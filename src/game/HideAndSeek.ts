import * as THREE from 'three';
import { Rng } from '../core/rng';
import { clamp, wrapAngle } from '../core/math';
import type { Animator } from '../pet/Animator';
import type { PetController } from '../pet/PetController';
import type { PetRig } from '../pet/PetModel';
import { NavGrid, NAV_NONE, type Waypoint } from '../world/NavGrid';
import type { ActionName } from '../pet/Animator';
import type { Vec3 } from '../core/math';
import { segmentObjects, type WorldObject } from '../world/Segmentation';
import type { WorldModel } from '../world/WorldModel';
import { describeSpot, findHideSpots, type HideSpot } from './HideSpots';
import { petSamplePoints, petVisibility, type ViewPose } from './Visibility';
import { measurePoseSamples } from '../pet/poseSamples';
import { HealthMonitor, type HealthOptions } from './Health';
import { Companion, standingNode } from './Companion';
import { Activities, HIDE_SEEK_MIN_AREA, type ActivityDef } from './Activities';

/**
 * Game flow:
 *   roam ("walk": Hopper follows the player around, see Companion) →
 *   (start) → countdown: the player covers their eyes while Hopper
 *   picks a spot and runs there → seek: the player looks around; Hopper stays
 *   put, giggles and peeks as hints → found → celebrate → roam.
 *
 * The game is pure logic over the world model, the pet and a camera pose, so
 * the same code runs on a phone, in the browser simulator and in node tests.
 */
export type Phase = 'waiting' | 'roam' | 'countdown' | 'seek' | 'found';

export interface GameEvents {
  onPhase?: (p: Phase) => void;
  onMessage?: (msg: string) => void;
  onGiggle?: (pos: THREE.Vector3, loud: boolean) => void;
  onFound?: (info: FoundInfo) => void;
  /** An idle fidget started while roaming (for voice flavour). */
  onFidget?: (action: string) => void;
  /** The player tapped somewhere and the game did something about it. */
  onTap?: (result: TapResult) => void;
  /** An activity became available for the first time (see Activities). */
  onUnlock?: (activity: ActivityDef) => void;
}

/** What a tap did. Points are in the map frame. */
export type TapResult =
  | { kind: 'none' }
  /** Tapped the hidden pet while seeking. */
  | { kind: 'found' }
  /** Tapped the pet while walking: it reacts. */
  | { kind: 'pet'; reaction: ActionName }
  /** Tapped a reachable spot: Hopper walks to `target` (a nav node near `at`). */
  | { kind: 'goto'; target: Vec3; at: Vec3 }
  /** Tapped somewhere Hopper can't go: unmapped ('unknown') or no path ('noPath'). */
  | { kind: 'unreachable'; reason: 'unknown' | 'noPath'; at: Vec3 | null };

export interface FoundInfo {
  seconds: number;
  /** True when Hopper gave up waiting and came out by themself. */
  revealed: boolean;
  where: string;
  spot: HideSpot | null;
  hintsUsed: number;
  round: number;
}

export interface GameOptions {
  countdown: number;
  difficulty: number;
  eyeHeight: number;
  seed: number;
  /** How far in front of the player Hopper likes to hang out while roaming (m). */
  roamDistance?: number;
  /** Let Hopper hop onto low surfaces by itself while exploring (default true). */
  roamHops?: boolean;
  health?: Partial<HealthOptions>;
}

const DEFAULTS: GameOptions = { countdown: 10, difficulty: 0.5, eyeHeight: 1.45, seed: 1 };

export class HideAndSeek {
  phase: Phase = 'waiting';
  readonly opts: GameOptions;
  nav: NavGrid | null = null;
  objects: WorldObject[] = [];
  spot: HideSpot | null = null;
  round = 0;
  /** Seconds left in the countdown (can go negative while Hopper finishes hiding). */
  countdownLeft = 0;
  seekTime = 0;
  /** Smoothed visibility of the pet in the current view (0..1). */
  visibility = 0;
  private seenAccum = 0;
  private hintsUsed = 0;
  private nextHint = 0;
  private peekTimer = 0;
  private previous: THREE.Vector3[] = [];
  private rng: Rng;
  /** Walk-mode behaviour: following the player and exploring nearby. */
  readonly companion: Companion;
  /** The activities menu (walk, hide and seek, ...). */
  readonly activities: Activities;
  private lastReaction: ActionName | null = null;
  private navTimer = 0;
  private relocated = false;
  private foundTimer = 0;
  /** Game clock (s) and a cooldown after a failed start. */
  private clock = 0;
  readonly health: HealthMonitor;
  private startBlockedUntil = 0;
  private hidden = false;
  private lastView: ViewPose | null = null;
  events: GameEvents = {};
  /** Diagnostics for tests and the debug overlay. */
  readonly stats = { spotsConsidered: 0, planMs: 0, replans: 0, relaxed: false, blockedReplans: 0 };

  constructor(
    readonly world: WorldModel,
    readonly pet: PetController,
    readonly anim: Animator,
    readonly rig: PetRig,
    opts: Partial<GameOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.rng = new Rng(this.opts.seed);
    this.health = new HealthMonitor(this, this.world, this.opts.health);
    const game = this;
    this.companion = new Companion(
      {
        pet,
        get nav() {
          return game.nav;
        },
        get floorY() {
          return game.world.floorY;
        },
        follow: (path, cruise, action, yaw) => this.follow(path, cruise, action, yaw),
        fidget: (a) => this.events.onFidget?.(a),
      },
      // Its own random stream: walking about never reshuffles hide and seek.
      new Rng(this.opts.seed * 7919 + 17),
      { roamDistance: this.opts.roamDistance ?? 1.2, hops: this.opts.roamHops ?? true },
    );
    this.activities = new Activities(this);
    this.activities.onUnlock = (def) => this.onUnlocked(def);
  }

  private onUnlocked(def: ActivityDef) {
    if (def.unlockLine) this.say(def.unlockLine);
    // A little celebration, unless Hopper is busy getting somewhere.
    if (this.phase === 'roam' && !this.pet.moving) {
      this.pet.perform('celebrate', 0.2);
      this.companion.delay(2);
    }
    this.events.onUnlock?.(def);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.events.onPhase?.(p);
  }

  say(msg: string) {
    this.events.onMessage?.(msg);
  }

  /** The map was rebuilt, aged or moved: drop derived data so it's recomputed. */
  mapChanged(): void {
    this.refreshNav(true);
    this.objects = [];
  }

  /**
   * Recovery: put the pet somewhere believable. A short hop when the target is
   * close (it looks like Hopper moving out of the way); otherwise it just
   * reappears there, startled.
   */
  relocatePet(target: Vec3, teleport: boolean): void {
    const pet = this.pet;
    this.move = null;
    if (teleport || !Number.isFinite(pet.pos.x + pet.pos.y + pet.pos.z)) {
      pet.placeAt(new THREE.Vector3(target.x, target.y, target.z), Number.isFinite(pet.yaw) ? pet.yaw : 0);
      pet.perform('surprised');
    } else pet.follow([{ x: target.x, y: target.y, z: target.z, jump: true, lift: 0.08, node: -1 }], 0.8, this.phase === 'seek' || this.phase === 'countdown' ? 'hide' : 'idle', null);
  }

  /**
   * Recovery: the pet's position can no longer be trusted (the world frame
   * jumped). Mid-round, Hopper gives the game away rather than sitting inside
   * something; otherwise hops back in front of the player.
   */
  reanchorPet(): void {
    const view = this.lastView;
    if (this.phase === 'countdown' || this.phase === 'seek') {
      this.say('Oops — I lost track of where I was! Here I am.');
      this.pet.stop('idle');
      if (view) this.reveal(view);
      else this.foundIt(true);
    }
    if (!view) return;
    const nav = this.refreshNav(true);
    const fx = view.forward.x, fz = view.forward.z, fl = Math.hypot(fx, fz) || 1;
    const want = { x: view.pos.x + (fx / fl) * 1.0, y: this.world.floorY, z: view.pos.z + (fz / fl) * 1.0 };
    let target: Vec3 = want;
    if (nav && nav.count) {
      const n = nav.nearest(want, 1.5);
      if (n !== NAV_NONE) target = nav.pos(n);
    }
    this.relocatePet(target, true);
  }

  /** Recovery: a phase overstayed its welcome; move the game along. */
  forceAdvance(): void {
    switch (this.phase) {
      case 'countdown':
        this.pet.stop('hide');
        this.hidden = true;
        this.seekTime = 0;
        this.nextHint = 22 - this.opts.difficulty * 8;
        this.setPhase('seek');
        this.say('Ready or not… come find me!');
        break;
      case 'seek':
        this.pet.stop('idle');
        if (this.lastView) this.reveal(this.lastView);
        else this.foundIt(true);
        break;
      case 'found':
        this.setPhase('roam');
        this.companion.reset();
        break;
    }
  }

  /** Put the pet in the world (e.g. where the user tapped). */
  spawn(at: THREE.Vector3, faceToward?: THREE.Vector3): void {
    // Inputs come from the device (tracking frame); the game lives in the map frame.
    at = toV3(this.world.toMapPoint(at));
    if (faceToward) faceToward = toV3(this.world.toMapPoint(faceToward));
    const yaw = faceToward ? Math.atan2(faceToward.x - at.x, faceToward.z - at.z) : 0;
    this.pet.placeAt(at, yaw);
    this.pet.perform('wave');
    this.companion.reset(2.5);
    this.setPhase('roam');
    this.say('Hi! I’m Hopper. Let’s go for a walk — show me around your room, then we can play hide and seek!');
  }

  /**
   * Put the pet back somewhere (map frame) without the introduction — for
   * re-placing it and for recoveries. Any round in progress is abandoned.
   */
  respawn(at: Vec3, faceToward?: Vec3): void {
    const yaw = faceToward ? Math.atan2(faceToward.x - at.x, faceToward.z - at.z) : this.pet.yaw;
    this.move = null;
    this.pet.placeAt(new THREE.Vector3(at.x, at.y, at.z), Number.isFinite(yaw) ? yaw : 0);
    this.pet.perform('wave');
    this.companion.reset(2.5);
    if (this.phase !== 'roam') this.setPhase('roam');
  }

  /** A graph for a replaced grid, being built in the background (see refreshNav). */
  private pendingNav: NavGrid | null = null;

  refreshNav(force = false): NavGrid | null {
    if (!this.world.grid) return null;
    // The world replaces its grid when it rebuilds (floor correction, reset):
    // a nav graph bound to the old grid would freeze on a stale map forever.
    if (!this.nav || this.nav.g !== this.world.grid) {
      // The map window moved with the player (a new grid of the same map):
      // build the new graph in the background and keep using the old one
      // (its positions are still right) until it's ready.
      if (this.nav && !force && NavGrid.background) {
        if (!this.pendingNav || this.pendingNav.g !== this.world.grid) this.pendingNav = new NavGrid(this.world, {}, true);
        if (this.pendingNav.builtVersion < 0) this.pendingNav.refresh(true);
        if (this.pendingNav.builtVersion < 0) return this.nav;
        this.nav = this.pendingNav;
      } else this.nav = new NavGrid(this.world);
      this.pendingNav = null;
    } else if (force || this.nav.builtVersion !== this.world.grid.version) this.nav.refresh(!force); // routine refreshes may run in the background (browser)
    return this.nav;
  }

  /** How well mapped the area is: number of walkable nodes (≈ 400 per m²). */
  mappedArea(): number {
    return this.nav ? this.nav.count * this.world.res * this.world.res : 0;
  }

  canStart(): boolean {
    return this.phase === 'roam' && this.mappedArea() > HIDE_SEEK_MIN_AREA && this.clock >= this.startBlockedUntil && !this.health.unsettled && this.petStanding();
  }

  /** Hopper is on walkable ground (not mid-air or inside something after a glitch). */
  petStanding(): boolean {
    if (this.pet.moving) return true;
    return !!this.nav && standingNode(this.nav, this.pet.pos) !== NAV_NONE;
  }

  /** Begin a round: the seeker should cover their eyes now. */
  start(viewTracking: ViewPose): boolean {
    const view = this.viewToMap(viewTracking);
    if (!view) return false;
    if (this.phase !== 'roam' && this.phase !== 'found') return false;
    if (this.clock < this.startBlockedUntil) return false;
    if (this.health.unsettled) {
      this.say('Hang on — I’m still getting my bearings after that tracking hiccup…');
      this.startBlockedUntil = this.clock + 3;
      return false;
    }
    const nav = this.refreshNav(true);
    if (!nav) return false;
    const t0 = performance.now();
    this.objects = segmentObjects(this.world);
    // Prefer properly hidden spots; in a bare room, settle for the best cover there is.
    let spots: HideSpot[] = [];
    for (const minHiddenNow of [0.85, 0.5, 0]) {
      spots = findHideSpots(
        nav,
        this.pet.pos,
        view.pos,
        {
          difficulty: this.opts.difficulty,
          maxPathCost: 9,
          previous: this.previous,
          rng: this.rng,
          objects: this.objects,
          eyeHeight: this.opts.eyeHeight,
          minHiddenNow,
          poseSamples: { hide: measurePoseSamples('hide'), hideLow: measurePoseSamples('hideLow') },
        },
        this.world.floorY,
      );
      this.stats.relaxed = minHiddenNow < 0.85;
      if (spots.length) break;
    }
    this.stats.planMs = performance.now() - t0;
    this.stats.spotsConsidered = spots.length;
    this.round++;
    this.hidden = false;
    this.relocated = false;
    this.hintsUsed = 0;
    this.seenAccum = 0;
    this.visibility = 0;
    this.countdownLeft = this.opts.countdown;
    // Pick the best spot we can actually path to.
    this.spot = null;
    for (const s of spots) {
      const path = nav.findPath(this.pet.pos, s.pos);
      if (!path) continue;
      this.spot = s;
      this.follow(path, 1.0, s.kind === 'under' || s.kind === 'inside' ? 'hideLow' : 'hide', s.faceYaw);
      this.pet.events.onArrive = () => this.onArrivedAtSpot();
      break;
    }
    if (!this.spot) {
      // Nowhere good: hide behind the player's back as a joke.
      // Every place I can safely reach is in plain view from here: the room
      // needs exploring (walking around, looking behind and under things).
      this.say('I can’t find a good hiding place yet — walk around and show me behind the furniture and under tables!');
      this.setPhase('roam');
      this.startBlockedUntil = this.clock + 4;
      return false;
    }
    this.setPhase('countdown');
    this.say(this.stats.relaxed ? 'Not much to hide behind in here… I’ll do my best! Cover your eyes!' : 'Cover your eyes and count to ten!');
    return true;
  }

  private onArrivedAtSpot() {
    this.hidden = true;
    this.pet.events.onArrive = undefined;
    if (this.spot) this.previous.push(new THREE.Vector3(this.spot.pos.x, this.spot.pos.y, this.spot.pos.z));
    if (this.previous.length > 4) this.previous.shift();
  }

  /** Ask for a hint: Hopper giggles (spatial audio) and their antennae glow. */
  hint(): void {
    if (this.phase !== 'seek') return;
    this.hintsUsed++;
    this.giggle(true);
  }

  private giggle(loud: boolean) {
    this.anim.play('giggle', 0.15, true);
    this.peekTimer = 1.6;
    this.events.onGiggle?.(this.pet.pos.clone(), loud);
  }

  // --- Runtime path safety ---------------------------------------------------------------
  // The map keeps changing while Hopper moves (someone walks into the way, a
  // new object gets mapped). Plans are re-checked against the live map a few
  // times a second; if the way ahead is blocked Hopper stops and replans.
  private move: { goal: Vec3; cruise: number; action: ActionName; yaw: number | null } | null = null;
  private guardTimer = 0;

  /** Walk a nav path (re-checked against the live map as Hopper goes, see guardPath). */
  follow(path: Waypoint[], cruise: number, action: ActionName, yaw: number | null) {
    const end = path[path.length - 1];
    this.move = end ? { goal: { x: end.x, y: end.y, z: end.z }, cruise, action, yaw } : null;
    this.pet.follow(path, cruise, action, yaw);
  }

  /** Is the rest of Hopper's current path still clear in the live map? */
  pathAheadClear(lookahead = 1.2): boolean {
    const g = this.world.grid, nav = this.nav;
    if (!g || !nav) return true;
    const path = this.pet.path;
    let from: Vec3 = { x: this.pet.pos.x, y: this.pet.pos.y, z: this.pet.pos.z };
    let dist = 0;
    for (let s = this.pet.segment; s < path.length && dist < lookahead; s++) {
      const w = path[s];
      if (w.jump) {
        if (this.pet.state !== 'air' && !nav.arcClear(from, w, w.lift ?? 0)) return false;
      } else {
        const len = Math.hypot(w.x - from.x, w.z - from.z);
        const n = Math.max(1, Math.ceil(len / 0.04));
        for (let q = 1; q <= n; q++) {
          const t = q / n;
          const x = from.x + (w.x - from.x) * t, z = from.z + (w.z - from.z) * t, y = from.y + (w.y - from.y) * t;
          // Body core: a narrow column from just above the feet to head height.
          for (const h of [0.07, 0.13, 0.19])
            for (const [ox, oz] of [[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]])
              if (g.blocked(g.cellX(x + ox), g.cellY(y + h), g.cellZ(z + oz))) return false;
          if (dist + len * t > lookahead) break;
        }
        dist += len;
      }
      from = w;
    }
    return true;
  }

  private guardPath(dt: number) {
    if (!this.pet.moving || !this.move || this.pet.state === 'air' || this.pet.state === 'crouch') return;
    this.guardTimer -= dt;
    if (this.guardTimer > 0) return;
    this.guardTimer = 0.3;
    if (this.pathAheadClear()) return;
    this.stats.blockedReplans++;
    // Replan on the graph we have (a forced rebuild here stalled the frame for
    // ~200ms on phones, every 0.3s while blocked); the background refresh
    // brings in the new obstacle within a moment, and until then the guard
    // keeps Hopper from walking into it.
    const nav = this.refreshNav();
    const m = this.move;
    // Bounded: when the way is truly blocked, an unbounded search would
    // explore the whole graph (jump links included) before giving up —
    // seconds on a large map. A detour is rarely more than a few times the
    // direct distance.
    // Jump links are worked out lazily and are the costly part of a search:
    // consider them only if the way there needed one (or the goal is up on something).
    const direct = Math.hypot(m.goal.x - this.pet.pos.x, m.goal.z - this.pet.pos.z);
    const needJumps = this.pet.path.some((w) => w.jump) || Math.abs(m.goal.y - this.world.floorY) > 0.06;
    const path = nav?.findPath(this.pet.pos, m.goal, 3 * direct + 4, needJumps ? 3000 : 12000, needJumps);
    if (path && path.length) this.pet.follow(path, m.cruise, m.action, m.yaw);
    else {
      // No way through right now: wait where we are (the obstacle may move away).
      this.pet.stop('idle');
      this.move = null;
    }
  }

  /** Tap/select (tracking frame ray). Returns true if the tap did something. */
  tapAt(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3): boolean {
    return this.tap(rayOrigin, rayDir).kind !== 'none';
  }

  /**
   * A tap on the screen, as a ray in the tracking frame. While seeking, a tap
   * on a visible Hopper finds them. While walking, tapping Hopper makes them
   * react (giggle, wave, a happy hop...) and tapping the floor (or a surface)
   * sends them there along the nav graph.
   */
  tap(rayOrigin: Vec3, rayDir: Vec3): TapResult {
    const r = this.tapInner(toV3(this.world.toMapPoint(rayOrigin)), toV3(this.world.toMapDir(rayDir)).normalize());
    if (r.kind !== 'none') this.events.onTap?.(r);
    return r;
  }

  private tapInner(o: THREE.Vector3, d: THREE.Vector3): TapResult {
    if (!Number.isFinite(o.x + o.y + o.z + d.x + d.y + d.z)) return { kind: 'none' };
    if (this.rayHitsPet(o, d)) {
      if (this.phase === 'seek' && this.visibility > 0.12) {
        this.foundIt();
        return { kind: 'found' };
      }
      if (this.phase === 'roam') return { kind: 'pet', reaction: this.reactToPoke() };
      return { kind: 'none' };
    }
    if (this.phase !== 'roam') return { kind: 'none' };
    return this.goToRay(o, d);
  }

  private rayHitsPet(o: THREE.Vector3, d: THREE.Vector3): boolean {
    const toC = this.pet.pos.clone().add(new THREE.Vector3(0, 0.15, 0)).sub(o);
    const t = toC.dot(d);
    if (t < 0) return false;
    return toC.sub(d.clone().multiplyScalar(t)).length() < 0.17;
  }

  /** Hopper was poked: a varied, happy reaction (never the same one twice in a row). */
  private reactToPoke(): ActionName {
    const options: ActionName[] = ['giggle', 'giggle', 'celebrate', 'wave', 'surprised'];
    let a = this.companion.rng.pick(options);
    if (a === this.lastReaction) a = this.companion.rng.pick(options.filter((x) => x !== a));
    this.lastReaction = a;
    this.move = null;
    this.pet.perform(a);
    if (a === 'surprised') {
      // Startled, then a fit of giggles.
      this.addTimer(0.6, () => {
        if (this.phase === 'roam' && this.pet.state === 'perform') this.anim.play('giggle', 0.15, true);
      });
    }
    // Turn to the player while reacting.
    if (this.lastView) this.pet.arriveYaw = Math.atan2(this.lastView.pos.x - this.pet.pos.x, this.lastView.pos.z - this.pet.pos.z);
    this.companion.delay(a === 'surprised' ? 2.2 : 1.8);
    return a;
  }

  /**
   * Where a ray (map frame) meets the mapped world: the first occupied voxel
   * (furniture, a wall) or the floor plane, whichever comes first.
   */
  pickSurface(o: Vec3, d: Vec3, maxDist = 8): Vec3 | null {
    const g = this.world.grid;
    const fy = this.world.floorY;
    let tMax = maxDist;
    const hitsFloor = d.y < -1e-3 && o.y > fy;
    if (hitsFloor) tMax = Math.min(tMax, (fy - o.y) / d.y);
    let tHit = -1;
    if (g)
      g.traverse(o, d, tMax, (i, j, k, t) => {
        // The floor itself is the plane; skip its voxels and the first few cm.
        if (t < 0.1 || g.centerY(j) < fy + g.res * 0.5) return false;
        if (g.blocked(i, j, k)) {
          tHit = t;
          return true;
        }
        return false;
      });
    if (tHit < 0) {
      if (!hitsFloor || tMax >= maxDist) return null;
      tHit = tMax;
    }
    return { x: o.x + d.x * tHit, y: o.y + d.y * tHit, z: o.z + d.z * tHit };
  }

  private goToRay(o: THREE.Vector3, d: THREE.Vector3): TapResult {
    const at = this.pickSurface(o, d);
    if (!at) return this.cantGo('unknown', null);
    return this.goTo(at, d);
  }

  /**
   * Walk to (near) a point in the map frame: the nearest reachable nav node.
   * `dir` (the tap ray) helps when the point is on the side of something.
   */
  goTo(at: Vec3, dir?: Vec3): TapResult {
    if (this.phase !== 'roam') return { kind: 'none' };
    const nav = this.refreshNav();
    if (!nav || !nav.count) return this.cantGo('unknown', at);
    const fy = this.world.floorY;
    // A surface Hopper can stand on right there (floor, a table top)...
    let n = nav.nearest(at, 0.3);
    if (n !== NAV_NONE && Math.abs(nav.ny[n] - at.y) > 0.12) n = NAV_NONE;
    // ...else the floor at the foot of whatever was tapped (a wall, a sofa's side).
    if (n === NAV_NONE && at.y - fy < 2) {
      const hl = dir ? Math.hypot(dir.x, dir.z) || 1 : 1;
      const foot = { x: at.x - (dir ? (dir.x / hl) * 0.15 : 0), y: fy, z: at.z - (dir ? (dir.z / hl) * 0.15 : 0) };
      n = nav.nearest(foot, 0.5);
      if (n !== NAV_NONE && Math.abs(nav.ny[n] - fy) > 0.1) n = NAV_NONE;
    }
    if (n === NAV_NONE) return this.cantGo('unknown', at);
    const s = standingNode(nav, this.pet.pos);
    let path = s === NAV_NONE ? null : nav.pathBetween(s, n);
    let partial = false;
    if (!path && s !== NAV_NONE) {
      // Can't get to that exact spot (the floor in between isn't mapped yet):
      // go as close as Hopper can get, preferring the same surface height.
      const goal = nav.pos(n);
      const { cost, prev } = nav.search(s, NAV_NONE, 30);
      const here = Math.hypot(this.pet.pos.x - goal.x, this.pet.pos.z - goal.z);
      let best = NAV_NONE, bd = Infinity;
      for (let q = 0; q < nav.count; q++) {
        if (!Number.isFinite(cost[q])) continue;
        const dd = Math.hypot(nav.g.centerX(nav.ni[q]) - goal.x, nav.g.centerZ(nav.nk[q]) - goal.z) + (Math.abs(nav.ny[q] - goal.y) > 0.12 ? 0.5 : 0);
        if (dd < bd) {
          bd = dd;
          best = q;
        }
      }
      // Only worth it if it actually gets Hopper noticeably closer.
      if (best !== NAV_NONE && bd < here - 0.3) {
        partial = bd > 0.5;
        n = best;
        path = nav.reconstruct(prev, s, n);
      }
    }
    if (!path) return this.cantGo('noPath', at);
    if (partial) this.say('That’s as far as I know — show me more of the floor and I’ll go further!');
    const target = nav.pos(n);
    const far = Math.hypot(target.x - this.pet.pos.x, target.z - this.pet.pos.z) > 1.5;
    this.follow(path, far ? 0.85 : 0.65, this.companion.rng.chance(0.6) ? 'sniff' : 'lookAround', null);
    this.companion.startGoto(target);
    return { kind: 'goto', target, at };
  }

  private cantGo(reason: 'unknown' | 'noPath', at: Vec3 | null): TapResult {
    // A puzzled look around, then back to normal.
    if (!this.pet.moving) {
      this.pet.perform('lookAround', 0.2);
      this.companion.delay(1.5);
    }
    this.say(
      reason === 'noPath'
        ? 'I can’t find a way over there!'
        : at
          ? 'Hmm, I don’t know that part of the room yet — show it to me first!'
          : 'Tap the floor and I’ll hop over there!',
    );
    return { kind: 'unreachable', reason, at };
  }

  update(dt: number, viewTracking: ViewPose): void {
    // Never let a bad frame poison the game: clamp time, reject broken poses.
    if (!(dt >= 0)) dt = 0;
    dt = Math.min(dt, 0.25);
    const view = this.viewToMap(viewTracking) ?? this.lastView;
    if (!view) return;
    this.clock += dt;
    this.lastView = view;
    this.anim.lookTarget = new THREE.Vector3(view.pos.x, view.pos.y, view.pos.z);
    this.navTimer -= dt;
    // Nav rebuilds cost ~100ms+ on a phone: refresh while roaming (the map is
    // still growing), and otherwise only on demand (start, sneak).
    if (this.navTimer <= 0 && this.phase === 'roam') {
      this.refreshNav();
      this.navTimer = 2.5;
    }
    this.activities.update();
    switch (this.phase) {
      case 'roam':
        this.companion.update(dt, view);
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'seek':
        this.updateSeek(dt, view);
        break;
      case 'found':
        this.foundTimer -= dt;
        if (this.foundTimer <= 0) {
          this.setPhase('roam');
          this.companion.reset();
        }
        break;
    }
    this.tickTimers(dt);
    this.guardPath(dt);
    this.pet.update(dt);
    this.anim.update(dt);
    this.health.update(dt, view);
  }

  /** Tracking-frame view → map frame; null if the pose is unusable. */
  private viewToMap(v: ViewPose): ViewPose | null {
    const ok = (p: Vec3) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    if (!v || !ok(v.pos) || !ok(v.forward) || !ok(v.up) || Math.hypot(v.forward.x, v.forward.y, v.forward.z) < 0.5) return null;
    if (this.world.frameVersion === 0) return v;
    return { ...v, pos: this.world.toMapPoint(v.pos), forward: this.world.toMapDir(v.forward), up: this.world.toMapDir(v.up) };
  }

  private updateCountdown(dt: number) {
    this.countdownLeft -= dt;
    // Wait (up to 8s extra) for Hopper to finish hiding.
    if ((this.countdownLeft <= 0 && this.hidden) || this.countdownLeft < -8) {
      if (!this.hidden) {
        // Couldn't make it in time: freeze where we are.
        this.pet.stop('hide');
        this.hidden = true;
      }
      this.seekTime = 0;
      this.nextHint = 22 - this.opts.difficulty * 8;
      this.setPhase('seek');
      this.say('Ready or not… come find me!');
    }
  }

  private updateSeek(dt: number, view: ViewPose) {
    this.seekTime += dt;
    const g = this.world.grid!;
    const raw = petVisibility(g, view, petSamplePoints(this.rig));
    this.visibility += (raw - this.visibility) * clamp(dt * 8, 0, 1);
    const dist = Math.hypot(view.pos.x - this.pet.pos.x, view.pos.z - this.pet.pos.z);
    // Found when a good chunk of Hopper is in view, close enough, for a moment.
    if (raw >= 0.35 && dist < 4.5) this.seenAccum += dt;
    else this.seenAccum = Math.max(0, this.seenAccum - dt * 0.5);
    if (this.seenAccum > 0.6) {
      this.foundIt();
      return;
    }
    // Don't let a round drag on forever: eventually Hopper pops out.
    const patience = 50 + this.opts.difficulty * 50;
    if ((this.seekTime > patience && !this.pet.moving) || this.seekTime > patience + 15) {
      this.pet.stop('idle');
      this.reveal(view);
      return;
    }
    // Automatic hints: giggles get more frequent the longer it takes.
    this.nextHint -= dt;
    if (this.nextHint <= 0) {
      this.giggle(false);
      this.nextHint = Math.max(7, 16 - this.seekTime * 0.1);
    }
    // Close but not looking: a nervous giggle.
    if (dist < 1.0 && raw < 0.1 && this.peekTimer <= 0 && this.rng.chance(dt * 0.4)) this.giggle(false);
    // Occasional peeks (more often on easy).
    this.peekTimer -= dt;
    if (this.peekTimer <= 0 && !this.pet.moving && this.rng.chance(dt * (0.12 * (1 - this.opts.difficulty) + 0.02))) {
      const toSeeker = Math.atan2(view.pos.x - this.pet.pos.x, view.pos.z - this.pet.pos.z);
      const rel = wrapAngle(toSeeker - this.pet.yaw);
      this.anim.ctx.peekSide = Math.abs(rel) < 0.4 ? 0 : Math.sign(rel);
      this.anim.play('peek', 0.25, true);
      this.peekTimer = 2.2;
    }
    if (this.peekTimer <= 0 && !this.pet.moving) {
      const cur = this.anim.current;
      const rest = this.spot && (this.spot.kind === 'under' || this.spot.kind === 'inside') ? 'hideLow' : 'hide';
      if (cur !== rest) this.anim.play(rest, 0.4);
    }
    // Hard mode: sneak away once if the seeker gets close without seeing.
    if (this.opts.difficulty >= 0.7 && !this.relocated && dist < 1.4 && raw < 0.05 && !this.pet.moving) this.sneak(view);
  }

  private sneak(view: ViewPose) {
    const nav = this.refreshNav();
    if (!nav) return;
    const spots = findHideSpots(
      nav,
      this.pet.pos,
      view.pos,
      {
        difficulty: 1,
        maxPathCost: 3.5,
        previous: [this.pet.pos.clone()],
        rng: this.rng,
        objects: this.objects,
        eyeHeight: this.opts.eyeHeight,
        poseSamples: { hide: measurePoseSamples('hide'), hideLow: measurePoseSamples('hideLow') },
      },
      this.world.floorY,
      4,
    );
    for (const s of spots) {
      // A sneak should actually go somewhere new.
      if (Math.hypot(s.pos.x - this.pet.pos.x, s.pos.z - this.pet.pos.z) < 0.6) continue;
      const path = nav.findPath(this.pet.pos, s.pos);
      if (!path) continue;
      this.relocated = true;
      this.stats.replans++;
      this.spot = s;
      this.follow(path, 0.9, s.kind === 'under' || s.kind === 'inside' ? 'hideLow' : 'hide', s.faceYaw);
      return;
    }
  }

  private reveal(view: ViewPose) {
    const nav = this.nav;
    if (nav) {
      // Hop ~0.6m towards the seeker so they can see where Hopper was.
      const dx = view.pos.x - this.pet.pos.x, dz = view.pos.z - this.pet.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const goal = nav.nearest({ x: this.pet.pos.x + (dx / d) * 0.6, y: this.world.floorY, z: this.pet.pos.z + (dz / d) * 0.6 }, 0.5);
      if (goal !== NAV_NONE) {
        const path = nav.findPath(this.pet.pos, nav.pos(goal));
        if (path) this.follow(path, 0.8, 'wave', Math.atan2(dx, dz));
      }
    }
    this.foundIt(true);
  }

  private foundIt(revealed = false) {
    const info: FoundInfo = {
      revealed,
      seconds: Math.round(this.seekTime),
      where: this.spot ? describeSpot(this.spot) : 'right here',
      spot: this.spot,
      hintsUsed: this.hintsUsed,
      round: this.round,
    };
    this.foundTimer = 3.2;
    this.setPhase('found');
    this.events.onFound?.(info);
    if (revealed) {
      this.say(`Here I am! I was hiding ${info.where}.`);
      this.foundTimer = 4;
      return;
    }
    this.pet.stop('surprised');
    this.anim.play('surprised', 0.08, true);
    this.say(`You found me ${info.where}! (${info.seconds}s)`);
    // Celebrate after the surprise.
    this.addTimer(0.9, () => {
      if (this.phase === 'found') this.pet.perform('celebrate', 0.2);
    });
  }

  /** Pending timers driven by update() so tests stay deterministic. */
  private timers: { t: number; fn: () => void }[] = [];
  tickTimers(dt: number) {
    for (const t of this.timers) t.t -= dt;
    const due = this.timers.filter((t) => t.t <= 0);
    this.timers = this.timers.filter((t) => t.t > 0);
    for (const t of due) t.fn();
  }
  addTimer(seconds: number, fn: () => void) {
    this.timers.push({ t: seconds, fn });
  }
  get view(): ViewPose | null {
    return this.lastView;
  }
}

const toV3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

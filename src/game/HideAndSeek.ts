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

/**
 * Game flow:
 *   roam → (start) → countdown: the player covers their eyes while Hopper
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
}

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
  private roamTimer = 0;
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
        this.roamTimer = 0;
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
    this.roamTimer = 2.5;
    this.setPhase('roam');
    this.say('Hi! I’m Hopper. Look around so I can learn your room, then let’s play hide and seek!');
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
    this.roamTimer = 2.5;
    if (this.phase !== 'roam') this.setPhase('roam');
  }

  refreshNav(force = false): NavGrid | null {
    if (!this.world.grid) return null;
    // The world replaces its grid when it rebuilds (floor correction, reset):
    // a nav graph bound to the old grid would freeze on a stale map forever.
    if (!this.nav || this.nav.g !== this.world.grid) this.nav = new NavGrid(this.world);
    else if (force || this.nav.builtVersion !== this.world.grid.version) this.nav.refresh(!force); // routine refreshes may run in the background (browser)
    return this.nav;
  }

  /** How well mapped the area is: number of walkable nodes (≈ 400 per m²). */
  mappedArea(): number {
    return this.nav ? this.nav.count * this.world.res * this.world.res : 0;
  }

  canStart(): boolean {
    return this.phase === 'roam' && this.mappedArea() > 2 && this.clock >= this.startBlockedUntil && !this.health.unsettled;
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

  private follow(path: Waypoint[], cruise: number, action: ActionName, yaw: number | null) {
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
    const nav = this.refreshNav(true);
    const m = this.move;
    const path = nav?.findPath(this.pet.pos, m.goal);
    if (path && path.length) this.pet.follow(path, m.cruise, m.action, m.yaw);
    else {
      // No way through right now: wait where we are (the obstacle may move away).
      this.pet.stop('idle');
      this.move = null;
    }
  }

  /** Tap/select: if aimed at a visible pet, that counts as found. */
  tapAt(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3): boolean {
    rayOrigin = toV3(this.world.toMapPoint(rayOrigin));
    rayDir = toV3(this.world.toMapDir(rayDir));
    const c = this.pet.pos.clone().add(new THREE.Vector3(0, 0.15, 0));
    const toC = c.clone().sub(rayOrigin);
    const t = toC.dot(rayDir);
    if (t < 0) return false;
    const miss = toC.sub(rayDir.clone().multiplyScalar(t)).length();
    const hit = miss < 0.17;
    if (!hit) return false;
    if (this.phase === 'seek' && this.visibility > 0.12) {
      this.foundIt();
      return true;
    }
    if (this.phase === 'roam') {
      this.pet.perform(this.rng.chance(0.5) ? 'giggle' : 'wave');
      this.roamTimer = 2;
      this.events.onGiggle?.(this.pet.pos.clone(), false);
      return true;
    }
    return false;
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
    switch (this.phase) {
      case 'roam':
        this.updateRoam(dt, view);
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
          this.roamTimer = 0;
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

  private updateRoam(dt: number, view: ViewPose) {
    this.roamTimer -= dt;
    if (this.pet.moving || this.roamTimer > 0) return;
    const nav = this.nav;
    // Stay in front of the player, ~1m away, so they can admire their pet.
    const fwd = new THREE.Vector3(view.forward.x, 0, view.forward.z);
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const rd = this.opts.roamDistance ?? 1.1;
    const want = new THREE.Vector3(view.pos.x + fwd.x * rd, this.world.floorY, view.pos.z + fwd.z * rd);
    const d = Math.hypot(want.x - this.pet.pos.x, want.z - this.pet.pos.z);
    if (nav && d > 0.8) {
      const goal = nav.nearest(want, 0.8);
      if (goal !== NAV_NONE) {
        const g = nav.pos(goal);
        const path = nav.findPath(this.pet.pos, g);
        if (path) {
          const faceYaw = Math.atan2(view.pos.x - g.x, view.pos.z - g.z);
          this.follow(path, 0.55, 'idle', faceYaw);
          this.roamTimer = 1.5;
          return;
        }
      }
    }
    // Idle fidgets.
    const r = this.rng.next();
    const fidget = r < 0.25 ? 'lookAround' : r < 0.45 ? 'sniff' : r < 0.55 ? 'wave' : 'idle';
    this.pet.perform(fidget, 0.3);
    this.events.onFidget?.(fidget);
    this.pet.arriveAction = fidget;
    this.pet.arriveYaw = Math.atan2(view.pos.x - this.pet.pos.x, view.pos.z - this.pet.pos.z);
    this.pet.state = 'idle';
    this.roamTimer = 2.5 + this.rng.next() * 2.5;
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

import * as THREE from 'three';
import { Rng } from '../core/rng';
import { clamp, wrapAngle } from '../core/math';
import type { Animator } from '../pet/Animator';
import type { PetController } from '../pet/PetController';
import type { PetRig } from '../pet/PetModel';
import { NavGrid, NAV_NONE } from '../world/NavGrid';
import { segmentObjects, type WorldObject } from '../world/Segmentation';
import type { WorldModel } from '../world/WorldModel';
import { describeSpot, findHideSpots, type HideSpot } from './HideSpots';
import { petSamplePoints, petVisibility, type ViewPose } from './Visibility';
import { measurePoseSamples } from '../pet/poseSamples';

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
  private hidden = false;
  private lastView: ViewPose | null = null;
  events: GameEvents = {};
  /** Diagnostics for tests and the debug overlay. */
  readonly stats = { spotsConsidered: 0, planMs: 0, replans: 0 };

  constructor(
    readonly world: WorldModel,
    readonly pet: PetController,
    readonly anim: Animator,
    readonly rig: PetRig,
    opts: Partial<GameOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.rng = new Rng(this.opts.seed);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.events.onPhase?.(p);
  }

  private say(msg: string) {
    this.events.onMessage?.(msg);
  }

  /** Put the pet in the world (e.g. where the user tapped). */
  spawn(at: THREE.Vector3, faceToward?: THREE.Vector3): void {
    const yaw = faceToward ? Math.atan2(faceToward.x - at.x, faceToward.z - at.z) : 0;
    this.pet.placeAt(at, yaw);
    this.pet.perform('wave');
    this.roamTimer = 2.5;
    this.setPhase('roam');
    this.say('Hi! I’m Hopper. Look around so I can learn your room, then let’s play hide and seek!');
  }

  refreshNav(force = false): NavGrid | null {
    if (!this.world.grid) return null;
    if (!this.nav) this.nav = new NavGrid(this.world);
    else if (force || this.nav.builtVersion !== this.world.grid.version) this.nav.refresh();
    return this.nav;
  }

  /** How well mapped the area is: number of walkable nodes (≈ 400 per m²). */
  mappedArea(): number {
    return this.nav ? this.nav.count * this.world.res * this.world.res : 0;
  }

  canStart(): boolean {
    return this.phase === 'roam' && this.mappedArea() > 2;
  }

  /** Begin a round: the seeker should cover their eyes now. */
  start(view: ViewPose): boolean {
    if (this.phase !== 'roam' && this.phase !== 'found') return false;
    const nav = this.refreshNav(true);
    if (!nav) return false;
    const t0 = performance.now();
    this.objects = segmentObjects(this.world);
    const spots = findHideSpots(
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
        poseSamples: { hide: measurePoseSamples('hide'), hideLow: measurePoseSamples('hideLow') },
      },
      this.world.floorY,
    );
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
      this.pet.follow(path, 1.0, s.kind === 'under' || s.kind === 'inside' ? 'hideLow' : 'hide', s.faceYaw);
      this.pet.events.onArrive = () => this.onArrivedAtSpot();
      break;
    }
    if (!this.spot) {
      // Nowhere good: hide behind the player's back as a joke.
      this.say('Hmm, I can’t find anywhere to hide yet — show me more of the room!');
      this.setPhase('roam');
      return false;
    }
    this.setPhase('countdown');
    this.say('Cover your eyes and count to ten!');
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

  /** Tap/select: if aimed at a visible pet, that counts as found. */
  tapAt(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3): boolean {
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

  update(dt: number, view: ViewPose): void {
    this.lastView = view;
    this.anim.lookTarget = new THREE.Vector3(view.pos.x, view.pos.y, view.pos.z);
    this.navTimer -= dt;
    if (this.navTimer <= 0 && this.phase !== 'countdown') {
      this.refreshNav();
      this.navTimer = 1.0;
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
    this.pet.update(dt);
    this.anim.update(dt);
  }

  private updateRoam(dt: number, view: ViewPose) {
    this.roamTimer -= dt;
    if (this.pet.moving || this.roamTimer > 0) return;
    const nav = this.nav;
    // Stay in front of the player, ~1m away, so they can admire their pet.
    const fwd = new THREE.Vector3(view.forward.x, 0, view.forward.z);
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const want = new THREE.Vector3(view.pos.x + fwd.x * 1.1, this.world.floorY, view.pos.z + fwd.z * 1.1);
    const d = Math.hypot(want.x - this.pet.pos.x, want.z - this.pet.pos.z);
    if (nav && d > 0.8) {
      const goal = nav.nearest(want, 0.8);
      if (goal !== NAV_NONE) {
        const g = nav.pos(goal);
        const path = nav.findPath(this.pet.pos, g);
        if (path) {
          const faceYaw = Math.atan2(view.pos.x - g.x, view.pos.z - g.z);
          this.pet.follow(path, 0.55, 'idle', faceYaw);
          this.roamTimer = 1.5;
          return;
        }
      }
    }
    // Idle fidgets.
    const r = this.rng.next();
    const fidget = r < 0.25 ? 'lookAround' : r < 0.45 ? 'sniff' : r < 0.55 ? 'wave' : 'idle';
    this.pet.perform(fidget, 0.3);
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
    if (this.seekTime > patience && !this.pet.moving) {
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
    const nav = this.nav;
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
      2,
    );
    for (const s of spots) {
      const path = nav.findPath(this.pet.pos, s.pos);
      if (!path) continue;
      this.relocated = true;
      this.stats.replans++;
      this.spot = s;
      this.pet.follow(path, 0.9, s.kind === 'under' || s.kind === 'inside' ? 'hideLow' : 'hide', s.faceYaw);
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
        if (path) this.pet.follow(path, 0.8, 'wave', Math.atan2(dx, dz));
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

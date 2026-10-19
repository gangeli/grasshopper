import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import type { ViewPose } from '../game/Visibility';

/**
 * Device-independent pieces of the AR runtime's self-protection: tracking
 * state, frame-time clamping, pose sanity checks, error budgets, anchor drift
 * correction and placement classification. Kept pure so they can be unit
 * tested without a WebXR device.
 */

/** Per-frame tracking quality as reported by WebXR. */
export type TrackSample = 'ok' | 'limited' | 'lost' | 'invalid';

/** Classify a viewer pose: null → lost, emulatedPosition → limited (orientation only), non-finite → invalid. */
export function classifyViewerPose(pose: { emulatedPosition?: boolean; transform: { matrix: ArrayLike<number> } } | null | undefined): TrackSample {
  if (!pose) return 'lost';
  const m = pose.transform?.matrix;
  if (!m || m.length < 16) return 'invalid';
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return 'invalid';
  if (Math.abs(m[12]) > 1e4 || Math.abs(m[13]) > 1e4 || Math.abs(m[14]) > 1e4) return 'invalid';
  return pose.emulatedPosition ? 'limited' : 'ok';
}

/**
 * Debounces tracking loss and gates resumption. The game is frozen on the
 * first bad frame (no updates with garbage poses), the user is told after
 * `showAfter` seconds, and play resumes only after `settleFrames` consecutive
 * good frames (relocalisation can jitter for a few frames). A large jump in
 * the viewer position between good frames (relocalisation snapping the
 * world) also re-arms the settle period.
 */
export class TrackingMonitor {
  frozen = false;
  /** Seconds the tracking has been bad (0 when fine). */
  badFor = 0;
  /** Counters for diagnostics/tests. */
  losses = 0;
  jumps = 0;
  private badSince = -1;
  private goodRun = 0;
  private lastPos: Vec3 | null = null;

  constructor(readonly settleFrames = 8, readonly showAfter = 0.6, readonly maxStep = 0.35) {}

  /** Feed one frame. `now` in seconds; `pos` is the viewer position for 'ok' samples. */
  update(now: number, sample: TrackSample, pos?: Vec3): void {
    if (sample !== 'ok' || !pos) {
      if (this.badSince < 0) {
        this.badSince = now;
        this.losses++;
      }
      this.badFor = Math.max(0, now - this.badSince);
      this.goodRun = 0;
      this.frozen = true;
      this.lastPos = null;
      return;
    }
    if (this.lastPos) {
      const d = Math.hypot(pos.x - this.lastPos.x, pos.y - this.lastPos.y, pos.z - this.lastPos.z);
      if (d > this.maxStep) {
        // Relocalisation snapped the pose: let it settle before the game sees it.
        this.jumps++;
        this.goodRun = 0;
        this.frozen = true;
        if (this.badSince < 0) this.badSince = now;
      }
    }
    this.lastPos = { x: pos.x, y: pos.y, z: pos.z };
    this.goodRun++;
    if (this.frozen && this.goodRun >= this.settleFrames) this.frozen = false;
    if (!this.frozen) {
      this.badSince = -1;
      this.badFor = 0;
    } else if (this.badSince >= 0) this.badFor = Math.max(0, now - this.badSince);
  }

  /** Whether to tell the user tracking is lost (debounced). */
  get showLost(): boolean {
    return this.frozen && this.badFor >= this.showAfter;
  }

  /** Force a settle period (e.g. after the app was paused/backgrounded). */
  reset(): void {
    this.goodRun = 0;
    this.lastPos = null;
    this.frozen = true;
    this.badSince = -1;
    this.badFor = 0;
  }
}

/**
 * Frame time in seconds from two rAF timestamps (ms). Gaps (backgrounded,
 * a long stall) must never reach the simulation as one huge step: anything
 * over `gap` is treated as a resume and replaced by a nominal frame.
 */
export function clampDt(prevMs: number, nowMs: number, max = 0.05, gap = 0.25): number {
  if (!prevMs) return 1 / 60;
  const dt = (nowMs - prevMs) / 1000;
  if (!Number.isFinite(dt) || dt <= 0 || dt > gap) return 1 / 60;
  return Math.min(max, dt);
}

const finite3 = (v: Vec3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const len3 = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

export function isFiniteVec(v: Vec3 | null | undefined): v is Vec3 {
  return !!v && finite3(v);
}

/** A view pose is safe to hand to the game: finite, unit axes, sane projection. */
export function validView(v: ViewPose | null | undefined): v is ViewPose {
  if (!v || !finite3(v.pos) || !finite3(v.forward) || !finite3(v.up)) return false;
  const lf = len3(v.forward), lu = len3(v.up);
  if (lf < 0.9 || lf > 1.1 || lu < 0.9 || lu > 1.1) return false;
  if (Math.abs(v.pos.x) > 1e4 || Math.abs(v.pos.y) > 1e4 || Math.abs(v.pos.z) > 1e4) return false;
  return Number.isFinite(v.fovY) && v.fovY > 0.05 && v.fovY < 3 && Number.isFinite(v.aspect) && v.aspect > 0.05 && v.aspect < 20;
}

/**
 * Counts errors in a sliding window, so the frame loop can survive a bug
 * (log, keep going) yet notice when something keeps failing.
 */
export class ErrorBudget {
  total = 0;
  last = '';
  private times: number[] = [];
  private lastLog = -Infinity;

  constructor(readonly window = 3) {}

  /** Record an error at `now` (s). Logs at most once a second. */
  record(now: number, where: string, e: unknown): void {
    this.total++;
    this.last = `${where}: ${e instanceof Error ? e.message : String(e)}`;
    this.times.push(now);
    this.prune(now);
    if (now - this.lastLog > 1) {
      this.lastLog = now;
      console.error(`[hopper] ${where} failed (${this.total} errors so far)`, e);
    }
  }

  /** Errors within the window ending at `now`. */
  recent(now: number): number {
    this.prune(now);
    return this.times.length;
  }

  clear(): void {
    this.times = [];
  }

  private prune(now: number) {
    while (this.times.length && now - this.times[0] > this.window) this.times.shift();
  }
}

/**
 * Anchor drift correction, tracking → map: C = A0 · A(t)⁻¹, where A0 is the
 * anchor's pose when first tracked and A(t) its pose now (column-major 4x4).
 * A point fixed to the anchor maps to the same map-frame position for ever.
 */
export function anchorCorrection(a0: ArrayLike<number>, at: ArrayLike<number>): number[] {
  const A0 = new THREE.Matrix4().fromArray(Array.from(a0));
  const At = new THREE.Matrix4().fromArray(Array.from(at));
  return A0.multiply(At.invert()).toArray();
}

/** Translation (m) and rotation (rad) difference between two rigid transforms. */
export function transformDelta(a: ArrayLike<number>, b: ArrayLike<number>): { dist: number; angle: number } {
  const ma = new THREE.Matrix4().fromArray(Array.from(a)), mb = new THREE.Matrix4().fromArray(Array.from(b));
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), s = new THREE.Vector3();
  ma.decompose(pa, qa, s);
  mb.decompose(pb, qb, s);
  return { dist: pa.distanceTo(pb), angle: qa.angleTo(qb) };
}

export function isFiniteMatrix(m: ArrayLike<number> | null | undefined): m is ArrayLike<number> {
  if (!m || m.length !== 16) return false;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
  return true;
}

export type PlacementVerdict =
  | { ok: true }
  | { ok: false; reason: 'wall' | 'ceiling'; message: string }
  /** Probably a table/sofa/bed top: accepted only if the user taps there again. */
  | { ok: false; reason: 'raised'; message: string };

/**
 * Is this hit-test result a plausible floor? Walls and ceilings are refused.
 * A horizontal surface well above the known floor (a detected floor plane,
 * or y≈0 in a local-floor space) or close below the camera is probably
 * furniture: a mis-tapped floor height breaks the whole map, so ask for a
 * confirming second tap.
 */
export function classifyPlacement(hit: { pos: Vec3; normal: Vec3 }, camY: number, floorHintY: number | null): PlacementVerdict {
  if (hit.normal.y < -0.7) return { ok: false, reason: 'ceiling', message: 'That’s the ceiling — point down at the floor and tap.' };
  if (hit.normal.y < 0.7) return { ok: false, reason: 'wall', message: 'That looks like a wall — point at the floor and tap.' };
  const aboveFloor = floorHintY !== null ? hit.pos.y - floorHintY : 0;
  const belowCam = camY - hit.pos.y;
  if (aboveFloor > 0.25 || belowCam < 0.5)
    return { ok: false, reason: 'raised', message: 'That looks like a table or sofa, not the floor. Tap the floor — or tap here again if this really is the floor.' };
  return { ok: true };
}

/** Intersect a ray with the horizontal plane y = h (fallback placement when hit-test never answers). */
export function rayToHeight(origin: Vec3, dir: Vec3, h: number, maxDist = 4): Vec3 | null {
  if (!(dir.y < -0.2)) return null;
  const t = (h - origin.y) / dir.y;
  if (!(t > 0.2 && t < maxDist)) return null;
  return { x: origin.x + dir.x * t, y: h, z: origin.z + dir.z * t };
}

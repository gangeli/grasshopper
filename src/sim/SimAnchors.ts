import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import { invertRigid4, mul4 } from '../world/WorldModel';
import type { SimSensor } from './SimSensor';

/**
 * Simulated WebXR anchors (XRAnchor) on top of SimSensor's tracker model.
 *
 * On a phone the tracker (ARCore) runs its own visual-inertial SLAM. An
 * anchor is glued to the tracker's map where it was created; the app reads
 * its pose in tracking coordinates each frame. While the tracker drifts
 * without noticing, the anchor drifts with it (its reported pose doesn't
 * change). When the tracker notices — it recognises a place and closes a
 * loop, or merges its old map back after a relocalisation — it corrects its
 * map, and anchors created since move with the correction: an anchor's
 * reported pose changes by how much the tracker now thinks the place it was
 * created at had drifted.
 *
 * Model (each anchor keeps B, its truth → reported transform; the reported
 * pose is B · (true pose)):
 *  - created: B = the tracking frame at that moment (so it reports the pose
 *    it was created with);
 *  - the tracker closes a loop (SimSensor.onLoop: back at a place seen at
 *    walked distance w_k, its frame snaps from T_before to T_after): like a
 *    pose graph, the correction L = T_after · T_before⁻¹ is spread over the
 *    path since the recognised place; an anchor created at walked distance
 *    w ∈ (w_k, w_now] gets L^s, s = (w − w_k)/(w_now − w_k), applied after a
 *    delay, scaled by a partial factor, and sometimes not at all. What is
 *    left wrong is the drift's deviation from a straight line (it is a random
 *    walk), plus the delay, partial and missing corrections;
 *  - a persistent jump of the tracking frame (SimSensor.onJump, a tracker
 *    that came back in a moved frame): anchors pause (not tracked). With
 *    `mergeChance` the tracker later recognises its old map and they come
 *    back, moved by the jump (+ error); otherwise they stay lost;
 *  - anchors are lost for good at `loseRate` per second, creation fails at
 *    `fail`, at most `max` live anchors;
 *  - reported poses wobble a little (AR(1) jitter);
 *  - `oracle`: anchors report through the tracking frame as it is now (the
 *    tracker always knows exactly how it drifted): the ceiling.
 * The anchors' own random numbers are separate from the sensor's, so the same
 * walk sees the same depth noise with or without them.
 */
export interface AnchorSimOptions {
  fail?: number;
  max?: number;
  loseRate?: number;
  jitterPos?: number;
  jitterRot?: number;
  /** Corrections from the tracker's loop closures: delay range (s), partial factor range, chance missing. */
  delay?: [number, number];
  frac?: [number, number];
  miss?: number;
  /** After a frame jump: chance the tracker merges its old map back, delay range (s), error (m, rad) of the merge. */
  mergeChance?: number;
  mergeDelay?: [number, number];
  mergeErrPos?: number;
  mergeErrRot?: number;
  /** Extra corrections: spurious anchor jumps (per anchor per second) of this size (m). */
  bogusRate?: number;
  bogusPos?: number;
  oracle?: boolean;
}

export const ANCHOR_DEFAULTS: Required<AnchorSimOptions> = {
  fail: 0.05,
  max: 60,
  loseRate: 0.0005,
  jitterPos: 0.004,
  jitterRot: 0.002,
  delay: [0.2, 3],
  frac: [0.6, 1],
  miss: 0.25,
  mergeChance: 0.5,
  mergeDelay: [5, 60],
  mergeErrPos: 0.05,
  mergeErrRot: 0.02,
  bogusRate: 0,
  bogusPos: 0.15,
  oracle: false,
};

interface SimAnchor {
  id: number;
  pTrue: number[];
  B: number[];
  w: number;
  paused: boolean;
  /** The sensor's jump transform when the anchor paused (a merge moves it by the jumps since). */
  pausedJump: number[] | null;
  lost: boolean;
  jit: { x: number; z: number; yaw: number };
}

/** Rigid transform about a pivot (yaw only + translation), raised to the power s (0..1). */
function fractional(L: number[], s: number, pivot: Vec3): number[] {
  const yaw = Math.atan2(L[8], L[0]);
  // L(x) = R(x − c) + c + t' → t' = L(c) − c.
  const Lc = { x: L[0] * pivot.x + L[4] * pivot.y + L[8] * pivot.z + L[12], y: L[1] * pivot.x + L[5] * pivot.y + L[9] * pivot.z + L[13], z: L[2] * pivot.x + L[6] * pivot.y + L[10] * pivot.z + L[14] };
  const tx = (Lc.x - pivot.x) * s, ty = (Lc.y - pivot.y) * s, tz = (Lc.z - pivot.z) * s;
  const a = yaw * s, c = Math.cos(a), sn = Math.sin(a);
  // x' = R(x − c) + c + t.
  return [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, pivot.x - (c * pivot.x + sn * pivot.z) + tx, ty, pivot.z - (-sn * pivot.x + c * pivot.z) + tz, 1];
}

function yawShift(dx: number, dz: number, dyaw: number, pivot: Vec3): number[] {
  const c = Math.cos(dyaw), sn = Math.sin(dyaw);
  return [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, pivot.x - (c * pivot.x + sn * pivot.z) + dx, 0, pivot.z - (-sn * pivot.x + c * pivot.z) + dz, 1];
}

export class SimAnchors {
  readonly o: Required<AnchorSimOptions>;
  private rng: Rng;
  private anchors = new Map<number, SimAnchor>();
  private nextId = 1;
  private now = 0;
  private pending: { at: number; run: () => void }[] = [];
  /** Diagnostics. */
  stats = { created: 0, failed: 0, lost: 0, corrections: 0, missed: 0, merges: 0 };

  constructor(readonly sensor: SimSensor, opts: AnchorSimOptions = {}, seed = 1) {
    this.o = { ...ANCHOR_DEFAULTS, ...opts };
    this.rng = new Rng(seed * 977 + 13);
    sensor.onLoop = (e) => this.loop(e);
    sensor.onJump = (J) => this.jump(J);
  }

  private gauss(): number {
    const u = Math.max(1e-9, this.rng.next()), v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Advance the clock (call every frame): delayed corrections, losses, jitter. */
  step(t: number, dt: number): void {
    this.now = t;
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= t);
      this.pending = this.pending.filter((p) => p.at > t);
      for (const p of due) p.run();
    }
    const O = this.o;
    for (const a of this.anchors.values()) {
      if (a.lost) continue;
      if (O.loseRate && this.rng.chance(O.loseRate * dt)) {
        a.lost = true;
        this.stats.lost++;
        continue;
      }
      // Slow wobble of the reported pose (AR(1), ~1 s correlation).
      const k = Math.min(1, dt);
      a.jit.x += -k * a.jit.x + this.gauss() * O.jitterPos * Math.sqrt(2 * k);
      a.jit.z += -k * a.jit.z + this.gauss() * O.jitterPos * Math.sqrt(2 * k);
      a.jit.yaw += -k * a.jit.yaw + this.gauss() * O.jitterRot * Math.sqrt(2 * k);
      if (O.bogusRate && this.rng.chance(O.bogusRate * dt)) {
        const ang = this.rng.range(0, Math.PI * 2), r = this.rng.range(0.3, 1) * O.bogusPos;
        const p = this.position(a);
        a.B = mul4(yawShift(Math.cos(ang) * r, Math.sin(ang) * r, this.gauss() * 0.03, p), a.B);
      }
    }
  }

  private position(a: SimAnchor): Vec3 {
    const P = mul4(a.B, a.pTrue);
    return { x: P[12], y: P[13], z: P[14] };
  }

  /** Create an anchor at a tracking-frame pose (column-major). Null if creation failed. */
  create(pose: ArrayLike<number>): number | null {
    const live = [...this.anchors.values()].filter((a) => !a.lost).length;
    if (live >= this.o.max || this.rng.chance(this.o.fail)) {
      this.stats.failed++;
      return null;
    }
    const T = this.sensor.trackingFromTruth();
    const a: SimAnchor = { id: this.nextId++, pTrue: mul4(invertRigid4(T), Array.from(pose)), B: T.slice(), w: this.sensor.walked, paused: false, pausedJump: null, lost: false, jit: { x: 0, z: 0, yaw: 0 } };
    this.anchors.set(a.id, a);
    this.stats.created++;
    return a.id;
  }

  /** The anchor's pose in tracking coordinates now; null while not tracked; 'lost' when gone for good. */
  pose(id: number): number[] | null | 'lost' {
    const a = this.anchors.get(id);
    if (!a || a.lost) return 'lost';
    if (a.paused && !this.o.oracle) return null;
    const B = this.o.oracle ? this.sensor.trackingFromTruth() : a.B;
    const P = mul4(B, a.pTrue);
    const j = a.jit;
    return mul4(yawShift(j.x, j.z, j.yaw, { x: P[12], y: P[13], z: P[14] }), P);
  }

  release(id: number): void {
    this.anchors.delete(id);
  }

  get live(): number {
    let n = 0;
    for (const a of this.anchors.values()) if (!a.lost) n++;
    return n;
  }

  /** The tracker closed a loop: spread the correction over anchors created since the recognised place. */
  private loop(e: { t: number; before: number[]; after: number[]; walkedKey: number; walkedNow: number; truePos: Vec3 }): void {
    const O = this.o;
    const L = mul4(e.after, invertRigid4(e.before));
    const span = e.walkedNow - e.walkedKey;
    if (!(span > 0.05)) return;
    // Pivot: where the camera is, in the tracking frame before the snap.
    const B = e.before, p = e.truePos;
    const pivot = { x: B[0] * p.x + B[4] * p.y + B[8] * p.z + B[12], y: B[1] * p.x + B[5] * p.y + B[9] * p.z + B[13], z: B[2] * p.x + B[6] * p.y + B[10] * p.z + B[14] };
    const targets = [...this.anchors.values()].filter((a) => !a.lost && a.w > e.walkedKey);
    if (!targets.length) return;
    if (this.rng.chance(O.miss)) {
      this.stats.missed++;
      return;
    }
    const frac = this.rng.range(O.frac[0], O.frac[1]);
    const at = this.now + this.rng.range(O.delay[0], O.delay[1]);
    const ups = targets.map((a) => ({ a, M: fractional(L, Math.min(1, (a.w - e.walkedKey) / span) * frac, pivot) }));
    this.pending.push({
      at,
      run: () => {
        this.stats.corrections++;
        for (const { a, M } of ups) if (!a.lost) a.B = mul4(M, a.B);
      },
    });
  }

  /** The tracking frame jumped for good: anchors pause; maybe the tracker merges its old map back later. */
  private jump(J: number[]): void {
    const O = this.o;
    if (O.oracle) return;
    const affected = [...this.anchors.values()].filter((a) => !a.lost && !a.paused);
    // (Called after the jump is applied: the frame before it is J⁻¹ · jump.)
    const before = mul4(invertRigid4(J), this.sensor.jump);
    for (const a of affected) (a.paused = true), (a.pausedJump = before);
    if (!affected.length) return;
    if (!this.rng.chance(O.mergeChance)) {
      for (const a of affected) a.lost = true;
      this.stats.lost += affected.length;
      return;
    }
    const at = this.now + this.rng.range(O.mergeDelay[0], O.mergeDelay[1]);
    const ex = this.gauss() * O.mergeErrPos, ez = this.gauss() * O.mergeErrPos, ey = this.gauss() * O.mergeErrRot;
    this.pending.push({
      at,
      run: () => {
        this.stats.merges++;
        for (const a of affected) {
          if (a.lost) continue;
          a.paused = false;
          const D = mul4(this.sensor.jump, invertRigid4(a.pausedJump ?? this.sensor.jump));
          a.B = mul4(D, a.B);
          a.B = mul4(yawShift(ex, ez, ey, this.position(a)), a.B);
        }
      },
    });
  }
}

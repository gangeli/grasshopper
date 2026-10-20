import type { Vec3 } from '../core/math';

/**
 * A depth image as delivered by the device (or the simulator), and the
 * front-end processing shared by both before anything touches the map.
 */
export interface DepthImage {
  w: number;
  h: number;
  /** Z-depth in metres along the camera's -Z axis; 0 = no reading. Row 0 is the top. */
  depth: Float32Array;
  /** Inverse projection matrix (column-major 4x4). */
  invProj: ArrayLike<number>;
  /** Camera-to-world matrix (column-major 4x4), i.e. the tracked camera pose. */
  camToWorld: ArrayLike<number>;
  /** Optional per-pixel range uncertainty (m), e.g. from motion stereo geometry. */
  sigma?: Float32Array;
}

/**
 * Remove depth discontinuity pixels. Depth sensors (especially
 * depth-from-motion) smear depth across object silhouettes; those "flying
 * pixels" land behind the object and would carve free space through it.
 *
 * Inverse depth is linear across any flat surface (floors seen at a glancing
 * angle included), so a pixel is flagged when the second difference of
 * inverse depth across it, horizontally or vertically, exceeds `rel` of its
 * own inverse depth. Slopes pass; steps and spikes don't.
 */
export function filterDiscontinuities(img: DepthImage, rel = 0.08): Float32Array {
  const { w, h, depth } = img;
  const out = new Float32Array(depth.length);
  const inv = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const d = depth[y * w + x];
    return d > 0 ? 1 / d : 0;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = inv(x, y);
      if (!q) continue;
      let ok = true;
      for (const [dx, dy] of DIRS) {
        const a = inv(x - dx, y - dy), b = inv(x + dx, y + dy);
        if (a && b) {
          if (Math.abs(a + b - 2 * q) > rel * q) ok = false;
        } else if (a || b) {
          // At the border of a hole or the image: first difference only, generous.
          const n = a || b;
          if (Math.abs(n - q) > 2 * rel * q) ok = false;
        }
        if (!ok) break;
      }
      if (ok) out[y * w + x] = depth[y * w + x];
    }
  return out;
}

const DIRS = [
  [1, 0],
  [0, 1],
];

/** Lift every valid pixel to a world-space point. */
export function depthImageToPoints(img: DepthImage, depth: Float32Array = img.depth, sigmas?: number[]): Vec3[] {
  const { w, h, invProj: P, camToWorld: M } = img;
  const out: Vec3[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = depth[y * w + x];
      if (!(d > 0.05 && d < 50)) continue; // also rejects NaN and Infinity
      const nx = ((x + 0.5) / w) * 2 - 1, ny = 1 - ((y + 0.5) / h) * 2;
      // Unproject the near-plane point (nx, ny, -1) to view space.
      const vx = P[0] * nx + P[4] * ny - P[8] + P[12];
      const vy = P[1] * nx + P[5] * ny - P[9] + P[13];
      const vz = P[2] * nx + P[6] * ny - P[10] + P[14];
      const vw = P[3] * nx + P[7] * ny - P[11] + P[15];
      const px = vx / vw, py = vy / vw, pz = vz / vw;
      const s = d / -pz;
      const cx = px * s, cy = py * s, cz = pz * s;
      if (sigmas) sigmas.push(img.sigma ? img.sigma[y * w + x] : 0);
      out.push({
        x: M[0] * cx + M[4] * cy + M[8] * cz + M[12],
        y: M[1] * cx + M[5] * cy + M[9] * cz + M[13],
        z: M[2] * cx + M[6] * cy + M[10] * cz + M[14],
      });
    }
  return out;
}

/**
 * Rejects depth frames taken while tracking is unreliable: while the device
 * reports an emulated (dead-reckoned) position, and for a while after a
 * sudden pose correction (relocalisation), which shows up as a jump that
 * doesn't fit the recent motion.
 */
export class PoseGate {
  private last: { p: Vec3; f: Vec3; t: number } | null = null;
  private vel: Vec3 = { x: 0, y: 0, z: 0 };
  private angVel = 0;
  private holdUntil = -Infinity;
  rejected = 0;
  accepted = 0;
  /** Why frames were turned away: emulated pose, held after a jump, turning too fast. */
  readonly reasons = { emulated: 0, hold: 0, fast: 0, posJumps: 0, rotJumps: 0 };
  /**
   * The most recent unexplained jump of the camera position (map frame):
   * where it is now minus where its motion said it would be. A tracker
   * relocalising or closing a loop moves the whole frame by about this much.
   */
  lastJump: { t: number; dx: number; dy: number; dz: number } | null = null;
  /**
   * Smarter rotation test (v2): a jump is a rotation that doesn't fit the
   * recent angular velocity (hand-held phones turn fast but smoothly), and
   * frames turning faster than `maxAngVel` are dropped on their own (motion
   * blur) without holding the following ones. Off: any turn faster than
   * maxRotResidual + 2.5 rad/s·dt holds for holdSeconds (the original rule).
   */
  smartRotation = false;
  maxAngVel = 3.2;
  constructor(readonly maxPosResidual = 0.04, readonly maxRotResidual = 0.05, readonly holdSeconds = 0.8) {}

  /** Forget motion history (e.g. after the map frame was deliberately corrected). */
  reset(): void {
    this.last = null;
    this.vel = { x: 0, y: 0, z: 0 };
    this.angVel = 0;
  }

  accept(eye: Vec3, forward: Vec3, t: number, emulated = false): boolean {
    let ok = true;
    if (emulated) {
      this.holdUntil = t + this.holdSeconds;
      ok = false;
      this.reasons.emulated++;
    } else if (this.last) {
      const dt = Math.max(1e-3, t - this.last.t);
      // Residual against a constant-velocity prediction.
      const rx = eye.x - (this.last.p.x + this.vel.x * dt), ry = eye.y - (this.last.p.y + this.vel.y * dt), rz = eye.z - (this.last.p.z + this.vel.z * dt);
      const posRes = Math.hypot(rx, ry, rz);
      const dot = forward.x * this.last.f.x + forward.y * this.last.f.y + forward.z * this.last.f.z;
      const turned = Math.acos(Math.max(-1, Math.min(1, dot)));
      const posJump = dt < 0.5 && posRes > this.maxPosResidual + 0.3 * dt;
      // Hand-held phones turn fast but smoothly; a jump is a big unexplained step.
      const rotJump = dt < 0.5 && (this.smartRotation ? Math.abs(turned - this.angVel * dt) > this.maxRotResidual + 1.5 * dt : turned > this.maxRotResidual + 2.5 * dt);
      if (posJump || rotJump) {
        this.holdUntil = t + this.holdSeconds;
        if (posJump) {
          this.reasons.posJumps++;
          this.lastJump = { t, dx: rx, dy: ry, dz: rz };
        } else this.reasons.rotJumps++;
      }
      this.angVel = dt < 0.5 ? turned / dt : 0;
      if (this.smartRotation && this.angVel > this.maxAngVel) {
        ok = false;
        this.reasons.fast++;
      }
      // After a jump, the velocity estimate must not include it.
      this.vel = posJump ? this.vel : { x: (eye.x - this.last.p.x) / dt, y: (eye.y - this.last.p.y) / dt, z: (eye.z - this.last.p.z) / dt };
    }
    this.last = { p: { ...eye }, f: { ...forward }, t };
    if (t < this.holdUntil && ok) {
      ok = false;
      this.reasons.hold++;
    }
    if (ok) this.accepted++;
    else this.rejected++;
    return ok;
  }
}

/**
 * Multi-view consistency check for depth that may be densified (ARCore's
 * "full depth", which WebXR delivers): holes in texture-less areas are
 * filled by interpolation, and those guesses change as the camera moves,
 * while real geometry doesn't. Each pixel of a new frame is lifted to 3D and
 * re-projected into recent frames taken from elsewhere:
 *  - consistent: an earlier frame saw a surface at the same depth;
 *  - contradicted: an earlier frame looked *through* that point, i.e. saw
 *    something clearly farther along the same line of sight.
 * Pixels with no support from any other view, or with any contradiction,
 * are dropped. This costs coverage and saves the map from
 * hallucinated surfaces and, worse, hallucinated free space.
 */
export interface ConsistencyOptions {
  /** Frames kept for comparison. */
  history: number;
  /** Minimum camera displacement (m) or rotation (rad) for an earlier view to count as "elsewhere". */
  minBaseline: number;
  minAngle: number;
  maxAge: number;
  /** Depth agreement tolerance: max(abs, rel × depth). */
  tolAbs: number;
  tolRel: number;
  /** Required supporting views. */
  minSupport: number;
}

export const DEFAULT_CONSISTENCY: ConsistencyOptions = { history: 8, minBaseline: 0.05, minAngle: 0.08, maxAge: 3, tolAbs: 0.04, tolRel: 0.05, minSupport: 1 };

export class DepthConsistency {
  readonly opts: ConsistencyOptions;
  private frames: { img: DepthImage; inv: number[]; t: number }[] = [];
  /** Running counts (for reports). */
  kept = 0;
  dropped = 0;
  constructor(opts: Partial<ConsistencyOptions> = {}) {
    this.opts = { ...DEFAULT_CONSISTENCY, ...opts };
  }

  reset(): void {
    this.frames = [];
  }

  /** Returns a filtered copy of `depth` (0 = rejected) and remembers the frame. */
  filter(img: DepthImage, depth: Float32Array, t: number): Float32Array {
    const O = this.opts, M = img.camToWorld;
    const others = this.frames.filter((f) => {
      if (t - f.t > O.maxAge || t < f.t) return false;
      const F = f.img.camToWorld;
      const b = Math.hypot(F[12] - M[12], F[13] - M[13], F[14] - M[14]);
      const ang = Math.acos(Math.max(-1, Math.min(1, F[8] * M[8] + F[9] * M[9] + F[10] * M[10])));
      return b >= O.minBaseline || ang >= O.minAngle;
    });
    const out = new Float32Array(depth.length);
    const pts = depthImageToPoints(img, depth);
    // depthImageToPoints skips invalid pixels; walk pixels in the same order.
    let q = 0;
    for (let i = 0; i < depth.length; i++) {
      if (!(depth[i] > 0.05 && depth[i] < 50)) continue; // same test as depthImageToPoints
      const p = pts[q++];
      let support = 0, contra = false;
      for (let fi = 0; fi < others.length; fi++) {
        // Project p into frame f: its z-depth there, and the depth f recorded at that pixel.
        // (Inline, no per-sample allocation: this runs ~100k times per depth frame.)
        const f = others[fi], inv = f.inv, fim = f.img, P = fim.invProj;
        const cx = inv[0] * p.x + inv[4] * p.y + inv[8] * p.z + inv[12];
        const cy = inv[1] * p.x + inv[5] * p.y + inv[9] * p.z + inv[13];
        const cz = inv[2] * p.x + inv[6] * p.y + inv[10] * p.z + inv[14];
        if (cz > -0.05) continue;
        const nx = (cx / -cz - (P[12] - P[8])) / P[0], ny = (cy / -cz - (P[13] - P[9])) / P[5];
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
        const px = Math.min(fim.w - 1, Math.floor(((nx + 1) / 2) * fim.w)), py = Math.min(fim.h - 1, Math.floor(((1 - ny) / 2) * fim.h));
        const proj = -cz, seen = fim.depth[py * fim.w + px];
        if (!(seen > 0.05)) continue;
        const tol = Math.max(O.tolAbs, O.tolRel * proj);
        if (Math.abs(seen - proj) <= tol) support++;
        else if (seen > proj + 2 * tol) {
          contra = true;
          break;
        }
      }
      if (!contra && support >= O.minSupport) {
        out[i] = depth[i];
        this.kept++;
      } else this.dropped++;
    }
    this.frames.push({ img: { ...img, depth: depth.slice() }, inv: invertRigidArr(M), t });
    if (this.frames.length > O.history) this.frames.shift();
    return out;
  }
}

function invertRigidArr(M: ArrayLike<number>): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * M[12] + o[4 + r] * M[13] + o[8 + r] * M[14]);
  o[15] = 1;
  return o;
}


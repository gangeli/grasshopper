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
export function depthImageToPoints(img: DepthImage, depth: Float32Array = img.depth): Vec3[] {
  const { w, h, invProj: P, camToWorld: M } = img;
  const out: Vec3[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = depth[y * w + x];
      if (!(d > 0.05)) continue;
      const nx = ((x + 0.5) / w) * 2 - 1, ny = 1 - ((y + 0.5) / h) * 2;
      // Unproject the near-plane point (nx, ny, -1) to view space.
      const vx = P[0] * nx + P[4] * ny - P[8] + P[12];
      const vy = P[1] * nx + P[5] * ny - P[9] + P[13];
      const vz = P[2] * nx + P[6] * ny - P[10] + P[14];
      const vw = P[3] * nx + P[7] * ny - P[11] + P[15];
      const px = vx / vw, py = vy / vw, pz = vz / vw;
      const s = d / -pz;
      const cx = px * s, cy = py * s, cz = pz * s;
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
  private holdUntil = -Infinity;
  rejected = 0;
  accepted = 0;
  constructor(readonly maxPosResidual = 0.04, readonly maxRotResidual = 0.05, readonly holdSeconds = 0.8) {}

  accept(eye: Vec3, forward: Vec3, t: number, emulated = false): boolean {
    let ok = true;
    if (emulated) {
      this.holdUntil = t + this.holdSeconds;
      ok = false;
    } else if (this.last) {
      const dt = Math.max(1e-3, t - this.last.t);
      // Residual against a constant-velocity prediction.
      const rx = eye.x - (this.last.p.x + this.vel.x * dt), ry = eye.y - (this.last.p.y + this.vel.y * dt), rz = eye.z - (this.last.p.z + this.vel.z * dt);
      const posRes = Math.hypot(rx, ry, rz);
      const dot = forward.x * this.last.f.x + forward.y * this.last.f.y + forward.z * this.last.f.z;
      const turned = Math.acos(Math.max(-1, Math.min(1, dot)));
      // Hand-held phones turn fast but smoothly; a jump is a big unexplained step.
      if (dt < 0.5 && (posRes > this.maxPosResidual + 0.3 * dt || turned > this.maxRotResidual + 2.5 * dt)) this.holdUntil = t + this.holdSeconds;
      this.vel = { x: (eye.x - this.last.p.x) / dt, y: (eye.y - this.last.p.y) / dt, z: (eye.z - this.last.p.z) / dt };
    }
    this.last = { p: { ...eye }, f: { ...forward }, t };
    if (t < this.holdUntil) ok = false;
    if (ok) this.accepted++;
    else this.rejected++;
    return ok;
  }
}

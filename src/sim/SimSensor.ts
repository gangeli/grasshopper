import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import type { MeshInput, PlaneInput } from '../world/WorldModel';
import { depthImageToPoints, filterDiscontinuities, type DepthImage } from '../world/DepthFrame';
import type { SimRoom } from './SimRoom';
import { densify } from '../world/StereoDepth';

/** Pinhole camera pose. yaw=0 looks down -Z (three.js convention), pitch>0 looks up. */
export interface SimCamera {
  pos: Vec3;
  yaw: number;
  pitch: number;
  fovY: number; // radians
  aspect: number;
}

export function cameraBasis(c: SimCamera) {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const forward = { x: -sy * cp, y: sp, z: -cy * cp };
  const right = { x: cy, y: 0, z: -sy };
  const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x };
  return { forward, right, up };
}

/** Project a world point; returns NDC (x,y ∈ [-1,1] when in view) and depth along forward. */
export function projectPoint(c: SimCamera, p: Vec3) {
  const { forward, right, up } = cameraBasis(c);
  const d = { x: p.x - c.pos.x, y: p.y - c.pos.y, z: p.z - c.pos.z };
  const z = d.x * forward.x + d.y * forward.y + d.z * forward.z;
  const x = d.x * right.x + d.y * right.y + d.z * right.z;
  const y = d.x * up.x + d.y * up.y + d.z * up.z;
  const t = Math.tan(c.fovY / 2);
  return { x: x / (z * t * c.aspect), y: y / (z * t), depth: z };
}

export function inFrustum(c: SimCamera, p: Vec3, margin = 1): boolean {
  const q = projectPoint(c, p);
  return q.depth > 0.05 && Math.abs(q.x) <= margin && Math.abs(q.y) <= margin;
}

/**
 * How a real depth camera + tracker deviates from the truth. Values are
 * per-frame (depth frames arrive at ~10Hz in the sim).
 */
export interface NoiseProfile {
  name: string;
  depthRes: [number, number];
  /** Depth noise sigma = sigmaA + sigmaB * z² (metres). */
  sigmaA: number;
  sigmaB: number;
  /** Fraction of edge pixels that take an in-between depth. */
  flyingPixels: number;
  /** Blur radius (pixels) and how much interior pixels are smoothed (0..1). */
  edgeBlur: number;
  smooth: number;
  dropout: number;
  holeBlobs: number;
  outliers: number;
  maxRange: number;
  /** Tracking drift (random walk, per sqrt(s)) and per-frame jitter. */
  driftPos: number;
  driftRot: number;
  jitterPos: number;
  jitterRot: number;
  planeEdgeErr: number;
  planeHeightErr: number;
  /** Error of the floor height taken from the placement tap. */
  floorErr: number;
  /** Persistent, world-anchored depth error (× sigma): doesn't average out over frames. */
  persistentBias?: number;
  /** Simulate materials (blank walls, dark fabric, glass, mirrors) and moving people. */
  materials?: boolean;
  /** Per-frame chance of a relocalisation jump, and its size. */
  relocRate?: number;
  relocPos?: number;
  relocRot?: number;
  /** Per-frame chance of losing tracking (no data for ~1–2s, then a jump). */
  lossRate?: number;
  /** Angular speed (rad/s) above which frames are too blurred to give depth. */
  blurAngVel?: number;
  /** Fill every hole by interpolation, like ARCore's full (densified) depth in WebXR. */
  densify?: boolean;
  /**
   * Visual-inertial odometry drift that grows with the path walked (only
   * accumulates when the sensor is told about the camera's motion, see
   * SimSensor.moveTo). The whole tracking frame slowly slides and turns
   * about the camera, so what is near is consistent and what was mapped
   * long ago no longer lines up.
   */
  odometry?: OdometryDrift;
}

export interface OdometryDrift {
  /** Position drift as a fraction of the distance walked (direction wanders slowly). */
  posPerM: number;
  /** Yaw random walk per sqrt(m) walked (rad/√m). */
  yawPerSqrtM: number;
  /** Optional constant yaw bias per metre walked (rad/m). */
  yawPerM?: number;
  /** Yaw random walk per sqrt(rad) turned (gyro noise). */
  yawPerSqrtRad: number;
  /**
   * The tracker's own loop closure: back near a place it saw at least
   * `loopMinAge` s ago, it snaps its frame back to how it was then (a sudden
   * jump) at this rate per second. 0 = never.
   */
  loopRate: number;
  loopMinAge: number;
  /**
   * VIO stays locked onto features it has in its local map: drift grows at
   * the full rate only through new territory. Near a place seen within
   * `localAge` s it grows at `localFactor` of the rate, near older places at
   * `oldFactor`. (Defaults 1: drift with every metre, wherever.)
   */
  localFactor?: number;
  oldFactor?: number;
  localAge?: number;
}

/** Typical hand-held VIO over a home: ~1% of the path, a degree or two of yaw per 20m, occasional loop closures. */
export const HOUSE_ODOMETRY: OdometryDrift = { posPerM: 0.015, yawPerSqrtM: 0.002, yawPerSqrtRad: 0.002, loopRate: 0.15, loopMinAge: 30, localFactor: 0.1, oldFactor: 0.5, localAge: 30 };

export const NOISE_PROFILES = {
  ideal: { name: 'ideal', depthRes: [40, 30], sigmaA: 0, sigmaB: 0.004, flyingPixels: 0, edgeBlur: 0, smooth: 0, dropout: 0, holeBlobs: 0, outliers: 0, maxRange: 6, driftPos: 0, driftRot: 0, jitterPos: 0, jitterRot: 0, planeEdgeErr: 0, planeHeightErr: 0, floorErr: 0 },
  /** A typical ARCore phone with a decent tracking session. */
  arcore: { name: 'arcore', depthRes: [40, 30], sigmaA: 0.006, sigmaB: 0.012, flyingPixels: 0.5, edgeBlur: 1, smooth: 0.3, dropout: 0.1, holeBlobs: 2, outliers: 0.005, maxRange: 5, driftPos: 0.01, driftRot: 0.004, jitterPos: 0.003, jitterRot: 0.002, planeEdgeErr: 0.05, planeHeightErr: 0.01, floorErr: 0.015 },
  /** A bad day: dim room, older phone, fast motion. */
  /**
   * Realistic operating conditions for an ARCore phone: everything in
   * 'arcore' plus persistent (non-averaging) depth bias, hard materials,
   * relocalisation jumps, tracking loss and motion blur. Use with dressRoom()
   * and humanScanPath().
   */
  real: { name: 'real', depthRes: [40, 30], sigmaA: 0.008, sigmaB: 0.015, flyingPixels: 0.6, edgeBlur: 1, smooth: 0.4, dropout: 0.12, holeBlobs: 2, outliers: 0.01, maxRange: 5, driftPos: 0.012, driftRot: 0.005, jitterPos: 0.004, jitterRot: 0.002, planeEdgeErr: 0.06, planeHeightErr: 0.012, floorErr: 0.015, persistentBias: 1.0, materials: true, relocRate: 0.01, relocPos: 0.08, relocRot: 0.03, lossRate: 0.004, blurAngVel: 2.5 },
  /** 'real' plus odometry drift over long walks (multi-room homes). */
  house: { name: 'house', depthRes: [40, 30], sigmaA: 0.008, sigmaB: 0.015, flyingPixels: 0.6, edgeBlur: 1, smooth: 0.4, dropout: 0.12, holeBlobs: 2, outliers: 0.01, maxRange: 5, driftPos: 0.012, driftRot: 0.005, jitterPos: 0.004, jitterRot: 0.002, planeEdgeErr: 0.06, planeHeightErr: 0.012, floorErr: 0.015, persistentBias: 1.0, materials: true, relocRate: 0.01, relocPos: 0.08, relocRot: 0.03, lossRate: 0.004, blurAngVel: 2.5, odometry: HOUSE_ODOMETRY, densify: true },
  /** 'house' with twice the odometry drift and a tracker that rarely closes loops by itself. */
  'house-hard': { name: 'house-hard', depthRes: [40, 30], sigmaA: 0.008, sigmaB: 0.015, flyingPixels: 0.6, edgeBlur: 1, smooth: 0.4, dropout: 0.12, holeBlobs: 2, outliers: 0.01, maxRange: 5, driftPos: 0.012, driftRot: 0.005, jitterPos: 0.004, jitterRot: 0.002, planeEdgeErr: 0.06, planeHeightErr: 0.012, floorErr: 0.015, persistentBias: 1.0, materials: true, relocRate: 0.01, relocPos: 0.08, relocRot: 0.03, lossRate: 0.006, blurAngVel: 2.5, odometry: { posPerM: 0.025, yawPerSqrtM: 0.004, yawPerSqrtRad: 0.003, loopRate: 0.03, loopMinAge: 30, localFactor: 0.15, oldFactor: 0.6, localAge: 30 }, densify: true },
  harsh: { name: 'harsh', depthRes: [32, 24], sigmaA: 0.01, sigmaB: 0.025, flyingPixels: 0.8, edgeBlur: 1, smooth: 0.5, dropout: 0.25, holeBlobs: 4, outliers: 0.02, maxRange: 4, driftPos: 0.025, driftRot: 0.01, jitterPos: 0.008, jitterRot: 0.005, planeEdgeErr: 0.1, planeHeightErr: 0.02, floorErr: 0.03 },
} satisfies Record<string, NoiseProfile>;
export type NoiseName = keyof typeof NOISE_PROFILES;

const MAT_CODE = { matte: 0, textureless: 1, dark: 2, glass: 0, mirror: 0 } as const;

/** Smooth 3D value noise in [-1,1], ~0.4m feature size. */
export function worldNoise(x: number, y: number, z: number): number {
  const s = 2.5;
  x *= s;
  y *= s;
  z *= s;
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

function mulCM(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
  return o;
}

/** Camera-to-world (column-major) for a camera with a tracking error applied. */
export function poseMatrix(cam: SimCamera, pose: { yaw: number; pitch: number; x: number; y: number; z: number }): number[] {
  const { forward, right, up } = cameraBasis(cam);
  // Directions only rotate: the translation error must not leak into the basis.
  const rot = { ...pose, x: 0, y: 0, z: 0 };
  const est = (v: Vec3) => applyPoseError(rot, { x: 0, y: 0, z: 0 }, v);
  const X = est(right), Y = est(up), Zb = est({ x: -forward.x, y: -forward.y, z: -forward.z });
  const T = applyPoseError(pose, cam.pos, cam.pos);
  return [X.x, X.y, X.z, 0, Y.x, Y.y, Y.z, 0, Zb.x, Zb.y, Zb.z, 0, T.x, T.y, T.z, 1];
}

/** Inverse of a standard perspective projection (near 0.1, far 100) for this camera. */
export function invProjFor(cam: { fovY: number; aspect: number }): number[] {
  const n = 0.1, f = 100, ty = Math.tan(cam.fovY / 2), tx = ty * cam.aspect;
  return [tx, 0, 0, 0, 0, ty, 0, 0, 0, 0, 0, (n - f) / (2 * f * n), 0, 0, -1, (f + n) / (2 * f * n)];
}

function applyPoseError(e: { yaw: number; pitch: number; x: number; y: number; z: number }, c: Vec3, p: Vec3): Vec3 {
  // Rotate about the camera, then translate.
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
  const cy = Math.cos(e.yaw), sy = Math.sin(e.yaw), cp = Math.cos(e.pitch), sp = Math.sin(e.pitch);
  const x1 = dx * cy + dz * sy, z1 = -dx * sy + dz * cy;
  const y2 = dy * cp - z1 * sp, z2 = dy * sp + z1 * cp;
  return { x: c.x + x1 + e.x, y: c.y + y2 + e.y, z: c.z + z2 + e.z };
}

export interface SensorCaps {
  depth: boolean;
  planes: boolean;
  mesh: boolean;
}

export class SimSensor {
  private rng: Rng;
  private detectedPlanes = new Map<string, PlaneInput>();
  private texturelessPlanes = new Set<string>();
  private allPlanes: PlaneInput[];
  /** Unperturbed planes: detection depends on whether the real surface is seen. */
  private truePlanes: PlaneInput[];
  readonly noise: NoiseProfile;
  constructor(readonly room: SimRoom, readonly caps: SensorCaps = { depth: true, planes: true, mesh: false }, seed = 7, noise: NoiseProfile | NoiseName = 'ideal') {
    this.rng = new Rng(seed);
    this.noise = typeof noise === 'string' ? NOISE_PROFILES[noise] : noise;
    this.truePlanes = buildPlanes(room);
    this.allPlanes = this.truePlanes.map((p) => this.perturbPlane(p));
    // Planes on texture-less surfaces (blank walls, bare floors) are harder to detect.
    for (const p of this.allPlanes) {
      const m = p.id === 'floor' || p.id.startsWith('floor_') ? room.floorMaterial : room.boxes[Number(p.id.replace(/\D+(\d+).*/, '$1'))]?.material;
      if (this.noise.materials && m === 'textureless') this.texturelessPlanes.add(p.id);
    }
  }

  /** Plane detection is imprecise: boundaries are off and heights wobble a little. */
  private perturbPlane(p: PlaneInput): PlaneInput {
    const N = this.noise;
    if (!N.planeEdgeErr && !N.planeHeightErr) return p;
    const c = p.polygon.reduce((a, q) => ({ x: a.x + q.x / p.polygon.length, y: a.y + q.y / p.polygon.length, z: a.z + q.z / p.polygon.length }), { x: 0, y: 0, z: 0 });
    const horizontal = Math.abs(p.normal.y) > 0.85;
    const dh = horizontal ? this.gauss() * N.planeHeightErr : 0;
    const polygon = p.polygon.map((q) => {
      // Move each vertex towards/away from the centre by a random amount (edge error).
      const dx = q.x - c.x, dy = q.y - c.y, dz = q.z - c.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      const e = this.gauss() * N.planeEdgeErr;
      return { x: q.x + (dx / L) * e, y: q.y + (horizontal ? dh : (dy / L) * e), z: q.z + (dz / L) * e };
    });
    return { ...p, polygon };
  }

  /**
   * A low-res depth image like ARCore's, turned into world points, degraded
   * according to the sensor's noise profile (see NOISE_PROFILES).
   */
  depthPoints(cam: SimCamera, w = this.noise.depthRes[0], h = this.noise.depthRes[1]): Vec3[] {
    const img = this.depthImage(cam, w, h);
    return depthImageToPoints(img, filterDiscontinuities(img));
  }

  /**
   * The raw depth image the device would hand the app, with its *tracked*
   * (estimated, possibly wrong) camera pose. Same format as ArMode builds from
   * WebXR, so the same front-end (filtering, gating) runs on both.
   */
  depthImage(cam: SimCamera, w = this.noise.depthRes[0], h = this.noise.depthRes[1]): DepthImage {
    const N = this.noise;
    const { forward, right, up } = cameraBasis(cam);
    const t = Math.tan(cam.fovY / 2);
    const far = N.maxRange * 1.6;
    // 1. True depth image (z-depth) and ray directions.
    const depth = new Float32Array(w * h);
    const mats = new Uint8Array(w * h);
    const dirs: Vec3[] = new Array(w * h);
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const nx = ((px + 0.5) / w) * 2 - 1, ny = ((py + 0.5) / h) * 2 - 1;
        const dx = forward.x + right.x * nx * t * cam.aspect + up.x * ny * t;
        const dy = forward.y + right.y * nx * t * cam.aspect + up.y * ny * t;
        const dz = forward.z + right.z * nx * t * cam.aspect + up.z * ny * t;
        const l = Math.hypot(dx, dy, dz);
        const d = { x: dx / l, y: dy / l, z: dz / l };
        let range: number;
        if (N.materials) {
          const sr = this.room.sensorRay(cam.pos, d, far);
          range = Number.isFinite(sr.range) ? sr.range : far;
          mats[py * w + px] = MAT_CODE[sr.material];
        } else {
          const hit = this.room.raycast(cam.pos, d, far);
          range = Number.isFinite(hit.t) ? hit.t : far;
        }
        dirs[py * w + px] = d;
        depth[py * w + px] = range * (d.x * forward.x + d.y * forward.y + d.z * forward.z);
      }
    // 2. Edge blur / flying pixels: depth sensors smear across discontinuities
    //    and smooth away thin structures (table legs).
    let img = depth;
    if (N.edgeBlur > 0) {
      const out = new Float32Array(w * h);
      const r = N.edgeBlur;
      for (let py = 0; py < h; py++)
        for (let px = 0; px < w; px++) {
          let sum = 0, n = 0;
          for (let yy = Math.max(0, py - r); yy <= Math.min(h - 1, py + r); yy++)
            for (let xx = Math.max(0, px - r); xx <= Math.min(w - 1, px + r); xx++) {
              sum += depth[yy * w + xx];
              n++;
            }
          const mean = sum / n, own = depth[py * w + px];
          // Median-ish behaviour: mostly keep own value, but near edges a fraction
          // of pixels take the blurred (in-between) value: classic flying pixels.
          const edge = Math.abs(mean - own) > 0.08 * own;
          out[py * w + px] = edge && this.rng.chance(N.flyingPixels) ? mean : own * (1 - N.smooth) + mean * N.smooth;
        }
      img = out;
    }
    // 3. Low-frequency correlated bias + per-pixel noise, both growing with distance.
    const gx = 4, gy = 3;
    const bias = Array.from({ length: (gx + 1) * (gy + 1) }, () => this.gauss());
    const biasAt = (u: number, v: number) => {
      const fx = u * gx, fy = v * gy;
      const x0 = Math.min(gx - 1, Math.floor(fx)), y0 = Math.min(gy - 1, Math.floor(fy));
      const ax = fx - x0, ay = fy - y0;
      const b = (x: number, y: number) => bias[y * (gx + 1) + x];
      return (b(x0, y0) * (1 - ax) + b(x0 + 1, y0) * ax) * (1 - ay) + (b(x0, y0 + 1) * (1 - ax) + b(x0 + 1, y0 + 1) * ax) * ay;
    };
    // 4. Holes: blobs where the sensor returns nothing (texture-less or dark areas).
    const holes = Array.from({ length: N.holeBlobs }, () => ({ x: this.rng.next(), y: this.rng.next(), r: this.rng.range(0.05, 0.18) }));
    // 5. Pose error for this frame: slow drift plus jitter.
    const pose = this.stepPoseError();
    const out = new Float32Array(w * h);
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const u = (px + 0.5) / w, v = (py + 0.5) / h;
        if (this.rng.chance(N.dropout)) continue;
        if (holes.some((hb) => (u - hb.x) ** 2 + (v - hb.y) ** 2 < hb.r * hb.r)) continue;
        const i = py * w + px;
        const d = dirs[i];
        const cosA = d.x * forward.x + d.y * forward.y + d.z * forward.z;
        let z = img[i];
        // Hard materials: blank surfaces and dark fabric give holes and extra noise.
        const mat = mats[i];
        if (mat === 1 && this.rng.chance(0.5)) continue;
        if (mat === 2 && this.rng.chance(0.6)) continue;
        const matGain = mat === 1 ? 2.5 : mat === 2 ? 1.5 : 1;
        if (this.rng.chance(N.outliers)) z = this.rng.range(0.3, N.maxRange);
        else {
          const sigma = (N.sigmaA + N.sigmaB * z * z) * matGain;
          let e = 0.6 * this.gauss() + 0.8 * biasAt(u, v);
          if (N.persistentBias) {
            // World-anchored error at the true surface point: the same wall is
            // "bent" the same way every time it's seen.
            const r0 = z / cosA;
            e += N.persistentBias * 1.5 * worldNoise(cam.pos.x + d.x * r0, cam.pos.y + d.y * r0, cam.pos.z + d.z * r0);
          }
          z += sigma * e;
        }
        if (!(z > 0.2) || z > N.maxRange) continue; // no reading
        out[(h - 1 - py) * w + px] = z; // image row 0 = top
      }
    // ARCore's "full depth" (what WebXR hands out) has no holes: every
    // pixel the sensor couldn't measure is interpolated from its
    // surroundings, with no confidence attached (dark fabric seen as the wall
    // behind it, a blank floor as a smooth guess).
    const dense = N.densify ? densify(out, new Float32Array(w * h), w, h, 2) : out;
    if (N.densify) for (let i = 0; i < dense.length; i++) if (dense[i] > N.maxRange * 1.6 || !(dense[i] > 0)) dense[i] = 0;
    return { w, h, depth: dense, invProj: invProjFor(cam), camToWorld: this.withShift(poseMatrix(cam, pose)) };
  }

  /**
   * The camera pose the tracker reports for this frame (column-major
   * camera-to-world, three.js convention). Visual-inertial tracking is much
   * smoother frame to frame than the depth-registration jitter modelled in
   * depthImage(), so camera frames get a fraction of that jitter.
   */
  trackedCamToWorld(cam: SimCamera, jitterScale = 0.1): number[] {
    const j = this.stepPoseError(jitterScale);
    // VIO error drifts smoothly (the IMU integrates over many frames): low-pass
    // the random-walk drift, keep relocalisation jumps instantaneous.
    const s = this.smoothErr, e = this.poseErr, a = 0.03;
    for (const k of ['yaw', 'pitch', 'x', 'y', 'z'] as const) s[k] += (e[k] - s[k]) * a;
    return this.withShift(poseMatrix(cam, {
      yaw: s.yaw + (j.yaw - e.yaw),
      pitch: s.pitch + (j.pitch - e.pitch),
      x: s.x + (j.x - e.x),
      y: s.y + (j.y - e.y),
      z: s.z + (j.z - e.z),
    }));
  }
  private smoothErr = { yaw: 0, pitch: 0, x: 0, y: 0, z: 0 };

  /** Floor height as measured by the placement hit-test (with error). */
  floorEstimate(): number {
    return this.gauss() * this.noise.floorErr;
  }

  /** The camera position the device *believes* it is at (true pose + tracking error). */
  estimatedEye(cam: SimCamera): Vec3 {
    const p = applyPoseError(this.poseErr, cam.pos, cam.pos), J = this.trackingFromTruth();
    return { x: J[0] * p.x + J[4] * p.y + J[8] * p.z + J[12], y: J[1] * p.x + J[5] * p.y + J[9] * p.z + J[13], z: J[2] * p.x + J[6] * p.y + J[10] * p.z + J[14] };
  }

  private poseErr = { yaw: 0, pitch: 0, x: 0, y: 0, z: 0 };
  private poseJit = { yaw: 0, pitch: 0, x: 0, y: 0, z: 0 };
  /** Mean-reverting random walk (tracking drifts, then relocalises) plus jitter. */
  private lossFrames = 0;
  /** A real tracking-loss episode is in progress (not just a blurred frame). */
  get trackingLost(): boolean {
    return this.lossFrames > 0;
  }
  /** Tracking state for this frame: false while tracking is lost or the frame is too blurred. */
  trackingOk(angVel = 0): boolean {
    const N = this.noise;
    if (this.lossFrames > 0) {
      this.lossFrames--;
      if (this.lossFrames === 0) this.relocalise();
      return false;
    }
    if (N.lossRate && this.rng.chance(N.lossRate)) {
      this.lossFrames = this.rng.int(10, 20);
      return false;
    }
    if (N.relocRate && this.rng.chance(N.relocRate)) this.relocalise();
    if (N.blurAngVel && angVel > N.blurAngVel) return false;
    return true;
  }
  /**
   * Fault injection: the tracker's world frame jumps by (dx, dz, dyaw) and
   * stays there, like a bad relocalisation. Everything mapped before no
   * longer lines up with what the camera sees now.
   */
  injectPoseJump(dx: number, dz: number, dyaw: number, dy = 0): void {
    // Compose a rigid world-frame transform: yaw about the room origin, then shift.
    const c = Math.cos(dyaw), sn = Math.sin(dyaw);
    const J = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, dx, dy, dz, 1];
    this.jump = mulCM(J, this.jump);
  }
  /** Persistent rigid world-frame offset of the tracking frame (injected faults); unlike drift it doesn't revert. */
  jump: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  private withShift(M: number[]): number[] {
    return mulCM(this.jump, mulCM(this.drift, M));
  }

  /**
   * Odometry drift (world-frame rigid transform, tracking = jump · drift ·
   * truth). Identity unless the profile has `odometry` and moveTo is called.
   */
  drift: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  /** Truth → tracking frame (everything the device reports is in the tracking frame). */
  trackingFromTruth(): number[] {
    return mulCM(this.jump, this.drift);
  }
  private odo: { last: Vec3 | null; lastYaw: number; dirAngle: number; yawBias: number; walked: number; nextKey: number; keys: { p: Vec3; D: number[]; t: number }[] } = { last: null, lastYaw: 0, dirAngle: 0, yawBias: 0, walked: 0, nextKey: 0, keys: [] };
  /** Loop closures performed by the simulated tracker. */
  loopClosures = 0;
  /** Distance walked so far (m). */
  get walked(): number {
    return this.odo.walked;
  }

  /**
   * The camera moved to `cam` at time t (call every camera frame): grows
   * the odometry drift with the motion, and maybe closes a loop.
   */
  moveTo(cam: SimCamera, t: number, dt = 1 / 30): void {
    const O = this.noise.odometry;
    if (!O) return;
    const o = this.odo, p = cam.pos;
    if (!o.last) {
      o.last = { ...p };
      o.lastYaw = cam.yaw;
      o.dirAngle = this.rng.range(0, Math.PI * 2);
      o.yawBias = (this.rng.chance(0.5) ? 1 : -1) * (O.yawPerM ?? 0);
      return;
    }
    const dx = p.x - o.last.x, dz = p.z - o.last.z, dist = Math.hypot(dx, dz, p.y - o.last.y);
    let dyaw = cam.yaw - o.lastYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    o.last = { ...p };
    o.lastYaw = cam.yaw;
    o.walked += dist;
    // How new is this place to the tracker? (Nearest keyframe within 1.5m.)
    let novelty = 1;
    if (O.localFactor !== undefined || O.oldFactor !== undefined) {
      let recent = false, old = false;
      for (let q = o.keys.length - 1; q >= 0 && !recent; q--) {
        const k = o.keys[q];
        if (Math.hypot(k.p.x - p.x, k.p.z - p.z) > 1.5) continue;
        if (t - k.t < (O.localAge ?? 30)) recent = true;
        else old = true;
      }
      novelty = recent ? (O.localFactor ?? 1) : old ? (O.oldFactor ?? 1) : 1;
    }
    const step = dist * novelty;
    // Drift direction and yaw bias wander slowly with distance.
    o.dirAngle += this.gauss() * 0.3 * Math.sqrt(dist);
    const dpsi = o.yawBias * step + this.gauss() * O.yawPerSqrtM * Math.sqrt(step) + this.gauss() * O.yawPerSqrtRad * Math.sqrt(Math.abs(dyaw));
    const tx = Math.cos(o.dirAngle) * O.posPerM * step, tz = Math.sin(o.dirAngle) * O.posPerM * step;
    // Rotate about the camera's tracked position, then shift.
    const D = this.drift;
    const cx = D[0] * p.x + D[4] * p.y + D[8] * p.z + D[12], cz = D[2] * p.x + D[6] * p.y + D[10] * p.z + D[14];
    const c = Math.cos(dpsi), sn = Math.sin(dpsi);
    const R = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, cx - c * cx - sn * cz + tx, 0, cz + sn * cx - c * cz + tz, 1];
    this.drift = mulCM(R, D);
    // Keyframes every 0.5m walked; loop closure back near an old one.
    if (o.walked >= o.nextKey) {
      o.keys.push({ p: { ...p }, D: this.drift.slice(), t });
      o.nextKey = o.walked + 0.5;
    }
    if (O.loopRate > 0 && this.rng.chance(O.loopRate * dt)) {
      let best: { p: Vec3; D: number[]; t: number } | null = null, bd = 1.0;
      for (const k of o.keys) {
        if (t - k.t < O.loopMinAge) continue;
        const d = Math.hypot(k.p.x - p.x, k.p.z - p.z);
        if (d < bd) (bd = d), (best = k);
      }
      if (best) {
        // Snap back to the frame the place was seen in.
        const off = Math.hypot(best.D[12] - this.drift[12], best.D[14] - this.drift[14]) + Math.abs(Math.atan2(best.D[8], best.D[0]) - Math.atan2(this.drift[8], this.drift[0]));
        if (off > 0.02) {
          this.drift = best.D.slice();
          this.loopClosures++;
        }
      }
    }
  }

  /** A sudden pose correction (loop closure / relocalisation). */
  private relocalise() {
    const N = this.noise, e = this.poseErr;
    const dx = this.gauss() * (N.relocPos ?? 0), dz = this.gauss() * (N.relocPos ?? 0), dy = this.gauss() * (N.relocPos ?? 0) * 0.3, dyaw = this.gauss() * (N.relocRot ?? 0);
    e.x += dx;
    e.z += dz;
    e.y += dy;
    e.yaw += dyaw;
    // Jumps are instantaneous for the camera pose too.
    const sm = this.smoothErr;
    sm.x += dx;
    sm.z += dz;
    sm.y += dy;
    sm.yaw += dyaw;
  }

  private stepPoseError(jitterScale = 1) {
    const N = this.noise, e = this.poseErr, dt = 1 / 10;
    const k = 0.05; // reversion per frame
    e.yaw += -k * e.yaw + this.gauss() * N.driftRot * Math.sqrt(dt);
    e.pitch += -k * e.pitch + this.gauss() * N.driftRot * 0.5 * Math.sqrt(dt);
    e.x += -k * e.x + this.gauss() * N.driftPos * Math.sqrt(dt);
    e.y += -k * e.y + this.gauss() * N.driftPos * 0.5 * Math.sqrt(dt);
    e.z += -k * e.z + this.gauss() * N.driftPos * Math.sqrt(dt);
    const j = this.poseJit;
    j.yaw = e.yaw + this.gauss() * N.jitterRot * jitterScale;
    j.pitch = e.pitch + this.gauss() * N.jitterRot * jitterScale;
    j.x = e.x + this.gauss() * N.jitterPos * jitterScale;
    j.y = e.y + this.gauss() * N.jitterPos * jitterScale;
    j.z = e.z + this.gauss() * N.jitterPos * jitterScale;
    return j;
  }

  /** Planes become "detected" once part of them has been seen; they then persist. */
  planes(cam: SimCamera): PlaneInput[] {
    for (const [q, p] of this.allPlanes.entries()) {
      if (this.detectedPlanes.has(p.id)) continue;
      const samples = planeSamples(this.truePlanes[q]);
      let seen = 0;
      for (const s of samples) {
        const lifted = { x: s.x + p.normal.x * 0.01, y: s.y + p.normal.y * 0.01, z: s.z + p.normal.z * 0.01 };
        if (inFrustum(cam, lifted, 0.95) && this.room.visible(cam.pos, lifted)) seen++;
      }
      // Blank surfaces need a much better look before a plane is found.
      // Detected in the tracking frame as it is now (it then stays put; any odometry drift is baked in).
      if (seen >= (this.texturelessPlanes.has(p.id) ? 8 : 2)) this.detectedPlanes.set(p.id, this.noise.odometry ? transformPlane(p, this.drift) : p);
    }
    return [...this.detectedPlanes.values()];
  }

  /** Full scene mesh, as delivered by headsets that have a room scan. */
  meshes(): MeshInput[] {
    const W = this.room.halfW, D = this.room.halfD;
    const floor: MeshInput = { id: 'meshFloor', positions: [-W, 0, -D, W, 0, -D, W, 0, D, -W, 0, D], indices: [0, 2, 1, 0, 3, 2], label: 'floor' };
    return [floor, ...this.room.pieces.map((pc) => {
      const positions: number[] = [];
      const indices: number[] = [];
      for (const b of pc.boxes) {
        const base = positions.length / 3;
        const xs = [b.min.x, b.max.x], ys = [b.min.y, b.max.y], zs = [b.min.z, b.max.z];
        for (let c = 0; c < 8; c++) positions.push(xs[c & 1], ys[(c >> 1) & 1], zs[(c >> 2) & 1]);
        const quads = [
          [0, 1, 3, 2],
          [4, 6, 7, 5],
          [0, 4, 5, 1],
          [2, 3, 7, 6],
          [0, 2, 6, 4],
          [1, 5, 7, 3],
        ];
        const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
        const P = (q: number) => [positions[(base + q) * 3], positions[(base + q) * 3 + 1], positions[(base + q) * 3 + 2]];
        for (const [a, b2, c, d] of quads) {
          // Orient each face outward (CCW seen from outside).
          const [ax, ay, az] = P(a), [bx, by, bz] = P(b2), [qx, qy, qz] = P(c);
          const nx = (by - ay) * (qz - az) - (bz - az) * (qy - ay);
          const ny = (bz - az) * (qx - ax) - (bx - ax) * (qz - az);
          const nz = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
          const out = nx * (ax - cx) + ny * (ay - cy) + nz * (az - cz) > 0;
          if (out) indices.push(base + a, base + b2, base + c, base + a, base + c, base + d);
          else indices.push(base + a, base + c, base + b2, base + a, base + d, base + c);
        }
      }
      return { id: `mesh${pc.id}`, positions, indices, label: pc.label };
    })];
  }

  private gauss(): number {
    const u = Math.max(1e-9, this.rng.next()), v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

function transformPlane(p: PlaneInput, M: number[]): PlaneInput {
  const tp = (q: Vec3, w: number) => ({ x: M[0] * q.x + M[4] * q.y + M[8] * q.z + M[12] * w, y: M[1] * q.x + M[5] * q.y + M[9] * q.z + M[13] * w, z: M[2] * q.x + M[6] * q.y + M[10] * q.z + M[14] * w });
  return { ...p, polygon: p.polygon.map((q) => tp(q, 1)), normal: tp(p.normal, 0) };
}

function planeSamples(p: PlaneInput): Vec3[] {
  const c = p.polygon;
  const out: Vec3[] = [];
  // Polygons here are rectangles: bilinear 4x4 samples.
  for (let a = 0.1; a < 1; a += 0.27)
    for (let b = 0.1; b < 1; b += 0.27) {
      const p0 = lerp3(c[0], c[1], a), p1 = lerp3(c[3], c[2], a);
      out.push(lerp3(p0, p1, b));
    }
  return out;
}
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Derive the planes a plane-detector would find: floor, raised tops, wall faces. */
export function buildPlanes(room: SimRoom): PlaneInput[] {
  const planes: PlaneInput[] = [];
  const W = room.halfW, D = room.halfD;
  const rects = room.floorRects ?? [{ x0: -W, z0: -D, x1: W, z1: D }];
  rects.forEach((r, q) =>
    planes.push({
      id: room.floorRects ? `floor_${q}` : 'floor',
      polygon: [
        { x: r.x0, y: 0, z: r.z0 },
        { x: r.x1, y: 0, z: r.z0 },
        { x: r.x1, y: 0, z: r.z1 },
        { x: r.x0, y: 0, z: r.z1 },
      ],
      normal: { x: 0, y: 1, z: 0 },
      label: 'floor',
    }),
  );
  room.boxes.forEach((b, idx) => {
    const pc = room.pieces[b.piece];
    // Plane detection needs visual features: nothing on glass or mirrors.
    if (b.material === 'glass' || b.material === 'mirror') return;
    const area = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    if (pc.label !== 'wall' && b.max.y > 0.1 && area > 0.08) {
      // Top face unless something sits right on top of it.
      const covered = room.boxes.some((o) => o !== b && Math.abs(o.min.y - b.max.y) < 0.01 && o.min.x <= b.min.x + 0.01 && o.max.x >= b.max.x - 0.01 && o.min.z <= b.min.z + 0.01 && o.max.z >= b.max.z - 0.01);
      if (!covered)
        planes.push({
          id: `top${idx}`,
          polygon: [
            { x: b.min.x, y: b.max.y, z: b.min.z },
            { x: b.max.x, y: b.max.y, z: b.min.z },
            { x: b.max.x, y: b.max.y, z: b.max.z },
            { x: b.min.x, y: b.max.y, z: b.max.z },
          ],
          normal: { x: 0, y: 1, z: 0 },
          label: pc.label === 'table' || pc.label === 'bed' ? pc.label : undefined,
        });
    }
    if (pc.label === 'wall' || pc.label === 'bookshelf') {
      // Inner vertical faces facing the room centre.
      const faces: [Vec3, Vec3[]][] = [];
      const y0 = b.min.y, y1 = b.max.y;
      if (b.max.x <= -W + 1e-3 || (pc.label === 'bookshelf' && b.max.x < 0))
        faces.push([{ x: 1, y: 0, z: 0 }, [{ x: b.max.x, y: y0, z: b.min.z }, { x: b.max.x, y: y0, z: b.max.z }, { x: b.max.x, y: y1, z: b.max.z }, { x: b.max.x, y: y1, z: b.min.z }]]);
      if (b.min.x >= W - 1e-3 || (pc.label === 'bookshelf' && b.min.x > 0))
        faces.push([{ x: -1, y: 0, z: 0 }, [{ x: b.min.x, y: y0, z: b.min.z }, { x: b.min.x, y: y0, z: b.max.z }, { x: b.min.x, y: y1, z: b.max.z }, { x: b.min.x, y: y1, z: b.min.z }]]);
      if (b.max.z <= -D + 1e-3 || (pc.label === 'bookshelf' && b.max.z < 0))
        faces.push([{ x: 0, y: 0, z: 1 }, [{ x: b.min.x, y: y0, z: b.max.z }, { x: b.max.x, y: y0, z: b.max.z }, { x: b.max.x, y: y1, z: b.max.z }, { x: b.min.x, y: y1, z: b.max.z }]]);
      if (b.min.z >= D - 1e-3 || (pc.label === 'bookshelf' && b.min.z > 0))
        faces.push([{ x: 0, y: 0, z: -1 }, [{ x: b.min.x, y: y0, z: b.min.z }, { x: b.max.x, y: y0, z: b.min.z }, { x: b.max.x, y: y1, z: b.min.z }, { x: b.min.x, y: y1, z: b.min.z }]]);
      // Interior walls of a multi-room home: both faces.
      const interior = pc.label === 'wall' && room.floorRects && b.min.x > -W + 1e-3 && b.max.x < W - 1e-3 && b.min.z > -D + 1e-3 && b.max.z < D - 1e-3 && b.min.y < 0.5;
      if (interior) {
        if (b.max.x - b.min.x < b.max.z - b.min.z) {
          faces.push([{ x: -1, y: 0, z: 0 }, [{ x: b.min.x, y: y0, z: b.min.z }, { x: b.min.x, y: y0, z: b.max.z }, { x: b.min.x, y: y1, z: b.max.z }, { x: b.min.x, y: y1, z: b.min.z }]]);
          faces.push([{ x: 1, y: 0, z: 0 }, [{ x: b.max.x, y: y0, z: b.min.z }, { x: b.max.x, y: y0, z: b.max.z }, { x: b.max.x, y: y1, z: b.max.z }, { x: b.max.x, y: y1, z: b.min.z }]]);
        } else {
          faces.push([{ x: 0, y: 0, z: -1 }, [{ x: b.min.x, y: y0, z: b.min.z }, { x: b.max.x, y: y0, z: b.min.z }, { x: b.max.x, y: y1, z: b.min.z }, { x: b.min.x, y: y1, z: b.min.z }]]);
          faces.push([{ x: 0, y: 0, z: 1 }, [{ x: b.min.x, y: y0, z: b.max.z }, { x: b.max.x, y: y0, z: b.max.z }, { x: b.max.x, y: y1, z: b.max.z }, { x: b.min.x, y: y1, z: b.max.z }]]);
        }
      }
      faces.forEach(([normal, polygon], f) => planes.push({ id: `wall${idx}_${f}`, polygon, normal, label: pc.label === 'wall' ? 'wall' : undefined }));
    }
  });
  return planes;
}

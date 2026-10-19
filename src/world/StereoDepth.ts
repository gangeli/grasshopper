import type { DepthImage } from './DepthFrame';

/**
 * Depth from motion, as phones without a depth sensor do it (ARCore's
 * "Depth API" on a single camera). Recent frames whose tracked poses are a
 * few centimetres apart serve as a stereo rig with unknown, noisy baselines.
 *
 * Plane-sweep stereo: for each pixel of the reference (newest) frame, try
 * many depths, project the pixel into each source frame and compare census
 * signatures (robust to exposure changes and noise). Costs are aggregated
 * over a small window. The best depth is kept only when it is clearly better
 * than all alternatives (uniqueness), the patch has texture, and the
 * baseline resolves that depth to within a few percent. Everything else is
 * left empty: holes are much safer for the map than guesses.
 */
export interface StereoFrame {
  w: number;
  h: number;
  gray: Uint8Array;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** Camera-to-world, column-major, camera looks down -Z, row 0 = top. */
  camToWorld: ArrayLike<number>;
  t: number;
}

export interface StereoOptions {
  /** Output grid stride in camera pixels (odd, so grid centres are pixel centres). */
  step: number;
  depths: number;
  minDepth: number;
  maxDepth: number;
  /** Cost aggregation window radius (camera pixels). */
  aggRadius: number;
  maxSources: number;
  minBaseline: number;
  maxBaseline: number;
  /** Preferred baseline (m). */
  idealBaseline: number;
  maxAngle: number;
  maxAge: number;
  /** Required margin of the best cost below the best non-neighbouring cost (fraction). */
  uniqueness: number;
  /** Max mean census mismatch (fraction of bits) for an accepted match. */
  maxCost: number;
  /** Minimum local contrast (gray levels, std-dev) for a pixel to be matched. */
  minTexture: number;
  /** Max relative depth uncertainty from the baseline geometry (σ_d / d) at 0.5px matching error. */
  maxRelSigma: number;
  /** Frames kept for source selection. */
  history: number;
}

export const DEFAULT_STEREO: StereoOptions = {
  step: 3,
  depths: 64,
  minDepth: 0.25,
  maxDepth: 5,
  aggRadius: 3,
  maxSources: 4,
  minBaseline: 0.025,
  maxBaseline: 0.45,
  idealBaseline: 0.12,
  maxAngle: 0.45,
  maxAge: 1.5,
  uniqueness: 0.12,
  maxCost: 0.3,
  minTexture: 2.5,
  maxRelSigma: 0.06,
  history: 24,
};

interface Prepared extends StereoFrame {
  census: Uint32Array;
  texture: Float32Array;
  /** World-to-camera (column-major). */
  inv: Float64Array;
}

const POP = new Uint8Array(4096);
for (let i = 1; i < 4096; i++) POP[i] = POP[i >> 1] + (i & 1);
const popcount24 = (x: number) => POP[x & 4095] + POP[(x >>> 12) & 4095];

export interface StereoResult {
  image: DepthImage;
  /** Uniqueness margin per output pixel (0 where rejected). */
  confidence: Float32Array;
  sources: number;
  stats: { candidates: number; accepted: number; rejectedTexture: number; rejectedUnique: number; rejectedCost: number; rejectedGeometry: number };
}

export class MotionStereo {
  readonly opts: StereoOptions;
  private frames: Prepared[] = [];
  constructor(opts: Partial<StereoOptions> = {}) {
    this.opts = { ...DEFAULT_STEREO, ...opts };
  }

  reset(): void {
    this.frames = [];
  }

  push(f: StereoFrame): void {
    const { census, texture } = censusTransform(f.gray, f.w, f.h);
    this.frames.push({ ...f, census, texture, inv: invertRigid(f.camToWorld) });
    if (this.frames.length > this.opts.history) this.frames.shift();
  }

  /** Pick source frames for the newest frame. */
  private chooseSources(ref: Prepared): Prepared[] {
    const O = this.opts, M = ref.camToWorld;
    const cands: { f: Prepared; score: number }[] = [];
    for (const f of this.frames) {
      if (f === ref || ref.t - f.t > O.maxAge || f.t > ref.t) continue;
      const S = f.camToWorld;
      const b = Math.hypot(S[12] - M[12], S[13] - M[13], S[14] - M[14]);
      if (b < O.minBaseline || b > O.maxBaseline) continue;
      // Angle between viewing directions (-Z columns).
      const ang = Math.acos(Math.max(-1, Math.min(1, S[8] * M[8] + S[9] * M[9] + S[10] * M[10])));
      if (ang > O.maxAngle) continue;
      cands.push({ f, score: Math.abs(Math.log(b / O.idealBaseline)) + ang * 2 });
    }
    cands.sort((a, b) => a.score - b.score);
    return cands.slice(0, O.maxSources).map((c) => c.f);
  }

  /** Depth for the newest frame, or null if no usable sources (e.g. pure rotation). */
  compute(): StereoResult | null {
    const ref = this.frames[this.frames.length - 1];
    if (!ref) return null;
    const srcs = this.chooseSources(ref);
    if (!srcs.length) return null;
    const O = this.opts, { w, h, fx, fy, cx, cy } = ref;
    const D = O.depths;
    const rhoMin = 1 / O.maxDepth, rhoMax = 1 / O.minDepth;
    const rhoAt = (k: number) => rhoMin + ((rhoMax - rhoMin) * k) / (D - 1);
    // Relative transforms ref camera → source camera: Q = R·ray + T·ρ.
    const rel = srcs.map((s) => mulRigid(s.inv, ref.camToWorld));
    // 1. Full-resolution cost volume [k][pixel]: mean of the best two sources' census mismatch.
    const N = w * h;
    const cost = new Float32Array(D * N);
    const per = new Float32Array(srcs.length);
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++) {
        const i = v * w + u;
        const rx = (u + 0.5 - cx) / fx, ry = -(v + 0.5 - cy) / fy, rz = -1;
        const cRef = ref.census[i];
        for (let k = 0; k < D; k++) {
          const rho = rhoAt(k);
          let n = 0;
          for (let s = 0; s < srcs.length; s++) {
            const R = rel[s];
            const qx = R[0] * rx + R[4] * ry + R[8] * rz + R[12] * rho;
            const qy = R[1] * rx + R[5] * ry + R[9] * rz + R[13] * rho;
            const qz = R[2] * rx + R[6] * ry + R[10] * rz + R[14] * rho;
            if (qz > -1e-6) continue;
            const su = Math.round((fx * qx) / -qz + cx - 0.5), sv = Math.round((-fy * qy) / -qz + cy - 0.5);
            if (su < 3 || sv < 3 || su >= w - 3 || sv >= h - 3) continue;
            per[n++] = popcount24(cRef ^ srcs[s].census[sv * w + su]);
          }
          let c: number;
          if (n === 0) c = 24;
          else if (n === 1) c = per[0];
          else {
            // Best two: robust to a source where the point is occluded.
            let a = 99, b = 99;
            for (let q = 0; q < n; q++) {
              const x = per[q];
              if (x < a) {
                b = a;
                a = x;
              } else if (x < b) b = x;
            }
            c = (a + b) / 2;
          }
          cost[k * N + i] = c;
        }
      }
    // 2. Box aggregation per depth layer (separable).
    const r = O.aggRadius;
    const tmp = new Float32Array(N);
    for (let k = 0; k < D; k++) {
      const L = cost.subarray(k * N, (k + 1) * N);
      for (let v = 0; v < h; v++) {
        let acc = 0;
        for (let u = -r; u <= r; u++) acc += L[v * w + clampI(u, w)];
        for (let u = 0; u < w; u++) {
          tmp[v * w + u] = acc;
          acc += L[v * w + clampI(u + r + 1, w)] - L[v * w + clampI(u - r, w)];
        }
      }
      for (let u = 0; u < w; u++) {
        let acc = 0;
        for (let v = -r; v <= r; v++) acc += tmp[clampI(v, h) * w + u];
        for (let v = 0; v < h; v++) {
          L[v * w + u] = acc / ((2 * r + 1) * (2 * r + 1));
          acc += tmp[clampI(v + r + 1, h) * w + u] - tmp[clampI(v - r, h) * w + u];
        }
      }
    }
    // 3. Winner-takes-all on the output grid, with sub-sample refinement and checks.
    const st = O.step, gw = Math.floor(w / st), gh = Math.floor(h / st);
    const depth = new Float32Array(gw * gh), confidence = new Float32Array(gw * gh);
    const stats = { candidates: gw * gh, accepted: 0, rejectedTexture: 0, rejectedUnique: 0, rejectedCost: 0, rejectedGeometry: 0 };
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        const u = gx * st + (st - 1) / 2, v = gy * st + (st - 1) / 2;
        const i = v * w + u;
        if (ref.texture[i] < O.minTexture) {
          stats.rejectedTexture++;
          continue;
        }
        let best = 0, c1 = Infinity;
        for (let k = 0; k < D; k++) {
          const c = cost[k * N + i];
          if (c < c1) {
            c1 = c;
            best = k;
          }
        }
        let c2 = Infinity;
        for (let k = 0; k < D; k++) if (Math.abs(k - best) > 2) c2 = Math.min(c2, cost[k * N + i]);
        if (c1 / 24 > O.maxCost) {
          stats.rejectedCost++;
          continue;
        }
        const margin = (c2 - c1) / Math.max(c2, 1e-3);
        if (!(margin > O.uniqueness) || best === 0 || best === D - 1) {
          stats.rejectedUnique++;
          continue;
        }
        // Parabola through the neighbours for a sub-sample inverse depth.
        const cm = cost[(best - 1) * N + i], cp = cost[(best + 1) * N + i];
        const den = cm - 2 * c1 + cp;
        const off = den > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (cm - cp)) / den)) : 0;
        const rho = rhoAt(best + off);
        const d = 1 / rho;
        // Geometry: how many pixels does a small change of inverse depth move the
        // match in the best-placed source? Too few → the depth is not resolved.
        const rx = (u + 0.5 - cx) / fx, ry = -(v + 0.5 - cy) / fy;
        let J = 0;
        for (const R of rel) {
          const pr = (rr: number) => {
            const qx = R[0] * rx + R[4] * ry - R[8] + R[12] * rr;
            const qy = R[1] * rx + R[5] * ry - R[9] + R[13] * rr;
            const qz = R[2] * rx + R[6] * ry - R[10] + R[14] * rr;
            return [(fx * qx) / -qz, (-fy * qy) / -qz];
          };
          const a = pr(rho), b = pr(rho * 1.01);
          J = Math.max(J, Math.hypot(a[0] - b[0], a[1] - b[1]) / (rho * 0.01));
        }
        const sigmaRho = 0.5 / Math.max(J, 1e-9);
        if ((sigmaRho * d * d) / d > O.maxRelSigma) {
          stats.rejectedGeometry++;
          continue;
        }
        depth[gy * gw + gx] = d;
        confidence[gy * gw + gx] = margin;
        stats.accepted++;
      }
    const tx = gw * st / 2 / fx, ty = gh * st / 2 / fy;
    const n = 0.1, f = 100;
    const invProj = [tx, 0, 0, 0, 0, ty, 0, 0, 0, 0, 0, (n - f) / (2 * f * n), 0, 0, -1, (f + n) / (2 * f * n)];
    return { image: { w: gw, h: gh, depth, invProj, camToWorld: ref.camToWorld }, confidence, sources: srcs.length, stats };
  }
}

const clampI = (x: number, n: number) => (x < 0 ? 0 : x >= n ? n - 1 : x);

/**
 * Modified 5x5 census on a lightly smoothed image: each neighbour is compared
 * with the window mean rather than the (noisy) centre pixel. 24 bits, plus the
 * local contrast (std-dev) used to skip blank patches.
 */
export function censusTransform(gray: Uint8Array, w: number, h: number): { census: Uint32Array; texture: Float32Array } {
  const census = new Uint32Array(w * h), texture = new Float32Array(w * h);
  // 3x3 binomial blur: sensor noise flips fewer bits.
  const g = new Float32Array(w * h);
  for (let v = 1; v < h - 1; v++)
    for (let u = 1; u < w - 1; u++) {
      const i = v * w + u;
      g[i] = (4 * gray[i] + 2 * (gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w]) + gray[i - w - 1] + gray[i - w + 1] + gray[i + w - 1] + gray[i + w + 1]) / 16;
    }
  for (let v = 3; v < h - 3; v++)
    for (let u = 3; u < w - 3; u++) {
      let s = 0, s2 = 0;
      for (let dv = -2; dv <= 2; dv++)
        for (let du = -2; du <= 2; du++) {
          const x = g[(v + dv) * w + u + du];
          s += x;
          s2 += x * x;
        }
      const m = s / 25;
      let code = 0;
      for (let dv = -2; dv <= 2; dv++)
        for (let du = -2; du <= 2; du++) {
          if (du === 0 && dv === 0) continue;
          code = (code << 1) | (g[(v + dv) * w + u + du] > m ? 1 : 0);
        }
      census[v * w + u] = code >>> 0;
      texture[v * w + u] = Math.sqrt(Math.max(0, s2 / 25 - m * m));
    }
  return { census, texture };
}

/** Inverse of a rigid column-major 4x4. */
export function invertRigid(M: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  // Transpose the rotation.
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  const tx = M[12], ty = M[13], tz = M[14];
  o[12] = -(o[0] * tx + o[4] * ty + o[8] * tz);
  o[13] = -(o[1] * tx + o[5] * ty + o[9] * tz);
  o[14] = -(o[2] * tx + o[6] * ty + o[10] * tz);
  o[15] = 1;
  return o;
}

/** A·B for column-major 4x4s. */
export function mulRigid(A: ArrayLike<number>, B: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

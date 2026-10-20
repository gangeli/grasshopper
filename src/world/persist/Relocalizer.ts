import { fft2Gen, nextPow2 } from './fft';
import { runToEnd, type Work } from './gen';
import { FragmentLookup, type ColumnFeatures, type MapFeatures, type VoxelSamples } from './features';
import { poseDelta, wrapAngle, type Pose2 } from './pose';

/**
 * Relocalization: where does the live session's map sit in a stored map?
 *
 * 1. Coarse global search over yaw (2° steps) and translation (20cm cells):
 *    2D "signature" images of both maps — occupied voxels in three height
 *    bands, plus space seen empty — are cross-correlated with FFTs (one
 *    correlation per yaw covers every translation). Occupied-vs-occupied
 *    agreement scores positively; occupied-vs-seen-empty (either way)
 *    negatively, which is what rejects look-alike placements.
 * 2. The best few distinct peaks are refined in 3D at full resolution
 *    (5cm, 0.25°, ±1 layer) by scoring sampled voxels against the stored
 *    map's per-voxel classes.
 * 3. Each refined candidate is verified (agreement and conflicts both ways),
 *    and the winner must beat the runner-up by a clear margin. Symmetric
 *    rooms (two equally good answers) are therefore refused, not guessed.
 *
 * All work is a generator that yields often, so callers can spread it over
 * frames (or run it to completion in tests).
 */
export const SIG_CELL = 0.3;
const BAND_W = [0.6, 0.8, 1.0];
const FREE_W = 0.8;
/** Seen-empty space agreeing with seen-empty space: rewards overlapping the whole room, not just an edge. */
const FREEFREE_W = 0.3;

export interface Candidate {
  /** live → stored map. */
  pose: Pose2;
  coarse: number;
  score: number;
  metrics?: VerifyMetrics;
}

export interface VerifyMetrics {
  fwdN: number;
  fwdHit: number;
  fwdConf: number;
  freeN: number;
  freeConf: number;
  /** Live free samples landing in stored free space (and all live free samples). */
  freeHit: number;
  freeSamples: number;
  /** Stored free samples landing in live free space (and all stored free samples). */
  bwdFreeHit: number;
  fragFreeSamples: number;
  /** Furniture-only (low, not under anything tall) live samples: count, hits, conflicts. */
  lowN: number;
  lowHit: number;
  lowConf: number;
  /** Separate pieces of furniture (clusters of agreeing furniture samples). */
  lowObjects: number;
  /** Same for the stored map's furniture samples landing in live-known space. */
  bwdLowN: number;
  bwdLowHit: number;
  bwdLowConf: number;
  /** Agreement of structure only (walls, tall cupboards: what doesn't move), both ways. */
  wallInlier: number;
  wallSamples: number;
  /** Live structure samples (columns reaching above 1.1m) on stored obstacles (strict: on the voxel). */
  wallHit: number;
  /**
   * How well the walls that agree pin the pose down in their weakest
   * direction: the smaller eigenvalue of Σ n·nᵀ over their normals (≈ the
   * number of wall samples facing that direction). Near 0: only parallel
   * walls were matched, so the pose could slide along them and the
   * furniture decides — and furniture moves.
   */
  wallWeak: number;
  bwdN: number;
  bwdHit: number;
  bwdConf: number;
  /** Agreement share among informative samples (hits / (hits + conflicts)). */
  inlier: number;
  /**
   * Share of the live occupied samples that land where the stored map has
   * seen something (its known columns) and are on its obstacles. (Live
   * observations outside the stored map say nothing either way.)
   */
  explained: number;
  /** Live occupied samples landing in the stored map's known columns. */
  fwdKnown: number;
  score: number;
}

export interface RelocResult {
  best: Candidate | null;
  second: Candidate | null;
  /** Second-best verified score / best (0 = unique, 1 = tie). */
  ambiguity: number;
  accepted: boolean;
  reason: string;
  /** Refined candidates, best first (hints for a re-check). */
  candidates: Pose2[];
  /** Work done (for diagnostics): yaw steps, poses scored. */
  work: { yaws: number; poses: number; fftN: number; coarseMs: number; refineMs: number };
}

export interface RelocOptions {
  yawStep?: number;
  /**
   * Re-check instead of searching: refine and verify these placements (the
   * previous answer first, then its rivals) without the global search. Used
   * to confirm an answer as the live map grows, at a fraction of the cost.
   */
  hint?: Pose2[];
  /** Only the coarse search: rank stored maps by their best correlation peak (cheap at coarse cells). */
  coarseOnly?: boolean;
  /** Distinct coarse candidates to refine. */
  candidates?: number;
  /** Acceptance thresholds (see accept()). */
  minOverlap?: number;
  minInlier?: number;
  minExplained?: number;
  maxAmbiguity?: number;
}

/** A stored map prepared for searching (cached while the map doesn't change). */
export class FragmentIndex {
  readonly lookup: FragmentLookup;
  readonly sig: SigImage;
  private qCache = new Map<number, { re: Float64Array[]; im: Float64Array[] }>();
  constructor(readonly features: MapFeatures, lookup: FragmentLookup, cell = SIG_CELL) {
    this.lookup = lookup;
    this.sig = buildStaticSig(features.cols, cell);
  }

  /** Frequency-domain correlation kernels for an N×N FFT (cached per N). */
  *kernels(N: number): Work<{ re: Float64Array[]; im: Float64Array[] }> {
    let q = this.qCache.get(N);
    if (q) return q;
    const s = this.sig;
    const img = function* (ch: Float32Array): Work<{ re: Float64Array; im: Float64Array }> {
      const re = new Float64Array(N * N), im = new Float64Array(N * N);
      for (let v = 0; v < s.h && v < N; v++) for (let u = 0; u < s.w && u < N; u++) re[v * N + u] = ch[v * s.w + u];
      yield* fft2Gen(re, im, N, false, 32);
      return { re, im };
    };
    const B = [yield* img(s.b[0]), yield* img(s.b[1]), yield* img(s.b[2])];
    const F = yield* img(s.free);
    const O = yield* img(s.occ);
    // Q_b = w_b·S_b − α·S_free ; Q_free = −α·S_occ
    const re: Float64Array[] = [], im: Float64Array[] = [];
    for (let b = 0; b < 3; b++) {
      const r = new Float64Array(N * N), i = new Float64Array(N * N);
      for (let q2 = 0; q2 < N * N; q2++) {
        r[q2] = BAND_W[b] * B[b].re[q2] - FREE_W * F.re[q2];
        i[q2] = BAND_W[b] * B[b].im[q2] - FREE_W * F.im[q2];
      }
      re.push(r);
      im.push(i);
    }
    const r = new Float64Array(N * N), i = new Float64Array(N * N);
    for (let q2 = 0; q2 < N * N; q2++) {
      r[q2] = -FREE_W * O.re[q2] + FREEFREE_W * F.re[q2];
      i[q2] = -FREE_W * O.im[q2] + FREEFREE_W * F.im[q2];
    }
    re.push(r);
    im.push(i);
    q = { re, im };
    this.qCache.set(N, q);
    return q;
  }
}

interface SigImage {
  cell: number;
  w: number;
  h: number;
  x0: number;
  z0: number;
  /** Band images (blurred for the stored map). */
  b: Float32Array[];
  free: Float32Array;
  /** Sum of the band images (stored map: for the live-free penalty). */
  occ: Float32Array;
}

function bandValue(n: number) {
  return Math.min(1, n / 12);
}

/** Accumulate column features into cells of an image (positions already in image coordinates). */
function rasterize(cols: ColumnFeatures, w: number, h: number, cellOf: (q: number) => number): { b: Float32Array[]; free: Float32Array } {
  const sums = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const fr = new Float32Array(w * h);
  for (let q = 0; q < cols.n; q++) {
    const c = cellOf(q);
    if (c < 0) continue;
    sums[0][c] += cols.b0[q];
    sums[1][c] += cols.b1[q];
    sums[2][c] += cols.b2[q];
    fr[c] += cols.free[q];
  }
  const b = sums.map((s) => s.map(bandValue));
  const free = new Float32Array(w * h);
  for (let c = 0; c < w * h; c++) free[c] = sums[0][c] + sums[1][c] > 2 ? 0 : Math.min(1, fr[c] / 64);
  return { b, free: erode(free, w, h) };
}

/** Free space shrunk by one cell (a wall one cell off isn't a contradiction). */
function erode(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let v = 1; v < h - 1; v++)
    for (let u = 1; u < w - 1; u++) {
      let m = a[v * w + u];
      if (!m) continue;
      for (let dv = -1; dv <= 1 && m; dv++) for (let du = -1; du <= 1; du++) m = Math.min(m, a[(v + dv) * w + u + du]);
      out[v * w + u] = m;
    }
  return out;
}

/** Occupancy spread to the 4-neighbours at half weight (tolerates half-cell misalignment). */
function spread(a: Float32Array, w: number, h: number): Float32Array {
  const out = a.slice();
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      let m = a[v * w + u];
      if (u > 0) m = Math.max(m, 0.5 * a[v * w + u - 1]);
      if (u < w - 1) m = Math.max(m, 0.5 * a[v * w + u + 1]);
      if (v > 0) m = Math.max(m, 0.5 * a[(v - 1) * w + u]);
      if (v < h - 1) m = Math.max(m, 0.5 * a[(v + 1) * w + u]);
      out[v * w + u] = m;
    }
  return out;
}

function buildStaticSig(cols: ColumnFeatures, cell: number): SigImage {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let q = 0; q < cols.n; q++) {
    x0 = Math.min(x0, cols.x[q]);
    z0 = Math.min(z0, cols.z[q]);
    x1 = Math.max(x1, cols.x[q]);
    z1 = Math.max(z1, cols.z[q]);
  }
  if (!cols.n) return { cell, w: 1, h: 1, x0: 0, z0: 0, b: [new Float32Array(1), new Float32Array(1), new Float32Array(1)], free: new Float32Array(1), occ: new Float32Array(1) };
  x0 -= cell;
  z0 -= cell;
  const w = Math.ceil((x1 - x0) / cell) + 2, h = Math.ceil((z1 - z0) / cell) + 2;
  const r = rasterize(cols, w, h, (q) => Math.floor((cols.z[q] - z0) / cell) * w + Math.floor((cols.x[q] - x0) / cell));
  const b = r.b.map((im) => spread(im, w, h));
  const occ = new Float32Array(w * h);
  for (let c = 0; c < w * h; c++) occ[c] = Math.min(1, b[0][c] + b[1][c] + b[2][c]);
  return { cell, w, h, x0, z0, b, free: r.free, occ };
}

/**
 * Score of the live samples at a pose against a stored map's classes.
 * Occupied samples: on/near stored obstacles +, in stored free space −.
 * Free samples: inside stored obstacles −.
 */
export function scorePose(L: FragmentLookup, occ: VoxelSamples, free: VoxelSamples, T: Pose2, stride = 1, freeStride = stride): number {
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw), dj = T.dj ?? 0;
  let sc = 0;
  for (let q = 0; q < occ.n; q += stride) {
    const x = occ.x[q], z = occ.z[q];
    const k = L.classAt(c * x - s * z + T.tx, s * x + c * z + T.tz, occ.j[q] + dj);
    if (k === 1) sc += 1;
    else if (k === 2) sc += 0.7;
    else if (k === 3) sc += 0.35;
    else if (k === 4) sc -= 1;
    else if (k === 5) sc -= 0.2;
  }
  for (let q = 0; q < free.n; q += freeStride) {
    const x = free.x[q], z = free.z[q];
    const k = L.classAt(c * x - s * z + T.tx, s * x + c * z + T.tz, free.j[q] + dj);
    if (k === 1) sc -= 0.7;
    else if (k === 2) sc -= 0.4;
    else if (k === 4) sc += 0.2;
  }
  return sc;
}

/**
 * Agreement of the live map with a stored map at pose T (live → stored),
 * both ways: live obstacles in the stored map, stored obstacles in the live
 * map, and live free space against stored obstacles.
 */
export function verifyPose(live: { features: MapFeatures; lookup: FragmentLookup }, frag: { features: MapFeatures; lookup: FragmentLookup }, T: Pose2): VerifyMetrics {
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw), dj = T.dj ?? 0;
  const F = frag.lookup, Lk = live.lookup;
  const lo = live.features.occ, lf = live.features.free, fo = frag.features.occ;
  let fwdN = 0, fwdHit = 0, fwdConf = 0, fwdKnown = 0, lowN = 0, lowHit = 0, lowConf = 0, sHit = 0, sConf = 0;
  // Furniture that agrees, by 25cm cell (live frame), to count separate objects.
  const hitCells = new Map<number, number>();
  for (let q = 0; q < lo.n; q++) {
    const x = lo.x[q], z = lo.z[q];
    const fx = c * x - s * z + T.tx, fz = s * x + c * z + T.tz;
    const k = F.classAt(fx, fz, lo.j[q] + dj);
    fwdN++;
    if (k !== 0 || F.knownAt(fx, fz) > 0) fwdKnown++;
    const hit = k === 1 || k === 2 || k === 3;
    if (hit) fwdHit++;
    else if (k === 4) fwdConf++;
    if (lo.low[q] === 2) {
      if (hit) sHit++;
      else if (k === 4) sConf++;
    }
    // Furniture: low in the live map *and* where it lands in the stored one
    // (the bottom of a wall the camera never saw higher up is no furniture).
    if (lo.low[q] === 1 && k !== 0 && !F.tallAt(fx, fz)) {
      lowN++;
      if (hit) {
        lowHit++;
        hitCells.set(cellKey(x, z), (hitCells.get(cellKey(x, z)) ?? 0) + 1);
      } else if (k === 4) lowConf++;
    }
  }
  const lowObjects = countClusters(hitCells, 8);
  let freeN = 0, freeConf = 0, freeHit = 0;
  for (let q = 0; q < lf.n; q++) {
    const x = lf.x[q], z = lf.z[q];
    const k = F.classAt(c * x - s * z + T.tx, s * x + c * z + T.tz, lf.j[q] + dj);
    if (k === 0) continue;
    freeN++;
    if (k === 1) freeConf++;
    else if (k === 4 || k === 5) freeHit++;
  }
  // Stored → live: inverse pose.
  let bwdN = 0, bwdHit = 0, bwdConf = 0, bwdLowN = 0, bwdLowHit = 0, bwdLowConf = 0;
  for (let q = 0; q < fo.n; q++) {
    const x = fo.x[q] - T.tx, z = fo.z[q] - T.tz;
    const lx = c * x + s * z, lz = -s * x + c * z;
    const k = Lk.classAt(lx, lz, fo.j[q] - dj);
    if (k === 0) continue;
    bwdN++;
    const hit = k === 1 || k === 2 || k === 3;
    if (hit) bwdHit++;
    else if (k === 4) bwdConf++;
    if (fo.low[q] === 2) {
      if (hit) sHit++;
      else if (k === 4) sConf++;
    }
    if (fo.low[q] === 1 && !Lk.tallAt(lx, lz)) {
      bwdLowN++;
      if (hit) bwdLowHit++;
      else if (k === 4) bwdLowConf++;
    }
  }
  // Stored free space inside live free space (area overlap seen from the stored side).
  const ff = frag.features.free;
  let bwdFreeHit = 0;
  for (let q = 0; q < ff.n; q++) {
    const x = ff.x[q] - T.tx, z = ff.z[q] - T.tz;
    const k = Lk.classAt(c * x + s * z, -s * x + c * z, ff.j[q] - dj);
    if (k === 4 || k === 5) bwdFreeHit++;
  }
  // Wall constraint (see VerifyMetrics.wallWeak): scatter of the normals of
  // structure samples that land on stored obstacles.
  let a = 0, b = 0, cc = 0, wallHit = 0;
  for (let q = 0; q < lo.n; q++) {
    if (lo.low[q] !== 2) continue;
    const x = lo.x[q], z = lo.z[q];
    const k = F.classAt(c * x - s * z + T.tx, s * x + c * z + T.tz, lo.j[q] + dj);
    if (k !== 1 && k !== 2) continue;
    wallHit++;
    const nx = lo.nx[q], nz = lo.nz[q];
    a += nx * nx;
    b += nx * nz;
    cc += nz * nz;
  }
  const tr = (a + cc) / 2, dd = Math.sqrt(((a - cc) / 2) ** 2 + b * b);
  const wallWeak = tr - dd;
  // Rescale sample counts to a common unit (the live occupied sample size)
  // so maps of very different sizes are weighed alike.
  const hits = fwdHit + bwdHit, conf = fwdConf + bwdConf + freeConf;
  const inlier = hits + conf > 0 ? hits / (hits + conf) : 0;
  // Free-space agreement counts at half weight (it is what tells a whole-room
  // overlap from two maps touching along one wall).
  return { fwdN, fwdHit, fwdConf, freeN, freeConf, freeHit, freeSamples: lf.n, bwdFreeHit, fragFreeSamples: ff.n, lowObjects, wallInlier: sHit + sConf ? sHit / (sHit + sConf) : 0, wallSamples: sHit + sConf, lowN, lowHit, lowConf, bwdLowN, bwdLowHit, bwdLowConf, wallHit, wallWeak, bwdN, bwdHit, bwdConf, inlier, explained: fwdKnown ? fwdHit / fwdKnown : 0, fwdKnown, score: hits + 0.5 * freeHit - 3 * conf };
}

const cellKey = (x: number, z: number) => (Math.floor(x / 0.25) + 32768) * 65536 + (Math.floor(z / 0.25) + 32768);

/** Connected clusters (8-neighbourhood) of cells, counting those with at least `min` samples. */
function countClusters(cells: Map<number, number>, min: number): number {
  const seen = new Set<number>();
  let n = 0;
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    let total = 0;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      total += cells.get(c)!;
      const u = Math.floor(c / 65536), v = c % 65536;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
      for (let du = -1; du <= 1; du++)
        for (let dv = -1; dv <= 1; dv++) {
          const nb = c + du * 65536 + dv;
          if (cells.has(nb) && !seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
    }
    // A piece of furniture is compact: a long thin run (> 2.6m) is a wall.
    if (total >= min && Math.max(u1 - u0, v1 - v0) * 0.25 <= 2.6) n++;
  }
  return n;
}

/** Wall samples facing the weakest direction needed for walls alone to pin the pose. */
export const MIN_WALL_WEAK = 40;
export const DEFAULT_ACCEPT = { minOverlap: 300, minInlier: 0.9, minExplained: 0.5, maxAmbiguity: 0.4 };

/** Is this verified candidate (with this runner-up) strong, unambiguous evidence? */
export function judge(best: Candidate | null, ambiguity: number, o: RelocOptions = {}): { ok: boolean; reason: string } {
  const minOverlap = o.minOverlap ?? DEFAULT_ACCEPT.minOverlap, minInlier = o.minInlier ?? DEFAULT_ACCEPT.minInlier;
  const minExplained = o.minExplained ?? DEFAULT_ACCEPT.minExplained, maxAmb = o.maxAmbiguity ?? DEFAULT_ACCEPT.maxAmbiguity;
  const m = best?.metrics;
  if (!best || !m) return { ok: false, reason: 'no candidate' };
  if (m.fwdHit + m.fwdConf < minOverlap) return { ok: false, reason: `overlap ${m.fwdHit + m.fwdConf} < ${minOverlap}` };
  if (m.bwdHit + m.bwdConf < minOverlap * 0.5) return { ok: false, reason: `reverse overlap ${m.bwdHit + m.bwdConf}` };
  // The live map must overlap the stored one as an area (its seen-empty
  // floor space inside the stored map's), not just touch it along a wall.
  // (Relative to the smaller of the two: either may extend far beyond the other.)
  if (m.freeHit < 600 || (m.freeHit < 0.3 * m.freeSamples && m.bwdFreeHit < 0.3 * m.fragFreeSamples))
    return { ok: false, reason: `free overlap ${m.freeHit}/${m.freeSamples}, ${m.bwdFreeHit}/${m.fragFreeSamples}` };
  // Agreement, with contradictions on furniture counted at half weight
  // (furniture moves between sessions; walls and seen-empty floor don't).
  const hits = m.fwdHit + m.bwdHit, conf = m.fwdConf + m.bwdConf + m.freeConf - 0.5 * (m.lowConf + m.bwdLowConf);
  const inlier = hits / Math.max(1, hits + conf);
  if (inlier < minInlier) return { ok: false, reason: `inlier ${inlier.toFixed(2)} < ${minInlier}` };
  if (m.explained < minExplained) return { ok: false, reason: `explained ${m.explained.toFixed(2)} < ${minExplained}` };
  if (ambiguity > maxAmb) return { ok: false, reason: `ambiguous ${ambiguity.toFixed(2)}` };
  // Walls alone never decide: homes have rooms of the same shape (and
  // symmetric ones). At least one piece of furniture must agree.
  if (m.lowObjects < 1) return { ok: false, reason: 'no furniture agrees (walls alone are not unique)' };
  // Same walls, different furniture: another room of the same shape (or
  // everything moved, when the stored map is of little use anyway).
  const furnN = m.lowN + m.bwdLowN, furnBad = (m.lowConf + m.bwdLowConf) / Math.max(1, furnN);
  if (furnN >= 100 && furnBad > 0.35) return { ok: false, reason: `furniture disagrees (${(furnBad * 100).toFixed(0)}%)` };
  // Walls (which don't move) must pin the pose down; where they don't, the
  // furniture decides, so it must agree almost perfectly (it may have moved).
  if (m.wallWeak < MIN_WALL_WEAK) {
    // Then several separate pieces of furniture must agree (one piece moved
    // along a wall would otherwise drag the placement with it).
    const lowConf = m.lowConf / Math.max(1, m.lowN), bwdLowConf = m.bwdLowConf / Math.max(1, m.bwdLowN);
    if (m.lowN < 150 || m.lowObjects < 3 || lowConf > 0.1 || bwdLowConf > 0.12)
      return { ok: false, reason: `walls don't pin it (${m.wallHit} hits, weakest ${m.wallWeak.toFixed(0)}); furniture: ${m.lowObjects} pieces, ${(lowConf * 100).toFixed(0)}%/${(bwdLowConf * 100).toFixed(0)}% disagree` };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * Search the stored map for the live map. Yields between small work units.
 * `live` and `frag` hold features + class lookups of each map in its own frame.
 */
export function* relocalize(
  live: { features: MapFeatures; lookup: FragmentLookup },
  frag: FragmentIndex,
  opts: RelocOptions = {},
): Generator<void, RelocResult, void> {
  const work = { yaws: 0, poses: 0, fftN: 0, coarseMs: 0, refineMs: 0 };
  const tCoarse = performance.now();
  const fail = (reason: string): RelocResult => ({ best: null, second: null, ambiguity: 1, accepted: false, reason, work, candidates: [] });
  const cols = live.features.cols;
  if (cols.n < 50 || live.features.occ.n < 100 || frag.features.occ.n < 100) return fail('too little map');
  // Live columns relative to their centroid (rotation pivot).
  let mx = 0, mz = 0;
  for (let q = 0; q < cols.n; q++) {
    mx += cols.x[q];
    mz += cols.z[q];
  }
  mx /= cols.n;
  mz /= cols.n;
  const at = { x: mx, z: mz };
  let cands: Candidate[] = [];
  if (opts.hint?.length) cands = opts.hint.map((pose) => ({ pose: { ...pose }, coarse: 0, score: -Infinity }));
  else cands = yield* coarseSearch();
  work.coarseMs = performance.now() - tCoarse;
  if (!cands.length) return fail('no coarse peak');
  if (opts.coarseOnly) return { ...fail('coarse only'), best: cands[0], candidates: cands.map((c) => c.pose) };
  return yield* refineAndJudge();

  // --- 1. coarse search ---------------------------------------------------------
  function* coarseSearch(): Work<Candidate[]> {
  const S = frag.sig;
  let rad = 0;
  for (let q = 0; q < cols.n; q++) rad = Math.max(rad, Math.hypot(cols.x[q] - mx, cols.z[q] - mz));
  // The coarse search looks at the live map within 4m of its centre (FFT size; refinement and verification use all of it).
  rad = Math.min(rad, 4);
  const cell = S.cell;
  const L = Math.ceil((2 * rad) / cell) + 3;
  const N = nextPow2(Math.max(S.w, S.h) + L);
  work.fftN = N;
  if (N > 512) return [];
  const Q = yield* frag.kernels(N);
  yield;
  const yawStep = opts.yawStep ?? (3 * Math.PI) / 180;
  const nYaw = Math.round((2 * Math.PI) / yawStep);
  const peaks: { yaw: number; tx: number; tz: number; v: number }[] = [];
  const reA = new Float64Array(N * N), imA = new Float64Array(N * N), reB = new Float64Array(N * N), imB = new Float64Array(N * N);
  const pr = new Float64Array(N * N), pi = new Float64Array(N * N);
  const half = (L * cell) / 2;
  for (let a = 0; a < nYaw; a++) {
    const yaw = a * yawStep;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // Rotated live image: cell (u, v) covers x ∈ [−half + u·cell, ...) around the centroid.
    const img = rasterize(cols, L, L, (q) => {
      const dx = cols.x[q] - mx, dz = cols.z[q] - mz;
      const u = Math.floor((c * dx - s * dz + half) / cell), v = Math.floor((s * dx + c * dz + half) / cell);
      return u < 0 || v < 0 || u >= L || v >= L ? -1 : v * L + u;
    });
    reA.fill(0);
    imA.fill(0);
    reB.fill(0);
    imB.fill(0);
    for (let v = 0; v < L; v++)
      for (let u = 0; u < L; u++) {
        const o = v * L + u, d = v * N + u;
        reA[d] = img.b[0][o];
        imA[d] = img.b[1][o];
        reB[d] = img.b[2][o];
        imB[d] = img.free[o];
      }
    yield* fft2Gen(reA, imA, N, false, 32);
    yield* fft2Gen(reB, imB, N, false, 32);
    // Unpack the two real transforms in each and correlate: P = Σ conj(L_c)·Q_c.
    for (let ky = 0; ky < N; ky++)
      for (let kx = 0; kx < N; kx++) {
        const k = ky * N + kx, nk = ((N - ky) % N) * N + ((N - kx) % N);
        // X = (Z[k] + conj(Z[−k]))/2 ; Y = (Z[k] − conj(Z[−k]))/(2i)
        const x0r = (reA[k] + reA[nk]) / 2, x0i = (imA[k] - imA[nk]) / 2;
        const x1r = (imA[k] + imA[nk]) / 2, x1i = -(reA[k] - reA[nk]) / 2;
        const x2r = (reB[k] + reB[nk]) / 2, x2i = (imB[k] - imB[nk]) / 2;
        const x3r = (imB[k] + imB[nk]) / 2, x3i = -(reB[k] - reB[nk]) / 2;
        // conj(X)·Q = (xr − i·xi)(qr + i·qi) = xr·qr + xi·qi + i(xr·qi − xi·qr)
        let r = 0, i = 0;
        r += x0r * Q.re[0][k] + x0i * Q.im[0][k];
        i += x0r * Q.im[0][k] - x0i * Q.re[0][k];
        r += x1r * Q.re[1][k] + x1i * Q.im[1][k];
        i += x1r * Q.im[1][k] - x1i * Q.re[1][k];
        r += x2r * Q.re[2][k] + x2i * Q.im[2][k];
        i += x2r * Q.im[2][k] - x2i * Q.re[2][k];
        r += x3r * Q.re[3][k] + x3i * Q.im[3][k];
        i += x3r * Q.im[3][k] - x3i * Q.re[3][k];
        pr[k] = r;
        pi[k] = i;
      }
    yield;
    yield* fft2Gen(pr, pi, N, true, 32);
    // Peaks: correlation index t means live cell (u, v) ↔ stored cell (u + tu, v + tv).
    const local: { k: number; v: number }[] = [];
    for (let k = 0; k < N * N; k++) {
      const v = pr[k];
      if (v <= 0) continue;
      if (local.length < 3 || v > local[local.length - 1].v) {
        // Non-maximum suppression (2 cells, circular).
        const ku = k % N, kv = (k - ku) / N;
        let dominated = false;
        for (let e = 0; e < local.length; e++) {
          const eu = local[e].k % N, ev = (local[e].k - eu) / N;
          const du = Math.min(Math.abs(eu - ku), N - Math.abs(eu - ku)), dv = Math.min(Math.abs(ev - kv), N - Math.abs(ev - kv));
          if (du <= 2 && dv <= 2) {
            if (local[e].v >= v) dominated = true;
            else local.splice(e--, 1);
          }
        }
        if (dominated) continue;
        local.push({ k, v });
        local.sort((p, q) => q.v - p.v);
        if (local.length > 3) local.length = 3;
      }
    }
    for (const p of local) {
      let tu = p.k % N, tv = (p.k - tu) / N;
      if (tu > N - L) tu -= N;
      if (tv > N - L) tv -= N;
      // u·cell ≈ R(x − m) + half and x_s ≈ x0 + (u + tu)·cell  →  x_s = R(x − m) + (x0 + half + tu·cell).
      const ox = S.x0 + half + tu * cell, oz = S.z0 + half + tv * cell;
      // Pose live→stored: x_s = R·(x − m) + o  =  R·x + (o − R·m)
      const tx = ox - (c * mx - s * mz), tz = oz - (s * mx + c * mz);
      peaks.push({ yaw: wrapAngle(yaw), tx, tz, v: p.v });
    }
    work.yaws++;
    yield;
  }
  // Distinct candidates (by pose at the live centroid).
  peaks.sort((p, q) => q.v - p.v);
  const nCand = opts.candidates ?? 5;
  const out: Candidate[] = [];
  for (const p of peaks) {
    const pose = { yaw: p.yaw, tx: p.tx, tz: p.tz, dj: 0 };
    if (out.some((c) => { const d = poseDelta(c.pose, pose, at); return d.dist < 0.5 && d.dyaw < (8 * Math.PI) / 180; })) continue;
    out.push({ pose, coarse: p.v, score: -Infinity });
    if (out.length >= nCand) break;
  }
  return out;
  }

  // --- 2. refine in 3D -------------------------------------------------------------
  function* refineAndJudge(): Work<RelocResult> {
  const occ = live.features.occ, free = live.features.free;
  // A lighter sample for the search; verification uses all of them.
  const stride = Math.max(1, Math.floor(occ.n / 1500)), freeStride = Math.max(1, Math.floor(free.n / 800));
  const tRefine = performance.now();
  const deg = Math.PI / 180;
  for (const cand of cands) {
    let best = cand.pose, bestS = -Infinity;
    const searchAround = function* (center: Pose2, dyaw: number, ystep: number, dt: number, tstep: number, djs: number[]) {
      let b = center, bs = -Infinity;
      for (let y = -dyaw; y <= dyaw + 1e-9; y += ystep) {
        for (const dj of djs)
          for (let ux = -dt; ux <= dt + 1e-9; ux += tstep, yield)
            for (let uz = -dt; uz <= dt + 1e-9; uz += tstep) {
              // Rotate about the live centroid (keeps translation and yaw decoupled).
              const yaw = center.yaw + y;
              const c0 = Math.cos(center.yaw), s0 = Math.sin(center.yaw), c1 = Math.cos(yaw), s1 = Math.sin(yaw);
              const pmx = c0 * mx - s0 * mz + center.tx, pmz = s0 * mx + c0 * mz + center.tz;
              const pose = { yaw, tx: pmx - (c1 * mx - s1 * mz) + ux, tz: pmz - (s1 * mx + c1 * mz) + uz, dj };
              const sc = scorePose(frag.lookup, occ, free, pose, stride, freeStride);
              work.poses++;
              if (sc > bs) {
                bs = sc;
                b = pose;
              }
            }
        yield;
      }
      return { b, bs };
    };
    // Coarse to fine: ±4° / ±30cm, then ±1.5° / ±10cm, then ±0.5° / ±5cm and ±1 layer.
    // (A re-check starts from an already refined placement: the last two only.)
    const stages: [number, number, number, number, number[]][] = [
      [4, 2, 0.3, 0.1, [0]],
      [1.5, 0.5, 0.1, 0.05, [0]],
      [0.5, 0.25, 0.05, 0.025, [0]],
      [0, 1, 0, 1, [-1, 1]],
    ];
    for (const [dy, ys, dt, ts, djs] of opts.hint?.length ? stages.slice(1) : stages) {
      const r = yield* searchAround(best, dy * deg, ys * deg, dt, ts, djs);
      if (r.bs > bestS) {
        best = r.b;
        bestS = r.bs;
      }
    }
    cand.pose = { ...best, yaw: wrapAngle(best.yaw) };
    cand.metrics = verifyPose(live, frag, cand.pose);
    cand.score = cand.metrics.score;
    yield;
  }
  work.refineMs = performance.now() - tRefine;
  // --- 3. pick and judge ----------------------------------------------------------
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  // Runner-up: the best candidate that is really a different placement and
  // that the evidence doesn't rule out. A placement that contradicts clearly
  // more of what was seen (seen-empty space where the other map has
  // obstacles, or the reverse) is not a rival, however many surfaces it
  // happens to line up (sliding along a long wall does that).
  const conf = (c: Candidate) => c.metrics!.fwdConf + c.metrics!.bwdConf + c.metrics!.freeConf;
  const ruledOut = (c: Candidate) => conf(c) >= Math.max(2 * conf(best), conf(best) + 60);
  // (Near placements — within 75cm and 15° — are the same basin as the best;
  // whether the walls pin the pose down within it is judged separately.)
  const distinct = cands.slice(1).filter((c) => { const d = poseDelta(c.pose, best.pose, at); return d.dist > 0.75 || d.dyaw > 15 * deg; });
  const second = distinct.find((c) => !ruledOut(c)) ?? distinct[0] ?? null;
  const rival = distinct.find((c) => !ruledOut(c));
  const ambiguity = best.score > 0 ? Math.max(0, rival?.score ?? 0) / best.score : 1;
  const j = judge(best, ambiguity, opts);
  return { best, second, ambiguity, accepted: j.ok, reason: j.reason, work, candidates: cands.map((c) => c.pose) };
  }
}

export { runToEnd };

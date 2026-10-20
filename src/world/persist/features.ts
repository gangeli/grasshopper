import { CS, CS2, chunkKey, type ChunkedMap } from './ChunkedMap';
import { every, runToEnd, type Work } from './gen';

/**
 * What the relocalizer looks at in a map, extracted once per map:
 *  - per column: occupied-voxel counts in three height bands (low furniture,
 *    table/counter height, tall things and walls) and the number of voxels
 *    confidently seen empty; used for the coarse 2D search;
 *  - samples of confidently occupied and confidently free voxels (metric x/z
 *    in the map's frame + layer), used to score candidate poses in 3D;
 *  - for a stored map: a per-voxel score class lookup (see FragmentLookup).
 */
export const OCC_CONF = 30;
export const FREE_CONF = -10;
/** Band layer ranges (floor-relative, 5cm layers): [lo, hi). */
export const BANDS: [number, number][] = [
  [3, 12], // 15–60cm: low furniture, seats, boxes
  [12, 26], // 60–130cm: tables, counters, couch backs
  [26, 48], // 130–240cm: walls, tall shelves, doors frames
];
const FREE_LAYERS: [number, number] = [3, 26];
/** Columns with obstacles at or above this layer (1.1m) are structure (walls, tall cupboards). */
const TALL_LAYER = 22;
/** Height bands for voxel samples (one sample per column and band). */
const SAMPLE_BANDS: [number, number][] = [
  [2, 7],
  [7, 14],
  [14, 26],
  [26, 48],
];

export interface ColumnFeatures {
  n: number;
  x: Float32Array;
  z: Float32Array;
  /** Occupied voxels per band. */
  b0: Uint8Array;
  b1: Uint8Array;
  b2: Uint8Array;
  /** Confidently free voxels (15–130cm). */
  free: Uint8Array;
}

export interface VoxelSamples {
  n: number;
  x: Float32Array;
  z: Float32Array;
  j: Int16Array;
  /**
   * 1 = furniture: a sample in a column with nothing above 1.1m (can move
   * between sessions). 2 = structure: a sample in a column that reaches above
   * 1.1m (walls, tall cupboards: what stays put).
   */
  low: Uint8Array;
  /**
   * Structure samples: horizontal normal of the wall they're on (from the
   * shape of the tall columns around them), scaled by how wall-like that
   * neighbourhood is (0 for a pillar or a lone column). 0 for other samples.
   */
  nx: Float32Array;
  nz: Float32Array;
}

export interface MapFeatures {
  cols: ColumnFeatures;
  occ: VoxelSamples;
  free: VoxelSamples;
  /** Totals before subsampling. */
  occTotal: number;
  freeTotal: number;
  bbox: { x0: number; z0: number; x1: number; z1: number } | null;
}

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Extract features. `maxOcc` / `maxFree` cap the voxel samples (uniformly
 * subsampled, deterministic).
 */
export function extractFeatures(m: ChunkedMap, maxOcc = 12000, maxFree = 6000): MapFeatures {
  return runToEnd(extractFeaturesGen(m, maxOcc, maxFree));
}

export function* extractFeaturesGen(m: ChunkedMap, maxOcc = 12000, maxFree = 6000): Work<MapFeatures> {
  const y = every(8);
  const res = m.res, ny = m.ny;
  const cols: number[][] = [[], [], [], [], [], []];
  const occAll: number[] = [], freeAll: number[] = [];
  const tallCols: number[] = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const c of m.chunks.values()) {
    if (y()) yield;
    const occ = c.occ;
    for (let lz = 0; lz < CS; lz++)
      for (let lx = 0; lx < CS; lx++) {
        const col = lz * CS + lx;
        let b0 = 0, b1 = 0, b2 = 0, fr = 0, known = 0;
        for (let j = 0; j < ny; j++) {
          const v = occ[j * CS2 + col];
          if (v === 0) continue;
          known++;
          if (v > OCC_CONF) {
            if (j >= BANDS[0][0] && j < BANDS[0][1]) b0++;
            else if (j >= BANDS[1][0] && j < BANDS[1][1]) b1++;
            else if (j >= BANDS[2][0] && j < BANDS[2][1]) b2++;
          } else if (v < FREE_CONF && j >= FREE_LAYERS[0] && j < FREE_LAYERS[1]) fr++;
        }
        if (!known && !c.observed[col]) continue;
        const I = c.cx * CS + lx, K = c.cz * CS + lz;
        const x = m.origin.x + (I + 0.5) * res, z = m.origin.z + (K + 0.5) * res;
        // Columns only touched by a few weak far-away rays don't go into the
        // signature (they'd stretch its extent, and the FFT size, for nothing).
        if (b0 + b1 + b2 > 0 || fr > 0 || c.observed[col]) {
          x0 = Math.min(x0, x);
          z0 = Math.min(z0, z);
          x1 = Math.max(x1, x);
          z1 = Math.max(z1, z);
          cols[0].push(x);
          cols[1].push(z);
          cols[2].push(b0);
          cols[3].push(b1);
          cols[4].push(b2);
          cols[5].push(fr);
        }
        if (!known) continue;
        // At most one occupied and one free sample per column and height
        // band (the middle one), so a tall wall weighs about as much as the
        // furniture in front of it rather than 10× more.
        let tall = false;
        for (let j = TALL_LAYER; j < Math.min(ny, 48) && !tall; j++) if (occ[j * CS2 + col] > OCC_CONF) tall = true;
        if (tall) tallCols.push(I, K);
        for (const [lo, hi] of SAMPLE_BANDS) {
          let o0 = -1, o1 = -1, f0 = -1, f1 = -1;
          for (let j = lo; j < Math.min(ny, hi); j++) {
            const v = occ[j * CS2 + col];
            if (v > OCC_CONF) {
              if (o0 < 0) o0 = j;
              o1 = j;
            } else if (v < FREE_CONF && j >= FREE_LAYERS[0] && j < FREE_LAYERS[1]) {
              if (f0 < 0) f0 = j;
              f1 = j;
            }
          }
          if (o0 >= 0) occAll.push(x, z, (o0 + o1) >> 1, tall ? 2 : 1);
          if (f0 >= 0) freeAll.push(x, z, (f0 + f1) >> 1, 0);
        }
      }
  }
  const pick = (all: number[], max: number, seed: number): VoxelSamples => {
    const total = all.length / 4;
    const keep = Math.min(total, max);
    const out = { n: keep, x: new Float32Array(keep), z: new Float32Array(keep), j: new Int16Array(keep), low: new Uint8Array(keep), nx: new Float32Array(keep), nz: new Float32Array(keep) };
    if (!keep) return out;
    // Systematic sampling with a random phase: uniform, deterministic.
    const rnd = lcg(seed);
    const step = total / keep;
    let pos = rnd() * step;
    for (let q = 0; q < keep; q++, pos += step) {
      const s = Math.min(total - 1, Math.floor(pos)) * 4;
      out.x[q] = all[s];
      out.z[q] = all[s + 1];
      out.j[q] = all[s + 2];
      out.low[q] = all[s + 3];
    }
    return out;
  };
  const n = cols[0].length;
  const occS = pick(occAll, maxOcc, 17);
  wallNormals(occS, tallCols, m);
  return {
    cols: {
      n,
      x: Float32Array.from(cols[0]),
      z: Float32Array.from(cols[1]),
      b0: Uint8Array.from(cols[2], (v) => Math.min(255, v)),
      b1: Uint8Array.from(cols[3], (v) => Math.min(255, v)),
      b2: Uint8Array.from(cols[4], (v) => Math.min(255, v)),
      free: Uint8Array.from(cols[5], (v) => Math.min(255, v)),
    },
    occ: occS,
    free: pick(freeAll, maxFree, 23),
    occTotal: occAll.length / 4,
    freeTotal: freeAll.length / 4,
    bbox: n ? { x0, z0, x1, z1 } : null,
  };
}

/** Fill in the wall normals of structure samples (see VoxelSamples.nx). */
function wallNormals(S: VoxelSamples, tallCols: number[], m: ChunkedMap) {
  if (!tallCols.length) return;
  let i0 = Infinity, k0 = Infinity, i1 = -Infinity, k1 = -Infinity;
  for (let q = 0; q < tallCols.length; q += 2) {
    i0 = Math.min(i0, tallCols[q]);
    i1 = Math.max(i1, tallCols[q]);
    k0 = Math.min(k0, tallCols[q + 1]);
    k1 = Math.max(k1, tallCols[q + 1]);
  }
  const w = i1 - i0 + 1, h = k1 - k0 + 1;
  if (w * h > 4e6) return;
  const grid = new Uint8Array(w * h);
  for (let q = 0; q < tallCols.length; q += 2) grid[(tallCols[q + 1] - k0) * w + (tallCols[q] - i0)] = 1;
  const R = 4;
  for (let q = 0; q < S.n; q++) {
    if (S.low[q] !== 2) continue;
    const I = Math.floor((S.x[q] - m.origin.x) / m.res) - i0, K = Math.floor((S.z[q] - m.origin.z) / m.res) - k0;
    let n = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0;
    for (let dk = -R; dk <= R; dk++)
      for (let di = -R; di <= R; di++) {
        if (di * di + dk * dk > R * R) continue;
        const u = I + di, v = K + dk;
        if (u < 0 || v < 0 || u >= w || v >= h || !grid[v * w + u]) continue;
        n++;
        sx += di;
        sz += dk;
        sxx += di * di;
        szz += dk * dk;
        sxz += di * dk;
      }
    if (n < 4) continue;
    const cxx = sxx / n - (sx / n) ** 2, czz = szz / n - (sz / n) ** 2, cxz = sxz / n - (sx / n) * (sz / n);
    // Eigen-decomposition of the 2x2 covariance: the wall runs along the big axis.
    const tr = (cxx + czz) / 2, d = Math.sqrt(((cxx - czz) / 2) ** 2 + cxz * cxz);
    const l1 = tr + d, l2 = tr - d;
    if (l1 <= 1e-9) continue;
    const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz); // direction of the big axis
    const aniso = (l1 - l2) / (l1 + l2);
    S.nx[q] = -Math.sin(ang) * aniso;
    S.nz[q] = Math.cos(ang) * aniso;
  }
}

/**
 * Per-voxel score classes of a stored map, for fast pose scoring:
 *  1 confidently occupied, 2 occupied, 3 next to a confidently occupied
 *  voxel (x/z), 4 confidently free, 0 unknown / weak.
 * Lookup goes through a dense table of chunk slots.
 */
export class FragmentLookup {
  readonly res: number;
  readonly ny: number;
  readonly ox: number;
  readonly oz: number;
  private cx0 = 0;
  private cz0 = 0;
  private cw = 0;
  private ch = 0;
  private slots: Int32Array = new Int32Array(0);
  private cls: Int8Array = new Int8Array(0);
  /** Known (non-zero) voxels per column, for "is this column known" tests. */
  private colKnown: Uint8Array = new Uint8Array(0);

  /** Build synchronously (tests, tools); see create() for the sliced version. */
  constructor(m: ChunkedMap, build = true) {
    this.res = m.res;
    this.ny = m.ny;
    this.ox = m.origin.x;
    this.oz = m.origin.z;
    if (build) runToEnd(this.init(m));
  }

  /** Build in slices (yields every few chunks). */
  static *create(m: ChunkedMap): Work<FragmentLookup> {
    const L = new FragmentLookup(m, false);
    yield* L.init(m);
    return L;
  }

  private *init(m: ChunkedMap): Work<void> {
    if (!m.chunks.size) return;
    const y = every(6);
    let cx0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cz1 = -Infinity;
    for (const c of m.chunks.values()) {
      cx0 = Math.min(cx0, c.cx);
      cz0 = Math.min(cz0, c.cz);
      cx1 = Math.max(cx1, c.cx);
      cz1 = Math.max(cz1, c.cz);
    }
    this.cx0 = cx0;
    this.cz0 = cz0;
    this.cw = cx1 - cx0 + 1;
    this.ch = cz1 - cz0 + 1;
    this.slots = new Int32Array(this.cw * this.ch).fill(-1);
    const ny = m.ny, per = CS2 * ny;
    const cls = (this.cls = new Int8Array(per * m.chunks.size));
    const known = (this.colKnown = new Uint8Array(CS2 * m.chunks.size));
    let slot = 0;
    for (const c of m.chunks.values()) {
      this.slots[(c.cz - cz0) * this.cw + (c.cx - cx0)] = slot;
      const base = slot * per;
      const occ = c.occ;
      for (let j = 0; j < ny; j++)
        for (let q = 0; q < CS2; q++) {
          const v = occ[j * CS2 + q];
          if (v !== 0 && known[slot * CS2 + q] < 255) known[slot * CS2 + q]++;
          cls[base + j * CS2 + q] = v > 45 ? 1 : v > 20 ? 2 : v < FREE_CONF ? 4 : 0;
        }
      slot++;
      if (y()) yield;
    }
    // Neighbours of confident voxels (x/z). Inside a chunk directly; across
    // chunk borders through rawClass. (Reads only classes 1 and 2, which this
    // pass never writes, so the order doesn't matter.)
    slot = 0;
    for (const c of m.chunks.values()) {
      const base = slot * per;
      for (let j = 0; j < ny; j++) {
        const lb = base + j * CS2;
        for (let lz = 0; lz < CS; lz++)
          for (let lx = 0; lx < CS; lx++) {
            const n = lb + lz * CS + lx;
            const v = cls[n];
            if (v === 1 || v === 2) continue;
            let near: boolean;
            if (lx > 0 && lx < CS - 1 && lz > 0 && lz < CS - 1) near = cls[n - 1] === 1 || cls[n + 1] === 1 || cls[n - CS] === 1 || cls[n + CS] === 1;
            else {
              const I = c.cx * CS + lx, K = c.cz * CS + lz;
              near = this.rawClass(I - 1, K, j) === 1 || this.rawClass(I + 1, K, j) === 1 || this.rawClass(I, K - 1, j) === 1 || this.rawClass(I, K + 1, j) === 1;
            }
            if (near) cls[n] = v === 4 ? 5 : 3; // 5: free but next to an obstacle (edge)
          }
      }
      slot++;
      if (y()) yield;
    }
  }

  private rawClass(I: number, K: number, j: number): number {
    const cx = I >> 4, cz = K >> 4;
    const u = cx - this.cx0, w = cz - this.cz0;
    if (u < 0 || w < 0 || u >= this.cw || w >= this.ch) return 0;
    const s = this.slots[w * this.cw + u];
    if (s < 0) return 0;
    return this.cls[s * CS2 * this.ny + j * CS2 + (K & 15) * CS + (I & 15)];
  }

  /** Score class at metric (x, z) in the map's frame and layer j. */
  classAt(x: number, z: number, j: number): number {
    if (j < 0 || j >= this.ny) return 0;
    const I = Math.floor((x - this.ox) / this.res), K = Math.floor((z - this.oz) / this.res);
    return this.rawClass(I, K, j);
  }

  /** Number of known voxels in the column at (x, z). */
  knownAt(x: number, z: number): number {
    const I = Math.floor((x - this.ox) / this.res), K = Math.floor((z - this.oz) / this.res);
    const cx = I >> 4, cz = K >> 4;
    const u = cx - this.cx0, w = cz - this.cz0;
    if (u < 0 || w < 0 || u >= this.cw || w >= this.ch) return 0;
    const s = this.slots[w * this.cw + u];
    if (s < 0) return 0;
    return this.colKnown[s * CS2 + (K & 15) * CS + (I & 15)];
  }
}

export { chunkKey };

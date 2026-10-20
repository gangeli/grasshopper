import { OCC_THRESHOLD, type VoxelGrid } from './VoxelGrid';
import type { ImportOptions, SerializedChunk, SerializedMap } from './MapFormat';

/**
 * Conversion between the live voxel grid and the chunked plain-data form in
 * MapFormat.ts. The grid is addressed on a lattice whose origin is
 * (latticeX, latticeZ) and cell offset (oi, ok): grid cell (i, k) is lattice
 * cell (i + oi, k + ok). For a single fixed grid the offset is zero.
 */
export const CHUNK = 32;

export interface Lattice {
  originX: number;
  originY: number;
  originZ: number;
  /** Lattice cell of grid cell (0, ·, 0). */
  oi: number;
  ok: number;
}

/** Scale log-odds towards unknown by w, keeping each voxel's class (occupied / guessed / free). */
export function scaleEvidence(v: number, w: number): number {
  if (w >= 1) return v;
  if (v > OCC_THRESHOLD) return v === 127 ? 127 : OCC_THRESHOLD + 1 + Math.round((v - OCC_THRESHOLD - 1) * w);
  if (v < 0) return Math.min(-1, Math.round(v * w));
  return v;
}

/** Export the grid's chunks that hold any information above `floorLayer`. */
export function exportGrid(g: VoxelGrid, lat: Lattice, floorY: number, floorLayer: number, out: SerializedChunk[] = []): SerializedChunk[] {
  const C = CHUNK, ny = g.ny, layer = g.nx * g.nz;
  const ci0 = Math.floor(lat.oi / C), ci1 = Math.floor((lat.oi + g.nx - 1) / C);
  const ck0 = Math.floor(lat.ok / C), ck1 = Math.floor((lat.ok + g.nz - 1) / C);
  void floorY;
  for (let cz = ck0; cz <= ck1; cz++)
    for (let cx = ci0; cx <= ci1; cx++) {
      const occ = new Int8Array(C * C * ny);
      const observed = new Uint8Array(C * C);
      let under: Uint8Array | null = null, top: Uint8Array | null = null;
      let info = false;
      for (let k = 0; k < C; k++) {
        const gk = cz * C + k - lat.ok;
        if (gk < 0 || gk >= g.nz) continue;
        for (let i = 0; i < C; i++) {
          const gi = cx * C + i - lat.oi;
          if (gi < 0 || gi >= g.nx) continue;
          const col = gk * g.nx + gi;
          if (g.observed[col]) {
            observed[k * C + i] = 1;
            info = true;
          }
          for (let j = 0; j < ny; j++) {
            const n = j * layer + col, q = (j * C + k) * C + i;
            const v = g.data[n];
            occ[q] = v;
            if (v !== 0 && j >= floorLayer) info = true;
            const u = g.underside[n];
            if (u) (under ??= new Uint8Array(C * C * ny))[q] = u;
            const f = g.topFrac[n];
            if (f !== 255) (top ??= new Uint8Array(C * C * ny).fill(255))[q] = f;
          }
        }
      }
      if (!info) continue;
      const ch: SerializedChunk = { cx, cz, occ, observed };
      if (under) ch.underside = under;
      if (top) ch.topFrac = top;
      out.push(ch);
    }
  return out;
}

const isIdentity = (T: ArrayLike<number> | undefined | null) => {
  if (!T) return true;
  for (let q = 0; q < 16; q++) if (Math.abs(T[q] - (q % 5 === 0 ? 1 : 0)) > 1e-9) return false;
  return true;
};

/** Combine an imported value into a voxel. */
function combine(dst: number, src: number, mode: 'merge' | 'replace', w: number): number {
  const s = scaleEvidence(src, w);
  if (mode === 'replace' || dst === 0) return s;
  const v = Math.round(dst + (s - dst) * (w / 2));
  return v > 120 ? 120 : v < -60 ? -60 : v;
}

/**
 * Write a serialized map into the grid. `T` (column-major 4x4, rigid) maps
 * points of the serialized map's frame into the grid's frame. Voxels below
 * `floorLayer` (the solid sub-floor) are left alone. Returns the number of
 * voxels written.
 */
export function importIntoGrid(g: VoxelGrid, lat: Lattice, floorLayer: number, m: SerializedMap, T: ArrayLike<number> | null | undefined, opts: ImportOptions = {}): number {
  const mode = opts.mode ?? 'merge', w = Math.max(0, Math.min(1, opts.weight ?? 1));
  const C = m.chunkSize, sny = m.ny, layer = g.nx * g.nz, r = g.res;
  const byKey = new Map<string, SerializedChunk>();
  for (const c of m.chunks) byKey.set(`${c.cx},${c.cz}`, c);
  let written = 0;
  const write = (n: number, col: number, gj: number, ch: SerializedChunk, q: number, colQ: number, ySrcCellBottom: number, yDstCellBottom: number) => {
    const s = ch.occ[q];
    if (ch.observed[colQ] && !g.observed[col]) g.observed[col] = 1;
    if (gj < floorLayer) return;
    if (s !== 0) {
      const before = g.data[n];
      const v = combine(before, s, mode, w);
      if (v !== before) {
        g.data[n] = v;
        written++;
      }
    }
    if (ch.underside && ch.underside[q]) g.underside[n] |= ch.underside[q];
    if (ch.topFrac && ch.topFrac[q] !== 255 && (g.topFrac[n] === 255 || mode === 'replace')) {
      // Re-express the surface height relative to the destination voxel.
      const y = ySrcCellBottom + (ch.topFrac[q] / 254) * m.res;
      const f = Math.round(((y - yDstCellBottom) / r) * 254);
      if (f >= 0 && f <= 254) g.topFrac[n] = f;
    }
  };
  // Fast path: same lattice spacing, no transform, aligned origins.
  const di = (m.originX - lat.originX) / r, dk = (m.originZ - lat.originZ) / r, dj = (m.originY - g.origin.y) / r;
  const aligned = Math.abs(m.res - r) < 1e-9 && isIdentity(T) && [di, dk, dj].every((d) => Math.abs(d - Math.round(d)) < 1e-6);
  if (aligned) {
    const DI = Math.round(di) - lat.oi, DK = Math.round(dk) - lat.ok, DJ = Math.round(dj);
    for (const ch of m.chunks)
      for (let k = 0; k < C; k++) {
        const gk = ch.cz * C + k + DK;
        if (gk < 0 || gk >= g.nz) continue;
        for (let i = 0; i < C; i++) {
          const gi = ch.cx * C + i + DI;
          if (gi < 0 || gi >= g.nx) continue;
          const col = gk * g.nx + gi;
          for (let j = 0; j < sny; j++) {
            const gj = j + DJ;
            if (gj < 0 || gj >= g.ny) continue;
            write(gj * layer + col, col, gj, ch, (j * C + k) * C + i, k * C + i, m.originY + j * m.res, g.origin.y + gj * r);
          }
        }
      }
  } else {
    // General rigid transform: sample the source at the inverse-transformed
    // centre of every destination voxel the transformed chunk can touch.
    const M = T ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // Inverse of a rigid transform: Rᵀ, −Rᵀt.
    const R = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
    const tx = M[12], ty = M[13], tz = M[14];
    const inv = (x: number, y: number, z: number, o: number[]) => {
      const ax = x - tx, ay = y - ty, az = z - tz;
      o[0] = R[0] * ax + R[1] * ay + R[2] * az;
      o[1] = R[3] * ax + R[4] * ay + R[5] * az;
      o[2] = R[6] * ax + R[7] * ay + R[8] * az;
    };
    const fwd = (x: number, y: number, z: number) => ({ x: M[0] * x + M[4] * y + M[8] * z + tx, y: M[1] * x + M[5] * y + M[9] * z + ty, z: M[2] * x + M[6] * y + M[10] * z + tz });
    const s = [0, 0, 0];
    const gox = lat.originX + lat.oi * r, goz = lat.originZ + lat.ok * r;
    for (const ch of m.chunks) {
      const x0 = m.originX + ch.cx * C * m.res, z0 = m.originZ + ch.cz * C * m.res, x1 = x0 + C * m.res, z1 = z0 + C * m.res;
      const y0 = m.originY, y1 = m.originY + sny * m.res;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
        const p = fwd(x, y, z);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      const i0 = Math.max(0, Math.floor((minX - gox) / r)), i1 = Math.min(g.nx - 1, Math.floor((maxX - gox) / r));
      const k0 = Math.max(0, Math.floor((minZ - goz) / r)), k1 = Math.min(g.nz - 1, Math.floor((maxZ - goz) / r));
      const j0 = Math.max(0, Math.floor((minY - g.origin.y) / r)), j1 = Math.min(g.ny - 1, Math.floor((maxY - g.origin.y) / r));
      for (let gk = k0; gk <= k1; gk++)
        for (let gi = i0; gi <= i1; gi++) {
          const col = gk * g.nx + gi;
          for (let gj = j0; gj <= j1; gj++) {
            inv(gox + (gi + 0.5) * r, g.origin.y + (gj + 0.5) * r, goz + (gk + 0.5) * r, s);
            const I = Math.floor((s[0] - m.originX) / m.res) - ch.cx * C, J = Math.floor((s[1] - m.originY) / m.res), K = Math.floor((s[2] - m.originZ) / m.res) - ch.cz * C;
            if (I < 0 || K < 0 || I >= C || K >= C || J < 0 || J >= sny) continue;
            // Source voxel bottom, carried into the destination frame (heights only move by ty for a level transform).
            const srcBottom = m.originY + J * m.res;
            write(gj * layer + col, col, gj, ch, (J * C + K) * C + I, K * C + I, srcBottom + (g.origin.y + (gj + 0.5) * r - (s[1])) , g.origin.y + gj * r);
          }
        }
    }
  }
  g.touchAll();
  g.version++;
  return written;
}

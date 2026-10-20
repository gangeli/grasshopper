import { CHUNK } from './mapIO';
import type { VoxelGrid } from './VoxelGrid';

/**
 * Storage for the parts of the map outside the dense window around the
 * player (see WorldModel: the window follows the camera; what leaves it is
 * kept here and comes back when the player does). Chunks are CHUNK×CHUNK
 * voxel columns of full height on the map's fixed lattice, in the same
 * layout as MapFormat ((j·C + k)·C + i).
 */
export interface StoredChunk {
  data: Int8Array;
  observed: Uint8Array;
  /** Null when all zero. */
  underside: Uint8Array | null;
  /** Null when all 255 (unknown). */
  topFrac: Uint8Array | null;
  /** Last-hit time codes (see VoxelGrid.hitTime); null when all 0. */
  hitTime: Uint16Array | null;
  /** Grid origin height (map frame) the layers were stored against. */
  oy: number;
  /** When it was stored (s). */
  t: number;
}

const KEY_OFF = 1 << 15;
export const chunkKey = (cx: number, cz: number) => (cx + KEY_OFF) * 65536 + (cz + KEY_OFF);
export const keyCx = (key: number) => Math.floor(key / 65536) - KEY_OFF;
export const keyCz = (key: number) => (key % 65536) - KEY_OFF;

export class ChunkStore {
  readonly map = new Map<number, StoredChunk>();

  get size(): number {
    return this.map.size;
  }

  bytes(): number {
    let n = 0;
    for (const c of this.map.values()) n += c.data.byteLength + c.observed.byteLength + (c.underside?.byteLength ?? 0) + (c.topFrac?.byteLength ?? 0) + (c.hitTime?.byteLength ?? 0) + 64;
    return n;
  }

  get(cx: number, cz: number): StoredChunk | undefined {
    return this.map.get(chunkKey(cx, cz));
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Store chunk (cx, cz) from grid g, whose cell (0, ·, 0) is lattice cell
   * (gi0, gk0). A chunk without any information above `floorLayer` is
   * dropped (the window was authoritative for it).
   */
  saveFrom(g: VoxelGrid, gi0: number, gk0: number, cx: number, cz: number, floorLayer: number, t: number): void {
    const C = CHUNK, ny = g.ny, layer = g.nx * g.nz;
    const bi = cx * C - gi0, bk = cz * C - gk0;
    const data = new Int8Array(C * C * ny), observed = new Uint8Array(C * C);
    let under: Uint8Array | null = null, top: Uint8Array | null = null, hits: Uint16Array | null = null, info = false;
    for (let k = 0; k < C; k++) {
      const gk = bk + k;
      if (gk < 0 || gk >= g.nz) continue;
      const i0 = Math.max(0, -bi), i1 = Math.min(C, g.nx - bi);
      if (i1 <= i0) continue;
      const rowCol = gk * g.nx + bi;
      for (let i = i0; i < i1; i++)
        if (g.observed[rowCol + i]) {
          observed[k * C + i] = 1;
          info = true;
        }
      for (let j = 0; j < ny; j++) {
        const src = j * layer + rowCol, dst = (j * C + k) * C;
        data.set(g.data.subarray(src + i0, src + i1), dst + i0);
        if (!info && j >= floorLayer) for (let i = i0; i < i1; i++) if (g.data[src + i] !== 0) (info = true);
        for (let i = i0; i < i1; i++) {
          const u = g.underside[src + i];
          if (u) (under ??= new Uint8Array(C * C * ny))[dst + i] = u;
          const f = g.topFrac[src + i];
          if (f !== 255) (top ??= new Uint8Array(C * C * ny).fill(255))[dst + i] = f;
          const h = g.hitTime ? g.hitTime[src + i] : 0;
          if (h) (hits ??= new Uint16Array(C * C * ny))[dst + i] = h;
        }
      }
    }
    const key = chunkKey(cx, cz);
    if (!info) this.map.delete(key);
    else this.map.set(key, { data, observed, underside: under, topFrac: top, hitTime: hits, oy: g.origin.y, t });
  }

  /**
   * Write chunk (cx, cz) into grid g (cell (0,·,0) = lattice (gi0, gk0)),
   * re-levelled if the grid's floor moved since it was stored. Layers below
   * `floorLayer` stay as they are (solid). Returns false if nothing is stored.
   */
  loadInto(g: ChunkTarget, gi0: number, gk0: number, cx: number, cz: number, floorLayer: number): boolean {
    const c = this.map.get(chunkKey(cx, cz));
    if (!c) return false;
    const C = CHUNK, ny = g.ny, layer = g.nx * g.nz;
    const bi = cx * C - gi0, bk = cz * C - gk0;
    const shift = Math.round((g.origin.y - c.oy) / g.res);
    for (let k = 0; k < C; k++) {
      const gk = bk + k;
      if (gk < 0 || gk >= g.nz) continue;
      const i0 = Math.max(0, -bi), i1 = Math.min(C, g.nx - bi);
      if (i1 <= i0) continue;
      const rowCol = gk * g.nx + bi;
      if (g.observed) for (let i = i0; i < i1; i++) if (c.observed[k * C + i]) g.observed[rowCol + i] = 1;
      if (!g.data && !g.underside && !g.topFrac) continue;
      for (let j = floorLayer; j < ny; j++) {
        // The band just above the floor changes meaning when the floor moved: leave it unknown.
        const js = j + shift;
        if (js < floorLayer || js >= ny || (shift !== 0 && j < floorLayer + 3)) continue;
        const dst = j * layer + rowCol, src = (js * C + k) * C;
        if (g.data) g.data.set(c.data.subarray(src + i0, src + i1), dst + i0);
        if (c.underside && g.underside) g.underside.set(c.underside.subarray(src + i0, src + i1), dst + i0);
        if (c.topFrac && g.topFrac) g.topFrac.set(c.topFrac.subarray(src + i0, src + i1), dst + i0);
        if (c.hitTime && g.hitTime) g.hitTime.set(c.hitTime.subarray(src + i0, src + i1), dst + i0);
      }
    }
    return true;
  }
}

/** Where loadInto writes: a grid, or any subset of a grid's arrays. */
export interface ChunkTarget {
  nx: number;
  ny: number;
  nz: number;
  res: number;
  origin: { y: number };
  data?: Int8Array;
  observed?: Uint8Array;
  underside?: Uint8Array;
  topFrac?: Uint8Array;
  hitTime?: Uint16Array | null;
}

/**
 * Shift a layered array in place: cell (i, k) takes the value of cell
 * (i + di, k + dk); cells with no source get `fill` (per layer: fill(j)).
 */
export function shiftInPlace(a: Int8Array | Uint8Array | Uint16Array, nx: number, nz: number, layers: number, di: number, dk: number, fill: (j: number) => number): void {
  const layer = nx * nz;
  const i0 = Math.max(0, -di), i1 = Math.min(nx, nx - di);
  // Visit rows so that a row is read before it is overwritten.
  const up = dk > 0 || (dk === 0 && di > 0);
  for (let j = 0; j < layers; j++) {
    const base = j * layer, f = fill(j);
    for (let q = 0; q < nz; q++) {
      const k = up ? q : nz - 1 - q;
      const d = base + k * nx, ks = k + dk;
      if (ks < 0 || ks >= nz || i1 <= i0) {
        a.fill(f, d, d + nx);
        continue;
      }
      const s = base + ks * nx;
      a.copyWithin(d + i0, s + i0 + di, s + i1 + di);
      if (i0 > 0) a.fill(f, d, d + i0);
      if (i1 < nx) a.fill(f, d + i1, d + nx);
    }
  }
}

/**
 * Copy the overlap of a layered per-voxel (or per-column, layers = 1) array
 * between two equally sized windows: dst cell (i, k) = src cell (i + di, k + dk).
 */
export function copyOverlap<A extends Int8Array | Uint8Array | Uint16Array>(src: A, dst: A, nx: number, nz: number, layers: number, di: number, dk: number): void {
  const i0 = Math.max(0, -di), i1 = Math.min(nx, nx - di);
  if (i1 <= i0) return;
  const layer = nx * nz;
  for (let j = 0; j < layers; j++)
    for (let k = Math.max(0, -dk); k < Math.min(nz, nz - dk); k++) {
      const d = j * layer + k * nx, s = j * layer + (k + dk) * nx + di;
      dst.set(src.subarray(s + i0, s + i1), d + i0);
    }
}

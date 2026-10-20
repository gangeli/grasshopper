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
  /**
   * Hit time codes (see VoxelGrid.hitTime) of the voxels with positive
   * occupancy evidence, sparse: chunk-local indices and packed values.
   */
  hitIdx: Uint16Array | null;
  hitVal: Uint32Array | null;
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
  private readonly chunks = new Map<number, StoredChunk>();
  /**
   * Saves not done yet: chunks of a grid that is no longer written to (the
   * window moved on), stored a few per frame by step() instead of all in the
   * frame the window moved. Anything reading the store finishes them first.
   */
  private pending: { g: VoxelGrid; gi0: number; gk0: number; cx: number; cz: number; floorLayer: number; t: number }[] = [];

  /** All stored chunks (finishes pending saves first). */
  get map(): Map<number, StoredChunk> {
    this.flush();
    return this.chunks;
  }

  get size(): number {
    return this.map.size;
  }

  /** Store chunk (cx, cz) of `g` later (g must not change any more). */
  defer(g: VoxelGrid, gi0: number, gk0: number, cx: number, cz: number, floorLayer: number, t: number): void {
    const key = chunkKey(cx, cz);
    this.pending = this.pending.filter((p) => chunkKey(p.cx, p.cz) !== key);
    this.pending.push({ g, gi0, gk0, cx, cz, floorLayer, t });
  }

  /** Do up to n pending saves; true while more remain. */
  step(n = 2): boolean {
    for (let q = 0; q < n && this.pending.length; q++) {
      const p = this.pending.shift()!;
      this.saveNow(p.g, p.gi0, p.gk0, p.cx, p.cz, p.floorLayer, p.t);
    }
    return this.pending.length > 0;
  }

  flush(): void {
    while (this.pending.length) this.step(this.pending.length);
  }

  bytes(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.data.byteLength + c.observed.byteLength + (c.underside?.byteLength ?? 0) + (c.topFrac?.byteLength ?? 0) + (c.hitIdx?.byteLength ?? 0) + (c.hitVal?.byteLength ?? 0) + 64;
    return n;
  }

  /** One chunk (finishing only its own pending save, if any). */
  get(cx: number, cz: number): StoredChunk | undefined {
    const key = chunkKey(cx, cz);
    const at = this.pending.findIndex((p) => p.cx === cx && p.cz === cz);
    if (at >= 0) {
      const p = this.pending.splice(at, 1)[0];
      this.saveNow(p.g, p.gi0, p.gk0, p.cx, p.cz, p.floorLayer, p.t);
    }
    return this.chunks.get(key);
  }

  /** Store a chunk as is (replacing what was there). */
  put(cx: number, cz: number, c: StoredChunk): void {
    const key = chunkKey(cx, cz);
    this.flush();
    this.chunks.set(key, c);
  }

  has(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    return this.chunks.has(key) || this.pending.some((p) => chunkKey(p.cx, p.cz) === key);
  }

  /** Forget one chunk (and any pending save of it). */
  delete(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    this.pending = this.pending.filter((p) => chunkKey(p.cx, p.cz) !== key);
    this.chunks.delete(key);
  }

  clear(): void {
    this.pending = [];
    this.chunks.clear();
  }

  /**
   * Store chunk (cx, cz) from grid g, whose cell (0, ·, 0) is lattice cell
   * (gi0, gk0). A chunk without any information above `floorLayer` is
   * dropped (the window was authoritative for it).
   */
  saveFrom(g: VoxelGrid, gi0: number, gk0: number, cx: number, cz: number, floorLayer: number, t: number): void {
    // A newer save of this chunk replaces a pending one.
    const key = chunkKey(cx, cz);
    if (this.pending.length) this.pending = this.pending.filter((p) => chunkKey(p.cx, p.cz) !== key);
    this.saveNow(g, gi0, gk0, cx, cz, floorLayer, t);
  }

  private saveNow(g: VoxelGrid, gi0: number, gk0: number, cx: number, cz: number, floorLayer: number, t: number): void {
    const C = CHUNK, ny = g.ny, layer = g.nx * g.nz, n = C * C * ny;
    const bi = cx * C - gi0, bk = cz * C - gk0;
    const key = chunkKey(cx, cz);
    // Reuse the arrays of what was stored here before (it's replaced).
    const prev = this.chunks.get(key);
    const data = prev?.data.length === n ? prev.data.fill(0) : new Int8Array(n), observed = prev?.observed.length === C * C ? prev.observed.fill(0) : new Uint8Array(C * C);
    const under = prev?.underside?.length === n ? prev.underside.fill(0) : new Uint8Array(n);
    const top = prev?.topFrac?.length === n ? prev.topFrac.fill(255) : new Uint8Array(n).fill(255);
    // Plain loops over 32-voxel rows (cheaper than a typed-array view per
    // row), one array at a time (monomorphic, tight).
    const i0 = Math.max(0, -bi), i1 = Math.min(C, g.nx - bi);
    let info = false;
    for (let k = 0; k < C; k++) {
      const gk = bk + k;
      if (gk < 0 || gk >= g.nz || i1 <= i0) continue;
      const rowCol = gk * g.nx + bi;
      for (let i = i0; i < i1; i++)
        if (g.observed[rowCol + i]) {
          observed[k * C + i] = 1;
          info = true;
        }
    }
    const copyRows = (src: Int8Array | Uint8Array | Uint16Array, dst: Int8Array | Uint8Array | Uint16Array, skip: number, fromLayer: number): boolean => {
      let any = false;
      for (let k = 0; k < C; k++) {
        const gk = bk + k;
        if (gk < 0 || gk >= g.nz || i1 <= i0) continue;
        const rowCol = gk * g.nx + bi;
        for (let j = 0; j < ny; j++) {
          const s0 = j * layer + rowCol, d0 = (j * C + k) * C;
          for (let i = i0; i < i1; i++) {
            const v = src[s0 + i];
            dst[d0 + i] = v;
            if (v !== skip && j >= fromLayer) any = true;
          }
        }
      }
      return any;
    };
    if (copyRows(g.data, data, 0, floorLayer)) info = true;
    if (!info) {
      this.chunks.delete(key);
      return;
    }
    const anyUnder = copyRows(g.underside, under, 0, 0), anyTop = copyRows(g.topFrac, top, 255, 0);
    // Hit times only where there is positive evidence (the rest don't matter).
    let hitIdx: Uint16Array | null = null, hitVal: Uint32Array | null = null;
    const gh = g.hitTime;
    if (gh) {
      const idx: number[] = [], val: number[] = [];
      for (let k = 0; k < C; k++) {
        const gk = bk + k;
        if (gk < 0 || gk >= g.nz || i1 <= i0) continue;
        const rowCol = gk * g.nx + bi;
        for (let j = floorLayer; j < ny; j++) {
          const s0 = j * layer + rowCol, d0 = (j * C + k) * C;
          for (let i = i0; i < i1; i++) {
            const h = gh[s0 + i];
            if (h !== 0 && data[d0 + i] > 0) {
              idx.push(d0 + i);
              val.push(h);
            }
          }
        }
      }
      if (idx.length) {
        hitIdx = Uint16Array.from(idx);
        hitVal = Uint32Array.from(val);
      }
    }
    this.chunks.set(key, { data, observed, underside: anyUnder ? under : null, topFrac: anyTop ? top : null, hitIdx, hitVal, oy: g.origin.y, t });
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
      const gd = g.data, gu = c.underside ? g.underside : undefined, gt = c.topFrac ? g.topFrac : undefined;
      if (!gd && !gu && !gt) continue;
      for (let j = floorLayer; j < ny; j++) {
        // The band just above the floor changes meaning when the floor moved: leave it unknown.
        const js = j + shift;
        if (js < floorLayer || js >= ny || (shift !== 0 && j < floorLayer + 3)) continue;
        const dst = j * layer + rowCol, src = (js * C + k) * C;
        for (let i = i0; i < i1; i++) {
          if (gd) gd[dst + i] = c.data[src + i];
          if (gu) gu[dst + i] = c.underside![src + i];
          if (gt) gt[dst + i] = c.topFrac![src + i];
        }
      }
    }
    if (c.hitIdx && g.hitTime) forHits(c, g, bi, bk, shift, floorLayer, (n, h) => (g.hitTime![n] = h));
    return true;
  }
}

/**
 * Like ChunkStore.loadInto, but what the grid already holds wins (it is
 * newer: observations made since the chunk entered the window).
 */
export function mergeChunkInto(store: ChunkStore, g: VoxelGrid, gi0: number, gk0: number, cx: number, cz: number, floorLayer: number): boolean {
  const c = store.get(cx, cz);
  if (!c) return false;
  const C = CHUNK, ny = g.ny, layer = g.nx * g.nz;
  const bi = cx * C - gi0, bk = cz * C - gk0;
  const shift = Math.round((g.origin.y - c.oy) / g.res);
  const i0 = Math.max(0, -bi), i1 = Math.min(C, g.nx - bi);
  for (let k = 0; k < C; k++) {
    const gk = bk + k;
    if (gk < 0 || gk >= g.nz || i1 <= i0) continue;
    const rowCol = gk * g.nx + bi;
    for (let i = i0; i < i1; i++) {
      if (c.observed[k * C + i]) g.observed[rowCol + i] = 1;
      g.touchColumn(bi + i, gk);
    }
    for (let j = floorLayer; j < ny; j++) {
      const js = j + shift;
      if (js < floorLayer || js >= ny || (shift !== 0 && j < floorLayer + 3)) continue;
      const dst = j * layer + rowCol, src = (js * C + k) * C;
      for (let i = i0; i < i1; i++) {
        if (g.data[dst + i] !== 0) continue;
        g.data[dst + i] = c.data[src + i];
        if (c.underside) g.underside[dst + i] |= c.underside[src + i];
        if (c.topFrac && g.topFrac[dst + i] === 255) g.topFrac[dst + i] = c.topFrac[src + i];
      }
    }
  }
  if (c.hitIdx && g.hitTime) forHits(c, g, bi, bk, shift, floorLayer, (n, h) => {
    if (g.hitTime![n] === 0) g.hitTime![n] = h;
  });
  g.version++;
  return true;
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
  hitTime?: Uint32Array | null;
}

/** Visit a stored chunk's sparse hit times at their grid indices (same layer rules as loadInto). */
function forHits(c: StoredChunk, g: ChunkTarget, bi: number, bk: number, shift: number, floorLayer: number, f: (n: number, h: number) => void): void {
  const C = CHUNK, layer = g.nx * g.nz;
  const idx = c.hitIdx!, val = c.hitVal!;
  for (let q = 0; q < idx.length; q++) {
    const d = idx[q], i = d % C, k = Math.floor(d / C) % C, js = Math.floor(d / (C * C));
    const j = js - shift;
    if (j < floorLayer || j >= g.ny || (shift !== 0 && j < floorLayer + 3)) continue;
    const gi = bi + i, gk = bk + k;
    if (gi < 0 || gk < 0 || gi >= g.nx || gk >= g.nz) continue;
    f(j * layer + gk * g.nx + gi, val[q]);
  }
}

/**
 * Shift a layered array in place: cell (i, k) takes the value of cell
 * (i + di, k + dk); cells with no source get `fill` (per layer: fill(j)).
 */
export function shiftInPlace(a: Int8Array | Uint8Array | Uint16Array | Uint32Array, nx: number, nz: number, layers: number, di: number, dk: number, fill: (j: number) => number): void {
  const layer = nx * nz;
  // Within a layer the shift is a flat offset: one copyWithin per layer,
  // then the cells whose source fell off the window (wrapped from the
  // neighbouring row, or beyond the layer) get the fill value.
  const off = dk * nx + di;
  const k0 = Math.max(0, -dk), k1 = Math.min(nz, nz - dk);
  const i0 = Math.max(0, -di), i1 = Math.min(nx, nx - di);
  for (let j = 0; j < layers; j++) {
    const base = j * layer, f = fill(j);
    if (Math.abs(off) >= layer || k1 <= k0 || i1 <= i0) {
      a.fill(f, base, base + layer);
      continue;
    }
    if (off > 0) a.copyWithin(base, base + off, base + layer);
    else if (off < 0) a.copyWithin(base - off, base, base + layer + off);
    if (k0 > 0) a.fill(f, base, base + k0 * nx);
    if (k1 < nz) a.fill(f, base + k1 * nx, base + layer);
    if (i0 > 0) for (let k = k0; k < k1; k++) a.fill(f, base + k * nx, base + k * nx + i0);
    if (i1 < nx) for (let k = k0; k < k1; k++) a.fill(f, base + k * nx + i1, base + (k + 1) * nx);
  }
}

/**
 * shiftInPlace into another array: dst cell (i, k) = src cell (i + di, k + dk),
 * `fill` where there's no source. One copy per layer plus the edges.
 */
export function shiftCopy<A extends Int8Array | Uint8Array | Uint16Array | Uint32Array>(src: A, dst: A, nx: number, nz: number, layers: number, di: number, dk: number, fill: (j: number) => number): void {
  const layer = nx * nz;
  const off = dk * nx + di;
  const k0 = Math.max(0, -dk), k1 = Math.min(nz, nz - dk);
  const i0 = Math.max(0, -di), i1 = Math.min(nx, nx - di);
  for (let j = 0; j < layers; j++) {
    const base = j * layer, f = fill(j);
    if (Math.abs(off) >= layer || k1 <= k0 || i1 <= i0) {
      dst.fill(f, base, base + layer);
      continue;
    }
    if (off >= 0) dst.set(src.subarray(base + off, base + layer), base);
    else dst.set(src.subarray(base, base + layer + off), base - off);
    if (k0 > 0) dst.fill(f, base, base + k0 * nx);
    if (k1 < nz) dst.fill(f, base + k1 * nx, base + layer);
    if (i0 > 0) for (let k = k0; k < k1; k++) dst.fill(f, base + k * nx, base + k * nx + i0);
    if (i1 < nx) for (let k = k0; k < k1; k++) dst.fill(f, base + k * nx + i1, base + (k + 1) * nx);
  }
}

/**
 * Copy the overlap of a layered per-voxel (or per-column, layers = 1) array
 * between two equally sized windows: dst cell (i, k) = src cell (i + di, k + dk).
 */
export function copyOverlap<A extends Int8Array | Uint8Array | Uint16Array | Uint32Array>(src: A, dst: A, nx: number, nz: number, layers: number, di: number, dk: number): void {
  const i0 = Math.max(0, -di), i1 = Math.min(nx, nx - di);
  if (i1 <= i0) return;
  const layer = nx * nz;
  for (let j = 0; j < layers; j++)
    for (let k = Math.max(0, -dk); k < Math.min(nz, nz - dk); k++) {
      const d = j * layer + k * nx, s = j * layer + (k + dk) * nx + di;
      dst.set(src.subarray(s + i0, s + i1), d + i0);
    }
}

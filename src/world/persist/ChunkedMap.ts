/**
 * The persistence layer's own map representation: a sparse, unbounded set of
 * column chunks with plain typed arrays. Everything in src/world/persist
 * (storage, relocalization, stitching) works on this, so it doesn't depend on
 * how the live WorldModel stores its grid (see adapter.ts for the bridge).
 *
 * Layout: layer 0 is the first layer of free space above the floor (the
 * floor is at the bottom of layer 0, so maps of different sessions line up
 * vertically by floor). Columns live on a lattice anchored at `origin`:
 * column (I, K) spans x ∈ [origin.x + I·res, origin.x + (I+1)·res) (same in z).
 * A chunk holds CS×CS columns, all layers.
 */
export const CS = 16;
export const CS2 = CS * CS;

export interface MapChunk {
  cx: number;
  cz: number;
  /** Log-odds per voxel, index (j·CS + lz)·CS + lx. */
  occ: Int8Array;
  /** Per column: floor observed (1) or not. Index lz·CS + lx. */
  observed: Uint8Array;
  /** VoxelGrid underside bits per voxel (null = all zero). */
  underside: Uint8Array | null;
  /** VoxelGrid sub-voxel surface height per voxel (null = all unknown, 255). */
  topFrac: Uint8Array | null;
}

export interface ChunkedMap {
  res: number;
  /** Layers above the floor. */
  ny: number;
  /** Lattice anchor in the map's own frame (y = floor height). */
  origin: { x: number; y: number; z: number };
  chunks: Map<number, MapChunk>;
}

/** Pack chunk coordinates (each within ±32767) into one number key. */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}
export function keyCx(key: number): number {
  return Math.floor(key / 65536) - 32768;
}
export function keyCz(key: number): number {
  return (key % 65536) - 32768;
}

export function emptyMap(res: number, ny: number, origin: { x: number; y: number; z: number }): ChunkedMap {
  return { res, ny, origin: { ...origin }, chunks: new Map() };
}

export function newChunk(cx: number, cz: number, ny: number): MapChunk {
  return { cx, cz, occ: new Int8Array(CS2 * ny), observed: new Uint8Array(CS2), underside: null, topFrac: null };
}

export function getOrCreateChunk(m: ChunkedMap, cx: number, cz: number): MapChunk {
  const key = chunkKey(cx, cz);
  let c = m.chunks.get(key);
  if (!c) {
    c = newChunk(cx, cz, m.ny);
    m.chunks.set(key, c);
  }
  return c;
}

/** Column bounds (inclusive min, exclusive max) of all chunks. */
export function columnBounds(m: ChunkedMap): { i0: number; k0: number; i1: number; k1: number } | null {
  if (!m.chunks.size) return null;
  let i0 = Infinity, k0 = Infinity, i1 = -Infinity, k1 = -Infinity;
  for (const c of m.chunks.values()) {
    i0 = Math.min(i0, c.cx * CS);
    k0 = Math.min(k0, c.cz * CS);
    i1 = Math.max(i1, (c.cx + 1) * CS);
    k1 = Math.max(k1, (c.cz + 1) * CS);
  }
  return { i0, k0, i1, k1 };
}

/** Voxel value at global column (I, K), layer j (0 when unknown / outside). */
export function voxelAt(m: ChunkedMap, I: number, K: number, j: number): number {
  if (j < 0 || j >= m.ny) return 0;
  const cx = Math.floor(I / CS), cz = Math.floor(K / CS);
  const c = m.chunks.get(chunkKey(cx, cz));
  if (!c) return 0;
  return c.occ[(j * CS + (K - cz * CS)) * CS + (I - cx * CS)];
}

export function chunkIsEmpty(c: MapChunk): boolean {
  for (let q = 0; q < c.observed.length; q++) if (c.observed[q]) return false;
  const o = c.occ;
  for (let q = 0; q < o.length; q++) if (o[q] !== 0) return false;
  return true;
}

export function cloneMap(m: ChunkedMap): ChunkedMap {
  const out = emptyMap(m.res, m.ny, m.origin);
  for (const [k, c] of m.chunks)
    out.chunks.set(k, { cx: c.cx, cz: c.cz, occ: c.occ.slice(), observed: c.observed.slice(), underside: c.underside?.slice() ?? null, topFrac: c.topFrac?.slice() ?? null });
  return out;
}

/** Number of columns with observed floor (×res² = observed area). */
export function observedColumns(m: ChunkedMap): number {
  let n = 0;
  for (const c of m.chunks.values()) for (let q = 0; q < CS2; q++) n += c.observed[q];
  return n;
}

/** Number of voxels above the occupancy threshold. */
export function occupiedVoxels(m: ChunkedMap, threshold = 20): number {
  let n = 0;
  for (const c of m.chunks.values()) for (let q = 0; q < c.occ.length; q++) if (c.occ[q] > threshold) n++;
  return n;
}

/** Number of voxels with any evidence. */
export function knownVoxels(m: ChunkedMap): number {
  let n = 0;
  for (const c of m.chunks.values()) for (let q = 0; q < c.occ.length; q++) if (c.occ[q] !== 0) n++;
  return n;
}

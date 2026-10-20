/**
 * Plain-data form of the voxel map, for saving a map and loading it into
 * another session (see WorldModel.exportMap / importMap). It contains only
 * typed arrays and numbers, so it can be structured-cloned, posted to a
 * worker, or written to IndexedDB as is.
 *
 * Layout
 * ------
 * The map is a lattice of cubic voxels of side `res` (m) in the *map frame*
 * (y up). Voxel (I, J, K) — integers, possibly negative in I and K — spans
 *
 *   x ∈ [originX + I·res, originX + (I+1)·res)
 *   y ∈ [originY + J·res, originY + (J+1)·res),   0 ≤ J < ny
 *   z ∈ [originZ + K·res, originZ + (K+1)·res)
 *
 * Horizontally the lattice is cut into square column tiles ("chunks") of
 * `chunkSize` × `chunkSize` voxels, each holding the full height (ny layers).
 * Chunk (cx, cz) holds voxels I ∈ [cx·chunkSize, (cx+1)·chunkSize),
 * K ∈ [cz·chunkSize, (cz+1)·chunkSize). Only chunks with any information are
 * present; a missing chunk means "never observed" (all zero / unknown).
 *
 * Inside a chunk, voxel (i, j, k) (local, 0 ≤ i,k < chunkSize, 0 ≤ j < ny)
 * is at index  (j · chunkSize + k) · chunkSize + i  in the per-voxel arrays,
 * and column (i, k) at  k · chunkSize + i  in the per-column arrays.
 *
 * Values
 * ------
 * occ        Int8 log-odds occupancy: > 20 occupied (OCC_THRESHOLD), 10..20
 *            guessed solid, 0 unknown, < 0 observed free (−60 … +120 clamp
 *            range; 127 marks the solid layers below the floor).
 * observed   1 where floor has been observed in that column (walkable floor
 *            is only trusted where observed), else 0.
 * underside  per-voxel bits: 1 = a downward-facing surface (a table's
 *            underside) passes here, 2 = an upward-facing one. Optional
 *            (absent = all zero).
 * topFrac    sub-voxel height of an upward surface inside the voxel, as a
 *            fraction 0..254 of the voxel height; 255 = unknown. Optional
 *            (absent = all 255).
 *
 * `floorY` is the floor height (map frame) when exported; the first free
 * layer above the floor is `floorLayer` (floorY = originY + floorLayer·res).
 */
export interface SerializedChunk {
  cx: number;
  cz: number;
  occ: Int8Array;
  observed: Uint8Array;
  underside?: Uint8Array;
  topFrac?: Uint8Array;
}

export interface SerializedMap {
  /** Format version (bump on incompatible changes). */
  version: 1;
  res: number;
  chunkSize: number;
  ny: number;
  originX: number;
  originY: number;
  originZ: number;
  floorY: number;
  floorLayer: number;
  chunks: SerializedChunk[];
}

/** Options for WorldModel.importMap. */
export interface ImportOptions {
  /**
   * How imported evidence combines with what the map already holds:
   *  - 'merge' (default): voxels the current map has never observed take the
   *    imported value (scaled by `weight`); observed ones keep their own
   *    value, nudged towards the imported one by `weight / 2`.
   *  - 'replace': imported chunks overwrite the map where they have data.
   *  - 'exact': every voxel and column of each imported chunk is written as
   *    it is, unknown (0) and unobserved included (`weight` is ignored);
   *    chunks absent from the import are left alone. For restoring a saved
   *    chunk exactly (undo, persistence round trips).
   */
  mode?: 'merge' | 'replace' | 'exact';
  /**
   * Confidence of the imported evidence, 0..1 (default 1). Below 1 an old
   * map is easier for fresh observations to overrule (things get moved
   * between sessions). Occupied voxels stay occupied (just less confident).
   */
  weight?: number;
}

/** Number of voxels in one chunk. */
export function chunkVoxels(m: Pick<SerializedMap, 'chunkSize' | 'ny'>): number {
  return m.chunkSize * m.chunkSize * m.ny;
}

/** Total bytes held by a serialized map's arrays. */
export function serializedBytes(m: SerializedMap): number {
  let n = 0;
  for (const c of m.chunks) n += c.occ.byteLength + c.observed.byteLength + (c.underside?.byteLength ?? 0) + (c.topFrac?.byteLength ?? 0);
  return n;
}

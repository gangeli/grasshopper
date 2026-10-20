import { FLOOR_LAYERS_BELOW, type WorldModel } from '../WorldModel';
import { CS, CS2, chunkKey, emptyMap, newChunk, type ChunkedMap, type MapChunk } from './ChunkedMap';

/**
 * Bridge between the live WorldModel (today: one dense VoxelGrid) and the
 * persistence layer's ChunkedMap. This is the only file in persist/ that
 * knows the grid's internals; when the world model offers
 * exportMap()/importMap() this file becomes a thin wrapper around them.
 *
 * exportLive: the grid's above-floor layers, on the grid's own lattice
 * (origin = grid origin, y = floor height), so export/import is exact.
 * importLive: replace the grid's above-floor contents with a map on that
 * same lattice (chunks that are missing become unknown).
 */
export interface LiveLattice {
  res: number;
  ny: number;
  origin: { x: number; y: number; z: number };
  /** Grid size in columns. */
  nx: number;
  nz: number;
}

export function liveLattice(world: WorldModel): LiveLattice | null {
  const g = world.grid;
  if (!g) return null;
  return { res: g.res, ny: g.ny - FLOOR_LAYERS_BELOW, origin: { x: g.origin.x, y: world.floorY, z: g.origin.z }, nx: g.nx, nz: g.nz };
}

/**
 * Copy the live grid into a ChunkedMap. `rows` limits the export to chunk
 * rows [r0, r1) so callers can spread the work over frames.
 */
export function exportLive(world: WorldModel, into?: ChunkedMap, rows?: [number, number]): ChunkedMap | null {
  const g = world.grid;
  if (!g) return null;
  const lat = liveLattice(world)!;
  const out = into ?? emptyMap(lat.res, lat.ny, lat.origin);
  const ny = lat.ny, nx = g.nx, nz = g.nz, layer = nx * nz;
  const ncx = Math.ceil(nx / CS), ncz = Math.ceil(nz / CS);
  const [r0, r1] = rows ?? [0, ncz];
  for (let cz = r0; cz < Math.min(r1, ncz); cz++)
    for (let cx = 0; cx < ncx; cx++) {
      let c: MapChunk | null = null;
      let any = false;
      const iw = Math.min(CS, nx - cx * CS), kw = Math.min(CS, nz - cz * CS);
      // Scan first (most chunks of a fresh map are empty): allocate only when needed.
      for (let lz = 0; lz < kw && !any; lz++) {
        const k = cz * CS + lz;
        for (let lx = 0; lx < iw; lx++)
          if (g.observed[k * nx + cx * CS + lx]) {
            any = true;
            break;
          }
      }
      for (let j = 0; j < ny && !any; j++) {
        const base = (j + FLOOR_LAYERS_BELOW) * layer;
        for (let lz = 0; lz < kw && !any; lz++) {
          const row = base + (cz * CS + lz) * nx + cx * CS;
          for (let lx = 0; lx < iw; lx++)
            if (g.data[row + lx] !== 0) {
              any = true;
              break;
            }
        }
      }
      const key = chunkKey(cx, cz);
      if (!any) {
        out.chunks.delete(key);
        continue;
      }
      c = out.chunks.get(key) ?? newChunk(cx, cz, ny);
      if (c.occ.length !== CS2 * ny) c = newChunk(cx, cz, ny);
      let under = false, top = false;
      for (let j = 0; j < ny; j++) {
        const base = (j + FLOOR_LAYERS_BELOW) * layer;
        for (let lz = 0; lz < CS; lz++) {
          const dst = (j * CS + lz) * CS;
          if (lz >= kw) {
            c.occ.fill(0, dst, dst + CS);
            continue;
          }
          const row = base + (cz * CS + lz) * nx + cx * CS;
          c.occ.set(g.data.subarray(row, row + iw), dst);
          if (iw < CS) c.occ.fill(0, dst + iw, dst + CS);
          for (let lx = 0; lx < iw; lx++) {
            if (g.underside[row + lx]) under = true;
            if (g.topFrac[row + lx] !== 255) top = true;
          }
        }
      }
      if (under || top) {
        const U = under ? (c.underside && c.underside.length === CS2 * ny ? c.underside : new Uint8Array(CS2 * ny)) : null;
        const T = top ? (c.topFrac && c.topFrac.length === CS2 * ny ? c.topFrac : new Uint8Array(CS2 * ny)) : null;
        U?.fill(0);
        T?.fill(255);
        for (let j = 0; j < ny; j++) {
          const base = (j + FLOOR_LAYERS_BELOW) * layer;
          for (let lz = 0; lz < kw; lz++) {
            const row = base + (cz * CS + lz) * nx + cx * CS, dst = (j * CS + lz) * CS;
            if (U) U.set(g.underside.subarray(row, row + iw), dst);
            if (T) T.set(g.topFrac.subarray(row, row + iw), dst);
          }
        }
        c.underside = U;
        c.topFrac = T;
      } else {
        c.underside = null;
        c.topFrac = null;
      }
      for (let lz = 0; lz < CS; lz++)
        for (let lx = 0; lx < CS; lx++) c.observed[lz * CS + lx] = lz < kw && lx < iw ? g.observed[(cz * CS + lz) * nx + cx * CS + lx] : 0;
      out.chunks.set(key, c);
    }
  return out;
}

/**
 * Replace the live grid's above-floor contents with `m` (on the live lattice:
 * chunk (cx, cz) covers grid columns [cx·CS, cx·CS+CS)). The below-floor
 * layers and transient obstacles are kept.
 */
export function importLive(world: WorldModel, m: ChunkedMap): boolean {
  const g = world.grid;
  if (!g) return false;
  const lat = liveLattice(world)!;
  if (Math.abs(m.res - lat.res) > 1e-9 || Math.abs(m.origin.x - lat.origin.x) > 1e-6 || Math.abs(m.origin.z - lat.origin.z) > 1e-6) return false;
  const ny = Math.min(lat.ny, m.ny), nx = g.nx, nz = g.nz, layer = nx * nz;
  g.data.fill(0, FLOOR_LAYERS_BELOW * layer);
  g.underside.fill(0, FLOOR_LAYERS_BELOW * layer);
  g.topFrac.fill(255, FLOOR_LAYERS_BELOW * layer);
  g.observed.fill(0);
  for (const c of m.chunks.values()) {
    if (c.cx < 0 || c.cz < 0 || c.cx * CS >= nx || c.cz * CS >= nz) continue;
    const iw = Math.min(CS, nx - c.cx * CS), kw = Math.min(CS, nz - c.cz * CS);
    for (let j = 0; j < ny; j++) {
      const base = (j + FLOOR_LAYERS_BELOW) * layer;
      for (let lz = 0; lz < kw; lz++) {
        const row = base + (c.cz * CS + lz) * nx + c.cx * CS, src = (j * CS + lz) * CS;
        g.data.set(c.occ.subarray(src, src + iw), row);
        if (c.underside) g.underside.set(c.underside.subarray(src, src + iw), row);
        if (c.topFrac) g.topFrac.set(c.topFrac.subarray(src, src + iw), row);
      }
    }
    for (let lz = 0; lz < kw; lz++)
      for (let lx = 0; lx < iw; lx++) if (c.observed[lz * CS + lx]) g.observed[(c.cz * CS + lz) * nx + c.cx * CS + lx] = 1;
  }
  g.touchAll();
  g.version++;
  return true;
}

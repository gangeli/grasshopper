import { FLOOR_LAYERS_BELOW, type WorldModel } from '../WorldModel';
import { VoxelGrid } from '../VoxelGrid';
import { CHUNK, type Lattice } from '../mapIO';
import { chunkKey as storeKey, keyCx as storeCx, keyCz as storeCz, type ChunkStore } from '../ChunkStore';
import { CS, CS2, chunkKey, emptyMap, newChunk, type ChunkedMap, type MapChunk } from './ChunkedMap';
import { fromSerialized } from './mapFormatBridge';

/**
 * Bridge between the live WorldModel and the persistence layer's ChunkedMap.
 *
 * The live map is a dense window that follows the camera plus an archive of
 * the chunks outside it (ChunkStore), both on one lattice fixed for the
 * session. The persistence layer sees the union, on that session lattice:
 * window moves are not map changes.
 *
 * exportLive: the above-floor layers of the window and the archive (origin =
 * lattice origin, y = floor height), so export/import is exact.
 * importLive: replace the above-floor contents of the whole live map with a
 * map on that same lattice (chunks that are missing become unknown). It must
 * *replace* exactly (an undo has to turn restored voxels back into
 * "unknown"); importMap's 'replace' mode never writes unknown (0) values, so
 * this writes the grid and the archive directly — see the interface notes
 * in docs/map-persistence.md. Snapshots copy the window in slices;
 * exportMap() (via mapFormatBridge) is the one-shot alternative.
 */
export interface LiveLattice {
  res: number;
  ny: number;
  /** Session lattice anchor (map frame; y = floor height). */
  origin: { x: number; y: number; z: number };
  /** Window size in columns. */
  nx: number;
  nz: number;
  /** Window position on the lattice (columns; multiples of the chunk size). */
  oi: number;
  ok: number;
}

/** The world's window lattice (session-fixed origin and the window offset). */
function windowOf(world: WorldModel): Lattice | null {
  const g = world.grid;
  if (!g) return null;
  // WorldModel keeps this private (its lattice()); read it through the
  // index escape hatch rather than re-deriving it. Older world models
  // without a moving window: the grid origin is the lattice.
  const f = (world as unknown as { lattice?: () => Lattice })['lattice'];
  if (typeof f === 'function') return f.call(world);
  return { originX: g.origin.x, originY: g.origin.y, originZ: g.origin.z, oi: 0, ok: 0 };
}

function archiveOf(world: WorldModel): ChunkStore | null {
  return world.archive ?? null;
}

export function liveLattice(world: WorldModel): LiveLattice | null {
  const g = world.grid, w = windowOf(world);
  if (!g || !w) return null;
  return { res: g.res, ny: g.ny - FLOOR_LAYERS_BELOW, origin: { x: w.originX, y: world.floorY, z: w.originZ }, nx: g.nx, nz: g.nz, oi: w.oi, ok: w.ok };
}

/** Anything grid-shaped whose cell (0, ·, 0) is lattice column (gi0, gk0). */
interface Src {
  nx: number;
  nz: number;
  data: Int8Array;
  observed: Uint8Array;
  underside: Uint8Array;
  topFrac: Uint8Array;
}

/**
 * Copy session chunk (cx, cz) out of grid g (cell 0 = lattice (gi0, gk0));
 * returns null when it holds nothing above the floor. Reuses `reuse`.
 */
function chunkFromGrid(g: Src, gi0: number, gk0: number, cx: number, cz: number, ny: number, reuse?: MapChunk): MapChunk | null {
  const nx = g.nx, layer = nx * g.nz;
  const bi = cx * CS - gi0, bk = cz * CS - gk0;
  const i0 = Math.max(0, -bi), i1 = Math.min(CS, nx - bi), k0 = Math.max(0, -bk), k1 = Math.min(CS, g.nz - bk);
  if (i1 <= i0 || k1 <= k0) return null;
  // Scan first (most chunks of a fresh map are empty): allocate only when needed.
  let any = false;
  for (let lz = k0; lz < k1 && !any; lz++) {
    const row = (bk + lz) * nx + bi;
    for (let lx = i0; lx < i1; lx++)
      if (g.observed[row + lx]) {
        any = true;
        break;
      }
  }
  for (let j = 0; j < ny && !any; j++) {
    const base = (j + FLOOR_LAYERS_BELOW) * layer;
    for (let lz = k0; lz < k1 && !any; lz++) {
      const row = base + (bk + lz) * nx + bi;
      for (let lx = i0; lx < i1; lx++)
        if (g.data[row + lx] !== 0) {
          any = true;
          break;
        }
    }
  }
  if (!any) return null;
  let c = reuse && reuse.occ.length === CS2 * ny ? reuse : newChunk(cx, cz, ny);
  c.cx = cx;
  c.cz = cz;
  const full = i0 === 0 && i1 === CS;
  if (!full || k0 > 0 || k1 < CS) c.occ.fill(0);
  let under = false, top = false;
  for (let j = 0; j < ny; j++) {
    const base = (j + FLOOR_LAYERS_BELOW) * layer;
    for (let lz = k0; lz < k1; lz++) {
      const row = base + (bk + lz) * nx + bi, dst = (j * CS + lz) * CS;
      c.occ.set(g.data.subarray(row + i0, row + i1), dst + i0);
      if (!under || !top)
        for (let lx = i0; lx < i1; lx++) {
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
      for (let lz = k0; lz < k1; lz++) {
        const row = base + (bk + lz) * nx + bi, dst = (j * CS + lz) * CS;
        if (U) U.set(g.underside.subarray(row + i0, row + i1), dst + i0);
        if (T) T.set(g.topFrac.subarray(row + i0, row + i1), dst + i0);
      }
    }
    c.underside = U;
    c.topFrac = T;
  } else {
    c.underside = null;
    c.topFrac = null;
  }
  c.observed.fill(0);
  for (let lz = k0; lz < k1; lz++) for (let lx = i0; lx < i1; lx++) c.observed[lz * CS + lx] = g.observed[(bk + lz) * nx + bi + lx];
  return c;
}

/** Write session chunk (cx, cz) into grid g (cell 0 = lattice (gi0, gk0)); null clears it to unknown. */
function chunkIntoGrid(g: Src, gi0: number, gk0: number, cx: number, cz: number, ny: number, c: MapChunk | null): void {
  const nx = g.nx, layer = nx * g.nz;
  const bi = cx * CS - gi0, bk = cz * CS - gk0;
  const i0 = Math.max(0, -bi), i1 = Math.min(CS, nx - bi), k0 = Math.max(0, -bk), k1 = Math.min(CS, g.nz - bk);
  if (i1 <= i0 || k1 <= k0) return;
  const cny = c ? Math.min(ny, c.occ.length / CS2) : 0;
  for (let j = 0; j < ny; j++) {
    const base = (j + FLOOR_LAYERS_BELOW) * layer;
    for (let lz = k0; lz < k1; lz++) {
      const row = base + (bk + lz) * nx + bi, src = (j * CS + lz) * CS;
      if (c && j < cny) {
        g.data.set(c.occ.subarray(src + i0, src + i1), row + i0);
        if (c.underside) g.underside.set(c.underside.subarray(src + i0, src + i1), row + i0);
        else g.underside.fill(0, row + i0, row + i1);
        if (c.topFrac) g.topFrac.set(c.topFrac.subarray(src + i0, src + i1), row + i0);
        else g.topFrac.fill(255, row + i0, row + i1);
      } else {
        g.data.fill(0, row + i0, row + i1);
        g.underside.fill(0, row + i0, row + i1);
        g.topFrac.fill(255, row + i0, row + i1);
      }
    }
  }
  for (let lz = k0; lz < k1; lz++)
    for (let lx = i0; lx < i1; lx++) g.observed[(bk + lz) * nx + bi + lx] = c ? c.observed[lz * CS + lx] : 0;
}

/** Window chunk range in session chunk coordinates: [cx0, cx1) × [cz0, cz1). */
function windowChunks(lat: LiveLattice) {
  return { cx0: lat.oi / CS, cz0: lat.ok / CS, cx1: (lat.oi + lat.nx) / CS, cz1: (lat.ok + lat.nz) / CS };
}

/** Archive chunks (store coordinates) that are not (entirely) covered by the window. */
function archivedOutside(store: ChunkStore, lat: LiveLattice): number[] {
  const keys: number[] = [];
  const C = CHUNK;
  for (const key of store.map.keys()) {
    const ax = storeCx(key), az = storeCz(key);
    if (ax * C >= lat.oi && (ax + 1) * C <= lat.oi + lat.nx && az * C >= lat.ok && (az + 1) * C <= lat.ok + lat.nz) continue;
    keys.push(key);
  }
  return keys;
}

/** A scratch grid of one archive chunk (full height, below-floor layers solid). */
function chunkGrid(world: WorldModel): VoxelGrid {
  const g = world.grid!;
  const t = new VoxelGrid({ origin: g.origin, res: g.res, nx: CHUNK, ny: g.ny, nz: CHUNK });
  t.data.fill(127, 0, FLOOR_LAYERS_BELOW * CHUNK * CHUNK);
  return t;
}

function clearChunkGrid(t: VoxelGrid) {
  const L = CHUNK * CHUNK;
  t.data.fill(127, 0, FLOOR_LAYERS_BELOW * L);
  t.data.fill(0, FLOOR_LAYERS_BELOW * L);
  t.observed.fill(0);
  t.underside.fill(0);
  t.topFrac.fill(255);
  t.hitTime?.fill(0);
}

/** Add archive chunk `key` (outside the window) to `out`. */
function exportArchived(world: WorldModel, store: ChunkStore, key: number, lat: LiveLattice, out: ChunkedMap, tmp: VoxelGrid) {
  const ax = storeCx(key), az = storeCz(key), C = CHUNK, r = CHUNK / CS;
  clearChunkGrid(tmp);
  tmp.origin.y = world.grid!.origin.y;
  if (!store.loadInto(tmp, ax * C, az * C, ax, az, world.floorLayer)) return;
  const w = windowChunks(lat);
  for (let a = 0; a < r; a++)
    for (let b = 0; b < r; b++) {
      const cx = ax * r + a, cz = az * r + b;
      if (cx >= w.cx0 && cx < w.cx1 && cz >= w.cz0 && cz < w.cz1) continue;
      const c = chunkFromGrid(tmp, ax * C, az * C, cx, cz, lat.ny);
      if (c) out.chunks.set(chunkKey(cx, cz), c);
    }
}

/**
 * Copy the live map into a ChunkedMap. `rows` limits the export to window
 * chunk rows [r0, r1) (and skips the archive) so callers can spread the work
 * over frames.
 */
export function exportLive(world: WorldModel, into?: ChunkedMap, rows?: [number, number]): ChunkedMap | null {
  const g = world.grid;
  if (!g) return null;
  if (!rows) world.loadPending?.();
  const lat = liveLattice(world)!;
  const out = into ?? emptyMap(lat.res, lat.ny, lat.origin);
  const w = windowChunks(lat);
  const ncx = w.cx1 - w.cx0, ncz = w.cz1 - w.cz0;
  const [r0, r1] = rows ?? [0, ncz];
  for (let lz = r0; lz < Math.min(r1, ncz); lz++)
    for (let lx = 0; lx < ncx; lx++) {
      const cx = w.cx0 + lx, cz = w.cz0 + lz, key = chunkKey(cx, cz);
      const c = chunkFromGrid(g, lat.oi, lat.ok, cx, cz, lat.ny, out.chunks.get(key));
      if (c) out.chunks.set(key, c);
      else out.chunks.delete(key);
    }
  const store = archiveOf(world);
  if (!rows && store && store.size) {
    const tmp = chunkGrid(world);
    for (const key of archivedOutside(store, lat)) exportArchived(world, store, key, lat, out, tmp);
  }
  return out;
}

/** Number of live map columns with observed floor (window: one pass over the column mask; archive: cached per chunk). */
export function liveObservedColumns(world: WorldModel): number {
  const o = world.grid?.observed;
  if (!o) return 0;
  let n = 0;
  for (let q = 0; q < o.length; q++) n += o[q];
  const store = archiveOf(world), lat = liveLattice(world);
  if (store && lat && store.size) {
    const C = CHUNK;
    for (const [key, c] of store.map) {
      const ax = storeCx(key), az = storeCz(key);
      // Window chunks are counted from the grid (archived copies of them are older).
      const i0 = ax * C - lat.oi, k0 = az * C - lat.ok;
      const inside = i0 >= 0 && k0 >= 0 && i0 + C <= lat.nx && k0 + C <= lat.nz;
      if (inside) continue;
      let m = obsCount.get(c.observed);
      if (m === undefined || obsStamp.get(c.observed) !== c.t) {
        m = 0;
        for (let q = 0; q < c.observed.length; q++) m += c.observed[q];
        obsCount.set(c.observed, m);
        obsStamp.set(c.observed, c.t);
      }
      n += m;
    }
  }
  return n;
}
const obsCount = new WeakMap<Uint8Array, number>();
const obsStamp = new WeakMap<Uint8Array, number>();

/** exportLive in slices (a couple of window chunk rows per step, then a few archive chunks per step). */
export function* exportLiveGen(world: WorldModel, rowsPerStep = 2): Generator<void, ChunkedMap | null, void> {
  // Snapshots are taken often, from the page's frame loop: copy the grid a
  // couple of chunk rows per step. world.exportMap() (MapFormat, lossless via
  // mapFormatBridge) gives the same map but in one go (~50ms for a 12m grid on
  // a laptop, several frames' worth on a phone); it is used when slicing is
  // asked off (rowsPerStep <= 0) — see the interface notes in
  // docs/map-persistence.md (an incremental / dirty-chunk export would let
  // snapshots go through it too).
  if (rowsPerStep <= 0 && typeof world.exportMap === 'function') {
    const m = world.exportMap();
    if (!m) return null;
    yield;
    return fromSerialized(m);
  }
  // The window may move (or the world rebuild its grid) meanwhile: start over
  // a few times, then give up (the caller retries).
  for (let attempt = 0; attempt < 4; attempt++) {
    const g = world.grid;
    if (!g) return null;
    world.loadPending?.();
    const lat = liveLattice(world)!;
    const out = emptyMap(lat.res, lat.ny, lat.origin);
    const ncz = Math.ceil(g.nz / CS);
    let moved = false;
    for (let r = 0; r < ncz && !moved; r += rowsPerStep) {
      exportLive(world, out, [r, r + rowsPerStep]);
      yield;
      moved = world.grid !== g;
    }
    if (moved) continue;
    const store = archiveOf(world);
    if (store && store.size) {
      // Chunks archived meanwhile were exported from the window already
      // (the window only gives chunks away when it moves, and then we restart).
      const tmp = chunkGrid(world);
      const keys = archivedOutside(store, lat);
      for (let q = 0; q < keys.length && !moved; q++) {
        if (store.map.has(keys[q])) exportArchived(world, store, keys[q], lat, out, tmp);
        if (q % 8 === 7) {
          yield;
          moved = world.grid !== g;
        }
      }
      if (moved) continue;
    }
    // Pending archive loads that arrived during the export: merged since,
    // so what we copied may lack them — start over (rare: only after a move).
    return out;
  }
  return null;
}

/**
 * Replace the live map's above-floor contents (window and archive) with `m`
 * (on the session lattice: chunk (cx, cz) covers lattice columns
 * [cx·CS, cx·CS+CS)). The below-floor layers and transient obstacles are kept.
 */
export function importLive(world: WorldModel, m: ChunkedMap): boolean {
  const g = world.grid;
  if (!g) return false;
  const lat = liveLattice(world)!;
  if (Math.abs(m.res - lat.res) > 1e-9 || Math.abs(m.origin.x - lat.origin.x) > 1e-6 || Math.abs(m.origin.z - lat.origin.z) > 1e-6) return false;
  // Archived chunks waiting to come back into the window would fill in what
  // this import clears: merge them first. (Also works around a world-model
  // bug where a chunk leaving the window again before its pending load was
  // merged is deleted from the archive; once moveWindow handles that, only
  // the first reason remains — see docs/map-persistence.md, interface note 8.)
  world.loadPending?.();
  const ny = Math.min(lat.ny, m.ny), nx = g.nx, nz = g.nz, layer = nx * nz;
  // Voxels whose value changes lose their hit time: they are no longer what
  // the session observed then, and a loop-closure warp (WorldModel.warpSince)
  // must not move restored voxels as if they had been.
  const old = g.hitTime ? g.data.slice(FLOOR_LAYERS_BELOW * layer) : null;
  g.data.fill(0, FLOOR_LAYERS_BELOW * layer);
  g.underside.fill(0, FLOOR_LAYERS_BELOW * layer);
  g.topFrac.fill(255, FLOOR_LAYERS_BELOW * layer);
  g.observed.fill(0);
  const w = windowChunks(lat);
  const outside = new Set<number>();
  const r = CHUNK / CS;
  for (const c of m.chunks.values()) {
    if (c.cx >= w.cx0 && c.cx < w.cx1 && c.cz >= w.cz0 && c.cz < w.cz1) chunkIntoGrid(g, lat.oi, lat.ok, c.cx, c.cz, ny, c);
    else outside.add(storeKey(Math.floor(c.cx / r), Math.floor(c.cz / r)));
  }
  if (old && g.hitTime) {
    const h = g.hitTime, d = g.data, o0 = FLOOR_LAYERS_BELOW * layer;
    for (let q = 0; q < old.length; q++) if (d[o0 + q] !== old[q]) h[o0 + q] = 0;
  }
  g.touchAll();
  g.version++;
  // The archive: chunks the map covers or that hold something now (outside the window).
  const store = archiveOf(world);
  if (store) {
    for (const key of archivedOutside(store, lat)) outside.add(key);
    if (outside.size) {
      const tmp = chunkGrid(world);
      tmp.hitTime = new Uint32Array(tmp.data.length);
      const C = CHUNK, fl = world.floorLayer;
      const before = new Int8Array(tmp.data.length), beforeObs = new Uint8Array(tmp.observed.length);
      for (const key of outside) {
        const ax = storeCx(key), az = storeCz(key);
        clearChunkGrid(tmp);
        const had = store.loadInto(tmp, ax * C, az * C, ax, az, fl);
        before.set(tmp.data);
        beforeObs.set(tmp.observed);
        for (let a = 0; a < r; a++)
          for (let b = 0; b < r; b++) {
            const cx = ax * r + a, cz = az * r + b;
            if (cx >= w.cx0 && cx < w.cx1 && cz >= w.cz0 && cz < w.cz1) continue;
            chunkIntoGrid(tmp, ax * C, az * C, cx, cz, ny, m.chunks.get(chunkKey(cx, cz)) ?? null);
          }
        // Untouched chunks keep their stored copy (and hit times); changed voxels lose theirs.
        let same = true;
        for (let q = FLOOR_LAYERS_BELOW * C * C; q < before.length; q++)
          if (before[q] !== tmp.data[q]) {
            same = false;
            tmp.hitTime[q] = 0;
          }
        for (let q = 0; q < beforeObs.length && same; q++) if (beforeObs[q] !== tmp.observed[q]) same = false;
        if (same && (had || !tmp.observed.some((v) => v))) continue;
        store.saveFrom(tmp, ax * C, az * C, ax, az, fl, world.now);
      }
    }
  }
  return true;
}

/**
 * What MapMemory needs from the live map, so it can run next to the world
 * model (WorldSource) or in a worker fed with snapshots (memoryWorker.ts).
 */
export interface LiveStamp {
  /** Identity of the live map (changes when the world model rebuilds it; not when the window moves). */
  grid: number;
  epoch: number;
  hard: number;
  soft: number;
  /** relevel + realign recoveries. */
  other: number;
}

export function sameStamp(a: LiveStamp, b: LiveStamp): boolean {
  return a.grid === b.grid && a.epoch === b.epoch && a.hard === b.hard && a.soft === b.soft && a.other === b.other;
}

export interface LiveSource {
  readonly ready: boolean;
  /** Waiting for another thread (a snapshot or an import): don't spin. */
  readonly waiting?: boolean;
  lattice(): LiveLattice | null;
  stamp(): LiveStamp;
  /** Columns with observed floor (cheap). */
  observedColumns(): number;
  /** A snapshot of the live map (sliced). */
  exportGen(): Generator<void, ChunkedMap | null, void>;
  /** Replace the live map's contents, if the live map is still `expectGrid`. */
  importGen(m: ChunkedMap, expectGrid: number): Generator<void, boolean, void>;
}

const gridIds = new WeakMap<object, number>();
let nextGridId = 1;
export function gridId(g: object | null): number {
  if (!g) return 0;
  let id = gridIds.get(g);
  if (!id) gridIds.set(g, (id = nextGridId++));
  return id;
}

/** Times the world rebuilt its map (epochs that weren't window moves). */
function rebuilds(world: WorldModel): number {
  return world.epoch - (world.recenters ?? 0);
}

/**
 * Identity of the live map: stable while the window moves, new when the
 * world model rebuilds it (or, for a world model without a window, when it
 * replaces its grid).
 */
export function liveId(world: WorldModel): number {
  if (!world.grid) return 0;
  const store = archiveOf(world);
  if (!store) return gridId(world.grid);
  return gridId(store) * 4096 + (rebuilds(world) & 4095);
}

export function worldStamp(world: WorldModel): LiveStamp {
  const r = world.recoveries;
  return { grid: liveId(world), epoch: rebuilds(world), hard: r.hard, soft: r.soft, other: r.relevel + r.realign };
}

/** The live map of a WorldModel in this thread. */
export class WorldSource implements LiveSource {
  constructor(readonly world: WorldModel) {}
  get ready(): boolean {
    return !!this.world.grid;
  }
  lattice() {
    return liveLattice(this.world);
  }
  stamp() {
    return worldStamp(this.world);
  }
  observedColumns() {
    return liveObservedColumns(this.world);
  }
  exportGen() {
    return exportLiveGen(this.world);
  }
  *importGen(m: ChunkedMap, expectGrid: number): Generator<void, boolean, void> {
    if (liveId(this.world) !== expectGrid) return false;
    return importLive(this.world, m);
  }
}


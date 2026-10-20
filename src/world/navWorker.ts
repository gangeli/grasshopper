import { computeNav, type NavScratch } from './NavGrid';
import { VoxelGrid } from './VoxelGrid';
import { occluderPositions } from './occluderMesh';
import type { NavBuildRequest, NavBuildResponse, OccluderRequest, OccluderResponse } from './NavWorkerClient';

/**
 * Nav-graph builds off the main thread: the main thread posts a copy of the
 * occupancy grid (transferred buffers), this worker runs exactly the same
 * build (computeNav) on it and transfers the graph, the shadow mask and the
 * grid buffers back (the client reuses them for the next request).
 */
const scratch: NavScratch = { colMask: null };

const ctx = self as unknown as { onmessage: ((e: MessageEvent<NavBuildRequest | OccluderRequest>) => void) | null; postMessage(m: unknown, transfer?: Transferable[]): void };
const none = new Uint8Array(0);

ctx.onmessage = (e) => {
  if (e.data.kind === 'occ') return occluder(e.data);
  const q = e.data;
  try {
    const g = new VoxelGrid({ origin: q.origin, res: q.res, nx: q.nx, ny: q.ny, nz: q.nz }, { data: q.data, observed: q.observed, underside: q.underside, topFrac: q.topFrac });
    g.version = q.version;
    g.now = q.now;
    g.loadTransient(q.transient);
    if (q.shadow) g.adoptShadow(q.shadow, -1);
    const colStart = new Int32Array(q.nx * q.nz), colCount = new Uint8Array(q.nx * q.nz);
    const res = computeNav(g, q.world, q.params, colStart, colCount, scratch, q.stale);
    const shadow = g.shadow!;
    const out: NavBuildResponse = { kind: 'nav', id: q.id, ok: true, res, shadow, data: q.data, observed: q.observed, underside: q.underside, topFrac: q.topFrac };
    const transfer = [res.ni, res.nk, res.ny, res.headroom, res.wallDist, res.edgeFlag, res.colStart, res.colCount, shadow, q.data, q.observed, q.underside, q.topFrac].map((a) => a.buffer as ArrayBuffer);
    ctx.postMessage(out, [...new Set(transfer)]);
  } catch (err) {
    ctx.postMessage({ kind: 'nav', id: q.id, ok: false, error: String(err) } satisfies Partial<NavBuildResponse>);
  }
};

/** Occluder mesh for a region of the grid (only the occupancy is sent). */
function occluder(q: OccluderRequest) {
  try {
    const g = new VoxelGrid({ origin: q.origin, res: q.res, nx: q.nx, ny: q.ny, nz: q.nz }, { data: q.data, observed: none, underside: none, topFrac: none });
    const positions = occluderPositions(g, q.center, q.radius, q.minLayer);
    const out: OccluderResponse = { kind: 'occ', id: q.id, ok: true, positions, data: q.data };
    ctx.postMessage(out, [positions.buffer as ArrayBuffer, q.data.buffer as ArrayBuffer]);
  } catch (err) {
    ctx.postMessage({ kind: 'occ', id: q.id, ok: false, error: String(err) } satisfies Partial<OccluderResponse>);
  }
}

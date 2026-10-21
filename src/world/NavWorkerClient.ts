import { freeRuleOn, NavGrid, staleColumnsFor, type NavArrays, type NavParams, type NavWorldInfo } from './NavGrid';
import type { VoxelGrid } from './VoxelGrid';

/**
 * Main-thread side of the nav worker (see navWorker.ts). Installed as
 * NavGrid.background in the browser: routine nav refreshes (every couple of
 * seconds while the map grows) no longer stall the frame loop for a full
 * graph build (~100ms on a laptop, several times that on a phone); the frame
 * that asks only copies the grid (a few MB, memcpy) into buffers that
 * shuttle back and forth between the threads.
 *
 * The graph arrives a few frames later and is installed if nothing newer
 * replaced it meanwhile. Forced refreshes (placing the pet, starting a
 * round, map rebuilds) stay synchronous, as do node and the tests.
 */
export interface NavBuildRequest {
  kind: 'nav';
  id: number;
  origin: { x: number; y: number; z: number };
  res: number;
  nx: number;
  ny: number;
  nz: number;
  version: number;
  now: number;
  data: Int8Array;
  observed: Uint8Array;
  underside: Uint8Array;
  topFrac: Uint8Array;
  /** A spare buffer for the shadow mask (the one the previous result replaced), or null. */
  shadow: Uint8Array | null;
  /** Dynamic obstacles as [cell, expiry, cell, expiry, ...]. */
  transient: Float64Array;
  /** Columns with stale structure at body height (NavParams.staleMargin), or null. */
  stale: Uint8Array | null;
  world: NavWorldInfo;
  params: NavParams;
}

export interface NavBuildResponse {
  kind: 'nav';
  id: number;
  ok: boolean;
  error?: string;
  res: NavArrays;
  shadow: Uint8Array;
  data: Int8Array;
  observed: Uint8Array;
  underside: Uint8Array;
  topFrac: Uint8Array;
}

export interface OccluderRequest {
  kind: 'occ';
  id: number;
  origin: { x: number; y: number; z: number };
  res: number;
  nx: number;
  ny: number;
  nz: number;
  data: Int8Array;
  center: { x: number; y: number; z: number };
  radius: number;
  minLayer: number;
}

export interface OccluderResponse {
  kind: 'occ';
  id: number;
  ok: boolean;
  error?: string;
  positions: Float32Array;
  data: Int8Array;
}

type OccDone = (positions: Float32Array, grid: VoxelGrid, version: number, center: { x: number; y: number; z: number }) => void;

type Pending = { id: number; nav: NavGrid; grid: VoxelGrid; version: number; syncBuilds: number; t0: number };

export class NavWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending: Pending | null = null;
  private spare: { data?: Int8Array; observed?: Uint8Array; underside?: Uint8Array; topFrac?: Uint8Array; shadow?: Uint8Array } = {};
  private failed = false;
  /** Diagnostics: builds done in the worker, results dropped as stale, last round trip (ms). */
  stats = { builds: 0, stale: 0, lastMs: 0, copyMs: 0, errors: 0 };
  /** Called after a background result was installed. */
  onInstalled: ((nav: NavGrid) => void) | null = null;

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('./navWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<NavBuildResponse | OccluderResponse>) => (e.data.kind === 'occ' ? this.receiveOccluder(e.data) : this.receive(e.data));
    this.worker.onerror = () => {
      // A worker that can't start (old browser, CSP): fall back to synchronous builds.
      this.failed = true;
      this.pending = null;
      this.occPending = null;
      this.stats.errors++;
    };
  }

  private occPending: { id: number; grid: VoxelGrid; version: number; center: { x: number; y: number; z: number }; done: OccDone } | null = null;
  private occSpare: Int8Array | null = null;

  /**
   * Build the occluder mesh around `center` in the worker; `done` gets it
   * when ready. False if the worker isn't available (build it here instead).
   */
  requestOccluder(g: VoxelGrid, center: { x: number; y: number; z: number }, radius: number, minLayer: number, done: OccDone): boolean {
    if (this.failed) return false;
    if (this.occPending) return true;
    const s = this.occSpare && this.occSpare.length === g.data.length ? this.occSpare : null;
    this.occSpare = null;
    const data = s ? (s.set(g.data), s) : g.data.slice();
    const req: OccluderRequest = { kind: 'occ', id: this.nextId++, origin: { ...g.origin }, res: g.res, nx: g.nx, ny: g.ny, nz: g.nz, data, center: { ...center }, radius, minLayer };
    try {
      this.worker.postMessage(req, [data.buffer as ArrayBuffer]);
    } catch {
      this.failed = true;
      return false;
    }
    this.occPending = { id: req.id, grid: g, version: g.version, center: { ...center }, done };
    return true;
  }

  private receiveOccluder(m: OccluderResponse) {
    const p = this.occPending;
    if (!p || p.id !== m.id) return;
    this.occPending = null;
    if (!m.ok) {
      this.stats.errors++;
      this.failed = true;
      return;
    }
    this.occSpare = m.data;
    p.done(m.positions, p.grid, p.version, p.center);
  }

  /** NavGrid.background hook: true if the build was handed off (or one is already running). */
  request(nav: NavGrid): boolean {
    if (this.failed) return false;
    if (this.pending) return true; // the running build will be followed by a fresh refresh
    const g = nav.g;
    const t0 = performance.now();
    const take = <A extends Int8Array | Uint8Array>(src: A, key: 'data' | 'observed' | 'underside' | 'topFrac'): A => {
      const s = this.spare[key] as A | undefined;
      this.spare[key] = undefined;
      if (s && s.length === src.length) {
        s.set(src);
        return s;
      }
      return src.slice() as A;
    };
    const tr: number[] = [];
    for (const [n, until] of g.transientEntries()) tr.push(n, until);
    const shadow = this.spare.shadow && this.spare.shadow.length === g.data.length ? this.spare.shadow : null;
    this.spare.shadow = undefined;
    const req: NavBuildRequest = {
      kind: 'nav',
      id: this.nextId++,
      origin: { ...g.origin },
      res: g.res,
      nx: g.nx,
      ny: g.ny,
      nz: g.nz,
      version: g.version,
      now: g.now,
      data: take(g.data, 'data'),
      observed: take(g.observed, 'observed'),
      underside: take(g.underside, 'underside'),
      topFrac: take(g.topFrac, 'topFrac'),
      shadow,
      transient: Float64Array.from(tr),
      stale: (nav.p.staleMargin > 0 || freeRuleOn(nav.p)) && g.hitTime ? staleColumnsFor(g, nav.world, nav.p) : null,
      world: { floorLayer: nav.world.floorLayer, floorY: nav.world.floorY, depthPoints: nav.world.depthPoints },
      params: { ...nav.p },
    };
    const transfer: Transferable[] = [req.data.buffer, req.observed.buffer, req.underside.buffer, req.topFrac.buffer, req.transient.buffer] as ArrayBuffer[];
    if (shadow) transfer.push(shadow.buffer as ArrayBuffer);
    if (req.stale) transfer.push(req.stale.buffer as ArrayBuffer);
    try {
      this.worker.postMessage(req, transfer);
    } catch {
      this.failed = true;
      return false;
    }
    this.stats.copyMs = performance.now() - t0;
    this.pending = { id: req.id, nav, grid: g, version: g.version, syncBuilds: nav.syncBuilds, t0 };
    return true;
  }

  private receive(m: NavBuildResponse) {
    const p = this.pending;
    if (!p || p.id !== m.id) return;
    this.pending = null;
    if (!m.ok) {
      this.stats.errors++;
      this.failed = true;
      return;
    }
    // Keep the grid buffers for the next request.
    this.spare.data = m.data;
    this.spare.observed = m.observed;
    this.spare.underside = m.underside;
    this.spare.topFrac = m.topFrac;
    this.stats.lastMs = performance.now() - p.t0;
    const nav = p.nav;
    // Stale: the map was replaced, or a synchronous build ran meanwhile.
    if (nav.g !== p.grid || nav.syncBuilds !== p.syncBuilds || nav.builtVersion > p.version) {
      this.stats.stale++;
      this.spare.shadow = m.shadow;
      return;
    }
    const g = nav.g;
    // The shadow mask the build used becomes the grid's (as a synchronous
    // build's updateShadow() would have left it); the one it replaces is
    // the spare for the next request.
    const old = g.shadow;
    g.adoptShadow(m.shadow, p.version);
    if (old && old !== m.shadow) this.spare.shadow = old;
    nav.adopt(m.res, p.version);
    // Expired dynamic obstacles the build looked at: expire them here too.
    for (const n of m.res.expired) g.isTransient(n);
    this.stats.builds++;
    this.onInstalled?.(nav);
  }

  dispose() {
    this.worker.terminate();
    if (NavGrid.background === this) NavGrid.background = null;
  }
}

/** Use the nav worker for routine refreshes (browser only; ?navworker=0 disables). */
export function installNavWorker(): NavWorkerClient | null {
  if (typeof Worker === 'undefined') return null;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('navworker') === '0') return null;
  try {
    const c = new NavWorkerClient();
    NavGrid.background = c;
    active = c;
    return c;
  } catch {
    return null;
  }
}

let active: NavWorkerClient | null = null;
/** The installed worker client (null in node / when disabled). */
export function activeNavWorker(): NavWorkerClient | null {
  return active;
}

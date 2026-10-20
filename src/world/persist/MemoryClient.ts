import type { WorldModel } from '../WorldModel';
import type { ChunkedMap } from './ChunkedMap';
import { exportLiveGen, importLive, liveId, liveLattice, liveObservedColumns, sameStamp, worldStamp, type LiveStamp } from './adapter';
import type { MemoryHooks, MemoryOptions, MemoryStatus } from './MapMemory';
import type { FragmentMeta } from './MapStore';
import type { HostMessage, PortLike, WorkerMessage } from './MemoryWorkerCore';
import type { Pose2 } from './pose';

/**
 * The page's side of MapMemory running in a worker (MemoryWorkerCore): it
 * snapshots the live grid when the worker asks (a few chunk rows per frame),
 * applies the maps the worker sends back, and relays events. Per frame this
 * costs a stamp check and, now and then, slices of a grid copy.
 */
export class MemoryClient {
  status: MemoryStatus = { state: 'loading', fragments: 0, storedBytes: 0, persistent: false, attempts: 0, restores: 0, undos: 0, saves: 0, lastReason: '', lastError: '' };
  links: { fragment: string; pose: Pose2; confirmed: boolean }[] = [];
  fragments: FragmentMeta[] = [];
  /** Worker CPU time (ms). */
  workerBusyMs = 0;
  /** Main-thread time spent on snapshots and imports (ms). */
  busyMs = 0;
  maxTickMs = 0;
  ready = false;
  private snapQueue: { id: number; gen: Generator<void, ChunkedMap | null, void> | null; stamp: LiveStamp }[] = [];
  private lastStamp: LiveStamp | null = null;
  private lastStampT = -Infinity;
  private seq = 0;
  private waiters = new Map<number, (v: unknown) => void>();
  private readyWaiters: (() => void)[] = [];

  constructor(
    readonly world: WorldModel,
    readonly port: PortLike,
    readonly hooks: MemoryHooks = {},
    options: Partial<MemoryOptions> = {},
    log = false,
  ) {
    port.onmessage = (e) => this.receive(e.data as WorkerMessage);
    this.send({ type: 'init', options, log });
  }

  private send(m: HostMessage, transfer?: Transferable[]) {
    this.port.postMessage(m, transfer);
  }

  /** Resolves once the worker has loaded the stored maps. */
  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r));
  }

  private receive(m: WorkerMessage) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.status = m.status;
        this.fragments = m.fragments;
        for (const r of this.readyWaiters.splice(0)) r();
        break;
      case 'need-snap':
        this.snapQueue.push({ id: m.id, gen: null, stamp: worldStamp(this.world) });
        break;
      case 'import': {
        const t0 = performance.now();
        const ok = liveId(this.world) === m.expectGrid && importLive(this.world, m.map);
        if (ok) this.hooks.onMapChanged?.();
        this.busyMs += performance.now() - t0;
        this.send({ type: 'imported', id: m.id, ok, stamp: worldStamp(this.world) });
        break;
      }
      case 'restored':
        this.hooks.onRestored?.(m);
        break;
      case 'undone':
        this.hooks.onUndone?.(m);
        break;
      case 'saved':
        this.hooks.onSaved?.(m);
        break;
      case 'log':
        this.hooks.log?.(m.msg);
        break;
      case 'status':
        this.status = m.status;
        this.links = m.links;
        this.workerBusyMs = m.busyMs;
        break;
      case 'done':
        this.waiters.get(m.id)?.(m.result);
        this.waiters.delete(m.id);
        break;
    }
  }

  private call<T>(m: (id: number) => HostMessage): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve) => {
      this.waiters.set(id, resolve as (v: unknown) => void);
      this.send(m(id));
    });
  }

  /** Per frame: tell the worker about the live map, and work on requested snapshots (≤ budget ms). */
  tick(now: number, budgetMs = 2): void {
    const t0 = performance.now();
    try {
      const w = this.world;
      const st = worldStamp(w);
      if (!this.lastStamp || !sameStamp(st, this.lastStamp) || t0 - this.lastStampT > 500) {
        this.lastStamp = st;
        this.lastStampT = t0;
        this.send({ type: 'stamp', stamp: st, observed: liveObservedColumns(w), lattice: liveLattice(w), now });
      }
      while (this.snapQueue.length && performance.now() - t0 < budgetMs) {
        const q = this.snapQueue[0];
        q.gen ??= exportLiveGen(w);
        const r = q.gen.next();
        if (!r.done) continue;
        this.snapQueue.shift();
        const map = r.value;
        const transfer: Transferable[] = [];
        if (map) for (const c of map.chunks.values()) for (const a of [c.occ, c.observed, c.underside, c.topFrac]) if (a) transfer.push(a.buffer);
        this.send({ type: 'snap', id: q.id, map, stamp: worldStamp(w), lattice: liveLattice(w) }, transfer);
      }
    } finally {
      const dt = performance.now() - t0;
      this.busyMs += dt;
      this.maxTickMs = Math.max(this.maxTickMs, dt);
    }
  }

  flush(): Promise<void> {
    return this.call<boolean>((id) => ({ type: 'flush', id })).then(() => undefined);
  }

  forget(): Promise<boolean> {
    return this.call<boolean>((id) => ({ type: 'forget', id }));
  }

  list(): Promise<FragmentMeta[]> {
    return this.call<FragmentMeta[]>((id) => ({ type: 'list', id }));
  }
}

/** Start MapMemory in a worker for this world (null if workers aren't available). */
export function startMemoryWorker(world: WorldModel, hooks: MemoryHooks, options: Partial<MemoryOptions> = {}, log = false): MemoryClient | null {
  try {
    const worker = new Worker(new URL('./memoryWorker.ts', import.meta.url), { type: 'module' });
    return new MemoryClient(world, worker as unknown as PortLike, hooks, options, log);
  } catch {
    return null;
  }
}

import type { ChunkedMap } from './ChunkedMap';
import type { LiveLattice, LiveSource, LiveStamp } from './adapter';
import { MapMemory, type Link, type MemoryOptions, type MemoryStatus } from './MapMemory';
import { MapStore, type FragmentMeta } from './MapStore';
import type { Pose2 } from './pose';

/**
 * MapMemory in a worker: all the searching, verifying, resampling, fusing,
 * encoding and storage happen here; the page only sends snapshots of the
 * live grid when asked and applies the maps it gets back (see
 * MemoryClient). The same code runs in-process in tests (MessageChannel).
 */
export type HostMessage =
  | { type: 'init'; options: Partial<MemoryOptions>; log: boolean }
  | { type: 'stamp'; stamp: LiveStamp; observed: number; lattice: LiveLattice | null; now: number }
  | { type: 'snap'; id: number; map: ChunkedMap | null; stamp: LiveStamp; lattice: LiveLattice | null }
  | { type: 'imported'; id: number; ok: boolean; stamp: LiveStamp }
  | { type: 'flush'; id: number }
  | { type: 'forget'; id: number }
  | { type: 'list'; id: number };

export type WorkerMessage =
  | { type: 'ready'; status: MemoryStatus; fragments: FragmentMeta[] }
  | { type: 'need-snap'; id: number }
  | { type: 'import'; id: number; map: ChunkedMap; expectGrid: number }
  | { type: 'restored'; fragment: string; area: number; pose: Pose2 }
  | { type: 'undone'; fragment: string; reason: string }
  | { type: 'saved'; fragment: string; bytes: number; ms: number }
  | { type: 'log'; msg: string }
  | { type: 'status'; status: MemoryStatus; links: Pick<Link, 'fragment' | 'pose' | 'confirmed'>[]; busyMs: number }
  | { type: 'done'; id: number; result: unknown };

export interface PortLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

/** The live map as seen from the worker: snapshots on request, imports by message. */
export class RemoteSource implements LiveSource {
  ready = false;
  private lat: LiveLattice | null = null;
  private st: LiveStamp = { grid: 0, epoch: 0, hard: 0, soft: 0, other: 0 };
  private obs = 0;
  private seq = 0;
  private snaps = new Map<number, ChunkedMap | null>();
  private acks = new Map<number, boolean>();
  private pending = 0;
  constructor(private readonly post: (m: WorkerMessage) => void) {}
  get waiting(): boolean {
    return this.pending > 0;
  }
  lattice() {
    return this.lat;
  }
  stamp() {
    return this.st;
  }
  observedColumns() {
    return this.obs;
  }
  update(stamp: LiveStamp, observed: number, lattice: LiveLattice | null) {
    this.st = stamp;
    this.obs = observed;
    this.lat = lattice;
    this.ready = !!lattice;
  }
  receiveSnap(id: number, map: ChunkedMap | null, stamp: LiveStamp, lattice: LiveLattice | null) {
    this.update(stamp, this.obs, lattice);
    this.snaps.set(id, map);
    this.pending--;
  }
  receiveAck(id: number, ok: boolean, stamp: LiveStamp) {
    this.st = stamp;
    this.acks.set(id, ok);
    this.pending--;
  }
  *exportGen(): Generator<void, ChunkedMap | null, void> {
    const id = ++this.seq;
    this.pending++;
    this.post({ type: 'need-snap', id });
    while (!this.snaps.has(id)) yield;
    const m = this.snaps.get(id)!;
    this.snaps.delete(id);
    return m;
  }
  *importGen(m: ChunkedMap, expectGrid: number): Generator<void, boolean, void> {
    const id = ++this.seq;
    this.pending++;
    this.post({ type: 'import', id, map: m, expectGrid });
    while (!this.acks.has(id)) yield;
    const ok = this.acks.get(id)!;
    this.acks.delete(id);
    return ok;
  }
}

/** Serve MapMemory over a port (the worker's global scope, or a MessageChannel port in tests). */
export function serveMemory(port: PortLike, openStore: () => Promise<MapStore> = () => MapStore.open()): void {
  const post = (m: WorkerMessage) => port.postMessage(m);
  const source = new RemoteSource(post);
  let memory: MapMemory | null = null;
  let now = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStatus = 0;
  const queue: HostMessage[] = [];

  const loop = () => {
    timer = null;
    if (!memory) return;
    memory.tick(now, 25);
    const t = performance.now();
    if (t - lastStatus > 500) {
      lastStatus = t;
      post({ type: 'status', status: memory.status, links: memory.links.map((l) => ({ fragment: l.fragment, pose: l.pose, confirmed: l.confirmed })), busyMs: memory.busyMs });
    }
    // Busy and not waiting for the page: keep going; otherwise check back soon.
    schedule(memory.busy && !source.waiting ? 0 : 50);
  };
  const schedule = (ms: number) => {
    if (timer === null) timer = setTimeout(loop, ms);
  };

  const handle = async (m: HostMessage) => {
    switch (m.type) {
      case 'init': {
        const store = await openStore().catch(() => null);
        memory = new MapMemory(
          store,
          {
            onRestored: (i) => post({ type: 'restored', ...i }),
            onUndone: (i) => post({ type: 'undone', ...i }),
            onSaved: (i) => post({ type: 'saved', ...i }),
            log: m.log ? (msg) => post({ type: 'log', msg }) : undefined,
          },
          m.options,
        );
        await memory.load();
        memory.attach(source);
        post({ type: 'ready', status: memory.status, fragments: store?.list() ?? [] });
        // Messages that arrived while loading.
        while (queue.length) await handle(queue.shift()!);
        schedule(0);
        break;
      }
      case 'stamp':
        source.update(m.stamp, m.observed, m.lattice);
        // The worker follows the page's clock (simulated time in the virtual room).
        now = m.now;
        schedule(0);
        break;
      case 'snap':
        source.receiveSnap(m.id, m.map, m.stamp, m.lattice);
        schedule(0);
        break;
      case 'imported':
        source.receiveAck(m.id, m.ok, m.stamp);
        schedule(0);
        break;
      case 'flush':
        if (!memory) return queue.push(m);
        await memory.flush();
        post({ type: 'done', id: m.id, result: true });
        break;
      case 'forget': {
        if (!memory) return queue.push(m);
        const ok = await memory.forget();
        post({ type: 'done', id: m.id, result: ok });
        break;
      }
      case 'list':
        if (!memory) return queue.push(m);
        post({ type: 'done', id: m.id, result: memory.store?.list() ?? [] });
        break;
    }
  };
  port.onmessage = (e: MessageEvent) => {
    const m = e.data as HostMessage;
    if (m.type !== 'init' && !memory && m.type !== 'stamp' && m.type !== 'snap' && m.type !== 'imported') {
      queue.push(m);
      return;
    }
    void handle(m).catch((err) => post({ type: 'log', msg: `worker error: ${(err as Error)?.stack ?? err}` }));
  };
}

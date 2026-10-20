import type { ChunkedMap } from './ChunkedMap';
import { decodeMap, encodeBody, packBody } from './codec';

/**
 * On-device storage of maps ("fragments": each is one connected piece of the
 * home with its own frame; sessions that relocalize into a fragment grow it,
 * and fragments are stitched into one when a session overlaps both).
 *
 * Backed by IndexedDB (localStorage is ~5MB and string-only). Writes are
 * crash-safe: a fragment's new data goes to a new key ("generation") first,
 * then the index is switched to it, and only the generation before the
 * previous one is deleted — so the previous version stays as a backup.
 * Anything that fails (no IndexedDB in a private window, quota exceeded, a
 * corrupted record) is reported and skipped; the game never depends on it.
 */
export interface FragmentMeta {
  id: string;
  created: number;
  updated: number;
  /** Sessions that contributed. */
  sessions: number;
  /** Encoded size (bytes). */
  bytes: number;
  /** Generation of the current data (key `frag:<id>:<gen>`). */
  gen: number;
  /** Previous generation kept as a backup (or -1). */
  prevGen: number;
  /** Observed floor area (m²), for UI and pruning. */
  area: number;
}

export interface StoreIndex {
  version: number;
  fragments: FragmentMeta[];
}

/** Minimal async key-value store. */
export interface KV {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
  readonly persistent: boolean;
}

export class MemoryKV implements KV {
  readonly persistent = false;
  readonly data = new Map<string, unknown>();
  /** Simulated quota (bytes of Uint8Array values); writes beyond it throw QuotaExceededError. */
  quota = Infinity;
  /** Fail every operation (tests: storage broken mid-session). */
  broken = false;
  async get(key: string) {
    if (this.broken) throw new Error('storage broken');
    const v = this.data.get(key);
    return v instanceof Uint8Array ? v.slice() : v;
  }
  async put(key: string, value: unknown) {
    if (this.broken) throw new Error('storage broken');
    const size = (v: unknown) => (v instanceof Uint8Array ? v.length : typeof v === 'string' ? v.length : 0);
    let used = 0;
    for (const [k, v] of this.data) if (k !== key) used += size(v);
    if (used + size(value) > this.quota) {
      const e = new Error('quota exceeded');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.data.set(key, value instanceof Uint8Array ? value.slice() : value);
  }
  async del(key: string) {
    if (this.broken) throw new Error('storage broken');
    this.data.delete(key);
  }
  async keys() {
    if (this.broken) throw new Error('storage broken');
    return [...this.data.keys()];
  }
}

export class IdbKV implements KV {
  readonly persistent = true;
  private constructor(private db: IDBDatabase) {}
  static open(name = 'hopper-maps'): Promise<IdbKV> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(name, 1);
      } catch (e) {
        return reject(e);
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(new IdbKV(req.result));
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      let t: IDBTransaction;
      try {
        t = this.db.transaction('kv', mode);
      } catch (e) {
        return reject(e);
      }
      let result: T | undefined;
      const r = fn(t.objectStore('kv'));
      if (r) r.onsuccess = () => (result = r.result);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error ?? new Error('IndexedDB error'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    });
  }
  get(key: string) {
    return this.tx('readonly', (s) => s.get(key));
  }
  async put(key: string, value: unknown) {
    await this.tx('readwrite', (s) => s.put(value, key));
  }
  async del(key: string) {
    await this.tx('readwrite', (s) => s.delete(key));
  }
  async keys() {
    return ((await this.tx('readonly', (s) => s.getAllKeys())) ?? []).map(String);
  }
}

export const STORE_VERSION = 1;
/** Default storage budget for all fragments together. */
export const DEFAULT_BUDGET = 40 * 1024 * 1024;

export class MapStore {
  private index: StoreIndex = { version: STORE_VERSION, fragments: [] };
  /** Last error (for diagnostics / HUD). */
  lastError = '';
  /** Fragments that failed to decode this session (skipped, kept on disk until overwritten or forgotten). */
  readonly corrupt = new Set<string>();
  budget = DEFAULT_BUDGET;

  private constructor(readonly kv: KV) {}

  /** Open the device store (IndexedDB), or an in-memory one when that's unavailable. */
  static async open(kv?: KV): Promise<MapStore> {
    let backend = kv;
    if (!backend)
      try {
        backend = await IdbKV.open();
      } catch {
        backend = new MemoryKV();
      }
    const s = new MapStore(backend);
    await s.readIndex();
    return s;
  }

  get persistent(): boolean {
    return this.kv.persistent;
  }

  private async readIndex() {
    try {
      const raw = await this.kv.get('index');
      const idx = typeof raw === 'string' ? (JSON.parse(raw) as StoreIndex) : null;
      if (idx && idx.version === STORE_VERSION && Array.isArray(idx.fragments)) {
        this.index = { version: STORE_VERSION, fragments: idx.fragments.filter((f) => f && typeof f.id === 'string' && Number.isFinite(f.gen)) };
      } else if (raw !== undefined) this.lastError = 'unreadable index (ignored)';
    } catch (e) {
      this.lastError = `index: ${(e as Error)?.message ?? e}`;
    }
  }

  private async writeIndex() {
    await this.kv.put('index', JSON.stringify(this.index));
  }

  list(): FragmentMeta[] {
    return this.index.fragments.map((f) => ({ ...f }));
  }

  get totalBytes(): number {
    return this.index.fragments.reduce((a, f) => a + f.bytes, 0);
  }

  /** Load a fragment's map; null (and remembered as corrupt) if it can't be read. */
  async load(id: string): Promise<ChunkedMap | null> {
    const meta = this.index.fragments.find((f) => f.id === id);
    if (!meta) return null;
    for (const gen of [meta.gen, meta.prevGen]) {
      if (gen < 0) continue;
      try {
        const raw = await this.kv.get(`frag:${id}:${gen}`);
        if (!(raw instanceof Uint8Array)) throw new Error('missing data');
        return await decodeMap(raw);
      } catch (e) {
        this.lastError = `load ${id}: ${(e as Error)?.message ?? e}`;
        this.corrupt.add(id);
        // Fall back to the backup generation.
      }
    }
    return null;
  }

  /**
   * Save (create or replace) a fragment. Returns the new metadata, or null if
   * it couldn't be stored (the previous version, if any, is untouched).
   */
  async save(id: string, map: ChunkedMap, info: { area: number; sessions?: number; created?: number }, encoded?: Uint8Array): Promise<FragmentMeta | null> {
    try {
      const data = encoded ?? (await encodeAsync(map));
      const old = this.index.fragments.find((f) => f.id === id);
      // Budget: make room by dropping other fragments (smallest area first), never this one.
      const others = this.index.fragments.filter((f) => f.id !== id);
      let total = others.reduce((a, f) => a + f.bytes, 0) + data.length;
      if (data.length > this.budget) throw Object.assign(new Error('map larger than the storage budget'), { name: 'QuotaExceededError' });
      const victims = [...others].sort((a, b) => a.area - b.area || a.updated - b.updated);
      while (total > this.budget && victims.length) {
        const v = victims.shift()!;
        await this.remove(v.id);
        total -= v.bytes;
      }
      const gen = old ? old.gen + 1 : 0;
      await this.kv.put(`frag:${id}:${gen}`, data);
      const now = Date.now();
      const meta: FragmentMeta = {
        id,
        created: info.created ?? old?.created ?? now,
        updated: now,
        sessions: info.sessions ?? old?.sessions ?? 1,
        bytes: data.length,
        gen,
        prevGen: old ? old.gen : -1,
        area: info.area,
      };
      const prevPrev = old?.prevGen ?? -1;
      this.index.fragments = [...this.index.fragments.filter((f) => f.id !== id), meta];
      try {
        await this.writeIndex();
      } catch (e) {
        // Index not switched: the old version stays current. Drop the orphan.
        this.index.fragments = [...this.index.fragments.filter((f) => f.id !== id), ...(old ? [old] : [])];
        await this.kv.del(`frag:${id}:${gen}`).catch(() => undefined);
        throw e;
      }
      this.corrupt.delete(id);
      if (prevPrev >= 0) await this.kv.del(`frag:${id}:${prevPrev}`).catch(() => undefined);
      return meta;
    } catch (e) {
      this.lastError = `save ${id}: ${(e as Error)?.name === 'QuotaExceededError' ? 'storage full' : ((e as Error)?.message ?? e)}`;
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    const meta = this.index.fragments.find((f) => f.id === id);
    this.index.fragments = this.index.fragments.filter((f) => f.id !== id);
    try {
      await this.writeIndex();
      if (meta) for (const g of [meta.gen, meta.prevGen]) if (g >= 0) await this.kv.del(`frag:${id}:${g}`);
    } catch (e) {
      this.lastError = `remove ${id}: ${(e as Error)?.message ?? e}`;
    }
  }

  /** Forget everything (the "forget saved rooms" control). */
  async clear(): Promise<boolean> {
    this.index = { version: STORE_VERSION, fragments: [] };
    try {
      for (const k of await this.kv.keys()) await this.kv.del(k);
      return true;
    } catch (e) {
      this.lastError = `clear: ${(e as Error)?.message ?? e}`;
      return false;
    }
  }

  /** Remove stored data no index entry points to (left by a crash mid-save). */
  async sweep(): Promise<number> {
    let n = 0;
    try {
      const live = new Set<string>();
      for (const f of this.index.fragments) for (const g of [f.gen, f.prevGen]) if (g >= 0) live.add(`frag:${f.id}:${g}`);
      for (const k of await this.kv.keys())
        if (k.startsWith('frag:') && !live.has(k)) {
          await this.kv.del(k);
          n++;
        }
    } catch {
      /* best effort */
    }
    return n;
  }
}

async function encodeAsync(m: ChunkedMap): Promise<Uint8Array> {
  const g = encodeBody(m);
  let r = g.next();
  while (!r.done) r = g.next();
  return packBody(r.value);
}

/** Ask the browser not to evict our storage under pressure (best effort, once). */
export async function requestPersistence(): Promise<boolean> {
  try {
    const s = (navigator as Navigator & { storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> } }).storage;
    if (!s?.persist) return false;
    if (await s.persisted?.()) return true;
    return await s.persist();
  } catch {
    return false;
  }
}

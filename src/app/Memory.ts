import type { GameStack } from '../game/stack';
import { MapMemory, type MemoryHooks, type MemoryOptions, type MemoryStatus } from '../world/persist/MapMemory';
import { MapStore, requestPersistence, type FragmentMeta } from '../world/persist/MapStore';
import { startMemoryWorker } from '../world/persist/MemoryClient';
import type { Hud } from './Hud';
import type { Voice } from './Voice';

/**
 * App glue for remembering rooms between sessions (src/world/persist): runs
 * MapMemory in a worker (or, without workers, in small per-frame slices),
 * restores a remembered room into the live map once Hopper recognises it
 * ("I remember this room!"), and saves while playing and when the page is
 * hidden. Every failure just means "no memory this time": the game never
 * waits for or depends on it.
 */
export interface AppMemory {
  readonly mode: 'worker' | 'inline';
  readonly status: MemoryStatus;
  /** Per-frame work (ms of main-thread time is small: a stamp check, now and then a slice of a grid copy). */
  tick(now: number): void;
  flush(): Promise<void>;
  forget(): Promise<boolean>;
  list(): Promise<FragmentMeta[]>;
}

export async function startMemory(
  stack: GameStack,
  hud: Hud,
  voice: Voice,
  opts: { onMapChanged?: () => void; budgetMs?: number; options?: Partial<MemoryOptions> } = {},
): Promise<AppMemory | null> {
  const q = new URLSearchParams(location.search);
  if (q.get('memory') === '0') return null;
  let askedPersist = false;
  let told = false;
  const log = q.get('memlog') === '1';
  const hooks: MemoryHooks = {
    onRestored: () => {
      if (told) return;
      told = true;
      hud.say(`I remember this room! 🏠`, 5);
      voice.giggle(false);
    },
    onUndone: () => hud.say('Hmm, it isn’t quite how I remembered it — I’ll learn it fresh.', 5),
    onMapChanged: () => {
      stack.game.refreshNav(true);
      opts.onMapChanged?.();
    },
    onSaved: () => {
      if (!askedPersist) {
        askedPersist = true;
        void requestPersistence();
      }
    },
    log: log ? (m) => console.log(`[memory] ${m}`) : undefined,
  };
  let mem: AppMemory | null = null;
  // Off the main thread when possible (?memworker=0 forces the in-page version).
  const client = q.get('memworker') === '0' ? null : startMemoryWorker(stack.world, hooks, opts.options, log);
  if (client) {
    const budget = Number(q.get('memBudget') ?? 2);
    mem = {
      mode: 'worker',
      get status() {
        return client.status;
      },
      tick: (now) => client.tick(now, budget),
      flush: () => client.flush(),
      forget: () => client.forget(),
      list: () => client.list(),
    };
  } else {
    let store: MapStore;
    try {
      store = await MapStore.open();
    } catch {
      return null;
    }
    const memory = new MapMemory(store, hooks, opts.options);
    try {
      await memory.load();
    } catch (e) {
      console.warn('[memory] load failed', e);
    }
    memory.attach(stack.world);
    const budget = Number(q.get('memBudget') ?? opts.budgetMs ?? 3);
    mem = {
      mode: 'inline',
      status: memory.status,
      tick: (now) => memory.tick(now, budget),
      flush: () => memory.flush(),
      forget: () => memory.forget(),
      list: async () => store.list(),
    };
  }
  // Save when the app goes to the background or the page is left (best effort).
  const flush = () => void mem!.flush().catch(() => undefined);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  return mem;
}

/** Start page: "Hopper remembers your room · forget" when there is something stored. */
export async function setupForgetControl(row: HTMLElement | null, button: HTMLElement | null, text: HTMLElement | null): Promise<void> {
  if (!row || !button || !text) return;
  let store: MapStore;
  try {
    store = await MapStore.open();
  } catch {
    return;
  }
  if (!store.persistent) return;
  const frags = store.list();
  if (!frags.length) return;
  const area = frags.reduce((a, f) => a + f.area, 0);
  text.textContent = `Hopper remembers ${frags.length > 1 ? `${frags.length} parts of your home` : 'your room'} (${Math.round(area)} m²)`;
  row.style.display = '';
  button.onclick = async (e) => {
    e.preventDefault();
    if (!confirm('Forget the rooms Hopper remembers? It will learn them again next time.')) return;
    await store.clear();
    text.textContent = 'Forgotten — Hopper will learn your home again.';
    button.style.display = 'none';
  };
}

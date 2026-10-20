import { Rng } from '../core/rng';
import { MapMemory, type MemoryOptions } from '../world/persist/MapMemory';
import { MapStore, MemoryKV } from '../world/persist/MapStore';
import { composePose, invertPose, poseDelta, type Pose2 } from '../world/persist/pose';
import { makeHome, rearrange, type Home } from './Home';
import { dressRoom } from './Realism';
import { exportLive, liveLattice } from '../world/persist/adapter';
import type { ChunkedMap } from '../world/persist/ChunkedMap';
import { SimSession, storedMapQuality, type StoredMapQuality } from './MultiSession';
import type { NoiseName, NoiseProfile } from './SimSensor';

/** Bench diagnostics (env PERSIST_DIAG): live map quality over time, memory log, stored map quality per session. */
const DIAG = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PERSIST_DIAG;

/**
 * Multi-session benchmark: a sequence of mapping sessions in one home, each
 * in a fresh random frame, sharing one on-device store. Measures how often
 * and how fast sessions relocalize, how accurately, whether any restore was
 * wrong (must be ~never), and what the stored map looks like at the end.
 */
export interface BenchOptions {
  seed: number;
  sessions: number;
  seconds?: number;
  /** Home layout. */
  cols?: number;
  rows?: number;
  symmetric?: boolean;
  furnish?: number;
  /** Chance per session that furniture was moved since the last one, and how much. */
  moveChance?: number;
  moveShare?: number;
  noise?: NoiseName | NoiseProfile;
  /** Probability that a session visits a room never mapped before. */
  newRoomChance?: number;
  /** Probability that a session walks through two adjacent rooms. */
  twoRoomChance?: number;
  /** Background work per 10Hz step (ms). */
  budgetMs?: number;
  /** Instead of a time budget: this many work slices per 10Hz step (deterministic runs). */
  stepBudget?: number;
  memory?: Partial<MemoryOptions>;
  cameraDepth?: boolean;
  /** Live grid half extent (m). */
  halfExtent?: number;
  /** Storage quota (bytes) and per-session chance of damaging a stored map. */
  quota?: number;
  corrupt?: number;
  log?: (s: string) => void;
}

export interface RestoreEvent {
  session: number;
  t: number;
  fragment: string;
  errCm: number;
  errDeg: number;
  wrong: boolean;
  undone: boolean;
}

export interface SessionReport {
  session: number;
  rooms: number[];
  /** Some room of this session was mapped in an earlier session (a restore is possible). */
  known: boolean;
  /** First restore time (s), or null. */
  restoredAt: number | null;
  restores: RestoreEvent[];
  undos: number;
  fragmentsAfter: number;
  storedBytes: number;
  saveMs: number;
  loadMs: number;
  busyMs: number;
  maxTickMs: number;
  maxStep: { ms: number; job: string };
}

export interface BenchReport {
  opts: BenchOptions;
  sessions: SessionReport[];
  /** Sessions with a known room that restored (correctly) / sessions with a known room. */
  relocRate: number;
  meanTimeToReloc: number;
  wrongRestores: number;
  wrongKept: number;
  restores: number;
  /** Stored fragments stitched offline, and how many of those were wrong. */
  stitches: number;
  wrongStitches: number;
  meanErrCm: number;
  meanErrDeg: number;
  fragments: number;
  storedBytes: number;
  quality: (StoredMapQuality & { fragment: string })[];
  /** Covered area of the biggest fragment / home free area. */
  coverage: number;
}

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const rng = new Rng(o.seed * 7919 + 1);
  let home: Home = makeHome(o.seed, { cols: o.cols ?? 2, rows: o.rows ?? 2, symmetric: o.symmetric, furnish: o.furnish });
  dressRoom(home.room, o.seed);
  const kv = new MemoryKV();
  if (o.quota) kv.quota = o.quota;
  const faultRng = new Rng(o.seed * 31 + 17);
  let corruptions = 0;
  /** room → fragment frame, per fragment id. */
  const fragTruth = new Map<string, Pose2>();
  const visited = new Set<number>();
  const stitches: { wrong: boolean; errCm: number }[] = [];
  const reports: SessionReport[] = [];
  const log = o.log ?? (() => undefined);
  for (let s = 0; s < o.sessions; s++) {
    // Storage faults between sessions: a flipped byte in a stored map, or a truncated one.
    if (s > 0 && o.corrupt && faultRng.chance(o.corrupt)) {
      const keys = [...kv.data.keys()].filter((k) => k.startsWith('frag:'));
      if (keys.length) {
        const k = faultRng.pick(keys);
        const v = kv.data.get(k) as Uint8Array;
        if (faultRng.chance(0.5)) v[faultRng.int(0, v.length - 1)] ^= 0x5a;
        else kv.data.set(k, v.slice(0, Math.floor(v.length / 2)));
        corruptions++;
        log(`  (storage fault before session ${s}: ${k} damaged)`);
      }
    }
    if (s > 0 && rng.chance(o.moveChance ?? 0.3)) home = rearrange(home, o.seed * 100 + s, o.moveShare ?? 0.25);
    // Which rooms: usually somewhere known, sometimes new, sometimes two.
    const all = home.rooms.map((r) => r.id);
    const unvisited = all.filter((r) => !visited.has(r));
    let start: number;
    if (!visited.size || (unvisited.length && rng.chance(o.newRoomChance ?? 0.35))) start = rng.pick(unvisited.length ? unvisited : all);
    else start = rng.pick([...visited]);
    const rooms = [start];
    if (rng.chance(o.twoRoomChance ?? 0.4)) {
      const nb = home.doors.filter((d) => d.a === start || d.b === start).map((d) => (d.a === start ? d.b : d.a));
      if (nb.length) rooms.push(rng.pick(nb));
    }
    const known = rooms.some((r) => visited.has(r));
    const t0 = performance.now();
    const store = await MapStore.open(kv);
    const restores: RestoreEvent[] = [];
    let session: SimSession | null = null;
    const recent: string[] = [];
    const memory = new MapMemory(store, {
      log: (m) => {
        recent.push(`    [${session?.t.toFixed(1)}s] ${m}`);
        if (DIAG) log(recent[recent.length - 1]);
        if (recent.length > 30) recent.shift();
      },
      onRestored: (info) => {
        const ft = fragTruth.get(info.fragment);
        if (!ft || !session) return;
        const truth = composePose(ft, invertPose(session.truth));
        const b = session.world.grid!;
        const at = { x: b.origin.x + (b.nx * b.res) / 2, z: b.origin.z + (b.nz * b.res) / 2 };
        // Error at the camera's position (where it matters), not the grid centre.
        const cam = session.path[Math.min(session.path.length - 1, Math.round(session.t * 10))]?.cam.pos;
        const p = cam ? session.sensor.toFrame(cam) : { x: at.x, z: at.z };
        const d = poseDelta(info.pose, truth, { x: p.x, z: p.z });
        const ev = { session: s, t: session.t, fragment: info.fragment, errCm: d.dist * 100, errDeg: (d.dyaw * 180) / Math.PI, wrong: d.dist > 0.2 || d.dyaw > 0.06, undone: false };
        restores.push(ev);
        log(`  session ${s} t=${session.t.toFixed(0)}s restored ${info.fragment}: err ${ev.errCm.toFixed(1)}cm ${ev.errDeg.toFixed(2)}°${ev.wrong ? '  <<< WRONG' : ''}`);
        if (ev.wrong) for (const l of recent) log(l);
      },
      onStitched: (info) => {
        const tb = fragTruth.get(info.base), to = fragTruth.get(info.other);
        if (!tb || !to) return;
        const d = poseDelta(info.pose, composePose(tb, invertPose(to)));
        const wrong = d.dist > 0.2 || d.dyaw > 0.06;
        stitches.push({ wrong, errCm: d.dist * 100 });
        log(`  session ${s} stitched stored ${info.other} into ${info.base}: err ${(d.dist * 100).toFixed(1)}cm${wrong ? '  <<< WRONG' : ''}`);
      },
      onUndone: (info) => {
        const ev = [...restores].reverse().find((r) => r.fragment === info.fragment && !r.undone);
        if (ev) ev.undone = true;
        log(`  session ${s} undo ${info.fragment}: ${info.reason}${ev ? (ev.wrong ? ' (was wrong: good)' : ' (was right: lost it)') : ''}`);
      },
    }, o.memory);
    await memory.load();
    const loadMs = performance.now() - t0;
    session = new SimSession({ home, room: home.room, rooms, seconds: o.seconds ?? 60, seed: o.seed * 1000 + s, noise: o.noise, cameraDepth: o.cameraDepth, halfExtent: o.halfExtent });
    memory.attach(session.world);
    const budget = o.budgetMs ?? 8;
    const diag = DIAG;
    let nextDiag = 5;
    const liveQ = () => {
      const m = exportLive(session!.world);
      return m ? storedMapQuality(m, home.room, session!.truth).precision.toFixed(3) : '-';
    };
    while (session.step()) {
      memory.tick(session.t, o.stepBudget ? Infinity : budget, o.stepBudget ?? Infinity);
      if (diag && session.t >= nextDiag) {
        nextDiag += 5;
        const r = session.world.recoveries;
        const mm = memory as unknown as { evidence: { map: ChunkedMap } | null; tracker: { liveOnly: ChunkedMap; base: ChunkedMap } | null };
        const q = (m: ChunkedMap | undefined) => (m ? storedMapQuality(m, home.room, session!.truth).precision.toFixed(3) : '-');
        if (mm.tracker) {
          // How the live map moved away from the bookkeeping base: forgotten voxels (known → 0), by place.
          const now = exportLive(session.world)!, b = mm.tracker.base, L = liveLattice(session.world)!;
          let forgot = 0, forgotOut = 0, gained = 0, changed = 0;
          for (const [k, c] of b.chunks) {
            const gch = now.chunks.get(k);
            const out = c.cx * 16 < L.oi || c.cx * 16 >= L.oi + L.nx || c.cz * 16 < L.ok || c.cz * 16 >= L.ok + L.nz;
            for (let qq = 0; qq < c.occ.length; qq++) {
              const bv = c.occ[qq], gv = gch ? gch.occ[qq] : 0;
              if (bv !== 0 && gv === 0) {
                forgot++;
                if (out) forgotOut++;
              } else if (bv !== gv) changed++;
            }
          }
          for (const [k, c] of now.chunks) if (!b.chunks.has(k)) for (let qq = 0; qq < c.occ.length; qq++) if (c.occ[qq]) gained++;
          log(`    [${session.t.toFixed(0)}s] vs base: forgot ${forgot} (outside window ${forgotOut}), changed ${changed}, new chunks ${gained}`);
        }
        log(`    [${session.t.toFixed(0)}s] evidence ${q(mm.evidence?.map)} liveOnly ${q(mm.tracker?.liveOnly)} base ${q(mm.tracker?.base)}`);
        log(`    [${session.t.toFixed(0)}s] live prec ${liveQ()} moves ${session.world.recenters} warps ${session.world.warps} epoch ${session.world.epoch} rec ${r.hard}/${r.soft}/${r.relevel}/${r.realign} links ${memory.links.length}`);
      }
    }
    // Leaving: finish what's running, save.
    const ts = performance.now();
    await memory.flush();
    const saveMs = performance.now() - ts;
    // Register the frame of a fragment this session created.
    if (store.list().some((f) => f.id === memory.sessionId)) fragTruth.set(memory.sessionId, session.truth);
    if (DIAG) {
      // Where a bad stored map comes from: the session's own map, or the save?
      const live = exportLive(session.world);
      const parts: string[] = [];
      if (live) parts.push(`live prec ${storedMapQuality(live, home.room, session.truth).precision.toFixed(3)}`);
      for (const f of store.list()) {
        const ft = fragTruth.get(f.id);
        const m = ft ? await store.load(f.id) : null;
        if (m && ft) parts.push(`${f.id.slice(-4)} ${storedMapQuality(m, home.room, ft).precision.toFixed(3)}`);
      }
      log(`  diag after session ${s}: ${parts.join(', ')}`);
    }
    for (const r of rooms) visited.add(r);
    const firstGood = restores.find((r) => !r.wrong);
    reports.push({
      session: s,
      rooms,
      known,
      restoredAt: firstGood ? firstGood.t : null,
      restores,
      undos: memory.status.undos,
      fragmentsAfter: store.list().length,
      storedBytes: store.totalBytes,
      saveMs,
      loadMs,
      busyMs: memory.busyMs,
      maxTickMs: memory.maxTickMs,
      maxStep: memory.maxStep,
    });
    log(
      `session ${s}: rooms ${rooms.join('+')} ${known ? 'known' : 'new'} → ${firstGood ? `restored at ${firstGood.t.toFixed(0)}s` : 'no restore'}${restores.some((r) => r.wrong) ? ' WRONG RESTORE' : ''}; fragments ${store.list().length}, ${(store.totalBytes / 1024).toFixed(0)}KB, save ${saveMs.toFixed(0)}ms load ${loadMs.toFixed(0)}ms busy ${memory.busyMs.toFixed(0)}ms (max tick ${memory.maxTickMs.toFixed(1)}ms, max step ${memory.maxStep.ms.toFixed(1)}ms in ${memory.maxStep.job})${session.world.recenters ? `, window moves ${session.world.recenters}` : ''} ${memory.status.lastReason}`,
    );
  }
  // Final map quality per stored fragment.
  const store = await MapStore.open(kv);
  const quality: (StoredMapQuality & { fragment: string })[] = [];
  for (const f of store.list()) {
    const m = await store.load(f.id);
    const t = fragTruth.get(f.id);
    if (m && t) quality.push({ fragment: f.id, ...storedMapQuality(m, home.room, t) });
  }
  const knownS = reports.filter((r) => r.known);
  const okS = knownS.filter((r) => r.restoredAt !== null);
  const all = reports.flatMap((r) => r.restores);
  const good = all.filter((r) => !r.wrong);
  return {
    opts: o,
    sessions: reports,
    relocRate: knownS.length ? okS.length / knownS.length : 1,
    meanTimeToReloc: okS.length ? okS.reduce((a, r) => a + r.restoredAt!, 0) / okS.length : NaN,
    wrongRestores: all.filter((r) => r.wrong).length,
    wrongKept: all.filter((r) => r.wrong && !r.undone).length,
    restores: all.length,
    stitches: stitches.length,
    wrongStitches: stitches.filter((x) => x.wrong).length,
    meanErrCm: good.length ? good.reduce((a, r) => a + r.errCm, 0) / good.length : NaN,
    meanErrDeg: good.length ? good.reduce((a, r) => a + r.errDeg, 0) / good.length : NaN,
    fragments: store.list().length,
    storedBytes: store.totalBytes,
    quality,
    coverage: quality.length ? Math.max(...quality.map((q) => q.coverage)) : 0,
  };
}

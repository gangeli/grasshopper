/**
 * Allocation rate of the per-frame work (world-model ingestion, game update,
 * nav rebuilds) during automated rounds, and the memory held by the world
 * model's big structures. Run with a large young generation so a scavenge
 * rarely lands inside a measured call (calls that saw one are skipped):
 *
 *   node --max-semi-space-size=256 --expose-gc --import tsx scripts/perf-alloc.ts
 */
import inspector from 'node:inspector';
import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { WorldModel } from '../src/world/WorldModel';
import { HideAndSeek } from '../src/game/HideAndSeek';
import { NavGrid } from '../src/world/NavGrid';
import { HealthMonitor } from '../src/game/Health';
import { Animator } from '../src/pet/Animator';
import { PetController } from '../src/pet/PetController';

type Acc = { bytes: number; calls: number; skipped: number };
const acc = new Map<string, Acc>();
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
function wrap(proto: object, name: string, label: string) {
  const p = proto as Record<string, (...a: unknown[]) => unknown>;
  const orig = p[name];
  if (typeof orig !== 'function') return;
  let inside = 0;
  p[name] = function (this: unknown, ...a: unknown[]) {
    if (inside) return orig.apply(this, a);
    inside++;
    const b0 = used();
    try {
      return orig.apply(this, a);
    } finally {
      const d = used() - b0;
      inside--;
      let e = acc.get(label);
      if (!e) acc.set(label, (e = { bytes: 0, calls: 0, skipped: 0 }));
      if (d < 0) e.skipped++;
      else {
        e.bytes += d;
        e.calls++;
      }
    }
  };
}
wrap(WorldModel.prototype, 'ingestDepthImage', 'world.ingestDepthImage');
wrap(HideAndSeek.prototype, 'update', 'game.update (incl. nav, health)');
if (process.env.ALLOC_DETAIL) {
  wrap(WorldModel.prototype, 'ingestDepth', '  world.ingestDepth (rays)');
  wrap(WorldModel.prototype, 'takeSnapshot', '  world.takeSnapshot');
  wrap(NavGrid.prototype, 'build', '  nav.build');
  wrap(HealthMonitor.prototype, 'update', '  health.update');
  wrap(Animator.prototype, 'update', '  anim.update');
  wrap(PetController.prototype, 'update', '  pet.update');
}

// ALLOC_PROFILE=1: sampling heap profiler including collected objects → top allocation sites.
const session = process.env.ALLOC_PROFILE ? new inspector.Session() : null;
const post = (m: string, p?: object) => new Promise<any>((res, rej) => session!.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
if (session) {
  session.connect();
  await post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
}
const rounds = Number(process.argv[2] ?? 2);
let frames = 0;
let snapBytes = 0, replayBytes = 0, gridBytes = 0;
for (let r = 0; r < rounds; r++) {
  const sim = new Simulation({ seed: 11 + r, noise: 'arcore', room: dressRoom(roomFromName('living'), 11 + r) });
  const bot = new SeekerBot(sim);
  while (bot.phase !== 'done' && sim.time < 200) {
    bot.step(1 / 30);
    frames++;
  }
  const w = sim.world as unknown as { snapshotBytes?: () => number; replay: { pts: Float32Array; sig: Float32Array | null }[] };
  const g = sim.world.grid!;
  gridBytes = g.data.byteLength + g.observed.byteLength + g.underside.byteLength + g.topFrac.byteLength + (g.shadow?.byteLength ?? 0);
  snapBytes = w.snapshotBytes ? w.snapshotBytes() : -1;
  replayBytes = w.replay.reduce((s, f) => s + f.pts.byteLength + (f.sig?.byteLength ?? 0), 0);
}
console.log(`${frames} frames`);
for (const [k, e] of acc)
  console.log(`${k.padEnd(34)} ${(e.bytes / e.calls / 1024).toFixed(1).padStart(8)} KB/call  ${((e.bytes / e.calls) * (e.calls / frames) / 1024).toFixed(1).padStart(8)} KB/frame  (${e.calls} calls, ${e.skipped} skipped)`);
const MB = (b: number) => (b / 1048576).toFixed(1) + ' MB';
console.log(`grid (incl. shadow mask) ${MB(gridBytes)}  snapshots ${snapBytes < 0 ? 'n/a' : MB(snapBytes)}  replay buffer ${MB(replayBytes)}`);

if (session) {
  const { profile } = await post('HeapProfiler.stopSampling');
  const self = new Map<string, number>();
  let total = 0;
  const walk = (n: any) => {
    const f = n.callFrame;
    const here = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`;
    self.set(here, (self.get(here) ?? 0) + n.selfSize);
    total += n.selfSize;
    for (const c of n.children) walk(c);
  };
  walk(profile.head);
  console.log(`\nallocated (sampled) ${(total / 1048576).toFixed(0)} MB; top sites:`);
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(v / 1048576).toFixed(1).padStart(8)} MB  ${k}`);
}

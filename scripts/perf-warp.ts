// Main-thread cost (CPU time) of the loop-closure pieces on a realistically filled map:
// warpSince (move what was mapped since the matched visit), realign (restore
// a snapshot, replay frames) and one place-memory search (all steps of the
// resumable search in one go, and the longest single step).
// Usage: npx tsx scripts/perf-warp.ts [WxD=12x15] [seed=2] [seconds=150]
import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import type { WorldModel } from '../src/world/WorldModel';
// CPU time of this process (ms): wall time is meaningless on a loaded machine.
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const [w, d] = (process.argv[2] ?? '12x15').split('x').map(Number);
const seed = Number(process.argv[3] ?? 2);
const seconds = Number(process.argv[4] ?? 150);
let world: WorldModel | null = null;
runLargeArea({ house: generateHouse(seed, w, d), seed, seconds, noise: 'house-hard', game: false, evalEvery: seconds, inspect: (c) => (world = c.world) });
const wm = world! as WorldModel;
const t = wm.now;
const time = (label: string, f: () => void) => {
  const t0 = cpu();
  f();
  console.log(`${label}: ${(cpu() - t0).toFixed(1)}ms`);
};
// One place search, step by step.
{
  const it = wm.placeSearch({ minAge: 15, maxShift: 0.6, maxYaw: 0.18 });
  let max = 0, total = 0, steps = 0;
  const all: [number, number][] = [];
  for (;;) {
    const t0 = cpu();
    const r = it.next();
    const dt = cpu() - t0;
    all.push([dt, steps]);
    max = Math.max(max, dt);
    total += dt;
    steps++;
    if (r.done) break;
  }
  console.log('longest steps (ms @ step):', all.sort((a, b) => b[0] - a[0]).slice(0, 6).map(([d, i]) => `${d.toFixed(1)}@${i}`).join(' '));
  console.log(`placeSearch: ${total.toFixed(1)}ms in ${steps} steps, longest step ${max.toFixed(1)}ms (${wm.placeWhy || 'found'}), place memory ${(wm.placeMemory!.bytes() / 1e6).toFixed(1)}MB in ${wm.placeMemory!.submaps.length} submaps`);
}
time('warpSince(t-120, t) first step', () => wm.warpSince(t - 120, t, { dx: 0.2, dz: -0.1, dyaw: 0.03, pivot: { x: 0, z: 0 } }));
{
  let max = 0, n = 0;
  while (wm.warpBusy) {
    const t0 = cpu();
    wm.stepWarp(2);
    max = Math.max(max, cpu() - t0);
    n++;
  }
  console.log(`warp: ${n} more frames of 2 steps, longest ${max.toFixed(1)}ms`);
}
time('realign (since t-2)', () => wm.realign(0.05, 0.02, 0.01, { x: 0, y: 0, z: 0 }, t - 2));

// Main-thread cost (CPU time) of submaps on anchors during a walk: per depth
// frame, reading anchors and queueing moves (stepAnchors), and the sliced
// submap warps (stepWarp, a few window layers / archive chunks per frame).
// Usage: ANCHORS='{"submaps":true,"sim":{"oracle":true}}' npx tsx scripts/perf-anchors.ts [WxD=12x15] [seed=2] [seconds=300]
import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { WorldModel } from '../src/world/WorldModel';
const cpu = process.env.WALL ? () => performance.now() : () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const [w, d] = (process.argv[2] ?? '12x15').split('x').map(Number);
const seed = Number(process.argv[3] ?? 2);
const seconds = Number(process.argv[4] ?? 300);
import { PlaceMemory } from '../src/world/PlaceMemory';
const times: Record<string, number[]> = { stepAnchors: [], stepWarp: [], ingestDepthImage: [], placeWarp: [], forgetFreeOf: [], startAnchorWarp: [] };
{
  const PM = PlaceMemory.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = PM.warp;
  PM.warp = function (this: unknown, ...a: unknown[]) {
    const t0 = cpu();
    const r = orig.apply(this, a);
    times.placeWarp.push(cpu() - t0);
    return r;
  };
}
const byPhase: Record<string, number> = {};
const P = WorldModel.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const k of Object.keys(times).filter((k) => k !== 'placeWarp')) {
  const orig = P[k];
  P[k] = function (this: unknown, ...a: unknown[]) {
    const ph = (this as WorldModel).warpPhase;
    const t0 = cpu();
    const r = orig.apply(this, a);
    const dt = cpu() - t0;
    times[k].push(dt);
    if (k === 'stepWarp') byPhase[ph] = Math.max(byPhase[ph] ?? 0, dt);
    return r;
  };
}
const rep = runLargeArea({ house: generateHouse(seed, w, d), seed, seconds, noise: (process.env.PROFILE ?? 'house-hard') as 'house-hard', walk: { panSpeed: [2, 5], glanceRate: 0.15 }, anchors: process.env.ANCHORS ? JSON.parse(process.env.ANCHORS) : undefined });
for (const [k, xs] of Object.entries(times)) {
  const s = xs.slice().sort((a, b) => a - b);
  const q = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0);
  console.log(`${k.padEnd(18)} n ${String(s.length).padStart(6)}  mean ${(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(2)}  p95 ${q(0.95).toFixed(2)}  p99 ${q(0.99).toFixed(2)}  max ${q(1).toFixed(1)} ms`);
}
console.log('longest stepWarp by phase (ms):', JSON.stringify(Object.fromEntries(Object.entries(byPhase).map(([a, b]) => [a, +b.toFixed(1)]))));
console.log('anchors', JSON.stringify(rep.events.anchors));

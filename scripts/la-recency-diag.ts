import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { bodyPenetration } from '../src/sim/MapMetrics';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
import { NavGrid } from '../src/world/NavGrid';
import { invertRigid4, mul4 } from '../src/world/WorldModel';
// Nav nodes near the player (3 m) that put the pet inside real furniture
// (through the current frame), by how long ago the low band of their column
// was last seen empty (VoxelGrid.colFree) and by the distance walked since.
// Usage: npx tsx scripts/la-recency-diag.ts 12x15 2 300 [house-hard]
const [w, d] = (process.argv[2] ?? '12x15').split('x').map(Number);
const seed = Number(process.argv[3] ?? 2);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const noise = { ...NOISE_PROFILES[prof], ...JSON.parse(process.env.NOISE ?? '{}') };
const house = generateHouse(seed, w, d);
const tally = new Map<string, { n: number; bad: number }>();
const add = (k: string, bad: boolean) => {
  const e = tally.get(k) ?? { n: 0, bad: 0 };
  e.n++;
  if (bad) e.bad++;
  tally.set(k, e);
};
runLargeArea({
  house,
  seed,
  seconds,
  noise,
  evalEvery: 5,
  walk: { panSpeed: [2, 5], glanceRate: 0.15 },
  anchors: process.env.ANCHORS ? JSON.parse(process.env.ANCHORS) : undefined,
  setup: (world) => Object.assign(world, JSON.parse(process.env.WORLD ?? '{}')),
  inspect: ({ t, world, sensor, cam, room }) => {
    const g = world.grid;
    if (!g || !g.colFree || t < 30) return;
    const nav = new NavGrid(world);
    const T = sensor.trackingFromTruth();
    const M = mul4(invertRigid4(T), world.mapToTracking());
    const cm = world.toMapPoint({ x: T[0] * cam.pos.x + T[8] * cam.pos.z + T[12], y: 1, z: T[2] * cam.pos.x + T[10] * cam.pos.z + T[14] });
    const now = world.timeCode(t), walkedNow = world.walkedAt(now);
    for (let a = 0; a < nav.count; a += 2) {
      const q = nav.pos(a);
      if (Math.hypot(q.x - cm.x, q.z - cm.z) > 3) continue;
      const wpt = { x: M[0] * q.x + M[4] * q.y + M[8] * q.z + M[12], y: M[1] * q.x + M[5] * q.y + M[9] * q.z + M[13], z: M[2] * q.x + M[6] * q.y + M[10] * q.z + M[14] };
      const bad = bodyPenetration(room, wpt) > 0.02;
      const i = g.cellX(q.x), k = g.cellZ(q.z);
      const c = g.colFree[k * g.nx + i];
      const age = c ? now - c : Infinity;
      const walked = c ? walkedNow - world.walkedAt(c) : Infinity;
      add(`age ${age < 5 ? 'a <5s' : age < 15 ? 'b 5-15s' : age < 60 ? 'c 15-60s' : age < 180 ? 'd 1-3min' : age < Infinity ? 'e >3min' : 'f never'}`, bad);
      add(`walk ${walked < 2 ? 'a <2m' : walked < 5 ? 'b 2-5m' : walked < 15 ? 'c 5-15m' : walked < 40 ? 'd 15-40m' : walked < Infinity ? 'e >40m' : 'f never'}`, bad);
      add('all', bad);
    }
  },
});
for (const [k, e] of [...tally].sort()) console.log(`${k.padEnd(20)} n ${String(e.n).padStart(7)}  bad ${((e.bad / e.n) * 100).toFixed(2)}%  (${e.bad})`);

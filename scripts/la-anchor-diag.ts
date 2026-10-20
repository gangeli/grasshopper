import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';
import { invertRigid4, mul4 } from '../src/world/WorldModel';
// What the wrong structure around the player is, with submap anchors: per bad
// obstacle voxel (within 3.5 m, through the current frame, > 8 cm from
// anything real), which submap laid it down (by birth code) and that submap's
// anchor state, and how old it is.
// Usage: ANCHORS='{"submaps":true,"sim":{"oracle":true}}' npx tsx scripts/la-anchor-diag.ts 12x15 2 300 [house-hard]
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
  evalEvery: 10,
  walk: { panSpeed: [2, 5], glanceRate: 0.15 },
  anchors: process.env.ANCHORS ? JSON.parse(process.env.ANCHORS) : undefined,
  setup: (world) => Object.assign(world, JSON.parse(process.env.WORLD ?? '{}')),
  inspect: ({ t, world, sensor, cam, room }) => {
    const g = world.grid;
    if (!g || !g.hitTime || t < 30) return;
    const T = sensor.trackingFromTruth();
    const M = mul4(invertRigid4(T), world.mapToTracking());
    const cm = world.toMapPoint({ x: T[0] * cam.pos.x + T[8] * cam.pos.z + T[12], y: 1, z: T[2] * cam.pos.x + T[10] * cam.pos.z + T[14] });
    const near = (x: number, y: number, z: number, pad: number) => {
      for (const b of room.boxes) if (x > b.min.x - pad && x < b.max.x + pad && y > b.min.y - pad && y < b.max.y + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
      return false;
    };
    const subs = world.submaps;
    const nowCode = world.timeCode(t);
    const j0 = world.floorLayer + 1, j1 = Math.min(g.ny - 1, g.cellY(world.floorY + 1.2));
    for (let k = g.cellZ(cm.z - 3.5); k <= g.cellZ(cm.z + 3.5); k += 2)
      for (let i = g.cellX(cm.x - 3.5); i <= g.cellX(cm.x + 3.5); i += 2) {
        if (!g.inBounds(i, 0, k)) continue;
        const x = g.centerX(i), z = g.centerZ(k);
        if ((x - cm.x) ** 2 + (z - cm.z) ** 2 > 3.5 * 3.5) continue;
        for (let j = j0; j <= j1; j++) {
          const q = g.idx(i, j, k);
          if (g.data[q] <= OCC_THRESHOLD) continue;
          const y = g.centerY(j);
          const rx = M[0] * x + M[4] * y + M[8] * z + M[12], ry = M[1] * x + M[5] * y + M[9] * z + M[13], rz = M[2] * x + M[6] * y + M[10] * z + M[14];
          const bad = !near(rx, ry, rz, 0.08);
          const born = g.hitTime[q] >>> 16;
          let sm = -1;
          for (let s = 0; s < subs.length; s++) if (subs[s].code0 <= born) sm = s;
          const state = born === 0 ? 'unborn' : sm < 0 ? 'before-first' : subs[sm].state;
          const age = nowCode - born;
          const ab = age < 15 ? '<15s' : age < 60 ? '15-60s' : age < 180 ? '1-3min' : '>3min';
          add(`state ${state}`, bad);
          add(`age ${ab}`, bad);
          if (state === 'live') add(`live, age ${ab}`, bad);
          if (state === 'live' && age >= 180) add(`old live submap #${String(sm).padStart(2)} (t ${subs[sm].t.toFixed(0)})`, bad);
        }
      }
  },
});
for (const [k, e] of [...tally].sort()) console.log(`${k.padEnd(28)} n ${String(e.n).padStart(7)}  bad ${((e.bad / e.n) * 100).toFixed(1)}%`);

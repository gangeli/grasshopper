import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { surfaceDistance } from '../src/sim/MapMetrics';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';
// Why is the map around the player wrong? At every metric interval, every
// obstacle voxel within 3.5m of the player (pet band) is taken to reality
// through the current frame and binned by how far it is from real geometry
// and how long ago it was last / first observed.
// Usage: npx tsx scripts/la-local-diag.ts [WxD] [seed] [seconds] [profile]   (env as scripts/large-area.ts: WORLD, DRIFT, WALK, NOISE)
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const house = generateHouse(seed, w, d);
const err = ['<8cm', '8-20', '20-50', '>50'], ageB = ['<5s', '5-15', '15-60', '>60'];
const tot = new Map<string, number>();
runLargeArea({
  house,
  seed,
  seconds,
  noise: { ...NOISE_PROFILES[prof], ...JSON.parse(process.env.NOISE ?? '{}') },
  evalEvery: 30,
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world, stack) => {
    Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
    Object.assign(stack.game.health.drift.opts, JSON.parse(process.env.DRIFT ?? '{}'));
  },
  inspect: ({ world, sensor, cam, room }) => {
    const g = world.grid!;
    const T = sensor.trackingFromTruth();
    const m2t = world.mapToTracking();
    // truth ← tracking ← map
    const inv = (M: number[]) => {
      const o = [M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0, 0, 0, 0, 1];
      o[12] = -(o[0] * M[12] + o[4] * M[13] + o[8] * M[14]);
      o[13] = -(o[1] * M[12] + o[5] * M[13] + o[9] * M[14]);
      o[14] = -(o[2] * M[12] + o[6] * M[13] + o[10] * M[14]);
      return o;
    };
    const Ti = inv(T);
    const ap = (M: number[], p: { x: number; y: number; z: number }) => ({ x: M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12], y: M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13], z: M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14] });
    const cm = world.toMapPoint(ap(T, { x: cam.pos.x, y: 1, z: cam.pos.z }));
    const j0 = world.floorLayer + 1, j1 = g.cellY(world.floorY + 1.2);
    const cnt = new Map<string, number>();
    for (let k = g.cellZ(cm.z - 3.5); k <= g.cellZ(cm.z + 3.5); k += 2)
      for (let i = g.cellX(cm.x - 3.5); i <= g.cellX(cm.x + 3.5); i += 2) {
        if (!g.inBounds(i, 0, k)) continue;
        const x = g.centerX(i), z = g.centerZ(k);
        if ((x - cm.x) ** 2 + (z - cm.z) ** 2 > 3.5 * 3.5) continue;
        for (let j = j0; j <= j1; j++) {
          const n = g.idx(i, j, k);
          if (g.data[n] <= OCC_THRESHOLD) continue;
          const real = ap(Ti, ap(m2t, { x, y: g.centerY(j), z }));
          const e = surfaceDistance(room, real);
          const h = g.hitTime![n], last = g.stamp - (h & 0xffff);
          const key = `${err[e < 0.08 ? 0 : e < 0.2 ? 1 : e < 0.5 ? 2 : 3]}|${ageB[last < 5 ? 0 : last < 15 ? 1 : last < 60 ? 2 : 3]}`;
          cnt.set(key, (cnt.get(key) ?? 0) + 1);
          tot.set(key, (tot.get(key) ?? 0) + 1);
        }
      }
    void cnt;
  },
});
console.log('obstacle voxels near the player: error (rows) by time since last observed (columns), all samples');
console.log('       ' + ageB.map((a) => a.padStart(8)).join(''));
for (const e of err) console.log(e.padEnd(7) + ageB.map((a) => String(tot.get(`${e}|${a}`) ?? 0).padStart(8)).join(''));

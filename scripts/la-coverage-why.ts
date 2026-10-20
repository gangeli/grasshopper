// Why isn't walkable floor covered? At the end of a large-area walk, every
// truly walkable floor cell of the visited rooms that has no nav node is put
// in one bucket: floor never observed / observed but the space above never
// seen empty (depth didn't carve it) / something in the map blocks it
// (an obstacle voxel within the pet's clearance) / other.
// Usage: npx tsx scripts/la-coverage-why.ts [WxD] [seed] [seconds] [profile]  (env CAMERA=1, WALK, WORLD)
import { generateHouse } from '../src/sim/House';
import { fullMap, runLargeArea, walkableTruth } from '../src/sim/largeArea';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const house = generateHouse(seed, w, d);
const truth = walkableTruth(house);
runLargeArea({
  house,
  seed,
  seconds,
  noise: { ...NOISE_PROFILES[prof] },
  evalEvery: Number(process.env.EVERY ?? seconds),
  depthFrom: process.env.CAMERA ? 'camera' : 'sensor',
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world) => Object.assign(world, JSON.parse(process.env.WORLD ?? '{}')),
  inspect: ({ t, world }) => {
    const { world: fw, nav } = fullMap(world, house);
    const g = fw.grid!, fl = fw.floorLayer;
    const b = { covered: 0, unobserved: 0, notSeenFree: 0, blocked: 0, other: 0 };
    for (const p of truth) {
      const n = nav.nearest({ x: p.x, y: fw.floorY, z: p.z }, 0.1);
      if (n >= 0 && Math.abs(nav.ny[n] - fw.floorY) < 0.05) {
        b.covered++;
        continue;
      }
      const i = g.cellX(p.x), k = g.cellZ(p.z);
      if (!g.inBounds(i, fl, k)) {
        b.unobserved++;
        continue;
      }
      if (!g.isObserved(i, k)) {
        b.unobserved++;
        continue;
      }
      let blocked = false;
      for (let dk = -2; dk <= 2 && !blocked; dk++)
        for (let di = -2; di <= 2 && !blocked; di++)
          for (let j = fl; j <= fl + 5; j++)
            if (g.inBounds(i + di, j, k + dk) && g.data[g.idx(i + di, j, k + dk)] > OCC_THRESHOLD) {
              blocked = true;
              break;
            }
      if (blocked) {
        b.blocked++;
        continue;
      }
      let free = 0;
      for (let j = fl + 1; j <= fl + 5; j++) if (g.data[g.idx(i, j, k)] < -1) free++;
      if (free < 2) b.notSeenFree++;
      else b.other++;
    }
    const n = truth.length;
    const pc = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
    console.log(`t ${t.toFixed(0)}s walkable cells ${n}: covered ${pc(b.covered)}, floor unobserved ${pc(b.unobserved)}, space above not seen empty ${pc(b.notSeenFree)}, blocked by a mapped obstacle ${pc(b.blocked)}, other ${pc(b.other)}`);
  },
});

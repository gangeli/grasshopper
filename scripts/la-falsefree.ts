// Where does hallucinated free space (falseFree) come from? Runs one
// large-area walk and, at each metric interval, breaks the falseFree shell
// voxels (inside real furniture, believed seen empty) down by the piece's
// label and material, and by how confident the free belief is.
// Usage: npx tsx scripts/la-falsefree.ts [WxD] [seed] [seconds] [profile]   (env WALK, WORLD, NOISE)
import { generateHouse } from '../src/sim/House';
import { fullMap, runLargeArea } from '../src/sim/largeArea';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const house = generateHouse(seed, w, d);
runLargeArea({
  house,
  seed,
  seconds,
  noise: { ...NOISE_PROFILES[prof], ...JSON.parse(process.env.NOISE ?? '{}') },
  evalEvery: Number(process.env.EVERY ?? 100),
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world) => Object.assign(world, JSON.parse(process.env.WORLD ?? '{}')),
  log: (l) => console.log(l),
  inspect: ({ t, world, room, sensor, cam }) => {
    // LOCAL=1: the live map through the current frame, furniture within 3.5m of the player only.
    const local = !!process.env.LOCAL;
    const fw = local ? world : fullMap(world, house).world, g = fw.grid!;
    const Mi = local ? truthToMap(world, sensor) : null;
    const by = new Map<string, { shell: number; bad: number; deep: number }>();
    for (const b of room.boxes) {
      const pc = room.pieces[b.piece];
      if (pc.label === 'wall') continue;
      if (Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < 0.16) continue;
      if (local && Math.hypot(Math.max(b.min.x - cam.pos.x, 0, cam.pos.x - b.max.x), Math.max(b.min.z - cam.pos.z, 0, cam.pos.z - b.max.z)) > 3.5) continue;
      const key = `${pc.label}/${b.material ?? 'matte'}`;
      let e = by.get(key);
      if (!e) by.set(key, (e = { shell: 0, bad: 0, deep: 0 }));
      for (let y = Math.max(b.min.y, 0.03) + 0.02; y < Math.min(b.max.y, 0.25); y += 0.04)
        for (let x = b.min.x; x <= b.max.x + 1e-6; x += 0.04)
          for (let z = b.min.z; z <= b.max.z + 1e-6; z += 0.04) {
            const edge = Math.min(x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z);
            if (edge <= 0.06 || edge >= 0.11) continue;
            const m = Mi ? xf(Mi, x, y, z) : { x, y, z };
            const i = g.cellX(m.x), j = g.cellY(m.y), k = g.cellZ(m.z);
            if (!g.inBounds(i, j, k)) continue;
            const v = g.data[g.idx(i, j, k)];
            if (v === 0) continue;
            // BOTTOM=1: split by height above the piece's bottom face (voxel straddling it or not).
            if (process.env.BOTTOM) {
              const kb = `${key} ${y - b.min.y < 0.05 ? '<5cm' : '>=5cm'} above bottom`;
              let eb = by.get(kb);
              if (!eb) by.set(kb, (eb = { shell: 0, bad: 0, deep: 0 }));
              eb.shell++;
              if (v < -2) eb.bad++;
              if (v < -20) eb.deep++;
              continue;
            }
            e.shell++;
            if (v < -2) e.bad++;
            if (v < -20) e.deep++;
          }
    }
    let S = 0, B = 0;
    const rows = [...by.entries()].filter(([, e]) => e.shell > 0).sort((a, b) => b[1].bad - a[1].bad);
    for (const [, e] of rows) (S += e.shell), (B += e.bad);
    console.log(`-- t ${t.toFixed(0)}s falseFree ${((B / Math.max(1, S)) * 100).toFixed(1)}% (${B}/${S})`);
    for (const [k, e] of rows.slice(0, 12)) console.log(`   ${k.padEnd(24)} bad ${String(e.bad).padStart(5)} / ${String(e.shell).padStart(5)} (${((e.bad / e.shell) * 100).toFixed(0)}%), confident ${e.deep}  share of all bad ${((e.bad / Math.max(1, B)) * 100).toFixed(0)}%`);
  },
});

function truthToMap(world: import('../src/world/WorldModel').WorldModel, sensor: import('../src/sim/SimSensor').SimSensor): number[] {
  // truth → tracking (T), tracking → map.
  const T = sensor.trackingFromTruth(), A = world.trackingToMap();
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * T[c * 4 + k];
  return o;
}
function xf(M: number[], x: number, y: number, z: number) {
  return { x: M[0] * x + M[4] * y + M[8] * z + M[12], y: M[1] * x + M[5] * y + M[9] * z + M[13], z: M[2] * x + M[6] * y + M[10] * z + M[14] };
}

// Which rays carve the inside of real furniture? Wraps VoxelGrid.integrateRay
// during a large-area walk; for every ray whose carved stretch crosses the
// inside of a real piece (≥6cm in from its sides, ≥5cm above its bottom,
// 3–25cm up; through the current frame chain), classifies the reading:
//  - "long": the reading lies behind the real surface along its own ray
//    (noise, a flying pixel, densified depth across a hole) by > 5cm;
//  - "frame": the reading is right (within 5cm of the real surface along the
//    ray in truth), yet the carved voxel is inside the piece: the map frame
//    and the current frame disagree (the voxel's truth position moved);
//  - "replay": during a replay of buffered frames (realign, floor fix);
//  - plus whether the voxel was already occupied/unknown/free when carved.
// Usage: npx tsx scripts/la-carve-why.ts [WxD] [seed] [seconds] [profile] (env WALK, WORLD, NOISE)
import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { VoxelGrid } from '../src/world/VoxelGrid';
import type { WorldModel } from '../src/world/WorldModel';
import type { SimSensor } from '../src/sim/SimSensor';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
import type { Vec3 } from '../src/core/math';
const [w, d] = (process.argv[2] ?? '12x15').split('x').map(Number);
const seed = Number(process.argv[3] ?? 2);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const house = generateHouse(seed, w, d);
const room = house.room;
let M: number[] | null = null; // map → truth
let W: WorldModel | null = null, S: SimSensor | null = null;
const mul = (A: ArrayLike<number>, B: ArrayLike<number>) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
  return o;
};
const inv = (T: ArrayLike<number>) => {
  const R = [T[0], T[4], T[8], 0, T[1], T[5], T[9], 0, T[2], T[6], T[10], 0, 0, 0, 0, 1];
  R[12] = -(R[0] * T[12] + R[4] * T[13] + R[8] * T[14]);
  R[13] = -(R[1] * T[12] + R[5] * T[13] + R[9] * T[14]);
  R[14] = -(R[2] * T[12] + R[6] * T[13] + R[10] * T[14]);
  return R;
};
const xf = (A: number[], p: Vec3) => ({ x: A[0] * p.x + A[4] * p.y + A[8] * p.z + A[12], y: A[1] * p.x + A[5] * p.y + A[9] * p.z + A[13], z: A[2] * p.x + A[6] * p.y + A[10] * p.z + A[14] });
const furn = room.boxes.filter((b) => room.pieces[b.piece].label !== 'wall' && Math.min(b.max.x - b.min.x, b.max.z - b.min.z) >= 0.16);
const inside = (p: Vec3) => {
  for (const b of furn) {
    if (p.y < Math.max(b.min.y + 0.05, 0.03) || p.y > Math.min(b.max.y, 0.25)) continue;
    const e = Math.min(p.x - b.min.x, b.max.x - p.x, p.z - b.min.z, b.max.z - p.z);
    if (e >= 0.06) return b;
  }
  return null;
};
const counts = new Map<string, number>();
const add = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
const orig = VoxelGrid.prototype.integrateRay;
VoxelGrid.prototype.integrateRay = function (this: VoxelGrid, from: Vec3, to: Vec3, hit: boolean, hitDelta = 14, missDelta = -3, carveShort = this.res * 1.5) {
  if (M && W && W.grid === this) {
    const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const carveLen = Math.max(0, len - carveShort);
    // Sample the carved stretch every 2.5cm (cheap stand-in for the voxel walk).
    let hitPiece: (typeof furn)[number] | null = null, at = 0, vBefore = 0;
    for (let t = 0.1; t < carveLen; t += 0.025) {
      const u = t / len;
      const m = { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u, z: from.z + (to.z - from.z) * u };
      const tr = xf(M, m);
      if (tr.y > 0.3) continue;
      const b = inside(tr);
      if (b) {
        hitPiece = b;
        at = t;
        vBefore = this.get(this.cellX(m.x), this.cellY(m.y), this.cellZ(m.z));
        break;
      }
    }
    if (hitPiece) {
      const pc = room.pieces[hitPiece.piece];
      const key = `${pc.label}/${hitPiece.material ?? 'matte'}`;
      // The reading in truth vs the real surface along the same (true) ray.
      const e = xf(M, from), p = xf(M, to);
      const L = Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z);
      const dir = { x: (p.x - e.x) / L, y: (p.y - e.y) / L, z: (p.z - e.z) / L };
      const rc = room.raycast(e, dir, 20);
      const floorT = dir.y < -1e-6 ? -e.y / dir.y : Infinity;
      const real = Math.min(rc.t, floorT);
      const replay = (W as unknown as { replaying: boolean }).replaying;
      const why = replay ? 'replay' : L > real + 0.05 ? (hit ? 'long(hit)' : missDelta === -1 && !hit ? 'long(far/noisy)' : 'long(floor)') : 'frame';
      const state = vBefore > 20 ? 'occ' : vBefore > 0 ? 'weak+' : vBefore === 0 ? 'unknown' : vBefore > -20 ? 'free' : 'deepfree';
      add(`${why}`);
      add(`${why} | ${key}`);
      add(`${why} | was ${state}`);
      if (why.startsWith('long')) add(`long by ${L - real < 0.15 ? '5-15cm' : L - real < 0.5 ? '15-50cm' : '>50cm'} | ${key}`);
      add(`total`);
      add(`depth into piece ${at > 0 ? '' : ''}`, 0);
    }
  }
  return orig.call(this, from, to, hit, hitDelta, missDelta, carveShort);
};
runLargeArea({
  house,
  seed,
  seconds,
  noise: { ...NOISE_PROFILES[prof], ...JSON.parse(process.env.NOISE ?? '{}') },
  evalEvery: 60,
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world, _stack, sensor) => {
    Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
    W = world;
    S = sensor;
    const ing = world.ingestDepthImage.bind(world);
    world.ingestDepthImage = (img, t, em) => {
      M = mul(inv(S!.trackingFromTruth()), world.mapToTracking());
      return ing(img, t, em);
    };
  },
  log: process.env.VERBOSE ? (l) => console.log(l) : undefined,
});
const tot = counts.get('total') ?? 1;
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) if (v) console.log(`${k.padEnd(50)} ${String(v).padStart(7)} (${((v / tot) * 100).toFixed(1)}%)`);

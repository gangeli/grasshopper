// Are the place-memory submaps right? For every submap, take its cells back
// to reality through the map frame of its own time (simulator ground truth)
// and count how many land on real geometry (within 8cm). A submap that was
// right when made but is wrong later was moved wrongly (warp, realign); one
// wrong from the start was built from bad frames.
// Usage: npx tsx scripts/la-place-check.ts [WxD] [seed] [seconds]   (env PROFILE, WALK, WORLD, DRIFT)
import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { NOISE_PROFILES } from '../src/sim/SimSensor';
import { PlaceMemory, type Submap } from '../src/world/PlaceMemory';
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 300);
const house = generateHouse(seed, w, d);
type M = number[];
const mul = (A: M, B: M): M => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return o; };
const inv = (M: M): M => { const o = [M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0, 0, 0, 0, 1]; o[12] = -(o[0] * M[12] + o[4] * M[13] + o[8] * M[14]); o[13] = -(o[1] * M[12] + o[5] * M[13] + o[9] * M[14]); o[14] = -(o[2] * M[12] + o[6] * M[13] + o[10] * M[14]); return o; };
const hist: { t: number; M: M }[] = []; // map <- truth
const room = house.room;
const near = (x: number, y: number, z: number, pad: number) => {
  for (const b of room.boxes) if (x > b.min.x - pad && x < b.max.x + pad && y > b.min.y - pad && y < b.max.y + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
  return false;
};
const at = (t: number) => {
  let h = hist[0];
  for (const e of hist) if (e.t <= t) h = e;
  return h.M;
};
/** Share of a submap's cells on real geometry, taken to reality through map frame of time t. */
const quality = (s: Submap, t: number, own = false) => {
  const Mi = inv(own ? subM.get(s) ?? at((s.t0 + s.t1) / 2) : at(t));
  let good = 0, n = 0;
  for (let q = 0; q < s.cells.length; q += 3 * 4) {
    const x = s.cells[q] / 100, y = s.cells[q + 1] / 100, z = s.cells[q + 2] / 100;
    const rx = Mi[0] * x + Mi[4] * y + Mi[8] * z + Mi[12], ry = Mi[1] * x + Mi[5] * y + Mi[9] * z + Mi[13], rz = Mi[2] * x + Mi[6] * y + Mi[10] * z + Mi[14];
    n++;
    if (near(rx, ry, rz, 0.08)) good++;
  }
  return n ? good / n : 1;
};
const firstQ = new Map<Submap, number>();
// Each submap's own truth -> map transform: the map frame of its time, then every move applied to it since.
const subM = new Map<Submap, M>();
const proto = PlaceMemory.prototype as unknown as { transform: (s: Submap, cs: number, sn: number, tx: number, tz: number, p: { x: number; z: number }) => void };
const origT = proto.transform;
proto.transform = function (s, cs, sn, tx, tz, p) {
  const T = [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, p.x - (cs * p.x + sn * p.z) + tx, 0, p.z - (-sn * p.x + cs * p.z) + tz, 1];
  const cur = subM.get(s) ?? at((s.t0 + s.t1) / 2);
  subM.set(s, mul(T, cur));
  origT.call(this, s, cs, sn, tx, tz, p);
};
runLargeArea({
  house, seed, seconds,
  noise: { ...NOISE_PROFILES[(process.env.PROFILE ?? 'house-hard') as 'house-hard'] },
  evalEvery: Number(process.env.EVERY ?? 60),
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world, stack, sensor) => {
    Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
    Object.assign(stack.game.health.drift.opts, JSON.parse(process.env.DRIFT ?? '{}'));
    const orig = world.ingestDepthImage.bind(world);
    (world as unknown as { ingestDepthImage: typeof orig }).ingestDepthImage = (img, t, e) => {
      const Mt = mul(inv(world.mapToTracking()), sensor.trackingFromTruth());
      if (!hist.length || world.now - hist[hist.length - 1].t >= 0.1) hist.push({ t: world.now, M: Mt });
      const r = orig(img, t, e);
      // New submaps: quality when made (through the frame of their time).
      for (const s of world.placeMemory?.submaps ?? []) if (!firstQ.has(s)) firstQ.set(s, quality(s, (s.t0 + s.t1) / 2));
      return r;
    };
  },
  inspect: ({ t, world }) => {
    const subs = world.placeMemory?.submaps ?? [];
    // Now: through the submap's own transform (its time's frame and every move since): did a move break it?
    const qs = subs.map((s) => ({ s, made: firstQ.get(s) ?? NaN, now: quality(s, t, true) }));
    const bad = qs.filter((q) => q.now < 0.6);
    const madeBad = qs.filter((q) => q.made < 0.6);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    console.log(`t ${t.toFixed(0)} submaps ${subs.length} (${((world.placeMemory?.bytes() ?? 0) / 1e6).toFixed(1)}MB) quality when made ${(mean(qs.map((q) => q.made)) * 100).toFixed(0)}% now ${(mean(qs.map((q) => q.now)) * 100).toFixed(0)}% | bad now ${bad.length}, bad when made ${madeBad.length}`);
    for (const q of bad.slice(0, 6)) console.log(`   bad ${q.s.t0.toFixed(1)}-${q.s.t1.toFixed(1)} made ${(q.made * 100).toFixed(0)}% now ${(q.now * 100).toFixed(0)}% cells ${q.s.cells.length / 3}`);
  },
});

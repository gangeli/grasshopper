// Why does the pet stand inside furniture? Runs one large-area walk and, every
// EVERY seconds, takes the nav nodes within 3m of the player in the live map,
// puts the pet's body there in reality (through the current frame) and, for
// the nodes that are inside real furniture (>2cm), looks up what the map
// believes at the penetrating body points: carved free (data < -2), weakly
// free, unknown (0), guessed solid, or occupied (then the node exists because
// the map's copy of the object is displaced: frame error). Broken down by the
// piece's label/material and by the age of the free evidence.
// Usage: npx tsx scripts/la-petcoll.ts [WxD] [seed] [seconds] [profile]   (env WALK, WORLD, NOISE, EVERY)
import { generateHouse } from '../src/sim/House';
import { hideCorePenetration, runLargeArea } from '../src/sim/largeArea';
import { penetration } from '../src/sim/MapMetrics';
import { NavGrid } from '../src/world/NavGrid';
import { findHideSpots } from '../src/game/HideSpots';
import { Rng } from '../src/core/rng';
import { objectNear, segmentObjects } from '../src/world/Segmentation';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const house = generateHouse(seed, w, d);
const BODY: { x: number; y: number; z: number }[] = [];
for (const h of [0.04, 0.12, 0.2]) for (let a = 0; a < 8; a++) BODY.push({ x: Math.cos((a / 8) * Math.PI * 2) * 0.07, y: h, z: Math.sin((a / 8) * Math.PI * 2) * 0.07 });
BODY.push({ x: 0, y: 0.12, z: 0 });
const tot = new Map<string, number>();
const byPiece = new Map<string, number>();
let nodes = 0, bad = 0, spotsN = 0, spotsBad = 0, openN = 0;
const ageBins = new Map<string, { n: number; bad: number }>();
const distBins = new Map<string, { n: number; bad: number }>();
const openLabels = new Map<string, number>();
const objStats = new Map<string, number>();
const spotWhy = new Map<string, number>();
const rng = new Rng(3);
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
const xf = (M: number[], p: { x: number; y: number; z: number }) => ({ x: M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12], y: M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13], z: M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14] });
runLargeArea({
  house,
  seed,
  seconds,
  noise: { ...NOISE_PROFILES[prof], ...JSON.parse(process.env.NOISE ?? '{}') },
  evalEvery: Number(process.env.EVERY ?? 20),
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world) => Object.assign(world, JSON.parse(process.env.WORLD ?? '{}')),
  log: process.env.VERBOSE ? (l) => console.log(l) : undefined,
  inspect: ({ world, sensor, cam, room }) => {
    const g = world.grid;
    if (!g) return;
    const nav = new NavGrid(world);
    const M = mul(inv(sensor.trackingFromTruth()), world.mapToTracking()); // map → truth
    const Mi = inv(M);
    const T = sensor.trackingFromTruth(), p = cam.pos;
    const cm = world.toMapPoint({ x: T[0] * p.x + T[4] * p.y + T[8] * p.z + T[12], y: 1, z: T[2] * p.x + T[6] * p.y + T[10] * p.z + T[14] });
    g.updateShadow();
    for (let a = 0; a < nav.count; a += 2) {
      const q = nav.pos(a);
      if (Math.hypot(q.x - cm.x, q.z - cm.z) > 3) continue;
      nodes++;
      const t = xf(M, q);
      let worst = 0, wp: { x: number; y: number; z: number } | null = null;
      for (const o of BODY) {
        const bp = { x: t.x + o.x, y: t.y + o.y, z: t.z + o.z };
        const pen = penetration(room, bp);
        if (pen > worst) (worst = pen), (wp = bp);
      }
      if (worst <= 0.02 || !wp) continue;
      bad++;
      // The piece and what the map says at the deepest body point.
      let piece = '?';
      for (const b of room.boxes)
        if (wp.x > b.min.x && wp.x < b.max.x && wp.y > b.min.y && wp.y < b.max.y && wp.z > b.min.z && wp.z < b.max.z) piece = `${room.pieces[b.piece].label}/${b.material ?? 'matte'}`;
      const m = xf(Mi, wp);
      const i = g.cellX(m.x), j = g.cellY(m.y), k = g.cellZ(m.z);
      let what = 'out';
      if (g.inBounds(i, j, k)) {
        const v = g.data[g.idx(i, j, k)];
        what = v > OCC_THRESHOLD ? 'occupied(displaced?)' : v >= 10 ? 'soft' : v > 0 ? 'weak+' : v === 0 ? 'unknown' : v >= -2 ? 'weak-free' : v >= -8 ? 'free(-3..-8)' : v >= -20 ? 'free(-9..-20)' : 'free(<-20)';
        // Is real furniture within 10cm of the node's map copy? (occupied voxel near the truth point in the map)
      }
      const key = `${what}`;
      tot.set(key, (tot.get(key) ?? 0) + 1);
      byPiece.set(piece, (byPiece.get(piece) ?? 0) + 1);
    }
    // Open floor near the player (no real furniture or wall within 50cm): what the game would call it.
    const objs = segmentObjects(world);
    for (let a = 0; a < nav.count; a += 5) {
      const q = nav.pos(a);
      if (Math.abs(q.y - world.floorY) > 0.05 || Math.hypot(q.x - cm.x, q.z - cm.z) > 3) continue;
      const t = xf(M, q);
      if (room.solidAt({ x: t.x, y: 0.05, z: t.z }, 0.5) || room.solidAt({ x: t.x, y: 0.3, z: t.z }, 0.5) || room.solidAt({ x: t.x, y: 1.0, z: t.z }, 0.5)) continue;
      openN++;
      const o = objectNear(objs, q);
      if (o) openLabels.set(o.label, (openLabels.get(o.label) ?? 0) + 1);
      if (o && process.env.OBJ) {
        // What is it in reality? Real furniture within 10cm of its footprint centre?
        const c = xf(M, { x: (o.min.x + o.max.x) / 2, y: world.floorY + 0.05, z: (o.min.z + o.max.z) / 2 });
        const real = room.solidAt({ x: c.x, y: Math.min(0.3, (o.max.y - o.min.y) / 2), z: c.z }, 0.1);
        const key = `${o.label} h${((o.max.y - o.min.y) * 100).toFixed(0)}cm cols ${o.columns} ${real ? 'REAL' : 'phantom'}`;
        objStats.set(key, (objStats.get(key) ?? 0) + 1);
      }
    }
    // Hide spots the game would pick from here.
    const eye = world.toMapPoint({ x: T[0] * p.x + T[4] * p.y + T[8] * p.z + T[12], y: T[1] * p.x + T[5] * p.y + T[9] * p.z + T[13], z: T[2] * p.x + T[6] * p.y + T[10] * p.z + T[14] });
    const pet = nav.count ? nav.pos(nav.nearest({ x: cm.x, y: world.floorY, z: cm.z }, 2) >= 0 ? nav.nearest({ x: cm.x, y: world.floorY, z: cm.z }, 2) : 0) : null;
    if (!pet) return;
    const spots = findHideSpots(nav, pet, eye, { difficulty: 0.5, maxPathCost: 9, previous: [], rng, objects: [], eyeHeight: 1.4, minHiddenNow: 0.85 }, world.floorY);
    for (const s of spots) {
      spotsN++;
      const t = xf(M, s.pos);
      const worst = hideCorePenetration(room, t);
      // How long since the structure around the spot (occupied voxels within 30cm, up to 60cm high) was last seen, and the walk since.
      let last = 0;
      if (g.hitTime) {
        const ci = g.cellX(s.pos.x), ck = g.cellZ(s.pos.z), cj = g.cellY(s.pos.y);
        for (let dk = -6; dk <= 6; dk++)
          for (let di = -6; di <= 6; di++)
            for (let dj = 0; dj <= 12; dj++) {
              const i = ci + di, j = cj + dj, k = ck + dk;
              if (!g.inBounds(i, j, k) || g.data[g.idx(i, j, k)] <= OCC_THRESHOLD) continue;
              last = Math.max(last, g.hitTime[g.idx(i, j, k)] & 0xffff);
            }
      }
      // Distance from the spot to the nearest occupied (or shadowed-solid) voxel at body height (5–25cm), in the map.
      let dmin = 9;
      {
        const ci = g.cellX(s.pos.x), ck = g.cellZ(s.pos.z), cj = g.cellY(s.pos.y + 0.001);
        for (let dk = -6; dk <= 6; dk++)
          for (let di = -6; di <= 6; di++)
            for (let dj = 1; dj <= 4; dj++) {
              const i = ci + di, j = cj + dj, k = ck + dk;
              if (!g.inBounds(i, j, k)) continue;
              if (g.data[g.idx(i, j, k)] > OCC_THRESHOLD || g.shadowAt(i, j, k)) dmin = Math.min(dmin, Math.hypot(di, dk) * g.res);
            }
      }
      const dbin = dmin < 0.125 ? 'd<12.5cm' : dmin < 0.175 ? 'd 12.5-17.5cm' : dmin < 0.25 ? 'd 17.5-25cm' : 'd>=25cm';
      const db = distBins.get(dbin) ?? { n: 0, bad: 0 };
      db.n++;
      if (worst > 0.02) db.bad++;
      distBins.set(dbin, db);
      const walkedSince = last ? world.walked - world.walkedAt(last) : -1;
      const bin = walkedSince < 0 ? 'no cover' : walkedSince < 5 ? 'walked <5m' : walkedSince < 20 ? 'walked 5-20m' : walkedSince < 60 ? 'walked 20-60m' : 'walked >60m';
      const ab = ageBins.get(bin) ?? { n: 0, bad: 0 };
      ab.n++;
      if (worst > 0.02) ab.bad++;
      ageBins.set(bin, ab);
      let wp: { x: number; y: number; z: number } | null = null, wb = 0;
      for (const o of BODY) {
        const bp = { x: t.x + o.x, y: t.y + o.y, z: t.z + o.z };
        const pen = penetration(room, bp);
        if (pen > wb) (wb = pen), (wp = bp);
      }
      if (worst <= 0.02 || !wp) continue;
      spotsBad++;
      let piece = '?';
      for (const b of room.boxes)
        if (wp.x > b.min.x && wp.x < b.max.x && wp.y > b.min.y && wp.y < b.max.y && wp.z > b.min.z && wp.z < b.max.z) piece = `${room.pieces[b.piece].label}/${b.material ?? 'matte'}`;
      const m = xf(Mi, wp);
      const v = g.get(g.cellX(m.x), g.cellY(m.y), g.cellZ(m.z));
      const key = `${s.kind} ${piece} pen ${(worst * 100).toFixed(0)}cm map ${v}`;
      if (process.env.SPOTS) console.log(`  bad spot: ${key}`);
      const k2 = `${s.kind} ${piece} ${v === 0 ? 'unknown' : v < -2 ? 'free' : v > 20 ? 'occ' : 'weak'}`;
      spotWhy.set(k2, (spotWhy.get(k2) ?? 0) + 1);
    }
  },
});
console.log(`${w}x${d} s${seed} ${seconds}s: nodes near player ${nodes}, inside furniture ${bad} (${((bad / Math.max(1, nodes)) * 100).toFixed(1)}%)`);
console.log('map belief at the deepest penetrating body point:');
for (const [k, v] of [...tot.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v} (${((v / bad) * 100).toFixed(0)}%)`);
console.log('pieces:');
for (const [k, v] of [...byPiece.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${k.padEnd(24)} ${v} (${((v / bad) * 100).toFixed(0)}%)`);
console.log(`hide spots: ${spotsN}, inside furniture ${spotsBad} (${((spotsBad / Math.max(1, spotsN)) * 100).toFixed(1)}%)`);
for (const [k, v] of [...spotWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${k.padEnd(40)} ${v}`);
console.log(`open floor nodes near the player: ${openN}; called near an object:`);
for (const [k, v] of [...openLabels.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v} (${((v / Math.max(1, openN)) * 100).toFixed(1)}%)`);
console.log('hide spots by walk since their cover was last seen:');
for (const [k, v] of [...ageBins.entries()].sort()) console.log(`  ${k.padEnd(16)} ${v.n} spots, ${v.bad} inside furniture (${((v.bad / Math.max(1, v.n)) * 100).toFixed(1)}%)`);
console.log('hide spots by distance to the nearest mapped obstacle at body height:');
for (const [k, v] of [...distBins.entries()].sort()) console.log(`  ${k.padEnd(16)} ${v.n} spots, ${v.bad} inside furniture (${((v.bad / Math.max(1, v.n)) * 100).toFixed(1)}%)`);
if (process.env.OBJ) for (const [k, v] of [...objStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  obj ${k.padEnd(40)} ${v}`);

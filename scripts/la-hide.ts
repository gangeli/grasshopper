// Hide-spot policies side by side on the same walk: one large-area run, and
// every EVERY seconds the game's hide-spot search (seeker at the camera, pet
// near the player) under each policy in POLICIES, scored in reality through
// the current frame: spots whose crouched pet is inside real furniture, and
// how often a policy finds no spot at all.
// Usage: npx tsx scripts/la-hide.ts [WxD] [seed] [seconds] [profile]   (env EVERY, WALK, WORLD, NOISE, MOVE, DARK, POLICIES=json, JSON=out)
import { darkenFurniture, generateHouse } from '../src/sim/House';
import { hideCorePenetration, runLargeArea } from '../src/sim/largeArea';
import { NavGrid } from '../src/world/NavGrid';
import { findHideSpots, type HideOptions } from '../src/game/HideSpots';
import { Rng } from '../src/core/rng';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
import { writeFileSync } from 'node:fs';
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 600);
const prof = (process.argv[5] ?? 'house-hard') as NoiseName;
const house = generateHouse(seed, w, d);
if (process.env.DARK) darkenFurniture(house.room, Number(process.env.DARK), seed);
const POLICIES: Record<string, Partial<HideOptions>> = JSON.parse(process.env.POLICIES ?? '{"none":{"minClearance":0,"minSeenFree":0},"default":{}}');
const res: Record<string, { rounds: number; none: number; spots: number; bad: number; kinds: Record<string, number> }> = {};
for (const k of Object.keys(POLICIES)) res[k] = { rounds: 0, none: 0, spots: 0, bad: 0, kinds: {} };
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
  evalEvery: Number(process.env.EVERY ?? 10),
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world) => Object.assign(world, JSON.parse(process.env.WORLD ?? '{}')),
  moveFurniture: process.env.MOVE ? JSON.parse(process.env.MOVE) : undefined,
  inspect: ({ world, sensor, cam, room }) => {
    if (!world.grid) return;
    const nav = new NavGrid(world);
    if (nav.count < 50) return;
    const M = mul(inv(sensor.trackingFromTruth()), world.mapToTracking());
    const T = sensor.trackingFromTruth(), p = cam.pos;
    const eye = world.toMapPoint({ x: T[0] * p.x + T[4] * p.y + T[8] * p.z + T[12], y: T[1] * p.x + T[5] * p.y + T[9] * p.z + T[13], z: T[2] * p.x + T[6] * p.y + T[10] * p.z + T[14] });
    const n0 = nav.nearest({ x: eye.x, y: world.floorY, z: eye.z }, 2);
    if (n0 < 0) return;
    const pet = nav.pos(n0);
    for (const [name, pol] of Object.entries(POLICIES)) {
      const r = res[name];
      r.rounds++;
      let spots: ReturnType<typeof findHideSpots> = [];
      // As the game does: properly hidden first, then settle for less.
      for (const minHiddenNow of [0.85, 0.5, 0]) {
        spots = findHideSpots(nav, pet, eye, { difficulty: 0.5, maxPathCost: 9, previous: [], rng: new Rng(7), objects: [], eyeHeight: 1.4, minHiddenNow, ...pol }, world.floorY);
        if (spots.length) break;
      }
      if (!spots.length) {
        r.none++;
        continue;
      }
      // The game takes the best one it can reach: score the top spot, and the top 5 for statistics.
      for (const s of spots) {
        r.spots++;
        r.kinds[s.kind] = (r.kinds[s.kind] ?? 0) + 1;
        if (hideCorePenetration(room, xf(M, s.pos)) > 0.02) r.bad++;
      }
    }
  },
});
console.log(`${w}x${d} s${seed}:`);
for (const [k, r] of Object.entries(res)) console.log(`  ${k.padEnd(14)} rounds ${r.rounds} no-spot ${r.none} spots ${r.spots} inside furniture ${r.bad} (${((r.bad / Math.max(1, r.spots)) * 100).toFixed(1)}%) kinds ${JSON.stringify(r.kinds)}`);
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify(res));

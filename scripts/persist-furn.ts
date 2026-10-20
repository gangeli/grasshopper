/**
 * Which "furniture" agrees in a placement? Bare symmetric home, A maps one
 * room, B another; prints the live furniture samples that hit, in room
 * coordinates, with what's really there.
 *   npx tsx scripts/persist-furn.ts [homeSeed] [roomA] [roomB]
 */
import { makeHome } from '../src/sim/Home';
import { dressRoom } from '../src/sim/Realism';
import { SimSession } from '../src/sim/MultiSession';
import { exportLive } from '../src/world/persist/adapter';
import { extractFeatures, FragmentLookup } from '../src/world/persist/features';
import { FragmentIndex, relocalize, runToEnd } from '../src/world/persist/Relocalizer';
import { applyPose, invertPose } from '../src/world/persist/pose';

const seed = Number(process.argv[2] ?? 21), ra = Number(process.argv[3] ?? 1), rb = Number(process.argv[4] ?? 0);
const home = makeHome(seed, { symmetric: true, furnish: 0 });
dressRoom(home.room, seed);
const A = new SimSession({ home, rooms: [ra], seconds: 60, seed: seed * 10 + 1 });
while (A.step());
const B = new SimSession({ home, rooms: [rb], seconds: 40, seed: seed * 10 + 2 });
while (B.step());
const mA = exportLive(A.world)!, mB = exportLive(B.world)!;
const frag = new FragmentIndex(extractFeatures(mA), new FragmentLookup(mA));
const fB = extractFeatures(mB);
const r = runToEnd(relocalize({ features: fB, lookup: new FragmentLookup(mB) }, frag));
console.log('accepted', r.accepted, r.reason, 'objects', r.best?.metrics?.lowObjects, 'low', r.best?.metrics?.lowN, r.best?.metrics?.lowHit);
if (r.best) {
  const T = r.best.pose, toRoom = invertPose(B.truth);
  const c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  const seen = new Map<string, number>();
  for (let q = 0; q < fB.occ.n; q++) {
    if (fB.occ.low[q] !== 1) continue;
    const x = fB.occ.x[q], z = fB.occ.z[q];
    const fx = c * x - s * z + T.tx, fz = s * x + c * z + T.tz;
    const k = frag.lookup.classAt(fx, fz, fB.occ.j[q] + (T.dj ?? 0));
    if (k < 1 || k > 3 || frag.lookup.tallAt(fx, fz)) continue;
    const p = applyPose(toRoom, x, z);
    const what = home.room.pieces.find((pc) => p.x > pc.min.x - 0.1 && p.x < pc.max.x + 0.1 && p.z > pc.min.z - 0.1 && p.z < pc.max.z + 0.1)?.label ?? 'nothing';
    const key = `${what} y=${(fB.occ.j[q] * 0.05).toFixed(2)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  console.log([...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
}

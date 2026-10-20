/**
 * Quick relocalization experiment: session A maps rooms, session B (a fresh
 * random frame) maps some rooms; can B find itself in A's map?
 *   npx tsx scripts/persist-reloc.ts [seeds=5] [secondsB=30]
 */
import { makeHome } from '../src/sim/Home';
import { dressRoom } from '../src/sim/Realism';
import { SimSession } from '../src/sim/MultiSession';
import { exportLive } from '../src/world/persist/adapter';
import { extractFeatures, FragmentLookup } from '../src/world/persist/features';
import { FragmentIndex, relocalize, runToEnd } from '../src/world/persist/Relocalizer';
import { composePose, invertPose, poseDelta } from '../src/world/persist/pose';

const seeds = Number(process.argv[2] ?? 5);
const secB = Number(process.argv[3] ?? 30);
const first = Number(process.argv[4] ?? 1);
for (let seed = first; seed <= seeds; seed++) {
  const home = makeHome(seed);
  dressRoom(home.room, seed);
  const t0 = performance.now();
  const A = new SimSession({ home, rooms: [0, 1], seconds: 90, seed: seed * 10 + 1 });
  while (A.step());
  const B = new SimSession({ home, rooms: [seed % 2 === 0 ? 2 : 0], seconds: secB, seed: seed * 10 + 2 });
  while (B.step());
  const t1 = performance.now();
  const mA = exportLive(A.world)!, mB = exportLive(B.world)!;
  const fA = extractFeatures(mA), fB = extractFeatures(mB);
  const frag = new FragmentIndex(fA, new FragmentLookup(mA));
  const live = { features: fB, lookup: new FragmentLookup(mB) };
  const t2 = performance.now();
  const r = runToEnd(relocalize(live, frag));
  const t3 = performance.now();
  const truth = composePose(A.truth, invertPose(B.truth));
  const at = { x: (fB.bbox!.x0 + fB.bbox!.x1) / 2, z: (fB.bbox!.z0 + fB.bbox!.z1) / 2 };
  const err = r.best ? poseDelta(r.best.pose, truth, at) : null;
  const shouldMatch = seed % 2 !== 0;
  console.log(
    `seed ${seed} ${shouldMatch ? 'SAME ' : 'OTHER'} sim ${((t1 - t0) / 1000).toFixed(1)}s prep ${(t2 - t1).toFixed(0)}ms search ${(t3 - t2).toFixed(0)}ms N=${r.work.fftN} ` +
      `accepted=${r.accepted} (${r.reason}) err=${err ? `${(err.dist * 100).toFixed(1)}cm ${((err.dyaw * 180) / Math.PI).toFixed(2)}°` : '-'} ` +
      `amb=${r.ambiguity.toFixed(2)} second=${r.second ? (() => { const d = poseDelta(r.second.pose, r.best!.pose, at); return `Δ${(d.dist * 100).toFixed(0)}cm/${((d.dyaw * 180) / Math.PI).toFixed(1)}° ${JSON.stringify(r.second.metrics)}`; })() : '-'} best=${r.best?.metrics ? JSON.stringify({ ...r.best.metrics, inlier: +r.best.metrics.inlier.toFixed(2), explained: +r.best.metrics.explained.toFixed(2) }) : '-'}`,
  );
}

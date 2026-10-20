/**
 * Where does relocalization time go? Times each phase on one pair of sessions,
 * and the longest single slice (generator step).
 *   npx tsx scripts/persist-prof.ts [homeSeed]
 */
import { makeHome } from '../src/sim/Home';
import { dressRoom } from '../src/sim/Realism';
import { SimSession } from '../src/sim/MultiSession';
import { exportLiveGen } from '../src/world/persist/adapter';
import { extractFeaturesGen, FragmentLookup } from '../src/world/persist/features';
import { FragmentIndex, relocalize } from '../src/world/persist/Relocalizer';
import type { Work } from '../src/world/persist/gen';

const seed = Number(process.argv[2] ?? 3);
const home = makeHome(seed);
dressRoom(home.room, seed);
const A = new SimSession({ home, rooms: [0, 1], seconds: 60, seed: seed * 10 + 1, halfExtent: 6 });
while (A.step());
const B = new SimSession({ home, rooms: [0], seconds: 40, seed: seed * 10 + 2, halfExtent: 6 });
while (B.step());

function timed<T>(name: string, g: Work<T>): T {
  const t0 = performance.now();
  let worst = 0, steps = 0;
  for (;;) {
    const s0 = performance.now();
    const r = g.next();
    worst = Math.max(worst, performance.now() - s0);
    steps++;
    if (r.done) {
      console.log(`${name.padEnd(22)} total ${(performance.now() - t0).toFixed(1).padStart(7)}ms  steps ${String(steps).padStart(5)}  longest step ${worst.toFixed(2)}ms`);
      return r.value;
    }
  }
}
for (let rep = 0; rep < 2; rep++) {
  const mA = timed('export A', exportLiveGen(A.world))!;
  const mB = timed('export B', exportLiveGen(B.world))!;
  const fA = timed('features A', extractFeaturesGen(mA));
  const lA = timed('lookup A', FragmentLookup.create(mA));
  const fB = timed('features B', extractFeaturesGen(mB));
  const lB = timed('lookup B', FragmentLookup.create(mB));
  const idx = new FragmentIndex(fA, lA);
  const r = timed('relocalize', relocalize({ features: fB, lookup: lB }, idx));
  console.log(`  → ${r.accepted} ${r.reason} sig ${idx.sig.w}x${idx.sig.h} fftN ${r.work.fftN} yaws ${r.work.yaws} poses ${r.work.poses} coarse ${r.work.coarseMs.toFixed(0)}ms refine ${r.work.refineMs.toFixed(0)}ms`);
}

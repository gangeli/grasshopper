/**
 * One relocalization pair, with all metrics printed (debugging).
 *   npx tsx scripts/persist-pair.ts <homeSeed> <roomsA e.g. 0,1> <roomsB e.g. 2> [noise] [secondsB] [layout e.g. 2x2]
 */
import { makeHome } from '../src/sim/Home';
import { SimSession } from '../src/sim/MultiSession';
import { exportLive } from '../src/world/persist/adapter';
import { extractFeatures, FragmentLookup } from '../src/world/persist/features';
import { FragmentIndex, relocalize, runToEnd, verifyPose } from '../src/world/persist/Relocalizer';
import { composePose, invertPose, poseDelta } from '../src/world/persist/pose';
import type { NoiseName } from '../src/sim/SimSensor';

const [seedS, aS, bS, noise = 'arcore', secS = '30', layout = '2x2'] = process.argv.slice(2);
const seed = Number(seedS);
const [cols, rows] = layout.split('x').map(Number);
const home = makeHome(seed, { cols, rows });
const A = new SimSession({ home, rooms: aS.split(',').map(Number), seconds: 60, seed: seed * 10 + 1, noise: noise as NoiseName });
while (A.step());
const B = new SimSession({ home, rooms: bS.split(',').map(Number), seconds: Number(secS), seed: seed * 10 + 2, noise: noise as NoiseName });
while (B.step());
const mA = exportLive(A.world)!, mB = exportLive(B.world)!;
const frag = new FragmentIndex(extractFeatures(mA), new FragmentLookup(mA));
const fB = extractFeatures(mB);
const live = { features: fB, lookup: new FragmentLookup(mB) };
const r = runToEnd(relocalize(live, frag));
const truth = composePose(A.truth, invertPose(B.truth));
const at = { x: (fB.bbox!.x0 + fB.bbox!.x1) / 2, z: (fB.bbox!.z0 + fB.bbox!.z1) / 2 };
const err = r.best ? poseDelta(r.best.pose, truth, at) : null;
console.log('accepted', r.accepted, r.reason, 'amb', r.ambiguity.toFixed(2), 'err', err && `${(err.dist * 100).toFixed(1)}cm ${((err.dyaw * 180) / Math.PI).toFixed(2)}°`);
console.log('best', r.best?.pose, r.best?.metrics);
console.log('second', r.second?.pose, r.second?.metrics);
console.log('at truth', verifyPose(live, frag, truth));
{
  const h = new Array(18).fill(0);
  let n = 0, wsum = 0;
  for (let q = 0; q < fB.occ.n; q++) {
    if (fB.occ.low[q] !== 2) continue;
    n++;
    const w = Math.hypot(fB.occ.nx[q], fB.occ.nz[q]);
    wsum += w;
    if (w < 0.2) continue;
    const ang = ((Math.atan2(fB.occ.nz[q], fB.occ.nx[q]) * 180) / Math.PI + 360) % 180;
    h[Math.floor(ang / 10)]++;
  }
  console.log('structure samples', n, 'mean aniso', (wsum / Math.max(1, n)).toFixed(2), 'normal angle histogram (10° bins)', h.join(' '));
}

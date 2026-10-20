/**
 * Relocalization trials for calibrating the acceptance rule: session A maps
 * some rooms of a home; session B (fresh random frame) maps either one of
 * those rooms (SAME) or another room (OTHER), sometimes after furniture was
 * moved. B tries to relocalize every 10s. One JSON line per attempt.
 *   npx tsx scripts/persist-trials.ts <first> <last> > trials.jsonl
 */
import { Rng } from '../src/core/rng';
import { makeHome, rearrange } from '../src/sim/Home';
import { dressRoom } from '../src/sim/Realism';
import { SimSession } from '../src/sim/MultiSession';
import { exportLive } from '../src/world/persist/adapter';
import { extractFeatures, FragmentLookup } from '../src/world/persist/features';
import { FragmentIndex, relocalize, runToEnd, verifyPose } from '../src/world/persist/Relocalizer';
import { composePose, invertPose, poseDelta, poseFromMatrix } from '../src/world/persist/pose';

const first = Number(process.argv[2] ?? 1), last = Number(process.argv[3] ?? first + 9);
const only = process.argv[4] ? new Set(process.argv[4].split(',').map(Number)) : null;
for (let seed = first; seed <= last; seed++) {
  if (only && !only.has(seed)) continue;
  const rng = new Rng(seed * 101 + 5);
  const shape = rng.pick([[2, 2], [3, 1], [2, 1], [3, 2]] as const);
  const home = makeHome(seed, { cols: shape[0], rows: shape[1], furnish: rng.int(2, 5) });
  dressRoom(home.room, seed);
  const nRooms = home.rooms.length;
  const aRooms = [rng.int(0, nRooms - 1)];
  if (rng.chance(0.5)) {
    const d = home.doors.find((q) => q.a === aRooms[0] || q.b === aRooms[0]);
    if (d) aRooms.push(d.a === aRooms[0] ? d.b : d.a);
  }
  const same = rng.chance(0.5) || aRooms.length === nRooms;
  const others = home.rooms.map((r) => r.id).filter((id) => !aRooms.includes(id));
  const bRoom = same ? rng.pick(aRooms) : rng.pick(others);
  const moved = process.env.MOVED ? process.env.MOVED === "1" : rng.chance(0.5);
  const A = new SimSession({ home, rooms: aRooms, seconds: rng.range(50, 110), seed: seed * 10 + 1 });
  while (A.step());
  const mA = exportLive(A.world)!;
  const frag = new FragmentIndex(extractFeatures(mA), new FragmentLookup(mA));
  const bHome = moved ? rearrange(home, seed, 0.35) : home;
  const B = new SimSession({ home: bHome, room: bHome.room, rooms: [bRoom], seconds: 50, seed: seed * 10 + 2 });
  let next = 10;
  while (B.step()) {
    if (B.t + 1e-6 < next) continue;
    next += 10;
    const mB = exportLive(B.world)!;
    const fB = extractFeatures(mB);
    const t0 = performance.now();
    const liveLookup = new FragmentLookup(mB);
    const r = runToEnd(relocalize({ features: fB, lookup: liveLookup }, frag));
    const ms = performance.now() - t0;
    const truth = composePose(A.truth, invertPose(B.truth));
    const at = fB.bbox ? { x: (fB.bbox.x0 + fB.bbox.x1) / 2, z: (fB.bbox.z0 + fB.bbox.z1) / 2 } : { x: 0, z: 0 };
    const err = r.best ? poseDelta(r.best.pose, truth, at) : null;
    const rival = r.second;
    console.log(
      JSON.stringify({
        seed,
        same,
        moved,
        shape,
        aRooms,
        bRoom,
        t: Math.round(B.t),
        ms: Math.round(ms),
        accepted: r.accepted,
        reason: r.reason,
        amb: +r.ambiguity.toFixed(3),
        errCm: err ? +(err.dist * 100).toFixed(1) : null,
        errDeg: err ? +((err.dyaw * 180) / Math.PI).toFixed(2) : null,
        liveOcc: fB.occTotal,
        liveFree: fB.freeTotal,
        best: r.best?.metrics,
        rival: rival?.metrics,
        rivalDist: rival && r.best ? +poseDelta(rival.pose, r.best.pose, at).dist.toFixed(2) : null,
        rivalDeg: rival && r.best ? +((poseDelta(rival.pose, r.best.pose, at).dyaw * 180) / Math.PI).toFixed(1) : null,
        atTruth: verifyPose({ features: fB, lookup: liveLookup }, frag, truth),
        aDrift: A.drift?.corrections ?? 0,
        bDrift: B.drift?.corrections ?? 0,
        aReg: poseFromMatrix(A.world.trackingToMap()),
        bReg: poseFromMatrix(B.world.trackingToMap()),
      }),
    );
  }
}

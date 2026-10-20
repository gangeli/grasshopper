/**
 * The persistence layer's bookkeeping across window moves: import a combined
 * map (own + a prior), move the window around, and check that "own evidence"
 * (liveOnly + now − base) still equals the own map when nothing new was seen.
 *   npx tsx scripts/persist-window.ts [halfExtent]
 */
import { WorldModel } from '../src/world/WorldModel';
import { scanRoom } from '../src/sim/scan';
import { livingRoom } from '../src/sim/SimRoom';
import { exportLive, importLive, liveLattice } from '../src/world/persist/adapter';
import { combinePrior, liveEvidence, transformMap } from '../src/world/persist/Stitcher';
import type { ChunkedMap } from '../src/world/persist/ChunkedMap';

const half = Number(process.argv[2] ?? 1.5);
const world = new WorldModel({ halfExtent: half });
scanRoom(livingRoom(), undefined, { seed: 3, world });
const lo = exportLive(world)!;
const lat = liveLattice(world)!;
// A fake prior: the own map, moved 1.5 m sideways.
const prior = transformMap(lo, { yaw: 0, tx: 1.5, tz: 0.3, dj: 0 }, lat);
const combined = combinePrior(lo, prior);
importLive(world, combined);
const base = exportLive(world)!;
const diff = (a: ChunkedMap, b: ChunkedMap) => {
  let n = 0, pos = 0;
  const keys = new Set([...a.chunks.keys(), ...b.chunks.keys()]);
  for (const k of keys) {
    const x = a.chunks.get(k), y = b.chunks.get(k);
    const L = (x ?? y)!.occ.length;
    for (let q = 0; q < L; q++) {
      const u = x ? x.occ[q] : 0, v = y ? y.occ[q] : 0;
      if (u !== v) {
        n++;
        if (v > 20 && u <= 20) pos++;
      }
    }
  }
  return `${n} voxels differ, ${pos} newly occupied`;
};
console.log('base vs combined:', diff(combined, base), 'moves', world.recenters);
const steps: [number, number][] = [[1, 0], [0, 1], [-1, 0], [-1, 0], [0, -1], [0, -1], [1, 1]];
for (const [a, b] of steps) {
  world.moveWindow(a, b);
  world.loadPending(2);
  const now = exportLive(world)!;
  console.log(`move ${a},${b}: now vs base: ${diff(base, now)}; evidence vs own: ${diff(lo, liveEvidence(now, base, lo))}`);
}

import type { NavGrid } from '../src/world/NavGrid';
import type { WorldModel } from '../src/world/WorldModel';

/**
 * Why isn't floor column (i, k) walkable? The first nav requirement it fails
 * (see NavGrid.build), or 'walkable'. Shared by the diagnostics scripts.
 */
export function whyNotWalkable(world: WorldModel, nav: NavGrid, i: number, k: number): string {
  const g = world.grid!, P = nav.p, r = g.res, j = world.floorLayer - 1;
  if (nav.neighborAt(i, k, world.floorY, 0.01) !== -1) return 'walkable';
  if (!g.isObserved(i, k)) return 'unobserved';
  const rad = Math.ceil(P.radius / r), need = Math.ceil(P.standHeight / r);
  let seen = 0;
  for (let jj = j + 1; jj <= j + 5; jj++) if (g.data[g.idx(i, jj, k)] < -2) seen++;
  let blocked = false, tot = 0, sf = 0, unsup = false;
  for (let dk = -rad; dk <= rad; dk++)
    for (let di = -rad; di <= rad; di++) {
      if (di * di + dk * dk > rad * rad) continue;
      for (let jj = j + 1; jj <= j + need; jj++) {
        if (g.solid(i + di, jj, k + dk)) blocked = true;
        tot++;
        if (g.data[g.idx(i + di, jj, k + dk)] <= -2) sf++;
      }
      if (di * di + dk * dk === 1 && !g.isObserved(i + di, k + dk)) unsup = true;
    }
  return blocked ? 'blocked' : seen < P.seenFreeMin ? 'notSeenFreeAbove' : unsup ? 'unsupported' : sf < tot * P.knownFreeMin ? 'knownFree<min' : 'other';
}

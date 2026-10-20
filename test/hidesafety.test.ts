import { describe, expect, it } from 'vitest';
import { NavGrid } from '../src/world/NavGrid';
import { WorldModel } from '../src/world/WorldModel';
import { DEFAULT_SPOT_SAFETY, spotSafety } from '../src/game/HideSpots';

/**
 * Hide spots keep clear of structure and of space never observed at body
 * height (spotSafety): where the map is least sure of itself (a wall
 * remembered from a drifted frame, a blank wall's unmeasured base), a pet
 * parked right against it is often inside the real thing.
 */
describe('hide-spot safety', () => {
  const world = new WorldModel({ halfExtent: 2 });
  world.followCamera = false;
  world.setFloor(0, { x: 0, y: 0, z: 0 });
  world.depthPoints = 1;
  const g = world.grid!, fl = world.floorLayer;
  for (let k = g.cellZ(-1); k <= g.cellZ(1); k++)
    for (let i = g.cellX(-1); i <= g.cellX(1); i++) {
      g.markObserved(g.centerX(i), g.centerZ(k));
      const x = g.centerX(i);
      // Seen empty everywhere, except: a crate at x > 0.7; a "wall" at
      // -0.65..-0.55 seen from 40cm up, never observed at body height (a
      // little seen-empty space between, so it doesn't shadow); and the same
      // never-observed band in the open at x < -0.85 (behind furniture:
      // hiding spots are next to such space all the time).
      const wall = x > -0.65 && x < -0.55, open = x < -0.85;
      for (let j = fl; j < fl + 24; j++) g.set(i, j, k, x > 0.7 ? (j < fl + 8 ? 100 : -10) : (wall || open) && j < fl + 6 ? 0 : wall && j >= fl + 8 ? 100 : -10);
    }
  const nav = new NavGrid(world);
  const at = (x: number): ReturnType<typeof spotSafety> => {
    const a = nav.nearest({ x, y: 0, z: 0 }, 0.03);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(Math.abs(nav.pos(a).x - x)).toBeLessThan(0.03);
    return spotSafety(g, nav, a, S.staleSeconds);
  };
  const S = DEFAULT_SPOT_SAFETY;
  const ok = (s: ReturnType<typeof spotSafety>) => s.clearance >= S.minClearance - 1e-6 && s.staleClearance >= S.minStaleClearance - 1e-6 && s.knownClearance >= S.minKnownClearance - 1e-6 && s.seenFree >= S.minSeenFree;
  it('open floor is fine', () => {
    expect(ok(at(0.075))).toBe(true);
  });
  it('measures the distance to mapped structure (the crate 15cm away)', () => {
    expect(at(0.575).clearance).toBeCloseTo(0.15, 3);
    expect(at(0.475).clearance).toBeCloseTo(0.25, 3);
  });
  it('structure not seen for a while counts as stale (it sits where an older frame put it)', () => {
    // The crate was mapped at time code 1; now it is 100.
    g.stamp = 100;
    expect(at(0.575).staleClearance).toBeCloseTo(0.15, 3);
    const okNow = ok(at(0.575));
    // Seen again just now: fresh, no stale margin needed.
    for (let k = g.cellZ(-1); k <= g.cellZ(1); k++) for (let i = g.cellX(0.7); i <= g.cellX(1); i++) for (let j = fl; j < fl + 8; j++) g.add(i, j, k, 1);
    expect(at(0.575).staleClearance).toBeCloseTo(0.3, 3);
    expect(okNow).toBe(false);
    expect(ok(at(0.575))).toBe(true);
    g.stamp = 1;
  });
  it('right next to the never-observed foot of a wall seen higher up is not', () => {
    const s = at(-0.475);
    expect(s.knownClearance).toBeLessThan(0.14);
    expect(ok(s)).toBe(false);
  });
  it('never-observed space in the open (nothing seen above it) does not count', () => {
    const s = at(-0.775);
    expect(s.knownClearance).toBeGreaterThanOrEqual(0.14);
  });
});

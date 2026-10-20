import { describe, expect, it } from 'vitest';
import { generateHouse } from '../src/sim/House';
import { fmtReport, runLargeArea } from '../src/sim/largeArea';

/**
 * Large-area mapping (CI-sized): a person walks through a multi-room home
 * larger than the map window, with realistic fast motion, odometry drift and
 * the tracker's own loop closures. The whole home must end up mapped and
 * stay mapped, line up with what the camera sees, and cost little per frame.
 * Thresholds are regression guards a little below what the code achieves
 * (see docs/large-area-mapping.md for the full benchmark).
 */
describe('large-area mapping', () => {
  it('maps a 9x14m home in a 3-minute walk and keeps it', () => {
    const house = generateHouse(7, 9, 14);
    const rep = runLargeArea({ house, seed: 7, seconds: 180, evalEvery: 60 });
    console.log(fmtReport(rep));
    const f = rep.final;
    // The home is bigger than the 12.8m window: parts of it live in the archive.
    expect(rep.events.recenters).toBeGreaterThan(0);
    expect(f.roomsVisited).toBeGreaterThanOrEqual(house.rooms.length - 1);
    expect(f.coverage, 'walkable floor mapped in visited rooms').toBeGreaterThan(0.45);
    expect(f.precision, 'mapped obstacles that are real').toBeGreaterThan(0.75);
    const local = rep.samples.slice(1).reduce((a, s) => a + s.localPrecision, 0) / (rep.samples.length - 1);
    expect(local, 'map around the player lines up with what the camera sees').toBeGreaterThan(0.85);
    expect(f.falseFree, 'furniture believed seen-empty').toBeLessThan(0.15);
    // Rooms mapped early are still mapped at the end.
    expect(rep.retention.worstCoverageDrop).toBeLessThan(0.35);
    expect(f.memMB, 'map memory').toBeLessThan(150);
  }, 240_000);
});

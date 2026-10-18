import { afterAll, describe, expect, it } from 'vitest';
import { runRound, type RoundReport } from '../src/sim/runRound';

/**
 * End-to-end hide and seek with an automated seeker, across hand-built and
 * random rooms. This is the "no humans needed" playtest.
 */
const CASES: [string, number][] = [
  ['living', 1],
  ['living', 2],
  ['bedroom', 3],
  ['r5', 4],
  ['r9', 5],
  ['r12', 7],
  ['r14', 9],
  ['r21', 11],
];

const reports: RoundReport[] = [];

describe('hide and seek, played by a bot', () => {
  it.each(CASES)('room %s (seed %i)', (room, seed) => {
    const r = runRound(room, seed);
    reports.push(r);
    expect(r.started, 'round started').toBe(true);
    // Hopper really is hidden (ground truth, not just the map) when seeking starts.
    expect(r.truthVisAtSeek, 'hidden at seek start').toBeLessThanOrEqual(0.25);
    expect(r.petToSpot, 'reached the chosen spot').toBeLessThan(0.15);
    // Never walks/jumps through furniture.
    expect(r.maxPenetration, 'penetration').toBeLessThan(0.06);
    expect(r.found, 'round finished').not.toBeNull();
    // When the game says "found", Hopper is genuinely visible.
    if (r.found && !r.found.revealed) expect(r.truthVisAtFound, 'visible when found').toBeGreaterThan(0.2);
    expect(r.planMs).toBeLessThan(1500);
  }, 180_000);

  afterAll(() => {
    const found = reports.filter((r) => r.found && !r.found.revealed).length;
    console.log('\nround summary:');
    for (const r of reports)
      console.log(`  ${r.room}#${r.seed}: ${r.spotKind} → ${r.found ? (r.found.revealed ? 'revealed' : 'found') : 'unfinished'} in ${r.found?.seconds}s, jumps ${r.jumps}, ${r.spotWhere}, plan ${r.planMs | 0}ms`);
    console.log(`  found by seeker: ${found}/${reports.length}`);
  });

  it('the seeker finds Hopper by searching in most rounds (not just via reveal)', () => {
    const found = reports.filter((r) => r.found && !r.found.revealed).length;
    expect(found / Math.max(1, reports.length)).toBeGreaterThanOrEqual(0.7);
  });
});

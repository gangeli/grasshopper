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
    if (!r.relaxed) {
      // Truly hidden (ground truth, not the map): core body hidden; antennae or a hand may peek out.
      expect(r.truthCoreVisAtSeek, 'core body hidden at seek start').toBeLessThanOrEqual(0.25);
      expect(r.truthVisAtSeek, 'mostly hidden at seek start').toBeLessThanOrEqual(0.4);
    }
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
      console.log(`  ${r.room}#${r.seed}: ${r.spotKind}${r.relaxed ? ' (relaxed)' : ''} → ${r.found ? (r.found.revealed ? 'revealed' : 'found') : 'unfinished'} in ${r.found?.seconds}s, jumps ${r.jumps}, ${r.spotWhere}, plan ${r.planMs | 0}ms`);
    console.log(`  found by seeker: ${found}/${reports.length}`);
  });

  it('the seeker finds Hopper by searching in most rounds (not just via reveal)', () => {
    const found = reports.filter((r) => r.found && !r.found.revealed).length;
    expect(found / Math.max(1, reports.length)).toBeGreaterThanOrEqual(0.7);
  });
});

describe('hard mode', () => {
  it('Hopper sneaks to a new hidden spot when the seeker gets close without seeing it', async () => {
    const { Simulation } = await import('../src/sim/Simulation');
    const { SeekerBot } = await import('../src/sim/SeekerBot');
    const sim = new Simulation({ room: 'living', seed: 5, game: { difficulty: 0.9 } });
    const bot = new SeekerBot(sim);
    const dt = 1 / 30;
    while (sim.game.phase !== 'seek' && sim.time < 80) bot.step(dt);
    expect(sim.game.phase).toBe('seek');
    const start = sim.pet.pos.clone();
    // Find a nearby standing spot from which Hopper is NOT visible.
    let placed = false;
    for (let a = 0; a < 24 && !placed; a++) {
      for (const r of [1.0, 1.2, 1.35]) {
        const x = start.x + Math.sin((a / 24) * Math.PI * 2) * r, z = start.z + Math.cos((a / 24) * Math.PI * 2) * r;
        if (Math.abs(x) > sim.room.halfW - 0.2 || Math.abs(z) > sim.room.halfD - 0.2) continue;
        if (sim.room.solidAt({ x, y: 1.0, z }, 0.15) || sim.room.solidAt({ x, y: 0.3, z }, 0.15)) continue;
        sim.cam.pos = { x, y: 1.45, z };
        sim.cam.yaw = Math.atan2(-(start.x - x), -(start.z - z));
        sim.cam.pitch = -0.6;
        if (sim.truthVisibility() === 0) {
          placed = true;
          break;
        }
      }
    }
    expect(placed).toBe(true);
    for (let i = 0; i < 30 * 8; i++) sim.step(dt);
    expect(sim.game.stats.replans).toBe(1);
    expect(sim.pet.pos.distanceTo(start)).toBeGreaterThan(0.3);
    if (sim.game.phase === 'seek') expect(sim.truthVisibility()).toBeLessThanOrEqual(0.25);
  }, 120_000);
});

/**
 * The same bot, under realistic operating conditions: rooms with clutter,
 * blank walls, dark sofas, glass and mirrors, someone walking through, and a
 * phone-like depth sensor with persistent bias, tracking drift and jumps.
 */
const REAL_CASES: [string, number][] = [
  ['living', 21],
  ['bedroom', 22],
  ['r5', 23],
  ['r12', 24],
  ['r23', 25],
  ['r31', 26],
];
const realReports: RoundReport[] = [];
describe('hide and seek under realistic sensing', () => {
  it.each(REAL_CASES)('room %s (seed %i)', (room, seed) => {
    const r = runRound(room, seed, { dress: true, noise: 'real' });
    realReports.push(r);
    expect(r.started, 'round started').toBe(true);
    if (!r.relaxed) {
      // Truly hidden (ground truth, not the map): core body hidden; antennae or a hand may peek out.
      expect(r.truthCoreVisAtSeek, 'core body hidden at seek start').toBeLessThanOrEqual(0.25);
      expect(r.truthVisAtSeek, 'mostly hidden at seek start').toBeLessThanOrEqual(0.4);
    }
    // Realistic depth is noisier: allow brushing by a few cm, never walking into things.
    expect(r.maxPenetration, 'penetration').toBeLessThan(0.07);
    expect(r.found, 'round finished').not.toBeNull();
    if (r.found && !r.found.revealed) expect(r.truthVisAtFound, 'visible when found').toBeGreaterThan(0.2);
  }, 300_000);

  afterAll(() => {
    console.log('\nrealistic round summary:');
    for (const r of realReports)
      console.log(`  ${r.room}#${r.seed}: ${r.spotKind}${r.relaxed ? ' (relaxed)' : ''} → ${r.found ? (r.found.revealed ? 'revealed' : 'found') : 'unfinished'} in ${r.found?.seconds}s, jumps ${r.jumps}, pen ${(r.maxPenetration * 100).toFixed(1)}cm, ${r.spotWhere}`);
  });
});

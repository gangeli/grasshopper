import { afterAll, describe, expect, it } from 'vitest';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { scanRoom, scanRoomHuman, defaultScanSpots } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { evaluateMap, type MapReport } from '../src/sim/MapMetrics';

/**
 * Mapping & pathfinding stress tests against ground truth, under realistic
 * operating conditions (cluttered rooms with hard materials, a person walking
 * through, human-like scanning, phone-like depth with persistent bias and
 * tracking errors). Thresholds are regression guards set a little above what
 * the current code achieves (see docs/stress-testing.md for the numbers).
 */
const rows: { name: string; m: MapReport }[] = [];

describe('mapping stress (realistic conditions)', () => {
  it.each([
    ['living', 0],
    ['bedroom', 1],
    ['r3', 2],
    ['r11', 4],
  ] as const)('room %s', (name, idx) => {
    const room = dressRoom(roomFromName(name), idx + 1);
    const { world, eyes } = scanRoomHuman(room, { seed: idx + 3, noise: 'real', seconds: 45 });
    room.time = 1e6;
    const nav = new NavGrid(world);
    const m = evaluateMap(world, nav, room, { paths: 100, eyes });
    rows.push({ name, m });
    // Safety first.
    expect(m.jumpsBadLanding / Math.max(1, m.jumpsTested), 'jumps landing on nothing').toBeLessThan(0.02);
    expect(m.nodesUnsupported / Math.max(1, m.nodeCount), 'standing on nothing').toBeLessThan(0.01);
    expect(m.pathsColliding / Math.max(1, m.pathsTested), 'paths brushing furniture').toBeLessThan(0.15);
    expect(m.pathMaxPenetration, 'worst penetration').toBeLessThan(0.15);
    expect(m.falseFree, 'solid space believed seen-empty').toBeLessThan(0.1);
    // ...but still room to play.
    expect(m.walkableArea, 'walkable area').toBeGreaterThan(4);
  }, 180_000);

  it.each(['ideal', 'arcore'] as const)('scripted scan, %s sensing, clean rooms: near-zero collisions', (noise) => {
    for (const name of ['living', 'bedroom']) {
      const room = roomFromName(name);
      const { world } = scanRoom(room, undefined, { noise, seed: 11 });
      const nav = new NavGrid(world);
      const m = evaluateMap(world, nav, room, { paths: 100, eyes: defaultScanSpots(room).map((p) => ({ x: p.x, y: 1.45, z: p.z })) });
      expect(m.pathsColliding / m.pathsTested).toBeLessThan(0.05);
      expect(m.pathMaxPenetration).toBeLessThan(0.05);
      expect(m.jumpsBadLanding).toBe(0);
      expect(m.walkableArea).toBeGreaterThan(8);
    }
  }, 180_000);

  afterAll(() => {
    console.log('\nrealistic mapping stress:');
    for (const { name, m } of rows)
      console.log(`  ${name.padEnd(8)} paths colliding ${((m.pathsColliding / m.pathsTested) * 100).toFixed(0)}% (max ${(m.pathMaxPenetration * 100).toFixed(0)}cm), falseFree ${(m.falseFree * 100).toFixed(1)}%, bad landings ${m.jumpsBadLanding}/${m.jumpsTested}, walkable ${m.walkableArea.toFixed(1)}m²`);
  });
});

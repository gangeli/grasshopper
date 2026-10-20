import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { Rng } from '../src/core/rng';
import { injectFault } from '../src/sim/Faults';

/**
 * The game must never get stuck in a broken state. Each test drives a full
 * simulated session, breaks something the way real devices break, and checks
 * that the health monitor (src/game/Health.ts) gets the game out of it.
 */
function mapped(room = 'living', seed = 3, noise: 'arcore' | 'real' = 'arcore') {
  const sim = new Simulation({ seed, noise, room: dressRoom(roomFromName(room), seed) });
  const bot = new SeekerBot(sim);
  bot.mapSeconds = 30;
  while (bot.phase === 'mapping' && sim.time < 60) bot.step(1 / 30);
  return { sim, bot };
}
const run = (sim: Simulation, bot: SeekerBot, seconds: number, until?: () => boolean) => {
  const end = sim.time + seconds;
  while (sim.time < end) {
    bot.step(1 / 30);
    if (until?.()) return true;
  }
  return false;
};

describe('health: recovering from broken states', () => {
  it('survives garbage input: NaN camera poses, negative and huge time steps', () => {
    const { sim } = mapped();
    const bad = { pos: { x: NaN, y: 1, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, fovY: 1, aspect: 1 };
    expect(() => {
      for (let i = 0; i < 30; i++) sim.game.update(1 / 30, bad);
      sim.game.update(-5, sim.view());
      sim.game.update(1e6, sim.view());
      sim.game.update(NaN, sim.view());
    }).not.toThrow();
    expect(Number.isFinite(sim.pet.pos.x + sim.pet.pos.y + sim.pet.pos.z)).toBe(true);
  }, 120_000);

  it('a pet whose position became NaN is put back somewhere real', () => {
    const { sim, bot } = mapped();
    sim.pet.pos.set(NaN, NaN, NaN);
    run(sim, bot, 1);
    expect(Number.isFinite(sim.pet.pos.x + sim.pet.pos.y + sim.pet.pos.z)).toBe(true);
    expect(sim.game.health.counts.petNaN).toBe(1);
  }, 120_000);

  it('a pet left floating in mid-air comes down', () => {
    const { sim, bot } = mapped();
    // Left floating while standing still (a walking pet follows the floor anyway).
    run(sim, bot, 30, () => !sim.pet.moving && sim.pet.state === 'idle');
    sim.pet.placeAt(sim.pet.pos.clone().add(new THREE.Vector3(0, 0.6, 0)));
    run(sim, bot, 5);
    expect(sim.game.health.counts.petFloating ?? 0).toBeGreaterThanOrEqual(1);
    expect(sim.pet.pos.y).toBeLessThan(sim.world.floorY + 0.5);
  }, 120_000);

  it.each(['floorLow', 'floorHigh'] as const)('a wrong floor (%s) is detected and corrected', (kind) => {
    const { sim, bot } = mapped('living', 4);
    injectFault(sim, kind, new Rng(1));
    expect(Math.abs(sim.world.floorY)).toBeGreaterThan(0.04);
    run(sim, bot, 40, () => Math.abs(sim.world.floorY) < 0.03);
    expect(Math.abs(sim.world.floorY)).toBeLessThan(0.03);
    // ...and the game can still play.
    expect(sim.game.mappedArea()).toBeGreaterThan(2);
  }, 180_000);

  it('a covered camera does not paint obstacles in mid-air', () => {
    const { sim, bot } = mapped();
    const before = sim.world.garbageFrames;
    sim.faults.coveredUntil = sim.time + 3;
    const cam = { ...sim.cam.pos };
    run(sim, bot, 3);
    expect(sim.world.garbageFrames).toBeGreaterThan(before);
    const g = sim.world.grid!;
    expect(g.occ(g.cellX(cam.x), g.cellY(cam.y - 0.15), g.cellZ(cam.z))).toBe(false);
  }, 120_000);

  it('after the map is wiped mid-round, the round still ends and play continues', () => {
    const { sim, bot } = mapped();
    run(sim, bot, 60, () => sim.game.phase === 'seek');
    expect(sim.game.phase).toBe('seek');
    injectFault(sim, 'mapWipe', new Rng(1));
    const ended = run(sim, bot, 200, () => sim.game.phase === 'found' || sim.game.phase === 'roam');
    expect(ended).toBe(true);
  }, 240_000);

  it('navigation follows the world when the map is rebuilt (no stale nav graph)', () => {
    const { sim } = mapped();
    const navBefore = sim.game.refreshNav(true)!;
    sim.world.relevelFloor(sim.world.floorY + 0.01);
    const navAfter = sim.game.refreshNav(true)!;
    expect(navAfter).not.toBe(navBefore);
    expect(navAfter.g).toBe(sim.world.grid);
  }, 120_000);

  it('a tracking jump after a loss never leaves the game stuck', () => {
    const { sim, bot } = mapped('bedroom', 2, 'real');
    bot.continuous = true;
    injectFault(sim, 'jump', new Rng(3));
    // Within two minutes the game must have played (or be playing) a round.
    let active = 0;
    run(sim, bot, 120, () => {
      if (sim.game.phase === 'countdown' || sim.game.phase === 'seek') active++;
      return active > 30;
    });
    expect(active).toBeGreaterThan(30);
  }, 300_000);
});

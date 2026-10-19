import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Simulation } from '../src/sim/Simulation';
import { emptyRoom, Furniture } from '../src/sim/SimRoom';
import { penetration } from '../src/sim/MapMetrics';

/**
 * Things change while Hopper is moving: here a box is put down right in its
 * path mid-walk. The live map picks it up and the path guard must stop and
 * replan, never walking into it.
 */
describe('runtime path safety', () => {
  it.each(['ideal', 'arcore'] as const)('replans around an obstacle that appears mid-walk (%s sensing)', (noise) => {
    const sim = new Simulation({ room: emptyRoom(), seed: 2, noise });
    const cam = sim.cam;
    // Stand in a corner looking over the room while it maps.
    cam.pos = { x: -1.5, y: 1.45, z: 1.5 };
    const look = (x: number, z: number) => {
      cam.yaw = Math.atan2(-(x - cam.pos.x), -(z - cam.pos.z));
      cam.pitch = Math.atan2(0.2 - cam.pos.y, Math.hypot(x - cam.pos.x, z - cam.pos.z));
    };
    for (let i = 0; i < 30 * 6; i++) {
      look(Math.sin(i * 0.03) * 1.2, -0.5 + Math.cos(i * 0.02) * 0.8);
      sim.step(1 / 30);
    }
    sim.spawnPet({ x: -1.2, y: 0, z: -1.2 });
    for (let i = 0; i < 30; i++) sim.step(1 / 30);
    // Send Hopper diagonally across the room.
    const game = sim.game as unknown as { follow(p: unknown, c: number, a: string, y: number | null): void };
    const nav = sim.game.refreshNav(true)!;
    const goal = { x: 1.2, y: 0, z: 1.0 };
    const path = nav.findPath(sim.pet.pos, goal)!;
    expect(path).not.toBeNull();
    game.follow(path, 0.5, 'idle', null);
    let dropped = false, worst = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < 30 * 20; i++) {
      // After a moment, a box lands ~0.6m ahead of Hopper on its way.
      if (!dropped && sim.time > 0.8 + 6 + 1) {
        const d = new THREE.Vector3(goal.x - sim.pet.pos.x, 0, goal.z - sim.pet.pos.z).normalize();
        const c = sim.pet.pos.clone().addScaledVector(d, 0.6);
        sim.room.addPiece('crate', Furniture.crate(c.x - 0.2, c.z - 0.2, 0.4, 0.4, 0.4));
        dropped = true;
      }
      look(sim.pet.pos.x, sim.pet.pos.z);
      sim.step(1 / 30);
      sim.rig.group.updateMatrixWorld(true);
      for (const b of ['hips', 'chest', 'head'] as const) worst = Math.max(worst, penetration(sim.room, sim.rig.bones[b].getWorldPosition(p)));
      if (dropped && !sim.pet.moving) break;
    }
    expect(dropped).toBe(true);
    expect(worst, 'never walks into the new box').toBeLessThan(0.03);
    expect(sim.game.stats.blockedReplans, 'replanned at least once').toBeGreaterThan(0);
    expect(sim.game.stats.blockedReplans, 'no replan storm').toBeLessThan(40);
    expect(Math.hypot(sim.pet.pos.x - goal.x, sim.pet.pos.z - goal.z), 'still gets there').toBeLessThan(0.4);
  }, 120_000);
});

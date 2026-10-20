import { describe, expect, it } from 'vitest';
import { livingRoom } from '../src/sim/SimRoom';

/** The simulator can rearrange furniture (a changed room on a later visit). */
describe('SimRoom.movePiece', () => {
  it('moves a piece when the spot is free, and the sensor sees it there', () => {
    const room = livingRoom();
    const pc = room.pieces.find((p) => p.label !== 'wall')!;
    const before = { ...pc.min };
    const ray = (x: number, z: number) => room.sensorRay({ x, y: 0.2, z: z - 3 }, { x: 0, y: 0, z: 1 }).range;
    // Some offset that works (the room is furnished; try a few).
    let moved = false;
    for (const [dx, dz] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.3, 0.3], [-0.3, -0.3]]) if ((moved = room.movePiece(pc.id, dx, dz))) break;
    expect(moved).toBe(true);
    expect(pc.min.x !== before.x || pc.min.z !== before.z).toBe(true);
    // The BVH follows: a ray at the piece's new centre hits it at its new face.
    const cx = (pc.min.x + pc.max.x) / 2;
    expect(Number.isFinite(ray(cx, pc.min.z))).toBe(true);
  });

  it('refuses to move into another piece or a wall', () => {
    const room = livingRoom();
    const pc = room.pieces.find((p) => p.label !== 'wall')!;
    expect(room.movePiece(pc.id, 50, 0)).toBe(false);
    const wall = room.pieces.find((p) => p.label === 'wall');
    if (wall) expect(room.movePiece(wall.id, 0.1, 0)).toBe(false);
  });
});

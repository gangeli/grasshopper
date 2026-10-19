import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { dressRoom } from '../src/sim/Realism';
import { rayBox, roomFromName } from '../src/sim/SimRoom';

describe('BoxBVH', () => {
  it.each(['living', 'bedroom', 'r23'])('finds the same nearest box as testing every box (%s)', (name) => {
    const room = dressRoom(roomFromName(name), 3);
    const rng = new Rng(9);
    let hits = 0;
    for (let n = 0; n < 4000; n++) {
      const o = { x: rng.range(-room.halfW, room.halfW), y: rng.range(0.05, 2.3), z: rng.range(-room.halfD, room.halfD) };
      // Include exactly axis-parallel rays.
      const d0 = n % 7 === 0 ? { x: 0, y: 0, z: rng.chance(0.5) ? 1 : -1 } : { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const l = Math.hypot(d0.x, d0.y, d0.z) || 1;
      const d = { x: d0.x / l, y: d0.y / l, z: d0.z / l };
      let best = 20, box = null as unknown, normal = null as unknown;
      for (const b of room.boxes) {
        const r = rayBox(o, d, b.min, b.max);
        if (r && r.t > 1e-4 && r.t < best) {
          best = r.t;
          box = b;
          normal = r.normal;
        }
      }
      const bvh = room.bvh;
      const hit = bvh.nearest(o.x, o.y, o.z, d.x, d.y, d.z, 20, 1e-4);
      expect(hit).toBe(box !== null);
      if (hit) {
        hits++;
        expect(bvh.t).toBeCloseTo(best, 9);
        expect(bvh.hit).toBe(box);
        const n2 = normal as { x: number; y: number; z: number };
        expect([n2.x, n2.y, n2.z][bvh.axis]).toBe(bvh.sign);
      }
    }
    expect(hits).toBeGreaterThan(1000);
  });
});

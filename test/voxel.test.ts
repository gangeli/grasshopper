import { describe, expect, it } from 'vitest';
import { VoxelGrid } from '../src/world/VoxelGrid';
import { Rng } from '../src/core/rng';

const mk = () => new VoxelGrid({ origin: { x: -1, y: 0, z: -1 }, res: 0.1, nx: 20, ny: 20, nz: 20 });

describe('VoxelGrid', () => {
  it('raycast finds the first occupied cell, matching brute-force marching', () => {
    const g = mk();
    const rng = new Rng(3);
    for (let n = 0; n < 60; n++) g.set(rng.int(0, 19), rng.int(0, 19), rng.int(0, 19), 100);
    for (let trial = 0; trial < 300; trial++) {
      const o = { x: rng.range(-0.9, 0.9), y: rng.range(0.1, 1.9), z: rng.range(-0.9, 0.9) };
      let d = { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const l = Math.hypot(d.x, d.y, d.z);
      d = { x: d.x / l, y: d.y / l, z: d.z / l };
      const hit = g.raycast(o, d, 3);
      // Brute force: tiny steps.
      let brute: number | null = null;
      for (let t = 0; t < 3; t += 0.0005) {
        const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
        if (g.occAt(p)) {
          brute = t;
          break;
        }
      }
      if (brute === null) expect(hit === null || hit.t > 2.99).toBe(true);
      else {
        expect(hit).not.toBeNull();
        expect(Math.abs(hit!.t - brute)).toBeLessThan(0.01);
      }
    }
  });

  it('integrateRay marks the endpoint occupied and carves the path free', () => {
    const g = mk();
    for (let r = 0; r < 4; r++) g.integrateRay({ x: -0.85, y: 1, z: 0.05 }, { x: 0.55, y: 1, z: 0.05 }, true);
    expect(g.occAt({ x: 0.55, y: 1, z: 0.05 })).toBe(true);
    expect(g.get(g.cellX(0), g.cellY(1), g.cellZ(0.05))).toBeLessThan(0);
    expect(g.version).toBeGreaterThan(0);
  });

  it('segmentClear respects skipEnd', () => {
    const g = mk();
    g.set(g.cellX(0.5), g.cellY(1), g.cellZ(0), 100);
    expect(g.segmentClear({ x: -0.5, y: 1.05, z: 0.05 }, { x: 0.55, y: 1.05, z: 0.05 })).toBe(false);
    expect(g.segmentClear({ x: -0.5, y: 1.05, z: 0.05 }, { x: 0.55, y: 1.05, z: 0.05 }, 0.2)).toBe(true);
  });
});

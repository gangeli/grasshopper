import { describe, expect, it } from 'vitest';
import { icp2d, nearestField, refLines, type RefImage } from '../src/world/LocalReg';

/** Plan-view reference from segments (x0, z0, x1, z1), 5 cm cells over [−4, 4]². */
function refFrom(segs: number[][]): RefImage {
  const res = 0.05, w = 160, h = 160, ox = -4, oz = -4;
  const cnt = new Float32Array(w * h);
  for (const [x0, z0, x1, z1] of segs) {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.01);
    for (let q = 0; q <= n; q++) {
      const x = x0 + ((x1 - x0) * q) / n, z = z0 + ((z1 - z0) * q) / n;
      const a = Math.floor((x - ox) / res), b = Math.floor((z - oz) / res);
      if (a >= 0 && b >= 0 && a < w && b < h) cnt[b * w + a] = 5;
    }
  }
  return { w, h, res, ox, oz, cnt };
}

/** Points along segments, moved by C (old → fresh) = [c, s, ax, az]. */
function pointsFrom(segs: number[][], C: number[], step = 0.05): Float32Array {
  const out: number[] = [];
  for (const [x0, z0, x1, z1] of segs) {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step);
    for (let q = 0; q <= n; q++) {
      const x = x0 + ((x1 - x0) * q) / n, z = z0 + ((z1 - z0) * q) / n;
      out.push(C[0] * x + C[1] * z + C[2], -C[1] * x + C[0] * z + C[3]);
    }
  }
  return Float32Array.from(out);
}

const corr = (dx: number, dz: number, yaw: number) => [Math.cos(yaw), Math.sin(yaw), dx, dz];

describe('local re-registration (plan-view ICP)', () => {
  // A room corner with a sofa and a cabinet: constrains both axes and the yaw.
  const room = [
    [-2.975, -2.475, 3, -2.475],
    [-2.975, -2.475, -2.975, 2.5],
    [-0.975, 1.025, 0.825, 1.025],
    [-0.975, 1.025, -0.975, 1.9],
    [0.825, 1.025, 0.825, 1.9],
    [1.825, -1.475, 2.4, -1.475],
    [1.825, -1.475, 1.825, -0.8],
  ];
  it('recovers a drift of the old structure', () => {
    const ref = refFrom(room);
    const truth = corr(0.12, -0.07, 0.03);
    const pts = pointsFrom(room, truth);
    const r = icp2d(pts, ref, nearestField(ref, 8), refLines(ref), { x: 0, z: 0 });
    expect(r.dims).toBe(3);
    // C should move old points onto the fresh ones: check on a few points.
    for (const [x, z] of [[-3, 0], [2, -1.5], [0, 1]]) {
      const ex = truth[0] * x + truth[1] * z + truth[2], ez = -truth[1] * x + truth[0] * z + truth[3];
      const gx = r.C[0] * x + r.C[1] * z + r.C[2], gz = -r.C[1] * x + r.C[0] * z + r.C[3];
      expect(Math.hypot(gx - ex, gz - ez)).toBeLessThan(0.015);
    }
    expect(r.inliers).toBeGreaterThan(r.inliers0 * 2);
  });
  it('moves only across a plain wall', () => {
    const wall = [[-3, -0.975, 3, -0.975]];
    const ref = refFrom(wall);
    const pts = pointsFrom(wall, corr(0.2, 0.1, 0));
    const r = icp2d(pts, ref, nearestField(ref, 8), refLines(ref), { x: 0, z: 0.5 });
    expect(r.dims).toBeLessThan(3);
    // Across the wall (z): recovered; along it (x): not invented.
    const gz = r.C[3], gx = r.C[2];
    expect(Math.abs(gz - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(gx)).toBeLessThan(0.05);
  });
});

describe('local re-registration: moving the old map', () => {
  it('moves old structure and its free space, keeps what was seen since, never frees the unknown', async () => {
    const { WorldModel } = await import('../src/world/WorldModel');
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    const g = w.grid!;
    g.freeTime = new Uint16Array(g.data.length);
    const j = g.cellY(0.525);
    const at = (x: number, z: number) => g.idx(g.cellX(x), j, g.cellZ(z));
    // Old wall at z = 1.025 (laid down at code 5), old free space in front of it (z 0.525..0.975), a recent post at (0.525, 1.125).
    for (let x = -1; x <= 1; x += 0.05) {
      const q = at(x + 0.025, 1.025);
      g.data[q] = 60;
      g.hitTime![q] = (5 << 16) | 5;
      for (let z = 0.525; z < 1.0; z += 0.05) {
        const f = at(x + 0.025, z);
        g.data[f] = -20;
        g.freeTime[f] = 5;
      }
    }
    const post = at(0.525, 1.125);
    g.data[post] = 60;
    g.hitTime![post] = (50 << 16) | 50;
    g.stamp = 60;
    // The view says the old map is 10 cm short in z: move it.
    const moved = w.localRegMove({ x: 0, y: 1.4, z: 0 }, 4, 1, 40, [1, 0, 0, 0.1]);
    expect(moved).toBeGreaterThan(0);
    expect(g.data[at(0.025, 1.125)]).toBe(60); // the wall moved
    expect(g.data[at(0.025, 1.025)]).toBeLessThan(0); // free space followed it
    expect(g.data[post]).toBe(60); // seen since: stays
    expect(g.hitTime![post] & 0xffff).toBe(50);
    expect(g.data[at(0.025, 0.525)]).toBe(0); // vacated, nothing moved in
    // Free space doesn't spill into never-seen space.
    expect(g.data[at(0.025, 1.175)]).toBe(0);
  });
});

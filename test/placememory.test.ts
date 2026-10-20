import { describe, expect, it } from 'vitest';
import { PlaceMemory } from '../src/world/PlaceMemory';

/** Points on the walls and a few boxes of a 4×5m room, seen from `eye` (within 3m). */
function view(eye: { x: number; z: number }, shift = { dx: 0, dz: 0, yaw: 0 }, seed = 1): Float32Array {
  const out: number[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const surf: [number, number, number, number][] = [
    [-2, -2.5, 2, -2.5], [2, -2.5, 2, 2.5], [2, 2.5, -2, 2.5], [-2, 2.5, -2, -2.5],
    [-1, -1, -0.2, -1], [-0.2, -1, -0.2, -0.4], [0.8, 1, 1.4, 1], [1.4, 1, 1.4, 1.8],
  ];
  const c = Math.cos(shift.yaw), sn = Math.sin(shift.yaw);
  for (let q = 0; q < 1500; q++) {
    const [x0, z0, x1, z1] = surf[Math.floor(rnd() * surf.length)];
    const a = rnd();
    const x = x0 + (x1 - x0) * a, z = z0 + (z1 - z0) * a, y = 0.1 + rnd() * 1.2;
    if (Math.hypot(x - eye.x, z - eye.z) > 2.9) continue;
    // The drifted frame: true point → frame coordinates (yaw about the eye, then shift).
    const rx = x - eye.x, rz = z - eye.z;
    out.push(eye.x + c * rx + sn * rz + shift.dx, y, eye.z - sn * rx + c * rz + shift.dz);
  }
  return Float32Array.from(out);
}

describe('PlaceMemory', () => {
  it('finds the correction back to an earlier visit', () => {
    const pm = new PlaceMemory();
    const frames = [];
    for (let f = 0; f < 40; f++) {
      const eye = { x: -0.5 + f * 0.02, y: 1.4, z: 0 };
      frames.push({ eye, pts: view(eye, undefined, f + 1), sig: null, t: f * 0.1 });
    }
    pm.settle(frames, 100, 0, () => true);
    pm.close();
    expect(pm.submaps.length).toBeGreaterThan(0);
    // Later, back in the room through a frame that slid 25cm and turned 0.06 rad.
    const eye = { x: 0, y: 1.4, z: 0.2 };
    const drift = { dx: 0.25, dz: -0.12, yaw: 0.06 };
    const pts: number[] = [];
    for (let f = 0; f < 5; f++) pts.push(...view(eye, drift, 100 + f));
    const visits = pm.visitsNear({ minX: -3, maxX: 3, minZ: -3, maxZ: 3 }, 50);
    expect(visits.length).toBe(1);
    const it = pm.align(pts, { x: eye.x + drift.dx, y: 1.4, z: eye.z + drift.dz }, visits[0], 0.6, 0.18);
    let r = it.next();
    while (!r.done) r = it.next();
    const m = r.value!;
    expect(m).not.toBeNull();
    if (process.env.DBG) console.log(JSON.stringify(m));
    // The correction undoes the drift: at the camera, -shift; yaw opposite.
    expect(Math.hypot(m.dx + drift.dx, m.dz + drift.dz)).toBeLessThan(0.04);
    expect(Math.abs(m.dyaw + drift.yaw)).toBeLessThan(0.015);
    expect(m.degenerate).toBe(false);
    expect(m.best).toBeGreaterThan(1.25 * m.second);
  });

  it('moves submaps with a warp and a realignment', () => {
    const pm = new PlaceMemory();
    const frames = [];
    for (let f = 0; f < 20; f++) {
      const eye = { x: 0, y: 1.4, z: 0 };
      frames.push({ eye, pts: view(eye, undefined, f + 1), sig: null, t: f * 0.1 });
    }
    pm.settle(frames, 100, 0, () => true);
    pm.close();
    const s = pm.submaps[0], x0 = s.cells[0], z0 = s.cells[2];
    pm.realign({ dx: 0.1, dz: -0.2, dyaw: 0, pivot: { x: 0, z: 0 } }, 0);
    expect(s.cells[0] - x0).toBe(10);
    expect(s.cells[2] - z0).toBe(-20);
    pm.warp(-1, 10, () => [1, 0, -0.1, 0.2], { x: 0, z: 0 });
    expect(s.cells[0]).toBe(x0);
    expect(s.cells[2]).toBe(z0);
  });
});

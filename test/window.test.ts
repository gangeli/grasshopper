import { describe, expect, it } from 'vitest';
import { WorldModel } from '../src/world/WorldModel';
import { copyOverlap, shiftInPlace } from '../src/world/ChunkStore';

/** The dense map window follows the camera; what it leaves behind is archived and comes back. */
describe('map window', () => {
  const mark = (w: WorldModel, x: number, y: number, z: number, v: number) => {
    const g = w.grid!;
    g.set(g.cellX(x), g.cellY(y), g.cellZ(z), v);
    g.markObserved(x, z);
  };
  const at = (w: WorldModel, x: number, y: number, z: number) => {
    const g = w.grid!;
    return g.inBounds(g.cellX(x), g.cellY(y), g.cellZ(z)) ? g.get(g.cellX(x), g.cellY(y), g.cellZ(z)) : null;
  };

  it('moves with the camera and restores archived areas on return', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    mark(w, 2.025, 0.525, 2.025, 100);
    mark(w, -3.025, 1.025, 1.025, -30);
    const g0 = w.grid!;
    w.follow({ x: 1, y: 1.4, z: 0 });
    expect(w.grid).toBe(g0); // near the middle: nothing moves
    // Walk 20m away: the window moves, the marked cells leave it.
    for (let x = 0; x <= 20; x += 0.5) w.follow({ x, y: 1.4, z: 0 });
    expect(w.recenters).toBeGreaterThan(0);
    expect(at(w, 2.025, 0.525, 2.025)).toBeNull();
    expect(w.grid!.cellX(20)).toBeGreaterThan(w.grid!.nx * 0.25);
    expect(w.grid!.cellX(20)).toBeLessThan(w.grid!.nx * 0.75);
    expect(w.archive.size).toBeGreaterThan(0);
    // The export still has them.
    const m = w.exportMap()!;
    const w2 = new WorldModel();
    w2.setFloor(0, { x: 0, y: 0, z: 0 });
    w2.importMap(m);
    expect(at(w2, 2.025, 0.525, 2.025)).toBe(100);
    // Walk back: they come back into the live window.
    for (let x = 20; x >= 0; x -= 0.5) w.follow({ x, y: 1.4, z: 0 });
    expect(at(w, 2.025, 0.525, 2.025)).toBe(100);
    expect(at(w, -3.025, 1.025, 1.025)).toBe(-30);
    expect(w.grid!.isObserved(w.grid!.cellX(2.025), w.grid!.cellZ(2.025))).toBe(true);
  });

  it('keeps the solid sub-floor and unknown space when entering new areas', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    for (let z = 0; z <= 15; z += 0.5) w.follow({ x: 0, y: 1.4, z });
    const g = w.grid!;
    expect(g.get(g.cellX(0), 0, g.cellZ(15))).toBe(127);
    expect(g.get(g.cellX(0), w.floorLayer + 3, g.cellZ(15))).toBe(0);
    expect(g.topFrac[g.idx(g.cellX(0), w.floorLayer + 3, g.cellZ(15))]).toBe(255);
  });

  it('imports a map larger than the window into the archive', () => {
    const big = new WorldModel({ halfExtent: 15 });
    big.followCamera = false;
    big.setFloor(0, { x: 0, y: 0, z: 0 });
    mark(big, 12.025, 0.625, -11.025, 90);
    mark(big, -12.025, 0.625, 12.025, 80);
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    w.importMap(big.exportMap()!);
    expect(at(w, 12.025, 0.625, -11.025)).toBeNull();
    for (let x = 0; x <= 12; x += 0.5) w.follow({ x, y: 1.4, z: -x });
    expect(at(w, 12.025, 0.625, -11.025)).toBe(90);
    const m = w.exportMap()!;
    const back = new WorldModel({ halfExtent: 15 });
    back.followCamera = false;
    back.setFloor(0, { x: 0, y: 0, z: 0 });
    back.importMap(m);
    expect(at(back, -12.025, 0.625, 12.025)).toBe(80);
    expect(at(back, 12.025, 0.625, -11.025)).toBe(90);
  });

  it('shifts arrays in place exactly like a copy', () => {
    const nx = 9, nz = 7, ny = 3;
    for (const [di, dk] of [[2, 0], [-3, 0], [0, 2], [0, -4], [3, -2], [-2, 3], [9, 0], [-1, -1]]) {
      const src = Int8Array.from({ length: nx * nz * ny }, (_, i) => (i * 37) % 120);
      const want = new Int8Array(src.length).fill(-5);
      copyOverlap(src, want, nx, nz, ny, di, dk);
      const got = src.slice();
      shiftInPlace(got, nx, nz, ny, di, dk, () => -5);
      expect(Array.from(got)).toEqual(Array.from(want));
    }
  });
});

import { describe, expect, it } from 'vitest';
import { WorldModel } from '../src/world/WorldModel';
import { copyOverlap, shiftInPlace } from '../src/world/ChunkStore';
import { scanRoom } from '../src/sim/scan';
import { livingRoom } from '../src/sim/SimRoom';

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
    // ...with their observation times.
    const h = w.grid!;
    expect(h.hitTime![h.idx(h.cellX(2.025), h.cellY(0.525), h.cellZ(2.025))]).toBe((1 << 16) | 1);
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

  it('keeps a companion point (the pet) inside the window when it can', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    // The pet lags 4m behind the player walking along +x.
    for (let x = 0; x <= 20; x += 0.25) {
      w.keepInWindow = { x: x - 4, y: 0, z: 0 };
      w.follow({ x, y: 1.4, z: 0 });
      const g = w.grid!;
      expect(g.cellX(x - 4)).toBeGreaterThanOrEqual(0);
    }
  });

  it('a local map reset forgets only the surroundings and weakens the rest', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    const g = w.grid!;
    const near = g.idx(g.cellX(1.025), g.cellY(0.525), g.cellZ(0.025)), far = g.idx(g.cellX(5.525), g.cellY(0.525), g.cellZ(0.025));
    g.data[near] = 100;
    g.data[far] = 100;
    w.hardReset({ x: 0, z: 0, radius: 3 });
    expect(w.grid).toBe(g);
    expect(g.data[near]).toBe(0);
    expect(g.data[far]).toBeGreaterThan(20);
    expect(g.data[far]).toBeLessThan(100);
  });
});

describe('map window: archive races', () => {
  const occupiedIn = (w: WorldModel, cx: number, cz: number) => {
    const c = w.archive.get(cx, cz);
    return c ? c.data.reduce((n, v) => n + (v > 20 && v !== 127 ? 1 : 0), 0) : 0;
  };
  const archivedTotals = (w: WorldModel) => {
    const out = new Map<number, number>();
    for (const [key, c] of w.archive.map) out.set(key, c.data.reduce((n, v) => n + (v > 20 && v !== 127 ? 1 : 0), 0));
    return out;
  };

  it('keeps an archived chunk that re-enters and leaves again before it is merged back', () => {
    const world = new WorldModel({ halfExtent: 1.5 });
    scanRoom(livingRoom(), undefined, { seed: 3, world });
    world.moveWindow(-1, 0); // (2,3) etc. leave: archived
    world.archive.flush();
    const before = archivedTotals(world);
    expect([...before.values()].some((n) => n > 0)).toBe(true);
    world.moveWindow(1, 0); // they come back: pending a merge
    world.moveWindow(0, -1); // ...and some leave again, unmerged
    world.moveWindow(1, 0);
    world.loadPending();
    world.moveWindow(-3, 3); // everything to the archive
    world.archive.flush();
    for (const [key, n] of before) if (n > 0) expect(archivedTotals(world).get(key) ?? 0).toBeGreaterThanOrEqual(n);
  });

  it('the reported repro: two moves without a merge in between keep store chunk (2,3)', () => {
    const world = new WorldModel({ halfExtent: 1.5 });
    scanRoom(livingRoom(), undefined, { seed: 3, world });
    // Rapid moves back and forth, with and without merges in between.
    const n0 = occupiedIn(world, 2, 3);
    world.moveWindow(1, 0);
    world.moveWindow(0, -1);
    expect(occupiedIn(world, 2, 3)).toBeGreaterThanOrEqual(n0);
    const totals = archivedTotals(world);
    for (const [si, sk, merge] of [[1, 0, false], [-1, 0, false], [0, 1, true], [0, -1, false], [1, 1, false], [-1, -1, true]] as const) {
      world.moveWindow(si, sk);
      if (merge) world.loadPending(1);
    }
    world.moveWindow(5, 5);
    world.archive.flush();
    const after = archivedTotals(world);
    for (const [key, n] of totals) if (n > 0) expect(after.get(key) ?? 0).toBeGreaterThan(0);
  });
});

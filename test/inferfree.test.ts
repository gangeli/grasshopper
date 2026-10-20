import { describe, expect, it } from 'vitest';
import { NavGrid } from '../src/world/NavGrid';
import { WorldModel } from '../src/world/WorldModel';

/**
 * NavParams.inferLowFree: depth that rarely measures the floor itself (motion
 * stereo on a blank floor) never carves the first layers above it; rays that
 * passed a little higher over observed floor, with nothing ever measured
 * below them, make it walkable.
 */
describe('inferring the empty space just above observed floor', () => {
  const setup = (toy: boolean) => {
    const world = new WorldModel({ halfExtent: 2 });
    world.followCamera = false;
    world.setFloor(0, { x: 0, y: 0, z: 0 });
    world.depthPoints = 1; // depth sensing: nav only trusts space seen empty
    const g = world.grid!;
    const i0 = g.cellX(-0.5), i1 = g.cellX(0.5), k0 = g.cellZ(-0.5), k1 = g.cellZ(0.5);
    const fl = world.floorLayer;
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        g.markObserved(g.centerX(i), g.centerZ(k));
        // Seen empty from 30cm up (rays passed over), nothing measured below.
        for (let j = fl + 6; j < fl + 14; j++) g.set(i, j, k, -10);
      }
    if (toy) for (let j = fl; j < fl + 2; j++) g.set(g.cellX(0), j, g.cellZ(0), 5);
    return world;
  };
  // Nodes in the column at (x, z): >= 0 when there is one.
  const nodeAt = (world: WorldModel, x: number, z: number) => {
    const nav = new NavGrid(world), g = world.grid!;
    return nav.colCount[g.cellZ(z) * g.nx + g.cellX(x)] - 1;
  };
  it('off by default: never-measured space is not walkable', () => {
    expect(nodeAt(setup(false), 0, 0)).toBeLessThan(0);
  });
  it('on: walkable where rays passed low enough', () => {
    const w = setup(false);
    w.navParams = { inferLowFree: 0.35 };
    expect(nodeAt(w, 0, 0)).toBeGreaterThanOrEqual(0);
    // Not if the lowest seen-empty voxel is higher than that.
    const w2 = setup(false);
    w2.navParams = { inferLowFree: 0.2 };
    expect(nodeAt(w2, 0, 0)).toBeLessThan(0);
  });
  it('anything ever measured low in the column (a toy) blocks the inference there', () => {
    const w = setup(true);
    w.navParams = { inferLowFree: 0.35 };
    expect(nodeAt(w, 0, 0)).toBeLessThan(0);
    expect(nodeAt(w, 0.3, 0.3)).toBeGreaterThanOrEqual(0);
  });
});

describe('the never-measured foot of structure seen higher up (NavParams.footSolid)', () => {
  const setup = () => {
    const world = new WorldModel({ halfExtent: 2 });
    world.followCamera = false;
    world.setFloor(0, { x: 0, y: 0, z: 0 });
    world.depthPoints = 1;
    const g = world.grid!, fl = world.floorLayer;
    for (let k = g.cellZ(-0.6); k <= g.cellZ(0.6); k++)
      for (let i = g.cellX(-0.6); i <= g.cellX(0.6); i++) {
        g.markObserved(g.centerX(i), g.centerZ(k));
        const wall = g.centerX(i) > 0.2 && g.centerX(i) < 0.3;
        // Open floor seen empty; a "wall" seen from 40cm up with some
        // seen-empty space below that (so no shadow) and its foot never measured.
        for (let j = fl; j < fl + 24; j++) g.set(i, j, k, !wall ? -10 : j < fl + 6 ? 0 : j < fl + 8 ? -10 : 100);
      }
    return world;
  };
  const nodeAt = (world: WorldModel, x: number) => {
    const nav = new NavGrid(world), g = world.grid!;
    return nav.colCount[g.cellZ(0) * g.nx + g.cellX(x)] - 1;
  };
  it('off: the pet may stand right against it', () => {
    const w = setup();
    w.navParams = { footSolid: false };
    expect(nodeAt(w, 0.125)).toBeGreaterThanOrEqual(0);
  });
  it('on: it keeps its clearance from it, and open floor is unaffected', () => {
    const w = setup();
    w.navParams = { footSolid: true };
    expect(nodeAt(w, 0.125)).toBeLessThan(0);
    expect(nodeAt(w, -0.2)).toBeGreaterThanOrEqual(0);
  });
});

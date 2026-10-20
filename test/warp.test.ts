import { describe, expect, it } from 'vitest';
import { WorldModel } from '../src/world/WorldModel';

/** Loop-closure map deformation: structure moves by its share of the correction, by when it was seen. */
describe('map warp (loop closure)', () => {
  it('moves structure observed in the interval by its share of the correction, in the window and the archive', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    w.timeCode(0); // session clock starts at t = 0
    const g = w.grid!;
    const put = (x: number, z: number, code: number) => {
      g.stamp = code;
      g.set(g.cellX(x), g.cellY(0.525), g.cellZ(z), 80);
    };
    put(1.025, 0.025, 5); // before the interval: stays
    put(2.025, 0.025, 51); // end of the interval: full correction
    put(3.025, 0.025, 31); // half way (by time; nothing was walked)
    const at = (x: number, z: number) => w.grid!.get(w.grid!.cellX(x), w.grid!.cellY(0.525), w.grid!.cellZ(z));
    const moved = w.warpSince(10, 50, { dx: 0.2, dz: 0, dyaw: 0, pivot: { x: 0, z: 0 } });
    expect(moved).toBe(2);
    expect(at(1.025, 0.025)).toBe(80);
    expect(at(2.025, 0.025)).toBe(0);
    expect(at(2.225, 0.025)).toBe(80);
    expect(at(3.025, 0.025)).toBe(0);
    expect(at(3.125, 0.025)).toBe(80);
    expect(w.grid!.hitTime![w.grid!.idx(w.grid!.cellX(2.225), w.grid!.cellY(0.525), w.grid!.cellZ(0.025))]).toBe(51);
  });

  it('warps archived chunks too', () => {
    const w = new WorldModel();
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    w.timeCode(0);
    const g = w.grid!;
    g.stamp = 40;
    g.set(g.cellX(-4.025), g.cellY(0.525), g.cellZ(0.025), 90);
    // Walk away: that spot goes to the archive.
    for (let x = 0; x <= 12; x += 0.5) w.follow({ x, y: 1.4, z: 0 });
    expect(w.grid!.inBounds(w.grid!.cellX(-4.025), 0, 0)).toBe(false);
    w.warpSince(0, 40, { dx: 0, dz: 0.3, dyaw: 0, pivot: { x: 0, z: 0 } });
    for (let x = 12; x >= -4; x -= 0.5) w.follow({ x, y: 1.4, z: 0 });
    const h = w.grid!;
    expect(h.get(h.cellX(-4.025), h.cellY(0.525), h.cellZ(0.025))).toBe(0);
    expect(h.get(h.cellX(-4.025), h.cellY(0.525), h.cellZ(0.325))).toBe(90);
  });
});

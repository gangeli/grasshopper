import { describe, expect, it } from 'vitest';
import { livingRoom, bedroom, randomRoom, type SimRoom } from '../src/sim/SimRoom';
import { scanRoom } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { segmentObjects } from '../src/world/Segmentation';
import type { Vec3 } from '../src/core/math';

type Caps = { depth: boolean; planes: boolean; mesh: boolean };
const MODES: [string, Caps][] = [
  ['depth+planes (ARCore phone)', { depth: true, planes: true, mesh: false }],
  ['scene mesh (Quest)', { depth: false, planes: false, mesh: true }],
];

/** Solid in ground truth, ignoring thin parts (legs) that phone depth can't resolve. */
function thickSolidAt(room: SimRoom, p: Vec3): boolean {
  for (const b of room.boxes) {
    const w = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
    if (w < 0.1) continue;
    // 5cm tolerance = one voxel of sensing resolution.
    if (p.x > b.min.x + 0.05 && p.x < b.max.x - 0.05 && p.y > b.min.y + 0.01 && p.y < b.max.y - 0.01 && p.z > b.min.z + 0.05 && p.z < b.max.z - 0.05) return true;
  }
  return false;
}

describe.each(MODES)('world model + navigation — %s', (_name, caps) => {
  const room = livingRoom();
  const { world } = scanRoom(room, caps);
  const nav = new NavGrid(world);

  it('builds a reasonable number of nav nodes', () => {
    expect(nav.count).toBeGreaterThan(3000);
  });

  it('never puts a nav node inside solid furniture', () => {
    let bad = 0;
    for (let a = 0; a < nav.count; a++) {
      const p = nav.pos(a);
      if (thickSolidAt(room, { x: p.x, y: p.y + 0.08, z: p.z })) bad++;
    }
    expect(bad).toBe(0);
  });

  it('finds walkable space under the dining table and on its top', () => {
    const under = nav.nearest({ x: 1.85, y: 0, z: -1.7 }, 0.15);
    expect(under).toBeGreaterThanOrEqual(0);
    expect(nav.pos(under).y).toBeLessThan(0.06);
    const top = nav.nearest({ x: 1.85, y: 0.75, z: -1.7 }, 0.15);
    expect(nav.pos(top).y).toBeGreaterThan(0.7);
  });

  it('reaches the table top and the inside of the basket by jumping', () => {
    for (const goal of [
      { x: 1.83, y: 0.75, z: -1.72 },
      { x: 2.58, y: 0.03, z: 1.95 },
    ]) {
      const path = nav.findPath({ x: 0, y: 0, z: 0 }, goal);
      expect(path).not.toBeNull();
      expect(path!.some((w) => w.jump)).toBe(true);
      const end = path![path!.length - 1];
      expect(Math.hypot(end.x - goal.x, end.z - goal.z)).toBeLessThan(0.2);
    }
  });

  it('paths and jump arcs stay out of solid geometry', () => {
    const goals = [
      { x: 1.83, y: 0.75, z: -1.72 },
      { x: 2.58, y: 0.03, z: 1.95 },
      { x: -1.1, y: 0, z: -0.85 },
      { x: -2.5, y: 0, z: -1.2 },
    ];
    for (const goal of goals) {
      const path = nav.findPath({ x: 0, y: 0, z: 0 }, goal);
      if (!path) continue;
      for (let s = 1; s < path.length; s++) {
        const a = path[s - 1], b = path[s];
        for (let t = 0; t <= 1; t += 0.05) {
          const p = b.jump ? NavGrid.arcPoint(a, b, t, undefined, b.lift) : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
          expect(thickSolidAt(room, { x: p.x, y: p.y + 0.12, z: p.z }), `segment ${s} t=${t.toFixed(2)} of path to ${JSON.stringify(goal)}`).toBe(false);
        }
      }
    }
  });
});

describe('segmentation ("object detection")', () => {
  it('finds the main furniture in the living room with sensible labels', () => {
    const room = livingRoom();
    const { world } = scanRoom(room);
    const objs = segmentObjects(world);
    const near = (x: number, z: number) => objs.find((o) => x > o.min.x - 0.1 && x < o.max.x + 0.1 && z > o.min.z - 0.1 && z < o.max.z + 0.1 && o.label !== 'wall');
    expect(near(1.85, -1.7)?.label).toBe('table');
    expect(near(-1.2, -2.0)?.label).toBe('couch');
    expect(['basket', 'box']).toContain(near(2.57, 1.95)?.label);
    expect(objs.some((o) => o.label === 'wall')).toBe(true);
  });

  it('works in other rooms without crashing and finds several objects', () => {
    for (const room of [bedroom(), randomRoom(4), randomRoom(11)]) {
      const { world } = scanRoom(room);
      const objs = segmentObjects(world).filter((o) => o.label !== 'wall');
      expect(objs.length).toBeGreaterThanOrEqual(Math.min(3, room.pieces.length - 4));
    }
  });
});

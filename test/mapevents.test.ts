import { describe, expect, it } from 'vitest';
import { WorldModel, type MapEvent } from '../src/world/WorldModel';

/** Map events, the public lattice and per-chunk last-seen times (for persistence). */
describe('map interface for persistence', () => {
  it('reports window moves, warps, realigns and rewrites; per-chunk last-seen time', () => {
    const w = new WorldModel();
    w.sliceWarps = false;
    w.setFloor(0, { x: 0, y: 0, z: 0 });
    w.timeCode(0);
    const seen: MapEvent['kind'][] = [];
    w.mapListeners.push((e) => seen.push(e.kind));
    const g = w.grid!;
    g.stamp = 5;
    g.set(g.cellX(1.025), g.cellY(0.5), g.cellZ(0.025), 80);
    const L = w.windowLattice()!;
    expect(L).not.toBeNull();
    const cx = Math.floor((L.oi + g.cellX(1.025)) / 32), cz = Math.floor((L.ok + g.cellZ(0.025)) / 32);
    expect(w.chunkLastSeen(cx, cz)).toBeCloseTo(4, 5);
    expect(w.chunkLastSeen(cx + 50, cz)).toBeNull();
    w.moveWindow(1, 0);
    w.warpSince(0, 10, { dx: 0.1, dz: 0, dyaw: 0, pivot: { x: 0, z: 0 } });
    w.realign(0.05, 0, 0, { x: 0, y: 0, z: 0 }, 0);
    w.hardReset();
    expect(seen).toEqual(['window', 'warp', 'realign', 'rewrite']);
  });

  it("imports with mode 'exact' write unknowns too", () => {
    const a = new WorldModel();
    a.setFloor(0, { x: 0, y: 0, z: 0 });
    const ga = a.grid!;
    ga.set(ga.cellX(0.525), ga.cellY(0.5), ga.cellZ(0.525), 60);
    ga.markObserved(0.525, 0.525);
    const saved = a.exportMap()!;
    // Something else gets written into the same chunk later...
    ga.set(ga.cellX(0.625), ga.cellY(0.5), ga.cellZ(0.525), 70);
    a.importMap(saved, null, { mode: 'merge' });
    expect(ga.get(ga.cellX(0.625), ga.cellY(0.5), ga.cellZ(0.525))).toBe(70);
    // ...an exact import restores the chunk as saved (the later voxel back to unknown).
    a.importMap(saved, null, { mode: 'exact' });
    expect(ga.get(ga.cellX(0.625), ga.cellY(0.5), ga.cellZ(0.525))).toBe(0);
    expect(ga.get(ga.cellX(0.525), ga.cellY(0.5), ga.cellZ(0.525))).toBe(60);
  });
});

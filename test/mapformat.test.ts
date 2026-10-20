import { describe, expect, it } from 'vitest';
import { livingRoom } from '../src/sim/SimRoom';
import { scanRoom } from '../src/sim/scan';
import { WorldModel } from '../src/world/WorldModel';
import { NavGrid } from '../src/world/NavGrid';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';
import { chunkVoxels, serializedBytes } from '../src/world/MapFormat';

/** Map export / import (the persistence interface). */
describe('map export / import', () => {
  const room = livingRoom();
  const { world } = scanRoom(room);
  const m = world.exportMap()!;

  it('exports only chunks with information, in the documented layout', () => {
    expect(m.version).toBe(1);
    expect(m.chunks.length).toBeGreaterThan(4);
    // The fixed 12m grid holds 8x8 chunks; the 6x5m room touches fewer.
    expect(m.chunks.length).toBeLessThan(64);
    for (const c of m.chunks) {
      expect(c.occ.length).toBe(chunkVoxels(m));
      expect(c.observed.length).toBe(m.chunkSize * m.chunkSize);
    }
    expect(serializedBytes(m)).toBeGreaterThan(0);
    // Spot check the index formula against the live grid.
    const g = world.grid!;
    const C = m.chunkSize;
    let checked = 0;
    for (const c of m.chunks)
      for (const [i, j, k] of [[3, 5, 7], [17, 10, 2], [31, 20, 31]]) {
        const gi = c.cx * C + i, gk = c.cz * C + k;
        if (gi >= g.nx || gk >= g.nz) continue;
        expect(c.occ[(j * C + k) * C + i]).toBe(g.data[g.idx(gi, j, gk)]);
        checked++;
      }
    expect(checked).toBeGreaterThan(10);
  });

  it('round-trips into a fresh session (same frame)', () => {
    const w2 = new WorldModel();
    w2.setFloor(world.floorY, { x: 0, y: 0, z: 0 });
    w2.importMap(m);
    const a = world.grid!, b = w2.grid!;
    let diff = 0;
    for (let n = 0; n < a.data.length; n++) if (a.data[n] !== b.data[n]) diff++;
    expect(diff).toBe(0);
    let obs = 0;
    for (let n = 0; n < a.observed.length; n++) if (a.observed[n] !== b.observed[n]) obs++;
    expect(obs).toBe(0);
    // A usable nav graph straight away (dynamic obstacles — someone's feet a
    // moment ago — are deliberately not saved).
    a.loadTransient([]);
    const nav = new NavGrid(w2), nav0 = new NavGrid(world);
    expect(nav.count).toBe(nav0.count);
  });

  it('imports through a rigid transform (yaw + shift), into a map with another origin', () => {
    const yaw = 0.5, dx = 1.3, dz = -0.7;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // x' = R x + t, rotation about y (column-major).
    const T = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, dx, 0, dz, 1];
    const w2 = new WorldModel();
    w2.setFloor(world.floorY, { x: 0.37, y: 0, z: -0.21 });
    w2.importMap(m, T);
    const a = world.grid!, b = w2.grid!;
    let occ = 0, match = 0;
    for (let j = world.floorLayer + 2; j < a.ny; j += 2)
      for (let k = 0; k < a.nz; k += 3)
        for (let i = 0; i < a.nx; i += 3) {
          if (a.data[a.idx(i, j, k)] <= OCC_THRESHOLD + 20) continue;
          const x = a.centerX(i), y = a.centerY(j), z = a.centerZ(k);
          const X = c * x + s * z + dx, Z = -s * x + c * z + dz;
          const bi = b.cellX(X), bj = b.cellY(y), bk = b.cellZ(Z);
          if (!b.inBounds(bi, bj, bk)) continue;
          occ++;
          // Nearest-voxel resampling: allow a one-voxel neighbourhood.
          let hit = false;
          for (let dk = -1; dk <= 1 && !hit; dk++) for (let di = -1; di <= 1 && !hit; di++) if (b.occ(bi + di, bj, bk + dk)) hit = true;
          if (hit) match++;
        }
    expect(occ).toBeGreaterThan(300);
    expect(match / occ).toBeGreaterThan(0.97);
  });

  it('merges with weight: an old map does not overrule fresh evidence', () => {
    const w2 = new WorldModel();
    w2.setFloor(world.floorY, { x: 0, y: 0, z: 0 });
    const g = w2.grid!;
    // Fresh evidence: a voxel known free where the old map says occupied.
    const a = world.grid!;
    let n0 = -1;
    for (let n = a.nx * a.nz * (world.floorLayer + 4); n < a.data.length; n++)
      if (a.data[n] > 60) {
        n0 = n;
        break;
      }
    expect(n0).toBeGreaterThan(0);
    g.data[n0] = -40;
    w2.importMap(m, null, { weight: 0.5 });
    expect(g.data[n0]).toBeLessThan(0);
  });
});

import type { VoxelGrid } from './VoxelGrid';

/**
 * Map deformation for loop closure ("pose graph lite"). Odometry drift grows
 * gradually: structure mapped at time t sits off by however much the frame
 * had drifted by then. When a loop closure finds that the frame is off by Δ
 * now (at t1) and was right at t0, the error of structure mapped in between
 * is taken to have grown linearly with the distance walked, and each
 * occupied voxel is moved by its share α(t)·Δ of the correction, according
 * to when it was last observed (VoxelGrid.hitTime).
 *
 * Only voxels with occupancy evidence move (they carry a time). The space
 * they leave becomes unknown; free space stays where it is (it is re-carved
 * by the next look). Voxel layers don't change (the correction is a yaw
 * about `pivot` plus a horizontal shift).
 */
export interface Correction {
  dx: number;
  dz: number;
  dyaw: number;
  pivot: { x: number; z: number };
}

/**
 * Warp the occupied voxels of `g` whose hit time code lies in [code0, code1]
 * by alpha(code)·c. `minLayer`: layers below stay (solid sub-floor).
 * Returns the number of voxels moved.
 */
export function warpGrid(g: VoxelGrid, code0: number, code1: number, alpha: (code: number) => number, c: Correction, minLayer: number): number {
  const hit = g.hitTime;
  if (!hit) return 0;
  const nx = g.nx, nz = g.nz, ny = g.ny, layer = nx * nz, r = g.res;
  // Per time code: the scaled correction (cos, sin, shift) — at most 65536 entries, built lazily.
  const cache = new Map<number, [number, number, number, number]>();
  const corrFor = (code: number) => {
    let e = cache.get(code);
    if (!e) {
      const a = Math.max(0, Math.min(1, alpha(code)));
      const yaw = a * c.dyaw;
      e = [Math.cos(yaw), Math.sin(yaw), a * c.dx, a * c.dz];
      cache.set(code, e);
    }
    return e;
  };
  // Pass 1: find movers and their targets; clear their sources.
  const src: number[] = [], dst: number[] = [];
  const ox = g.origin.x, oz = g.origin.z, px = c.pivot.x, pz = c.pivot.z;
  for (let j = minLayer; j < ny; j++) {
    const base = j * layer;
    for (let k = 0; k < nz; k++)
      for (let i = 0; i < nx; i++) {
        const n = base + k * nx + i;
        const v = g.data[n];
        if (v <= 0 || v === 127) continue;
        const h = hit[n] & 0xffff;
        if (h < code0 || h > code1) continue;
        const [cs, sn, tx, tz] = corrFor(h);
        const x = ox + (i + 0.5) * r - px, z = oz + (k + 0.5) * r - pz;
        const X = px + cs * x + sn * z + tx, Z = pz - sn * x + cs * z + tz;
        const ti = Math.floor((X - ox) / r), tk = Math.floor((Z - oz) / r);
        if (ti === i && tk === k) continue;
        src.push(n);
        dst.push(ti >= 0 && tk >= 0 && ti < nx && tk < nz ? base + tk * nx + ti : -1);
      }
  }
  const m = src.length;
  const vals = new Int8Array(m), hits = new Uint32Array(m), tops = new Uint8Array(m), unders = new Uint8Array(m);
  for (let q = 0; q < m; q++) {
    const n = src[q];
    vals[q] = g.data[n];
    hits[q] = hit[n];
    tops[q] = g.topFrac[n];
    unders[q] = g.underside[n];
    g.data[n] = 0;
    hit[n] = 0;
    g.topFrac[n] = 255;
    g.underside[n] = 0;
  }
  // Pass 2: write them at their targets (the stronger evidence wins).
  for (let q = 0; q < m; q++) {
    const t = dst[q];
    if (t < 0) continue;
    const before = g.data[t];
    if (before >= vals[q] && before > 0) continue;
    g.data[t] = vals[q];
    hit[t] = hits[q];
    if (tops[q] !== 255) g.topFrac[t] = tops[q];
    g.underside[t] |= unders[q];
  }
  if (m) {
    g.touchAll();
    g.version++;
  }
  return m;
}

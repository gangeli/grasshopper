import type { VoxelGrid } from './VoxelGrid';
import { OCC_THRESHOLD } from './VoxelGrid';

/**
 * Turns the occupancy map into a depth-only mesh so real furniture hides the
 * virtual pet (the essence of hide and seek in AR). Faces between occupied
 * and free voxels are greedily merged into rectangles per slice, which keeps
 * the triangle count low enough for phones. Returns triangle positions
 * (xyz per vertex). No three.js here: it also runs in the nav worker.
 */
export function occluderPositions(g: VoxelGrid, center: { x: number; z: number }, radius: number, minLayer: number): Float32Array {
  const i0 = Math.max(0, g.cellX(center.x - radius)), i1 = Math.min(g.nx - 1, g.cellX(center.x + radius));
  const k0 = Math.max(0, g.cellZ(center.z - radius)), k1 = Math.min(g.nz - 1, g.cellZ(center.z + radius));
  const j0 = minLayer, j1 = g.ny - 1;
  const r = g.res, o = g.origin;
  const dims = [i1 - i0 + 1, j1 - j0 + 1, k1 - k0 + 1];
  const base = [i0, j0, k0];
  // Snapshot the region's occupancy once (the sweep below reads each cell ~6 times).
  const [DX, DY, DZ] = dims;
  const occGrid = new Uint8Array(DX * DY * DZ);
  for (let j = 0; j < DY; j++)
    for (let k = 0; k < DZ; k++) {
      let src = g.idx(i0, j0 + j, k0 + k);
      let dst = (j * DZ + k) * DX;
      for (let i = 0; i < DX; i++) occGrid[dst++] = g.data[src++] > OCC_THRESHOLD ? 1 : 0;
    }
  const strides = [1, DZ * DX, DX];
  const P = [0, 0, 0], DU = [0, 0, 0], DV = [0, 0, 0];
  const C = new Float64Array(12);
  const corner = (q: number, a0: number, a1: number, a2: number) => {
    C[q * 3] = o.x + (base[0] + a0) * r;
    C[q * 3 + 1] = o.y + (base[1] + a1) * r;
    C[q * 3 + 2] = o.z + (base[2] + a2) * r;
  };
  let pos = new Float32Array(1 << 15);
  let len = 0;
  const put = (c: number) => {
    pos[len++] = C[c * 3];
    pos[len++] = C[c * 3 + 1];
    pos[len++] = C[c * 3 + 2];
  };
  const emit = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    if (len + 18 > pos.length) {
      const grown = new Float32Array(pos.length * 2);
      grown.set(pos);
      pos = grown;
    }
    put(a);
    put(b);
    put(c);
    put(d);
    put(e);
    put(f);
  };
  // For each axis d and direction s, sweep slices and greedy-merge the face mask.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const mask = new Int8Array(dims[u] * dims[v]);
    const x = [0, 0, 0];
    for (x[d] = 0; x[d] <= dims[d]; x[d]++) {
      // Build mask: +1 face facing +d (solid behind, free ahead), -1 facing -d.
      let n = 0;
      const xd = x[d], su = strides[u], sv = strides[v], sd = strides[d];
      const hasA = xd > 0, hasB = xd < dims[d];
      const baseOff = xd * sd;
      for (let jv = 0; jv < dims[v]; jv++) {
        let off = baseOff + jv * sv;
        for (let iu = 0; iu < dims[u]; iu++, n++, off += su) {
          const a = hasA && occGrid[off - sd] === 1;
          const b = hasB && occGrid[off] === 1;
          mask[n] = a === b ? 0 : a ? 1 : -1;
        }
      }
      // Greedy merge.
      n = 0;
      for (let jv = 0; jv < dims[v]; jv++)
        for (let iu = 0; iu < dims[u]; ) {
          const c = mask[n];
          if (!c) {
            iu++;
            n++;
            continue;
          }
          let w = 1;
          while (iu + w < dims[u] && mask[n + w] === c) w++;
          let h = 1;
          outer: for (; jv + h < dims[v]; h++)
            for (let q = 0; q < w; q++) if (mask[n + q + h * dims[u]] !== c) break outer;
          // Emit quad (corners into scratch, no arrays per quad).
          P[0] = P[1] = P[2] = 0;
          P[d] = x[d];
          P[u] = iu;
          P[v] = jv;
          DU[0] = DU[1] = DU[2] = DV[0] = DV[1] = DV[2] = 0;
          DU[u] = w;
          DV[v] = h;
          corner(0, P[0], P[1], P[2]);
          corner(1, P[0] + DU[0], P[1] + DU[1], P[2] + DU[2]);
          corner(2, P[0] + DU[0] + DV[0], P[1] + DU[1] + DV[1], P[2] + DU[2] + DV[2]);
          corner(3, P[0] + DV[0], P[1] + DV[1], P[2] + DV[2]);
          if (c > 0) emit(0, 1, 2, 0, 2, 3);
          else emit(0, 2, 1, 0, 3, 2);
          for (let hh = 0; hh < h; hh++) for (let q = 0; q < w; q++) mask[n + q + hh * dims[u]] = 0;
          iu += w;
          n += w;
        }
    }
  }
  return pos.slice(0, len);
}

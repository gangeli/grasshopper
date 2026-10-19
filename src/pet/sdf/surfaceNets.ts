/**
 * Narrow-band naive surface nets: meshes an SDF into a smooth, watertight
 * quad-dominant surface (triangulated). One vertex per sign-changing cell,
 * placed at the mean of edge crossings and then projected onto the surface.
 */
export interface SdfMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export function surfaceNets(
  d: (x: number, y: number, z: number) => number,
  min: [number, number, number],
  max: [number, number, number],
  h: number,
  /** Gradient steps that pull vertices onto the exact surface (0 keeps the smoother cell averages). */
  project = 2,
): SdfMesh {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const N = nx * ny * nz;
  const val = new Float32Array(N);
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // Coarse pass (every C cells) to find the band near the surface.
  const C = 4;
  const cnx = Math.ceil(nx / C) + 1, cny = Math.ceil(ny / C) + 1, cnz = Math.ceil(nz / C) + 1;
  const coarse = new Float32Array(cnx * cny * cnz);
  for (let k = 0; k < cnz; k++)
    for (let j = 0; j < cny; j++)
      for (let i = 0; i < cnx; i++) coarse[(k * cny + j) * cnx + i] = d(min[0] + i * C * h, min[1] + j * C * h, min[2] + k * C * h);
  const band = C * h * 1.8;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const ci = Math.round(i / C), cj = Math.round(j / C), ck = Math.round(k / C);
        const cv = coarse[(Math.min(ck, cnz - 1) * cny + Math.min(cj, cny - 1)) * cnx + Math.min(ci, cnx - 1)];
        val[idx(i, j, k)] = Math.abs(cv) > band ? Math.sign(cv) * band : d(min[0] + i * h, min[1] + j * h, min[2] + k * h);
      }

  // One vertex per cell with a sign change.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
  const corner = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = val[idx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + (((b & 1) - (a & 1)) * t);
          sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
          sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
          n++;
        }
        cellVert[cidx(i, j, k)] = pos.length / 3;
        pos.push(min[0] + (i + sx / n) * h, min[1] + (j + sy / n) * h, min[2] + (k + sz / n) * h);
      }

  // Quads across each sign-changing grid edge.
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, e: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    if (flip) tris.push(a, c, b, a, e, c);
    else tris.push(a, b, c, a, c, e);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = val[idx(i, j, k)];
        // +X edge
        if (i < nx - 1) {
          const v1 = val[idx(i + 1, j, k)];
          if (v0 < 0 !== v1 < 0) quad(cellVert[cidx(i, j - 1, k - 1)], cellVert[cidx(i, j, k - 1)], cellVert[cidx(i, j, k)], cellVert[cidx(i, j - 1, k)], v0 < 0);
        }
        if (j < ny - 1) {
          const v1 = val[idx(i, j + 1, k)];
          if (v0 < 0 !== v1 < 0) quad(cellVert[cidx(i - 1, j, k - 1)], cellVert[cidx(i - 1, j, k)], cellVert[cidx(i, j, k)], cellVert[cidx(i, j, k - 1)], v0 < 0);
        }
        if (k < nz - 1) {
          const v1 = val[idx(i, j, k + 1)];
          if (v0 < 0 !== v1 < 0) quad(cellVert[cidx(i - 1, j - 1, k)], cellVert[cidx(i, j - 1, k)], cellVert[cidx(i, j, k)], cellVert[cidx(i - 1, j, k)], v0 < 0);
        }
      }

  // Project onto the surface and compute normals from the SDF gradient.
  const P = new Float32Array(pos);
  const Nrm = new Float32Array(P.length);
  const e = h * 0.25;
  for (let v = 0; v < P.length; v += 3) {
    let x = P[v], y = P[v + 1], z = P[v + 2];
    let gx = 0, gy = 0, gz = 1;
    for (let it = 0; it <= project; it++) {
      gx = d(x + e, y, z) - d(x - e, y, z);
      gy = d(x, y + e, z) - d(x, y - e, z);
      gz = d(x, y, z + e) - d(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl;
      gy /= gl;
      gz /= gl;
      if (it < project) {
        const dv = d(x, y, z);
        // Don't let projection move a vertex out of its cell neighbourhood.
        const step = Math.max(-h, Math.min(h, dv));
        x -= gx * step;
        y -= gy * step;
        z -= gz * step;
      }
    }
    P[v] = x;
    P[v + 1] = y;
    P[v + 2] = z;
    Nrm[v] = gx;
    Nrm[v + 1] = gy;
    Nrm[v + 2] = gz;
  }
  return { positions: P, normals: Nrm, indices: new Uint32Array(tris) };
}

const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

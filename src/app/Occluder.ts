import * as THREE from 'three';
import type { VoxelGrid } from '../world/VoxelGrid';
import { OCC_THRESHOLD } from '../world/VoxelGrid';

/**
 * Turns the occupancy map into a depth-only mesh so real furniture hides the
 * virtual pet (the essence of hide and seek in AR). Faces between occupied
 * and free voxels are greedily merged into rectangles per slice, which keeps
 * the triangle count low enough for phones.
 */
export function buildOccluderGeometry(g: VoxelGrid, center: THREE.Vector3, radius: number, minLayer: number): THREE.BufferGeometry {
  const i0 = Math.max(0, g.cellX(center.x - radius)), i1 = Math.min(g.nx - 1, g.cellX(center.x + radius));
  const k0 = Math.max(0, g.cellZ(center.z - radius)), k1 = Math.min(g.nz - 1, g.cellZ(center.z + radius));
  const j0 = minLayer, j1 = g.ny - 1;
  const pos: number[] = [];
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
          // Emit quad.
          const p = [0, 0, 0];
          p[d] = x[d];
          p[u] = iu;
          p[v] = jv;
          const du = [0, 0, 0], dv = [0, 0, 0];
          du[u] = w;
          dv[v] = h;
          const corner = (a: number[]) => [o.x + (base[0] + a[0]) * r, o.y + (base[1] + a[1]) * r, o.z + (base[2] + a[2]) * r];
          const p0 = corner(p);
          const p1 = corner([p[0] + du[0], p[1] + du[1], p[2] + du[2]]);
          const p2 = corner([p[0] + du[0] + dv[0], p[1] + du[1] + dv[1], p[2] + du[2] + dv[2]]);
          const p3 = corner([p[0] + dv[0], p[1] + dv[1], p[2] + dv[2]]);
          if (c > 0) pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
          else pos.push(...p0, ...p2, ...p1, ...p0, ...p3, ...p2);
          for (let hh = 0; hh < h; hh++) for (let q = 0; q < w; q++) mask[n + q + hh * dims[u]] = 0;
          iu += w;
          n += w;
        }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

export class Occluder {
  readonly mesh: THREE.Mesh;
  private builtVersion = -1;
  private builtGrid: VoxelGrid | null = null;
  private builtCenter = new THREE.Vector3(1e9, 0, 0);
  readonly material: THREE.MeshBasicMaterial;
  /** Visible (tinted) for debugging instead of depth-only. */
  set debugVisible(on: boolean) {
    this.material.colorWrite = on;
    this.material.opacity = on ? 0.35 : 1;
    this.material.transparent = on;
    this.material.needsUpdate = true;
  }

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ color: 0x66ccff, colorWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'occluder';
    // Draw before everything else so it fills the depth buffer first.
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  /** Rebuild when the map changed or the pet moved far from the last build centre. */
  update(g: VoxelGrid, center: THREE.Vector3, minLayer: number, force = false): boolean {
    // A rebuilt map is a new grid object whose version restarts: compare identity too.
    if (!force && g === this.builtGrid && g.version === this.builtVersion && center.distanceTo(this.builtCenter) < 1.0) return false;
    this.builtGrid = g;
    this.mesh.geometry.dispose();
    this.mesh.geometry = buildOccluderGeometry(g, center, 3.5, minLayer);
    this.builtVersion = g.version;
    this.builtCenter.copy(center);
    return true;
  }
}

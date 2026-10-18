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
  const occ = (i: number, j: number, k: number) => i >= i0 && i <= i1 && k >= k0 && k <= k1 && j >= j0 && j <= j1 && g.data[g.idx(i, j, k)] > OCC_THRESHOLD;
  const pos: number[] = [];
  const r = g.res, o = g.origin;
  const dims = [i1 - i0 + 1, j1 - j0 + 1, k1 - k0 + 1];
  const base = [i0, j0, k0];
  // For each axis d and direction s, sweep slices and greedy-merge the face mask.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const mask = new Int8Array(dims[u] * dims[v]);
    const x = [0, 0, 0];
    for (x[d] = 0; x[d] <= dims[d]; x[d]++) {
      // Build mask: +1 face facing +d (solid behind, free ahead), -1 facing -d.
      let n = 0;
      for (x[v] = 0; x[v] < dims[v]; x[v]++)
        for (x[u] = 0; x[u] < dims[u]; x[u]++, n++) {
          const a = x[d] > 0 && occAt(x, d, -1);
          const b = x[d] < dims[d] && occAt(x, d, 0);
          mask[n] = a === b ? 0 : a ? 1 : -1;
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

  function occAt(x: number[], d: number, off: number) {
    const c = [x[0], x[1], x[2]];
    c[d] += off;
    return occ(base[0] + c[0], base[1] + c[1], base[2] + c[2]);
  }
}

export class Occluder {
  readonly mesh: THREE.Mesh;
  private builtVersion = -1;
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
    if (!force && g.version === this.builtVersion && center.distanceTo(this.builtCenter) < 1.0) return false;
    this.mesh.geometry.dispose();
    this.mesh.geometry = buildOccluderGeometry(g, center, 3.5, minLayer);
    this.builtVersion = g.version;
    this.builtCenter.copy(center);
    return true;
  }
}

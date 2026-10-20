import type { Vec3 } from '../core/math';
import type { WorldModel } from './WorldModel';

/**
 * Lightweight "object detection" over the occupancy map: group occupied
 * columns into connected footprints and classify each by shape (height,
 * overhang, hollowness). Semantic labels from the device (Quest's room setup,
 * plane labels) win when present.
 */
export interface WorldObject {
  id: number;
  label: string;
  min: Vec3;
  max: Vec3;
  /** Fraction of footprint columns with free space beneath the top (tables, beds). */
  overhang: number;
  /** Interior lower than its rim (baskets, boxes). */
  hollow: boolean;
  columns: number;
  /** The footprint's grid columns (k * nx + i), for "is this spot near it" checks. */
  cells: Set<number>;
  grid: { ox: number; oz: number; res: number; nx: number; nz: number };
}

export function segmentObjects(world: WorldModel, maxHeight = 2.6): WorldObject[] {
  const g = world.grid;
  if (!g) return [];
  const j0 = world.floorLayer + 1; // ignore floor noise in the first layer
  const j1 = Math.min(g.ny - 1, world.floorLayer + Math.floor(maxHeight / g.res));
  const N = g.nx * g.nz;
  const top = new Int16Array(N).fill(-1);
  const bottom = new Int16Array(N).fill(-1);
  // Unknown space under observed tops counts as solid (see VoxelGrid.updateShadow).
  g.updateShadow();
  for (let k = 0; k < g.nz; k++)
    for (let i = 0; i < g.nx; i++) {
      for (let j = j0; j <= j1; j++)
        if (g.occ(i, j, k) || (bottom[k * g.nx + i] < 0 && g.solid(i, j, k) && g.data[g.idx(i, j, k)] >= 0)) {
          if (bottom[k * g.nx + i] < 0) bottom[k * g.nx + i] = j;
          top[k * g.nx + i] = j;
        }
    }
  const comp = new Int32Array(N).fill(-1);
  const objects: WorldObject[] = [];
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (top[s] < 0 || comp[s] >= 0) continue;
    const id = objects.length;
    let cols = 0, over = 0;
    let mnI = Infinity, mxI = -Infinity, mnK = Infinity, mxK = -Infinity, mxJ = 0;
    const members: number[] = [];
    stack.push(s);
    comp[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      const i = c % g.nx, k = (c / g.nx) | 0;
      cols++;
      mnI = Math.min(mnI, i);
      mxI = Math.max(mxI, i);
      mnK = Math.min(mnK, k);
      mxK = Math.max(mxK, k);
      mxJ = Math.max(mxJ, top[c]);
      // Free space of 20cm+ under the top: a table or bed rather than a couch with feet.
      if ((bottom[c] - world.floorLayer) * g.res >= 0.2) over++;
      for (const [di, dk] of NB) {
        const ii = i + di, kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz) continue;
        const n = kk * g.nx + ii;
        // Only join columns of similar height so furniture against a wall stays separate.
        if (top[n] >= 0 && comp[n] < 0 && Math.abs(top[n] - top[c]) * g.res < 0.5) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
    if (cols < 3) continue;
    // Hollow: interior columns notably lower than the max rim height.
    const h = (mxJ - world.floorLayer + 1) * g.res;
    let low = 0;
    for (const c of members) if ((top[c] - world.floorLayer + 1) * g.res < h * 0.4) low++;
    const obj: WorldObject = {
      id,
      label: 'thing',
      min: { x: g.origin.x + mnI * g.res, y: world.floorY, z: g.origin.z + mnK * g.res },
      max: { x: g.origin.x + (mxI + 1) * g.res, y: world.floorY + h, z: g.origin.z + (mxK + 1) * g.res },
      overhang: over / cols,
      hollow: low > cols * 0.2 && h < 0.7,
      columns: cols,
      cells: new Set(members),
      grid: { ox: g.origin.x, oz: g.origin.z, res: g.res, nx: g.nx, nz: g.nz },
    };
    obj.label = classify(obj, world);
    objects.push(obj);
  }
  return objects;
}

const NB = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function classify(o: WorldObject, world: WorldModel): string {
  // Device-provided semantic labels take priority.
  let best: string | null = null, bestOverlap = 0;
  for (const r of world.labels.values()) {
    if (r.label === 'floor') continue;
    const ox = Math.max(0, Math.min(o.max.x, r.max.x) - Math.max(o.min.x, r.min.x));
    const oz = Math.max(0, Math.min(o.max.z, r.max.z) - Math.max(o.min.z, r.min.z));
    const ov = ox * oz;
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = r.label;
    }
  }
  const w = o.max.x - o.min.x, d = o.max.z - o.min.z, h = o.max.y - o.min.y;
  if (best && bestOverlap > 0.3 * w * d) return best;
  const area = w * d;
  const thin = Math.min(w, d);
  const fill = (o.columns * world.res * world.res) / Math.max(area, 1e-6);
  // Tall and thin or sparse: walls (often seen only up to ~1.3m, as the phone
  // looks down), or walls joined with what stands against them — not a shelf.
  if (h > 1.0 && (thin < 0.25 || fill < 0.35)) return 'wall';
  if (h > 1.2 && thin < 0.7) return 'shelf';
  if (h > 1.2) return 'thing';
  if (o.hollow) return 'basket';
  if (o.overhang > 0.5 && area < 0.4) return h > 1.0 ? 'plant' : 'chair';
  if (o.overhang > 0.5) {
    if (h < 0.6 && area > 1.8) return 'bed';
    if (h < 0.6) return 'coffee table';
    return 'table';
  }
  if (h > 0.6 && area > 0.9) return 'couch';
  if (h > 0.7) return 'chair';
  if (h < 0.7 && area < 0.5) return 'box';
  return 'thing';
}

/**
 * The object whose footprint is nearest to p (within `pad`). Footprint cells,
 * not bounding boxes: an L-shaped run of walls has a box covering half the
 * room, which made open floor "near the shelf".
 */
export function objectNear(objects: WorldObject[], p: Vec3, pad = 0.25): WorldObject | null {
  let best: WorldObject | null = null, bd = Infinity;
  for (const o of objects) {
    if (o.label === 'wall') continue;
    const dx = Math.max(o.min.x - p.x, 0, p.x - o.max.x);
    const dz = Math.max(o.min.z - p.z, 0, p.z - o.max.z);
    if (Math.hypot(dx, dz) >= pad) continue; // cheap reject on the box
    const G = o.grid, ci = Math.floor((p.x - G.ox) / G.res), ck = Math.floor((p.z - G.oz) / G.res);
    const R = Math.ceil(pad / G.res);
    for (let dk = -R; dk <= R; dk++)
      for (let di = -R; di <= R; di++) {
        const i = ci + di, k = ck + dk;
        if (i < 0 || k < 0 || i >= G.nx || k >= G.nz || !o.cells.has(k * G.nx + i)) continue;
        const d = Math.hypot(G.ox + (i + 0.5) * G.res - p.x, G.oz + (k + 0.5) * G.res - p.z);
        if (d < pad && d < bd) {
          bd = d;
          best = o;
        }
      }
  }
  return best;
}

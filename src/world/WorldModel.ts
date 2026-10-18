import type { Vec3 } from '../core/math';
import { VoxelGrid } from './VoxelGrid';

/**
 * Everything the pet knows about the physical room. It fuses the sensor
 * streams a WebXR device can offer (planes, meshes, depth, hit tests) into one
 * occupancy grid, which navigation, hiding-spot search and occlusion read.
 * The simulator feeds exactly the same inputs.
 */

export interface PlaneInput {
  id: string;
  /** Polygon vertices in world space, on the plane. */
  polygon: Vec3[];
  /** Unit normal pointing away from the solid side (up for floors and table tops). */
  normal: Vec3;
  label?: string;
}

export interface MeshInput {
  id: string;
  /** Flat xyz world-space vertex positions. */
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  label?: string;
}

export interface LabeledRegion {
  id: string;
  label: string;
  min: Vec3;
  max: Vec3;
}

export interface WorldModelOptions {
  res?: number;
  /** Horizontal half-extent of the mapped area (meters). */
  halfExtent?: number;
  height?: number;
}

export const FLOOR_LAYERS_BELOW = 2;
/** Weakly-free: inferred, not observed. Depth-based navigation doesn't trust it. */
export const ASSUMED_FREE = -1;
const HOLLOW_LABELS = new Set(['table', 'desk', 'bed', 'shelf']);

export class WorldModel {
  grid: VoxelGrid | null = null;
  floorY = 0;
  readonly res: number;
  readonly halfExtent: number;
  readonly height: number;
  readonly labels = new Map<string, LabeledRegion>();
  private planeVersions = new Map<string, string>();
  /** Number of depth points integrated so far (diagnostics/HUD). */
  depthPoints = 0;

  constructor(opts: WorldModelOptions = {}) {
    this.res = opts.res ?? 0.05;
    this.halfExtent = opts.halfExtent ?? 6;
    this.height = opts.height ?? 2.6;
  }

  get ready(): boolean {
    return this.grid !== null;
  }

  /** First layer of free space above the floor. */
  get floorLayer(): number {
    return FLOOR_LAYERS_BELOW;
  }

  /** Establish the floor height and an anchor point; allocates the grid. */
  setFloor(y: number, center: Vec3): void {
    if (this.grid) return;
    const r = this.res;
    const n = Math.ceil((this.halfExtent * 2) / r);
    const ny = Math.ceil(this.height / r) + FLOOR_LAYERS_BELOW;
    this.floorY = y;
    // Snap the origin so the floor is exactly at a cell boundary.
    this.grid = new VoxelGrid({
      origin: { x: center.x - (n / 2) * r, y: y - FLOOR_LAYERS_BELOW * r, z: center.z - (n / 2) * r },
      res: r,
      nx: n,
      ny,
      nz: n,
    });
    // The below-floor layers are solid everywhere; whether you may *walk* there
    // is governed by the observed mask.
    const g = this.grid;
    for (let j = 0; j < FLOOR_LAYERS_BELOW; j++)
      for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) g.data[g.idx(i, j, k)] = 127;
  }

  isFloorHeight(y: number, tol = 0.06): boolean {
    return Math.abs(y - this.floorY) < tol;
  }

  /** A hit-test result on a surface, e.g. where the user tapped. */
  ingestHit(p: Vec3, normal?: Vec3): void {
    if (!this.grid) return;
    if ((!normal || normal.y > 0.8) && this.isFloorHeight(p.y)) this.grid.markObserved(p.x, p.z, 4);
  }

  ingestPlane(plane: PlaneInput): void {
    const g = this.grid;
    if (!g || plane.polygon.length < 3) return;
    // Skip re-rasterizing an unchanged plane.
    const sig = plane.polygon.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(';');
    if (this.planeVersions.get(plane.id) === sig) return;
    this.planeVersions.set(plane.id, sig);

    const n = normalize(plane.normal);
    const horizontal = Math.abs(n.y) > 0.85;
    const c = centroid(plane.polygon);
    if (horizontal && n.y > 0 && this.isFloorHeight(c.y, 0.1)) {
      // Floor: rasterize into the observed mask.
      rasterizePolygon(plane.polygon, n, g.res * 0.7, (p) => g.markObserved(p.x, p.z));
      return;
    }
    if (horizontal && n.y < 0) return; // ceilings: irrelevant for a small pet
    // Raised horizontal planes: tables/desks/beds are slabs you can get under;
    // low unlabeled surfaces (seats, ottomans) are assumed solid to the floor
    // since plane detection alone can't tell us what's beneath them.
    const heightAboveFloor = c.y - this.floorY;
    const label = plane.label?.toLowerCase();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const q of plane.polygon) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z);
      maxZ = Math.max(maxZ, q.z);
    }
    // Narrow strips (couch backs, arm rests, shelves' tops) are almost never hollow.
    const narrow = Math.min(maxX - minX, maxZ - minZ) < 0.3;
    const hollow = label ? HOLLOW_LABELS.has(label) : heightAboveFloor >= 0.6 && !narrow;
    const thickness = horizontal ? (hollow ? 0.04 : Math.max(0.04, heightAboveFloor)) : 0.08;
    const min = { x: 0, y: 0, z: 0 }, max = { x: 0, y: 0, z: 0 };
    rasterizePolygon(plane.polygon, n, g.res * 0.7, (p) => {
      // Extrude into the solid side of the plane.
      const q = { x: p.x - n.x * thickness, y: p.y - n.y * thickness, z: p.z - n.z * thickness };
      min.x = Math.min(p.x, q.x) - 1e-3;
      min.y = Math.min(p.y, q.y) - 1e-3;
      min.z = Math.min(p.z, q.z) - 1e-3;
      max.x = Math.max(p.x, q.x) + 1e-3;
      max.y = Math.max(p.y, q.y) + 1e-3;
      max.z = Math.max(p.z, q.z) + 1e-3;
      g.fillBox(min, max, 100);
    });
    if (horizontal && hollow) {
      // Plane detection says "table": assume open space beneath it.
      rasterizePolygon(plane.polygon, n, g.res * 0.7, (p) => {
        const i = g.cellX(p.x), k = g.cellZ(p.z);
        const jTop = g.cellY(p.y - thickness) - 1;
        for (let j = this.floorLayer; j <= jTop; j++) if (g.get(i, j, k) === 0) g.set(i, j, k, ASSUMED_FREE);
      });
    }
    if (plane.label) this.addLabel(plane.id, plane.label, plane.polygon, horizontal ? -0.05 : 0);
  }

  ingestMesh(mesh: MeshInput): void {
    const g = this.grid;
    if (!g) return;
    const P = mesh.positions, I = mesh.indices;
    const step = g.res * 0.5;
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 };
    const pts: Vec3[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
      load(P, I[t], a);
      load(P, I[t + 1], b);
      load(P, I[t + 2], c);
      const e1 = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const e2 = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
      const nu = Math.max(1, Math.ceil(e1 / step)), nv = Math.max(1, Math.ceil(e2 / step));
      // Triangle normal from CCW winding (outward-facing, as XR meshes are).
      const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
      const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const down = ny < -0.7 * Math.hypot(nx, ny, nz);
      for (let u = 0; u <= nu; u++)
        for (let v = 0; v <= nv - (u * nv) / nu; v++) {
          const fu = u / nu, fv = v / nv;
          const x = a.x + (b.x - a.x) * fu + (c.x - a.x) * fv;
          const y = a.y + (b.y - a.y) * fu + (c.y - a.y) * fv;
          const z = a.z + (b.z - a.z) * fu + (c.z - a.z) * fv;
          if (y < this.floorY + 0.03) {
            g.markObserved(x, z);
          } else {
            const i = g.cellX(x), j = g.cellY(y), k = g.cellZ(z);
            if (g.get(i, j, k) < 100) g.set(i, j, k, 100);
            if (down && g.inBounds(i, j, k)) g.underside[g.idx(i, j, k)] = 1;
          }
          if (mesh.label) pts.push({ x, y, z });
        }
    }
    if (mesh.label && pts.length) this.addLabel(mesh.id, mesh.label, pts, 0);
  }

  /**
   * Integrate a set of depth samples taken from `eye`. Points near the floor
   * mark the floor as observed; others mark occupancy and carve free space.
   */
  ingestDepth(eye: Vec3, points: Vec3[], maxRange = 4.5): void {
    const g = this.grid;
    if (!g) return;
    for (const p of points) {
      const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
      if (d < 0.1) continue;
      const far = d > maxRange;
      const target = far
        ? { x: eye.x + ((p.x - eye.x) * maxRange) / d, y: eye.y + ((p.y - eye.y) * maxRange) / d, z: eye.z + ((p.z - eye.z) * maxRange) / d }
        : p;
      if (!far && p.y < this.floorY + 0.035) {
        g.markObserved(p.x, p.z);
        // Free space down to just above the floor.
        g.integrateRay(eye, { x: p.x, y: this.floorY + 0.03, z: p.z }, false);
      } else {
        g.integrateRay(eye, target, !far);
      }
      this.depthPoints++;
    }
  }

  private addLabel(id: string, label: string, pts: Vec3[], padBelow: number) {
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of pts) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }
    min.y += padBelow;
    this.labels.set(id, { id, label: label.toLowerCase(), min, max });
  }
}

function load(P: ArrayLike<number>, i: number, out: Vec3) {
  out.x = P[i * 3];
  out.y = P[i * 3 + 1];
  out.z = P[i * 3 + 2];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function centroid(pts: Vec3[]): Vec3 {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    c.x += p.x;
    c.y += p.y;
    c.z += p.z;
  }
  c.x /= pts.length;
  c.y /= pts.length;
  c.z /= pts.length;
  return c;
}

/** Calls `visit` with world-space points sampled on a grid covering the (convex or not) polygon. */
export function rasterizePolygon(poly: Vec3[], normal: Vec3, step: number, visit: (p: Vec3) => void): void {
  const n = normalize(normal);
  // Plane basis.
  const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  let u = cross(ref, n);
  u = normalize(u);
  const v = cross(n, u);
  const o = poly[0];
  const p2 = poly.map((p) => {
    const d = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
    return [dot(d, u), dot(d, v)] as [number, number];
  });
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [a, b] of p2) {
    minU = Math.min(minU, a);
    maxU = Math.max(maxU, a);
    minV = Math.min(minV, b);
    maxV = Math.max(maxV, b);
  }
  for (let a = minU; a <= maxU + 1e-9; a += step)
    for (let b = minV; b <= maxV + 1e-9; b += step) {
      if (!pointInPoly2(a, b, p2)) continue;
      visit({ x: o.x + u.x * a + v.x * b, y: o.y + u.y * a + v.y * b, z: o.z + u.z * a + v.z * b });
    }
}

function pointInPoly2(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    // Treat points on the boundary as inside by expanding slightly.
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi + 1e-6) inside = !inside;
  }
  return inside;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

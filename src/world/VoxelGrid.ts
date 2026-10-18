import type { Vec3 } from '../core/math';

/**
 * Log-odds occupancy grid. Y is up. The grid's bottom layers sit just below the
 * floor so that layer `floorLayer` is the first layer of free space above it.
 *
 * Values are stored as Int8 log-odds. Sensor sources write with different
 * confidence: geometry from plane/mesh detection writes strongly, depth points
 * write incrementally and free-space carving slowly erodes stale occupancy.
 */
export interface VoxelGridOptions {
  /** World-space position of the min corner of cell (0,0,0). */
  origin: Vec3;
  res: number;
  nx: number;
  ny: number;
  nz: number;
}

export const OCC_THRESHOLD = 20;
/**
 * Cells in [SOFT_SOLID, OCC_THRESHOLD] are *guessed* solid (e.g. below a seat
 * found by plane detection). Navigation avoids them, but they don't occlude
 * the line of sight, since a wrong guess there would hide the pet for no
 * visible reason.
 */
export const SOFT_SOLID = 10;
const MAX_LO = 120;
const MIN_LO = -60;

const cls = (v: number) => (v > OCC_THRESHOLD ? 2 : v >= SOFT_SOLID ? 1 : 0);

export interface RayHit {
  t: number;
  i: number;
  j: number;
  k: number;
}

export class VoxelGrid {
  readonly origin: Vec3;
  readonly res: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly data: Int8Array;
  /** Per-column flag: floor here has been observed (by planes or depth). */
  readonly observed: Uint8Array;
  /**
   * Per-voxel bits: 1 = a downward-facing mesh surface passes here, 2 = an
   * upward-facing one. "Underside only" (=== 1) voxels come from a downward-facing mesh surface (the
   * bottom of a couch, a table's underside). Standing on top of one would mean
   * standing *inside* the object, so navigation ignores those surfaces.
   */
  readonly underside: Uint8Array;
  /** Increments whenever occupancy changes meaningfully, so derived data can be cached. */
  version = 0;

  constructor(o: VoxelGridOptions) {
    this.origin = { ...o.origin };
    this.res = o.res;
    this.nx = o.nx;
    this.ny = o.ny;
    this.nz = o.nz;
    this.data = new Int8Array(o.nx * o.ny * o.nz);
    this.observed = new Uint8Array(o.nx * o.nz);
    this.underside = new Uint8Array(o.nx * o.ny * o.nz);
  }

  idx(i: number, j: number, k: number): number {
    return (j * this.nz + k) * this.nx + i;
  }
  inBounds(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz;
  }
  cellX(x: number) {
    return Math.floor((x - this.origin.x) / this.res);
  }
  cellY(y: number) {
    return Math.floor((y - this.origin.y) / this.res);
  }
  cellZ(z: number) {
    return Math.floor((z - this.origin.z) / this.res);
  }
  centerX(i: number) {
    return this.origin.x + (i + 0.5) * this.res;
  }
  centerY(j: number) {
    return this.origin.y + (j + 0.5) * this.res;
  }
  centerZ(k: number) {
    return this.origin.z + (k + 0.5) * this.res;
  }

  get(i: number, j: number, k: number): number {
    if (!this.inBounds(i, j, k)) return 0;
    return this.data[this.idx(i, j, k)];
  }
  occ(i: number, j: number, k: number): boolean {
    if (!this.inBounds(i, j, k)) return false;
    return this.data[this.idx(i, j, k)] > OCC_THRESHOLD;
  }
  occAt(p: Vec3): boolean {
    return this.occ(this.cellX(p.x), this.cellY(p.y), this.cellZ(p.z));
  }

  /** Add `delta` log-odds to a cell, clamped. */
  add(i: number, j: number, k: number, delta: number): void {
    if (!this.inBounds(i, j, k)) return;
    const n = this.idx(i, j, k);
    const before = this.data[n];
    let v = before + delta;
    if (v > MAX_LO) v = MAX_LO;
    if (v < MIN_LO) v = MIN_LO;
    this.data[n] = v;
    if (cls(before) !== cls(v)) this.version++;
  }

  set(i: number, j: number, k: number, v: number): void {
    if (!this.inBounds(i, j, k)) return;
    const n = this.idx(i, j, k);
    const before = this.data[n];
    this.data[n] = v;
    if (cls(before) !== cls(v)) this.version++;
  }

  markObserved(x: number, z: number, radiusCells = 0): void {
    const ci = this.cellX(x), ck = this.cellZ(z);
    for (let dk = -radiusCells; dk <= radiusCells; dk++)
      for (let di = -radiusCells; di <= radiusCells; di++) {
        const i = ci + di, k = ck + dk;
        if (i >= 0 && k >= 0 && i < this.nx && k < this.nz) {
          if (!this.observed[k * this.nx + i]) {
            this.observed[k * this.nx + i] = 1;
            this.version++;
          }
        }
      }
  }
  isObserved(i: number, k: number): boolean {
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return false;
    return this.observed[k * this.nx + i] === 1;
  }

  /** Fill an axis-aligned box with a confidence value (max-combined). */
  fillBox(min: Vec3, max: Vec3, value: number): void {
    const i0 = Math.max(0, this.cellX(min.x)), i1 = Math.min(this.nx - 1, this.cellX(max.x - 1e-6));
    const j0 = Math.max(0, this.cellY(min.y)), j1 = Math.min(this.ny - 1, this.cellY(max.y - 1e-6));
    const k0 = Math.max(0, this.cellZ(min.z)), k1 = Math.min(this.nz - 1, this.cellZ(max.z - 1e-6));
    for (let j = j0; j <= j1; j++)
      for (let k = k0; k <= k1; k++)
        for (let i = i0; i <= i1; i++) {
          if (this.get(i, j, k) < value) this.set(i, j, k, value);
        }
  }

  /**
   * Integrate a depth observation: the ray from `from` to `to` is free space and
   * `to` itself is occupied (unless `hit` is false, e.g. max-range readings).
   */
  integrateRay(from: Vec3, to: Vec3, hit: boolean, hitDelta = 14, missDelta = -3): void {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const ti = this.cellX(to.x), tj = this.cellY(to.y), tk = this.cellZ(to.z);
    // Stop carving a little short of the endpoint so noisy surfaces don't self-erase.
    const carveLen = hit ? Math.max(0, len - this.res * 1.5) : len;
    this.traverse(from, { x: dx / len, y: dy / len, z: dz / len }, carveLen, (i, j, k) => {
      if (i === ti && j === tj && k === tk) return true;
      this.add(i, j, k, missDelta);
      return false;
    });
    if (hit) this.add(ti, tj, tk, hitDelta);
  }

  /**
   * Amanatides & Woo voxel traversal. Calls `visit` for each cell the ray passes
   * through (within maxDist); return true from visit to stop.
   */
  traverse(o: Vec3, d: Vec3, maxDist: number, visit: (i: number, j: number, k: number, t: number) => boolean): void {
    const r = this.res;
    let i = this.cellX(o.x), j = this.cellY(o.y), k = this.cellZ(o.z);
    const stepX = d.x > 0 ? 1 : d.x < 0 ? -1 : 0;
    const stepY = d.y > 0 ? 1 : d.y < 0 ? -1 : 0;
    const stepZ = d.z > 0 ? 1 : d.z < 0 ? -1 : 0;
    const nextB = (c: number, step: number, orig: number) => orig + (c + (step > 0 ? 1 : 0)) * r;
    let tMaxX = stepX ? (nextB(i, stepX, this.origin.x) - o.x) / d.x : Infinity;
    let tMaxY = stepY ? (nextB(j, stepY, this.origin.y) - o.y) / d.y : Infinity;
    let tMaxZ = stepZ ? (nextB(k, stepZ, this.origin.z) - o.z) / d.z : Infinity;
    const tDX = stepX ? r / Math.abs(d.x) : Infinity;
    const tDY = stepY ? r / Math.abs(d.y) : Infinity;
    const tDZ = stepZ ? r / Math.abs(d.z) : Infinity;
    let t = 0;
    // Bound iterations defensively.
    const maxIter = Math.ceil(maxDist / r) * 3 + 3;
    for (let n = 0; n < maxIter && t <= maxDist; n++) {
      if (this.inBounds(i, j, k)) {
        if (visit(i, j, k, t)) return;
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDX;
        i += stepX;
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        tMaxY += tDY;
        j += stepY;
      } else {
        t = tMaxZ;
        tMaxZ += tDZ;
        k += stepZ;
      }
    }
  }

  /** First occupied cell along a ray. */
  raycast(o: Vec3, d: Vec3, maxDist: number): RayHit | null {
    let hit: RayHit | null = null;
    this.traverse(o, d, maxDist, (i, j, k, t) => {
      if (this.data[this.idx(i, j, k)] > OCC_THRESHOLD) {
        hit = { t, i, j, k };
        return true;
      }
      return false;
    });
    return hit;
  }

  /**
   * Whether the straight segment a→b is free of occupied voxels, ignoring the
   * last `skipEnd` meters near b (so the target's own support doesn't block it).
   */
  segmentClear(a: Vec3, b: Vec3, skipEnd = 0): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    const hit = this.raycast(a, { x: dx / len, y: dy / len, z: dz / len }, len - skipEnd);
    return !hit || hit.t > len - skipEnd;
  }

  /**
   * Unknown space directly beneath an observed surface is assumed solid (we
   * saw the top of a box but never saw under it). Space below a mesh
   * underside, or anything carved free by depth rays, stays free. The mask is
   * cached per occupancy version.
   */
  shadow: Uint8Array | null = null;
  private shadowVersion = -1;
  updateShadow(): Uint8Array {
    if (this.shadow && this.shadowVersion === this.version) return this.shadow;
    const s = this.shadow ?? new Uint8Array(this.data.length);
    s.fill(0);
    for (let k = 0; k < this.nz; k++)
      for (let i = 0; i < this.nx; i++) {
        let shadowing = false;
        for (let j = this.ny - 1; j >= 0; j--) {
          const n = (j * this.nz + k) * this.nx + i;
          const v = this.data[n];
          if (v > OCC_THRESHOLD) {
            shadowing = this.underside[n] !== 1;
          } else if (v < 0) {
            shadowing = false;
          } else if (shadowing) {
            s[n] = 1;
          }
        }
      }
    this.shadow = s;
    this.shadowVersion = this.version;
    return s;
  }

  /** Occupied, or assumed solid (see updateShadow). */
  solid(i: number, j: number, k: number): boolean {
    if (!this.inBounds(i, j, k)) return false;
    const n = this.idx(i, j, k);
    return this.data[n] >= SOFT_SOLID || (this.shadow !== null && this.shadow[n] === 1);
  }

  countOccupied(): number {
    let n = 0;
    for (let q = 0; q < this.data.length; q++) if (this.data[q] > OCC_THRESHOLD) n++;
    return n;
  }
}

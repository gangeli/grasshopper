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
/** Occupancy confident enough that a ray passing through it is a contradiction. */
export const STRONG_OCC = 45;
const MAX_LO = 120;
const MIN_LO = -60;

const cls = (v: number) => (v > OCC_THRESHOLD ? 2 : v >= SOFT_SOLID ? 1 : 0);

export interface RayHit {
  t: number;
  i: number;
  j: number;
  k: number;
}

/** The grid's storage (see the VoxelGrid fields). */
export interface GridArrays {
  data: Int8Array;
  observed: Uint8Array;
  underside: Uint8Array;
  topFrac: Uint8Array;
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
  /**
   * Sub-voxel height of the observed surface inside each voxel, as a fraction
   * of the voxel (0..254; 255 = unknown, treated as the voxel top). Lets the
   * pet stand at the real height of a table instead of the voxel boundary.
   */
  readonly topFrac: Uint8Array;
  /**
   * Per voxel, two time codes (see `stamp`) packed as born << 16 | last:
   * `last` = the latest observation that added occupancy evidence there,
   * `born` = when it last became occupied (crossed OCC_THRESHOLD); 0 = never
   * (or before the session, e.g. an imported map). Lets drift checks match
   * what the camera sees now against structure that existed before (`born`),
   * lets stale structure erode (`last`), and lets a loop closure move what
   * was mapped during a drift (`last`). Null on grid copies that don't need it.
   */
  hitTime: Uint32Array | null = null;
  /** Time code written by hits (whole seconds since the session started, from 1). */
  stamp = 1;
  /**
   * Occupied voxels not re-observed for this many seconds (hitTime) lose
   * their resistance to erosion: a ray through one erodes it `staleMissGain`×
   * as fast as through free space. Doubled walls left by odometry drift, and
   * furniture that was moved, then clear as soon as they're looked through,
   * while structure the camera keeps seeing stays sticky. 0 = off.
   */
  staleAfter = 0;
  staleMissGain = 3;
  /** See integrateRay: occupied voxels resist erosion by passing rays. */
  stickyOccupied = true;
  /** Increments whenever occupancy changes meaningfully, so derived data can be cached. */
  version = 0;

  /** `arrays`: wrap existing storage instead of allocating (a grid copy handed to a worker). */
  constructor(o: VoxelGridOptions, arrays?: GridArrays) {
    this.origin = { ...o.origin };
    this.res = o.res;
    this.nx = o.nx;
    this.ny = o.ny;
    this.nz = o.nz;
    this.data = arrays?.data ?? new Int8Array(o.nx * o.ny * o.nz);
    this.observed = arrays?.observed ?? new Uint8Array(o.nx * o.nz);
    this.underside = arrays?.underside ?? new Uint8Array(o.nx * o.ny * o.nz);
    this.topFrac = arrays?.topFrac ?? new Uint8Array(o.nx * o.ny * o.nz).fill(255);
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
    if (delta > 0 && this.hitTime) this.stampHit(n, before, v);
    this.touch(n);
    if (cls(before) !== cls(v)) this.version++;
  }

  set(i: number, j: number, k: number, v: number): void {
    if (!this.inBounds(i, j, k)) return;
    const n = this.idx(i, j, k);
    const before = this.data[n];
    this.data[n] = v;
    if (v > before && this.hitTime) this.stampHit(n, before, v);
    this.touch(n);
    if (cls(before) !== cls(v)) this.version++;
  }

  private stampHit(n: number, before: number, v: number): void {
    const h = this.hitTime!;
    const born = before <= OCC_THRESHOLD && v > OCC_THRESHOLD ? this.stamp : h[n] >>> 16;
    h[n] = ((born << 16) | this.stamp) >>> 0;
  }

  // --- Shadow-mask bookkeeping ----------------------------------------------------------
  // The shadow mask (updateShadow) is a per-column function of data and
  // underside. Every write marks its column, so a recompute only redoes the
  // columns written since the last one (a depth frame touches a few
  // thousand of 57,600). Code writing data / underside directly must call
  // touchColumn() or touchAll().
  private dirtyFlag: Uint8Array | null = null;
  private dirtyList: Int32Array | null = null;
  private dirtyCount = 0;
  private allDirty = true;
  private touch(n: number): void {
    if (this.allDirty) return;
    const layer = this.nx * this.nz;
    const c = n % layer;
    if (this.dirtyFlag![c]) return;
    this.dirtyFlag![c] = 1;
    if (this.dirtyCount < this.dirtyList!.length) this.dirtyList![this.dirtyCount++] = c;
    else this.allDirty = true;
  }
  /** A direct write to data / underside in column (i, k). */
  touchColumn(i: number, k: number): void {
    if (i >= 0 && k >= 0 && i < this.nx && k < this.nz) this.touch(k * this.nx + i);
  }
  /** Bulk writes to data / underside: the next shadow update recomputes everything. */
  touchAll(): void {
    this.allDirty = true;
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
  integrateRay(from: Vec3, to: Vec3, hit: boolean, hitDelta = 14, missDelta = -3, carveShort = this.res * 1.5): number {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return 0;
    // Strongly occupied voxels this ray says are empty: evidence that the map
    // and the current view disagree (drift, relocalisation, things moved).
    let conflicts = 0;
    const ti = this.cellX(to.x), tj = this.cellY(to.y), tk = this.cellZ(to.z);
    // Stop carving short of the endpoint (by more for noisier readings) so a
    // reading that lands behind a surface doesn't carve into the object.
    const carveLen = Math.max(0, len - carveShort);
    // Asymmetric update: rays grazing past a confidently occupied voxel
    // erode it only slowly, so small real objects survive many near-misses.
    // Precise rays (missDelta ≤ -3: close, sharp readings) erode a little faster, so stale obstacles
    // left by a tracking jump don't linger; noisy ones barely touch confident voxels.
    const occMiss = this.stickyOccupied ? Math.max(missDelta, missDelta <= -3 ? -2 : -1) : missDelta;
    // The voxel walk of traverse(), inlined (this is the mapper's hot loop:
    // no closure or direction object per ray; same arithmetic, same order).
    const dX = dx / len, dY = dy / len, dZ = dz / len;
    const r = this.res, o = this.origin;
    const nx = this.nx, ny = this.ny, nz = this.nz, data = this.data;
    const hits = this.staleAfter > 0 ? this.hitTime : null;
    const staleStamp = this.stamp - this.staleAfter, staleMiss = Math.min(-1, missDelta) * this.staleMissGain;
    let i = this.cellX(from.x), j = this.cellY(from.y), k = this.cellZ(from.z);
    const stepX = dX > 0 ? 1 : dX < 0 ? -1 : 0;
    const stepY = dY > 0 ? 1 : dY < 0 ? -1 : 0;
    const stepZ = dZ > 0 ? 1 : dZ < 0 ? -1 : 0;
    let tMaxX = stepX ? (o.x + (i + (stepX > 0 ? 1 : 0)) * r - from.x) / dX : Infinity;
    let tMaxY = stepY ? (o.y + (j + (stepY > 0 ? 1 : 0)) * r - from.y) / dY : Infinity;
    let tMaxZ = stepZ ? (o.z + (k + (stepZ > 0 ? 1 : 0)) * r - from.z) / dZ : Infinity;
    const tDX = stepX ? r / Math.abs(dX) : Infinity;
    const tDY = stepY ? r / Math.abs(dY) : Infinity;
    const tDZ = stepZ ? r / Math.abs(dZ) : Infinity;
    let t = 0;
    const maxIter = Math.ceil(carveLen / r) * 3 + 3;
    for (let n = 0; n < maxIter && t <= carveLen; n++) {
      if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) {
        if (i === ti && j === tj && k === tk) break;
        const q = (j * nz + k) * nx + i;
        const v = data[q];
        if (v > STRONG_OCC) conflicts++;
        let nv = v + (v > OCC_THRESHOLD ? (hits !== null && (hits[q] & 0xffff) < staleStamp && v !== 127 ? staleMiss : occMiss) : missDelta);
        if (nv > MAX_LO) nv = MAX_LO;
        if (nv < MIN_LO) nv = MIN_LO;
        data[q] = nv;
        this.touch(q);
        if (cls(v) !== cls(nv)) this.version++;
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
    if (hit) {
      this.add(ti, tj, tk, hitDelta);
      this.noteHeight(ti, tj, tk, to.y);
    }
    return conflicts;
  }

  /**
   * Shrink all evidence towards "unknown" (keeps its sign): after the map and
   * reality have drifted apart, fresh observations then win quickly instead of
   * fighting with stale, confident ones. The solid below-floor layers stay.
   */
  ageEvidence(factor: number, fromLayer: number, region?: { i0: number; i1: number; k0: number; k1: number }): void {
    // Keep every voxel's class (an obstacle stays an obstacle, free stays
    // free) and only shrink the margin, so fresh observations flip it
    // quickly. Scaling raw log-odds would push confident obstacles under the
    // occupancy threshold: they'd vanish, and the pet could be "seen" through
    // (or walk through) furniture that's really there.
    const layer = this.nx * this.nz;
    const i0 = Math.max(0, region?.i0 ?? 0), i1 = Math.min(this.nx - 1, region?.i1 ?? this.nx - 1);
    const k0 = Math.max(0, region?.k0 ?? 0), k1 = Math.min(this.nz - 1, region?.k1 ?? this.nz - 1);
    for (let j = fromLayer; j < this.ny; j++)
      for (let k = k0; k <= k1; k++)
        for (let n = j * layer + k * this.nx + i0, e = j * layer + k * this.nx + i1; n <= e; n++) {
          const v = this.data[n];
          if (v > OCC_THRESHOLD) this.data[n] = OCC_THRESHOLD + 1 + Math.round((v - OCC_THRESHOLD - 1) * factor);
          else if (v < 0) this.data[n] = Math.min(-1, Math.round(v * factor));
        }
    this.touchAll();
    this.transient.clear();
    this.version++;
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
  raycast(o: Vec3, d: Vec3, maxDist: number, includeShadow = false): RayHit | null {
    let hit: RayHit | null = null;
    const sh = includeShadow ? this.updateShadow() : null;
    this.traverse(o, d, maxDist, (i, j, k, t) => {
      const n = this.idx(i, j, k);
      if (this.data[n] > OCC_THRESHOLD && this.passesAboveSurface(n, i, j, k, o, d, t)) return false;
      if (this.data[n] > OCC_THRESHOLD || (sh !== null && sh[n] === 1)) {
        hit = { t, i, j, k };
        return true;
      }
      return false;
    });
    return hit;
  }

  /**
   * A ray crossing the top voxel of a horizontal surface (table top, seat)
   * above the surface's measured height isn't really blocked: the voxel is 5cm
   * tall but the surface inside it may be lower. Uses the sub-voxel height.
   */
  private passesAboveSurface(n: number, i: number, j: number, k: number, o: Vec3, d: Vec3, t: number): boolean {
    const f = this.topFrac[n];
    if (f === 255) return false;
    if (this.inBounds(i, j + 1, k) && this.data[this.idx(i, j + 1, k)] > OCC_THRESHOLD) return false; // not a top surface
    const top = this.origin.y + (j + f / 254) * this.res;
    // Ray height on entry and after the longest possible chord through the voxel.
    const y0 = o.y + d.y * t, y1 = o.y + d.y * (t + this.res * 1.733);
    return Math.min(y0, y1) > top + 0.005;
  }

  /**
   * Whether the straight segment a→b is free of occupied voxels, ignoring the
   * last `skipEnd` meters near b (so the target's own support doesn't block it).
   */
  segmentClear(a: Vec3, b: Vec3, skipEnd = 0, includeShadow = false): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    const hit = this.raycast(a, { x: dx / len, y: dy / len, z: dz / len }, len - skipEnd, includeShadow);
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
    const layer = this.nx * this.nz;
    if (!this.dirtyFlag) {
      this.dirtyFlag = new Uint8Array(layer);
      this.dirtyList = new Int32Array(Math.max(1024, layer >> 3));
    }
    const s = this.shadow ?? new Uint8Array(this.data.length);
    const data = this.data, under = this.underside;
    if (this.allDirty || !this.shadow || this.shadowBuiltFor !== s) {
      // Walk all columns at once, layer by layer from the top: the same
      // per-column scan, but in memory order (a column walk strides a whole
      // layer per step and thrashes the cache on a phone).
      const shadowing = (this._shadowCols ??= new Uint8Array(layer));
      shadowing.fill(0);
      for (let j = this.ny - 1; j >= 0; j--) {
        const base = j * layer;
        for (let c = 0; c < layer; c++) {
          const n = base + c;
          const v = data[n];
          if (v > OCC_THRESHOLD) {
            shadowing[c] = under[n] !== 1 ? 1 : 0;
            s[n] = 0;
          } else if (v < 0) {
            shadowing[c] = 0;
            s[n] = 0;
          } else s[n] = shadowing[c];
        }
      }
    } else {
      // Only the columns written since the last update.
      for (let q = 0; q < this.dirtyCount; q++) {
        const c = this.dirtyList![q];
        let shadowing = 0;
        for (let n = (this.ny - 1) * layer + c; n >= 0; n -= layer) {
          const v = data[n];
          if (v > OCC_THRESHOLD) {
            shadowing = under[n] !== 1 ? 1 : 0;
            s[n] = 0;
          } else if (v < 0) {
            shadowing = 0;
            s[n] = 0;
          } else s[n] = shadowing;
        }
      }
    }
    for (let q = 0; q < this.dirtyCount; q++) this.dirtyFlag[this.dirtyList![q]] = 0;
    this.dirtyCount = 0;
    this.allDirty = false;
    this.shadow = s;
    this.shadowBuiltFor = s;
    this.shadowVersion = this.version;
    return s;
  }
  /** The mask buffer the dirty tracking is relative to (adoptShadow may swap in another). */
  private shadowBuiltFor: Uint8Array | null = null;
  private _shadowCols: Uint8Array | null = null;

  /**
   * Install a shadow mask computed elsewhere (a background nav build on a
   * copy of this grid at `version`); it is recomputed when the grid has
   * changed since. Pass version -1 to force a recompute into `mask`.
   */
  adoptShadow(mask: Uint8Array, version: number): void {
    if (mask.length !== this.data.length) return;
    this.shadow = mask;
    this.shadowVersion = version;
    // Built from a snapshot elsewhere: the next local update recomputes all of it.
    this.allDirty = true;
  }

  /** Same rule as updateShadow, for one voxel (walks its column from the top; no full-grid pass). */
  shadowAt(i: number, j: number, k: number): boolean {
    if (!this.inBounds(i, j, k)) return false;
    let shadowing = false;
    for (let jj = this.ny - 1; jj > j; jj--) {
      const n = (jj * this.nz + k) * this.nx + i;
      const v = this.data[n];
      if (v > OCC_THRESHOLD) shadowing = this.underside[n] !== 1;
      else if (v < 0) shadowing = false;
    }
    const v = this.data[this.idx(i, j, k)];
    return shadowing && v >= 0 && v <= OCC_THRESHOLD;
  }

  /** Occupied, or assumed solid (see updateShadow). */
  solid(i: number, j: number, k: number): boolean {
    if (!this.inBounds(i, j, k)) return false;
    const n = this.idx(i, j, k);
    return this.data[n] >= SOFT_SOLID || (this.shadow !== null && this.shadow[n] === 1) || this.isTransient(n);
  }

  // --- Dynamic obstacle layer --------------------------------------------------------------
  // Space the map is confident is empty can't be flipped quickly by normal
  // evidence. When new readings say "something is here" inside such space
  // (a box put down, someone's feet), the cells become temporary obstacles
  // straight away; they expire unless re-observed.
  /** Current time (s), set by the world model as frames arrive. */
  now = 0;
  private transient = new Map<number, number>();
  private surprise = new Map<number, { n: number; t: number }>();

  /**
   * A reading landed in voxel (i,j,k) although the map believes it empty.
   * `dir` is the viewing ray direction; `floorJ` the first layer above the floor.
   */
  noteSurprise(i: number, j: number, k: number, dir: { x: number; z: number }, floorJ: number, holdSeconds = 3): void {
    if (!this.inBounds(i, j, k)) return;
    const n = this.idx(i, j, k);
    const s = this.surprise.get(n);
    // Two surprises within half a second: not a lone noisy pixel.
    if (!(s && this.now - s.t < 0.5)) {
      this.surprise.set(n, { n: 1, t: this.now });
      return;
    }
    this.surprise.delete(n);
    // What we saw is the front of something standing on the floor: mark the
    // column down to the floor, and ~20cm behind the seen face, as obstacle.
    const until = this.now + holdSeconds;
    const L = Math.hypot(dir.x, dir.z) || 1;
    for (let back = 0; back <= 0.2 + 1e-6; back += this.res) {
      const ii = this.cellX(this.centerX(i) + (dir.x / L) * back), kk = this.cellZ(this.centerZ(k) + (dir.z / L) * back);
      for (let jj = floorJ; jj <= j; jj++) {
        if (!this.inBounds(ii, jj, kk)) continue;
        const m = this.idx(ii, jj, kk);
        if (!this.transient.has(m)) this.version++;
        this.transient.set(m, until);
      }
    }
  }

  isTransient(n: number): boolean {
    const until = this.transient.get(n);
    if (until === undefined) return false;
    if (until < this.now) {
      this.transient.delete(n);
      this.version++;
      return false;
    }
    return true;
  }

  /** Occupied, or a fresh dynamic obstacle. */
  blocked(i: number, j: number, k: number): boolean {
    if (!this.inBounds(i, j, k)) return false;
    const n = this.idx(i, j, k);
    return this.data[n] > OCC_THRESHOLD || this.isTransient(n);
  }

  /** Drop expired bookkeeping (call occasionally). */
  pruneTransient(): void {
    for (const [n, until] of this.transient) if (until < this.now) (this.transient.delete(n), this.version++);
    for (const [n, s] of this.surprise) if (this.now - s.t > 1) this.surprise.delete(n);
  }

  /** Replace the dynamic-obstacle cells (a grid copy in a worker). */
  loadTransient(entries: ArrayLike<number>): void {
    this.transient.clear();
    for (let q = 0; q + 1 < entries.length; q += 2) this.transient.set(entries[q], entries[q + 1]);
  }

  /** Dynamic-obstacle cells and their expiry times (read only; see isTransient). */
  transientEntries(): IterableIterator<[number, number]> {
    return this.transient.entries();
  }

  get transientCount(): number {
    return this.transient.size;
  }

  /** Running estimate of where inside voxel (i,j,k) the surface is (height y). */
  noteHeight(i: number, j: number, k: number, y: number): void {
    if (!this.inBounds(i, j, k)) return;
    const n = this.idx(i, j, k);
    const f = Math.max(0, Math.min(254, Math.round(((y - (this.origin.y + j * this.res)) / this.res) * 254)));
    const old = this.topFrac[n];
    this.topFrac[n] = old === 255 ? f : Math.round(old * 0.8 + f * 0.2);
  }

  /** Height of the surface on top of voxel (i,j,k). */
  surfaceY(i: number, j: number, k: number): number {
    const f = this.inBounds(i, j, k) ? this.topFrac[this.idx(i, j, k)] : 255;
    return this.origin.y + (j + (f === 255 ? 1 : f / 254)) * this.res;
  }

  countOccupied(): number {
    let n = 0;
    for (let q = 0; q < this.data.length; q++) if (this.data[q] > OCC_THRESHOLD) n++;
    return n;
  }
}

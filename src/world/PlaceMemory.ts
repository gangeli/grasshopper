import type { Vec3 } from '../core/math';
import type { Correction } from './warp';

/**
 * Place memory for loop closure: what the camera saw, kept as small
 * point-cell "submaps", each from a few seconds of depth frames (one
 * generation of the map, consistent with itself).
 *
 * Why not match against the voxel map: after a long walk the map holds
 * several copies of the same wall, each laid down by a frame that had
 * drifted differently; a search against all of them finds a wrong compromise
 * or the wrong copy (consistent, well supported, and wrong). A submap is one
 * look at the place from one moment: matching the current frames against
 * the submaps of *one earlier visit* gives a clean correction to that visit.
 *
 * Frames are taken from the replay buffer once they are settled (old enough
 * that holds, realignments and warps have corrected them), so a submap is in
 * the map frame as best known; later corrections (warps after loop
 * closures) move submaps along with the voxels they describe.
 *
 * Memory: a submap keeps the centroid (1cm) of each 5cm cell hit in at least
 * two of its frames, as int16 triplets: ~1-3k cells, ~10 KB per 3 s.
 */
export interface Submap {
  /** Time range of the frames (s). */
  t0: number;
  t1: number;
  /** Mean camera position (map frame), and the view headings of its frames (atan2 of the mean x/z direction to the readings; distinct ones). */
  ex: number;
  ez: number;
  headings: number[];
  /** Cell centroids, cm, xyz triplets (map frame). */
  cells: Int16Array;
  /** Bounding box of the cells (m). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PlaceMatch {
  dx: number;
  dz: number;
  dyaw: number;
  pivot: Vec3;
  /** Support without / with the correction (soft counts), readings that could match. */
  base: number;
  best: number;
  n: number;
  degenerate: boolean;
  /** Time range of the visit matched (s). */
  visitT0: number;
  visitT1: number;
  /** Support of the strongest clearly different correction (≥25cm at 1m away): ambiguity. */
  second: number;
  /** That correction (diagnostics). */
  secondAt: { dx: number; dz: number; dyaw: number } | null;
  /** How well the fit is constrained in its weakest direction (see minConstraint; NaN: no ICP fit). */
  constraint: number;
  /** Exact hits of the best fit / of the strongest clearly different one (∞-ish when there is none). */
  unique: number;
}

type Frame = { eye: Vec3; pts: Float32Array; sig: Float32Array | null; t: number };

const CELL = 0.05;

export class PlaceMemory {
  readonly submaps: Submap[] = [];
  /** Frames are settled into submaps once this old (s). */
  settleAge = 10;
  /** A submap covers at most this long (s) and this much camera travel (m). */
  spanSeconds = 3;
  spanMeters = 1.5;
  /** Readings used: precise, within this range, above the floor band. */
  maxRange = 3;
  /** Total memory cap (bytes): oldest *redundant* submaps are thinned past it. */
  budgetBytes = 24e6;
  private lastSettled = -Infinity;
  private building: { t0: number; t1: number; frames: number; ex: number; ez: number; ne: number; cells: Map<number, number[]>; x0: number; z0: number; hs: number[] } | null = null;

  /** Bytes held. */
  bytes(): number {
    let n = 0;
    for (const s of this.submaps) n += s.cells.byteLength + 96;
    return n;
  }

  clear(): void {
    this.submaps.length = 0;
    this.building = null;
  }

  /**
   * Take over another memory's submaps (newer than these), moved by a
   * correction into this memory's frame (after a relocalisation).
   */
  absorb(other: PlaceMemory, c: Correction): void {
    other.close();
    const cs = Math.cos(c.dyaw), sn = Math.sin(c.dyaw);
    for (const s of other.submaps) {
      this.transform(s, cs, sn, c.dx, c.dz, c.pivot);
      this.submaps.push(s);
    }
    this.submaps.sort((a, b) => a.t0 - b.t0);
    this.building = null;
    this.lastSettled = Math.max(this.lastSettled, other.lastSettled);
    this.enforceBudget();
  }

  /**
   * Take settled frames (older than settleAge, newer than the last one taken)
   * from the replay buffer. `occupied(x, y, z)` says whether the map still
   * believes a point is solid (filters people that walked by and noise).
   */
  settle(replay: readonly Frame[], now: number, floorY: number, occupied: (x: number, y: number, z: number) => boolean | null, skipFrom = Infinity, age = this.settleAge): void {
    const until = Math.min(now - age, skipFrom);
    if (!(until > this.lastSettled)) return;
    // Frames in time order; find the first unsettled one from the end (few per call).
    let q = replay.length - 1;
    while (q >= 0 && replay[q].t > this.lastSettled) q--;
    for (q++; q < replay.length; q++) {
      const f = replay[q];
      if (f.t > until) break;
      this.lastSettled = f.t;
      this.add(f, floorY, occupied);
    }
  }

  private add(f: Frame, floorY: number, occupied: (x: number, y: number, z: number) => boolean | null): void {
    let b = this.building;
    const h = frameHeading(f, floorY);
    if (b && (f.t - b.t0 > this.spanSeconds || Math.hypot(f.eye.x - b.x0, f.eye.z - b.z0) > this.spanMeters || f.t < b.t1)) {
      this.close();
      b = null;
    }
    if (!b) b = this.building = { t0: f.t, t1: f.t, frames: 0, ex: 0, ez: 0, ne: 0, cells: new Map(), x0: f.eye.x, z0: f.eye.z, hs: [] };
    if (h !== null && !b.hs.some((x) => angDiff(x, h) < 0.25)) b.hs.push(h);
    b.t1 = f.t;
    b.frames++;
    b.ex += f.eye.x;
    b.ez += f.eye.z;
    b.ne++;
    const P = f.pts, S = f.sig, e = f.eye, R2 = this.maxRange * this.maxRange;
    // Each cell counts once per frame (frame tag in slot 4).
    const tag = b.frames;
    for (let q = 0; q < P.length; q += 3) {
      const x = P[q], y = P[q + 1], z = P[q + 2];
      if (y < floorY + 0.06 || y > floorY + 2.2) continue;
      if (S && S[q / 3] > 0.08) continue;
      const dx = x - e.x, dy = y - e.y, dz = z - e.z;
      if (dx * dx + dy * dy + dz * dz > R2) continue;
      const i = Math.floor(x / CELL), j = Math.floor((y + 0.5) / CELL), k = Math.floor(z / CELL);
      if (i < -2000 || i > 2000 || k < -2000 || k > 2000 || j < 0 || j > 63) continue;
      const key = ((i + 2048) * 4096 + (k + 2048)) * 64 + j;
      let c = b.cells.get(key);
      if (!c) b.cells.set(key, (c = [0, 0, 0, 0, 0, 0]));
      c[0] += x;
      c[1] += y;
      c[2] += z;
      c[3]++;
      if (c[4] !== tag) {
        c[4] = tag;
        c[5]++;
      }
    }
    this.occupied = occupied;
  }
  private occupied: ((x: number, y: number, z: number) => boolean | null) | null = null;

  /** Finish the submap being built. */
  close(): void {
    const b = this.building;
    this.building = null;
    if (!b || b.frames < 2) return;
    const out: number[] = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of b.cells.values()) {
      if (c[5] < 2) continue;
      const x = c[0] / c[3], y = c[1] / c[3], z = c[2] / c[3];
      // Not since seen through (a person who walked by, a stray reading)? (Outside the window: kept.)
      if (this.occupied && this.occupied(x, y, z) === false) continue;
      out.push(Math.round(x * 100), Math.round(y * 100), Math.round(z * 100));
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (out.length < 3 * 40) return;
    this.submaps.push({ t0: b.t0, t1: b.t1, ex: b.ex / b.ne, ez: b.ez / b.ne, headings: b.hs, cells: Int16Array.from(out), minX, maxX, minZ, maxZ });
    this.enforceBudget();
  }

  /**
   * Over budget: drop submaps whose place is covered by an older one
   * (another submap of an earlier visit with its camera within 0.75m),
   * newest-redundant first; failing that, the oldest.
   */
  private enforceBudget(): void {
    while (this.bytes() > this.budgetBytes && this.submaps.length > 1) {
      let drop = -1;
      for (let a = this.submaps.length - 2; a >= 1 && drop < 0; a--) {
        const s = this.submaps[a];
        for (let b = 0; b < a; b++) {
          const o = this.submaps[b];
          if (s.t0 - o.t1 > 30 && Math.hypot(s.ex - o.ex, s.ez - o.ez) < 0.75) {
            drop = a;
            break;
          }
        }
      }
      this.submaps.splice(drop >= 0 ? drop : 0, 1);
    }
  }

  /** Move submaps whose frames fall in [t0, t1] by their share of a correction (see WorldModel.warpSince). */
  warp(t0: number, t1: number, corrAt: (t: number) => [number, number, number, number], pivot: { x: number; z: number }): void {
    for (const s of this.submaps) {
      const tm = (s.t0 + s.t1) / 2;
      if (tm < t0 || tm > t1) continue;
      const [cs, sn, tx, tz] = corrAt(tm);
      this.transform(s, cs, sn, tx, tz, pivot);
    }
  }

  /** Correct submaps built from frames at/after `since` (WorldModel.realign corrected those frames). */
  realign(c: Correction, since: number): void {
    const cs = Math.cos(c.dyaw), sn = Math.sin(c.dyaw);
    for (const s of this.submaps) if (s.t0 >= since) this.transform(s, cs, sn, c.dx, c.dz, c.pivot);
    // The submap being built has frames from before the correction (as they
    // were) and may get corrected ones next: drop it. (Frames not settled
    // yet are corrected in the replay buffer and settle as they are.)
    if (this.building && this.building.t1 >= since) this.building = null;
  }

  private transform(s: Submap, cs: number, sn: number, tx: number, tz: number, pivot: { x: number; z: number }): void {
    const C = s.cells;
    const px = pivot.x, pz = pivot.z;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let q = 0; q < C.length; q += 3) {
      const x = C[q] / 100 - px, z = C[q + 2] / 100 - pz;
      const X = px + cs * x + sn * z + tx, Z = pz - sn * x + cs * z + tz;
      C[q] = Math.round(X * 100);
      C[q + 2] = Math.round(Z * 100);
      if (X < minX) minX = X;
      if (X > maxX) maxX = X;
      if (Z < minZ) minZ = Z;
      if (Z > maxZ) maxZ = Z;
    }
    const ex = s.ex - px, ez = s.ez - pz;
    // (x' = c x + s z, z' = -s x + c z turns headings by -atan2(s, c).)
    const da = Math.atan2(sn, cs);
    for (let q = 0; q < s.headings.length; q++) s.headings[q] -= da;
    s.ex = px + cs * ex + sn * ez + tx;
    s.ez = pz - sn * ex + cs * ez + tz;
    Object.assign(s, { minX, maxX, minZ, maxZ });
  }

  // --- Matching ----------------------------------------------------------------------

  private lut: Int8Array | null = null;
  /** A fit is degenerate below this constraint (smallest eigenvalue of the ICP normal equations per pair). */
  minConstraint = 0.008;
  /** Why the last alignment found nothing (diagnostics). */
  why = '';
  /** Debug hook: the scoring function of each alignment (tests, diagnostics). */
  debug: ((score: (dx: number, dz: number, yaw: number) => number, visit: { t0: number; t1: number }, pivot: Vec3) => void) | null = null;

  /**
   * Visits (runs of submaps close in time) older than `before` whose
   * structure overlaps the box, oldest first, with the number of cells inside.
   */
  visitsNear(box: { minX: number; maxX: number; minZ: number; maxZ: number }, before: number, view?: { x: number; z: number; headings: number[]; maxDist: number; maxTurn: number }, gap = 8): { t0: number; t1: number; subs: Submap[]; cells: number }[] {
    const out: { t0: number; t1: number; subs: Submap[]; cells: number }[] = [];
    let cur: { t0: number; t1: number; subs: Submap[]; cells: number } | null = null;
    for (const s of this.submaps) {
      if (s.t1 > before) break;
      // Seen from about here, looking about the same way (what it saw is what we see).
      if (view && (Math.hypot(s.ex - view.x, s.ez - view.z) > view.maxDist || !view.headings.some((h) => s.headings.some((x) => angDiff(h, x) <= view.maxTurn)))) continue;
      if (s.maxX < box.minX || s.minX > box.maxX || s.maxZ < box.minZ || s.minZ > box.maxZ) continue;
      let inside = 0;
      const C = s.cells;
      for (let q = 0; q < C.length; q += 3) {
        const x = C[q] / 100, z = C[q + 2] / 100;
        if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) inside++;
      }
      if (inside < 20) continue;
      if (cur && s.t0 - cur.t1 <= gap) {
        cur.t1 = s.t1;
        cur.subs.push(s);
        cur.cells += inside;
      } else {
        cur = { t0: s.t0, t1: s.t1, subs: [s], cells: inside };
        out.push(cur);
      }
    }
    return out;
  }

  /**
   * Align readings (map frame, xyz triplets) to one visit: the rigid x/z
   * shift + yaw about `pivot` (within maxShift / maxYaw) that puts the most
   * readings on the visit's cells. Resumable (yields between search rows).
   */
  *align(pts: Float32Array | number[], pivot: Vec3, visit: { t0: number; t1: number; subs: Submap[] }, maxShift: number, maxYaw: number): Generator<void, PlaceMatch | null, void> {
    return yield* this.alignBest(pts, pivot, [visit], maxShift, maxYaw);
  }

  /**
   * Align readings (map frame, xyz triplets) to earlier visits: for each
   * visit, the rigid x/z shift + yaw about `pivot` (within maxShift /
   * maxYaw) that puts the most readings on its cells (coarse 10cm / 0.05 rad
   * lattice, then refined); the visit whose best fit explains the most
   * readings wins. `n` is the number of readings scored, so best / n is the
   * share of the current view that visit explains. Resumable (yields
   * between search rows).
   */
  *alignBest(pts: Float32Array | number[], pivot: Vec3, visits: { t0: number; t1: number; subs: Submap[] }[], maxShift: number, maxYaw: number, penalty = 0.02): Generator<void, PlaceMatch | null, void> {
    const np = pts.length / 3;
    this.why = '';
    if (np < 60 || !visits.length) return (this.why = 'few readings'), null;
    // Local lookup grid over the readings' box plus the search reach.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, rmax = 0;
    for (let q = 0; q < pts.length; q += 3) {
      const x = pts[q], z = pts[q + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      rmax = Math.max(rmax, Math.hypot(x - pivot.x, z - pivot.z));
    }
    const reach = maxShift + maxYaw * rmax + 0.15;
    const ox = Math.floor((minX - reach) / CELL) * CELL, oz = Math.floor((minZ - reach) / CELL) * CELL, oy = -0.5;
    const nx = Math.ceil((maxX + reach - ox) / CELL) + 1, nz = Math.ceil((maxZ + reach - oz) / CELL) + 1, ny = 56;
    const len = nx * nz * ny;
    if (len > 6e6) return (this.why = `area too large (${nx}x${nz})`), null;
    if (!this.lut || this.lut.length < len) this.lut = new Int8Array(Math.max(len, 1 << 20));
    const L = this.lut;
    // Readings relative to the pivot, with their layer.
    const stride = Math.max(1, Math.floor(np / 800));
    const m = Math.ceil(np / stride);
    const RX = new Float64Array(m), RZ = new Float64Array(m), JL = new Int32Array(m), PY = new Float64Array(m);
    for (let q = 0, u = 0; u < m; q += 3 * stride, u++) {
      RX[u] = pts[q] - pivot.x;
      RZ[u] = pts[q + 2] - pivot.z;
      PY[u] = pts[q + 1];
      const j = Math.floor((pts[q + 1] - oy) / CELL);
      JL[u] = j >= 0 && j < ny ? j * nz * nx : -1;
    }
    const px = pivot.x, pz = pivot.z, inv = 1 / CELL;
    const X0 = new Float64Array(m), Z0 = new Float64Array(m), XI = new Int32Array(m);
    let cYaw = NaN, cDx = NaN;
    const score = (dx: number, dz: number, yaw: number, near = 0.5): number => {
      if (yaw !== cYaw) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        for (let u = 0; u < m; u++) {
          X0[u] = px + c * RX[u] + s * RZ[u];
          Z0[u] = pz - s * RX[u] + c * RZ[u];
        }
        cYaw = yaw;
        cDx = NaN;
      }
      if (dx !== cDx) {
        for (let u = 0; u < m; u++) {
          const i = Math.floor((X0[u] + dx - ox) * inv);
          XI[u] = JL[u] < 0 || i < 0 || i >= nx ? -1 : JL[u] + i;
        }
        cDx = dx;
      }
      let sc = 0;
      for (let u = 0; u < m; u++) {
        const ji = XI[u];
        if (ji < 0) continue;
        const k = Math.floor((Z0[u] + dz - oz) * inv);
        if (k < 0 || k >= nz) continue;
        const c = L[ji + k * nx];
        if (c === 1) sc += 1;
        else if (c === 2) sc += near;
      }
      return sc;
    };
    const at = (i: number, j: number, k: number) => (j * nz + k) * nx + i;
    // Prefer small corrections among near-ties: `penalty` × readings per 10cm (yaw at 1m).
    const pen = (dx: number, dz: number, yaw: number) => (penalty * m * (Math.hypot(dx, dz) + Math.abs(yaw))) / 0.1;
    let result: PlaceMatch | null = null;
    for (const visit of visits) {
      // Cells: 1 = on the visit's structure; 2 = next to it (x, y or z).
      // (And where each structure cell's points are, for the ICP refinement.)
      L.fill(0, 0, len);
      const cellAt = new Map<number, number>();
      const CX: number[] = [], CY: number[] = [], CZ: number[] = [];
      let filled = 0;
      for (const s of visit.subs) {
        const C = s.cells;
        if ((filled += C.length) > 6000) (filled = 0), yield;
        for (let q = 0; q < C.length; q += 3) {
          const i = Math.floor((C[q] / 100 - ox) / CELL), j = Math.floor((C[q + 1] / 100 - oy) / CELL), k = Math.floor((C[q + 2] / 100 - oz) / CELL);
          if (i < 1 || k < 1 || i >= nx - 1 || k >= nz - 1 || j < 0 || j >= ny) continue;
          const n0 = at(i, j, k);
          if (!cellAt.has(n0)) {
            cellAt.set(n0, CX.length);
            CX.push(C[q] / 100);
            CY.push(C[q + 1] / 100);
            CZ.push(C[q + 2] / 100);
          }
          L[n0] = 1;
          if (L[n0 - 1] === 0) L[n0 - 1] = 2;
          if (L[n0 + 1] === 0) L[n0 + 1] = 2;
          if (L[n0 - nx] === 0) L[n0 - nx] = 2;
          if (L[n0 + nx] === 0) L[n0 + nx] = 2;
          if (j > 0 && L[n0 - nx * nz] === 0) L[n0 - nx * nz] = 2;
          if (j < ny - 1 && L[n0 + nx * nz] === 0) L[n0 + nx * nz] = 2;
        }
      }
      yield;
      cYaw = NaN;
      if (this.debug) this.debug(score, visit, pivot);
      // Coarse lattice (kept whole for peak finding).
      const SY = 0.05, SS = 0.1;
      const NY = Math.round((2 * maxYaw) / SY) + 1, NS = Math.round((2 * maxShift) / SS) + 1;
      const y0 = -((NY - 1) / 2) * SY, s0 = -((NS - 1) / 2) * SS;
      const grid = new Float32Array(NY * NS * NS);
      for (let a = 0; a < NY; a++)
        for (let b = 0; b < NS; b++) {
          for (let c = 0; c < NS; c++) grid[(a * NS + b) * NS + c] = score(s0 + b * SS, s0 + c * SS, y0 + a * SY);
          yield;
        }
      // Local maxima (each beats its 26 neighbours), by penalised support.
      type P = { dx: number; dz: number; dyaw: number; s: number; v: number; weak?: number };
      const peaks: P[] = [];
      for (let a = 0; a < NY; a++)
        for (let b = 0; b < NS; b++)
          for (let c = 0; c < NS; c++) {
            const v0 = grid[(a * NS + b) * NS + c];
            if (v0 < 0.1 * m) continue;
            let isMax = true;
            for (let da = -1; da <= 1 && isMax; da++)
              for (let db = -1; db <= 1 && isMax; db++)
                for (let dc = -1; dc <= 1; dc++) {
                  if (!da && !db && !dc) continue;
                  const A = a + da, B = b + db, Cc = c + dc;
                  if (A < 0 || B < 0 || Cc < 0 || A >= NY || B >= NS || Cc >= NS) continue;
                  if (grid[(A * NS + B) * NS + Cc] > v0) {
                    isMax = false;
                    break;
                  }
                }
            if (!isMax) continue;
            const dx = s0 + b * SS, dz = s0 + c * SS, dyaw = y0 + a * SY;
            peaks.push({ dx, dz, dyaw, s: v0, v: v0 - pen(dx, dz, dyaw) });
          }
      if (!peaks.length) {
        this.why = `no peak (max ${Math.max(...grid).toFixed(0)} of ${m})`;
        continue;
      }
      peaks.sort((a, b) => b.v - a.v);
      // Surface normals (x/z) of structure cells, from their neighbours,
      // computed when first needed: 0 = not yet, 1 = a wall-like surface
      // (normal known), 2 = no clear x/z direction (a top, a corner, noise).
      const NS2 = new Float32Array(CX.length * 2), NK = new Uint8Array(CX.length);
      const normalOf = (ci: number): boolean => {
        if (NK[ci]) return NK[ci] === 1;
        const i0 = Math.floor((CX[ci] - ox) * inv), j0 = Math.floor((CY[ci] - oy) * inv), k0 = Math.floor((CZ[ci] - oz) * inv);
        let n = 0, mx = 0, mz = 0, sxx = 0, sxz = 0, szz = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let dk = -2; dk <= 2; dk++)
            for (let di = -2; di <= 2; di++) {
              const i = i0 + di, j = j0 + dj, k = k0 + dk;
              if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
              const n0 = at(i, j, k);
              if (L[n0] !== 1) continue;
              const cj = cellAt.get(n0)!;
              const x = CX[cj], z = CZ[cj];
              n++;
              mx += x;
              mz += z;
              sxx += x * x;
              sxz += x * z;
              szz += z * z;
            }
        let ok = false;
        if (n >= 5) {
          mx /= n;
          mz /= n;
          const a = sxx / n - mx * mx, b = sxz / n - mx * mz, c = szz / n - mz * mz;
          // Eigen-decomposition of [[a, b], [b, c]]: the normal is the minor axis.
          const tr = a + c, det = a * c - b * b, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
          const lmax = tr / 2 + disc, lmin = tr / 2 - disc;
          if (lmax > 1e-5 && lmin < 0.15 * lmax) {
            // Minor-axis eigenvector: (b, lmin - a) or (lmin - c, b).
            let ex = b, ez = lmin - a;
            if (Math.hypot(ex, ez) < 1e-9) (ex = lmin - c), (ez = b);
            const L2 = Math.hypot(ex, ez);
            if (L2 > 1e-9) {
              NS2[ci * 2] = ex / L2;
              NS2[ci * 2 + 1] = ez / L2;
              ok = true;
            }
          }
        }
        NK[ci] = ok ? 1 : 2;
        return ok;
      };
      // Refine the strongest peaks by ICP: readings paired with the nearest
      // structure cell (3D, within a shrinking radius); point-to-plane
      // residuals against wall-like cells (sliding along a wall is free),
      // point-to-point otherwise; the linearised x/z + yaw step solved in
      // closed form, repeated. Peaks on one ridge (yaw traded against shift)
      // converge to the same answer; a peak that converges elsewhere is a
      // real alternative.
      const icp = function* (st: { dx: number; dz: number; dyaw: number }): Generator<void, P, void> {
        let { dx, dz, dyaw } = st;
        // How well the pairs pin down the weakest direction (smallest eigenvalue of
        // the normal equations per pair; yaw counted at 1m): ~0 = slides freely.
        let weak = 0;
        for (let it = 0; it < 8; it++) {
          const tau = it < 3 ? 0.12 : 0.06, tau2 = tau * tau, R = it < 3 ? 2 : 1;
          const c = Math.cos(dyaw), sn = Math.sin(dyaw);
          // Normal equations of the 3 parameters (yaw, x, z).
          let h00 = 0, h01 = 0, h02 = 0, h11 = 0, h12 = 0, h22 = 0, g0 = 0, g1 = 0, g2 = 0, n = 0;
          const add = (j0: number, j1: number, j2: number, r: number) => {
            h00 += j0 * j0;
            h01 += j0 * j1;
            h02 += j0 * j2;
            h11 += j1 * j1;
            h12 += j1 * j2;
            h22 += j2 * j2;
            g0 += j0 * r;
            g1 += j1 * r;
            g2 += j2 * r;
          };
          for (let u = 0; u < m; u++) {
            if ((u & 255) === 255) yield;
            if (JL[u] < 0) continue;
            const rx = c * RX[u] + sn * RZ[u], rz = -sn * RX[u] + c * RZ[u];
            const x = px + rx + dx, z = pz + rz + dz, y = PY[u];
            const i0 = Math.floor((x - ox) * inv), j0 = Math.floor((y - oy) * inv), k0 = Math.floor((z - oz) * inv);
            let bd = tau2, bq = -1;
            for (let dj = -1; dj <= 1; dj++)
              for (let dk = -R; dk <= R; dk++)
                for (let di = -R; di <= R; di++) {
                  const i = i0 + di, j = j0 + dj, k = k0 + dk;
                  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
                  const n0 = at(i, j, k);
                  if (L[n0] !== 1) continue;
                  const ci = cellAt.get(n0)!;
                  const d2 = (CX[ci] - x) ** 2 + (CY[ci] - y) ** 2 + (CZ[ci] - z) ** 2;
                  if (d2 < bd) (bd = d2), (bq = ci);
                }
            if (bq < 0) continue;
            n++;
            // d(point)/d(yaw) = (rz, -rx) for x' = c x + s z, z' = -s x + c z.
            const ex = x - CX[bq], ez = z - CZ[bq];
            if (normalOf(bq)) {
              const nxv = NS2[bq * 2], nzv = NS2[bq * 2 + 1];
              add(nxv * rz - nzv * rx, nxv, nzv, ex * nxv + ez * nzv);
            } else {
              // Weak point-to-point pull (a top or a corner fixes little on its own).
              add(0.5 * rz, 0.5, 0, 0.5 * ex);
              add(-0.5 * rx, 0, 0.5, 0.5 * ez);
            }
          }
          if (n < 30) break;
          weak = minEig3(h00, h01, h02, h11, h12, h22) / n;
          // Solve H δ = -g (3×3, a little damping).
          const d = 1e-6 * n;
          const a00 = h00 + d, a11 = h11 + d, a22 = h22 + d;
          const det = a00 * (a11 * a22 - h12 * h12) - h01 * (h01 * a22 - h12 * h02) + h02 * (h01 * h12 - a11 * h02);
          if (Math.abs(det) < 1e-12) break;
          const b0 = -g0, b1 = -g1, b2 = -g2;
          const s0 = (b0 * (a11 * a22 - h12 * h12) - h01 * (b1 * a22 - h12 * b2) + h02 * (b1 * h12 - a11 * b2)) / det;
          const s1 = (a00 * (b1 * a22 - h12 * b2) - b0 * (h01 * a22 - h12 * h02) + h02 * (h01 * b2 - b1 * h02)) / det;
          const s2 = (a00 * (a11 * b2 - b1 * h12) - h01 * (h01 * b2 - b1 * h02) + b0 * (h01 * h12 - a11 * h02)) / det;
          // A yaw step turns the readings about the pivot; the shift is applied after the turn.
          const step = Math.max(Math.abs(s0) * 2, Math.hypot(s1, s2));
          const k = step > 0.1 ? 0.1 / step : 1;
          const ndyaw = dyaw + k * s0;
          // Turning by δ about the pivot also moves the current shift: x' = R(δ)(x - p) + p + d keeps d; our
          // parameterisation is the total yaw and the total shift, so the shift just takes its own step.
          dx += k * s1;
          dz += k * s2;
          dyaw = ndyaw;
          if (Math.abs(dyaw) > maxYaw + 0.05) break;
          if (Math.abs(k * s0) < 2e-4 && Math.hypot(k * s1, k * s2) < 1e-3) break;
          yield; // (one pass over the readings per step: keep frames short)
        }
        const sc = score(dx, dz, dyaw);
        return { dx, dz, dyaw, s: sc, v: sc - pen(dx, dz, dyaw), weak };
      };
      const refined: P[] = [];
      for (const pk of peaks.slice(0, 3)) {
        const r = yield* icp(pk);
        // (The count is flat over a voxel or two — walls come out a couple of
        // voxels thick — so a converged ICP fit is the better estimate even
        // when it counts less; if it wandered off or got much worse, keep the peak.)
        refined.push(Math.hypot(r.dx, r.dz) <= maxShift + 0.1 && Math.hypot(r.dx - pk.dx, r.dz - pk.dz) + Math.abs(r.dyaw - pk.dyaw) < 0.25 && r.s >= 0.6 * pk.s ? r : pk);
        yield;
      }
      refined.sort((a, b) => b.v - a.v);
      const best = refined[0];
      // Ambiguity: the strongest peak that is a clearly different correction
      // (≥30cm at 1m away). Nearer ones are mostly the same fit traded along
      // a ridge (yaw against shift): uncertainty, which the drift monitor
      // handles by requiring estimates from different moments to agree.
      // Compared by exact hits only (the soft count is flat over a voxel or
      // two, so it rates a sloppy alternative almost as high as a tight fit).
      let second = 0, secondSharp = 0, secondAt: { dx: number; dz: number; dyaw: number } | null = null;
      const dist = (c: { dx: number; dz: number; dyaw: number }) => Math.hypot(c.dx - best.dx, c.dz - best.dz) + Math.abs(c.dyaw - best.dyaw);
      for (const c of refined.slice(1)) {
        if (dist(c) < 0.3) continue;
        const sh = score(c.dx, c.dz, c.dyaw, 0);
        if (sh > secondSharp) {
          secondSharp = sh;
          second = c.s;
          secondAt = { dx: c.dx, dz: c.dz, dyaw: c.dyaw };
        }
      }
      const bestSharp = score(best.dx, best.dz, best.dyaw, 0);
      // Degenerate: the fit slides freely along some direction (support
      // holds up both ways along x, z, a diagonal, or yaw).
      // (From the ICP fit when it took: the count is flat over a voxel or two
      // everywhere, so nudging it says little.)
      let degenerate = false;
      if (best.weak !== undefined && best.weak > 0) degenerate = best.weak < this.minConstraint;
      else {
        const drop = 0.12 * best.s;
        const flatAt = (a: number, b: number, y: number) => score(best.dx + a, best.dz + b, best.dyaw + y) > best.s - drop;
        for (const [a, b, y] of [[0.1, 0, 0], [0, 0.1, 0], [0.07, 0.07, 0], [0.07, -0.07, 0], [0, 0, 0.05]]) if (flatAt(a, b, y) && flatAt(-a, -b, -y)) degenerate = true;
      }
      const match: PlaceMatch = { dx: best.dx, dz: best.dz, dyaw: best.dyaw, pivot: { ...pivot }, base: Math.round(score(0, 0, 0)), best: Math.round(best.s), n: m, degenerate, visitT0: visit.t0, visitT1: visit.t1, second: Math.round(second), secondAt, constraint: best.weak ?? NaN, unique: bestSharp / Math.max(1, secondSharp) };
      if (!result || match.best > result.best) result = match;
    }
    return result;
  }
}

/** Heading (atan2 of the mean x/z direction from the eye) of a frame's off-floor readings, or null. */
export function frameHeading(f: { eye: Vec3; pts: Float32Array }, floorY: number): number | null {
  let hx = 0, hz = 0, n = 0;
  const P = f.pts, e = f.eye;
  for (let q = 0; q < P.length; q += 9) {
    if (P[q + 1] < floorY + 0.06) continue;
    const dx = P[q] - e.x, dz = P[q + 2] - e.z, d = Math.hypot(dx, dz);
    if (d < 0.2) continue;
    hx += dx / d;
    hz += dz / d;
    n++;
  }
  return n >= 10 && Math.hypot(hx, hz) > 0.3 * n ? Math.atan2(hz, hx) : null;
}

export function angDiff(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/** Smallest eigenvalue of a symmetric 3×3 matrix (closed form). */
export function minEig3(a: number, b: number, c: number, d: number, e: number, f: number): number {
  // [[a, b, c], [b, d, e], [c, e, f]]
  const p1 = b * b + c * c + e * e;
  const q = (a + d + f) / 3;
  if (p1 < 1e-18) return Math.min(a, d, f);
  const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B00 = (a - q) / p, B11 = (d - q) / p, B22 = (f - q) / p, B01 = b / p, B02 = c / p, B12 = e / p;
  const detB = B00 * (B11 * B22 - B12 * B12) - B01 * (B01 * B22 - B12 * B02) + B02 * (B01 * B12 - B11 * B02);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  // Eigenvalues q + 2p cos(phi + 2πk/3); the smallest is k = 1.
  return q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
}

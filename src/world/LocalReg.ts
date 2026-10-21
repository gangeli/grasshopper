/**
 * Local re-registration of the old map near the player (2-D, x/z + yaw).
 *
 * Odometry drift moves the tracking frame slowly: what the camera sees now is
 * consistent with itself, and structure laid down a while ago sits where an
 * older, drifted frame put it. Instead of moving the frame onto the old map
 * (a loop closure: right locally, wrong for everything mapped since), the old
 * structure near the player is moved onto the current view, a little at a
 * time. Drift is horizontal (a slide and a turn of the frame), so the match
 * is done in plan view: the old structure's footprint at body height against
 * the footprint of the latest depth readings, point-to-line ICP with robust
 * weights, a small search range, and only along directions the scene
 * constrains (a plain wall pins one axis, not the one along it).
 *
 * This file is the geometry (pure functions, no map access): a plan-view
 * reference image of old structure, its nearest-cell field and local lines,
 * and the ICP. WorldModel builds the reference, collects the readings and
 * moves the voxels.
 */

/** Plan-view footprint of old structure: cell (a, b) covers map x ∈ [ox + a·res, +res), z likewise. */
export interface RefImage {
  w: number;
  h: number;
  res: number;
  ox: number;
  oz: number;
  /** Old occupied voxels in the column's height band (weight). */
  cnt: Float32Array;
}

/** Nearest occupied reference cell for every cell (index, or -1 when none within reach). */
export function nearestField(ref: RefImage, reach: number): Int32Array {
  const { w, h, cnt } = ref;
  const near = new Int32Array(w * h).fill(-1);
  const d2 = new Float32Array(w * h).fill(Infinity);
  for (let c = 0; c < w * h; c++) if (cnt[c] > 0) (near[c] = c), (d2[c] = 0);
  const R2 = reach * reach;
  // Two chamfer passes propagating the nearest seed (8-neighbourhood); distances exact to the seed.
  const relax = (c: number, n: number, a: number, b: number) => {
    const s = near[n];
    if (s < 0) return;
    const sa = s % w, sb = (s - sa) / w;
    const dd = (sa - a) * (sa - a) + (sb - b) * (sb - b);
    if (dd < d2[c] && dd <= R2) (d2[c] = dd), (near[c] = s);
  };
  for (let b = 0; b < h; b++)
    for (let a = 0; a < w; a++) {
      const c = b * w + a;
      if (a > 0) relax(c, c - 1, a, b);
      if (b > 0) {
        relax(c, c - w, a, b);
        if (a > 0) relax(c, c - w - 1, a, b);
        if (a < w - 1) relax(c, c - w + 1, a, b);
      }
    }
  for (let b = h - 1; b >= 0; b--)
    for (let a = w - 1; a >= 0; a--) {
      const c = b * w + a;
      if (a < w - 1) relax(c, c + 1, a, b);
      if (b < h - 1) {
        relax(c, c + w, a, b);
        if (a < w - 1) relax(c, c + w + 1, a, b);
        if (a > 0) relax(c, c + w - 1, a, b);
      }
    }
  return near;
}

/** Local line through a reference cell's neighbourhood: centroid, unit normal, and how line-like (0 blob .. 1 line). */
export interface RefLines {
  cx: Float32Array;
  cz: Float32Array;
  nx: Float32Array;
  nz: Float32Array;
  lin: Float32Array;
  done: Uint8Array;
}

export function refLines(ref: RefImage): RefLines {
  const n = ref.w * ref.h;
  return { cx: new Float32Array(n), cz: new Float32Array(n), nx: new Float32Array(n), nz: new Float32Array(n), lin: new Float32Array(n), done: new Uint8Array(n) };
}

/** Fit the line of reference cell c from its ±2-cell neighbourhood (cached). */
export function lineAt(ref: RefImage, L: RefLines, c: number): void {
  if (L.done[c]) return;
  L.done[c] = 1;
  const { w, h, cnt, res, ox, oz } = ref;
  const a0 = c % w, b0 = (c - a0) / w;
  let sw = 0, sx = 0, sz = 0, sxx = 0, sxz = 0, szz = 0;
  for (let db = -2; db <= 2; db++) {
    const b = b0 + db;
    if (b < 0 || b >= h) continue;
    for (let da = -2; da <= 2; da++) {
      const a = a0 + da;
      if (a < 0 || a >= w) continue;
      const q = cnt[b * w + a];
      if (q <= 0) continue;
      const x = ox + (a + 0.5) * res, z = oz + (b + 0.5) * res;
      sw += q;
      sx += q * x;
      sz += q * z;
      sxx += q * x * x;
      sxz += q * x * z;
      szz += q * z * z;
    }
  }
  const mx = sx / sw, mz = sz / sw;
  const cxx = sxx / sw - mx * mx, cxz = sxz / sw - mx * mz, czz = szz / sw - mz * mz;
  // Eigen of [[cxx, cxz], [cxz, czz]]: the normal is the minor axis.
  const tr = cxx + czz, det = cxx * czz - cxz * cxz;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  // Minor-axis eigenvector.
  let ex = cxz, ez = l2 - cxx;
  if (Math.abs(ex) + Math.abs(ez) < 1e-12) (ex = l2 - czz), (ez = cxz);
  if (Math.abs(ex) + Math.abs(ez) < 1e-12) (ex = 1), (ez = 0);
  const el = Math.hypot(ex, ez);
  L.cx[c] = mx;
  L.cz[c] = mz;
  L.nx[c] = ex / el;
  L.nz[c] = ez / el;
  L.lin[c] = l1 > 1e-9 ? 1 - l2 / l1 : 0;
}

export interface IcpOptions {
  /** Correspondence distance per iteration (m); the last one is used for scoring. */
  reach: number[];
  /** Huber scale of the residuals (m). */
  huber: number;
  /** Inlier residual (m). */
  inlier: number;
  /** Lever (m) that puts the yaw on the same scale as the shifts in the constraint test. */
  lever: number;
  /** A direction is constrained when its information (Σ w·J², in inlier-equivalents) reaches this. */
  minInfo: number;
}

export const ICP_DEFAULTS: IcpOptions = { reach: [0.3, 0.25, 0.2, 0.15, 0.12, 0.1, 0.08, 0.08, 0.08], huber: 0.03, inlier: 0.03, lever: 2, minInfo: 40 };

export interface IcpResult {
  /** Fresh → old (the frame where the reference is): x' = c·x + s·z + tx, z' = −s·x + c·z + tz. */
  T: [number, number, number, number];
  /** Old → fresh (what moves the old structure onto the current view), same layout. */
  C: [number, number, number, number];
  /** Readings with a reference cell within the last reach, and inliers among them, before (identity) and after. */
  matched0: number;
  inliers0: number;
  matched: number;
  inliers: number;
  /** Robust mean residual (m) after. */
  rms: number;
  /** Information along the weakest of the 3 directions (inlier-equivalents) and the number of constrained directions. */
  minInfo: number;
  dims: number;
  /** Points used. */
  n: number;
  /** Reference cells the inliers landed on (after). */
  cells: number[];
}

/** Symmetric 3×3 eigen-decomposition (Jacobi). Returns eigenvalues and column eigenvectors (V[r*3+c]). */
export function eig3(A: number[]): { val: number[]; V: number[] } {
  const a = A.slice();
  const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const app = a[p * 3 + p], aqq = a[q * 3 + q];
      const th = (aqq - app) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq;
        V[k * 3 + q] = s * vkp + c * vkq;
      }
      off = 0;
    }
  }
  return { val: [a[0], a[4], a[8]], V };
}

/**
 * Align fresh plan-view points (x, z pairs, map frame) to the reference:
 * the transform T taking them onto it (and its inverse C, moving the old
 * structure onto them), about `pivot`. Only constrained directions move.
 */
export function icp2d(pts: Float32Array, ref: RefImage, near: Int32Array, lines: RefLines, pivot: { x: number; z: number }, o: IcpOptions = ICP_DEFAULTS, init?: { th: number; tx: number; tz: number }): IcpResult {
  const n = pts.length >> 1;
  const { w, h, res, ox, oz } = ref;
  // T as rotation angle th about the pivot plus shift: p' = R(th)(p − pivot) + pivot + t.
  let th = init?.th ?? 0, tx = init?.tx ?? 0, tz = init?.tz ?? 0;
  const L = o.lever;
  let minInfo = 0, dims = 0;
  let cells: number[] | null = null;
  const score = (th: number, tx: number, tz: number, reach: number) => {
    const c = Math.cos(th), s = Math.sin(th);
    let matched = 0, inl = 0, sr = 0, sw = 0;
    for (let q = 0; q < n; q++) {
      const rx = pts[2 * q] - pivot.x, rz = pts[2 * q + 1] - pivot.z;
      const x = pivot.x + c * rx + s * rz + tx, z = pivot.z - s * rx + c * rz + tz;
      const a = Math.floor((x - ox) / res), b = Math.floor((z - oz) / res);
      if (a < 0 || b < 0 || a >= w || b >= h) continue;
      const m = near[b * w + a];
      if (m < 0) continue;
      lineAt(ref, lines, m);
      const dx = x - lines.cx[m], dz = z - lines.cz[m];
      if (dx * dx + dz * dz > reach * reach) continue;
      const lin = lines.lin[m];
      const r = lin > 0.6 ? Math.abs(dx * lines.nx[m] + dz * lines.nz[m]) : Math.hypot(dx, dz);
      matched++;
      if (r < o.inlier) {
        inl++;
        cells?.push(m);
      }
      const wgt = r < o.huber ? 1 : o.huber / r;
      sr += wgt * r * r;
      sw += wgt;
    }
    return { matched, inl, rms: sw > 0 ? Math.sqrt(sr / sw) : Infinity };
  };
  const last = o.reach[o.reach.length - 1];
  const s0 = score(0, 0, 0, last);
  for (let it = 0; it < o.reach.length; it++) {
    const reach = o.reach[it];
    const c = Math.cos(th), s = Math.sin(th);
    // Normal equations in (δx, δz, L·δth).
    const H = [0, 0, 0, 0, 0, 0, 0, 0, 0], g = [0, 0, 0];
    // Unweighted information: which directions the scene constrains at all
    // (robust weights shrink it while the residuals are still large).
    const U = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    let used = 0;
    for (let q = 0; q < n; q++) {
      const rx = pts[2 * q] - pivot.x, rz = pts[2 * q + 1] - pivot.z;
      const vx = c * rx + s * rz, vz = -s * rx + c * rz;
      const x = pivot.x + vx + tx, z = pivot.z + vz + tz;
      const a = Math.floor((x - ox) / res), b = Math.floor((z - oz) / res);
      if (a < 0 || b < 0 || a >= w || b >= h) continue;
      const m = near[b * w + a];
      if (m < 0) continue;
      lineAt(ref, lines, m);
      const dx = x - lines.cx[m], dz = z - lines.cz[m];
      if (dx * dx + dz * dz > reach * reach) continue;
      // d(p')/d(th) for p' = R(th) v: R = [[c, s], [−s, c]] → (−s·rx + c·rz, −c·rx − s·rz) = (vz, −vx).
      const jx = vz / L, jz = -vx / L;
      const addRow = (nx: number, nz: number, r: number) => {
        const J0 = nx, J1 = nz, J2 = nx * jx + nz * jz;
        const wgt = Math.abs(r) < o.huber ? 1 : o.huber / Math.abs(r);
        H[0] += wgt * J0 * J0;
        H[1] += wgt * J0 * J1;
        H[2] += wgt * J0 * J2;
        H[4] += wgt * J1 * J1;
        H[5] += wgt * J1 * J2;
        H[8] += wgt * J2 * J2;
        U[0] += J0 * J0;
        U[1] += J0 * J1;
        U[2] += J0 * J2;
        U[4] += J1 * J1;
        U[5] += J1 * J2;
        U[8] += J2 * J2;
        g[0] += wgt * J0 * r;
        g[1] += wgt * J1 * r;
        g[2] += wgt * J2 * r;
      };
      if (lines.lin[m] > 0.6) addRow(lines.nx[m], lines.nz[m], dx * lines.nx[m] + dz * lines.nz[m]);
      else {
        // A blob (a chair leg, a corner): point to point, but at half weight per axis.
        addRow(Math.SQRT1_2, 0, dx * Math.SQRT1_2);
        addRow(0, Math.SQRT1_2, dz * Math.SQRT1_2);
      }
      used++;
    }
    if (used < 10) break;
    H[3] = H[1];
    H[6] = H[2];
    H[7] = H[5];
    U[3] = U[1];
    U[6] = U[2];
    U[7] = U[5];
    const { val, V } = eig3(U);
    // Solve the weighted normal equations within the constrained directions only.
    const P: number[][] = [];
    minInfo = Infinity;
    for (let e = 0; e < 3; e++) {
      minInfo = Math.min(minInfo, val[e]);
      if (val[e] >= o.minInfo) P.push([V[e], V[3 + e], V[6 + e]]);
    }
    dims = P.length;
    const d = [0, 0, 0];
    if (dims) {
      // Reduced system (PᵀHP) y = −Pᵀg.
      const k = dims, M: number[] = new Array(k * k).fill(0), rhs: number[] = new Array(k).fill(0);
      for (let a = 0; a < k; a++) {
        for (let r = 0; r < 3; r++) rhs[a] -= P[a][r] * g[r];
        for (let b = 0; b < k; b++) {
          let sum = 0;
          for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) sum += P[a][r] * H[r * 3 + q] * P[b][q];
          M[a * k + b] = sum;
        }
      }
      const y = solveSmall(M, rhs, k);
      if (y) for (let a = 0; a < k; a++) for (let r = 0; r < 3; r++) d[r] += y[a] * P[a][r];
    }
    // Compose: p'' = R(δth)(p' − pivot) + pivot + δt, with p' = R(th)(p − pivot) + pivot + t.
    const dth = d[2] / L;
    const cd = Math.cos(dth), sd = Math.sin(dth);
    const ntx = cd * tx + sd * tz + d[0], ntz = -sd * tx + cd * tz + d[1];
    th += dth;
    tx = ntx;
    tz = ntz;
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-4 && reach === last) break;
  }
  cells = [];
  const s1 = score(th, tx, tz, last);
  // T as an affine map: x' = c·x + s·z + ax, about the origin.
  const c = Math.cos(th), s = Math.sin(th);
  const ax = pivot.x - c * pivot.x - s * pivot.z + tx, az = pivot.z + s * pivot.x - c * pivot.z + tz;
  // Inverse: R⁻¹ = [[c, −s], [s, c]]; x = R⁻¹(x' − a).
  const iax = -(c * ax - s * az), iaz = -(s * ax + c * az);
  return { T: [c, s, ax, az], C: [c, -s, iax, iaz], matched0: s0.matched, inliers0: s0.inl, matched: s1.matched, inliers: s1.inl, rms: s1.rms, minInfo: Number.isFinite(minInfo) ? minInfo : 0, dims, n, cells };
}

/** Solve a small dense system (Gaussian elimination with partial pivoting); null if singular. */
function solveSmall(M: number[], b: number[], k: number): number[] | null {
  const A = M.slice(), x = b.slice();
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r * k + c]) > Math.abs(A[p * k + c])) p = r;
    if (Math.abs(A[p * k + c]) < 1e-12) return null;
    if (p !== c) {
      for (let q = 0; q < k; q++) [A[c * k + q], A[p * k + q]] = [A[p * k + q], A[c * k + q]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = c + 1; r < k; r++) {
      const f = A[r * k + c] / A[c * k + c];
      for (let q = c; q < k; q++) A[r * k + q] -= f * A[c * k + q];
      x[r] -= f * x[c];
    }
  }
  for (let c = k - 1; c >= 0; c--) {
    let sum = x[c];
    for (let q = c + 1; q < k; q++) sum -= A[c * k + q] * x[q];
    x[c] = sum / A[c * k + c];
  }
  return x;
}

export interface CoarseResult {
  th: number;
  tx: number;
  tz: number;
  /** Soft count of readings on the reference at the best shift, at none, and at the best shift ≥ `apart` from it. */
  best: number;
  base: number;
  second: number;
}

/**
 * Exhaustive search of shifts (±range, step) and yaws (about the pivot) for
 * the best overlap of the readings with the reference (soft count: 1 on a
 * reference cell, falling to 0 at two cells), as a start for the ICP; with
 * the best score of shifts at least `apart` from the winner (look-alikes).
 */
export function coarse2d(pts: Float32Array, ref: RefImage, near: Int32Array, pivot: { x: number; z: number }, range: number, step: number, yaws: number[], apart = 0.15): CoarseResult {
  const n = pts.length >> 1, { w, h, res, ox, oz } = ref;
  const S = Math.round(range / step), side = 2 * S + 1;
  const scores = new Float32Array(side * side * yaws.length);
  const sx = new Float32Array(n), sz = new Float32Array(n);
  const r2 = (2 * res) * (2 * res);
  for (let y = 0; y < yaws.length; y++) {
    const c = Math.cos(yaws[y]), s = Math.sin(yaws[y]);
    for (let q = 0; q < n; q++) {
      const rx = pts[2 * q] - pivot.x, rz = pts[2 * q + 1] - pivot.z;
      sx[q] = pivot.x + c * rx + s * rz;
      sz[q] = pivot.z - s * rx + c * rz;
    }
    for (let b = -S; b <= S; b++)
      for (let a = -S; a <= S; a++) {
        const tx = a * step, tz = b * step;
        let sc = 0;
        for (let q = 0; q < n; q++) {
          const x = sx[q] + tx, z = sz[q] + tz;
          const ca = Math.floor((x - ox) / res), cb = Math.floor((z - oz) / res);
          if (ca < 0 || cb < 0 || ca >= w || cb >= h) continue;
          const m = near[cb * w + ca];
          if (m < 0) continue;
          const ma = m % w, mb = (m - ma) / w;
          const dx = x - (ox + (ma + 0.5) * res), dz = z - (oz + (mb + 0.5) * res);
          const d2 = dx * dx + dz * dz;
          if (d2 < r2) sc += 1 - d2 / r2;
        }
        scores[(y * side + (b + S)) * side + (a + S)] = sc;
      }
  }
  let bi = 0;
  for (let q = 1; q < scores.length; q++) if (scores[q] > scores[bi]) bi = q;
  const by = Math.floor(bi / (side * side)), bb = Math.floor((bi % (side * side)) / side) - S, ba = (bi % side) - S;
  let second = 0;
  for (let q = 0; q < scores.length; q++) {
    const b = Math.floor((q % (side * side)) / side) - S, a = (q % side) - S;
    if (Math.hypot(a - ba, b - bb) * step >= apart) second = Math.max(second, scores[q]);
  }
  const y0 = yaws.findIndex((v) => v === 0);
  const base = y0 >= 0 ? scores[(y0 * side + S) * side + S] : 0;
  return { th: yaws[by], tx: ba * step, tz: bb * step, best: scores[bi], base, second };
}

/** Combine coarse searches over different yaws (`hasBase`: b was the zero-yaw search). */
export function mergeCoarse(a: CoarseResult | null, b: CoarseResult, hasBase: boolean, apart = 0.15): CoarseResult {
  if (!a) return { ...b, base: hasBase ? b.base : 0 };
  const far = Math.hypot(a.tx - b.tx, a.tz - b.tz) >= apart;
  const out = b.best > a.best ? { ...b, second: Math.max(b.second, far ? a.best : a.second) } : { ...a, second: Math.max(a.second, far ? b.best : b.second) };
  out.base = hasBase ? b.base : a.base;
  return out;
}

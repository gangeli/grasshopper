import type { SimBox } from './SimRoom';

/**
 * Bounding-volume hierarchy over a room's static boxes, so simulated rays
 * (camera pixels, shadow rays, depth-sensor rays) test a handful of nearby
 * boxes instead of every box in the room. Same answers as testing each box
 * with `rayBox` (inside-the-box starts are ignored), without allocating.
 */
export class BoxBVH {
  /** Result of the last `nearest` call: the box, distance and hit face (axis 0..2, sign ±1). */
  hit: SimBox | null = null;
  t = Infinity;
  axis = 0;
  sign = 0;
  private hitIndex = -1;

  private readonly bmin: Float64Array;
  private readonly bmax: Float64Array;
  // Nodes: bounds, then either children (left, right) or a leaf range (start, count) in `order`.
  private nmin: Float64Array;
  private nmax: Float64Array;
  private left: Int32Array;
  private right: Int32Array;
  private start: Int32Array;
  private count: Int32Array;
  private nodes = 0;
  private readonly order: Int32Array;
  private readonly stack = new Int32Array(128);

  constructor(readonly boxes: SimBox[]) {
    const n = boxes.length;
    this.bmin = new Float64Array(n * 3);
    this.bmax = new Float64Array(n * 3);
    boxes.forEach((b, i) => {
      this.bmin.set([b.min.x, b.min.y, b.min.z], i * 3);
      this.bmax.set([b.max.x, b.max.y, b.max.z], i * 3);
    });
    const cap = Math.max(1, 2 * n);
    this.nmin = new Float64Array(cap * 3);
    this.nmax = new Float64Array(cap * 3);
    this.left = new Int32Array(cap);
    this.right = new Int32Array(cap);
    this.start = new Int32Array(cap);
    this.count = new Int32Array(cap);
    this.order = Int32Array.from({ length: n }, (_, i) => i);
    if (n) this.build(0, n);
  }

  private build(lo: number, hi: number): number {
    const id = this.nodes++;
    const { bmin, bmax, order } = this;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const b = order[i] * 3;
      for (let a = 0; a < 3; a++) {
        mn[a] = Math.min(mn[a], bmin[b + a]);
        mx[a] = Math.max(mx[a], bmax[b + a]);
      }
    }
    this.nmin.set(mn, id * 3);
    this.nmax.set(mx, id * 3);
    if (hi - lo <= 4) {
      this.start[id] = lo;
      this.count[id] = hi - lo;
      return id;
    }
    // Split at the median centre along the widest axis.
    let axis = 0;
    for (let a = 1; a < 3; a++) if (mx[a] - mn[a] > mx[axis] - mn[axis]) axis = a;
    const c = (i: number) => bmin[i * 3 + axis] + bmax[i * 3 + axis];
    const sorted = Array.from(order.subarray(lo, hi)).sort((p, q) => c(p) - c(q));
    order.set(sorted, lo);
    const mid = (lo + hi) >> 1;
    this.count[id] = 0;
    this.left[id] = this.build(lo, mid);
    this.right[id] = this.build(mid, hi);
    return id;
  }

  /** Slab test against node/box bounds: entry distance, or Infinity on a miss. */
  private static enter(mn: Float64Array, mx: Float64Array, k: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tMax: number): number {
    let t1 = (mn[k] - ox) * ix, t2 = (mx[k] - ox) * ix;
    let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
    t1 = (mn[k + 1] - oy) * iy;
    t2 = (mx[k + 1] - oy) * iy;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
    t1 = (mn[k + 2] - oz) * iz;
    t2 = (mx[k + 2] - oz) * iz;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
    return tmax >= Math.max(tmin, 0) && tmin <= tMax ? tmin : Infinity;
  }

  /**
   * Exact ray-box test for box i, as `rayBox` does it (axis-parallel rays,
   * ignoring starts inside the box). Sets axis/sign scratch. Returns t or Infinity.
   */
  private boxT(i: number, o: number[], d: number[]): number {
    const k = i * 3;
    let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        if (o[a] < this.bmin[k + a] || o[a] > this.bmax[k + a]) return Infinity;
        continue;
      }
      let t1 = (this.bmin[k + a] - o[a]) / d[a], t2 = (this.bmax[k + a] - o[a]) / d[a];
      let s = -1;
      if (t1 > t2) {
        const x = t1;
        t1 = t2;
        t2 = x;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
    if (tmax < 0 || tmin < 0) return Infinity;
    this.sa = axis;
    this.ss = sign;
    return tmin;
  }
  private sa = 0;
  private ss = 0;
  private readonly o = [0, 0, 0];
  private readonly d = [0, 0, 0];

  /**
   * Nearest box hit with minT < t < maxT (boxes for which `skip` is true are
   * ignored). Returns true on a hit and fills hit/t/axis/sign.
   */
  nearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, minT = 0, skip?: (b: SimBox) => boolean): boolean {
    this.hit = null;
    this.t = maxT;
    if (!this.nodes) return false;
    const o = this.o, d = this.d;
    o[0] = ox;
    o[1] = oy;
    o[2] = oz;
    d[0] = dx;
    d[1] = dy;
    d[2] = dz;
    // (Axis-parallel rays: a huge finite inverse keeps the slab test free of NaNs.)
    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    const st = this.stack;
    let sp = 0;
    st[sp++] = 0;
    while (sp) {
      const nd = st[--sp];
      if (BoxBVH.enter(this.nmin, this.nmax, nd * 3, ox, oy, oz, ix, iy, iz, this.t) === Infinity) continue;
      const c = this.count[nd];
      if (c) {
        for (let q = this.start[nd], e = q + c; q < e; q++) {
          const i = this.order[q];
          const b = this.boxes[i];
          if (skip && skip(b)) continue;
          const t = this.boxT(i, o, d);
          // Ties (boxes sharing a face) go to the earlier box, as a linear scan would.
          if (t > minT && (t < this.t || (t === this.t && this.hit !== null && i < this.hitIndex))) {
            this.hitIndex = i;
            this.t = t;
            this.hit = b;
            this.axis = this.sa;
            this.sign = this.ss;
          }
        }
      } else {
        // Visit the nearer child first so far boxes get culled.
        const l = this.left[nd], r = this.right[nd];
        const tl = BoxBVH.enter(this.nmin, this.nmax, l * 3, ox, oy, oz, ix, iy, iz, this.t);
        const tr = BoxBVH.enter(this.nmin, this.nmax, r * 3, ox, oy, oz, ix, iy, iz, this.t);
        if (tl <= tr) {
          if (tr !== Infinity) st[sp++] = r;
          if (tl !== Infinity) st[sp++] = l;
        } else {
          if (tl !== Infinity) st[sp++] = l;
          if (tr !== Infinity) st[sp++] = r;
        }
      }
    }
    return this.hit !== null;
  }
}

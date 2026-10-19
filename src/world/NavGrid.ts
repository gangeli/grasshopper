import type { Vec3 } from '../core/math';
import type { VoxelGrid } from './VoxelGrid';
import type { WorldModel } from './WorldModel';

/**
 * 2.5D navigation built from the occupancy grid. Every column can hold several
 * standable surfaces (floor, under a table, the table top, inside a box...).
 * Nodes connect to neighbours by walking (small steps) and, lazily, by jump
 * links that pass a parabolic clearance test.
 */
export interface NavParams {
  /** Headroom needed to walk upright. */
  standHeight: number;
  /** Minimum headroom to squeeze through crawling. */
  crawlHeight: number;
  /** Clearance radius from obstacles. */
  radius: number;
  maxStep: number;
  maxJumpUp: number;
  maxJumpDown: number;
  maxJumpDist: number;
  /** Ignore surfaces higher than this above the floor (wall tops, wardrobes). */
  maxSurfaceHeight: number;
  /** With depth sensing: fraction of the body volume that must have been observed empty. */
  knownFreeMin: number;
  /** Raised surfaces lower than this (above the floor) aren't stood on. */
  minPlatform: number;
  /** Voxels of observed-empty space required right above a surface. */
  seenFreeMin: number;
}

export const DEFAULT_NAV: NavParams = {
  standHeight: 0.26,
  crawlHeight: 0.13,
  radius: 0.1,
  maxStep: 0.045,
  maxJumpUp: 0.95,
  maxJumpDown: 1.3,
  maxJumpDist: 1.1,
  maxSurfaceHeight: 1.95,
  knownFreeMin: 0.5,
  minPlatform: 0.12,
  seenFreeMin: 2,
};

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** True when arriving at this waypoint requires a jump from the previous one. */
  jump: boolean;
  /** For jumps: extra apex height above the default arc (metres), chosen to clear obstacles. */
  lift?: number;
  node: number;
}

const NONE = -1;

export class NavGrid {
  readonly p: NavParams;
  readonly g: VoxelGrid;
  /** Node attributes (struct of arrays). */
  ni: Int32Array = new Int32Array(0);
  nk: Int32Array = new Int32Array(0);
  /** Top-of-surface height in world units. */
  ny: Float32Array = new Float32Array(0);
  headroom: Float32Array = new Float32Array(0);
  /** Distance (m) to the nearest blocking column, capped. */
  wallDist: Float32Array = new Float32Array(0);
  /** Columns: start offset & count into node arrays. */
  colStart: Int32Array;
  colCount: Uint8Array;
  count = 0;
  builtVersion = -1;
  private jumpCache = new Map<number, number[]>();
  /** Extra arc lift per jump link, keyed by from*count+to. */
  private jumpLift = new Map<number, number>();
  private edgeFlag: Uint8Array = new Uint8Array(0);

  constructor(readonly world: WorldModel, params: Partial<NavParams> = {}) {
    if (!world.grid) throw new Error('NavGrid needs an initialized world grid');
    this.g = world.grid;
    this.p = { ...DEFAULT_NAV, ...params };
    this.colStart = new Int32Array(this.g.nx * this.g.nz);
    this.colCount = new Uint8Array(this.g.nx * this.g.nz);
    this.build();
  }

  /** Rebuild if the grid changed. Returns true if rebuilt. */
  refresh(): boolean {
    if (this.g.version === this.builtVersion) return false;
    this.build();
    return true;
  }

  build(): void {
    const g = this.g, p = this.p, r = g.res;
    const floorTopJ = this.world.floorLayer - 1;
    const rad = Math.ceil(p.radius / r);
    const stepCells = p.maxStep / r;
    const crawlCells = Math.ceil(p.crawlHeight / r);
    const capCells = Math.ceil(0.5 / r);
    g.updateShadow();
    // With depth sensing we only trust space we've actually seen to be empty;
    // otherwise the inside of a box whose top we never saw would look walkable.
    const requireSeen = this.world.depthPoints > 0;

    // Pass 1: candidate surfaces per column.
    const candI: number[] = [], candK: number[] = [], candJ: number[] = [], candH: number[] = [];
    this.colCount.fill(0);
    for (let k = 0; k < g.nz; k++)
      for (let i = 0; i < g.nx; i++) {
        const col = k * g.nx + i;
        this.colStart[col] = candI.length;
        for (let j = floorTopJ; j < g.ny - 1; j++) {
          if (!g.solid(i, j, k) || g.solid(i, j + 1, k)) continue;
          if (j === floorTopJ && !g.isObserved(i, k)) continue;
          // Only real observations can hold the pet up; guessed ("soft") or
          // shadow-inferred cells only block.
          if (j !== floorTopJ && !g.occ(i, j, k)) continue;
          // Low "platforms" (a few cm up to ~12cm) are mostly depth noise on
          // the floor, or toys: walk around them, never stand on them.
          if (j !== floorTopJ) {
            const hAbove = g.surfaceY(i, j, k) - this.world.floorY;
            if (hAbove > p.maxStep && hAbove < p.minPlatform) continue;
          }
          if (g.underside[g.idx(i, j, k)] === 1) continue;
          if (j * r > p.maxSurfaceHeight) break;
          // Headroom.
          let h = 0;
          while (h < capCells && j + 1 + h < g.ny && !g.solid(i, j + 1 + h, k)) h++;
          if (h < crawlCells) continue;
          if (requireSeen && !this.seenFree(i, j, k)) continue;
          candI.push(i);
          candK.push(k);
          candJ.push(j);
          candH.push(h * r);
          this.colCount[col]++;
          if (this.colCount[col] >= 6) break;
        }
      }

    // Pass 2: clearance and support filtering.
    const n0 = candI.length;
    const keep = new Uint8Array(n0);
    const wd = new Float32Array(n0);
    for (let q = 0; q < n0; q++) {
      const i = candI[q], k = candK[q], j = candJ[q];
      const needCells = Math.min(Math.round(candH[q] / r), Math.ceil(p.standHeight / r));
      let ok = true;
      let nearest = 9;
      let seen = 0, total = 0;
      for (let dk = -rad - 1; dk <= rad + 1 && ok; dk++)
        for (let di = -rad - 1; di <= rad + 1 && ok; di++) {
          const d2 = di * di + dk * dk;
          const ii = i + di, kk = k + dk;
          const inDisc = d2 <= rad * rad;
          // Obstacle check: anything solid in the body's height band.
          let blocked = false;
          for (let jj = j + 1 + Math.floor(stepCells); jj <= j + needCells; jj++) {
            if (g.solid(ii, jj, kk)) {
              blocked = true;
              break;
            }
            if (inDisc && requireSeen) {
              total++;
              if (g.data[g.idx(ii, jj, kk)] <= -2) seen++;
            }
          }
          if (blocked) {
            const d = Math.sqrt(d2);
            if (inDisc) ok = false;
            else nearest = Math.min(nearest, d);
          }
          // Support check: immediate 4-neighbourhood must have ground near this height.
          if (ok && d2 === 1) {
            let support = false;
            for (let jj = j - Math.ceil(stepCells); jj <= j + Math.floor(stepCells); jj++)
              if (g.solid(ii, jj, kk) && !g.solid(ii, jj + 1, kk)) {
                if (jj === floorTopJ && !g.isObserved(ii, kk)) continue;
                if (jj !== floorTopJ && !g.occ(ii, jj, kk)) continue;
                support = true;
                break;
              }
            if (!support) ok = false;
          }
        }
      // With depth sensing, most of the body's footprint must have been seen
      // empty: unseen space (e.g. a pot hidden under foliage) isn't trusted.
      if (ok && requireSeen && total > 0 && seen < total * p.knownFreeMin) ok = false;
      if (ok) {
        keep[q] = 1;
        wd[q] = Math.min(nearest, 9) * r;
      }
    }

    // Compact.
    let n = 0;
    for (let q = 0; q < n0; q++) if (keep[q]) n++;
    this.ni = new Int32Array(n);
    this.nk = new Int32Array(n);
    this.ny = new Float32Array(n);
    this.headroom = new Float32Array(n);
    this.wallDist = new Float32Array(n);
    this.colCount.fill(0);
    let w = 0;
    let lastCol = -1;
    for (let q = 0; q < n0; q++) {
      if (!keep[q]) continue;
      const col = candK[q] * g.nx + candI[q];
      if (col !== lastCol) {
        this.colStart[col] = w;
        lastCol = col;
      }
      this.colCount[col]++;
      this.ni[w] = candI[q];
      this.nk[w] = candK[q];
      // Floor nodes sit exactly on the floor; others at the observed sub-voxel surface height.
      this.ny[w] = candJ[q] === floorTopJ ? this.world.floorY : g.surfaceY(candI[q], candJ[q], candK[q]);
      this.headroom[w] = candH[q];
      this.wallDist[w] = wd[q];
      w++;
    }
    this.count = n;
    this.jumpCache.clear();
    this.jumpLift.clear();

    // Edge nodes: next to a height discontinuity → candidates for jump links.
    this.edgeFlag = new Uint8Array(n);
    for (let a = 0; a < n; a++) {
      for (let d = 0; d < 8; d++) {
        const ii = this.ni[a] + DI[d], kk = this.nk[a] + DK[d];
        if (this.neighborAt(ii, kk, this.ny[a]) === NONE) {
          this.edgeFlag[a] = 1;
          break;
        }
      }
    }
    this.builtVersion = g.version;
  }

  /** Some voxel in the body band of this column (or a 4-neighbour) was carved free by depth. */
  /**
   * The body space right above this surface has actually been observed empty
   * (carved by depth rays) in this very column — not just next to it, and not
   * merely assumed.
   */
  private seenFree(i: number, j: number, k: number): boolean {
    const g = this.g;
    let n = 0;
    for (let jj = j + 1; jj <= j + 5; jj++) if (g.inBounds(i, jj, k) && g.data[g.idx(i, jj, k)] < -2) n++;
    return n >= this.p.seenFreeMin;
  }

  pos(a: number): Vec3 {
    return { x: this.g.centerX(this.ni[a]), y: this.ny[a], z: this.g.centerZ(this.nk[a]) };
  }

  /** Node in column (i,k) whose height is within maxStep of y. */
  neighborAt(i: number, k: number, y: number, tol = this.p.maxStep + 1e-4): number {
    const g = this.g;
    if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) return NONE;
    const col = k * g.nx + i;
    const s = this.colStart[col], c = this.colCount[col];
    let best = NONE, bd = tol;
    for (let q = s; q < s + c; q++) {
      const d = Math.abs(this.ny[q] - y);
      if (d <= bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  /** Nearest node to a world point, preferring nodes at a similar height. */
  nearest(p: Vec3, maxR = 0.6): number {
    const g = this.g;
    const ci = g.cellX(p.x), ck = g.cellZ(p.z);
    const R = Math.ceil(maxR / g.res);
    let best = NONE, bd = Infinity;
    for (let dk = -R; dk <= R; dk++)
      for (let di = -R; di <= R; di++) {
        const i = ci + di, k = ck + dk;
        if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) continue;
        const col = k * g.nx + i;
        for (let q = this.colStart[col]; q < this.colStart[col] + this.colCount[col]; q++) {
          const dx = g.centerX(i) - p.x, dz = g.centerZ(k) - p.z, dy = (this.ny[q] - p.y) * 3;
          const d = dx * dx + dz * dz + dy * dy;
          if (d < bd) {
            bd = d;
            best = q;
          }
        }
      }
    return best;
  }

  isEdge(a: number): boolean {
    return this.edgeFlag[a] === 1;
  }

  /** Jump targets from node a (lazily computed). */
  jumps(a: number): number[] {
    if (!this.edgeFlag[a]) return EMPTY;
    const cached = this.jumpCache.get(a);
    if (cached) return cached;
    const out: number[] = [];
    const g = this.g, p = this.p, r = g.res;
    const i0 = this.ni[a], k0 = this.nk[a], y0 = this.ny[a];
    const from = this.pos(a);
    const minD = 3, maxD = Math.floor(p.maxJumpDist / r);
    // Is there room to leap upward from here (nothing overhead up to the highest reachable surface)?
    const takeoffOpen = this.openAbove(a, p.maxJumpUp + 0.2);
    for (let dir = 0; dir < 16; dir++) {
      const ang = (dir / 16) * Math.PI * 2;
      const cx = Math.cos(ang), cz = Math.sin(ang);
      let found = false;
      let lastCol = -1;
      for (let d = minD; d <= maxD && !found; d++) {
        const i = Math.round(i0 + cx * d), k = Math.round(k0 + cz * d);
        if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) break;
        const col = k * g.nx + i;
        if (col === lastCol) continue;
        lastCol = col;
        for (let q = this.colStart[col]; q < this.colStart[col] + this.colCount[col]; q++) {
          const dy = this.ny[q] - y0;
          if (dy > p.maxJumpUp || -dy > p.maxJumpDown) continue;
          // Must be a meaningful jump: a height change or a gap we can't walk.
          if (Math.abs(dy) <= p.maxStep && d <= 4) continue;
          if (Math.abs(dy) <= p.maxStep && this.walkable(from, this.pos(q))) continue;
          // Same-height leaps only hop over a mapped obstacle, never over unknown floor.
          if (Math.abs(dy) <= p.maxStep && !this.obstacleBetween(from, this.pos(q))) continue;
          if (this.headroom[q] < p.standHeight * 0.8) continue;
          // Land well inside a surface, never on its edge: under tracking
          // drift, mapped edges can be ~10cm off.
          if (!this.landingZone(q)) continue;
          // Dropping down: land in the open, never tucked under an overhang
          // whose edge the descending arc could clip.
          // The landing column must be open all the way up past the take-off
          // height: you can't drop onto a spot that's under something.
          if (dy < -p.maxStep && !this.openAbove(q, -dy + 0.25)) continue;
          // Likewise, jumping up needs open space above the take-off spot.
          if (dy > p.maxStep && !takeoffOpen) continue;
          // Lowest arc that clears everything in between (vault over walls/rims).
          const lift = this.clearLift(from, this.pos(q));
          if (lift === null) continue;
          if (lift > 0) this.jumpLift.set(a * this.count + q, lift);
          out.push(q);
          found = true;
          break;
        }
      }
    }
    this.jumpCache.set(a, out);
    return out;
  }

  /**
   * No drop-off within ~10cm of node q: every nearby cell has ground at the
   * same height or is a wall (solid at body height, e.g. a basket's side).
   */
  private landingZone(q: number): boolean {
    const g = this.g;
    const i = this.ni[q], k = this.nk[q], y = this.ny[q];
    const j0 = g.cellY(y + 0.06), j1 = g.cellY(y + 0.2);
    for (let dk = -2; dk <= 2; dk++)
      for (let di = -2; di <= 2; di++) {
        if (!(di || dk) || this.neighborAt(i + di, k + dk, y, this.p.maxStep * 0.6) !== NONE) continue;
        // Ground at the same height (just too close to a wall to be a node)?
        const js = g.cellY(y - 0.001);
        if (g.solid(i + di, js, k + dk) || g.solid(i + di, js - 1, k + dk)) continue;
        let wall = false;
        for (let j = j0; j <= j1 && !wall; j++) wall = g.solid(i + di, j, k + dk);
        if (!wall) return false;
      }
    return true;
  }

  /** No solid within `h` above node q (and its 4-neighbours). */
  private openAbove(q: number, h: number): boolean {
    const g = this.g;
    const i = this.ni[q], k = this.nk[q];
    const j0 = g.cellY(this.ny[q] + 0.02), j1 = g.cellY(this.ny[q] + h);
    for (const [di, dk] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) for (let j = j0; j <= j1; j++) if (g.solid(i + di, j, k + dk)) return false;
    return true;
  }

  /** Apex height above the higher endpoint for a jump between two points. */
  /** Extra lift needed for a clear arc from→to, or null if no allowed arc is clear. */
  clearLift(from: Vec3, to: Vec3): number | null {
    for (const lift of [0, 0.12, 0.25, 0.4]) {
      // Never above what the pet can jump from the start point.
      if (NavGrid.jumpApex(from, to, lift) - from.y > this.p.maxJumpUp + 0.2) break;
      if (this.arcClear(from, to, lift)) return lift;
    }
    return null;
  }

  liftFor(a: number, b: number): number {
    return this.jumpLift.get(a * this.count + b) ?? 0;
  }

  static jumpApex(from: Vec3, to: Vec3, lift = 0): number {
    const horiz = Math.hypot(to.x - from.x, to.z - from.z);
    return Math.max(from.y, to.y) + 0.12 + horiz * 0.15 + lift;
  }

  /** Point on the jump arc at parameter t ∈ [0,1]. */
  static arcPoint(from: Vec3, to: Vec3, t: number, out: Vec3 = { x: 0, y: 0, z: 0 }, lift = 0): Vec3 {
    const apex = NavGrid.jumpApex(from, to, lift);
    // Quadratic Bezier through an apex control point gives a smooth parabola.
    const cy = 2 * apex - 0.5 * (from.y + to.y);
    const u = 1 - t;
    out.x = from.x + (to.x - from.x) * t;
    out.z = from.z + (to.z - from.z) * t;
    out.y = u * u * from.y + 2 * u * t * cy + t * t * to.y;
    return out;
  }

  arcClear(from: Vec3, to: Vec3, lift = 0): boolean {
    const g = this.g;
    const horiz = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(8, Math.ceil(horiz / (g.res * 0.8)) + 6);
    const p: Vec3 = { x: 0, y: 0, z: 0 };
    const strict = this.world.depthPoints > 0;
    let samples = 0, unseen = 0;
    // Unit vector perpendicular to the jump direction (horizontal).
    const hl = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    const sx = -(to.z - from.z) / hl, sz = (to.x - from.x) / hl;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      NavGrid.arcPoint(from, to, t, p, lift);
      // Sample the body: feet (raised a bit), middle and head.
      for (const h of [0.06, 0.13, 0.2]) {
        // Near the endpoints the feet are on the surface itself; skip the lowest sample.
        if (h === 0.06 && (t < 0.12 || t > 0.88)) continue;
        // Centre line plus the body's width either side.
        for (const side of [0, -1, 1]) {
          const x = p.x + side * sx * 0.07, z = p.z + side * sz * 0.07;
          const i = g.cellX(x), j = g.cellY(p.y + h), k = g.cellZ(z);
          if (g.solid(i, j, k)) return false;
          if (side) continue;
          samples++;
          if (strict && g.inBounds(i, j, k) && g.data[g.idx(i, j, k)] >= -2) unseen++;
        }
      }
    }
    // Like walking, leaping needs space we've actually seen to be empty.
    return !strict || unseen <= samples * 0.15;
  }

  /** Is there something solid (5–35cm above the start height) under the straight line a→b? */
  private obstacleBetween(a: Vec3, b: Vec3): boolean {
    const g = this.g;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.ceil(len / (g.res * 0.5));
    for (let s = 1; s < n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n, z = a.z + ((b.z - a.z) * s) / n;
      for (let y = a.y + 0.05; y <= a.y + 0.35; y += g.res) if (g.occAt({ x, y, z })) return true;
    }
    return false;
  }

  /** Straight-line walkability between two nodes' positions (for path smoothing). */
  walkable(a: Vec3, b: Vec3): boolean {
    const g = this.g;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / (g.res * 0.5)));
    let y = a.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const q = this.neighborAt(g.cellX(x), g.cellZ(z), y);
      if (q === NONE) return false;
      y = this.ny[q];
    }
    return Math.abs(y - b.y) <= this.p.maxStep + 1e-4;
  }

  /** Movement cost multiplier for being on node a (squeezing and hugging walls cost a bit more). */
  private nodeCost(a: number): number {
    let c = 1;
    if (this.headroom[a] < this.p.standHeight) c += 0.6;
    if (this.wallDist[a] < 0.2) c += (0.2 - this.wallDist[a]) * 2;
    return c;
  }

  /**
   * Dijkstra/A* over walk + jump edges. If `goal` is NONE, computes a full
   * cost field up to maxCost (used to score hiding spots by reachability).
   */
  search(start: number, goal: number = NONE, maxCost = 60): { cost: Float32Array; prev: Int32Array } {
    const n = this.count;
    const cost = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(NONE);
    const heap = new MinHeap();
    if (start === NONE) return { cost, prev };
    const goalP = goal !== NONE ? this.pos(goal) : null;
    const h = (a: number) => (goalP ? Math.hypot(this.g.centerX(this.ni[a]) - goalP.x, this.g.centerZ(this.nk[a]) - goalP.z) : 0);
    cost[start] = 0;
    heap.push(start, h(start));
    const r = this.g.res;
    const closed = new Uint8Array(n);
    while (heap.size) {
      const a = heap.pop();
      if (closed[a]) continue;
      closed[a] = 1;
      if (a === goal) break;
      const ca = cost[a];
      if (ca > maxCost) break;
      const ia = this.ni[a], ka = this.nk[a], ya = this.ny[a];
      for (let d = 0; d < 8; d++) {
        const b = this.neighborAt(ia + DI[d], ka + DK[d], ya);
        if (b === NONE || closed[b]) continue;
        // No diagonal corner cutting.
        if (d >= 4 && (this.neighborAt(ia + DI[d], ka, ya) === NONE || this.neighborAt(ia, ka + DK[d], ya) === NONE)) continue;
        const step = (d >= 4 ? Math.SQRT2 : 1) * r;
        const nc = ca + step * this.nodeCost(b) + Math.abs(this.ny[b] - ya) * 0.5;
        if (nc < cost[b]) {
          cost[b] = nc;
          prev[b] = a;
          heap.push(b, nc + h(b));
        }
      }
      if (this.edgeFlag[a]) {
        const pa = this.pos(a);
        for (const b of this.jumps(a)) {
          if (closed[b]) continue;
          const pb = this.pos(b);
          // Jumps cost a fixed effort plus distance; dropping down is cheaper than climbing.
          const dy = pb.y - pa.y;
          const nc = ca + 0.35 + Math.hypot(pb.x - pa.x, pb.z - pa.z) + Math.max(0, dy) * 0.8 + Math.max(0, -dy) * 0.2;
          if (nc < cost[b]) {
            cost[b] = nc;
            prev[b] = a;
            heap.push(b, nc + h(b));
          }
        }
      }
    }
    return { cost, prev };
  }

  findPath(from: Vec3, to: Vec3): Waypoint[] | null {
    const s = this.nearest(from), t = this.nearest(to);
    if (s === NONE || t === NONE) return null;
    return this.pathBetween(s, t);
  }

  pathBetween(s: number, t: number): Waypoint[] | null {
    const { prev } = this.search(s, t);
    if (s !== t && prev[t] === NONE) return null;
    return this.reconstruct(prev, s, t);
  }

  reconstruct(prev: Int32Array, s: number, t: number): Waypoint[] {
    const nodes: number[] = [];
    for (let a = t; a !== NONE; a = prev[a]) {
      nodes.push(a);
      if (a === s) break;
    }
    nodes.reverse();
    const raw: Waypoint[] = nodes.map((a, idx) => {
      const p = this.pos(a);
      const jump = idx > 0 && !this.isWalkStep(nodes[idx - 1], a);
      return jump ? { ...p, jump, node: a, lift: this.liftFor(nodes[idx - 1], a) } : { ...p, jump, node: a };
    });
    return this.smooth(raw);
  }

  private isWalkStep(a: number, b: number): boolean {
    return Math.abs(this.ni[a] - this.ni[b]) <= 1 && Math.abs(this.nk[a] - this.nk[b]) <= 1 && Math.abs(this.ny[a] - this.ny[b]) <= this.p.maxStep + 1e-4;
  }

  /** Greedy string-pulling over walk segments; jump waypoints are kept. */
  private smooth(path: Waypoint[]): Waypoint[] {
    if (path.length <= 2) return path;
    const out: Waypoint[] = [path[0]];
    let anchor = 0;
    let i = 1;
    while (i < path.length) {
      if (path[i].jump) {
        if (out[out.length - 1] !== path[i - 1]) out.push(path[i - 1]);
        out.push(path[i]);
        anchor = i;
        i++;
        continue;
      }
      // Extend as far as a straight walk remains valid and no jump intervenes.
      let j = i;
      while (j + 1 < path.length && !path[j + 1].jump && this.walkable(path[anchor], path[j + 1]) && this.clearLine(path[anchor].node, path[j + 1].node)) j++;
      out.push(path[j]);
      anchor = j;
      i = j + 1;
    }
    return out;
  }

  /** Keep smoothed lines off walls: every node along the line must keep its clearance. */
  private clearLine(a: number, b: number): boolean {
    const pa = this.pos(a), pb = this.pos(b);
    const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const steps = Math.max(1, Math.ceil(len / (this.g.res * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = pa.x + (pb.x - pa.x) * t, z = pa.z + (pb.z - pa.z) * t;
      const q = this.neighborAt(this.g.cellX(x), this.g.cellZ(z), pa.y + (pb.y - pa.y) * t);
      if (q === NONE) return false;
      if (this.headroom[q] < this.p.standHeight && this.headroom[a] >= this.p.standHeight) return false;
    }
    return true;
  }
}

const EMPTY: number[] = [];
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DK = [0, 0, 1, -1, 1, -1, 1, -1];
export const NAV_NONE = NONE;

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mk = lastKey;
        if (l < n && keys[l] < mk) {
          m = l;
          mk = keys[l];
        }
        if (r < n && keys[r] < mk) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

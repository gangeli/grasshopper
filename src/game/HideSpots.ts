import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { NavGrid, NAV_NONE } from '../world/NavGrid';
import { objectNear, type WorldObject } from '../world/Segmentation';
import type { VoxelGrid } from '../world/VoxelGrid';

/**
 * Hiding-spot search. A candidate spot is any reachable nav node. It is scored
 * by how well it conceals a crouching pet from the seeker now and from the
 * places the seeker is likely to walk to, plus some "personality" terms
 * (cosy spots under/inside things, novelty, a reasonable distance).
 */

export type SpotKind = 'under' | 'inside' | 'behind' | 'atop' | 'corner';

export interface HideSpot {
  node: number;
  pos: Vec3;
  kind: SpotKind;
  object: WorldObject | null;
  /** Fraction of the pet hidden from the seeker's position at hide time. */
  hiddenNow: number;
  /** Fraction of sampled seeker viewpoints the pet is hidden from. */
  coverage: number;
  pathCost: number;
  score: number;
  /** Yaw the pet should face while hiding (towards the open side, to peek). */
  faceYaw: number;
}

export interface HideOptions {
  /** 0 = easy (findable from many places), 1 = hard. */
  difficulty: number;
  maxPathCost: number;
  previous: Vec3[];
  rng: Rng;
  objects: WorldObject[];
  eyeHeight: number;
  /** Body sample offsets of the actual hiding poses (pet facing +Z), see measurePoseSamples. */
  poseSamples?: { hide: Vec3[]; hideLow: Vec3[] };
}

/** Body sample points of a crouched pet standing at `p` (relative offsets). */
export const HIDE_SAMPLES: Vec3[] = [
  { x: 0, y: 0.07, z: 0 },
  { x: 0, y: 0.14, z: 0.03 },
  { x: 0.07, y: 0.07, z: 0 },
  { x: -0.07, y: 0.07, z: 0 },
  { x: 0, y: 0.07, z: 0.07 },
  { x: 0, y: 0.07, z: -0.07 },
  { x: 0, y: 0.19, z: 0 },
];

/** Fraction of `points` with an unobstructed line of sight from `eye`. */
export function visibleFraction(g: VoxelGrid, eye: Vec3, points: Vec3[], skipEnd = 0.04): number {
  let vis = 0;
  for (const q of points) if (g.segmentClear(eye, q, skipEnd)) vis++;
  return vis / points.length;
}

export function samplesAt(p: Vec3, offsets: Vec3[] = HIDE_SAMPLES, yaw = 0): Vec3[] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Rotation about +Y by yaw (pet's +Z forward maps to (sin yaw, 0, cos yaw)).
  return offsets.map((o) => ({ x: p.x + o.x * c + o.z * s, y: p.y + o.y, z: p.z - o.x * s + o.z * c }));
}

/** Spread-out seeker viewpoints on open floor (farthest-point sampling). */
export function seekerViewpoints(nav: NavGrid, eyeHeight: number, count: number, rng: Rng, floorY: number): Vec3[] {
  const open: number[] = [];
  for (let a = 0; a < nav.count; a++) {
    if (Math.abs(nav.ny[a] - floorY) > 0.05) continue;
    if (nav.headroom[a] < 0.45 || nav.wallDist[a] < 0.3) continue;
    if ((nav.ni[a] + nav.nk[a]) % 3 !== 0) continue;
    open.push(a);
  }
  if (!open.length) return [];
  const pts: Vec3[] = [];
  const first = open[rng.int(0, open.length - 1)];
  pts.push(nav.pos(first));
  const dmin = new Float32Array(open.length).fill(Infinity);
  while (pts.length < count) {
    const last = pts[pts.length - 1];
    let best = -1, bd = -1;
    for (let q = 0; q < open.length; q++) {
      const p = nav.pos(open[q]);
      const d = Math.hypot(p.x - last.x, p.z - last.z);
      if (d < dmin[q]) dmin[q] = d;
      if (dmin[q] > bd) {
        bd = dmin[q];
        best = q;
      }
    }
    if (best < 0 || bd < 0.3) break;
    pts.push(nav.pos(open[best]));
  }
  return pts.map((p) => ({ x: p.x, y: p.y + eyeHeight, z: p.z }));
}

export function classifySpot(g: VoxelGrid, nav: NavGrid, a: number, floorY: number): { kind: SpotKind; walls: number; openYaw: number } {
  const p = nav.pos(a);
  const i = nav.ni[a], k = nav.nk[a];
  const j = g.cellY(p.y + 0.001);
  // Overhead cover within ~1.1m.
  let covered = false;
  for (let jj = j + 3; jj < Math.min(g.ny, j + Math.ceil(1.1 / g.res)); jj++)
    if (g.occ(i, jj, k)) {
      covered = true;
      break;
    }
  // Walls around at body height, in 8 directions within 0.3m.
  let walls = 0;
  let ox = 0, oz = 0;
  const R = Math.ceil(0.3 / g.res);
  for (let d = 0; d < 8; d++) {
    const ang = (d / 8) * Math.PI * 2;
    const cx = Math.cos(ang), cz = Math.sin(ang);
    let hit = false;
    for (let s = 1; s <= R && !hit; s++) {
      const ii = Math.round(i + cx * s), kk = Math.round(k + cz * s);
      for (let jj = j + 1; jj <= j + 4; jj++)
        if (g.occ(ii, jj, kk)) {
          hit = true;
          break;
        }
    }
    if (hit) walls++;
    else {
      ox += cx;
      oz += cz;
    }
  }
  // Yaw such that the pet's +Z faces the open direction (atan2(x, z)).
  const openYaw = Math.atan2(ox, oz);
  const elevated = p.y - floorY > 0.25;
  let kind: SpotKind;
  if (walls >= 6) kind = 'inside';
  else if (covered) kind = 'under';
  else if (elevated) kind = 'atop';
  else if (walls >= 3) kind = 'corner';
  else kind = 'behind';
  return { kind, walls, openYaw };
}

export function findHideSpots(nav: NavGrid, petPos: Vec3, seekerEye: Vec3, opts: HideOptions, floorY: number, topN = 5): HideSpot[] {
  const g = nav.g;
  const start = nav.nearest(petPos);
  if (start === NAV_NONE) return [];
  const { cost } = nav.search(start, NAV_NONE, opts.maxPathCost);
  const rng = opts.rng;

  // Stage 1: cheap filter — reachable, hidden from the seeker right now.
  type Cand = { a: number; p: Vec3; hiddenNow: number; pre: number; cls: ReturnType<typeof classifySpot>; pts: Vec3[] };
  const cands: Cand[] = [];
  for (let a = 0; a < nav.count; a++) {
    if (!(cost[a] <= opts.maxPathCost)) continue;
    if ((nav.ni[a] + 2 * nav.nk[a]) % 2 !== 0) continue; // thin out
    const p = nav.pos(a);
    const dSeeker = Math.hypot(p.x - seekerEye.x, p.z - seekerEye.z);
    if (dSeeker < 1.0) continue;
    if (visibleFraction(g, seekerEye, samplesAt(p)) > 0.5) continue; // quick reject
    const cls = classifySpot(g, nav, a, floorY);
    const low = cls.kind === 'under' || cls.kind === 'inside';
    const offs = opts.poseSamples ? (low ? opts.poseSamples.hideLow : opts.poseSamples.hide) : HIDE_SAMPLES;
    const pts = samplesAt(p, offs, cls.openYaw);
    const hiddenNow = 1 - visibleFraction(g, seekerEye, pts);
    if (hiddenNow < 0.85) continue;
    let pre = 0;
    pre += { inside: 1.0, under: 0.8, corner: 0.5, behind: 0.3, atop: 0.4 }[cls.kind];
    pre += Math.min(cls.walls, 5) * 0.05;
    pre -= Math.abs(dSeeker - 2.8) * 0.12;
    cands.push({ a, p, hiddenNow, pre, cls, pts });
  }
  cands.sort((x, y) => y.pre - x.pre);
  const shortlist = cands.slice(0, 300);

  // Stage 2: coverage over likely seeker viewpoints.
  // Standing and crouching viewpoints: a spot only counts as findable from a
  // viewpoint if most of the pet would be visible from there.
  const standing = seekerViewpoints(nav, opts.eyeHeight, 16, new Rng(1234), floorY);
  const views = [...standing, ...standing.filter((_, i) => i % 2 === 0).map((v) => ({ ...v, y: floorY + 0.85 }))];
  // Target coverage: easy → hidden from ~55% of the room, hard → ~90%.
  const target = 0.55 + 0.35 * opts.difficulty;
  const spots: HideSpot[] = shortlist.map((c) => {
    const pts = c.pts;
    let hiddenFrom = 0;
    for (const v of views) if (visibleFraction(g, v, pts) < 0.5) hiddenFrom++;
    const coverage = views.length ? hiddenFrom / views.length : 1;
    let score = c.pre;
    score -= Math.abs(coverage - target) * 2.2;
    // Never pick a spot that literally nobody can see (unfun): penalise full coverage on easy.
    if (coverage > 0.97) score -= 0.6 * (1 - opts.difficulty);
    // Novelty: avoid previous hiding places.
    for (const q of opts.previous) {
      const d = Math.hypot(q.x - c.p.x, q.z - c.p.z);
      if (d < 1.2) score -= (1.2 - d) * 1.2;
    }
    score -= cost[c.a] * 0.03;
    score += rng.range(0, 0.35);
    return {
      node: c.a,
      pos: c.p,
      kind: c.cls.kind,
      object: objectNear(opts.objects, c.p),
      hiddenNow: c.hiddenNow,
      coverage,
      pathCost: cost[c.a],
      score,
      faceYaw: c.cls.openYaw,
    };
  });
  spots.sort((x, y) => y.score - x.score);
  // Return a diverse top list (no two within 0.6m).
  const out: HideSpot[] = [];
  for (const s of spots) {
    if (out.some((o) => Math.hypot(o.pos.x - s.pos.x, o.pos.z - s.pos.z) < 0.6)) continue;
    out.push(s);
    if (out.length >= topN) break;
  }
  return out;
}

export function describeSpot(s: Pick<HideSpot, 'kind' | 'object'>): string {
  const obj = s.object ? s.object.label : null;
  switch (s.kind) {
    case 'under':
      return obj ? `under the ${obj}` : 'under something';
    case 'inside':
      return obj ? `inside the ${obj}` : 'in a cosy nook';
    case 'atop':
      return obj ? `on top of the ${obj}` : 'up high';
    case 'corner':
      return obj ? `tucked beside the ${obj}` : 'in a corner';
    default:
      return obj ? `behind the ${obj}` : 'behind something';
  }
}

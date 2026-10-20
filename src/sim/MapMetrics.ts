import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { NavGrid, type Waypoint } from '../world/NavGrid';
import type { WorldModel } from '../world/WorldModel';
import { OCC_THRESHOLD } from '../world/VoxelGrid';
import type { SimRoom } from './SimRoom';

/**
 * Ground-truth evaluation of mapping and navigation: compares what the world
 * model believes to the simulated room it was built from.
 */
export interface MapReport {
  /** Furniture-only (no walls, < 1.2m): distance from mapped occupied voxel centres to the real surface. */
  surfErrMedian: number;
  surfErrP95: number;
  /** Fraction of furniture-region occupied voxels more than 5cm / 10cm from any real surface. */
  surfErrOver5: number;
  surfErrOver10: number;
  /** Real solid space (6–11cm inside furniture, i.e. voxels wholly inside it; pet height band) that the map believes it SAW empty. */
  falseFree: number;
  /** Real furniture surface in the pet's height band (observed areas) with no mapped obstacle within 5cm. */
  missedLow: number;
  /** Fraction of mapped occupied voxels that are within 1 voxel of real geometry. */
  precision: number;
  /** Fraction of real furniture surface (in mapped area) that the map marks occupied (±1 voxel). */
  recall: number;
  /** Mapped-occupied voxels more than 1 voxel from any real geometry, in the pet's height band. */
  phantomsLow: number;
  /** Nav nodes whose pet body intersects real (thick) furniture, and its max depth. */
  nodesColliding: number;
  nodeMaxPenetration: number;
  /** Nav nodes with nothing real underneath (floating / sunk). */
  nodesUnsupported: number;
  nodeCount: number;
  /** Sampled paths: fraction where the pet body hits thick furniture, and worst penetration. */
  pathsTested: number;
  pathsColliding: number;
  pathMaxPenetration: number;
  /** Fraction of jump landings that land on real support. */
  jumpsTested: number;
  jumpsBadLanding: number;
  /** Walkable area found vs. real reachable floor area (m²). */
  walkableArea: number;
}

/** Pet body as a set of sample points relative to its feet (radius ~8cm, height 3–22cm). */
const BODY: Vec3[] = [];
for (const h of [0.04, 0.12, 0.2])
  for (let a = 0; a < 8; a++) BODY.push({ x: Math.cos((a / 8) * Math.PI * 2) * 0.07, y: h, z: Math.sin((a / 8) * Math.PI * 2) * 0.07 });
BODY.push({ x: 0, y: 0.12, z: 0 });

/** Penetration depth of point p into the room's thick boxes (≥ minThick wide); 0 if outside. */
export function penetration(room: SimRoom, p: Vec3, minThick = 0.045): number {
  let worst = 0;
  for (const b of room.boxes) {
    // Everything the pet would bump into: furniture, legs, toys, glass. Flat
    // things it simply walks over (rugs, cables) don't count.
    if (Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < minThick) continue;
    if (b.max.y - b.min.y < 0.03 && b.min.y < 0.01) continue;
    const d = Math.min(p.x - b.min.x, b.max.x - p.x, p.y - b.min.y, b.max.y - p.y, p.z - b.min.z, b.max.z - p.z);
    if (d > worst) worst = d;
  }
  return worst;
}

export function bodyPenetration(room: SimRoom, at: Vec3): number {
  let w = 0;
  for (const o of BODY) w = Math.max(w, penetration(room, { x: at.x + o.x, y: at.y + o.y, z: at.z + o.z }));
  return w;
}

/** Height of the real support surface under (x,z) closest to y, or null. */
function supportUnder(room: SimRoom, x: number, z: number, y: number): number | null {
  let best: number | null = Math.abs(y) < 0.2 ? 0 : null;
  for (const b of room.boxes) {
    if (x < b.min.x - 0.03 || x > b.max.x + 0.03 || z < b.min.z - 0.03 || z > b.max.z + 0.03) continue;
    if (best === null || Math.abs(b.max.y - y) < Math.abs(best - y)) best = b.max.y;
  }
  return best;
}

export function evaluateMap(world: WorldModel, nav: NavGrid, room: SimRoom, opts: { paths?: number; seed?: number; eyes?: Vec3[] } = {}): MapReport {
  const g = world.grid!;
  const r = g.res;
  const truthSolid = (x: number, y: number, z: number, pad: number) => room.solidAt({ x, y, z }, pad);
  // --- occupancy precision / phantoms -----------------------------------------
  let occ = 0, good = 0, phantomsLow = 0;
  for (let j = world.floorLayer; j < g.ny; j++)
    for (let k = 0; k < g.nz; k++)
      for (let i = 0; i < g.nx; i++) {
        if (g.data[g.idx(i, j, k)] <= OCC_THRESHOLD) continue;
        const x = g.centerX(i), y = g.centerY(j), z = g.centerZ(k);
        if (Math.abs(x) > room.halfW + 0.3 || Math.abs(z) > room.halfD + 0.3) continue;
        occ++;
        if (truthSolid(x, y, z, r * 1.2) || y < r) good++;
        else if (y < world.floorY + 0.3) phantomsLow++;
      }
  // --- recall over furniture surfaces in the observed area -------------------
  let surf = 0, hit = 0;
  const step = r;
  for (const b of room.boxes) {
    if (room.pieces[b.piece].label === 'wall') continue;
    // Top faces and side faces sampled on a grid.
    const faces: [Vec3, Vec3, Vec3][] = [
      [{ x: b.min.x, y: b.max.y, z: b.min.z }, { x: b.max.x - b.min.x, y: 0, z: 0 }, { x: 0, y: 0, z: b.max.z - b.min.z }],
      [{ x: b.min.x, y: b.min.y, z: b.min.z }, { x: b.max.x - b.min.x, y: 0, z: 0 }, { x: 0, y: b.max.y - b.min.y, z: 0 }],
      [{ x: b.min.x, y: b.min.y, z: b.max.z }, { x: b.max.x - b.min.x, y: 0, z: 0 }, { x: 0, y: b.max.y - b.min.y, z: 0 }],
      [{ x: b.min.x, y: b.min.y, z: b.min.z }, { x: 0, y: 0, z: b.max.z - b.min.z }, { x: 0, y: b.max.y - b.min.y, z: 0 }],
      [{ x: b.max.x, y: b.min.y, z: b.min.z }, { x: 0, y: 0, z: b.max.z - b.min.z }, { x: 0, y: b.max.y - b.min.y, z: 0 }],
    ];
    for (const [o, u, v] of faces) {
      const nu = Math.max(1, Math.round(Math.hypot(u.x, u.y, u.z) / step)), nv = Math.max(1, Math.round(Math.hypot(v.x, v.y, v.z) / step));
      for (let a = 0; a < nu; a++)
        for (let c = 0; c < nv; c++) {
          const p = { x: o.x + (u.x * (a + 0.5)) / nu + (v.x * (c + 0.5)) / nv, y: o.y + (u.y * (a + 0.5)) / nu + (v.y * (c + 0.5)) / nv, z: o.z + (u.z * (a + 0.5)) / nu + (v.z * (c + 0.5)) / nv };
          // Skip faces buried inside other geometry (e.g. against a wall).
          if (truthSolid(p.x, p.y, p.z, -0.01)) continue;
          if (p.y < 0.02) continue;
          if (!g.isObserved(g.cellX(p.x), g.cellZ(p.z)) && !anyOcc(g, p, 1)) continue;
          surf++;
          if (anyOcc(g, p, 1)) hit++;
        }
    }
  }
  // --- nav nodes ----------------------------------------------------------------
  let nodesColliding = 0, nodeMaxPen = 0, unsupported = 0;
  for (let a = 0; a < nav.count; a++) {
    const p = nav.pos(a);
    const pen = bodyPenetration(room, p);
    if (pen > 0.02) nodesColliding++;
    nodeMaxPen = Math.max(nodeMaxPen, pen);
    const s = supportUnder(room, p.x, p.z, p.y);
    if (s === null || Math.abs(s - p.y) > 0.06) unsupported++;
  }
  // --- paths ------------------------------------------------------------------------
  const rng = new Rng(opts.seed ?? 3);
  const nPaths = opts.paths ?? 120;
  let tested = 0, colliding = 0, pathMax = 0, jumps = 0, badLand = 0;
  for (let q = 0; q < nPaths * 3 && tested < nPaths; q++) {
    const a = rng.int(0, nav.count - 1), b = rng.int(0, nav.count - 1);
    const path = nav.pathBetween(a, b);
    if (!path || path.length < 2) continue;
    tested++;
    const pen = pathPenetration(room, path);
    if (pen > 0.02) colliding++;
    pathMax = Math.max(pathMax, pen);
    for (const w of path)
      if (w.jump) {
        jumps++;
        const s = supportUnder(room, w.x, w.z, w.y);
        if (s === null || Math.abs(s - w.y) > 0.06) badLand++;
      }
  }
  // --- honest furniture-only metrics --------------------------------------------------
  const errs: number[] = [];
  const nearWall = (x: number, z: number) => Math.abs(x) > room.halfW - 0.15 || Math.abs(z) > room.halfD - 0.15;
  for (let j = world.floorLayer + 1; j < g.ny; j++) {
    const y = g.centerY(j);
    if (y > world.floorY + 1.2) break;
    for (let k = 0; k < g.nz; k++)
      for (let i = 0; i < g.nx; i++) {
        if (g.data[g.idx(i, j, k)] <= OCC_THRESHOLD) continue;
        const x = g.centerX(i), z = g.centerZ(k);
        if (nearWall(x, z) || Math.abs(x) > room.halfW || Math.abs(z) > room.halfD) continue;
        errs.push(surfaceDistance(room, { x, y, z }));
      }
  }
  errs.sort((a, b) => a - b);
  const pct = (q: number) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(q * errs.length))] : 0);
  // Inside-surface shell samples (3–8cm inside furniture, 3–25cm above floor).
  let shell = 0, shellFree = 0, low = 0, lowMissed = 0;
  for (const b of room.boxes) {
    if (room.pieces[b.piece].label === 'wall') continue;
    const w = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
    for (let y = Math.max(b.min.y, 0.03) + 0.02; y < Math.min(b.max.y, 0.25); y += 0.04)
      for (let x = b.min.x; x <= b.max.x + 1e-6; x += 0.04)
        for (let z = b.min.z; z <= b.max.z + 1e-6; z += 0.04) {
          const edge = Math.min(x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z);
          const pin = { x, y, z };
          if (!g.isObserved(g.cellX(x), g.cellZ(z)) && !g.isObserved(g.cellX(x + 0.1), g.cellZ(z)) && !g.isObserved(g.cellX(x - 0.1), g.cellZ(z))) continue;
          if (w >= 0.16 && edge > 0.06 && edge < 0.11) {
            shell++;
            if (g.data[g.idx(g.cellX(x), g.cellY(y), g.cellZ(z))] < -2) shellFree++;
          }
          if (edge < 0.005 && opts.eyes && visibleFromAny(room, b, pin, opts.eyes)) {
            low++;
            if (!anyOcc(g, pin, 1)) lowMissed++;
          }
        }
  }
  return {
    surfErrMedian: pct(0.5),
    surfErrP95: pct(0.95),
    surfErrOver5: errs.length ? errs.filter((e) => e > 0.05).length / errs.length : 0,
    surfErrOver10: errs.length ? errs.filter((e) => e > 0.1).length / errs.length : 0,
    falseFree: shell ? shellFree / shell : 0,
    missedLow: low ? lowMissed / low : 0,
    precision: occ ? good / occ : 1,
    recall: surf ? hit / surf : 1,
    phantomsLow,
    nodesColliding,
    nodeMaxPenetration: nodeMaxPen,
    nodesUnsupported: unsupported,
    nodeCount: nav.count,
    pathsTested: tested,
    pathsColliding: colliding,
    pathMaxPenetration: pathMax,
    jumpsTested: jumps,
    jumpsBadLanding: badLand,
    walkableArea: nav.count * r * r,
  };
}

function anyOcc(g: NonNullable<WorldModel['grid']>, p: Vec3, rad: number): boolean {
  const ci = g.cellX(p.x), cj = g.cellY(p.y), ck = g.cellZ(p.z);
  for (let dj = -rad; dj <= rad; dj++) for (let dk = -rad; dk <= rad; dk++) for (let di = -rad; di <= rad; di++) if (g.occ(ci + di, cj + dj, ck + dk)) return true;
  return false;
}

/** Worst body penetration along a path, walking segments and jump arcs. */
export function pathPenetration(room: SimRoom, path: Waypoint[]): number {
  let worst = 0;
  for (let s = 1; s < path.length; s++) {
    const a = path[s - 1], b = path[s];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(2, Math.ceil(len / 0.03));
    for (let t = 0; t <= n; t++) {
      const u = t / n;
      const p = b.jump ? NavGrid.arcPoint(a, b, u, undefined, b.lift) : { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
      // During a jump the body is compact (tucked); check the core only.
      worst = Math.max(worst, b.jump ? penetration(room, { x: p.x, y: p.y + 0.12, z: p.z }) : bodyPenetration(room, p));
    }
  }
  return worst;
}

/** Distance from p to the nearest real surface (box faces or the floor). */
export function surfaceDistance(room: SimRoom, p: Vec3): number {
  let best = Math.abs(p.y);
  for (const b of room.boxes) {
    const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
    const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
    const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
    let d = Math.hypot(dx, dy, dz);
    if (d === 0) d = Math.min(p.x - b.min.x, b.max.x - p.x, p.y - b.min.y, b.max.y - p.y, p.z - b.min.z, b.max.z - p.z);
    if (d < best) best = d;
  }
  return best;
}

/** A face sample is "seeable" if some eye has line of sight to a point 2cm outside the face. */
function visibleFromAny(room: SimRoom, b: { min: Vec3; max: Vec3 }, p: Vec3, eyes: Vec3[]): boolean {
  const out = { ...p };
  if (Math.abs(p.x - b.min.x) < 0.006) out.x -= 0.02;
  else if (Math.abs(p.x - b.max.x) < 0.006) out.x += 0.02;
  else if (Math.abs(p.z - b.min.z) < 0.006) out.z -= 0.02;
  else out.z += 0.02;
  if (room.solidAt(out)) return false;
  return eyes.some((e) => room.visible(e, out));
}

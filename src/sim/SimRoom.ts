import { BoxBVH } from './BoxBVH';
import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';

/**
 * Procedural rooms made of axis-aligned boxes. They stand in for the real
 * world in tests and in the in-browser simulator: SimSensor raycasts them to
 * produce depth, planes and meshes the way a headset/phone would.
 */
/**
 * How a surface looks to a depth sensor. Depth-from-motion (ARCore) needs
 * texture: blank walls and dark fabric give holes and noise; glass is
 * invisible; mirrors show a phantom room behind them.
 */
export type Material = 'matte' | 'textureless' | 'dark' | 'glass' | 'mirror';

export interface SimBox {
  min: Vec3;
  max: Vec3;
  color: number;
  /** Owning furniture piece. */
  piece: number;
  material?: Material;
}

/** Something that moves through the room (a person walking past). */
export interface DynamicBox {
  size: Vec3;
  /** Feet position at time t, or null when not in the room. */
  at: (t: number) => Vec3 | null;
}

export interface SimPiece {
  id: number;
  label: string;
  boxes: SimBox[];
  /** Footprint bounds (for placement and test expectations). */
  min: Vec3;
  max: Vec3;
}

export class SimRoom {
  readonly pieces: SimPiece[] = [];
  readonly boxes: SimBox[] = [];
  readonly dynamic: DynamicBox[] = [];
  /** Simulation time (s), for dynamic objects. */
  time = 0;
  /** Material of the floor (blank floors are hard for depth-from-motion). */
  floorMaterial: Material = 'matte';
  /**
   * Multi-room homes: the floor of each room as its own rectangle, so plane
   * detection finds them one by one (as a phone does) instead of the whole
   * home's floor at the first glance. Null for single rooms.
   */
  floorRects: { x0: number; z0: number; x1: number; z1: number }[] | null = null;
  constructor(readonly width: number, readonly depth: number, readonly wallHeight = 2.4) {}

  private bvhCache: BoxBVH | null = null;
  /** Acceleration structure over `boxes` (rebuilt when pieces are added). */
  get bvh(): BoxBVH {
    if (!this.bvhCache || this.bvhCache.boxes.length !== this.boxes.length) this.bvhCache = new BoxBVH(this.boxes.slice());
    return this.bvhCache;
  }
  private static readonly isGlass = (b: SimBox) => b.material === 'glass';

  /** Room spans x ∈ [-w/2, w/2], z ∈ [-d/2, d/2], floor at y=0. */
  get halfW() {
    return this.width / 2;
  }
  get halfD() {
    return this.depth / 2;
  }

  addPiece(label: string, boxes: Omit<SimBox, 'piece'>[]): SimPiece {
    const id = this.pieces.length;
    const bs = boxes.map((b) => ({ ...b, piece: id }));
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of bs) {
      min.x = Math.min(min.x, b.min.x);
      min.y = Math.min(min.y, b.min.y);
      min.z = Math.min(min.z, b.min.z);
      max.x = Math.max(max.x, b.max.x);
      max.y = Math.max(max.y, b.max.y);
      max.z = Math.max(max.z, b.max.z);
    }
    const piece = { id, label, boxes: bs, min, max };
    this.pieces.push(piece);
    this.boxes.push(...bs);
    return piece;
  }

  /** Ray vs all boxes. Returns distance or Infinity. */
  raycast(o: Vec3, d: Vec3, maxDist = 20): { t: number; box: SimBox | null; normal: Vec3 } {
    let best = maxDist;
    let hitBox: SimBox | null = null;
    let normal: Vec3 = { x: 0, y: 1, z: 0 };
    // Floor plane.
    if (d.y < -1e-6) {
      const t = -o.y / d.y;
      if (t > 0 && t < best) {
        best = t;
        normal = { x: 0, y: 1, z: 0 };
      }
    }
    const bvh = this.bvh;
    if (bvh.nearest(o.x, o.y, o.z, d.x, d.y, d.z, best, -1)) {
      best = bvh.t;
      hitBox = bvh.hit;
      normal = axisNormal(bvh.axis, bvh.sign);
    }
    return { t: best >= maxDist ? Infinity : best, box: hitBox, normal };
  }

  /**
   * What a depth sensor ray actually returns: glass is skipped, mirrors
   * reflect (the reading lands behind the mirror), people walking by are
   * included. `range` is the apparent distance along the original ray.
   */
  sensorRay(o: Vec3, d: Vec3, maxDist = 20): { range: number; material: Material } {
    let origin = o, dir = d, travelled = 0;
    for (let bounce = 0; bounce < 3; bounce++) {
      let best = maxDist - travelled;
      let mat: Material = this.floorMaterial;
      let normal: Vec3 | null = null;
      if (dir.y < -1e-6) {
        const t = -origin.y / dir.y;
        if (t > 1e-4 && t < best) best = t;
      }
      const bvh = this.bvh;
      if (bvh.nearest(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, best, 1e-4, SimRoom.isGlass)) {
        best = bvh.t;
        mat = bvh.hit!.material ?? 'matte';
        normal = axisNormal(bvh.axis, bvh.sign);
      }
      for (const dyn of this.dynamic) {
        const f = dyn.at(this.time);
        if (!f) continue;
        const mn = { x: f.x - dyn.size.x / 2, y: f.y, z: f.z - dyn.size.z / 2 }, mx = { x: f.x + dyn.size.x / 2, y: f.y + dyn.size.y, z: f.z + dyn.size.z / 2 };
        const r = rayBox(origin, dir, mn, mx);
        if (r && r.t > 1e-4 && r.t < best) {
          best = r.t;
          mat = 'dark';
          normal = r.normal;
        }
      }
      if (best >= maxDist - travelled) return { range: Infinity, material: mat };
      if (mat === 'mirror' && normal) {
        travelled += best;
        origin = { x: origin.x + dir.x * best, y: origin.y + dir.y * best, z: origin.z + dir.z * best };
        const dn = dir.x * normal.x + dir.y * normal.y + dir.z * normal.z;
        dir = { x: dir.x - 2 * dn * normal.x, y: dir.y - 2 * dn * normal.y, z: dir.z - 2 * dn * normal.z };
        continue;
      }
      return { range: travelled + best, material: mat };
    }
    return { range: Infinity, material: 'matte' };
  }

  /** Is the point inside any solid box? */
  solidAt(p: Vec3, pad = 0): boolean {
    if (p.y < 0) return true;
    for (const b of this.boxes)
      if (p.x > b.min.x - pad && p.x < b.max.x + pad && p.y > b.min.y - pad && p.y < b.max.y + pad && p.z > b.min.z - pad && p.z < b.max.z + pad) return true;
    return false;
  }

  /** Line of sight between two points (true if unobstructed). */
  /** Line of sight for eyes (glass is see-through; mirrors and everything else block). */
  visible(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    const d = { x: dx / len, y: dy / len, z: dz / len };
    if (d.y < -1e-6 && -a.y / d.y < len - 1e-3 && -a.y / d.y > 0) return false; // floor
    return !this.bvh.nearest(a.x, a.y, a.z, d.x, d.y, d.z, len - 1e-3, -1, SimRoom.isGlass);
  }

  pieceAt(p: Vec3, pad = 0.05): SimPiece | null {
    for (const pc of this.pieces) {
      if (pc.label === 'wall') continue;
      if (p.x > pc.min.x - pad && p.x < pc.max.x + pad && p.z > pc.min.z - pad && p.z < pc.max.z + pad) return pc;
    }
    return null;
  }
}

export function axisNormal(axis: number, sign: number): Vec3 {
  return { x: axis === 0 ? sign : 0, y: axis === 1 ? sign : 0, z: axis === 2 ? sign : 0 };
}

export function rayBox(o: Vec3, d: Vec3, mn: Vec3, mx: Vec3): { t: number; normal: Vec3 } | null {
  let tmin = -Infinity, tmax = Infinity;
  let axis = 0, sign = 0;
  const os = [o.x, o.y, o.z], ds = [d.x, d.y, d.z], mins = [mn.x, mn.y, mn.z], maxs = [mx.x, mx.y, mx.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-12) {
      if (os[a] < mins[a] || os[a] > maxs[a]) return null;
      continue;
    }
    let t1 = (mins[a] - os[a]) / ds[a], t2 = (maxs[a] - os[a]) / ds[a];
    let s = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = a;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  if (tmin < 0) return null; // inside the box: ignore
  const normal = { x: 0, y: 0, z: 0 };
  if (axis === 0) normal.x = sign;
  else if (axis === 1) normal.y = sign;
  else normal.z = sign;
  return { t: tmin, normal };
}

// ---------------------------------------------------------------------------
// Furniture builders. Each takes a footprint anchor (min x/z corner) and size.

type B = Omit<SimBox, 'piece'>;
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): B => ({
  min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
  max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
  color,
});

export const Furniture = {
  table(x: number, z: number, w: number, d: number, h = 0.74, color = 0x9a6b44): B[] {
    const t = 0.04, l = 0.05;
    return [
      box(x, h - t, z, x + w, h, z + d, color),
      box(x, 0, z, x + l, h - t, z + l, color),
      box(x + w - l, 0, z, x + w, h - t, z + l, color),
      box(x, 0, z + d - l, x + l, h - t, z + d, color),
      box(x + w - l, 0, z + d - l, x + w, h - t, z + d, color),
    ];
  },
  /** Couch with its back along the -z side (rotated with `facing`). */
  couch(x: number, z: number, w: number, d: number, facing: 'z+' | 'z-' | 'x+' | 'x-', gap = 0.16, color = 0x4f6d8f): B[] {
    const seatH = 0.44, backH = 0.85, armH = 0.6, back = 0.22, arm = 0.18;
    const parts: B[] = [];
    // Local frame: width along u, depth along v (v=0 at back).
    const mk = (u0: number, y0: number, v0: number, u1: number, y1: number, v1: number) => {
      switch (facing) {
        case 'z+':
          return box(x + u0, y0, z + v0, x + u1, y1, z + v1, color);
        case 'z-':
          return box(x + u0, y0, z + d - v0, x + u1, y1, z + d - v1, color);
        case 'x+':
          return box(x + v0, y0, z + u0, x + v1, y1, z + u1, color);
        case 'x-':
          return box(x + w - v0, y0, z + u0, x + w - v1, y1, z + u1, color);
      }
    };
    const W = facing === 'x+' || facing === 'x-' ? d : w;
    const D = facing === 'x+' || facing === 'x-' ? w : d;
    // Feet so there's a gap underneath.
    const f = 0.06;
    for (const [u, v] of [
      [0, 0],
      [W - f, 0],
      [0, D - f],
      [W - f, D - f],
    ])
      parts.push(mk(u, 0, v, u + f, gap, v + f));
    parts.push(mk(0, gap, 0, W, seatH, D)); // seat block
    parts.push(mk(0, seatH, 0, W, backH, back)); // back
    parts.push(mk(0, seatH, back, arm, armH, D)); // arm L
    parts.push(mk(W - arm, seatH, back, W, armH, D)); // arm R
    return parts;
  },
  chair(x: number, z: number, s = 0.45, color = 0x7a5534): B[] {
    const seat = 0.45, l = 0.04;
    return [
      box(x, seat - 0.04, z, x + s, seat, z + s, color),
      box(x, 0, z, x + l, seat - 0.04, z + l, color),
      box(x + s - l, 0, z, x + s, seat - 0.04, z + l, color),
      box(x, 0, z + s - l, x + l, seat - 0.04, z + s, color),
      box(x + s - l, 0, z + s - l, x + s, seat - 0.04, z + s, color),
      box(x, seat, z, x + s, 0.92, z + 0.04, color),
    ];
  },
  bookshelf(x: number, z: number, w: number, d: number, h = 1.8, color = 0xd8c3a5): B[] {
    return [box(x, 0, z, x + w, h, z + d, color)];
  },
  /** Open-top container the pet can jump into. */
  basket(x: number, z: number, w = 0.55, d = 0.5, h = 0.32, color = 0xc9a26b): B[] {
    const t = 0.025;
    return [
      box(x, 0, z, x + w, 0.03, z + d, color),
      box(x, 0, z, x + t, h, z + d, color),
      box(x + w - t, 0, z, x + w, h, z + d, color),
      box(x, 0, z, x + w, h, z + t, color),
      box(x, 0, z + d - t, x + w, h, z + d, color),
    ];
  },
  bed(x: number, z: number, w = 1.5, d = 2.0, color = 0xe6e0f0): B[] {
    const gap = 0.24, top = 0.55, l = 0.08;
    return [
      box(x, gap, z, x + w, top, z + d, color),
      box(x, 0, z, x + l, gap, z + l, 0x6b4a33),
      box(x + w - l, 0, z, x + w, gap, z + l, 0x6b4a33),
      box(x, 0, z + d - l, x + l, gap, z + d, 0x6b4a33),
      box(x + w - l, 0, z + d - l, x + w, gap, z + d, 0x6b4a33),
      box(x, 0, z, x + w, 1.0, z + 0.06, 0x6b4a33), // headboard
    ];
  },
  plant(x: number, z: number, r = 0.18, color = 0x3f7a3a): B[] {
    return [box(x, 0, z, x + r * 2, 0.35, z + r * 2, 0xa0522d), box(x - 0.08, 0.35, z - 0.08, x + r * 2 + 0.08, 1.0, z + r * 2 + 0.08, color)];
  },
  crate(x: number, z: number, w = 0.45, d = 0.45, h = 0.45, color = 0xb58b5a): B[] {
    return [box(x, 0, z, x + w, h, z + d, color)];
  },
};

function addWalls(room: SimRoom) {
  const t = 0.1, h = room.wallHeight, W = room.halfW, D = room.halfD, c = 0xeeeae2;
  room.addPiece('wall', [box(-W - t, 0, -D - t, W + t, h, -D, c)]);
  room.addPiece('wall', [box(-W - t, 0, D, W + t, h, D + t, c)]);
  room.addPiece('wall', [box(-W - t, 0, -D, -W, h, D, c)]);
  room.addPiece('wall', [box(W, 0, -D, W + t, h, D, c)]);
}

/** A hand-built living room used by many tests (player starts near the origin). */
export function livingRoom(): SimRoom {
  const room = new SimRoom(6, 5);
  addWalls(room);
  room.addPiece('couch', Furniture.couch(-2.2, -2.45, 2.0, 0.9, 'z+'));
  room.addPiece('table', Furniture.table(1.2, -2.1, 1.3, 0.8));
  room.addPiece('chair', Furniture.chair(1.6, -1.15));
  room.addPiece('table', Furniture.table(-1.6, -1.1, 1.0, 0.55, 0.45, 0x6b4a33)); // coffee table
  room.addPiece('bookshelf', Furniture.bookshelf(2.55, 0.2, 0.4, 1.2));
  room.addPiece('basket', Furniture.basket(2.3, 1.7));
  room.addPiece('plant', Furniture.plant(-2.7, 1.9));
  room.addPiece('crate', Furniture.crate(-1.0, 1.6));
  return room;
}

/** An empty room of the given size (walls only). */
export function openRoom(width: number, depth: number): SimRoom {
  const room = new SimRoom(width, depth);
  addWalls(room);
  return room;
}

export function emptyRoom(): SimRoom {
  const room = new SimRoom(4, 4);
  addWalls(room);
  return room;
}

export function bedroom(): SimRoom {
  const room = new SimRoom(4.5, 4.2);
  addWalls(room);
  room.addPiece('bed', Furniture.bed(-2.2, -2.04));
  room.addPiece('table', Furniture.table(1.2, -2.05, 1.0, 0.6, 0.76, 0xffffff)); // desk
  room.addPiece('chair', Furniture.chair(1.45, -1.35));
  room.addPiece('basket', Furniture.basket(1.5, 1.4));
  room.addPiece('bookshelf', Furniture.bookshelf(-0.4, 1.75, 1.0, 0.35));
  return room;
}

/** Random furnished room; furniture is placed without overlap and away from the start area. */
export function randomRoom(seed: number): SimRoom {
  const rng = new Rng(seed);
  const room = new SimRoom(rng.range(4, 7), rng.range(3.5, 6));
  addWalls(room);
  const W = room.halfW, D = room.halfD;
  const placed: { x0: number; z0: number; x1: number; z1: number }[] = [{ x0: -0.7, z0: -0.7, x1: 0.7, z1: 0.7 }];
  const tryPlace = (w: number, d: number, againstWall: boolean, build: (x: number, z: number) => [string, B[]]) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      let x: number, z: number;
      if (againstWall) {
        const side = rng.int(0, 3);
        x = side < 2 ? rng.range(-W + 0.05, W - w - 0.05) : side === 2 ? -W + 0.02 : W - w - 0.02;
        z = side >= 2 ? rng.range(-D + 0.05, D - d - 0.05) : side === 0 ? -D + 0.02 : D - d - 0.02;
      } else {
        x = rng.range(-W + 0.4, W - w - 0.4);
        z = rng.range(-D + 0.4, D - d - 0.4);
      }
      const r = { x0: x - 0.35, z0: z - 0.35, x1: x + w + 0.35, z1: z + d + 0.35 };
      if (placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.z0 < p.z1 && r.z1 > p.z0)) continue;
      if (x < -W || z < -D || x + w > W || z + d > D) continue;
      placed.push({ x0: x, z0: z, x1: x + w, z1: z + d });
      const [label, boxes] = build(x, z);
      room.addPiece(label, boxes);
      return true;
    }
    return false;
  };
  const n = rng.int(4, 8);
  const kinds = ['table', 'couch', 'chair', 'bookshelf', 'basket', 'plant', 'crate', 'bed', 'coffee'];
  for (let q = 0; q < n; q++) {
    const kind = rng.pick(kinds);
    switch (kind) {
      case 'table': {
        const w = rng.range(0.9, 1.6), d = rng.range(0.6, 0.9);
        tryPlace(w, d, false, (x, z) => ['table', Furniture.table(x, z, w, d)]);
        break;
      }
      case 'coffee': {
        const w = rng.range(0.8, 1.2), d = rng.range(0.5, 0.7);
        tryPlace(w, d, false, (x, z) => ['table', Furniture.table(x, z, w, d, 0.45, 0x6b4a33)]);
        break;
      }
      case 'couch': {
        const facing = rng.pick(['z+', 'z-', 'x+', 'x-'] as const);
        const w = facing[0] === 'z' ? rng.range(1.6, 2.2) : 0.9, d = facing[0] === 'z' ? 0.9 : rng.range(1.6, 2.2);
        tryPlace(w, d, true, (x, z) => ['couch', Furniture.couch(x, z, w, d, facing, rng.pick([0.05, 0.16]))]);
        break;
      }
      case 'chair':
        tryPlace(0.45, 0.45, false, (x, z) => ['chair', Furniture.chair(x, z)]);
        break;
      case 'bookshelf': {
        const w = rng.range(0.6, 1.2), d = 0.35;
        tryPlace(w, d, true, (x, z) => ['bookshelf', Furniture.bookshelf(x, z, w, d)]);
        break;
      }
      case 'basket':
        tryPlace(0.55, 0.5, rng.chance(0.5), (x, z) => ['basket', Furniture.basket(x, z)]);
        break;
      case 'plant':
        tryPlace(0.36, 0.36, rng.chance(0.7), (x, z) => ['plant', Furniture.plant(x, z)]);
        break;
      case 'crate':
        tryPlace(0.45, 0.45, false, (x, z) => ['crate', Furniture.crate(x, z, 0.45, 0.45, rng.range(0.35, 0.6))]);
        break;
      case 'bed':
        tryPlace(1.5, 2.0, true, (x, z) => ['bed', Furniture.bed(x, z)]);
        break;
    }
  }
  return room;
}

export const NAMED_ROOMS: Record<string, () => SimRoom> = {
  living: livingRoom,
  bedroom,
  empty: emptyRoom,
};

export function roomFromName(name: string): SimRoom {
  if (NAMED_ROOMS[name]) return NAMED_ROOMS[name]();
  const seed = parseInt(name.replace(/\D/g, ''), 10);
  return randomRoom(Number.isFinite(seed) ? seed : 1);
}

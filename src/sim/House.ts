import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import { Furniture, SimRoom, type SimBox } from './SimRoom';
import { dressRoom } from './Realism';

/**
 * Multi-room homes for large-area mapping tests: an outer shell split into
 * rooms (and sometimes a corridor) by interior walls with doorways, every
 * room furnished according to what it is. The result is an ordinary SimRoom
 * (walls are 'wall' pieces), plus the room layout for metrics and walkers.
 */
export interface HouseRoom {
  id: number;
  kind: 'living' | 'bedroom' | 'kitchen' | 'bath' | 'hall' | 'study';
  min: { x: number; z: number };
  max: { x: number; z: number };
}

export interface Doorway {
  /** Centre of the opening. */
  x: number;
  z: number;
  /** The wall runs along this axis ('x': a wall of constant z). */
  along: 'x' | 'z';
  width: number;
  /** Rooms on either side. */
  a: number;
  b: number;
}

export interface House {
  room: SimRoom;
  rooms: HouseRoom[];
  doors: Doorway[];
  /** Where the player starts (floor level). */
  start: Vec3;
  width: number;
  depth: number;
}

type B = Omit<SimBox, 'piece'>;
const WALL_T = 0.1, WALL_H = 2.4, DOOR_H = 2.05;
const WALL_C = 0xeeeae2;

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * A home of about `width` × `depth` metres. Rooms come from recursive
 * splits; each split wall gets a doorway (connecting both sides) and long
 * ones sometimes a second (so there are loops).
 */
export function generateHouse(seed: number, width = 10, depth = 12, opts: { corridor?: boolean; dress?: boolean } = {}): House {
  const rng = new Rng(seed * 977 + 31);
  const room = new SimRoom(width, depth, WALL_H);
  const W = width / 2, D = depth / 2;
  // Outer walls.
  const t = WALL_T;
  room.addPiece('wall', [box(-W - t, 0, -D - t, W + t, WALL_H, -D, WALL_C)]);
  room.addPiece('wall', [box(-W - t, 0, D, W + t, WALL_H, D + t, WALL_C)]);
  room.addPiece('wall', [box(-W - t, 0, -D, -W, WALL_H, D, WALL_C)]);
  room.addPiece('wall', [box(W, 0, -D, W + t, WALL_H, D, WALL_C)]);

  const leaves: Rect[] = [];
  const walls: { r: Rect; axis: 'x' | 'z'; at: number; from: number; to: number }[] = [];
  const minRoom = 2.6;
  const split = (r: Rect, depthLevel: number) => {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const area = w * d;
    const wantSplit = depthLevel < 1 || (area > 24 && rng.chance(0.75)) || area > 40;
    if (!wantSplit || (w < 2 * minRoom && d < 2 * minRoom)) return void leaves.push(r);
    // Split across the longer side.
    const acrossX = w >= d ? true : false; // true: a wall of constant x
    const len = acrossX ? w : d;
    if (len < 2 * minRoom) return void leaves.push(r);
    const corridor = opts.corridor !== false && depthLevel === 0 && len > 2 * minRoom + 1.3 && rng.chance(0.6);
    const at = (acrossX ? r.x0 : r.z0) + rng.range(minRoom, len - minRoom - (corridor ? 1.3 : 0));
    if (corridor) {
      // A 1.2m corridor between two halves.
      const at2 = at + 1.25;
      if (acrossX) {
        walls.push({ r, axis: 'z', at, from: r.z0, to: r.z1 }, { r, axis: 'z', at: at2, from: r.z0, to: r.z1 });
        split({ x0: r.x0, z0: r.z0, x1: at, z1: r.z1 }, depthLevel + 1);
        leaves.push({ x0: at, z0: r.z0, x1: at2, z1: r.z1 });
        split({ x0: at2, z0: r.z0, x1: r.x1, z1: r.z1 }, depthLevel + 1);
      } else {
        walls.push({ r, axis: 'x', at, from: r.x0, to: r.x1 }, { r, axis: 'x', at: at2, from: r.x0, to: r.x1 });
        split({ x0: r.x0, z0: r.z0, x1: r.x1, z1: at }, depthLevel + 1);
        leaves.push({ x0: r.x0, z0: at, x1: r.x1, z1: at2 });
        split({ x0: r.x0, z0: at2, x1: r.x1, z1: r.z1 }, depthLevel + 1);
      }
      return;
    }
    if (acrossX) {
      walls.push({ r, axis: 'z', at, from: r.z0, to: r.z1 });
      split({ x0: r.x0, z0: r.z0, x1: at, z1: r.z1 }, depthLevel + 1);
      split({ x0: at, z0: r.z0, x1: r.x1, z1: r.z1 }, depthLevel + 1);
    } else {
      walls.push({ r, axis: 'x', at, from: r.x0, to: r.x1 });
      split({ x0: r.x0, z0: r.z0, x1: r.x1, z1: at }, depthLevel + 1);
      split({ x0: r.x0, z0: at, x1: r.x1, z1: r.z1 }, depthLevel + 1);
    }
  };
  split({ x0: -W, z0: -D, x1: W, z1: D }, 0);

  const rooms: HouseRoom[] = leaves.map((r, id) => ({ id, kind: 'study', min: { x: r.x0, z: r.z0 }, max: { x: r.x1, z: r.z1 } }));
  const roomAt = (x: number, z: number) => rooms.findIndex((q) => x > q.min.x && x < q.max.x && z > q.min.z && z < q.max.z);
  const doors: Doorway[] = [];
  // Walls with doorways. A wall along a split line borders several leaves on
  // each side: cut it into the stretches between pairs of facing rooms and
  // put a door into each stretch that connects two rooms not yet connected
  // (plus some extra ones for loops).
  const parent = rooms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const wl of walls) {
    // Stretches: boundaries where the room on either side changes.
    const cuts = new Set<number>([wl.from, wl.to]);
    for (const q of rooms) {
      const [lo, hi] = wl.axis === 'z' ? [q.min.z, q.max.z] : [q.min.x, q.max.x];
      const [n0, n1] = wl.axis === 'z' ? [q.min.x, q.max.x] : [q.min.z, q.max.z];
      if (Math.abs(n0 - wl.at) < 1e-6 || Math.abs(n1 - wl.at) < 1e-6) {
        if (lo > wl.from && lo < wl.to) cuts.add(lo);
        if (hi > wl.from && hi < wl.to) cuts.add(hi);
      }
    }
    const cs = [...cuts].sort((a, b) => a - b);
    const openings: [number, number][] = [];
    for (let s = 0; s + 1 < cs.length; s++) {
      const a = cs[s], b = cs[s + 1];
      if (b - a < 1.3) continue;
      const mid = (a + b) / 2;
      const ra = wl.axis === 'z' ? roomAt(wl.at - 0.2, mid) : roomAt(mid, wl.at - 0.2);
      const rb = wl.axis === 'z' ? roomAt(wl.at + 0.2, mid) : roomAt(mid, wl.at + 0.2);
      if (ra < 0 || rb < 0) continue;
      const joins = find(ra) !== find(rb);
      if (!joins && !rng.chance(0.35)) continue;
      parent[find(ra)] = find(rb);
      const dw = rng.range(0.85, 1.0);
      const c = rng.range(a + 0.25 + dw / 2, b - 0.25 - dw / 2);
      openings.push([c - dw / 2, c + dw / 2]);
      doors.push(wl.axis === 'z' ? { x: wl.at, z: c, along: 'z', width: dw, a: ra, b: rb } : { x: c, z: wl.at, along: 'x', width: dw, a: ra, b: rb });
    }
    // Wall segments between the openings, a lintel above each.
    openings.sort((p, q) => p[0] - q[0]);
    let from = wl.from;
    const seg = (a: number, b: number, y0: number, y1: number) => {
      if (b - a < 1e-3) return;
      room.addPiece('wall', [wl.axis === 'z' ? box(wl.at - t / 2, y0, a, wl.at + t / 2, y1, b, WALL_C) : box(a, y0, wl.at - t / 2, b, y1, wl.at + t / 2, WALL_C)]);
    };
    for (const [a, b] of openings) {
      seg(from, a, 0, WALL_H);
      seg(a, b, DOOR_H, WALL_H);
      from = b;
    }
    seg(from, wl.to, 0, WALL_H);
  }

  // What each room is: the biggest is the living room, corridors are halls.
  const byArea = rooms.map((q) => ({ q, a: (q.max.x - q.min.x) * (q.max.z - q.min.z), narrow: Math.min(q.max.x - q.min.x, q.max.z - q.min.z) < 1.5 }));
  byArea.sort((p, q) => q.a - p.a);
  const kinds: HouseRoom['kind'][] = ['living', 'kitchen', 'bedroom', 'bedroom', 'study', 'bath', 'bedroom', 'study'];
  let ki = 0;
  for (const { q, a, narrow } of byArea) q.kind = narrow ? 'hall' : a < 6.5 ? 'bath' : kinds[Math.min(kinds.length - 1, ki++)];
  for (const q of rooms) furnish(room, q, doors, rng);
  const living = rooms.find((q) => q.kind === 'living') ?? rooms[0];
  room.floorRects = rooms.map((q) => ({ x0: q.min.x, z0: q.min.z, x1: q.max.x, z1: q.max.z }));
  // Start: a free spot in the living room, near its middle.
  let start = { x: (living.min.x + living.max.x) / 2, y: 0, z: (living.min.z + living.max.z) / 2 };
  for (let q = 0; q < 200; q++) {
    const s = { x: start.x + rng.range(-1, 1) * (q / 100), y: 0, z: start.z + rng.range(-1, 1) * (q / 100) };
    if (!room.solidAt({ x: s.x, y: 0.3, z: s.z }, 0.45) && !room.solidAt({ x: s.x, y: 1.0, z: s.z }, 0.45)) {
      start = s;
      break;
    }
  }
  if (opts.dress !== false) dressHouse(room, rooms, seed);
  return { room, rooms, doors, start, width, depth };
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): B {
  return { min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }, color };
}

/** Furniture for one room, kept clear of its doorways and of a walkway through the middle. */
function furnish(room: SimRoom, q: HouseRoom, doors: Doorway[], rng: Rng) {
  const m = 0.06; // gap to walls
  const x0 = q.min.x + WALL_T / 2 + m, x1 = q.max.x - WALL_T / 2 - m, z0 = q.min.z + WALL_T / 2 + m, z1 = q.max.z - WALL_T / 2 - m;
  const placed: Rect[] = [];
  // Keep doorways clear (a 1.1m deep zone in front of each, both sides).
  for (const d of doors) {
    if (d.a !== q.id && d.b !== q.id) continue;
    placed.push(d.along === 'z' ? { x0: d.x - 1.1, z0: d.z - d.width / 2 - 0.15, x1: d.x + 1.1, z1: d.z + d.width / 2 + 0.15 } : { x0: d.x - d.width / 2 - 0.15, z0: d.z - 1.1, x1: d.x + d.width / 2 + 0.15, z1: d.z + 1.1 });
  }
  // A walkway: keep the room's centre open.
  const cx = (q.min.x + q.max.x) / 2, cz = (q.min.z + q.max.z) / 2;
  placed.push({ x0: cx - 0.45, z0: cz - 0.45, x1: cx + 0.45, z1: cz + 0.45 });
  const tryPlace = (w: number, d: number, againstWall: boolean, build: (x: number, z: number) => [string, B[]]) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      let x: number, z: number;
      if (againstWall) {
        const side = rng.int(0, 3);
        x = side < 2 ? rng.range(x0, x1 - w) : side === 2 ? x0 : x1 - w;
        z = side >= 2 ? rng.range(z0, z1 - d) : side === 0 ? z0 : z1 - d;
      } else {
        x = rng.range(x0 + 0.35, x1 - w - 0.35);
        z = rng.range(z0 + 0.35, z1 - d - 0.35);
      }
      if (!(x >= x0 - 1e-6 && z >= z0 - 1e-6 && x + w <= x1 + 1e-6 && z + d <= z1 + 1e-6)) continue;
      const r = { x0: x - 0.3, z0: z - 0.3, x1: x + w + 0.3, z1: z + d + 0.3 };
      if (placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.z0 < p.z1 && r.z1 > p.z0)) continue;
      placed.push({ x0: x, z0: z, x1: x + w, z1: z + d });
      const [label, boxes] = build(x, z);
      room.addPiece(label, boxes);
      return true;
    }
    return false;
  };
  const couch = () => {
    const facing = rng.pick(['z+', 'z-', 'x+', 'x-'] as const);
    const w = facing[0] === 'z' ? rng.range(1.6, 2.2) : 0.9, d = facing[0] === 'z' ? 0.9 : rng.range(1.6, 2.2);
    tryPlace(w, d, true, (x, z) => ['couch', Furniture.couch(x, z, w, d, facing, rng.pick([0.05, 0.16]))]);
  };
  const table = (h = 0.74) => {
    const w = rng.range(0.9, 1.6), d = rng.range(0.6, 0.9);
    tryPlace(w, d, false, (x, z) => ['table', Furniture.table(x, z, w, d, h)]);
  };
  const shelf = () => {
    const w = rng.range(0.6, 1.2), d = 0.35;
    tryPlace(w, d, true, (x, z) => ['bookshelf', Furniture.bookshelf(x, z, w, d)]);
  };
  const counter = () => {
    // Kitchen units: a long box along a wall (0.9m high).
    const along = rng.chance(0.5);
    const len = rng.range(1.6, 2.6);
    const w = along ? len : 0.6, d = along ? 0.6 : len;
    tryPlace(w, d, true, (x, z) => ['bookshelf', [box(x, 0, z, x + w, 0.9, z + d, 0xd9d4c7)]]);
  };
  switch (q.kind) {
    case 'living':
      couch();
      table(0.45);
      shelf();
      if (rng.chance(0.6)) couch();
      tryPlace(0.36, 0.36, true, (x, z) => ['plant', Furniture.plant(x, z)]);
      tryPlace(0.55, 0.5, rng.chance(0.5), (x, z) => ['basket', Furniture.basket(x, z)]);
      break;
    case 'kitchen':
      counter();
      counter();
      table();
      tryPlace(0.45, 0.45, false, (x, z) => ['chair', Furniture.chair(x, z)]);
      tryPlace(0.45, 0.45, false, (x, z) => ['chair', Furniture.chair(x, z)]);
      break;
    case 'bedroom':
      tryPlace(1.5, 2.0, true, (x, z) => ['bed', Furniture.bed(x, z)]);
      shelf();
      if (rng.chance(0.5)) tryPlace(0.45, 0.45, false, (x, z) => ['crate', Furniture.crate(x, z, 0.45, 0.45, rng.range(0.35, 0.6))]);
      break;
    case 'study':
      table();
      tryPlace(0.45, 0.45, false, (x, z) => ['chair', Furniture.chair(x, z)]);
      shelf();
      if (rng.chance(0.5)) couch();
      break;
    case 'bath':
      tryPlace(0.7, 0.5, true, (x, z) => ['crate', Furniture.crate(x, z, 0.7, 0.5, 0.85)]);
      if (rng.chance(0.5)) tryPlace(0.55, 0.5, true, (x, z) => ['basket', Furniture.basket(x, z)]);
      break;
    case 'hall':
      if (rng.chance(0.5)) shelf();
      break;
  }
}

/**
 * Materials, clutter, mirrors and people for a whole house (see dressRoom):
 * one mirror and one person per few rooms, inside the rooms.
 */
export function dressHouse(room: SimRoom, rooms: HouseRoom[], seed: number): void {
  dressRoom(room, seed);
  // dressRoom's whole-extent extras (a person walking straight through every
  // wall, one mirror on the outer north wall) don't fit a house: redo them per room.
  room.dynamic.length = 0;
  const rng = new Rng(seed * 4099 + 5);
  for (const q of rooms) {
    const w = q.max.x - q.min.x, d = q.max.z - q.min.z;
    if (q.kind !== 'hall' && rng.chance(0.25) && w > 2) {
      const x = rng.range(q.min.x + 0.4, q.max.x - 1.2);
      room.addPiece('mirror', [{ min: { x, y: 0.3, z: q.min.z + WALL_T / 2 }, max: { x: x + 0.8, y: 1.9, z: q.min.z + WALL_T / 2 + 0.02 }, color: 0xcfe8ef, material: 'mirror' }]);
    }
    if (rng.chance(0.35)) {
      // Someone pacing across this room now and then.
      const alongX = w > d;
      const fixed = alongX ? rng.range(q.min.z + 0.5, q.max.z - 0.5) : rng.range(q.min.x + 0.5, q.max.x - 0.5);
      const a = alongX ? q.min.x + 0.4 : q.min.z + 0.4, b = alongX ? q.max.x - 0.4 : q.max.z - 0.4;
      const period = rng.range(40, 120), t0 = rng.range(0, period), speed = 0.9;
      const span = b - a;
      room.dynamic.push({
        size: { x: 0.45, y: 1.7, z: 0.3 },
        at: (t) => {
          const ph = (t + t0) % period;
          const walk = (2 * span) / speed;
          if (ph > walk) return null;
          const s = ph * speed;
          const u = s < span ? a + s : a + 2 * span - s;
          return alongX ? { x: u, y: 0, z: fixed } : { x: fixed, y: 0, z: u };
        },
      });
    }
  }
}

/** Grid of where a walker can stand (true = free), 10cm cells, with `clearance` to anything. */
export function walkableMask(room: SimRoom, clearance = 0.3, cell = 0.1): { ok: Uint8Array; nx: number; nz: number; x0: number; z0: number; cell: number } {
  const x0 = -room.halfW, z0 = -room.halfD;
  const nx = Math.ceil(room.width / cell), nz = Math.ceil(room.depth / cell);
  const ok = new Uint8Array(nx * nz);
  // Rasterise obstacles (anything a person would bump into: up to 1.9m, but
  // not flat floor things or overhead lintels).
  const blocked = new Uint8Array(nx * nz);
  for (const b of room.boxes) {
    if (b.min.y > 1.9 || b.max.y < 0.2) continue; // people step over toys and cables
    const i0 = Math.max(0, Math.floor((b.min.x - clearance - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((b.max.x + clearance - x0) / cell));
    const k0 = Math.max(0, Math.floor((b.min.z - clearance - z0) / cell)), k1 = Math.min(nz - 1, Math.floor((b.max.z + clearance - z0) / cell));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) blocked[k * nx + i] = 1;
  }
  for (let q = 0; q < ok.length; q++) ok[q] = blocked[q] ? 0 : 1;
  // Border.
  for (let i = 0; i < nx; i++) ok[i] = ok[(nz - 1) * nx + i] = 0;
  for (let k = 0; k < nz; k++) ok[k * nx] = ok[k * nx + nx - 1] = 0;
  return { ok, nx, nz, x0, z0, cell };
}

/** Shortest walk between two points over a walkable mask (A*, 8-connected). Null if unreachable. */
export function planWalk(mask: ReturnType<typeof walkableMask>, from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number }[] | null {
  const { ok, nx, nz, x0, z0, cell } = mask;
  const ci = (x: number) => Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / cell)));
  const ck = (z: number) => Math.max(0, Math.min(nz - 1, Math.floor((z - z0) / cell)));
  const snap = (x: number, z: number) => {
    let best = -1, bd = Infinity;
    const i = ci(x), k = ck(z);
    for (let r = 0; r < 12 && best < 0; r++)
      for (let dk = -r; dk <= r; dk++)
        for (let di = -r; di <= r; di++) {
          const ii = i + di, kk = k + dk;
          if (ii < 0 || kk < 0 || ii >= nx || kk >= nz || !ok[kk * nx + ii]) continue;
          const dd = di * di + dk * dk;
          if (dd < bd) (bd = dd), (best = kk * nx + ii);
        }
    return best;
  };
  const s = snap(from.x, from.z), g = snap(to.x, to.z);
  if (s < 0 || g < 0) return null;
  const cost = new Float32Array(nx * nz).fill(Infinity);
  const prev = new Int32Array(nx * nz).fill(-1);
  const gi = g % nx, gk = (g / nx) | 0;
  const h = (n: number) => Math.hypot((n % nx) - gi, ((n / nx) | 0) - gk);
  const heap = new MinHeap();
  const push = (f: number, n: number) => heap.push(f, n);
  const pop = () => heap.pop();
  cost[s] = 0;
  push(h(s), s);
  while (heap.size) {
    const n = pop();
    if (n === g) break;
    const i = n % nx, k = (n / nx) | 0;
    for (let dk = -1; dk <= 1; dk++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dk) continue;
        const ii = i + di, kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
        const m = kk * nx + ii;
        if (!ok[m]) continue;
        if (di && dk && (!ok[k * nx + ii] || !ok[kk * nx + i])) continue;
        const c = cost[n] + (di && dk ? 1.4142 : 1);
        if (c < cost[m]) {
          cost[m] = c;
          prev[m] = n;
          push(c + h(m), m);
        }
      }
  }
  if (!Number.isFinite(cost[g])) return null;
  const cells: number[] = [];
  for (let n = g; n >= 0; n = prev[n]) cells.push(n);
  cells.reverse();
  // String-pull: keep only the corners (straight walks between them stay on free cells).
  const clear = (a: number, b: number) => {
    const ai = a % nx, ak = (a / nx) | 0, bi = b % nx, bk = (b / nx) | 0;
    const steps = Math.ceil(Math.hypot(bi - ai, bk - ak) * 2);
    for (let q = 1; q < steps; q++) {
      const i = Math.round(ai + ((bi - ai) * q) / steps), k = Math.round(ak + ((bk - ak) * q) / steps);
      if (!ok[k * nx + i]) return false;
    }
    return true;
  };
  const keep = [cells[0]];
  let at = 0;
  while (at < cells.length - 1) {
    let to = at + 1;
    for (let q = cells.length - 1; q > at + 1; q--)
      if (clear(cells[at], cells[q])) {
        to = q;
        break;
      }
    keep.push(cells[to]);
    at = to;
  }
  return keep.map((n) => ({ x: x0 + ((n % nx) + 0.5) * cell, z: z0 + (((n / nx) | 0) + 0.5) * cell }));
}

/** Binary min-heap of (priority, value) pairs. */
class MinHeap {
  private f: number[] = [];
  private v: number[] = [];
  get size() {
    return this.f.length;
  }
  push(f: number, v: number) {
    const F = this.f, V = this.v;
    let c = F.length;
    F.push(f);
    V.push(v);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (F[p] <= F[c]) break;
      [F[p], F[c]] = [F[c], F[p]];
      [V[p], V[c]] = [V[c], V[p]];
      c = p;
    }
  }
  pop(): number {
    const F = this.f, V = this.v;
    const top = V[0];
    const lf = F.pop()!, lv = V.pop()!;
    if (F.length) {
      F[0] = lf;
      V[0] = lv;
      let c = 0;
      const m = F.length;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let s = c;
        if (l < m && F[l] < F[s]) s = l;
        if (r < m && F[r] < F[s]) s = r;
        if (s === c) break;
        [F[s], F[c]] = [F[c], F[s]];
        [V[s], V[c]] = [V[c], V[s]];
        c = s;
      }
    }
    return top;
  }
}

/**
 * Harder homes: furniture in dark fabric or finish (60% depth dropout, more
 * noise; densified depth fills it from what's around it). Each piece of the
 * listed kinds goes dark with probability `share`.
 */
export function darkenFurniture(room: SimRoom, share: number, seed: number, kinds = ['couch', 'bed', 'bookshelf', 'crate', 'chair', 'table', 'plant', 'basket']): number {
  const rng = new Rng(seed * 6007 + 17);
  let n = 0;
  for (const pc of room.pieces)
    if (kinds.includes(pc.label) && rng.chance(share)) {
      for (const b of pc.boxes) if (b.material !== 'glass') b.material = 'dark';
      n++;
    }
  return n;
}

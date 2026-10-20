import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import { Furniture, SimRoom, type SimBox } from './SimRoom';
import type { SimCamera } from './SimSensor';

/**
 * Multi-room homes for the map-persistence benchmark: a rectangle split into
 * rooms by interior walls with doorways, each room furnished. Sessions can
 * then visit one room, part of a room, or walk through several.
 */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface HomeRoom extends Rect {
  id: number;
}

export interface Door {
  /** Door centre on the wall. */
  x: number;
  z: number;
  /** Wall orientation: 'x' = wall runs along x (door connects rooms north/south). */
  along: 'x' | 'z';
  a: number;
  b: number;
}

export interface Home {
  room: SimRoom;
  rooms: HomeRoom[];
  doors: Door[];
}

type B = Omit<SimBox, 'piece'>;
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): B => ({
  min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
  max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
  color,
});

const WALL = 0xeeeae2;

function outerWalls(room: SimRoom) {
  const t = 0.1, h = room.wallHeight, W = room.halfW, D = room.halfD;
  room.addPiece('wall', [box(-W - t, 0, -D - t, W + t, h, -D, WALL)]);
  room.addPiece('wall', [box(-W - t, 0, D, W + t, h, D + t, WALL)]);
  room.addPiece('wall', [box(-W - t, 0, -D, -W, h, D, WALL)]);
  room.addPiece('wall', [box(W, 0, -D, W + t, h, D, WALL)]);
}

/**
 * A home of `cols`×`rows` rooms (sizes jittered), interior walls 10cm thick
 * with a 90cm doorway between each pair of neighbours.
 */
export function makeHome(seed: number, opts: { cols?: number; rows?: number; furnish?: number; symmetric?: boolean } = {}): Home {
  const rng = new Rng(seed * 977 + 31);
  const cols = opts.cols ?? 2, rows = opts.rows ?? 2;
  const widths = Array.from({ length: cols }, () => (opts.symmetric ? 4 : rng.range(3.4, 5.2)));
  const depths = Array.from({ length: rows }, () => (opts.symmetric ? 4 : rng.range(3.2, 4.8)));
  const W = widths.reduce((a, b) => a + b, 0), D = depths.reduce((a, b) => a + b, 0);
  const room = new SimRoom(W, D);
  outerWalls(room);
  const xs = [-W / 2];
  for (const w of widths) xs.push(xs[xs.length - 1] + w);
  const zs = [-D / 2];
  for (const d of depths) zs.push(zs[zs.length - 1] + d);
  const rooms: HomeRoom[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) rooms.push({ id: r * cols + c, x0: xs[c] + 0.05, x1: xs[c + 1] - 0.05, z0: zs[r] + 0.05, z1: zs[r + 1] - 0.05 });
  const doors: Door[] = [];
  const t = 0.05, h = room.wallHeight, gap = 0.9;
  // Vertical walls (between columns), one segment per row with a doorway.
  for (let c = 1; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const x = xs[c], z0 = zs[r], z1 = zs[r + 1];
      const dz = opts.symmetric ? (z0 + z1) / 2 : rng.range(z0 + 0.7, z1 - 0.7);
      room.addPiece('wall', [box(x - t, 0, z0, x + t, h, dz - gap / 2, WALL), box(x - t, 0, dz + gap / 2, x + t, h, z1, WALL)]);
      doors.push({ x, z: dz, along: 'z', a: r * cols + c - 1, b: r * cols + c });
    }
  // Horizontal walls (between rows), one segment per column with a doorway.
  for (let r = 1; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const z = zs[r], x0 = xs[c], x1 = xs[c + 1];
      const dx = opts.symmetric ? (x0 + x1) / 2 : rng.range(x0 + 0.7, x1 - 0.7);
      room.addPiece('wall', [box(x0, 0, z - t, dx - gap / 2, h, z + t, WALL), box(dx + gap / 2, 0, z - t, x1, h, z + t, WALL)]);
      doors.push({ x: dx, z, along: 'x', a: (r - 1) * cols + c, b: r * cols + c });
    }
  const nFurn = opts.furnish ?? 4;
  for (const rm of rooms) if (nFurn > 0) furnish(room, rm, doors, rng, nFurn);
  return { room, rooms, doors };
}

function furnish(room: SimRoom, r: Rect, doors: Door[], rng: Rng, n: number) {
  const placed: Rect[] = [];
  // Keep doorways and the room centre (where sessions start) clear.
  for (const d of doors) placed.push({ x0: d.x - 0.8, z0: d.z - 0.8, x1: d.x + 0.8, z1: d.z + 0.8 });
  const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  placed.push({ x0: cx - 0.5, z0: cz - 0.5, x1: cx + 0.5, z1: cz + 0.5 });
  const tryPlace = (w: number, d: number, againstWall: boolean, build: (x: number, z: number) => [string, B[]]) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      let x: number, z: number;
      if (againstWall) {
        const side = rng.int(0, 3);
        x = side < 2 ? rng.range(r.x0 + 0.05, r.x1 - w - 0.05) : side === 2 ? r.x0 + 0.02 : r.x1 - w - 0.02;
        z = side >= 2 ? rng.range(r.z0 + 0.05, r.z1 - d - 0.05) : side === 0 ? r.z0 + 0.02 : r.z1 - d - 0.02;
      } else {
        x = rng.range(r.x0 + 0.4, r.x1 - w - 0.4);
        z = rng.range(r.z0 + 0.4, r.z1 - d - 0.4);
      }
      const q = { x0: x - 0.3, z0: z - 0.3, x1: x + w + 0.3, z1: z + d + 0.3 };
      if (placed.some((p) => q.x0 < p.x1 && q.x1 > p.x0 && q.z0 < p.z1 && q.z1 > p.z0)) continue;
      if (x < r.x0 || z < r.z0 || x + w > r.x1 || z + d > r.z1) continue;
      placed.push({ x0: x, z0: z, x1: x + w, z1: z + d });
      const [label, boxes] = build(x, z);
      room.addPiece(label, boxes);
      return true;
    }
    return false;
  };
  const kinds = ['table', 'couch', 'chair', 'bookshelf', 'basket', 'plant', 'crate', 'bed', 'coffee'];
  for (let q = 0; q < n; q++) {
    switch (rng.pick(kinds)) {
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
}

/**
 * Move some furniture between sessions (people tidy up): each movable piece
 * is shifted/re-placed with probability `p`. Returns a new SimRoom (the old
 * one is left as it was). Walls never move.
 */
export function rearrange(home: Home, seed: number, p = 0.3): Home {
  const rng = new Rng(seed * 131 + 7);
  const room = new SimRoom(home.room.width, home.room.depth, home.room.wallHeight);
  room.floorMaterial = home.room.floorMaterial;
  const movable = (label: string) => !['wall', 'mirror', 'cable', 'rug'].includes(label);
  for (const pc of home.room.pieces) {
    let dx = 0, dz = 0;
    if (movable(pc.label) && rng.chance(p)) {
      // Try a few shifts that stay inside the piece's room and off other things.
      const r = home.rooms.find((q) => (pc.min.x + pc.max.x) / 2 > q.x0 && (pc.min.x + pc.max.x) / 2 < q.x1 && (pc.min.z + pc.max.z) / 2 > q.z0 && (pc.min.z + pc.max.z) / 2 < q.z1);
      for (let a = 0; a < 20 && r; a++) {
        const sx = rng.range(-1.2, 1.2), sz = rng.range(-1.2, 1.2);
        if (pc.min.x + sx < r.x0 || pc.max.x + sx > r.x1 || pc.min.z + sz < r.z0 || pc.max.z + sz > r.z1) continue;
        const clash = room.pieces.some((o) => o.label !== 'rug' && o.label !== 'cable' && pc.min.x + sx < o.max.x + 0.1 && pc.max.x + sx > o.min.x - 0.1 && pc.min.z + sz < o.max.z + 0.1 && pc.max.z + sz > o.min.z - 0.1);
        if (clash) continue;
        dx = sx;
        dz = sz;
        break;
      }
      if (!dx && !dz && rng.chance(0.5)) continue; // removed altogether
    }
    room.addPiece(
      pc.label,
      pc.boxes.map((b) => ({ min: { x: b.min.x + dx, y: b.min.y, z: b.min.z + dz }, max: { x: b.max.x + dx, y: b.max.y, z: b.max.z + dz }, color: b.color, material: b.material })),
    );
  }
  return { room, rooms: home.rooms, doors: home.doors };
}

/**
 * A person mapping part of the home: walks between random open spots inside
 * the allowed rooms (through doorways), looking at furniture, walls and floor,
 * with whip pans and crouches. 10Hz camera poses.
 */
export function homeScanPath(home: Home, allowed: number[], seed: number, seconds: number, start?: Vec3): { t: number; cam: SimCamera; angVel: number }[] {
  const rng = new Rng(seed * 53 + 11);
  const room = home.room;
  const open = (x: number, z: number) => !room.solidAt({ x, y: 1.0, z }, 0.2) && !room.solidAt({ x, y: 0.3, z }, 0.2);
  const roomOf = (x: number, z: number) => home.rooms.find((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)?.id ?? -1;
  const pickSpot = (rid: number): Vec3 => {
    const r = home.rooms[rid];
    for (let q = 0; q < 60; q++) {
      const x = rng.range(r.x0 + 0.35, r.x1 - 0.35), z = rng.range(r.z0 + 0.35, r.z1 - 0.35);
      if (open(x, z)) return { x, y: 0, z };
    }
    return { x: (r.x0 + r.x1) / 2, y: 0, z: (r.z0 + r.z1) / 2 };
  };
  const pickLook = (rid: number): Vec3 => {
    const r = home.rooms[rid];
    const pc = room.pieces.filter((p) => p.label !== 'wall' && p.max.x > r.x0 && p.min.x < r.x1 && p.max.z > r.z0 && p.min.z < r.z1);
    if (pc.length && rng.chance(0.6)) {
      const p = rng.pick(pc);
      return { x: rng.range(p.min.x, p.max.x), y: rng.range(0, p.max.y), z: rng.range(p.min.z, p.max.z) };
    }
    if (rng.chance(0.5)) {
      // A wall.
      const side = rng.int(0, 3);
      const x = side < 2 ? rng.range(r.x0, r.x1) : side === 2 ? r.x0 : r.x1;
      const z = side >= 2 ? rng.range(r.z0, r.z1) : side === 0 ? r.z0 : r.z1;
      return { x, y: rng.range(0.2, 1.8), z };
    }
    return { x: rng.range(r.x0, r.x1), y: 0, z: rng.range(r.z0, r.z1) };
  };
  // Route between rooms: BFS over doors.
  const route = (from: number, to: number): Vec3[] => {
    if (from === to || from < 0) return [];
    const prev = new Map<number, { room: number; door: number }>();
    const q = [from];
    const seen = new Set([from]);
    while (q.length) {
      const r = q.shift()!;
      if (r === to) break;
      home.doors.forEach((d, di) => {
        const o = d.a === r ? d.b : d.b === r ? d.a : -1;
        if (o < 0 || seen.has(o) || !allowed.includes(o)) return;
        seen.add(o);
        prev.set(o, { room: r, door: di });
        q.push(o);
      });
    }
    if (!prev.has(to)) return [];
    const doorsOnPath: { door: Door; into: number }[] = [];
    for (let r = to; r !== from; r = prev.get(r)!.room) doorsOnPath.unshift({ door: home.doors[prev.get(r)!.door], into: r });
    const pts: Vec3[] = [];
    for (const { door, into } of doorsOnPath) {
      const target = home.rooms[into];
      const tc = { x: (target.x0 + target.x1) / 2, z: (target.z0 + target.z1) / 2 };
      const before = door.along === 'z' ? { x: door.x - Math.sign(tc.x - door.x) * 0.5, y: 0, z: door.z } : { x: door.x, y: 0, z: door.z - Math.sign(tc.z - door.z) * 0.5 };
      const after = door.along === 'z' ? { x: door.x + Math.sign(tc.x - door.x) * 0.5, y: 0, z: door.z } : { x: door.x, y: 0, z: door.z + Math.sign(tc.z - door.z) * 0.5 };
      pts.push(before, after);
    }
    return pts;
  };
  const out: { t: number; cam: SimCamera; angVel: number }[] = [];
  const s0 = start ?? pickSpot(allowed[0]);
  const pos = { x: s0.x, y: 1.45, z: s0.z };
  let curRoom = roomOf(pos.x, pos.z);
  if (curRoom < 0) curRoom = allowed[0];
  let yaw = rng.range(-Math.PI, Math.PI), pitch = -0.6;
  let goalRoom = curRoom;
  let waypoints: Vec3[] = [pickSpot(curRoom)];
  let look = pickLook(curRoom), lookT = 0;
  let height = 1.45;
  for (let t = 0; t < seconds; t += 0.1) {
    const goal = waypoints[0];
    const dx = goal.x - pos.x, dz = goal.z - pos.z, d = Math.hypot(dx, dz);
    if (d < 0.1) {
      waypoints.shift();
      if (!waypoints.length) {
        // Next goal: usually the same room, sometimes another allowed one.
        goalRoom = allowed.length > 1 && rng.chance(0.3) ? rng.pick(allowed) : curRoom;
        waypoints = [...route(curRoom, goalRoom), pickSpot(goalRoom)];
      }
    } else {
      const sp = Math.min(d, 0.05);
      const nx = pos.x + (dx / d) * sp, nz = pos.z + (dz / d) * sp;
      if (open(nx, nz) || waypoints.length > 1) {
        pos.x = nx;
        pos.z = nz;
        const r = roomOf(pos.x, pos.z);
        if (r >= 0) curRoom = r;
      } else waypoints = [...route(curRoom, curRoom), pickSpot(curRoom)];
    }
    if (rng.chance(0.02)) height = rng.range(1.15, 1.6);
    pos.y += (height - pos.y) * 0.2;
    lookT -= 0.1;
    if (lookT <= 0) {
      look = pickLook(curRoom);
      lookT = rng.range(0.8, 3);
    }
    const ldx = look.x - pos.x, ldy = look.y - pos.y, ldz = look.z - pos.z;
    const wantYaw = Math.atan2(-ldx, -ldz), wantPitch = Math.max(-1.3, Math.min(0.2, Math.atan2(ldy, Math.hypot(ldx, ldz))));
    const rate = rng.chance(0.05) ? 0.9 : 0.25;
    let dy = wantYaw - yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const prevYaw = yaw, prevPitch = pitch;
    yaw += dy * rate + rng.range(-0.01, 0.01);
    pitch += (wantPitch - pitch) * rate + rng.range(-0.01, 0.01);
    const angVel = Math.hypot(yaw - prevYaw, pitch - prevPitch) / 0.1;
    out.push({ t, cam: { pos: { ...pos }, yaw, pitch, fovY: 1.05, aspect: 0.6 }, angVel });
  }
  return out;
}

export function roomCenter(home: Home, id: number): Vec3 {
  const r = home.rooms[id];
  return { x: (r.x0 + r.x1) / 2, y: 0, z: (r.z0 + r.z1) / 2 };
}

import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import type { Material, SimRoom } from './SimRoom';
import type { SimCamera } from './SimSensor';

/**
 * Makes a simulated room look more like a real one to a depth sensor:
 * difficult materials, small clutter, and a person walking through. Used by
 * the stress tests so the mapping isn't only ever tested on clean boxes.
 */
export function dressRoom(room: SimRoom, seed: number): SimRoom {
  const rng = new Rng(seed * 7919 + 13);
  // Materials: blank walls are the norm; dark sofas and glass tables are common.
  for (const pc of room.pieces) {
    let m: Material = 'matte';
    if (pc.label === 'wall') m = rng.chance(0.75) ? 'textureless' : 'matte';
    else if (pc.label === 'couch') m = rng.chance(0.6) ? 'dark' : 'matte';
    else if (pc.label === 'bookshelf') m = rng.chance(0.4) ? 'textureless' : 'matte';
    for (const b of pc.boxes) b.material = m;
    // Glass top on some tables (legs stay visible).
    if (pc.label === 'table' && rng.chance(0.3)) {
      const top = pc.boxes.reduce((a, b) => (b.max.y > a.max.y ? b : a));
      top.material = 'glass';
    }
  }
  room.floorMaterial = rng.chance(0.4) ? 'textureless' : 'matte';
  const W = room.halfW, D = room.halfD;
  const free = (x: number, z: number, r: number) => !room.solidAt({ x, y: 0.05, z }, r) && Math.abs(x) < W - r && Math.abs(z) < D - r;
  // Floor clutter: toys, shoes, a box, a cable, a rug.
  const nToys = rng.int(3, 8);
  for (let q = 0, placed = 0; q < 60 && placed < nToys; q++) {
    const x = rng.range(-W + 0.3, W - 0.3), z = rng.range(-D + 0.3, D - 0.3);
    const s = rng.range(0.05, 0.16), h = rng.range(0.04, 0.14);
    if (Math.hypot(x, z) < 0.6 || !free(x, z, s + 0.05)) continue;
    room.addPiece('toy', [{ min: { x, y: 0, z }, max: { x: x + s, y: h, z: z + s * rng.range(0.6, 1.4) }, color: rng.pick([0xe94f37, 0x3f88c5, 0xf6ae2d, 0x44bba4]), material: 'matte' }]);
    placed++;
  }
  // A cable across the floor (1.5cm high, 1cm wide): below the pet's step height.
  {
    const z = rng.range(-D + 0.4, D - 0.4), x0 = rng.range(-W + 0.3, 0), len = rng.range(0.8, 2);
    room.addPiece('cable', [{ min: { x: x0, y: 0, z }, max: { x: Math.min(W - 0.2, x0 + len), y: 0.015, z: z + 0.012 }, color: 0x222222, material: 'dark' }]);
  }
  // A rug (1cm) somewhere open.
  for (let q = 0; q < 20; q++) {
    const x = rng.range(-W + 0.5, W - 2), z = rng.range(-D + 0.5, D - 1.5);
    if (!free(x + 0.7, z + 0.5, 0.5)) continue;
    room.addPiece('rug', [{ min: { x, y: 0, z }, max: { x: x + 1.4, y: 0.012, z: z + 1.0 }, color: 0x8c4b5d, material: 'matte' }]);
    break;
  }
  // Books on tables, pillows on couches.
  for (const pc of [...room.pieces]) {
    if (pc.label === 'table' && rng.chance(0.7)) {
      const top = pc.max.y;
      const x = pc.min.x + rng.range(0.1, Math.max(0.11, pc.max.x - pc.min.x - 0.35)), z = pc.min.z + rng.range(0.05, Math.max(0.06, pc.max.z - pc.min.z - 0.3));
      room.addPiece('books', [{ min: { x, y: top, z }, max: { x: x + 0.25, y: top + 0.08, z: z + 0.2 }, color: 0x5a3e8c, material: 'matte' }]);
    }
    if (pc.label === 'couch') {
      const seat = pc.boxes[4];
      if (seat) {
        const y = seat.max.y, cx = (seat.min.x + seat.max.x) / 2, cz = (seat.min.z + seat.max.z) / 2;
        room.addPiece('pillow', [{ min: { x: cx - 0.2, y, z: cz - 0.15 }, max: { x: cx + 0.15, y: y + 0.18, z: cz + 0.1 }, color: 0xf2d0a4, material: 'matte' }]);
      }
    }
  }
  // A mirror on a wall in some rooms.
  if (rng.chance(0.4)) {
    const x = rng.range(-W + 0.6, W - 1.4);
    room.addPiece('mirror', [{ min: { x, y: 0.3, z: -D }, max: { x: x + 0.8, y: 1.9, z: -D + 0.02 }, color: 0xcfe8ef, material: 'mirror' }]);
  }
  // Someone walks through the room during the first ~20 seconds.
  if (rng.chance(0.7)) {
    const z = rng.range(-D + 0.6, D - 0.6), t0 = rng.range(2, 8), speed = 0.9;
    room.dynamic.push({
      size: { x: 0.45, y: 1.7, z: 0.3 },
      at: (t) => {
        const x = -W - 0.3 + (t - t0) * speed;
        return t < t0 || x > W + 0.3 ? null : { x, y: 0, z };
      },
    });
  }
  return room;
}

/**
 * A human-ish scanning session: wander between random open spots, look at
 * random things (furniture, floor, walls), with occasional fast pans and
 * changes of phone height. Returns camera poses at 10Hz.
 */
export function humanScanPath(room: SimRoom, seed: number, seconds = 40): { t: number; cam: SimCamera; angVel: number }[] {
  const rng = new Rng(seed * 31 + 7);
  const W = room.halfW - 0.35, D = room.halfD - 0.35;
  const open = (x: number, z: number) => !room.solidAt({ x, y: 1.0, z }, 0.2) && !room.solidAt({ x, y: 0.3, z }, 0.2);
  const pickSpot = (): Vec3 => {
    for (let q = 0; q < 50; q++) {
      const x = rng.range(-W, W), z = rng.range(-D, D);
      if (open(x, z)) return { x, y: 0, z };
    }
    return { x: 0, y: 0, z: 0 };
  };
  const pickLook = (): Vec3 => {
    const pc = room.pieces.filter((p) => p.label !== 'wall');
    if (pc.length && rng.chance(0.7)) {
      const p = rng.pick(pc);
      return { x: rng.range(p.min.x, p.max.x), y: rng.range(0, p.max.y), z: rng.range(p.min.z, p.max.z) };
    }
    return { x: rng.range(-W, W), y: 0, z: rng.range(-D, D) };
  };
  const out: { t: number; cam: SimCamera; angVel: number }[] = [];
  let pos = { x: 0, y: 1.45, z: 0 };
  let yaw = 0, pitch = -0.6;
  let goal = pickSpot(), look = pickLook(), lookT = 0;
  let height = 1.45;
  for (let t = 0; t < seconds; t += 0.1) {
    // Walk.
    const dx = goal.x - pos.x, dz = goal.z - pos.z, d = Math.hypot(dx, dz);
    if (d < 0.1 || rng.chance(0.01)) goal = pickSpot();
    else {
      const sp = Math.min(d, 0.05);
      const nx = pos.x + (dx / d) * sp, nz = pos.z + (dz / d) * sp;
      if (open(nx, nz)) {
        pos.x = nx;
        pos.z = nz;
      } else goal = pickSpot();
    }
    if (rng.chance(0.02)) height = rng.range(1.15, 1.6); // crouch / raise the phone
    pos.y += (height - pos.y) * 0.2;
    // Look.
    lookT -= 0.1;
    if (lookT <= 0) {
      look = pickLook();
      lookT = rng.range(0.8, 3);
    }
    const ldx = look.x - pos.x, ldy = look.y - pos.y, ldz = look.z - pos.z;
    const wantYaw = Math.atan2(-ldx, -ldz), wantPitch = Math.max(-1.3, Math.min(0.2, Math.atan2(ldy, Math.hypot(ldx, ldz))));
    // Sometimes a quick whip pan; usually a smooth turn. Plus hand shake.
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

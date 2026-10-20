import { Rng } from '../core/rng';
import type { SimCamera } from './SimSensor';
import { planWalk, walkableMask, type House } from './House';

/**
 * A person walking through a whole home with the phone up, the way people
 * actually do it: walking 0.5–1.2 m/s from room to room, stopping to look
 * around (pans with bursts of 1.5–4 rad/s), quick glances back over the
 * shoulder, looking down at the floor and up at shelves, crouching now and
 * then, and coming back to rooms seen minutes ago. Poses at 30 Hz.
 */
export interface WalkStep {
  t: number;
  cam: SimCamera;
  /** Angular speed of the camera during this frame (rad/s). */
  angVel: number;
  /** Room the camera is in (-1 in a doorway). */
  roomId: number;
}

export interface WalkOptions {
  seconds: number;
  /** Walking speed range (m/s). */
  speed: [number, number];
  /** Pan speed range for look-arounds and glances (rad/s). */
  panSpeed: [number, number];
  /** Chance per second of a quick glance back while walking. */
  glanceRate: number;
  /** Look-around duration range at each stop (s). */
  lookAround: [number, number];
  /** Hand shake (rad, per frame). */
  shake: number;
  /** Order of visits: tour all rooms first, then come back to the start, then wander. */
  fps: number;
}

export const DEFAULT_WALK: WalkOptions = { seconds: 300, speed: [0.5, 1.2], panSpeed: [1.5, 4], glanceRate: 0.08, lookAround: [2, 6], shake: 0.006, fps: 30 };

export function houseWalk(house: House, seed: number, o: Partial<WalkOptions> = {}): WalkStep[] {
  const opts = { ...DEFAULT_WALK, ...o };
  const rng = new Rng(seed * 7717 + 3);
  const mask = walkableMask(house.room, 0.3);
  const dt = 1 / opts.fps;
  const roomOf = (x: number, z: number) => house.rooms.findIndex((q) => x > q.min.x + 0.05 && x < q.max.x - 0.05 && z > q.min.z + 0.05 && z < q.max.z - 0.05);
  const free = (x: number, z: number) => {
    const i = Math.floor((x - mask.x0) / mask.cell), k = Math.floor((z - mask.z0) / mask.cell);
    return i >= 0 && k >= 0 && i < mask.nx && k < mask.nz && mask.ok[k * mask.nx + i] === 1;
  };
  const spotIn = (r: number) => {
    const q = house.rooms[r];
    for (let a = 0; a < 80; a++) {
      const x = rng.range(q.min.x + 0.4, q.max.x - 0.4), z = rng.range(q.min.z + 0.4, q.max.z - 0.4);
      if (free(x, z)) return { x, z };
    }
    return { x: (q.min.x + q.max.x) / 2, z: (q.min.z + q.max.z) / 2 };
  };
  // Visit plan: nearest unvisited room each time (a natural tour), back to
  // the start room, then random rooms (revisits) until time runs out.
  const startRoom = Math.max(0, roomOf(house.start.x, house.start.z));
  const plan: number[] = [startRoom];
  const centre = (r: number) => ({ x: (house.rooms[r].min.x + house.rooms[r].max.x) / 2, z: (house.rooms[r].min.z + house.rooms[r].max.z) / 2 });
  const left = new Set(house.rooms.map((q) => q.id).filter((id) => id !== startRoom));
  let cur = startRoom;
  while (left.size) {
    let best = -1, bd = Infinity;
    for (const r of left) {
      const d = Math.hypot(centre(r).x - centre(cur).x, centre(r).z - centre(cur).z);
      if (d < bd) (bd = d), (best = r);
    }
    plan.push(best);
    left.delete(best);
    cur = best;
  }
  plan.push(startRoom);
  for (let q = 0; q < 40; q++) plan.push(rng.int(0, house.rooms.length - 1));

  const out: WalkStep[] = [];
  let pos = { x: house.start.x, y: 1.4, z: house.start.z };
  let yaw = rng.range(-Math.PI, Math.PI), pitch = -0.5;
  let height = 1.4;
  let t = 0;
  const push = (av: number) => {
    out.push({ t, cam: { pos: { ...pos }, yaw, pitch, fovY: 1.05, aspect: 0.6 }, angVel: av, roomId: roomOf(pos.x, pos.z) });
    t += dt;
  };
  /** Turn the view towards (wantYaw, wantPitch) at up to `rate` rad/s for one frame. */
  const turn = (wantYaw: number, wantPitch: number, rate: number) => {
    let dy = Math.atan2(Math.sin(wantYaw - yaw), Math.cos(wantYaw - yaw));
    const dp = wantPitch - pitch;
    const mag = Math.hypot(dy, dp), max = rate * dt;
    // At most `rate`, easing in on the target (35% of what is left per frame).
    const ease = mag > 1e-9 ? Math.min(max, mag * 0.35) / mag : 0;
    dy *= ease;
    const prevYaw = yaw, prevPitch = pitch;
    yaw += dy + (rng.next() - 0.5) * 2 * opts.shake;
    pitch = Math.max(-1.35, Math.min(0.5, pitch + dp * ease + (rng.next() - 0.5) * 2 * opts.shake));
    return Math.hypot(Math.atan2(Math.sin(yaw - prevYaw), Math.cos(yaw - prevYaw)), pitch - prevPitch) / dt;
  };
  const end = opts.seconds;
  // Look-around at a stop: a few pans to random headings at random tilts.
  const lookAround = (secs: number) => {
    const until = t + secs;
    while (t < until && t < end) {
      const wantYaw = yaw + rng.range(0.6, 2.4) * (rng.chance(0.5) ? 1 : -1);
      const wantPitch = rng.chance(0.15) ? rng.range(-0.1, 0.4) : rng.range(-1.1, -0.25);
      const rate = rng.range(opts.panSpeed[0], opts.panSpeed[1]);
      if (rng.chance(0.2)) height = rng.chance(0.5) ? rng.range(0.8, 1.0) : rng.range(1.3, 1.55);
      const hold = rng.range(0.3, 1.2);
      let settled = 0;
      for (let f = 0; f < 120 && t < end; f++) {
        pos.y += (height - pos.y) * 0.08;
        const av = turn(wantYaw, wantPitch, rate);
        push(av);
        if (av < 0.3) settled += dt;
        if (settled > hold) break;
      }
    }
  };
  for (let v = 1; v < plan.length && t < end; v++) {
    const r = plan[v];
    const stops = house.rooms[r].kind === 'hall' ? 1 : rng.int(1, 3);
    for (let s = 0; s < stops && t < end; s++) {
      const goal = spotIn(r);
      const path = planWalk(mask, pos, goal);
      if (!path) continue;
      const speed = rng.range(opts.speed[0], opts.speed[1]);
      let v0 = 0;
      let heading = yaw;
      let glanceUntil = -1, glanceYaw = 0;
      let lookOff = rng.range(-0.4, 0.4), lookPitch = rng.range(-0.8, -0.3);
      // Walk with bounded acceleration (people round corners and ease in
      // and out of stops; ~1.5 m/s²), steering at the next waypoint.
      let vx = 0, vz = 0;
      const last = path[path.length - 1];
      for (let w = 1; w < path.length && t < end; ) {
        let dx = path[w].x - pos.x, dz = path[w].z - pos.z, d = Math.hypot(dx, dz);
        if (w < path.length - 1 && d < 0.35) {
          w++;
          continue;
        }
        const toEnd = Math.hypot(last.x - pos.x, last.z - pos.z);
        if (w === path.length - 1 && toEnd < 0.08 && Math.hypot(vx, vz) < 0.15) break;
        const want = Math.min(speed, Math.max(0.15, toEnd * 1.2));
        const ax = (dx / Math.max(d, 1e-6)) * want - vx, az = (dz / Math.max(d, 1e-6)) * want - vz, am = Math.hypot(ax, az), amax = 1.5 * dt;
        vx += am > amax ? (ax / am) * amax : ax;
        vz += am > amax ? (az / am) * amax : az;
        v0 = Math.hypot(vx, vz);
        pos.x += vx * dt;
        pos.z += vz * dt;
        dx = vx;
        dz = vz;
        d = v0;
        pos.y += (height - pos.y) * 0.05;
        if (height < 1.2 && rng.chance(0.02)) height = rng.range(1.3, 1.55);
        // Where to look: mostly ahead (where the walk is going), with drifting interest.
        // Smoothed walking direction (people turn their body gradually).
        if (d > 0.05) {
          const want = Math.atan2(-dx, -dz);
          heading += Math.atan2(Math.sin(want - heading), Math.cos(want - heading)) * Math.min(1, dt / 0.4);
        }
        if (rng.chance(0.4 * dt)) lookOff = rng.range(-0.9, 0.9);
        if (rng.chance(0.3 * dt)) lookPitch = rng.chance(0.15) ? rng.range(-0.1, 0.3) : rng.range(-1.0, -0.25);
        let wantYaw = heading + lookOff, rate = 1.2;
        if (t < glanceUntil) {
          wantYaw = glanceYaw;
          rate = rng.range(opts.panSpeed[0], opts.panSpeed[1]) + 1;
        } else if (rng.chance(opts.glanceRate * dt)) {
          // A quick look back over the shoulder.
          glanceYaw = heading + Math.PI + rng.range(-0.6, 0.6);
          glanceUntil = t + rng.range(0.8, 1.6);
        }
        push(turn(wantYaw, lookPitch, rate));
      }
      lookAround(rng.range(opts.lookAround[0], opts.lookAround[1]));
    }
  }
  // Out of plan before time: stand and look around.
  while (t < end) lookAround(5);
  return out;
}

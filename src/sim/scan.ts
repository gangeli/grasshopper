import type { Vec3 } from '../core/math';
import { WorldModel } from '../world/WorldModel';
import type { SimRoom } from './SimRoom';
import { SimSensor, type NoiseName, type NoiseProfile, type SensorCaps, type SimCamera } from './SimSensor';
import { humanScanPath } from './Realism';

/** Feed one camera frame of simulated sensing into the world model. */
export function senseFrame(world: WorldModel, sensor: SimSensor, cam: SimCamera, depthRes?: [number, number]): void {
  if (sensor.caps.planes) for (const p of sensor.planes(cam)) world.ingestPlane(p);
  if (sensor.caps.depth) {
    const img = depthRes ? sensor.depthImage(cam, depthRes[0], depthRes[1]) : sensor.depthImage(cam);
    world.ingestDepthImage(img, sensor.room.time);
  }
}

/**
 * A scripted "user looks around the room" scan: turn in place at a few spots,
 * looking slightly down, like someone holding a phone while the app maps.
 */
export function scanRoom(room: SimRoom, caps: SensorCaps = { depth: true, planes: true, mesh: false }, opts: { spots?: Vec3[]; seed?: number; world?: WorldModel; noise?: NoiseName | NoiseProfile } = {}) {
  const world = opts.world ?? new WorldModel();
  const sensor = new SimSensor(room, caps, opts.seed ?? 7, opts.noise ?? 'ideal');
  world.setFloor(sensor.floorEstimate(), { x: 0, y: 0, z: 0 });
  if (caps.mesh) for (const m of sensor.meshes()) world.ingestMesh(m);
  const spots = opts.spots ?? defaultScanSpots(room);
  for (const s of spots) {
    // Two standing sweeps, then a crouched one to see under tables (the app asks for this).
    for (const [height, pitch] of [[1.45, -0.75], [1.45, -0.35], [0.9, -0.3]] as const) {
      for (let a = 0; a < 16; a++) {
        const cam: SimCamera = { pos: { x: s.x, y: height, z: s.z }, yaw: (a / 16) * Math.PI * 2, pitch, fovY: 1.1, aspect: 0.75 };
        room.time += 0.25; // ~1.5 rad/s sweep: brisk but plausible for a hand-held phone
        senseFrame(world, sensor, cam);
        world.refineFloor();
      }
    }
  }
  return { world, sensor };
}

export function defaultScanSpots(room: SimRoom): Vec3[] {
  const W = room.halfW * 0.55, D = room.halfD * 0.55;
  const cands = [
    { x: 0, y: 0, z: 0 },
    { x: -W, y: 0, z: -D },
    { x: W, y: 0, z: -D },
    { x: W, y: 0, z: D },
    { x: -W, y: 0, z: D },
  ];
  return cands.filter((c) => !room.solidAt({ x: c.x, y: 1.0, z: c.z }, 0.15) && !room.solidAt({ x: c.x, y: 0.3, z: c.z }, 0.15));
}

/**
 * A realistic mapping session: a person wanders the room for `seconds`,
 * looking at things, with whip pans, crouches, tracking hiccups and (in a
 * dressed room) someone walking through.
 */
export function scanRoomHuman(room: SimRoom, opts: { seed?: number; seconds?: number; noise?: NoiseName | NoiseProfile; world?: WorldModel; caps?: SensorCaps } = {}) {
  const world = opts.world ?? new WorldModel();
  const sensor = new SimSensor(room, opts.caps ?? { depth: true, planes: true, mesh: false }, opts.seed ?? 7, opts.noise ?? 'real');
  world.setFloor(sensor.floorEstimate(), { x: 0, y: 0, z: 0 });
  const path = humanScanPath(room, opts.seed ?? 7, opts.seconds ?? 40);
  const eyes: Vec3[] = [];
  let frames = 0, dropped = 0;
  for (const step of path) {
    room.time = step.t;
    if (!sensor.trackingOk(step.angVel)) {
      dropped++;
      continue;
    }
    senseFrame(world, sensor, step.cam);
    world.refineFloor();
    frames++;
    if (frames % 10 === 0) eyes.push({ ...step.cam.pos });
  }
  return { world, sensor, eyes, frames, dropped };
}

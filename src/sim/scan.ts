import type { Vec3 } from '../core/math';
import { WorldModel } from '../world/WorldModel';
import type { SimRoom } from './SimRoom';
import { SimSensor, type SensorCaps, type SimCamera } from './SimSensor';

/** Feed one camera frame of simulated sensing into the world model. */
export function senseFrame(world: WorldModel, sensor: SimSensor, cam: SimCamera, depthRes: [number, number] = [40, 30]): void {
  if (sensor.caps.planes) for (const p of sensor.planes(cam)) world.ingestPlane(p);
  if (sensor.caps.depth) world.ingestDepth(cam.pos, sensor.depthPoints(cam, depthRes[0], depthRes[1]));
}

/**
 * A scripted "user looks around the room" scan: turn in place at a few spots,
 * looking slightly down, like someone holding a phone while the app maps.
 */
export function scanRoom(room: SimRoom, caps: SensorCaps = { depth: true, planes: true, mesh: false }, opts: { spots?: Vec3[]; seed?: number; world?: WorldModel } = {}) {
  const world = opts.world ?? new WorldModel();
  world.setFloor(0, { x: 0, y: 0, z: 0 });
  const sensor = new SimSensor(room, caps, opts.seed ?? 7);
  if (caps.mesh) for (const m of sensor.meshes()) world.ingestMesh(m);
  const spots = opts.spots ?? defaultScanSpots(room);
  for (const s of spots) {
    for (let a = 0; a < 16; a++) {
      for (const pitch of [-0.75, -0.35]) {
        const cam: SimCamera = { pos: { x: s.x, y: 1.45, z: s.z }, yaw: (a / 16) * Math.PI * 2, pitch, fovY: 1.1, aspect: 0.75 };
        senseFrame(world, sensor, cam);
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

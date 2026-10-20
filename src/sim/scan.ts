import type { Vec3 } from '../core/math';
import { WorldModel } from '../world/WorldModel';
import type { SimRoom } from './SimRoom';
import { SimSensor, type NoiseName, type NoiseProfile, type SensorCaps, type SimCamera } from './SimSensor';
import { humanScanPath } from './Realism';
import { CameraSim, type CameraOptions } from './CameraSim';
import { MotionStereo, type StereoOptions, type StereoResult } from '../world/StereoDepth';

/**
 * Depth from the camera instead of a depth sensor: render what the phone's
 * camera sees, run motion stereo on recent frames (with tracked, imperfect
 * poses) and hand the result to the mapper like any depth image.
 */
export class CameraDepthSource {
  readonly camera: CameraSim;
  readonly stereo: MotionStereo;
  frames = 0;
  depthFrames = 0;
  last: StereoResult | null = null;
  constructor(room: SimRoom, readonly sensor: SimSensor, opts: { camera?: Partial<CameraOptions>; stereo?: Partial<StereoOptions>; seed?: number; every?: number } = {}) {
    this.camera = new CameraSim(room, opts.camera, opts.seed ?? 5);
    this.stereo = new MotionStereo(opts.stereo);
    this.every = opts.every ?? 2;
  }
  private every: number;
  /** Tell the map its depth is sparse (WorldModel.navParams). */
  sparseNav = true;
  private tick = 0;
  /** Tracking was lost: old frames' poses can't be trusted against new ones. */
  lost(): void {
    this.stereo.reset();
  }
  /** Navigation for sparse (stereo) depth: see WorldModel.navParams. */
  static readonly NAV = { seenFreeMin: 1 };
  sense(world: WorldModel, cam: SimCamera): void {
    if (this.sparseNav && world.navParams.seenFreeMin === undefined) Object.assign(world.navParams, CameraDepthSource.NAV);
    // The tracker produces a pose every frame; the camera pipeline samples every `every` frames.
    const pose = this.sensor.trackedCamToWorld(cam);
    if (this.tick++ % this.every) return;
    this.stereo.push(this.camera.render(cam, pose));
    this.frames++;
    // Floor hypotheses at the detected floor plane's height, only where it
    // says there is floor. (Anchored to the plane, not to the game's floor
    // estimate: if that is wrong, depth "found" at the wrong height would
    // seem to confirm it and block the floor from ever being corrected.)
    const horiz = this.sensor.caps.planes ? this.sensor.planes(cam).filter((p) => p.normal.y > 0.85) : [];
    if (horiz.length) {
      const fy = Math.min(...horiz.map((p) => p.polygon[0].y));
      this.stereo.floorY = fy;
      this.stereo.floorRegion = horiz.filter((p) => Math.abs(p.polygon[0].y - fy) < 0.05).map((p) => p.polygon);
    } else {
      this.stereo.floorY = world.grid ? world.toTrackingPoint({ x: 0, y: world.floorY, z: 0 }).y : null;
      this.stereo.floorRegion = null;
    }
    const res = this.stereo.compute();
    this.last = res;
    if (!res) return;
    this.depthFrames++;
    world.ingestDepthImage(res.image, this.sensor.room.time);
  }
}

/** Feed one camera frame of simulated sensing into the world model. */
export function senseFrame(world: WorldModel, sensor: SimSensor, cam: SimCamera, depthRes?: [number, number], camera?: CameraDepthSource): void {
  if (sensor.caps.planes) for (const p of sensor.planes(cam)) world.ingestPlane(p);
  if (camera) camera.sense(world, cam);
  else if (sensor.caps.depth) {
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
export function scanRoomHuman(
  room: SimRoom,
  opts: { seed?: number; seconds?: number; noise?: NoiseName | NoiseProfile; world?: WorldModel; caps?: SensorCaps; cameraDepth?: boolean; camera?: Partial<CameraOptions>; stereo?: Partial<StereoOptions>; cameraEvery?: number } = {},
) {
  const world = opts.world ?? new WorldModel();
  const sensor = new SimSensor(room, opts.caps ?? { depth: true, planes: true, mesh: false }, opts.seed ?? 7, opts.noise ?? 'real');
  const camera = opts.cameraDepth ? new CameraDepthSource(room, sensor, { camera: opts.camera, stereo: opts.stereo, seed: opts.seed, every: opts.cameraEvery }) : undefined;
  world.setFloor(sensor.floorEstimate(), { x: 0, y: 0, z: 0 });
  const path = humanScanPath(room, opts.seed ?? 7, opts.seconds ?? 40);
  const eyes: Vec3[] = [];
  let frames = 0, dropped = 0, lost = false;
  for (const step of path) {
    room.time = step.t;
    const ok = sensor.trackingOk(step.angVel);
    if (sensor.trackingLost !== lost) {
      lost = sensor.trackingLost;
      world.noteTrackingEvent(step.t);
    }
    if (!ok) {
      dropped++;
      camera?.lost();
      continue;
    }
    senseFrame(world, sensor, step.cam, undefined, camera);
    world.refineFloor();
    frames++;
    if (frames % 10 === 0) eyes.push({ ...step.cam.pos });
  }
  return { world, sensor, eyes, frames, dropped, camera };
}

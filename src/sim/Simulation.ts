import * as THREE from 'three';
import type { HideAndSeek, GameOptions } from '../game/HideAndSeek';
import { petSamplePoints, type ViewPose } from '../game/Visibility';
import type { Animator } from '../pet/Animator';
import type { PetController } from '../pet/PetController';
import type { PetRig, PALETTES } from '../pet/PetModel';
import type { WorldModel } from '../world/WorldModel';
import { createStack } from '../game/stack';
import { roomFromName, type SimRoom } from './SimRoom';
import { cameraBasis, SimSensor, type NoiseName, type NoiseProfile, type SensorCaps, type SimCamera } from './SimSensor';
import { CameraDepthSource, senseFrame } from './scan';
import type { CameraOptions } from './CameraSim';
import type { StereoOptions } from '../world/StereoDepth';
import type { Vec3 } from '../core/math';

/**
 * Everything needed to run the app without a device: a simulated room, the
 * sensors a phone would have, the real world model, pet and game. Used by
 * node tests, the seeker bot and the browser's simulator mode.
 */
export interface SimOptions {
  room?: string | SimRoom;
  caps?: SensorCaps;
  game?: Partial<GameOptions>;
  seed?: number;
  /** Sense every N frames (depth integration is the expensive part). */
  senseEvery?: number;
  palette?: keyof typeof PALETTES;
  /** Sensor realism: 'ideal', 'arcore' or 'harsh' (or a custom profile). */
  noise?: NoiseName | NoiseProfile;
  /**
   * Where depth comes from: the depth-sensor model, or rendered camera images
   * through motion stereo (a phone without a depth sensor).
   */
  depthFrom?: 'sensor' | 'camera';
  camera?: Partial<CameraOptions>;
  stereo?: Partial<StereoOptions>;
}

export class Simulation {
  readonly room: SimRoom;
  readonly sensor: SimSensor;
  readonly world: WorldModel;
  readonly rig: PetRig;
  readonly anim: Animator;
  readonly pet: PetController;
  readonly game: HideAndSeek;
  readonly cam: SimCamera = { pos: { x: 0, y: 1.45, z: 0.6 }, yaw: 0, pitch: -0.45, fovY: 1.05, aspect: 0.6 };
  time = 0;
  private frame = 0;
  private senseEvery: number;
  /** Simulated sensing on/off (camera mode maps its invisible room once, then stops). */
  sensing = true;

  /**
   * Map the room from where the camera stands with a quick look around (a
   * few full turns at different tilts, as a smooth ~10Hz sweep so the pose
   * gate keeps every frame). Synchronous; advances simulation time.
   */
  primeMap(): void {
    const c = this.cam, yaw = c.yaw, pitch = c.pitch;
    for (const p of [-0.35, -0.7]) {
      c.pitch = p;
      for (let a = 0; a <= 36; a++) {
        c.yaw = (a / 36) * Math.PI * 2;
        this.time += 0.1;
        this.room.time = this.time;
        // Coarse depth is plenty for open floor, and 4x cheaper.
        senseFrame(this.world, this.sensor, c, [20, 15]);
      }
    }
    c.yaw = yaw;
    c.pitch = pitch;
  }

  constructor(opts: SimOptions = {}) {
    this.room = typeof opts.room === 'object' ? opts.room : roomFromName(opts.room ?? 'living');
    this.sensor = new SimSensor(this.room, opts.caps ?? { depth: true, planes: true, mesh: false }, opts.seed ?? 7, opts.noise ?? 'ideal');
    const stack = createStack({ seed: opts.seed, palette: opts.palette, game: opts.game });
    this.world = stack.world;
    this.rig = stack.rig;
    this.anim = stack.anim;
    this.pet = stack.pet;
    this.game = stack.game;
    this.world.setFloor(this.sensor.floorEstimate(), { x: 0, y: 0, z: 0 });
    if (this.sensor.caps.mesh) for (const m of this.sensor.meshes()) this.world.ingestMesh(m);
    this.senseEvery = opts.senseEvery ?? 3;
    if (opts.depthFrom === 'camera') this.camera = new CameraDepthSource(this.room, this.sensor, { camera: opts.camera, stereo: opts.stereo, seed: opts.seed, every: 1 });
  }
  /** Camera + motion-stereo depth, when simulating a phone without a depth sensor. */
  readonly camera: CameraDepthSource | null = null;

  /** Injected faults (see sim/Faults.ts). */
  readonly faults = { coveredUntil: -1, nanViewUntil: -1 };

  view(): ViewPose {
    if (this.time < this.faults.nanViewUntil) return { pos: { x: NaN, y: NaN, z: NaN }, forward: { x: NaN, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, fovY: this.cam.fovY, aspect: this.cam.aspect };
    const { forward, up } = cameraBasis(this.cam);
    return { pos: { ...this.cam.pos }, forward, up, fovY: this.cam.fovY, aspect: this.cam.aspect };
  }

  private trackingLost = false;
  private lastCam: SimCamera | null = null;
  sense(): void {
    // Tracking can drop out (fast turns, blur, featureless views); the device
    // reports it, and re-localises afterwards (sometimes with a jump).
    const prev = this.lastCam;
    const dt = this.senseEvery / 30;
    const angVel = prev ? Math.hypot(Math.atan2(Math.sin(this.cam.yaw - prev.yaw), Math.cos(this.cam.yaw - prev.yaw)), this.cam.pitch - prev.pitch) / dt : 0;
    this.lastCam = { ...this.cam, pos: { ...this.cam.pos } };
    const ok = this.sensor.trackingOk(angVel);
    // Blurred frames just get dropped; a real loss (and the relocalisation
    // after it) is what the device reports and what can move the world frame.
    const lost = this.sensor.trackingLost;
    if (lost !== this.trackingLost) {
      this.trackingLost = lost;
      this.world.noteTrackingEvent(this.room.time);
      if (lost) this.camera?.lost();
    }
    if (!ok) return;
    if (this.time < this.faults.coveredUntil) {
      // A hand over the lens / phone face down: everything ~15cm away.
      const img = this.sensor.depthImage(this.cam);
      img.depth.fill(0.15);
      this.camera?.lost();
      this.world.ingestDepthImage(img, this.room.time);
      return;
    }
    senseFrame(this.world, this.sensor, this.cam, undefined, this.camera ?? undefined);
  }

  /** Spawn the pet on the floor in front of the camera. */
  spawnPet(at?: Vec3): void {
    const { forward } = cameraBasis(this.cam);
    const p = at ?? { x: this.cam.pos.x + forward.x * 1.0, y: 0, z: this.cam.pos.z + forward.z * 1.0 };
    this.world.ingestHit(p);
    this.game.refreshNav(true);
    const nav = this.game.nav!;
    const n = nav.nearest(p, 1.0);
    const pos = n >= 0 ? nav.pos(n) : p;
    this.game.spawn(new THREE.Vector3(pos.x, pos.y, pos.z), new THREE.Vector3(this.cam.pos.x, 0, this.cam.pos.z));
  }

  step(dt: number): void {
    this.time += dt;
    this.room.time = this.time;
    if (this.sensing && this.frame++ % this.senseEvery === 0) this.sense();
    this.game.update(dt, this.view());
  }

  /**
   * Ground-truth visibility of the pet from the current camera: the same body
   * points and weights the game uses, occluded by the real room (no frustum).
   */
  truthVisibility(coreOnly = false): number {
    const v = this.view();
    let vis = 0, tot = 0;
    // Core body = head, neck, chest, hips (the first four samples).
    const pts = petSamplePoints(this.rig);
    for (const { p, w } of coreOnly ? pts.slice(0, 4) : pts) {
      tot += w;
      if (this.room.visible(v.pos, p)) vis += w;
    }
    return tot ? vis / tot : 0;
  }
}

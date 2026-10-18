import * as THREE from 'three';
import { HideAndSeek, type GameOptions } from '../game/HideAndSeek';
import type { ViewPose } from '../game/Visibility';
import { Animator } from '../pet/Animator';
import { PetController } from '../pet/PetController';
import { buildPet, type PetRig } from '../pet/PetModel';
import { WorldModel } from '../world/WorldModel';
import { roomFromName, type SimRoom } from './SimRoom';
import { cameraBasis, SimSensor, type SensorCaps, type SimCamera } from './SimSensor';
import { senseFrame } from './scan';
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
}

export class Simulation {
  readonly room: SimRoom;
  readonly sensor: SimSensor;
  readonly world = new WorldModel();
  readonly rig: PetRig;
  readonly anim: Animator;
  readonly pet: PetController;
  readonly game: HideAndSeek;
  readonly cam: SimCamera = { pos: { x: 0, y: 1.45, z: 0.6 }, yaw: 0, pitch: -0.45, fovY: 1.05, aspect: 0.6 };
  time = 0;
  private frame = 0;
  private senseEvery: number;

  constructor(opts: SimOptions = {}) {
    this.room = typeof opts.room === 'object' ? opts.room : roomFromName(opts.room ?? 'living');
    this.sensor = new SimSensor(this.room, opts.caps ?? { depth: true, planes: true, mesh: false }, opts.seed ?? 7);
    this.world.setFloor(0, { x: 0, y: 0, z: 0 });
    if (this.sensor.caps.mesh) for (const m of this.sensor.meshes()) this.world.ingestMesh(m);
    this.rig = buildPet('mint');
    this.anim = new Animator(this.rig, opts.seed ?? 1);
    this.pet = new PetController(this.rig, this.anim);
    this.game = new HideAndSeek(this.world, this.pet, this.anim, this.rig, { seed: opts.seed ?? 1, ...opts.game });
    this.senseEvery = opts.senseEvery ?? 3;
  }

  view(): ViewPose {
    const { forward, up } = cameraBasis(this.cam);
    return { pos: { ...this.cam.pos }, forward, up, fovY: this.cam.fovY, aspect: this.cam.aspect };
  }

  sense(): void {
    senseFrame(this.world, this.sensor, this.cam, [32, 24]);
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
    if (this.frame++ % this.senseEvery === 0) this.sense();
    this.game.update(dt, this.view());
  }

  /** Ground-truth visibility of the pet from the current camera (raycasting the real room). */
  truthVisibility(): number {
    let vis = 0, tot = 0;
    const v = this.view();
    this.rig.group.updateMatrixWorld(true);
    const p = new THREE.Vector3();
    for (const b of ['head', 'chest', 'hips', 'neck'] as const) {
      this.rig.bones[b].getWorldPosition(p);
      tot++;
      if (this.room.visible(v.pos, p)) vis++;
    }
    return vis / tot;
  }
}

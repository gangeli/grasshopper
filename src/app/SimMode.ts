import * as THREE from 'three';
import { Simulation } from '../sim/Simulation';
import { SeekerBot } from '../sim/SeekerBot';
import { cameraBasis } from '../sim/SimSensor';
import type { SimRoom } from '../sim/SimRoom';
import { clamp } from '../core/math';
import type { Hud } from './Hud';
import type { Stage } from './Stage';
import type { Voice } from './Voice';
import { GameUI } from './GameUI';

/**
 * Virtual-room mode: the same world model, pet and game, but the "camera
 * feed" is a rendered simulated room and the sensors are simulated. It is the
 * fallback for devices without WebXR AR (iPhone Safari, desktop) and the
 * harness for automated browser tests (?bot=1 lets the seeker bot play).
 */
export interface SimModeOptions {
  room: string;
  seed: number;
  bot: boolean;
  /** Simulation steps per rendered frame (fast-forward for tests). */
  speed: number;
  /** Fixed timestep (deterministic). */
  fixed: boolean;
}

export class SimMode {
  readonly sim: Simulation;
  readonly bot: SeekerBot | null;
  private ui: GameUI;
  private keys = new Set<string>();
  private lastT = 0;
  private drag: { x: number; y: number; id: number; move: boolean } | null = null;
  private joy: { x: number; y: number } = { x: 0, y: 0 };
  private roomGroup = new THREE.Group();
  frames = 0;
  onExit: (() => void) | null = null;

  constructor(readonly stage: Stage, readonly hud: Hud, readonly voice: Voice, readonly opts: SimModeOptions) {
    this.sim = new Simulation({ room: opts.room, seed: opts.seed });
    this.bot = opts.bot ? new SeekerBot(this.sim) : null;
    this.ui = new GameUI(this.sim, hud, voice);
    stage.scene.add(this.sim.rig.group);
    this.buildRoom(this.sim.room);
    stage.scene.add(this.roomGroup);
    stage.scene.background = new THREE.Color(0x202430);
    // In the simulator the rendered room already hides the pet; keep the
    // occluder only for the debug view.
    stage.occluder.mesh.visible = false;
    this.stage.hemi.intensity = 1.1;
  }

  start() {
    const hud = this.hud, game = this.sim.game;
    hud.on('play', () => game.start(this.sim.view()));
    hud.on('again', () => game.start(this.sim.view()));
    hud.on('exit', () => this.onExit?.());
    hud.on('debug', () => {
      this.stage.debug = !this.stage.debug;
      this.stage.occluder.mesh.visible = this.stage.debug;
      if (this.stage.debug) this.stage.updateOccluder(this.sim);
    });
    if (!this.bot) {
      hud.say('Virtual room: drag to look, WASD / left-thumb to walk, C to crouch. Hopper appears in a moment!', 7);
      this.bindControls();
    }
    this.stage.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private frame(t: number) {
    const real = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 1 / 60;
    this.lastT = t;
    const dt = this.opts.fixed ? 1 / 30 : real;
    for (let s = 0; s < this.opts.speed; s++) this.step(dt);
    this.frames++;
    const cam = this.stage.camera;
    const c = this.sim.cam;
    cam.position.set(c.pos.x, c.pos.y, c.pos.z);
    cam.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
    cam.fov = (c.fovY * 180) / Math.PI;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.stage.followPet(this.sim);
    this.stage.updateDebug(this.sim);
    if (this.stage.debug && this.frames % 30 === 0) this.stage.updateOccluder(this.sim);
    this.ui.update(cam);
    this.stage.render();
  }

  private step(dt: number) {
    const sim = this.sim;
    if (this.bot) {
      this.bot.step(dt);
      return;
    }
    this.move(dt);
    if (sim.game.phase === 'waiting' && sim.time > 1.5) sim.spawnPet();
    sim.step(dt);
  }

  /** Keep the simulator's camera aspect in sync with the window. */
  syncAspect() {
    this.sim.cam.aspect = window.innerWidth / window.innerHeight;
  }

  private move(dt: number) {
    const c = this.sim.cam;
    const { forward, right } = cameraBasis(c);
    let fx = 0, fz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) fz += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fz -= 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) fx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) fx += 1;
    fx += this.joy.x;
    fz += this.joy.y;
    const sp = 1.1;
    const fl = Math.hypot(forward.x, forward.z) || 1;
    let nx = c.pos.x + ((forward.x / fl) * fz + right.x * fx) * sp * dt;
    let nz = c.pos.z + ((forward.z / fl) * fz + right.z * fx) * sp * dt;
    const room = this.sim.room;
    nx = clamp(nx, -room.halfW + 0.2, room.halfW - 0.2);
    nz = clamp(nz, -room.halfD + 0.2, room.halfD - 0.2);
    // Don't walk through tall furniture (you can step "over" low things in a sim, that's fine).
    if (!room.solidAt({ x: nx, y: 1.0, z: nz }, 0.15)) {
      c.pos.x = nx;
      c.pos.z = nz;
    }
    const crouch = this.keys.has('c');
    c.pos.y += ((crouch ? 0.8 : 1.45) - c.pos.y) * Math.min(1, dt * 6);
    this.syncAspect();
  }

  private bindControls() {
    const canvas = this.stage.renderer.domElement;
    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      this.voice.unlock();
      // Left third of a touch screen is a virtual joystick.
      const move = e.pointerType === 'touch' && e.clientX < window.innerWidth * 0.33;
      this.drag = { x: e.clientX, y: e.clientY, id: e.pointerId, move };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (this.drag.move) {
        this.joy = { x: clamp(dx / 60, -1, 1), y: clamp(-dy / 60, -1, 1) };
        return;
      }
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      const c = this.sim.cam;
      c.yaw -= dx * 0.005;
      c.pitch = clamp(c.pitch - dy * 0.005, -1.4, 1.2);
    });
    const end = (e: PointerEvent) => {
      if (this.drag && e.pointerId === this.drag.id) {
        if (this.drag.move) this.joy = { x: 0, y: 0 };
        this.drag = null;
      }
    };
    canvas.addEventListener('pointerup', (e) => {
      end(e);
      // Click/tap on the pet.
      const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.stage.camera);
      this.sim.game.tapAt(ray.ray.origin, ray.ray.direction);
    });
    canvas.addEventListener('pointercancel', end);
  }

  private buildRoom(room: SimRoom) {
    const g = this.roomGroup;
    const floorTex = checkerTexture();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(room.width, room.depth).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }),
    );
    floorTex.repeat.set(room.width * 2, room.depth * 2);
    floor.receiveShadow = true;
    g.add(floor);
    const mats = new Map<number, THREE.MeshStandardMaterial>();
    for (const b of room.boxes) {
      let m = mats.get(b.color);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.8 });
        mats.set(b.color, m);
      }
      const size = new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), m);
      mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      mesh.castShadow = room.pieces[b.piece].label !== 'wall';
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    const lamp = new THREE.PointLight(0xfff2dd, 6, 8, 1.6);
    lamp.position.set(0, 2.2, 0);
    g.add(lamp);
  }
}

function checkerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#b89a78';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#a98b6a';
  x.fillRect(0, 0, 32, 32);
  x.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

import * as THREE from 'three';
import { applyPetEnvironment } from '../pet/lighting';
import { Simulation } from '../sim/Simulation';
import { SeekerBot } from '../sim/SeekerBot';
import { cameraBasis } from '../sim/SimSensor';
import { openRoom, type SimRoom } from '../sim/SimRoom';
import { clamp } from '../core/math';
import type { Hud } from './Hud';
import type { Stage } from './Stage';
import type { Voice } from './Voice';
import { GameUI } from './GameUI';
import type { CameraFeed } from './CameraFeed';

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
  /**
   * Camera mode: the live camera is the background and the phone's
   * orientation turns the view; the simulated room is empty and invisible
   * (there is no depth sensing to learn the real one).
   */
  camera?: CameraFeed;
}

export class SimMode {
  readonly sim: Simulation;
  readonly bot: SeekerBot | null;
  private ui: GameUI;
  private keys = new Set<string>();
  private lastT = 0;
  private drag: { x: number; y: number; x0: number; y0: number; t0: number; id: number; move: boolean; travel: number } | null = null;
  private joy: { x: number; y: number } = { x: 0, y: 0 };
  private roomGroup = new THREE.Group();
  frames = 0;
  private readonly camera: CameraFeed | null;
  private readonly _e = new THREE.Euler();
  onExit: (() => void) | null = null;

  constructor(readonly stage: Stage, readonly hud: Hud, readonly voice: Voice, readonly opts: SimModeOptions) {
    this.camera = opts.camera ?? null;
    // Camera mode: the player stands still (orientation-only tracking), so
    // Hopper keeps a bit further off, where a phone held normally sees it.
    this.sim = new Simulation({ room: this.camera ? openFloor() : opts.room, seed: opts.seed, game: this.camera ? { roamDistance: 1.8, eyeHeight: 1.35 } : undefined });
    this.bot = opts.bot ? new SeekerBot(this.sim) : null;
    this.ui = new GameUI(this.sim, hud, voice);
    // Spread drift checks over frames (a few ms each) instead of stalling one frame.
    this.sim.game.health.drift.budgetMs = 3;
    stage.scene.add(this.sim.rig.group);
    stage.setPetRig(this.sim.rig);
    const perf = stage.perf;
    perf.attachOverlay(hud.root);
    perf.instrument(this.sim.world, 'ingestDepthImage', 'world.ingestDepth');
    perf.instrument(this.sim.sensor, 'depthImage', 'sim.sensorDepth');
    perf.instrument(this.sim.game, 'update', 'game.update');
    perf.instrument(this.sim.game, 'refreshNav', 'game.refreshNav');
    perf.instrument(this.sim.game.health, 'update', 'game.health');
    perf.instrument(this.sim.anim, 'update', 'game.anim');
    perf.instrument(this.ui, 'update', 'ui');
    applyPetEnvironment(stage.renderer, this.sim.rig);
    if (this.camera) {
      // Video shows through the transparent canvas; keep the grounding shadow.
      stage.scene.background = null;
      stage.renderer.setClearColor(0x000000, 0);
      Object.assign(stage.renderer.domElement.style, { position: 'fixed', inset: '0', zIndex: '1' });
      this.sim.cam.pos.y = 1.35;
      // The invisible room never changes and the player can't walk around it:
      // map it once, then skip simulated sensing (the most expensive per-frame work).
      this.sim.primeMap();
      this.sim.sensing = false;
    } else {
      this.buildRoom(this.sim.room);
      // Look a little further down than the simulator's default, so Hopper
      // (1m ahead) appears mid-screen rather than behind the activities bar.
      if (!this.bot) this.sim.cam.pitch = -0.75;
      stage.scene.add(this.roomGroup);
      stage.scene.background = new THREE.Color(0x202430);
    }
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
    if (this.camera) {
      hud.say('Look around slowly so Hopper can settle in — it appears in a moment!', 7);
      this.bindControls();
      // No motion sensor (a laptop webcam): drag to look instead.
      setTimeout(() => {
        if (!this.camera!.hasOrientation) hud.say('No motion sensor here: drag to look around.', 6);
      }, 2500);
    } else if (!this.bot) {
      hud.say('Virtual room: drag to look, WASD / left-thumb to walk, C to crouch. Hopper appears in a moment!', 7);
      this.bindControls();
    }
    this.stage.renderer.setAnimationLoop((t) => this.frame(t));
  }

  private frame(t: number) {
    const perf = this.stage.perf;
    perf.beginFrame(t);
    try {
      this.frameBody(t);
    } finally {
      perf.endFrame();
    }
  }

  private frameBody(t: number) {
    const real = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 1 / 60;
    this.lastT = t;
    const dt = this.opts.fixed ? 1 / 30 : real;
    const t0 = performance.now();
    for (let s = 0; s < this.opts.speed; s++) this.step(dt);
    this.stage.perf.add('sim.step*', performance.now() - t0);
    this.frames++;
    const cam = this.stage.camera;
    const c = this.sim.cam;
    cam.position.set(c.pos.x, c.pos.y, c.pos.z);
    if (this.camera?.hasOrientation) {
      // The phone's full orientation (roll too, so the pet stays upright against the video).
      cam.quaternion.copy(this.camera.quaternion);
      cam.fov = this.camera.fovY;
    } else {
      cam.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
      cam.fov = this.camera ? this.camera.fovY : (c.fovY * 180) / Math.PI;
    }
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
    if (this.camera) {
      this.camera.update(dt);
      if (this.camera.hasOrientation) {
        // The game's camera follows where the phone points.
        this._e.setFromQuaternion(this.camera.quaternion, 'YXZ');
        sim.cam.yaw = this._e.y;
        sim.cam.pitch = clamp(this._e.x, -1.5, 1.5);
      }
      sim.cam.fovY = (this.camera.fovY * Math.PI) / 180;
      this.syncAspect();
    } else this.move(dt);
    if (sim.game.phase === 'waiting' && sim.time > 1.5) sim.spawnPet(this.camera ? this.spawnPoint() : undefined);
    sim.step(dt);
  }

  /** Camera mode: where the middle of the view meets the floor (1.2–2.2m away), so Hopper appears on screen. */
  private spawnPoint() {
    const c = this.sim.cam;
    const { forward } = cameraBasis(c);
    const fl = Math.hypot(forward.x, forward.z) || 1;
    const d = forward.y < -0.1 ? clamp(c.pos.y / -forward.y * fl, 1.2, 2.2) : 2;
    return { x: c.pos.x + (forward.x / fl) * d, y: 0, z: c.pos.z + (forward.z / fl) * d };
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
      const move = !this.camera && e.pointerType === 'touch' && e.clientX < window.innerWidth * 0.33;
      this.drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), id: e.pointerId, move, travel: 0 };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.travel = Math.max(this.drag.travel, Math.hypot(e.clientX - this.drag.x0, e.clientY - this.drag.y0));
      if (this.drag.move) {
        this.joy = { x: clamp(dx / 60, -1, 1), y: clamp(-dy / 60, -1, 1) };
        return;
      }
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.camera?.hasOrientation) return; // the phone itself is the look control
      const c = this.sim.cam;
      c.yaw -= dx * 0.005;
      c.pitch = clamp(c.pitch - dy * 0.005, -1.4, 1.2);
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (d && e.pointerId === d.id) {
        if (d.move) this.joy = { x: 0, y: 0 };
        this.drag = null;
        return d;
      }
      return null;
    };
    canvas.addEventListener('pointerup', (e) => {
      const d = end(e);
      // A tap (not a drag to look around, not the joystick): on Hopper, or a
      // spot for Hopper to go to.
      if (!d || d.move || d.travel > 12 || performance.now() - d.t0 > 700) return;
      this.tapScreen(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointercancel', end);
  }

  /** A tap at a screen point (CSS px): the game decides what it means. */
  tapScreen(x: number, y: number) {
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    this.stage.camera.updateMatrixWorld();
    ray.setFromCamera(ndc, this.stage.camera);
    return this.sim.game.tap(ray.ray.origin, ray.ray.direction);
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

/**
 * Camera mode's stand-in for the real room: open floor around the player,
 * bounded ~3m away so Hopper stays within sight of a player standing still.
 */
function openFloor(): SimRoom {
  return openRoom(6, 6);
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

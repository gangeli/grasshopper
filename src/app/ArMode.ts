import * as THREE from 'three';
import type { GameStack } from '../game/stack';
import { viewFromCamera, type ViewPose } from '../game/Visibility';
import type { DepthImage } from '../world/DepthFrame';
import { Recorder } from './Recorder';
import { DepthConsistency } from '../world/DepthFrame';
import type { Vec3 } from '../core/math';
import type { Hud } from './Hud';
import type { Stage } from './Stage';
import type { Voice } from './Voice';
import { GameUI } from './GameUI';
import { NavGrid } from '../world/NavGrid';
import { VoxelGrid } from '../world/VoxelGrid';
import { NavWorkerClient } from '../world/NavWorkerClient';
import { HIDE_SEEK_MIN_AREA } from '../game/Activities';
import {
  ErrorBudget,
  TrackingMonitor,
  anchorCorrection,
  classifyPlacement,
  classifyViewerPose,
  clampDt,
  isFiniteMatrix,
  isFiniteVec,
  rayToHeight,
  transformDelta,
  validView,
  type TrackSample,
} from './runtime';

/**
 * WebXR immersive-ar mode. Feeds every sensor stream the device offers into
 * the world model:
 *   - hit-test: placement reticle and floor height
 *   - plane-detection: floors, tables, walls (ARCore, Quest, Vision Pro)
 *   - mesh-detection: full room mesh (Quest 3 scene mesh)
 *   - depth-sensing (cpu): per-pixel depth → occupancy + free space (ARCore)
 *   - anchors: drift correction of the map frame (world.setAnchorCorrection)
 * Rendering: three.js XR, the occupancy occluder, and GPU depth occlusion when
 * the device provides it.
 *
 * Self-protection (a real phone in a real room misbehaves): the game freezes
 * while tracking is lost or the session is hidden/blurred and resumes after a
 * settle period; frame time is clamped; view poses are validated before the
 * game sees them; every part of the frame loop is isolated so an exception
 * never kills the loop, and repeated game errors trigger an automatic
 * recovery. The user always has two escape hatches: "move" (place Hopper
 * again; a different floor height relevels the map) and "rescan" (forget the
 * map, keep playing).
 */
type Hit = { pos: THREE.Vector3; normal: THREE.Vector3; matrix: THREE.Matrix4; fallback: boolean };

export class ArMode {
  session: XRSession | null = null;
  private hitSource: XRHitTestSource | null = null;
  private hitSourcePending = false;
  private hitSourceRetryT = 0;
  private refSpace: XRReferenceSpace | null = null;
  private useFloorSpace = false;
  private frameNo = 0;
  // Weak: the device drops plane/mesh objects as it merges and replaces them.
  private planeTimes = new WeakMap<XRPlane, number>();
  private meshTimes = new WeakMap<XRMesh, number>();
  private planeIngestAt = new WeakMap<XRPlane, number>();
  private lastHit: Hit | null = null;
  private ui: GameUI;
  private lastT = 0;
  private now = 0;
  private startT = -1;
  private lastRealHitT = -1;
  /** Floor height estimate in the tracking frame from detected planes (before/independent of the map). */
  private planeFloorY: number | null = null;
  readonly tracking = new TrackingMonitor();
  readonly errors = new ErrorBudget(3);
  private gameErrors = new ErrorBudget(2);
  private autoLevel = 0;
  private lastAutoRecoverT = -Infinity;
  private sessionVisibility: XRVisibilityState = 'visible';
  private wasPaused = false;
  /** In a tracking-loss episode reported to the world (noteTrackingEvent). */
  private lossNoted = false;
  private lastJumps = 0;
  /** Re-placing Hopper (the "move" button). */
  replacing = false;
  private pendingRaised: { y: number; t: number } | null = null;
  private mappingSince = 0;
  private lastTipT = 0;
  private tipNo = 0;
  private noHitTold = false;
  private lastGoodPet: THREE.Vector3 | null = null;
  private emptySince = -1;
  private anchor: XRAnchor | null = null;
  private anchorA0: number[] | null = null;
  private lastCorrection: number[] | null = null;
  /** Diagnostics exposed for tests/debug overlay. */
  readonly stats = {
    planes: 0,
    meshes: 0,
    depthFrames: 0,
    depthRejected: 0,
    depthEmpty: 0,
    /** CPU depth delivered only empty frames for a while (mapping falls back to planes + hit-test). */
    depthDead: false,
    depthUsage: '' as string,
    refSpace: '' as string,
    frames: 0,
    gameUpdates: 0,
    frozenFrames: 0,
    pausedFrames: 0,
    invalidViews: 0,
    maxDt: 0,
    errors: 0,
    lastError: '',
    autoRecoveries: 0,
    petResets: 0,
    placements: 0,
    replacements: 0,
    relevels: 0,
    rescans: 0,
    hitFallback: false,
    anchor: 'none' as string,
    anchorUpdates: 0,
    anchorCorrection: null as number[] | null,
    /** noteTrackingEvent calls (loss + regain). */
    trackingEvents: 0,
  };
  onExit: ((reason?: string) => void) | null = null;
  /** Session recorder (?record=1): depth + poses for offline evaluation. */
  readonly recorder = new URLSearchParams(location.search).get('record') === '1' ? new Recorder() : null;

  constructor(readonly stage: Stage, readonly stack: GameStack, readonly hud: Hud, readonly voice: Voice) {
    this.ui = new GameUI(stack, hud, voice);
    // Spread drift checks over frames (a few ms each) instead of stalling one frame.
    stack.game.health.drift.budgetMs = 3;
    // WebXR depth is densified with no confidence: surfaces the sensor can't
    // see (dark fabric, glass) get interpolated, which can carve phantom free
    // space through a couch. Keep only depth that another recent view agrees
    // with (on real camera data: phantoms 31% → 10%, real objects intruding
    // into walkable space 2.1% → 0.3%).
    stack.world.multiView = new DepthConsistency();
    // Profiler (?perf=1): the overlay must live in the dom-overlay root to show in AR.
    const perf = stage.perf;
    perf.attachOverlay(hud.root);
    perf.instrument(stack.world, 'ingestDepthImage', 'world.ingestDepth');
    perf.instrument(stack.world, 'ingestPlane', 'world.ingestPlane');
    perf.instrument(stack.world, 'ingestMesh', 'world.ingestMesh');
    perf.instrument(stack.game, 'refreshNav', 'game.refreshNav');
    perf.instrument(NavGrid.prototype, 'build', 'nav.build');
    perf.instrument(VoxelGrid.prototype, 'updateShadow', 'grid.updateShadow');
    perf.instrument(NavWorkerClient.prototype, 'request', 'nav.worker request');
    perf.instrument(NavWorkerClient.prototype, 'receive', 'nav.worker install');
    perf.instrument(stack.game.health, 'update', 'game.health');
    perf.instrument(stack.anim, 'update', 'game.anim');
    perf.instrument(stack.pet, 'update', 'game.pet');
    perf.instrument(stack.game, 'start', 'game.start(plan)');
    perf.instrument(stage, 'updateOccluder', 'occluder');
    perf.instrument(this.ui, 'update', 'ui');
  }

  static async supported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'));
    } catch {
      return false;
    }
  }

  /** True while the session is hidden/blurred or the page is in the background: no game updates. */
  get paused(): boolean {
    return this.sessionVisibility !== 'visible' || document.visibilityState === 'hidden';
  }

  async start(): Promise<void> {
    const xr = navigator.xr!;
    const init: XRSessionInit & Record<string, unknown> = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'dom-overlay', 'plane-detection', 'mesh-detection', 'depth-sensing', 'anchors', 'light-estimation'],
      domOverlay: { root: this.hud.root },
      depthSensing: { usagePreference: ['cpu-optimized', 'gpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
    };
    const session = await xr.requestSession('immersive-ar', init);
    this.session = session;
    const r = this.stage.renderer;
    // Register 'end' first: if anything below fails we end the session and
    // land back on the start page instead of sitting in a broken AR view.
    session.addEventListener('end', () => {
      this.session = null;
      r.setAnimationLoop(null);
      this.onExit?.();
    });
    try {
      const enabled: readonly string[] = (session as unknown as { enabledFeatures?: string[] }).enabledFeatures ?? [];
      // Some runtimes don't report enabledFeatures: try local-floor and fall back to local.
      this.useFloorSpace = enabled.length ? enabled.includes('local-floor') : await session.requestReferenceSpace('local-floor').then(() => true, () => false);
      r.xr.enabled = true;
      // ?xrscale=0.5..1: fixed XR framebuffer scale (the governor scales the viewport within it).
      const xrScale = Number(new URLSearchParams(location.search).get('xrscale'));
      if (xrScale >= 0.25 && xrScale <= 1) r.xr.setFramebufferScaleFactor(xrScale);
      r.xr.setReferenceSpaceType(this.useFloorSpace ? 'local-floor' : 'local');
      this.stats.refSpace = this.useFloorSpace ? 'local-floor' : 'local';
      // Set the loop before the session: three.js then drives it from the XR
      // session (calling it after would start a second, frame-less loop).
      r.setAnimationLoop((t, frame) => {
        try {
          this.onFrame(t, frame);
        } catch (e) {
          // Last line of defence; onFrame isolates its parts itself.
          this.recordError('frame', e);
        }
      });
      await r.xr.setSession(session);
      this.refSpace = r.xr.getReferenceSpace();
      this.stats.depthUsage = (() => {
        // Without the feature some runtimes still report a usage; getDepthInformation would throw.
        if (enabled.length && !enabled.includes('depth-sensing')) return '';
        try {
          return (session as unknown as { depthUsage?: string }).depthUsage ?? '';
        } catch {
          return ''; // depth-sensing not enabled: the getter throws on some runtimes
        }
      })();
    } catch (e) {
      try {
        await session.end();
      } catch {
        /* already ended */
      }
      throw e;
    }
    await this.requestHitSource();
    session.addEventListener('select', (e) => {
      try {
        this.onSelect(e as XRInputSourceEvent);
      } catch (err) {
        this.recordError('select', err);
      }
    });
    session.addEventListener('visibilitychange', () => {
      this.sessionVisibility = session.visibilityState;
    });
    // Backgrounded: frames usually stop entirely, so no frame sees the paused
    // state. Coming back, let tracking settle before the game moves again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.tracking.reset();
    });
    this.hud.on('play', () => this.startRound());
    this.hud.on('again', () => this.startRound());
    this.hud.on('exit', () => {
      // Offer the recording before leaving.
      if (this.recorder && this.recorder.count) this.recorder.download();
      void session.end().catch(() => this.onExit?.());
    });
    this.hud.on('debug', () => (this.stage.debug = !this.stage.debug));
    this.hud.on('move', () => this.toggleReplace());
    this.hud.on('rescan', () => this.rescan());
    this.hud.showPlaceHint(true, 'Point at the floor and tap to place Hopper');
    this.hud.say('Move your phone slowly so I can see the floor…', 6);
  }

  private async requestHitSource() {
    const session = this.session;
    if (!session || this.hitSource || this.hitSourcePending) return;
    this.hitSourcePending = true;
    try {
      const viewer = await session.requestReferenceSpace('viewer');
      this.hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    } catch (e) {
      this.recordError('hit-test source', e);
    } finally {
      this.hitSourcePending = false;
    }
  }

  private recordError(where: string, e: unknown) {
    this.errors.record(this.now, where, e);
    this.stats.errors = this.errors.total;
    this.stats.lastError = this.errors.last;
  }

  /** Run one part of the frame; an exception is logged and counted, never propagated. */
  private guard(where: string, fn: () => void): boolean {
    const t0 = performance.now();
    try {
      fn();
      return true;
    } catch (e) {
      this.recordError(where, e);
      return false;
    } finally {
      this.stage.perf.add(`${where}*`, performance.now() - t0);
    }
  }

  private get placing(): boolean {
    return this.stack.game.phase === 'waiting' || this.replacing;
  }

  private camPos(): THREE.Vector3 {
    const cam = this.stage.renderer.xr.getCamera();
    cam.updateMatrixWorld();
    return new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  }

  /** A validated view of the current camera, or null when it can't be trusted. */
  private currentView(): ViewPose | null {
    if (this.paused || this.tracking.frozen) return null;
    const v = viewFromCamera(this.stage.renderer.xr.getCamera());
    return validView(v) ? v : null;
  }

  private startRound() {
    const view = this.currentView();
    if (!view) {
      this.hud.say('Hold on — I can’t see where you are right now. Move slowly and point at the room.', 4);
      return;
    }
    this.stack.game.start(view);
  }

  private toggleReplace() {
    const { game, world } = this.stack;
    if (!world.ready || game.phase === 'waiting') {
      this.hud.say('Point at the floor and tap to place Hopper.', 3);
      return;
    }
    if (game.phase === 'countdown') return;
    this.replacing = !this.replacing;
    this.pendingRaised = null;
    if (this.replacing) {
      this.hud.showPlaceHint(true, 'Tap the floor where Hopper should be');
      this.hud.say('Point at the floor and tap where Hopper should go.', 4);
    } else {
      this.hud.showPlaceHint(false);
      this.stage.reticle.visible = false;
    }
  }

  /** Escape hatch: forget the depth map (floor and planes stay) and keep playing. */
  rescan() {
    const { game, world } = this.stack;
    if (!world.ready) {
      this.hud.say('Tap the floor to place Hopper first.', 3);
      return;
    }
    this.guard('rescan', () => {
      world.hardReset();
      this.afterMapRebuilt();
      this.stats.rescans++;
      this.mappingSince = this.now;
      this.lastTipT = this.now;
      this.hud.say('Okay, I forgot the map. Look around slowly so I can learn the room again.', 6);
      if (game.phase === 'seek' || game.phase === 'countdown') this.hud.say('Map cleared — keep looking for Hopper!', 5);
    });
  }

  /** The world replaced its grid: drop everything derived from the old one. */
  private afterMapRebuilt() {
    const { game } = this.stack;
    // The nav grid holds a reference to the old voxel grid.
    game.nav = null;
    game.refreshNav(true);
    this.stage.updateOccluder(this.stack);
  }

  private onSelect(e: XRInputSourceEvent) {
    const frame = e.frame;
    const { game } = this.stack;
    this.voice.unlock();
    if (this.paused) return;
    if (this.placing) {
      this.tryPlace(frame);
      return;
    }
    // Tap on the pet (a reaction, or "found" while seeking) or on the floor
    // (Hopper goes there); the screen tap's ray goes through the tapped pixel.
    if (this.tracking.frozen || !this.refSpace) return;
    const pose = frame.getPose(e.inputSource.targetRaySpace, this.refSpace);
    if (!pose || !isFiniteMatrix(pose.transform.matrix)) return;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    game.tapAt(origin, dir);
  }

  private floorHintY(): number | null {
    if (this.planeFloorY !== null) return this.planeFloorY;
    return this.useFloorSpace ? 0 : null;
  }

  private tryPlace(frame: XRFrame) {
    if (this.tracking.frozen) {
      this.hud.say('Hold on — I’ve lost track of the room. Move slowly and point at a textured area.', 4);
      return;
    }
    const hit = this.lastHit;
    if (!hit) {
      this.hud.say('I can’t see the floor there yet — point your phone at the floor and move it slowly.', 4);
      return;
    }
    const camY = this.camPos().y;
    const v = classifyPlacement(hit, camY, this.floorHintY());
    if (!v.ok) {
      const p = this.pendingRaised;
      const confirmed = v.reason === 'raised' && p && Math.abs(p.y - hit.pos.y) < 0.08 && this.now - p.t < 8;
      if (!confirmed) {
        if (v.reason === 'raised') this.pendingRaised = { y: hit.pos.y, t: this.now };
        this.hud.say(v.message, 5);
        return;
      }
    }
    this.pendingRaised = null;
    this.place(hit, frame);
  }

  private place(hit: Hit, frame: XRFrame) {
    const { game, world } = this.stack;
    const camT = this.camPos();
    if (!world.ready) {
      const { pos, normal } = hit;
      world.setFloor(pos.y, pos);
      world.ingestHit(pos, normal);
      this.createAnchor(frame, pos);
      game.refreshNav(true);
      game.spawn(pos.clone(), camT);
      this.stats.placements++;
    } else {
      // The map lives in the (anchor-corrected) map frame.
      const pm = this.stage.trackingToMap(hit.pos);
      const camM = this.stage.trackingToMap(camT);
      if (Math.abs(pm.y - world.floorY) > 0.04) {
        // The first tap was on the wrong surface (or tracking moved the
        // floor): rebuild the map at the new floor height.
        world.relevelFloor(pm.y);
        this.stats.relevels++;
      }
      world.ingestHit(hit.pos, hit.normal);
      this.afterMapRebuilt();
      game.respawn(pm, camM);
      this.stats.replacements++;
    }
    this.lastGoodPet = game.pet.pos.clone();
    this.replacing = false;
    this.mappingSince = this.now;
    this.lastTipT = this.now;
    this.hud.showPlaceHint(false);
    this.stage.reticle.visible = false;
  }

  private createAnchor(frame: XRFrame, pos: Vec3) {
    const create = (frame as unknown as { createAnchor?: (pose: XRRigidTransform, space: XRSpace) => Promise<XRAnchor> | undefined }).createAnchor;
    if (!create || !this.refSpace || typeof XRRigidTransform === 'undefined') {
      this.stats.anchor = 'unsupported';
      return;
    }
    try {
      const p = create.call(frame, new XRRigidTransform({ x: pos.x, y: pos.y, z: pos.z }), this.refSpace);
      this.stats.anchor = 'pending';
      Promise.resolve(p).then(
        (a) => {
          if (!a) return void (this.stats.anchor = 'failed');
          this.anchor = a;
          this.stats.anchor = 'created';
        },
        () => (this.stats.anchor = 'failed'),
      );
    } catch {
      this.stats.anchor = 'failed';
    }
  }

  private onFrame(t: number, frame?: XRFrame) {
    if (!frame) return; // only render from the XR session's frames
    const perf = this.stage.perf;
    perf.beginFrame(t);
    try {
      this.frameBody(t, frame);
    } finally {
      perf.endFrame();
    }
  }

  private frameBody(t: number, frame: XRFrame) {
    const dt = clampDt(this.lastT, t);
    this.lastT = t;
    this.now = t / 1000;
    if (this.startT < 0) this.startT = this.now;
    this.frameNo++;
    this.stats.frames++;
    this.stats.maxDt = Math.max(this.stats.maxDt, dt);
    const { game, world } = this.stack;
    const cam = this.stage.renderer.xr.getCamera();

    // 1. Tracking and visibility. Nothing below may use a pose we don't trust.
    const paused = this.paused;
    if (paused) this.stats.pausedFrames++;
    else if (this.wasPaused) this.tracking.reset(); // settle after resume
    this.wasPaused = paused;
    if (!paused) {
      let sample: TrackSample = 'invalid';
      let vpos: Vec3 | undefined;
      this.guard('viewer pose', () => {
        const vp = this.refSpace ? frame.getViewerPose(this.refSpace) : null;
        // Render resolution from the quality governor (dynamic viewport scaling, where supported).
        this.stage.quality.applyViewportScale(vp?.views);
        sample = classifyViewerPose(vp);
        if (sample === 'ok') {
          const m = vp!.transform.matrix;
          vpos = { x: m[12], y: m[13], z: m[14] };
        }
      });
      this.tracking.update(this.now, sample, vpos);
      this.noteTracking(frame);
    }
    let view: ViewPose | null = null;
    if (!paused && !this.tracking.frozen)
      this.guard('view', () => {
        const v = viewFromCamera(cam);
        if (validView(v)) view = v;
        else this.stats.invalidViews++;
      });

    // 2. Sensors: only with good tracking (depth under bad tracking paints garbage).
    if (view && this.refSpace) {
      this.guard('hit-test', () => this.updateHitTest(frame));
      if (this.frameNo % 10 === 0) this.guard('planes', () => this.ingestPlanes(frame));
      if (world.ready) {
        if (this.frameNo % 30 === 0) this.guard('meshes', () => this.ingestMeshes(frame));
        if (this.frameNo % 4 === 0) this.guard('depth', () => this.ingestDepth(frame));
        this.guard('anchor', () => this.updateAnchor(frame));
      }
    } else {
      this.lastHit = null;
      this.stage.reticle.visible = false;
    }

    // 3. Game: frozen (not updated) while tracking is bad or the app is paused.
    if (game.phase !== 'waiting') {
      if (view) {
        const ok = this.guard('game', () => {
          game.update(dt, view!);
          this.stats.gameUpdates++;
        });
        if (!ok) this.gameErrors.record(this.now, 'game', this.stats.lastError);
        this.guard('pet check', () => this.checkPet());
        this.guard('stage', () => {
          this.stage.followPet(this.stack);
          // Occluder meshing takes tens of ms on a phone: refresh every ~2s while the
          // map grows, less often once a round is under way (in the nav worker).
          if (this.frameNo % (game.phase === 'roam' ? 120 : 300) === 0) this.stage.updateOccluder(this.stack, true);
          this.stage.updateDebug(this.stack);
        });
        this.maybeAutoRecover();
      } else this.stats.frozenFrames++;
    }

    // 4. HUD, then render — always, whatever failed above.
    this.guard('ui', () => {
      this.ui.update(cam);
      this.updateAlert();
      this.updateGuidance();
      this.hud.showTools(world.ready && game.phase !== 'countdown', this.replacing ? 'cancel' : 'move');
    });
    this.guard('render', () => {
      this.stage.syncMapFrame(world);
      this.stage.render();
    });
  }

  /**
   * Tell the world model when tracking is lost (null / orientation-only /
   * broken pose, or a relocalisation jump) and when it is regained (after the
   * settle period): it snapshots the map at the loss and checks for a
   * relocalisation jump afterwards.
   */
  private noteTracking(frame: XRFrame) {
    const note = (this.stack.world as unknown as { noteTrackingEvent?: (t: number) => void }).noteTrackingEvent;
    const t = frame.predictedDisplayTime / 1000;
    const jumped = this.tracking.jumps !== this.lastJumps;
    this.lastJumps = this.tracking.jumps;
    const bad = this.tracking.frozen && (this.tracking.badFor > 0 || jumped || this.lossNoted);
    if (!this.lossNoted && this.tracking.frozen && (jumped || this.tracking.losses > this.lossesNoted)) {
      this.lossNoted = true;
      this.lossesNoted = this.tracking.losses;
      this.stats.trackingEvents++;
      if (Number.isFinite(t)) note?.call(this.stack.world, t);
    } else if (this.lossNoted && !bad) {
      this.lossNoted = false;
      this.stats.trackingEvents++;
      if (Number.isFinite(t)) note?.call(this.stack.world, t);
    }
  }
  private lossesNoted = 0;

  /** The pet must stay finite: if the game ever produces NaN, put it back where it last was fine. */
  private checkPet() {
    const { game, pet } = this.stack;
    if (isFiniteVec(pet.pos)) {
      if (!this.lastGoodPet) this.lastGoodPet = pet.pos.clone();
      else this.lastGoodPet.copy(pet.pos);
      return;
    }
    this.stats.petResets++;
    const at = this.lastGoodPet ?? new THREE.Vector3(0, this.stack.world.floorY, 0);
    game.respawn(at.clone(), this.stage.trackingToMap(this.camPos()));
  }

  /**
   * game.update keeps throwing (a bug meeting a state we didn't foresee):
   * rebuild the derived state, then the map, so the session never stays
   * broken. Escalates at most every 8s.
   */
  private maybeAutoRecover() {
    const now = this.now;
    if (now - this.lastAutoRecoverT > 30) this.autoLevel = 0;
    if (this.gameErrors.recent(now) < 30 || now - this.lastAutoRecoverT < 8) return;
    this.lastAutoRecoverT = now;
    this.stats.autoRecoveries++;
    const level = this.autoLevel++;
    this.gameErrors.clear();
    const { game, world } = this.stack;
    console.warn(`[hopper] game keeps failing; automatic recovery level ${level}`);
    this.guard('auto-recover', () => {
      if (level >= 1 && world.ready) world.hardReset();
      this.afterMapRebuilt();
      const at = this.lastGoodPet ?? new THREE.Vector3(0, world.floorY, 0);
      game.respawn(at.clone(), this.stage.trackingToMap(this.camPos()));
    });
    this.hud.say(level ? 'Oops, I got muddled — I’m relearning the room. Look around slowly.' : 'Oops, I got muddled. Let’s carry on!', 5);
  }

  private updateAlert() {
    const hud = this.hud;
    if (this.paused) hud.setAlert('Paused');
    else if (this.tracking.showLost) hud.setAlert('Tracking lost — move slowly and point at a textured area');
    else if (this.errors.recent(this.now) >= 10) hud.setAlert('Something’s not right — if Hopper looks stuck, tap “move” or “↻ rescan”');
    else hud.setAlert(null);
  }

  /** Placement and mapping guidance when things don't progress. */
  private updateGuidance() {
    const { game } = this.stack;
    const now = this.now;
    if (this.placing) {
      const since = now - (this.lastRealHitT >= 0 ? this.lastRealHitT : this.startT);
      const base = this.replacing ? 'Tap the floor where Hopper should be' : 'Point at the floor and tap to place Hopper';
      if (this.lastHit?.fallback) this.hud.showPlaceHint(true, `${base} (floor estimated)`);
      else if (!this.lastHit && since > 4) this.hud.showPlaceHint(true, 'Looking for the floor… point at it and move your phone slowly');
      else this.hud.showPlaceHint(true, base);
      if (!this.lastHit && since > 10 && !this.noHitTold) {
        this.noHitTold = true;
        this.hud.say('I can’t find the floor yet. Point at the floor, move slowly, and turn on more light if it’s dark.', 7);
      }
      if (this.lastHit) this.noHitTold = false;
      return;
    }
    if (game.phase === 'roam' && game.mappedArea() < HIDE_SEEK_MIN_AREA && now - this.mappingSince > 30 && now - this.lastTipT > 30) {
      this.lastTipT = now;
      const noDepth = this.stats.depthUsage !== 'cpu-optimized' || this.stats.depthDead;
      const tips = noDepth
        ? ['Sweep your phone slowly over the floor so I can see where I can hop.', 'Walk around slowly and point at the floor around furniture.']
        : ['Walk around slowly and look at the floor and under tables so I can learn the room.', 'Point your phone at the floor around furniture — I need a bit more of the room.'];
      this.hud.say(tips[this.tipNo++ % tips.length], 7);
    }
  }

  private updateHitTest(frame: XRFrame) {
    if (!this.hitSource && this.now > this.hitSourceRetryT) {
      this.hitSourceRetryT = this.now + 2;
      void this.requestHitSource();
    }
    const results = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
    const pose = results[0]?.getPose(this.refSpace!);
    const ret = this.stage.reticle;
    let hit: Hit | null = null;
    if (pose && isFiniteMatrix(pose.transform.matrix)) {
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      hit = { pos: new THREE.Vector3().setFromMatrixPosition(m), normal: new THREE.Vector3(0, 1, 0).transformDirection(m), matrix: m, fallback: false };
      this.lastRealHitT = this.now;
      if (this.stack.world.ready) this.stack.world.ingestHit(hit.pos, hit.normal);
    } else if (this.placing && this.now - (this.lastRealHitT >= 0 ? this.lastRealHitT : this.startT) > 12) {
      // Hit-test never answers (textureless floor, unsupported surface): place
      // on the floor estimate from planes / local-floor instead of being stuck.
      const h = this.floorHintY();
      const cam = this.stage.renderer.xr.getCamera();
      const o = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      const d = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
      const p = h === null ? null : rayToHeight(o, d, h);
      if (p) {
        const pos = new THREE.Vector3(p.x, p.y, p.z);
        hit = { pos, normal: new THREE.Vector3(0, 1, 0), matrix: new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z), fallback: true };
        this.stats.hitFallback = true;
      }
    }
    this.lastHit = hit;
    if (!hit || !this.placing) {
      ret.visible = false;
      return;
    }
    // Colour the reticle by what a tap would do: white = floor, amber = raised, red = refused.
    const v = classifyPlacement(hit, this.camPos().y, this.floorHintY());
    (ret.material as THREE.MeshBasicMaterial).color.set(v.ok ? 0xffffff : v.reason === 'raised' ? 0xffc04d : 0xff5a4a);
    ret.visible = true;
    ret.matrix.copy(hit.matrix);
  }

  private ingestPlanes(frame: XRFrame) {
    const planes = (frame as unknown as { detectedPlanes?: Set<XRPlane> }).detectedPlanes;
    if (!planes) return;
    this.stats.planes = planes.size;
    const ready = this.stack.world.ready;
    let floorLabelled: number | null = null, lowest: number | null = null;
    const camY = this.camPos().y;
    for (const plane of planes) {
      const pose = frame.getPose(plane.planeSpace, this.refSpace!);
      if (!pose || !isFiniteMatrix(pose.transform.matrix)) continue;
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const n = new THREE.Vector3(0, 1, 0).transformDirection(m);
      const label = (plane as unknown as { semanticLabel?: string }).semanticLabel;
      // Floor height hint for placement checks (tracking frame).
      if (n.y > 0.9) {
        const y = m.elements[13];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of plane.polygon) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
        const area = (maxX - minX) * (maxZ - minZ);
        if (label === 'floor') floorLabelled = floorLabelled === null ? y : Math.min(floorLabelled, y);
        else if (area > 0.25 && y < camY - 0.5) lowest = lowest === null ? y : Math.min(lowest, y);
      }
      if (!ready || this.planeTimes.get(plane) === plane.lastChangedTime) continue;
      // ARCore refines plane outlines nearly every frame; re-rasterizing each
      // change cost ~1.4ms/frame on phones. Planes evolve slowly: twice a second is plenty.
      const now = performance.now();
      if (now - (this.planeIngestAt.get(plane) ?? -Infinity) < 500) continue;
      this.planeIngestAt.set(plane, now);
      this.planeTimes.set(plane, plane.lastChangedTime);
      const polygon: Vec3[] = plane.polygon.map((p) => {
        const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m);
        return { x: v.x, y: v.y, z: v.z };
      });
      this.stack.world.ingestPlane({ id: `p${planeId(plane)}`, polygon, normal: { x: n.x, y: n.y, z: n.z }, label });
    }
    this.planeFloorY = floorLabelled ?? lowest;
    // Surfaces the device no longer reports are forgotten (checked now and then; cheap).
    if (++this.surfaceSweep % 60 === 0) {
      const live = new Set<string>();
      for (const plane of planes) live.add(`p${planeId(plane)}`);
      this.stack.world.forgetSurfaces({ planes: live });
    }
  }
  private surfaceSweep = 0;
  private meshSweep = 0;

  private ingestMeshes(frame: XRFrame) {
    const meshes = (frame as unknown as { detectedMeshes?: Set<XRMesh> }).detectedMeshes;
    if (!meshes) return;
    this.stats.meshes = meshes.size;
    if (++this.meshSweep % 60 === 0) {
      const live = new Set<string>();
      for (const mesh of meshes) live.add(`m${planeId(mesh)}`);
      this.stack.world.forgetSurfaces({ meshes: live });
    }
    for (const mesh of meshes) {
      if (this.meshTimes.get(mesh) === mesh.lastChangedTime) continue;
      const pose = frame.getPose(mesh.meshSpace, this.refSpace!);
      if (!pose || !isFiniteMatrix(pose.transform.matrix)) continue;
      this.meshTimes.set(mesh, mesh.lastChangedTime);
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const v = mesh.vertices;
      const out = new Float32Array(v.length);
      const tmp = new THREE.Vector3();
      for (let i = 0; i < v.length; i += 3) {
        tmp.set(v[i], v[i + 1], v[i + 2]).applyMatrix4(m);
        out[i] = tmp.x;
        out[i + 1] = tmp.y;
        out[i + 2] = tmp.z;
      }
      const label = (mesh as unknown as { semanticLabel?: string }).semanticLabel;
      this.stack.world.ingestMesh({ id: `m${planeId(mesh)}`, positions: out, indices: mesh.indices, label });
    }
  }

  private ingestDepth(frame: XRFrame) {
    if (this.stats.depthUsage !== 'cpu-optimized') return;
    const viewerPose = frame.getViewerPose(this.refSpace!);
    const view = viewerPose?.views[0];
    if (!view || !isFiniteMatrix(view.transform.matrix)) return;
    let info: XRCPUDepthInformation | null = null;
    try {
      info = (frame as unknown as { getDepthInformation(v: XRView): XRCPUDepthInformation | null }).getDepthInformation(view);
    } catch {
      return;
    }
    if (!info) return;
    this.stats.depthFrames++;
    // Same front end as the simulator: discontinuity filter + tracking gate.
    const t0 = performance.now();
    const img = sampleDepthImage(info, view, 40, 30);
    this.stage.perf.add('depth.sample', performance.now() - t0);
    let valid = 0;
    for (let q = 0; q < img.depth.length; q++) if (img.depth[q] > 0) valid++;
    if (valid < img.depth.length * 0.01) {
      // All-zero frames (sensor warming up, covered, unsupported format):
      // mapping carries on from planes + hit-test.
      this.stats.depthEmpty++;
      if (this.emptySince < 0) this.emptySince = this.now;
      else if (this.now - this.emptySince > 4) this.stats.depthDead = true;
      return;
    }
    this.emptySince = -1;
    this.stats.depthDead = false;
    const emulated = !!viewerPose?.emulatedPosition;
    if (this.recorder && !emulated) this.recorder.add(img, frame.predictedDisplayTime / 1000);
    if (!this.stack.world.ingestDepthImage(img, frame.predictedDisplayTime / 1000, emulated)) this.stats.depthRejected++;
  }

  /**
   * Drift correction: the anchor placed with Hopper stays put in the real
   * room. C = A0 · A(t)⁻¹ maps today's tracking frame back onto the frame the
   * map was built in.
   */
  private updateAnchor(frame: XRFrame) {
    const a = this.anchor;
    if (!a) return;
    const tracked = (frame as unknown as { trackedAnchors?: Set<XRAnchor> }).trackedAnchors;
    if (tracked && !tracked.has(a)) {
      if (this.stats.anchor !== 'lost') this.stats.anchor = 'lost';
      return;
    }
    const pose = frame.getPose(a.anchorSpace, this.refSpace!);
    if (!pose || pose.emulatedPosition || !isFiniteMatrix(pose.transform.matrix)) return;
    const m = Array.from(pose.transform.matrix);
    this.stats.anchor = 'tracking';
    if (!this.anchorA0) {
      this.anchorA0 = m;
      return;
    }
    const c = anchorCorrection(this.anchorA0, m);
    if (!isFiniteMatrix(c) || Math.hypot(c[12], c[13], c[14]) > 10) return;
    if (this.lastCorrection) {
      const d = transformDelta(this.lastCorrection, c);
      if (d.dist <= 0.01 && d.angle <= (0.3 * Math.PI) / 180) return;
    } else {
      const d = transformDelta(new THREE.Matrix4().toArray(), c);
      if (d.dist <= 0.01 && d.angle <= (0.3 * Math.PI) / 180) return;
    }
    this.lastCorrection = c;
    this.stats.anchorCorrection = c;
    this.stats.anchorUpdates++;
    (this.stack.world as unknown as { setAnchorCorrection?: (m: number[] | null) => void }).setAnchorCorrection?.(c);
  }
}

/**
 * Sample a CPU depth image on a w×h grid into a DepthImage. Normalised view
 * coordinates have their origin at the top-left; depth is the distance along
 * the view's -Z axis.
 */
export function sampleDepthImage(info: { getDepthInMeters(x: number, y: number): number }, view: { projectionMatrix: Float32Array | number[]; transform: { matrix: Float32Array | number[] } }, w: number, h: number): DepthImage {
  const invProj = new THREE.Matrix4().fromArray(Array.from(view.projectionMatrix)).invert().elements;
  const depth = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let d = 0;
      try {
        d = info.getDepthInMeters((i + 0.5) / w, (j + 0.5) / h);
      } catch {
        continue;
      }
      if (d > 0.05 && Number.isFinite(d)) depth[j * w + i] = d;
    }
  return { w, h, depth, invProj, camToWorld: Array.from(view.transform.matrix) };
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function planeId(o: object): number {
  let id = ids.get(o);
  if (!id) ids.set(o, (id = nextId++));
  return id;
}

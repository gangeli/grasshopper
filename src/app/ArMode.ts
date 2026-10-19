import * as THREE from 'three';
import type { GameStack } from '../game/stack';
import { viewFromCamera } from '../game/Visibility';
import type { DepthImage } from '../world/DepthFrame';
import { Recorder } from './Recorder';
import type { Vec3 } from '../core/math';
import type { Hud } from './Hud';
import type { Stage } from './Stage';
import type { Voice } from './Voice';
import { GameUI } from './GameUI';

/**
 * WebXR immersive-ar mode. Feeds every sensor stream the device offers into
 * the world model:
 *   - hit-test: placement reticle and floor height
 *   - plane-detection: floors, tables, walls (ARCore, Quest, Vision Pro)
 *   - mesh-detection: full room mesh (Quest 3 scene mesh)
 *   - depth-sensing (cpu): per-pixel depth → occupancy + free space (ARCore)
 * Rendering: three.js XR, the occupancy occluder, and GPU depth occlusion when
 * the device provides it.
 */
export class ArMode {
  session: XRSession | null = null;
  private hitSource: XRHitTestSource | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private frameNo = 0;
  private planeTimes = new Map<XRPlane, number>();
  private meshTimes = new Map<XRMesh, number>();
  private lastHit: { pos: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  private ui: GameUI;
  private lastT = 0;
  /** Diagnostics exposed for tests/debug overlay. */
  readonly stats = { planes: 0, meshes: 0, depthFrames: 0, depthRejected: 0, depthUsage: '' as string, refSpace: '' as string };
  onExit: (() => void) | null = null;
  /** Session recorder (?record=1): depth + poses for offline evaluation. */
  readonly recorder = new URLSearchParams(location.search).get('record') === '1' ? new Recorder() : null;

  constructor(readonly stage: Stage, readonly stack: GameStack, readonly hud: Hud, readonly voice: Voice) {
    this.ui = new GameUI(stack, hud, voice);
  }

  static async supported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'));
    } catch {
      return false;
    }
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
    const enabled: readonly string[] = (session as unknown as { enabledFeatures?: string[] }).enabledFeatures ?? [];
    const useFloor = enabled.includes('local-floor');
    const r = this.stage.renderer;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType(useFloor ? 'local-floor' : 'local');
    this.stats.refSpace = useFloor ? 'local-floor' : 'local';
    // Set the loop before the session: three.js then drives it from the XR
    // session (calling it after would start a second, frame-less loop).
    r.setAnimationLoop((t, frame) => {
      try {
        this.onFrame(t, frame);
      } catch (e) {
        console.error('frame error', e);
      }
    });
    await r.xr.setSession(session);
    this.refSpace = r.xr.getReferenceSpace();
    this.stats.depthUsage = (session as unknown as { depthUsage?: string }).depthUsage ?? '';
    const viewer = await session.requestReferenceSpace('viewer');
    this.hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    session.addEventListener('select', (e) => this.onSelect(e as XRInputSourceEvent));
    session.addEventListener('end', () => {
      this.session = null;
      r.setAnimationLoop(null);
      this.onExit?.();
    });
    this.hud.on('play', () => this.startRound());
    this.hud.on('again', () => this.startRound());
    this.hud.on('exit', () => {
      // Offer the recording before leaving.
      if (this.recorder && this.recorder.count) this.recorder.download();
      void session.end();
    });
    this.hud.on('debug', () => (this.stage.debug = !this.stage.debug));
    this.hud.showPlaceHint(true, 'Point at the floor and tap to place Hopper');
    this.hud.say('Move your phone slowly so I can see the floor…', 6);
  }

  private startRound() {
    const cam = this.stage.renderer.xr.getCamera();
    this.stack.game.start(viewFromCamera(cam));
  }

  private onSelect(e: XRInputSourceEvent) {
    const frame = e.frame;
    const { game, world } = this.stack;
    this.voice.unlock();
    if (game.phase === 'waiting') {
      if (!this.lastHit) return;
      const { pos, normal } = this.lastHit;
      if (normal.y < 0.7) {
        this.hud.say('That looks like a wall — tap the floor!', 3);
        return;
      }
      world.setFloor(pos.y, pos);
      world.ingestHit(pos, normal);
      game.refreshNav(true);
      const cam = this.stage.renderer.xr.getCamera();
      const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      game.spawn(pos.clone(), camPos);
      this.hud.showPlaceHint(false);
      this.stage.reticle.visible = false;
      return;
    }
    // Tap on the pet.
    const pose = this.refSpace && frame.getPose(e.inputSource.targetRaySpace, this.refSpace);
    if (!pose) return;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    game.tapAt(origin, dir);
  }

  private onFrame(t: number, frame?: XRFrame) {
    if (!frame) return; // only render from the XR session's frames
    const dt = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 1 / 60;
    this.lastT = t;
    this.frameNo++;
    const { game, world } = this.stack;
    const cam = this.stage.renderer.xr.getCamera();
    if (frame && this.refSpace) {
      this.updateHitTest(frame);
      if (world.ready) {
        if (this.frameNo % 10 === 0) this.ingestPlanes(frame);
        if (this.frameNo % 30 === 0) this.ingestMeshes(frame);
        if (this.frameNo % 4 === 0) this.ingestDepth(frame);
      }
    }
    if (game.phase !== 'waiting') {
      game.update(dt, viewFromCamera(cam));
      this.stage.followPet(this.stack);
      // Occluder meshing takes tens of ms on a phone: refresh every ~2s while the
      // map grows, less often once a round is under way.
      if (this.frameNo % (game.phase === 'roam' ? 120 : 300) === 0) this.stage.updateOccluder(this.stack);
      this.stage.updateDebug(this.stack);
    }
    this.ui.update(cam);
    this.stage.render();
  }

  private updateHitTest(frame: XRFrame) {
    const results = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
    const pose = results[0]?.getPose(this.refSpace!);
    const ret = this.stage.reticle;
    if (!pose) {
      ret.visible = false;
      this.lastHit = null;
      return;
    }
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    const normal = new THREE.Vector3(0, 1, 0).transformDirection(m);
    this.lastHit = { pos, normal };
    if (this.stack.world.ready) this.stack.world.ingestHit(pos, normal);
    ret.visible = this.stack.game.phase === 'waiting';
    ret.matrix.copy(m);
  }

  private ingestPlanes(frame: XRFrame) {
    const planes = (frame as unknown as { detectedPlanes?: Set<XRPlane> }).detectedPlanes;
    if (!planes) return;
    this.stats.planes = planes.size;
    for (const plane of planes) {
      if (this.planeTimes.get(plane) === plane.lastChangedTime) continue;
      const pose = frame.getPose(plane.planeSpace, this.refSpace!);
      if (!pose) continue;
      this.planeTimes.set(plane, plane.lastChangedTime);
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const polygon: Vec3[] = plane.polygon.map((p) => {
        const v = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m);
        return { x: v.x, y: v.y, z: v.z };
      });
      const n = new THREE.Vector3(0, 1, 0).transformDirection(m);
      const label = (plane as unknown as { semanticLabel?: string }).semanticLabel;
      this.stack.world.ingestPlane({ id: `p${planeId(plane)}`, polygon, normal: { x: n.x, y: n.y, z: n.z }, label });
    }
  }

  private ingestMeshes(frame: XRFrame) {
    const meshes = (frame as unknown as { detectedMeshes?: Set<XRMesh> }).detectedMeshes;
    if (!meshes) return;
    this.stats.meshes = meshes.size;
    for (const mesh of meshes) {
      if (this.meshTimes.get(mesh) === mesh.lastChangedTime) continue;
      const pose = frame.getPose(mesh.meshSpace, this.refSpace!);
      if (!pose) continue;
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
    if (!view) return;
    let info: XRCPUDepthInformation | null = null;
    try {
      info = (frame as unknown as { getDepthInformation(v: XRView): XRCPUDepthInformation | null }).getDepthInformation(view);
    } catch {
      return;
    }
    if (!info) return;
    this.stats.depthFrames++;
    // Same front end as the simulator: discontinuity filter + tracking gate.
    const img = sampleDepthImage(info, view, 40, 30);
    const emulated = !!viewerPose?.emulatedPosition;
    if (this.recorder && !emulated) this.recorder.add(img, frame.predictedDisplayTime / 1000);
    if (!this.stack.world.ingestDepthImage(img, frame.predictedDisplayTime / 1000, emulated)) this.stats.depthRejected++;
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

import * as THREE from 'three';
import { XRDevice, metaQuest3, NativePlane, NativeMesh, XRRigidTransform, type XRDeviceConfig } from 'iwer';
import { roomFromName, type SimRoom } from '../sim/SimRoom';
import { buildPlanes, SimSensor, worldNoise } from '../sim/SimSensor';

/**
 * Installs the IWER WebXR runtime with a synthetic environment backed by one
 * of our simulated rooms, so the real AR code path (requestSession, hit-test,
 * plane/mesh detection, CPU depth, select events) runs in a desktop or
 * headless browser. Two device profiles:
 *   ?emulate=phone  — handheld AR: hit-test, planes, CPU depth, dom-overlay
 *   ?emulate=quest  — headset: planes + room mesh, controllers
 * The room is also rendered behind the app canvas as a fake camera feed.
 */
type Profile = 'phone' | 'quest';

export async function installEmulator(roomName: string, profile: Profile = (new URLSearchParams(location.search).get('emulate') as Profile) === 'quest' ? 'quest' : 'phone') {
  const room = roomFromName(roomName);
  const config: XRDeviceConfig =
    profile === 'quest'
      ? metaQuest3
      : {
          ...metaQuest3,
          name: 'Emulated AR phone',
          supportedSessionModes: ['inline', 'immersive-ar'],
          supportedFeatures: ['viewer', 'local', 'local-floor', 'hit-test', 'plane-detection', 'depth-sensing', 'anchors', 'dom-overlay'],
        };
  const device = new XRDevice(config, { stereoEnabled: false, fovy: 1.05 });
  device.position.set(0, 1.45, 0.6);
  setYawPitch(device, 0, -0.45);
  SimRoomSEM.room = room;
  SimRoomSEM.profile = profile;
  device.installSEM(SimRoomSEM as never);
  device.installRuntime({ forceInstall: true });
  const emu = {
    device,
    room,
    /** Move/turn the emulated viewer (yaw 0 looks down -Z). */
    setPose(x: number, y: number, z: number, yaw: number, pitch: number) {
      device.position.set(x, y, z);
      setYawPitch(device, yaw, pitch);
    },
    /** Fire an XR select (a screen tap / trigger pull). */
    async select() {
      await device.remote.dispatch('select', { device: profile === 'quest' ? 'controller-right' : 'controller-right' } as never);
    },
  };
  (window as unknown as { __emu: typeof emu }).__emu = emu;
  return emu;
}

function setYawPitch(device: XRDevice, yaw: number, pitch: number) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  device.quaternion.set(q.x, q.y, q.z, q.w);
}

/** Synthetic Environment Module backed by a SimRoom. */
class SimRoomSEM {
  static room: SimRoom;
  static profile: Profile;
  readonly version = 'hopper-sim-1';
  planesVisible = false;
  boundingBoxesVisible = false;
  meshesVisible = false;
  readonly trackedPlanes = new Set<NativePlane>();
  readonly trackedMeshes = new Set<NativeMesh>();
  private canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.02, 40);
  private room: SimRoom;

  constructor(readonly device: XRDevice) {
    this.room = SimRoomSEM.room;
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.buildScene();
    for (const p of buildPlanes(this.room)) {
      const n = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z).normalize();
      const c = new THREE.Vector3();
      for (const v of p.polygon) c.add(new THREE.Vector3(v.x, v.y, v.z));
      c.divideScalar(p.polygon.length);
      const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      const inv = rot.clone().invert();
      const poly = p.polygon.map((v) => {
        const l = new THREE.Vector3(v.x, v.y, v.z).sub(c).applyQuaternion(inv);
        return new DOMPointReadOnly(l.x, 0, l.z, 1);
      });
      const label = (p.label ?? 'other') as never;
      this.trackedPlanes.add(new NativePlane(new XRRigidTransform({ x: c.x, y: c.y, z: c.z, w: 1 }, { x: rot.x, y: rot.y, z: rot.z, w: rot.w }), poly, label));
    }
    if (SimRoomSEM.profile === 'quest') {
      const sensor = new SimSensor(this.room, { depth: false, planes: false, mesh: true });
      for (const m of sensor.meshes()) {
        this.trackedMeshes.add(new NativeMesh(new XRRigidTransform(), new Float32Array(m.positions as number[]), new Uint32Array(m.indices as number[]), (m.label ?? 'other') as never));
      }
    }
  }

  get environmentCanvas() {
    return this.canvas;
  }

  render() {
    const w = window.innerWidth, h = window.innerHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
    const p = this.device.position, q = this.device.quaternion;
    this.camera.position.set(p.x, p.y, p.z);
    this.camera.quaternion.set(q.x, q.y, q.z, q.w);
    this.camera.fov = (this.device.fovy * 180) / Math.PI;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  loadEnvironment() {}
  async loadDefaultEnvironment() {}
  deleteAll() {
    this.trackedPlanes.clear();
    this.trackedMeshes.clear();
  }

  computeHitTestResults(rayMatrix: Float32Array | number[]): Float32Array[] {
    const m = new THREE.Matrix4().fromArray(Array.from(rayMatrix));
    const o = new THREE.Vector3().setFromMatrixPosition(m);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(m);
    const hit = this.room.raycast(o, d, 10);
    if (!Number.isFinite(hit.t)) return [];
    const pos = o.clone().addScaledVector(d, hit.t);
    const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z));
    const out = new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(1, 1, 1));
    return [new Float32Array(out.elements)];
  }

  /** Z-depth in metres (with realistic phone-like error), row 0 at the top of the view, downsampled for speed. */
  computeDepthBuffer(viewMatrix: Float32Array | number[], projectionMatrix: Float32Array | number[], width: number, height: number) {
    const w = Math.min(width, 64), h = Math.max(1, Math.round((w * height) / width));
    const invProj = new THREE.Matrix4().fromArray(Array.from(projectionMatrix)).invert();
    const camWorld = new THREE.Matrix4().fromArray(Array.from(viewMatrix)).invert();
    const eye = new THREE.Vector3().setFromMatrixPosition(camWorld);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(camWorld);
    const data = new Float32Array(w * h);
    const p = new THREE.Vector3();
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        p.set(((c + 0.5) / w) * 2 - 1, 1 - ((r + 0.5) / h) * 2, -1).applyMatrix4(invProj).applyMatrix4(camWorld);
        const d = p.sub(eye).normalize();
        const hit = this.room.raycast(eye, d, 8);
        if (!Number.isFinite(hit.t) || Math.random() < 0.1) continue; // holes
        // Phone-like error: per-pixel noise plus a persistent, world-anchored bias.
        const z = hit.t * d.dot(fwd);
        const sigma = 0.008 + 0.015 * z * z;
        const at = eye.clone().addScaledVector(d, hit.t);
        const gauss = Math.sqrt(-2 * Math.log(Math.max(1e-9, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
        data[r * w + c] = Math.max(0, z + sigma * (0.6 * gauss + 1.5 * worldNoise(at.x, at.y, at.z)));
      }
    return { data: data.buffer, width: w, height: h, rawValueToMeters: 1 };
  }

  private buildScene() {
    const s = this.scene;
    s.background = new THREE.Color(0x30363c);
    s.add(new THREE.HemisphereLight(0xffffff, 0x887766, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(1, 3, 2);
    s.add(sun);
    const room = this.room;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(room.width, room.depth).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xb39472, roughness: 0.9 }));
    s.add(floor);
    for (const b of room.boxes) {
      const size = new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.85 }));
      mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      s.add(mesh);
    }
  }
}

import * as THREE from 'three';
import { applyPetEnvironment } from '../pet/lighting';
import type { GameStack } from '../game/stack';
import { Occluder } from './Occluder';

/**
 * Renderer, scene and the always-present scene furniture for the pet:
 * lights, a shadow catcher that follows the pet (so it feels grounded on
 * real floors and table tops), the occluder, and the debug map view.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly shadowCatcher: THREE.Mesh;
  readonly occluder = new Occluder();
  readonly reticle: THREE.Mesh;
  readonly debugGroup = new THREE.Group();
  /**
   * Parent of everything expressed in the world model's map frame (the pet,
   * the occluder, debug visuals). Its matrix is the map → tracking transform
   * (anchor drift correction); identity when there is none. Reticle, shadow
   * catcher and lights live in the tracking frame.
   */
  readonly mapRoot = new THREE.Group();
  private debugBuiltVersion = -1;
  private debugBuiltEpoch = -1;
  private readonly _v = new THREE.Vector3();
  debug = false;

  constructor(container: HTMLElement, opts: { ar: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: opts.ar, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 40);

    this.hemi = new THREE.HemisphereLight(0xfffaf0, 0x8d8475, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -0.6;
    sc.right = sc.top = 0.6;
    sc.near = 0.1;
    sc.far = 5;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target);

    this.shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(0.7, 40), new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.renderOrder = 1;
    this.scene.add(this.shadowCatcher);

    this.mapRoot.matrixAutoUpdate = false;
    this.scene.add(this.mapRoot);
    this.mapRoot.add(this.occluder.mesh);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    this.reticle.visible = false;
    this.reticle.matrixAutoUpdate = false;
    this.scene.add(this.reticle);
    this.mapRoot.add(this.debugGroup);

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  addPet(stack: GameStack) {
    this.mapRoot.add(stack.rig.group);
    applyPetEnvironment(this.renderer, stack.rig, this.renderer.getContextAttributes()?.alpha ? 0.6 : 0.8);
  }

  /**
   * Follow the world model's map → tracking transform (anchor drift
   * correction). Non-finite or missing transforms leave the identity.
   */
  syncMapFrame(world: unknown) {
    const fn = (world as { mapToTracking?: () => ArrayLike<number> | null }).mapToTracking;
    let m: ArrayLike<number> | null = null;
    try {
      m = fn ? fn.call(world) : null;
    } catch {
      m = null;
    }
    let ok = !!m && m.length === 16;
    if (ok) for (let i = 0; i < 16; i++) if (!Number.isFinite(m![i])) ok = false;
    if (ok) this.mapRoot.matrix.fromArray(Array.from(m!));
    else this.mapRoot.matrix.identity();
    this.mapRoot.matrixWorldNeedsUpdate = true;
  }

  /** Map-frame point → tracking frame (what the renderer, lights and audio use). */
  mapToTracking(p: { x: number; y: number; z: number }, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(p.x, p.y, p.z).applyMatrix4(this.mapRoot.matrix);
  }

  /** Tracking-frame point (hit-test, camera) → map frame (what the world model and game use). */
  trackingToMap(p: { x: number; y: number; z: number }, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(p.x, p.y, p.z).applyMatrix4(new THREE.Matrix4().copy(this.mapRoot.matrix).invert());
  }

  /** Keep the key light and shadow catcher centred on the pet. */
  followPet(stack: GameStack) {
    const pm = stack.pet.pos;
    if (!Number.isFinite(pm.x) || !Number.isFinite(pm.y) || !Number.isFinite(pm.z)) return;
    // Lights and the catcher are in the tracking frame; the pet is in the map frame.
    const p = this.mapToTracking(pm, this._v);
    this.sun.position.set(p.x + 0.8, p.y + 2.2, p.z + 0.6);
    this.sun.target.position.copy(p);
    const g = this.mapToTracking({ x: pm.x, y: groundUnder(stack), z: pm.z });
    this.shadowCatcher.position.set(g.x, g.y + 0.002, g.z);
  }

  updateOccluder(stack: GameStack) {
    const g = stack.world.grid;
    if (!g) return;
    this.occluder.update(g, stack.pet.pos, stack.world.floorLayer);
  }

  /** Debug: show occupied voxels (by height) and nav nodes. */
  updateDebug(stack: GameStack) {
    this.debugGroup.visible = this.debug;
    this.occluder.debugVisible = this.debug;
    const g = stack.world.grid, nav = stack.game.nav;
    if (!this.debug || !g || !nav || (g.version === this.debugBuiltVersion && stack.world.epoch === this.debugBuiltEpoch)) return;
    this.debugBuiltVersion = g.version;
    this.debugBuiltEpoch = stack.world.epoch;
    for (const c of [...this.debugGroup.children]) {
      this.debugGroup.remove(c);
      const o = c as THREE.Mesh;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    const pts: number[] = [], cols: number[] = [];
    const col = new THREE.Color();
    for (let a = 0; a < nav.count; a += 2) {
      const p = nav.pos(a);
      pts.push(p.x, p.y + 0.01, p.z);
      const crawl = nav.headroom[a] < nav.p.standHeight;
      col.set(nav.isEdge(a) ? 0xffaa00 : crawl ? 0x33aaff : 0x33dd66);
      cols.push(col.r, col.g, col.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.debugGroup.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.02, vertexColors: true })));
    if (stack.game.spot) {
      const s = stack.game.spot.pos;
      const m = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.01, 8, 32).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3366 }));
      m.position.set(s.x, s.y + 0.02, s.z);
      this.debugGroup.add(m);
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function groundUnder(stack: GameStack): number {
  const nav = stack.game.nav;
  const p = stack.pet.pos;
  if (nav && stack.pet.state === 'air') {
    // Mid-jump: put the shadow on whatever surface is below.
    const n = nav.nearest({ x: p.x, y: p.y, z: p.z }, 0.3);
    if (n >= 0 && nav.ny[n] <= p.y + 0.01) return nav.ny[n];
    return stack.world.floorY;
  }
  return p.y;
}

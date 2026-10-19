import * as THREE from 'three';
import { buildPet } from './pet/PetModel';
import { Animator, type ActionName } from './pet/Animator';
import { applyPetEnvironment } from './pet/lighting';
import { PetController } from './pet/PetController';
import type { Waypoint } from './world/NavGrid';

/**
 * Pose lab: renders Hopper in a grid of actions × times (and optional camera
 * angles) so automated tests and humans can review the model and animation at
 * a glance. URL params: actions=a,b,c  times=0.1,0.5  yaw=0.6  size=220  palette=mint
 * dist/camY/lookY (camera), fur=N, res=0.0034 (mesh), look=0 (don't look at the camera)
 *
 * Filmstrips: seq=walk,jump,... renders whole sequences driven by the real
 * PetController (one row per sequence, one column per time in `times`), on a
 * gridded floor so foot planting can be judged. Sequences: walk, run, jump
 * (onto a box), drop (off a box), turn (hop round on the spot), idle (blinks
 * on, look target swinging), and any `script` such as
 * script=idle@0,giggle@0.6,idle@2.4 (actions performed at those seconds).
 * follow=1 keeps the camera on the pet; blink=0 suppresses blinks.
 */
const q = new URLSearchParams(location.search);
const seqs = q.get('seq')?.split(',') ?? null;
const actions = seqs ? (seqs as ActionName[]) : (q.get('actions') ?? 'idle,hop,jumpCrouch,jumpAir,land,hide,hideLow,peek,giggle,surprised,celebrate,wave,lookAround,sniff,coverEyes,sleep').split(',') as ActionName[];
const times = (q.get('times') ?? '0.15,0.45,0.8').split(',').map(Number);
const yaws = (q.get('yaw') ?? '0.5').split(',').map(Number);
const cell = Number(q.get('size') ?? 200);
const dist = Number(q.get('dist') ?? 0.95);
const camY = Number(q.get('camY') ?? 0.32);
const lookY = Number(q.get('lookY') ?? 0.15);
const cols = times.length * yaws.length;
const rows = actions.length;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(cols * cell, rows * cell);
renderer.setScissorTest(true);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f72, 0.6));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.0);
sun.position.set(0.6, 1.4, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = sun.shadow.camera.bottom = -0.4;
sun.shadow.camera.right = sun.shadow.camera.top = 0.4;
scene.add(sun);
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9d2c5';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#c9c0b0';
  g.fillRect(0, 0, 128, 128);
  g.fillRect(128, 128, 128, 128);
  g.strokeStyle = '#8f8676';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // One checker square = 5 cm.
  t.repeat.set(30, 30);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(
  seqs ? new THREE.PlaneGeometry(3, 3) : new THREE.CircleGeometry(0.4, 40),
  new THREE.MeshStandardMaterial(seqs ? { map: gridTexture() } : { color: 0xd9d2c5 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const tBuild = performance.now();
const rig = buildPet((q.get('palette') as 'mint') ?? 'mint', {
  ...(q.has('fur') ? { furShells: Number(q.get('fur')) } : {}),
  ...(q.has('res') ? { meshResolution: Number(q.get('res')) } : {}),
});
scene.add(rig.group);
console.log(`lab: pet build ${(performance.now() - tBuild).toFixed(0)} ms`);
applyPetEnvironment(renderer, rig);
if (q.get('debug') === 'basic') rig.group.traverse((o) => o.name === 'body' && ((o as THREE.Mesh).material = new THREE.MeshBasicMaterial({ vertexColors: true })));
if (q.get('debug') === 'normal') rig.group.traverse((o) => o.name === 'body' && ((o as THREE.Mesh).material = new THREE.MeshNormalMaterial()));
// hide=name,name: hide parts of the rig by object name (to see what a patch belongs to).
for (const n of q.get('hide')?.split(',') ?? []) rig.group.traverse((o) => o.name === n && (o.visible = false));
const anim = new Animator(rig, 3);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);

function poseAt(action: ActionName, t: number) {
  // Re-simulate from scratch so springs settle deterministically.
  anim.play(action, 0, true);
  // No random blinks mid-sheet: they'd make cells look half-lidded at random.
  Object.assign(anim, { blinkT: 1e9, blinkPhase: 1 });
  if (action === 'hop') anim.ctx.speed = 0.6;
  const dt = 1 / 60;
  let tt = 0;
  while (tt < t) {
    if (action === 'hop') anim.ctx.hopPhase = (tt * 2.6) % 1;
    if (action === 'jumpAir') anim.ctx.jumpU = Math.min(1, tt / 0.9);
    anim.update(dt);
    tt += dt;
  }
}

// --- Filmstrip sequences, driven by the real controller. ---
const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: 0xb8a58a }));
box.castShadow = box.receiveShadow = true;
box.visible = false;
scene.add(box);
const wp = (x: number, y: number, z: number, jump = false): Waypoint => ({ x, y, z, jump, node: -1 });
const cruiseParam = Number(q.get('cruise') ?? 0.5);

/** Plays a sequence once, rendering a cell in row `row` at each of `times`. */
function runSeq(name: string, row: number): void {
  anim.reset();
  if (q.get('blink') === '0') Object.assign(anim, { blinkT: 1e9 });
  const pet = new PetController(rig, anim);
  box.visible = false;
  let start = new THREE.Vector3();
  let plan: (pet: PetController) => void = () => {};
  const timeline: [number, ActionName][] = [];
  let lookSwing = false;
  switch (name) {
    case 'walk':
    case 'run':
      start = new THREE.Vector3(-0.5, 0, 0);
      plan = (p) => p.follow([wp(0.15, 0, 0), wp(0.6, 0, 0)], name === 'run' ? 1.0 : cruiseParam);
      pet.placeAt(start, Math.PI / 2);
      break;
    case 'jump':
      box.visible = true;
      box.position.set(0.3, 0.1, 0);
      start = new THREE.Vector3(-0.35, 0, 0);
      pet.placeAt(start, Math.PI / 2);
      plan = (p) => p.follow([wp(-0.08, 0, 0), wp(0.28, 0.2, 0, true), wp(0.36, 0.2, 0)], cruiseParam);
      break;
    case 'drop':
      box.visible = true;
      box.position.set(-0.2, 0.1, 0);
      start = new THREE.Vector3(-0.3, 0.2, 0);
      pet.placeAt(start, Math.PI / 2);
      plan = (p) => p.follow([wp(-0.1, 0.2, 0), wp(0.2, 0, 0, true), wp(0.3, 0, 0)], cruiseParam);
      break;
    case 'turn':
      pet.placeAt(start, 0);
      plan = (p) => {
        p.arriveYaw = 2.6;
        p.arriveAction = 'idle';
      };
      break;
    case 'idle':
      pet.placeAt(start, 0);
      lookSwing = true;
      break;
    default: {
      // script: action@time,...
      pet.placeAt(start, 0);
      // Any other name is an action performed at 0.3s (and back to idle at `back`).
      const back = q.has('back') ? `,idle@${q.get('back')}` : '';
      const script = name === 'script' ? (q.get('script') ?? 'idle@0') : `idle@0,${name}@0.3${back}`;
      for (const part of script.split(',')) {
        const [a, at] = part.split('@');
        timeline.push([Number(at), a as ActionName]);
      }
    }
  }
  plan(pet);
  const dt = 1 / 60;
  let tt = 0;
  let next = 0;
  const lt = new THREE.Vector3();
  const follow = q.get('follow') !== '0';
  const placeCam = (yaw: number) => {
    const c = follow ? pet.pos : new THREE.Vector3();
    camera.position.set(c.x + Math.sin(yaw) * dist, camY + c.y * 0.4, c.z + Math.cos(yaw) * dist);
    camera.lookAt(c.x, lookY + c.y * 0.4, c.z);
  };
  for (const T of times) {
    while (tt < T - 1e-6) {
      while (next < timeline.length && timeline[next][0] <= tt) {
        const a = timeline[next++][1];
        if (a === 'idle') pet.stop('idle');
        else pet.perform(a, 0.2);
      }
      // Look target: the (first) camera, or (idle) one that wanders left and right.
      placeCam(yaws[0]);
      if (lookSwing) {
        const k = Math.floor(tt / 1.3) % 3;
        lt.set([-0.6, 0.5, 0.05][k], 0.35, 0.9);
        anim.lookTarget = lt;
      } else anim.lookTarget = q.get('look') === '0' ? null : camera.position.clone();
      pet.update(dt);
      anim.update(dt);
      tt += dt;
    }
    for (const yaw of yaws) {
      placeCam(yaw);
      sun.position.set(pet.pos.x + 0.6, pet.pos.y + 1.4, pet.pos.z + 0.9);
      sun.target.position.copy(pet.pos);
      sun.target.updateMatrixWorld();
      draw(row, col++);
    }
  }
}

const H = renderer.domElement.height;
let col = 0;
function draw(r: number, c: number) {
  renderer.setViewport(c * cell, H - (r + 1) * cell, cell, cell);
  renderer.setScissor(c * cell, H - (r + 1) * cell, cell, cell);
  renderer.setClearColor(r % 2 ? 0xe2e8ee : 0xeef2f5);
  renderer.render(scene, camera);
}
if (seqs) {
  seqs.forEach((name, r) => {
    col = 0;
    runSeq(name, r);
  });
} else {
  let r = 0;
  for (const action of actions) {
  let c = 0;
  for (const t of times) {
    for (const yaw of yaws) {
      // The pet looks at this cell's camera (set before posing so it's not the previous cell's).
      camera.position.set(Math.sin(yaw) * dist, camY, Math.cos(yaw) * dist);
      camera.lookAt(0, lookY, 0);
      anim.lookTarget = q.get('look') === '0' ? null : camera.position.clone();
      poseAt(action, t);
      renderer.setViewport(c * cell, H - (r + 1) * cell, cell, cell);
      renderer.setScissor(c * cell, H - (r + 1) * cell, cell, cell);
      renderer.setClearColor(r % 2 ? 0xe2e8ee : 0xeef2f5);
      renderer.render(scene, camera);
      c++;
    }
  }
  r++;
}
}
// Labels.
const overlay = document.createElement('div');
overlay.style.cssText = 'position:absolute;left:0;top:0;';
actions.forEach((a, i) => {
  const d = document.createElement('div');
  d.textContent = a;
  d.style.cssText = `position:absolute;left:4px;top:${i * cell + 3}px;color:#334;font-weight:600`;
  overlay.appendChild(d);
});
times.forEach((t, i) => {
  const d = document.createElement('div');
  d.textContent = `${t}s`;
  d.style.cssText = `position:absolute;left:${i * yaws.length * cell + cell - 44}px;top:3px;color:#556`;
  overlay.appendChild(d);
});
document.body.appendChild(overlay);
// ?bench=N: re-render the last cell N times and log the average frame time
// (relative numbers only: software GL in tests is far slower than a phone GPU).
if (q.has('bench')) {
  const n = Number(q.get('bench'));
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  renderer.render(scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) renderer.render(scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  console.log(`lab: bench ${((performance.now() - t0) / n).toFixed(1)} ms/frame`);
}
(window as unknown as { __labReady: boolean }).__labReady = true;

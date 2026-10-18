import * as THREE from 'three';
import { buildPet } from './pet/PetModel';
import { Animator, type ActionName } from './pet/Animator';

/**
 * Pose lab: renders Hopper in a grid of actions × times (and optional camera
 * angles) so automated tests and humans can review the model and animation at
 * a glance. URL params: actions=a,b,c  times=0.1,0.5  yaw=0.6  size=220  palette=mint
 */
const q = new URLSearchParams(location.search);
const actions = (q.get('actions') ?? 'idle,hop,jumpCrouch,jumpAir,land,hide,hideLow,peek,giggle,surprised,celebrate,wave,lookAround,sniff,coverEyes,sleep').split(',') as ActionName[];
const times = (q.get('times') ?? '0.15,0.45,0.8').split(',').map(Number);
const yaws = (q.get('yaw') ?? '0.5').split(',').map(Number);
const cell = Number(q.get('size') ?? 200);
const cols = times.length * yaws.length;
const rows = actions.length;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(cols * cell, rows * cell);
renderer.setScissorTest(true);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f72, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(0.6, 1.4, 0.9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = sun.shadow.camera.bottom = -0.4;
sun.shadow.camera.right = sun.shadow.camera.top = 0.4;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(0.4, 40), new THREE.MeshStandardMaterial({ color: 0xd9d2c5 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const rig = buildPet((q.get('palette') as 'mint') ?? 'mint');
scene.add(rig.group);
const anim = new Animator(rig, 3);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);

function poseAt(action: ActionName, t: number) {
  // Re-simulate from scratch so springs settle deterministically.
  anim.play(action, 0, true);
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

const H = renderer.domElement.height;
let r = 0;
for (const action of actions) {
  let c = 0;
  for (const t of times) {
    for (const yaw of yaws) {
      poseAt(action, t);
      const dist = 0.95;
      camera.position.set(Math.sin(yaw) * dist, 0.32, Math.cos(yaw) * dist);
      camera.lookAt(0, 0.15, 0);
      anim.lookTarget = camera.position.clone();
      renderer.setViewport(c * cell, H - (r + 1) * cell, cell, cell);
      renderer.setScissor(c * cell, H - (r + 1) * cell, cell, cell);
      renderer.setClearColor(r % 2 ? 0xe2e8ee : 0xeef2f5);
      renderer.render(scene, camera);
      c++;
    }
  }
  r++;
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
document.body.appendChild(overlay);
(window as unknown as { __labReady: boolean }).__labReady = true;

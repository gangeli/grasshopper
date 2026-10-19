import * as THREE from 'three';
import { Stage } from './app/Stage';
import { Hud } from './app/Hud';
import { Voice } from './app/Voice';
import { ArMode } from './app/ArMode';
import { SimMode } from './app/SimMode';
import { createStack } from './game/stack';
import { Animator } from './pet/Animator';
import { buildPet } from './pet/PetModel';
import { applyPetEnvironment } from './pet/lighting';

/**
 * Entry point. URL parameters (handy for testing):
 *   ?sim=1            jump straight into the virtual room
 *   &room=living|bedroom|empty|r<seed>   which simulated room
 *   &bot=1            let the seeker bot play (automated test harness)
 *   &speed=4          simulation steps per frame (fast-forward)
 *   &fixed=1          fixed 1/30s timestep (deterministic)
 *   &emulate=1        install the IWER WebXR emulator (AR without a device)
 *   &seed=N
 */
const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? Math.floor(Math.random() * 1e6));

declare global {
  interface Window {
    __hopper?: Record<string, unknown>;
  }
}

async function main() {
  if (q.get('emulate')) {
    // Dev/test only: emulate an AR device (see src/emulate). Loaded lazily so it isn't in the main bundle.
    const { installEmulator } = await import('./emulate/installEmulator');
    await installEmulator(q.get('room') ?? 'living');
  }
  const landing = document.getElementById('landing')!;
  const arBtn = document.getElementById('btn-ar') as HTMLButtonElement;
  const simBtn = document.getElementById('btn-sim') as HTMLButtonElement;
  const note = document.getElementById('support-note')!;
  const voice = new Voice();
  window.__hopper = { voice };

  const arOk = await ArMode.supported();
  if (arOk) arBtn.style.display = '';
  else note.textContent = 'AR needs a WebXR browser (Chrome on Android, Quest Browser). On this device you can play in a virtual room.';
  // A message carried over a reload (e.g. AR failed to start).
  try {
    const carried = sessionStorage.getItem('hopper-note');
    if (carried) {
      sessionStorage.removeItem('hopper-note');
      note.textContent = carried;
    }
  } catch {
    /* storage unavailable */
  }

  // Showcase: Hopper waves on the landing page.
  const showcase = startShowcase();

  const enter = async (mode: 'ar' | 'sim') => {
    voice.unlock();
    showcase.stop();
    landing.style.display = 'none';
    if (mode === 'ar') {
      const stage = new Stage(document.body, { ar: true });
      const hud = new Hud(document.body);
      const stack = createStack({ seed });
      stage.addPet(stack);
      const ar = new ArMode(stage, stack, hud, voice);
      window.__hopper = { ...window.__hopper, mode: 'ar', stage, hud, stack, ar, game: stack.game, THREE };
      // Leaving AR (or AR failing) goes back to a fresh start page: never a dead AR screen.
      const backToStart = (msg?: string) => {
        try {
          if (msg) sessionStorage.setItem('hopper-note', msg);
        } catch {
          /* storage unavailable */
        }
        location.reload();
      };
      ar.onExit = () => backToStart();
      try {
        await ar.start();
      } catch (e) {
        console.warn(e);
        const msg = `Couldn't start AR: ${(e as Error)?.message ?? e}. Try again, or play in the virtual room.`;
        hud.say(msg, 8);
        // If the session never started there is nothing to show: back to the start page.
        if (!ar.session) setTimeout(() => backToStart(msg), 2500);
      }
    } else {
      const stage = new Stage(document.body, { ar: false });
      const hud = new Hud(document.body);
      const sim = new SimMode(stage, hud, voice, {
        room: q.get('room') ?? 'living',
        seed,
        bot: q.get('bot') === '1',
        speed: Math.max(1, Number(q.get('speed') ?? 1)),
        fixed: q.get('fixed') === '1',
      });
      sim.syncAspect();
      window.__hopper = { ...window.__hopper, mode: 'sim', stage, hud, sim, game: sim.sim.game, THREE };
      sim.onExit = () => location.reload();
      sim.start();
    }
  };
  arBtn.onclick = () => void enter('ar');
  simBtn.onclick = () => void enter('sim');
  if (q.get('sim') === '1') void enter('sim');
}

function startShowcase() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1f2a33);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(0.5, 1.5, 1);
  sun.castShadow = true;
  scene.add(sun);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.35, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2c3b46 }));
  disc.receiveShadow = true;
  scene.add(disc);
  const rig = buildPet('mint');
  scene.add(rig.group);
  applyPetEnvironment(renderer, rig);
  const anim = new Animator(rig, 7);
  const cam = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 10);
  const portrait = innerHeight > innerWidth;
  cam.position.set(0, 0.34, portrait ? 1.9 : 1.1);
  cam.lookAt(0, portrait ? -0.05 : 0.1, 0);
  anim.lookTarget = cam.position.clone();
  const cycle = ['wave', 'idle', 'giggle', 'lookAround', 'celebrate', 'idle', 'peek', 'idle'] as const;
  let i = 0, t = 0, last = performance.now();
  anim.play('wave', 0);
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    if (t > 2.6) {
      t = 0;
      i = (i + 1) % cycle.length;
      anim.ctx.peekSide = 1;
      anim.play(cycle[i], 0.3, true);
    }
    rig.group.rotation.y = Math.sin(now / 2400) * 0.35;
    anim.update(dt);
    renderer.render(scene, cam);
  });
  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
  };
  addEventListener('resize', onResize);
  return {
    stop() {
      renderer.setAnimationLoop(null);
      removeEventListener('resize', onResize);
      renderer.domElement.remove();
      renderer.dispose();
    },
  };
}

void main();

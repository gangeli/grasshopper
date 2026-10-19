import * as THREE from 'three';
import { Stage } from './app/Stage';
import { Hud } from './app/Hud';
import { Voice } from './app/Voice';
import { ArMode } from './app/ArMode';
import { SimMode } from './app/SimMode';
import { CameraFeed } from './app/CameraFeed';
import { createStack } from './game/stack';
import { Animator } from './pet/Animator';
import { buildPet } from './pet/PetModel';
import { applyPetEnvironment } from './pet/lighting';

/**
 * Entry point. URL parameters (handy for testing):
 *   ?sim=1            jump straight into the virtual room
 *   ?camera=1         force camera mode (live camera + motion sensors, no WebXR)
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
  const camBtn = document.getElementById('btn-cam') as HTMLButtonElement;
  const simBtn = document.getElementById('btn-sim') as HTMLButtonElement;
  const note = document.getElementById('support-note')!;
  const voice = new Voice();
  window.__hopper = { voice };

  // Best experience first: WebXR AR (Hopper learns your furniture) → the
  // live camera with motion sensors → a virtual room as a quiet last resort.
  const arOk = q.get('camera') !== '1' && (await ArMode.supported());
  const camOk = CameraFeed.available();
  if (arOk) arBtn.style.display = '';
  else if (camOk) camBtn.style.display = '';
  note.textContent = supportNote(arOk, camOk);
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

  const enter = async (mode: 'ar' | 'sim' | 'camera') => {
    // iOS only shows the motion-sensor prompt from inside the tap itself.
    const motion = mode === 'camera' ? CameraFeed.requestOrientationPermission() : Promise.resolve(true);
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
        const msg = arErrorMessage(e);
        hud.say(msg, 8);
        // If the session never started there is nothing to show: back to the start page.
        if (!ar.session) setTimeout(() => backToStart(msg), 2500);
      }
    } else if (mode === 'camera') {
      const feed = new CameraFeed(document.body);
      try {
        await feed.start();
      } catch (e) {
        console.warn(e);
        feed.stop();
        try {
          sessionStorage.setItem('hopper-note', cameraErrorMessage(e));
        } catch {
          /* storage unavailable */
        }
        location.reload();
        return;
      }
      const stage = new Stage(document.body, { ar: true });
      const hud = new Hud(document.body);
      const sim = new SimMode(stage, hud, voice, { room: 'empty', seed, bot: false, speed: 1, fixed: false, camera: feed });
      sim.syncAspect();
      window.__hopper = { ...window.__hopper, mode: 'camera', stage, hud, sim, feed, game: sim.sim.game, THREE };
      sim.onExit = () => location.reload();
      sim.start();
      if (!(await motion)) hud.say('Motion access was declined, so the view can’t follow your phone. Drag to look around — or reload and tap “Allow”.', 9);
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
  camBtn.onclick = () => void enter('camera');
  simBtn.onclick = (e) => {
    e.preventDefault();
    void enter('sim');
  };
  if (q.get('sim') === '1') void enter('sim');
}

/** What this browser can do, in plain words (and what would work better). */
function supportNote(arOk: boolean, camOk: boolean): string {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const chrome = /Chrome\//.test(ua) && !/Edg|OPR|SamsungBrowser|Firefox/.test(ua);
  if (arOk) return 'Hopper will map your room through your camera — have a bit of floor and some furniture in view.';
  if (!camOk) return 'This browser can’t use the camera. Open this page in Chrome on Android for full AR, or try the virtual room.';
  if (android && !chrome)
    return 'Camera mode: Hopper appears in your room but can’t see your furniture here. For full AR — Hopper hides behind your real couch — open this page in Chrome.';
  if (android) return 'Full AR isn’t available on this phone (it needs “Google Play Services for AR”). Camera mode still puts Hopper in your room.';
  if (ios) return 'iPhone browsers don’t support full AR yet, so Hopper can’t see your furniture — it hides around you instead. Turn around to find it!';
  return 'Camera mode works best on a phone. For full AR, open this page in Chrome on Android.';
}

function arErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  const raw = (e as Error)?.message ?? String(e);
  if (name === 'NotSupportedError' || /not supported/i.test(raw))
    return 'This phone couldn’t start AR. Make sure “Google Play Services for AR” is installed and up to date, then try again.';
  if (name === 'SecurityError' || name === 'NotAllowedError' || /permission|denied/i.test(raw))
    return 'AR needs camera permission. Allow the camera for this site (tap the lock icon next to the address), then try again.';
  return `AR didn’t start (${raw}). Try again — closing other camera apps sometimes helps.`;
}

function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera access was blocked. Allow the camera for this site (tap the lock icon next to the address), then tap Start again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is busy — close other apps using it, then try again.';
  return `The camera didn’t start (${(e as Error)?.message ?? e}). Try again.`;
}

function startShowcase() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.prepend(renderer.domElement);
  Object.assign(renderer.domElement.style, { position: 'fixed', inset: '0', zIndex: '1' });
  const sky = document.getElementById('sky');
  if (sky && !sky.childElementCount)
    for (let k = 0; k < 18; k++) {
      const f = document.createElement('i');
      f.style.left = `${5 + Math.random() * 90}%`;
      f.style.top = `${8 + Math.random() * 60}%`;
      f.style.animationDelay = `${-Math.random() * 9}s`;
      f.style.animationDuration = `${7 + Math.random() * 6}s`;
      sky.appendChild(f);
    }
  const scene = new THREE.Scene();
  // Transparent: the page's dusk sky (#sky) shows through.
  scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3550, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
  sun.position.set(0.5, 1.5, 1);
  sun.castShadow = true;
  scene.add(sun);
  // Warm rim light from behind, like the spotlight in the sky.
  const rim = new THREE.DirectionalLight(0xffd59a, 1.4);
  rim.position.set(-0.6, 0.8, -1.2);
  scene.add(rim);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.45, 48).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.45 }));
  disc.receiveShadow = true;
  scene.add(disc);
  const rig = buildPet('mint');
  scene.add(rig.group);
  applyPetEnvironment(renderer, rig);
  const anim = new Animator(rig, 7);
  const cam = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 10);
  const portrait = innerHeight > innerWidth;
  // Frame Hopper in the upper part of the screen, above the title and buttons.
  cam.position.set(0, 0.36, portrait ? 2.2 : 2.1);
  cam.lookAt(0, portrait ? -0.2 : -0.28, 0);
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
      document.getElementById('sky')?.remove();
    },
  };
}

void main();

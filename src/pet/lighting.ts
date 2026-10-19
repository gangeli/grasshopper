import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { PetRig } from './PetModel';

/**
 * Soft indoor image-based lighting for the pet: gives fur, eyes and the nose
 * believable reflections and fill instead of flat CG shading. It is applied
 * to the pet's materials only (not scene.environment), so large surfaces like
 * the sim room don't pay for it. ?env=0 disables it.
 */
export function petEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('env') === '0') return null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return env;
}

export function applyPetEnvironment(renderer: THREE.WebGLRenderer, rig: PetRig, intensity = 0.8): void {
  const env = petEnvironment(renderer);
  if (!env) return;
  for (const m of rig.materials) {
    const s = m as THREE.MeshStandardMaterial;
    if (!s.isMeshStandardMaterial) continue;
    s.envMap = env;
    s.envMapIntensity = (s.envMapIntensity ?? 1) * intensity;
    s.needsUpdate = true;
  }
}

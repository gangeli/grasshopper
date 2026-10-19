import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Soft indoor image-based lighting: gives fur, eyes and the nose believable
 * reflections and fill instead of flat CG shading. Used everywhere the pet is
 * drawn. In AR, light estimation can replace it later.
 */
export function applyPetEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, intensity = 0.8): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = intensity;
  return env;
}

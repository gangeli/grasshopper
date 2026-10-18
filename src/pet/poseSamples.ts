import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { Animator, type ActionName } from './Animator';
import { buildPet, type BoneName } from './PetModel';

const BONES: BoneName[] = ['head', 'neck', 'chest', 'hips', 'tail3', 'handL', 'handR', 'ankleL', 'ankleR'];
let cache: Partial<Record<ActionName, Vec3[]>> = {};

/**
 * Where the pet's body actually is in a given pose (offsets from its root,
 * facing +Z). Hide-spot scoring uses these so "hidden" means the real
 * crouched body is hidden, not an approximation.
 */
export function measurePoseSamples(action: ActionName): Vec3[] {
  if (cache[action]) return cache[action]!;
  const rig = buildPet('mint');
  const anim = new Animator(rig, 0);
  anim.play(action, 0, true);
  for (let i = 0; i < 40; i++) anim.update(1 / 30);
  rig.group.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  const out = BONES.map((b) => {
    rig.bones[b].getWorldPosition(p);
    if (b === 'head') p.y += 0.055;
    return { x: p.x, y: p.y, z: p.z };
  });
  cache[action] = out;
  return out;
}

export function resetPoseSampleCache() {
  cache = {};
}

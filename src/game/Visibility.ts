import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import type { PetRig, BoneName } from '../pet/PetModel';
import type { VoxelGrid } from '../world/VoxelGrid';

/** What the seeker (the phone/headset camera) is looking at. */
export interface ViewPose {
  pos: Vec3;
  /** Unit forward vector. */
  forward: Vec3;
  /** Unit up vector. */
  up: Vec3;
  fovY: number;
  aspect: number;
}

export function viewFromCamera(cam: THREE.PerspectiveCamera): ViewPose {
  cam.updateMatrixWorld();
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(cam.matrixWorld);
  // XR cameras carry their projection in projectionMatrix; derive the fov from it.
  const fovY = 2 * Math.atan(1 / cam.projectionMatrix.elements[5]);
  const aspect = cam.projectionMatrix.elements[5] / cam.projectionMatrix.elements[0];
  return { pos, forward, up, fovY: Number.isFinite(fovY) ? fovY : (cam.fov * Math.PI) / 180, aspect: Number.isFinite(aspect) ? aspect : cam.aspect };
}

/** Normalised screen coordinates (-1..1 inside) and depth, or null behind the camera. */
export function projectToView(v: ViewPose, p: Vec3): { x: number; y: number; depth: number } | null {
  const dx = p.x - v.pos.x, dy = p.y - v.pos.y, dz = p.z - v.pos.z;
  const f = v.forward, u = v.up;
  const r = { x: f.y * u.z - f.z * u.y, y: f.z * u.x - f.x * u.z, z: f.x * u.y - f.y * u.x };
  const depth = dx * f.x + dy * f.y + dz * f.z;
  if (depth < 0.05) return null;
  const sx = dx * r.x + dy * r.y + dz * r.z;
  const sy = dx * u.x + dy * u.y + dz * u.z;
  const t = Math.tan(v.fovY / 2);
  return { x: sx / (depth * t * v.aspect), y: sy / (depth * t), depth };
}

/** Bones sampled to decide whether the pet is visible, with weights. */
const SAMPLE_BONES: [BoneName, number][] = [
  ['head', 1.5],
  ['neck', 1],
  ['chest', 1],
  ['hips', 1],
  ['tail3', 0.5],
  ['handL', 0.4],
  ['handR', 0.4],
  ['ankleL', 0.4],
  ['ankleR', 0.4],
  ['antL3', 0.25],
  ['antR3', 0.25],
];

const _p = new THREE.Vector3();

export function petSamplePoints(rig: PetRig): { p: Vec3; w: number }[] {
  rig.group.updateMatrixWorld(true);
  return SAMPLE_BONES.map(([b, w]) => {
    rig.bones[b].getWorldPosition(_p);
    // Head bone sits at the neck joint; sample the middle of the head instead.
    if (b === 'head') _p.y += 0.055 * rig.group.scale.y;
    return { p: { x: _p.x, y: _p.y, z: _p.z }, w };
  });
}

/**
 * Weighted fraction of the pet that is on screen and not occluded by the
 * mapped world. 0 = completely hidden, 1 = fully in view.
 */
export function petVisibility(grid: VoxelGrid, view: ViewPose, samples: { p: Vec3; w: number }[], maxDist = 6, margin = 0.92): number {
  let vis = 0, total = 0;
  for (const { p, w } of samples) {
    total += w;
    const s = projectToView(view, p);
    if (!s || s.depth > maxDist || Math.abs(s.x) > margin || Math.abs(s.y) > margin) continue;
    // Occupied or inferred-solid (unseen space under an observed top) blocks sight.
    if (grid.segmentClear(view.pos, p, 0.03, true)) vis += w;
  }
  return total ? vis / total : 0;
}

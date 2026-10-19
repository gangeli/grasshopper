import * as THREE from 'three';
import type { VoxelGrid } from '../world/VoxelGrid';
import { occluderPositions } from '../world/occluderMesh';

/** The occluder mesh for the region around `center` (see occluderPositions). */
/** Half-size (m) of the region around the pet that the occluder covers. */
export const OCCLUDER_RADIUS = 3.5;

export function buildOccluderGeometry(g: VoxelGrid, center: THREE.Vector3, radius: number, minLayer: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(occluderPositions(g, center, radius, minLayer), 3));
  return geo;
}

export class Occluder {
  readonly mesh: THREE.Mesh;
  private builtVersion = -1;
  private builtGrid: VoxelGrid | null = null;
  private builtCenter = new THREE.Vector3(1e9, 0, 0);
  readonly material: THREE.MeshBasicMaterial;
  /** Visible (tinted) for debugging instead of depth-only. */
  set debugVisible(on: boolean) {
    // Called every frame: only touch the material when it changes (needsUpdate
    // makes three.js re-validate the program).
    if (this.material.colorWrite === on) return;
    this.material.colorWrite = on;
    this.material.opacity = on ? 0.35 : 1;
    this.material.transparent = on;
    this.material.needsUpdate = true;
  }

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ color: 0x66ccff, colorWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'occluder';
    // Draw before everything else so it fills the depth buffer first.
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  /** Does the mesh need rebuilding (the map changed, or the pet moved far from the last build centre)? */
  stale(g: VoxelGrid, center: THREE.Vector3): boolean {
    // A rebuilt map is a new grid object whose version restarts: compare identity too.
    return !(g === this.builtGrid && g.version === this.builtVersion && center.distanceTo(this.builtCenter) < 1.0);
  }

  /** Rebuild when stale (see stale()). */
  update(g: VoxelGrid, center: THREE.Vector3, minLayer: number, force = false): boolean {
    if (!force && !this.stale(g, center)) return false;
    this.install(occluderPositions(g, center, OCCLUDER_RADIUS, minLayer), g, g.version, center);
    return true;
  }

  /** Install a mesh built for grid `g` at `version` around `center` (here or in the nav worker). */
  install(positions: Float32Array, g: VoxelGrid, version: number, center: { x: number; y: number; z: number }) {
    this.builtGrid = g;
    // The old geometry's GPU buffers are freed, not just dropped.
    this.mesh.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.mesh.geometry = geo;
    this.builtVersion = version;
    this.builtCenter.set(center.x, center.y, center.z);
  }
}

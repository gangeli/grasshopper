import * as THREE from 'three';
import type { Vec3 } from '../core/math';

/**
 * A little ring on the floor where the player tapped: mint and pulsing while
 * Hopper heads there, a quick coral blip when Hopper can't go there. Lives in
 * the map frame (a sibling of the pet's rig).
 */
export class TapMarker {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private dot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private t = 0;
  private life = 0;
  private kind: 'go' | 'no' = 'go';

  constructor() {
    const mat = (c: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.1, 40).rotateX(-Math.PI / 2), mat(0x5ccf9f));
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24).rotateX(-Math.PI / 2), mat(0xfbf8f1));
    this.ring.renderOrder = this.dot.renderOrder = 5;
    this.group.add(this.ring, this.dot);
    this.group.visible = false;
    this.group.name = 'tap-marker';
  }

  /** Show at a map-frame point. `ok` false = Hopper can't go there. */
  show(p: Vec3, ok: boolean) {
    this.group.position.set(p.x, p.y + 0.008, p.z);
    this.kind = ok ? 'go' : 'no';
    this.ring.material.color.set(ok ? 0x5ccf9f : 0xff7a6b);
    this.t = 0;
    this.life = ok ? 3 : 1.1;
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  /** Fade out early once Hopper got there. */
  arrived() {
    if (this.group.visible && this.kind === 'go') this.life = Math.min(this.life, this.t + 0.4);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    const t = this.t;
    if (t >= this.life) {
      this.group.visible = false;
      return;
    }
    // Pop in with a little overshoot, pulse, fade out at the end.
    const pop = t < 0.25 ? 1.35 * Math.sin((t / 0.25) * (Math.PI / 2)) : 1 + 0.12 * Math.sin((t - 0.25) * 7) * (this.kind === 'go' ? 1 : 0);
    const fade = Math.min(1, (this.life - t) / 0.35);
    this.ring.scale.setScalar(Math.max(0.01, pop));
    this.dot.scale.setScalar(Math.max(0.01, this.kind === 'go' ? 1 : 0.6));
    this.ring.material.opacity = 0.95 * fade;
    this.dot.material.opacity = 0.9 * fade;
  }
}

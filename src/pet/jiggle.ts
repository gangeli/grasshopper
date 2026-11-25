import * as THREE from 'three';

const _j1 = new THREE.Vector3();
const _j2 = new THREE.Vector3();
const _j3 = new THREE.Vector3();
const _jq = new THREE.Quaternion();
const _jq2 = new THREE.Quaternion();
const _js = new THREE.Vector3();

/**
 * Secondary motion for a soft dangling part (antenna, ear, tail, wing): its tip
 * is a damped spring chasing where the animation puts it, and the lag is turned
 * back into a bend of the bone chain. The damping is relative to the target's
 * own velocity, so steady travel causes no lag - only accelerations do, which
 * gives the overlap and follow-through of a real soft appendage. A few vector
 * ops per chain per frame.
 */
export class Jiggle {
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly prevT = new THREE.Vector3();
  private live = false;
  constructor(
    private readonly chain: THREE.Object3D[],
    private readonly tipLocal: THREE.Vector3,
    private readonly freq: number,
    private readonly zeta: number,
    private readonly gain: number,
    private readonly maxBend: number,
  ) {}

  reset(): void {
    this.live = false;
  }

  /** Needs fresh world matrices; bends the chain's local rotations in place. */
  update(dt: number, weight = 1): void {
    const tip = this.chain[this.chain.length - 1];
    const T = _j1.copy(this.tipLocal).applyMatrix4(tip.matrixWorld);
    if (!this.live || dt <= 0 || weight <= 0.01 || T.distanceToSquared(this.pos) > 0.04 || !Number.isFinite(this.pos.x)) {
      this.pos.copy(T);
      this.vel.set(0, 0, 0);
      this.prevT.copy(T);
      this.live = true;
      return;
    }
    const w = 2 * Math.PI * this.freq, k = w * w, c = 2 * this.zeta * w;
    const tv = _j2.copy(T).sub(this.prevT).divideScalar(dt);
    this.prevT.copy(T);
    const n = Math.ceil(dt * 120), h = dt / n;
    for (let i = 0; i < n; i++) {
      // a = k (T - p) - c (v - v_T), semi-implicit Euler.
      const ax = k * (T.x - this.pos.x) - c * (this.vel.x - tv.x);
      const ay = k * (T.y - this.pos.y) - c * (this.vel.y - tv.y);
      const az = k * (T.z - this.pos.z) - c * (this.vel.z - tv.z);
      this.vel.x += ax * h;
      this.vel.y += ay * h;
      this.vel.z += az * h;
      this.pos.addScaledVector(this.vel, h);
    }
    // Bend the chain about its base so the tip moves towards the lagging point
    // (the stretch component along the chain is ignored).
    _j3.setFromMatrixPosition(this.chain[0].matrixWorld);
    const r = _j3.subVectors(T, _j3);
    const rl = r.length();
    if (rl < 1e-4) return;
    const d = _j2.subVectors(this.pos, T);
    d.addScaledVector(r, -d.dot(r) / (rl * rl));
    const angle = Math.min(this.maxBend, (this.gain * d.length()) / rl) * weight;
    if (angle < 1e-4) return;
    const axis = r.cross(d).normalize();
    const per = angle / this.chain.length;
    for (const b of this.chain) {
      b.parent!.matrixWorld.decompose(_js, _jq, _js);
      _j2.copy(axis).applyQuaternion(_jq.invert());
      b.quaternion.premultiply(_jq2.setFromAxisAngle(_j2, per));
    }
  }
}

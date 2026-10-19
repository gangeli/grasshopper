import * as THREE from 'three';
import { clamp, noise1, smoothstep } from '../core/math';
import type { BoneName, PetRig } from './PetModel';

/**
 * Procedural, layered animation for Hopper.
 *
 * Each action is a pure function (time, context) → pose channels. Active
 * actions cross-fade by weight; the blended pose then gets additive layers
 * (look-at, blinking, breathing) and physically simulated secondary motion
 * (antennae, ears, tail springs), and finally leg IK keeps the feet planted.
 */

export const CHANNELS = [
  'bodyX', 'bodyY', 'bodyZ', 'bodyPitch', 'bodyRoll', 'bodyYaw',
  'spinePitch', 'spineRoll', 'spineYaw', 'chestPitch', 'chestRoll', 'chestYaw',
  'neckPitch', 'neckYaw', 'neckRoll', 'headPitch', 'headYaw', 'headRoll',
  'armLPitch', 'armLRaise', 'elbowL', 'armRPitch', 'armRRaise', 'elbowR',
  'tailLift', 'tailSide', 'tailCurl',
  'wingSpread', 'wingFlap',
  'antLift', 'antSpread', 'earLift',
  'footLX', 'footLY', 'footLZ', 'footRX', 'footRY', 'footRZ', 'footPitch',
  'squash',
  'eyeOpen', 'happy', 'mouthOpen', 'smile', 'blush', 'pupilSize', 'lookX', 'lookY', 'lookWeight', 'glow',
] as const;
export type Channel = (typeof CHANNELS)[number];
export type Pose = Record<Channel, number>;

export function neutralPose(): Pose {
  const p = {} as Pose;
  for (const c of CHANNELS) p[c] = 0;
  p.eyeOpen = 1;
  p.smile = 1;
  p.pupilSize = 1;
  p.lookWeight = 1;
  p.glow = 0.6;
  return p;
}

export interface ActionCtx {
  /** Hop phase in [0,1) for locomotion. */
  hopPhase: number;
  /** Ground speed (m/s). */
  speed: number;
  /** Progress through a jump flight, [0,1]. */
  jumpU: number;
  /** Peek direction: +1 = to the pet's left, -1 = right, 0 = up/over. */
  peekSide: number;
  /** A per-pet random seed for idle variation. */
  seed: number;
}

export type ActionName =
  | 'idle' | 'hop' | 'jumpCrouch' | 'jumpAir' | 'land' | 'hide' | 'hideLow' | 'peek' | 'giggle'
  | 'surprised' | 'celebrate' | 'wave' | 'lookAround' | 'sniff' | 'coverEyes' | 'sleep';

type ActionFn = (t: number, c: ActionCtx, p: Pose) => void;

const TAU = Math.PI * 2;

/** Relaxed standing pose shared by many actions. */
function stand(t: number, c: ActionCtx, p: Pose) {
  const br = Math.sin(t * 2.4);
  p.bodyY = -0.004 + 0.0012 * br;
  p.squash = 0.012 * br;
  p.chestPitch = 0.03 * br - 0.04;
  p.bodyPitch = 0.06;
  p.bodyYaw = 0.06 * noise1(t * 0.35, c.seed);
  p.headRoll = 0.1 * noise1(t * 0.4, c.seed + 1);
  p.headPitch = -0.05;
  p.armLPitch = -0.25 + 0.05 * br;
  p.armRPitch = -0.25 + 0.05 * br;
  p.armLRaise = 0.15;
  p.armRRaise = 0.15;
  p.elbowL = 0.5;
  p.elbowR = 0.5;
  p.tailSide = 0.25 * Math.sin(t * 1.4 + c.seed);
  p.tailLift = 0.08 * Math.sin(t * 0.9);
  p.antLift = 0.05 * noise1(t * 0.8, c.seed + 2);
  p.antSpread = 0.05 * noise1(t * 0.6, c.seed + 3);
  p.earLift = 0.12 * Math.sin(t * 1.7);
  p.wingSpread = 0.05;
}

function hideBase(t: number, c: ActionCtx, p: Pose, low: boolean) {
  const br = Math.sin(t * 1.6);
  const k = low ? 1 : 0;
  p.bodyY = -0.036 - 0.014 * k + 0.0008 * br;
  p.squash = -0.1 - 0.05 * k;
  p.bodyPitch = 0.28 + 0.2 * k;
  p.spinePitch = 0.1 + 0.08 * k;
  p.chestPitch = 0.08;
  p.neckPitch = 0.12 + 0.15 * k;
  p.headPitch = -0.32 - 0.25 * k;
  p.armLPitch = -0.7;
  p.armRPitch = -0.7;
  p.armLRaise = 0.05;
  p.armRRaise = 0.05;
  p.elbowL = 1.1;
  p.elbowR = 1.1;
  p.tailCurl = 0.7;
  p.tailLift = -0.35;
  p.tailSide = 0.1 * Math.sin(t * 0.7);
  // Antennae fold back, but twitch now and then (a hint for sharp-eyed seekers).
  const twitch = Math.max(0, noise1(t * 0.9, c.seed + 5)) * 0.5;
  p.antLift = -0.75 + twitch;
  p.antSpread = 0.1;
  p.earLift = -0.6;
  p.wingSpread = -0.1;
  p.pupilSize = 1.25;
  p.smile = 0.4;
  p.eyeOpen = 0.95;
  p.footLZ = -0.006;
  p.footRZ = -0.006;
  p.glow = 0.25 + twitch * 0.5;
}

/** Locomotion hop cycle: crouch → push → flight → land. */
function hop(t: number, c: ActionCtx, p: Pose) {
  stand(t, c, p);
  const ph = c.hopPhase % 1;
  const sp = clamp(c.speed, 0, 1.5);
  const H = 0.018 + sp * 0.04;
  // Flight portion of the cycle.
  const f0 = 0.22, f1 = 0.92;
  let air = 0, compress = 0, stretch = 0;
  if (ph >= f0 && ph <= f1) {
    const u = (ph - f0) / (f1 - f0);
    air = 4 * u * (1 - u);
    stretch = u < 0.35 ? Math.sin((u / 0.35) * Math.PI) : 0;
  } else {
    const g = ph < f0 ? (ph + (1 - f1)) / (f0 + 1 - f1) : (ph - f1) / (f0 + 1 - f1);
    compress = Math.sin(g * Math.PI);
  }
  const lean = 0.12 + sp * 0.25;
  p.bodyY = H * air - 0.012 * compress - 0.004;
  p.squash = -0.14 * compress + 0.1 * stretch;
  p.bodyPitch = lean + 0.1 * compress - 0.08 * stretch;
  p.headPitch = -lean * 0.8 - 0.06 * compress;
  // Feet lift and swing: back on push-off, forward for landing.
  const tuck = air * (0.6 + sp * 0.3);
  p.footLY = p.footRY = H * tuck;
  const swing = ph < 0.5 ? -Math.sin(((ph - f0) / (0.5 - f0)) * Math.PI) : Math.sin(((ph - 0.5) / (f1 - 0.5)) * Math.PI);
  const sw = ph >= f0 && ph <= f1 ? swing : 0;
  p.footLZ = p.footRZ = 0.012 * sw * (0.6 + sp);
  p.footPitch = 0.4 * air;
  p.armLPitch = p.armRPitch = -0.3 + 0.7 * air * (0.5 + sp * 0.6) - 0.2 * compress;
  p.armLRaise = p.armRRaise = 0.25 + 0.2 * air;
  p.tailLift = 0.15 * air - 0.1 * compress;
  p.wingSpread = 0.15 * air * sp;
  p.earLift = -0.3 * sp + 0.2 * compress;
  p.antLift = -0.2 * sp;
  p.lookWeight = 0.3;
}

const ACTIONS: Record<ActionName, ActionFn> = {
  idle: stand,
  hop,
  jumpCrouch(t, c, p) {
    stand(t, c, p);
    const e = smoothstep(0, 0.22, t);
    const quiver = Math.sin(t * 60) * 0.004 * e;
    p.bodyY = -0.032 * e + quiver;
    p.squash = -0.2 * e;
    p.bodyPitch = 0.4 * e;
    p.headPitch = -0.55 * e;
    p.neckPitch = -0.1 * e;
    p.armLPitch = p.armRPitch = 0.7 * e;
    p.armLRaise = p.armRRaise = 0.35 * e;
    p.tailLift = 0.5 * e;
    p.wingSpread = 0.6 * e;
    p.antLift = -0.35 * e;
    p.earLift = -0.5 * e;
    p.pupilSize = 0.85;
    p.lookWeight = 0.4;
    p.smile = 0.6;
  },
  jumpAir(_t, c, p) {
    stand(_t, c, p);
    const u = clamp(c.jumpU, 0, 1);
    const early = 1 - smoothstep(0.0, 0.35, u);
    const late = smoothstep(0.65, 1, u);
    const mid = 1 - early - late;
    p.squash = 0.16 * early - 0.02 * mid + 0.04 * late;
    p.bodyPitch = -0.2 * early + 0.1 * mid + 0.15 * late;
    p.headPitch = -0.3 * early + 0.25 * late;
    // Legs: extended back on take-off, tucked mid-air, reaching on landing.
    p.footLY = p.footRY = 0.045 * mid + 0.01 * late;
    p.footLZ = p.footRZ = -0.03 * early + 0.0 * mid + 0.025 * late;
    p.footPitch = 0.5 * early + 0.4 * mid - 0.2 * late;
    p.armLPitch = p.armRPitch = -1.3 * early - 0.6 * mid - 0.2 * late;
    p.armLRaise = p.armRRaise = 0.7 * early + 0.9 * mid + 1.0 * late;
    p.elbowL = p.elbowR = 0.2;
    p.wingSpread = 1;
    p.wingFlap = 1;
    p.tailLift = -0.3 * early + 0.3 * late;
    p.earLift = -0.8 * early + 0.4 * late;
    p.antLift = -0.6 * early;
    p.eyeOpen = 1.1;
    p.mouthOpen = 0.35 * mid;
    p.happy = 0.3 * mid;
    p.lookWeight = 0.2;
  },
  land(t, c, p) {
    stand(t, c, p);
    // Damped squash spring after impact.
    const k = Math.exp(-t * 9) * Math.cos(t * 22);
    p.squash = -0.24 * k;
    p.bodyY = -0.03 * Math.max(0, k);
    p.bodyPitch = 0.25 * Math.max(0, k);
    p.armLRaise = p.armRRaise = 0.9 * Math.exp(-t * 6);
    p.armLPitch = p.armRPitch = -0.4;
    p.earLift = 0.6 * k;
    p.wingSpread = 0.6 * Math.exp(-t * 5);
    p.lookWeight = 0.5;
  },
  hide(t, c, p) {
    hideBase(t, c, p, false);
  },
  hideLow(t, c, p) {
    hideBase(t, c, p, true);
  },
  peek(t, c, p) {
    hideBase(t, c, p, false);
    // In: 0.5s, hold, out: 0.5s (total 1.8s).
    const e = smoothstep(0, 0.5, t) * (1 - smoothstep(1.3, 1.8, t));
    const s = c.peekSide;
    if (s === 0) {
      // Rise up and look over the top.
      p.bodyY += 0.05 * e;
      p.bodyPitch -= 0.25 * e;
      p.headPitch += 0.25 * e;
      p.antLift += 0.9 * e;
    } else {
      p.bodyX = 0.05 * s * e;
      p.bodyRoll = -0.4 * s * e;
      p.neckRoll = -0.25 * s * e;
      p.headRoll = -0.3 * s * e;
      p.neckYaw = 0.15 * s * e;
      p.antLift += 0.4 * e;
    }
    p.eyeOpen = 1.1;
    p.pupilSize = 1.35;
    p.smile = 0.2;
    p.mouthOpen = 0.12 * e;
    p.lookWeight = 1;
  },
  giggle(t, c, p) {
    hideBase(t, c, p, false);
    const shake = Math.sin(t * 30);
    p.bodyY += 0.012;
    p.chestRoll = 0.1 * shake;
    p.headRoll = 0.15 * Math.sin(t * 15);
    p.armLPitch = p.armRPitch = -1.1;
    p.armLRaise = p.armRRaise = 0.25;
    p.elbowL = p.elbowR = 1.6; // hands to mouth
    p.happy = 1;
    p.eyeOpen = 0.8;
    p.mouthOpen = 0.35 + 0.25 * Math.abs(Math.sin(t * 18));
    p.blush = 1;
    p.antLift = -0.2 + 0.25 * Math.sin(t * 14);
    p.tailSide = 0.5 * Math.sin(t * 12);
    p.glow = 1;
  },
  surprised(t, c, p) {
    stand(t, c, p);
    const hopUp = t < 0.35 ? Math.sin((t / 0.35) * Math.PI) : 0;
    p.bodyY = 0.035 * hopUp;
    p.footLY = p.footRY = 0.03 * hopUp;
    p.bodyZ = -0.03 * smoothstep(0, 0.3, t);
    p.squash = 0.16 * hopUp - 0.05;
    p.bodyPitch = -0.2;
    p.armLRaise = p.armRRaise = 1.4;
    p.armLPitch = p.armRPitch = -0.7;
    p.elbowL = p.elbowR = 0.3;
    p.eyeOpen = 1.2;
    p.pupilSize = 0.7;
    p.mouthOpen = 0.9;
    p.smile = 0;
    p.antLift = 0.7;
    p.antSpread = 0.4;
    p.earLift = 0.8;
    p.wingSpread = 1;
    p.wingFlap = 0.6;
    p.tailLift = 0.6;
    p.glow = 1;
  },
  celebrate(t, c, p) {
    // Hop in place with a spin, arms up.
    const ph = (t / 0.9) % 1;
    hop(t, { ...c, hopPhase: ph, speed: 1.0 }, p);
    const spin = Math.floor(t / 0.9) % 2 === 1;
    if (spin && ph > 0.22 && ph < 0.92) p.bodyYaw = TAU * smoothstep(0.22, 0.92, ph);
    p.armLRaise = p.armRRaise = 1.5 + 0.2 * Math.sin(t * 12);
    p.armLPitch = p.armRPitch = -0.9;
    p.elbowL = p.elbowR = 0.3 + 0.3 * Math.sin(t * 12);
    p.happy = 1;
    p.eyeOpen = 0.8;
    p.mouthOpen = 0.6;
    p.blush = 0.8;
    p.wingSpread = 1;
    p.wingFlap = 1;
    p.tailSide = 0.6 * Math.sin(t * 10);
    p.lookWeight = 0.6;
    p.glow = 1;
  },
  wave(t, c, p) {
    stand(t, c, p);
    const e = smoothstep(0, 0.3, t);
    p.armRRaise = 0.15 + 1.9 * e;
    p.armRPitch = -0.6 * e;
    p.elbowR = 0.5 + 0.5 * Math.sin(t * 10) * e;
    p.bodyRoll = 0.08 * e;
    p.headRoll = -0.15 * e;
    p.happy = 0.7 * e;
    p.eyeOpen = 1 - 0.4 * e;
    p.mouthOpen = 0.3 * e;
    p.antLift = 0.2 * e;
    p.earLift = 0.4 * e;
  },
  lookAround(t, c, p) {
    stand(t, c, p);
    const sweep = Math.sin(t * 1.3);
    p.headYaw = 0.8 * sweep;
    p.neckYaw = 0.35 * sweep;
    p.lookX = 0.6 * sweep;
    p.headPitch = -0.1 + 0.1 * Math.sin(t * 0.7);
    p.lookWeight = 0;
    p.antLift = 0.3;
    p.antSpread = 0.2 * sweep;
  },
  sniff(t, c, p) {
    stand(t, c, p);
    p.bodyPitch = 0.35;
    p.neckPitch = 0.25;
    p.headPitch = 0.15 + 0.06 * Math.sin(t * 16);
    p.headYaw = 0.4 * Math.sin(t * 1.1);
    p.antLift = 0.5 + 0.1 * Math.sin(t * 9);
    p.antSpread = 0.3;
    p.lookWeight = 0;
  },
  coverEyes(t, c, p) {
    stand(t, c, p);
    const e = smoothstep(0, 0.4, t);
    // Bow the head into raised hands.
    p.armLPitch = p.armRPitch = -2.1 * e;
    p.armLRaise = p.armRRaise = -0.15 * e;
    p.elbowL = p.elbowR = 1.1 * e;
    p.bodyPitch = 0.2 * e;
    p.neckPitch = 0.3 * e;
    p.headPitch = 0.45 * e;
    p.antLift = -0.3 * e;
    p.eyeOpen = 1 - e;
    p.happy = 0.6 * e;
    p.smile = 1;
    p.lookWeight = 0;
  },
  sleep(t, c, p) {
    hideBase(t, c, p, true);
    p.eyeOpen = 0;
    p.happy = 0.4;
    p.antLift = -0.9;
    p.glow = 0.15 + 0.1 * Math.sin(t * 1.2);
  },
};

interface Layer {
  name: ActionName;
  t: number;
  w: number;
  target: number;
  fade: number;
}

class Spring {
  x = 0;
  v = 0;
  constructor(public k = 120, public c = 9) {}
  step(target: number, drive: number, dt: number) {
    const a = -this.k * (this.x - target) - this.c * this.v + drive;
    this.v += a * dt;
    this.x += this.v * dt;
    if (!Number.isFinite(this.x)) this.x = this.v = 0;
    return this.x;
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Animator {
  readonly ctx: ActionCtx = { hopPhase: 0, speed: 0, jumpU: 0, peekSide: 1, seed: 0 };
  private layers: Layer[] = [{ name: 'idle', t: 0, w: 1, target: 1, fade: 4 }];
  readonly pose: Pose = neutralPose();
  private tmp: Pose = neutralPose();
  private time = 0;
  /** World-space look target (usually the camera). */
  lookTarget: THREE.Vector3 | null = null;
  private blinkT = 2;
  private blinkPhase = 1;
  private springs = {
    antPitch: new Spring(90, 7),
    antYaw: new Spring(90, 7),
    tailLift: new Spring(60, 6),
    tailSide: new Spring(50, 5),
    ear: new Spring(110, 8),
  };
  private lastHeadPos = new THREE.Vector3();
  private lastHeadVel = new THREE.Vector3();
  private hasLast = false;
  private restAnkle: Record<'L' | 'R', THREE.Vector3>;

  constructor(readonly rig: PetRig, seed = 0) {
    this.ctx.seed = seed;
    this.restAnkle = {
      L: rig.bones.ankleL.getWorldPosition(new THREE.Vector3()),
      R: rig.bones.ankleR.getWorldPosition(new THREE.Vector3()),
    };
    // Express in scaler (pet) space.
    rig.group.updateMatrixWorld(true);
    for (const s of ['L', 'R'] as const) rig.scaler.worldToLocal(this.restAnkle[s]);
  }

  /** Cross-fade to an action; restarting the same action resets its clock if `restart`. */
  play(name: ActionName, fadeTime = 0.2, restart = false): void {
    const top = this.layers[this.layers.length - 1];
    if (top && top.name === name && top.target === 1) {
      if (restart) top.t = 0;
      return;
    }
    const fade = 1 / Math.max(0.01, fadeTime);
    for (const l of this.layers) {
      l.target = 0;
      l.fade = fade;
    }
    const existing = this.layers.find((l) => l.name === name);
    if (existing && !restart) {
      existing.target = 1;
      existing.fade = fade;
      this.layers.splice(this.layers.indexOf(existing), 1);
      this.layers.push(existing);
    } else {
      this.layers.push({ name, t: 0, w: fadeTime <= 0 ? 1 : 0, target: 1, fade });
      if (fadeTime <= 0) for (const l of this.layers) if (l.name !== name || l !== this.layers[this.layers.length - 1]) l.w = 0;
    }
  }

  get current(): ActionName {
    return this.layers[this.layers.length - 1].name;
  }

  /** Seconds since the current action started. */
  get currentTime(): number {
    return this.layers[this.layers.length - 1].t;
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    // Advance & fade layers.
    for (const l of this.layers) {
      l.t += dt;
      const d = l.target - l.w;
      l.w += Math.sign(d) * Math.min(Math.abs(d), l.fade * dt);
    }
    this.layers = this.layers.filter((l) => l.w > 1e-3 || l.target > 0);

    // Blend.
    const P = this.pose;
    for (const c of CHANNELS) P[c] = 0;
    let wsum = 0;
    for (const l of this.layers) {
      const T = this.tmp;
      const n = neutralPose();
      Object.assign(T, n);
      ACTIONS[l.name](l.t, this.ctx, T);
      for (const c of CHANNELS) P[c] += T[c] * l.w;
      wsum += l.w;
    }
    if (wsum > 0) for (const c of CHANNELS) P[c] /= wsum;
    else Object.assign(P, neutralPose());

    // Blinking (suppressed while eyes are squeezed shut anyway).
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blinkPhase = 0;
      this.blinkT = 1.8 + Math.abs(noise1(this.time, 9)) * 3.5;
    }
    if (this.blinkPhase < 1) {
      this.blinkPhase = Math.min(1, this.blinkPhase + dt / 0.16);
      P.eyeOpen *= Math.abs(Math.cos(this.blinkPhase * Math.PI));
    }

    this.apply(dt);
  }

  private apply(dt: number): void {
    const { bones, rest, scaler, face } = this.rig;
    const P = this.pose;
    const set = (n: BoneName, x: number, y: number, z: number) => {
      bones[n].rotation.set(x, y, z);
    };
    // Squash & stretch with volume preservation.
    const sq = 1 + clamp(P.squash, -0.5, 0.5);
    scaler.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    bones.hips.position.set(rest.hips.x + P.bodyX, rest.hips.y + P.bodyY, rest.hips.z + P.bodyZ);
    set('hips', P.bodyPitch, P.bodyYaw, P.bodyRoll);
    set('spine', P.spinePitch, P.spineYaw, P.spineRoll);
    set('chest', P.chestPitch, P.chestYaw, P.chestRoll);

    // Look-at: split between neck and head, the remainder goes to the eyes.
    let lookYaw = 0, lookPitch = 0;
    if (this.lookTarget && P.lookWeight > 0) {
      this.rig.group.updateMatrixWorld(true);
      _v.copy(this.lookTarget);
      bones.chest.worldToLocal(_v);
      _v.sub(bones.neck.position);
      const yaw = Math.atan2(_v.x, _v.z);
      const pitch = -Math.atan2(_v.y - 0.05, Math.hypot(_v.x, _v.z));
      // Don't twist backwards for targets behind: fade out.
      const behind = smoothstep(1.9, 2.6, Math.abs(yaw));
      lookYaw = clamp(yaw, -1.3, 1.3) * P.lookWeight * (1 - behind);
      lookPitch = clamp(pitch, -0.8, 0.6) * P.lookWeight;
    }
    set('neck', P.neckPitch + lookPitch * 0.35, P.neckYaw + lookYaw * 0.4, P.neckRoll);
    set('head', P.headPitch + lookPitch * 0.5, P.headYaw + lookYaw * 0.45, P.headRoll);

    // Arms (positive pitch swings back; raise lifts outward).
    set('shoulderL', P.armLPitch, 0, P.armLRaise);
    set('shoulderR', P.armRPitch, 0, -P.armRRaise);
    set('elbowL', -P.elbowL, 0, 0);
    set('elbowR', -P.elbowR, 0, 0);

    // Secondary motion from head acceleration.
    this.rig.group.updateMatrixWorld(true);
    const headPos = bones.head.getWorldPosition(_v2);
    let accLocal = new THREE.Vector3();
    if (this.hasLast && dt > 0) {
      const vel = headPos.clone().sub(this.lastHeadPos).divideScalar(dt);
      const acc = vel.clone().sub(this.lastHeadVel).divideScalar(dt);
      this.lastHeadVel.copy(vel);
      // Into the pet's frame.
      bones.head.getWorldQuaternion(_q);
      accLocal = acc.applyQuaternion(_q.invert());
      accLocal.clampLength(0, 40);
    }
    this.lastHeadPos.copy(headPos);
    this.hasLast = true;
    const sp = this.springs;
    const antP = sp.antPitch.step(0, accLocal.z * 0.9 + accLocal.y * 0.5, dt);
    const antY = sp.antYaw.step(0, -accLocal.x * 0.9, dt);
    const ear = sp.ear.step(0, accLocal.y * 0.8, dt);
    const tl = sp.tailLift.step(0, accLocal.y * 0.6, dt);
    const ts = sp.tailSide.step(0, -accLocal.x * 0.8, dt);

    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1;
      const lift = -P.antLift * 0.45 + antP * 0.04;
      const spread = P.antSpread * 0.4 * s + antY * 0.03;
      for (let q = 0; q < 4; q++) {
        const wob = 0.04 * noise1(this.time * 1.3 + q * 0.4, this.ctx.seed + (s > 0 ? 11 : 13));
        set(`ant${side}${q}` as BoneName, lift * (0.5 + q * 0.3) + wob, spread * (0.6 + q * 0.2), -spread * 0.3);
      }
      set(`ear${side}` as BoneName, 0, 0, s * (-P.earLift * 0.5 + ear * 0.05));
      // Wings: fold back, spread out, flap.
      const flap = P.wingFlap * Math.sin(this.time * 55) * 0.6;
      // At rest the wings lie folded back along the shoulders. Spreading raises
      // them in the plane of the back (so they stay face-on and peek above the
      // shoulders) with a little outward swing.
      set(`wing${side}` as BoneName, 0.1 - P.wingSpread * 0.3, -s * (P.wingSpread * 0.35 + flap * 0.3), s * (P.wingSpread * 0.6 + flap * 0.7));
    }
    // Tail chain: curl, lift and sway distributed along the bones, with spring lag.
    for (let q = 0; q < 6; q++) {
      const f = (q + 1) / 6;
      set(
        `tail${q}` as BoneName,
        -P.tailLift * 0.25 + tl * 0.02 * f - P.tailCurl * 0.22 * f,
        P.tailSide * 0.18 + ts * 0.02 * f,
        0,
      );
    }

    // Face.
    const open = clamp(P.eyeOpen, 0, 1.25);
    const happy = clamp(P.happy, 0, 1);
    // Upper lid: a hemispherical shell that rotates from tucked back (open)
    // to covering the front of the eye (closed). Lower lid rises for squints.
    const up = THREE.MathUtils.lerp(1.5, -1.65, clamp(open + happy * 0.5, 0, 1)) - (open > 1 ? (open - 1) * 0.6 : 0);
    const lo = THREE.MathUtils.lerp(1.65, 0.62, happy);
    face.lidUpL.rotation.x = face.lidUpR.rotation.x = up;
    face.lidLoL.rotation.x = face.lidLoR.rotation.x = lo;
    const ps = clamp(P.pupilSize, 0.5, 1.5);
    for (const ir of [face.irisL, face.irisR]) {
      const pupil = ir.getObjectByName('pupil')!;
      pupil.scale.set(ps, ps, 1);
    }
    // Remaining look offset goes to the eyes.
    const eyeYaw = clamp(P.lookX * 0.5 + lookYaw * 0.3, -0.5, 0.5);
    const eyePitch = clamp(-P.lookY * 0.4 + lookPitch * 0.3, -0.4, 0.4);
    face.irisL.rotation.set(eyePitch, eyeYaw - 0.25, 0);
    face.irisR.rotation.set(eyePitch, eyeYaw + 0.25, 0);
    const mo = clamp(P.mouthOpen, 0, 1);
    face.mouthOpen.scale.set(0.8 + mo * 0.4, 0.2 + mo * 1.1, 0.01 + mo * 0.12);
    face.mouthOpen.visible = mo > 0.04;
    face.smile.visible = mo < 0.25;
    face.smile.scale.set(1, clamp(P.smile, 0.05, 1.2), 1);
    face.blushMat.opacity = 0.35 + 0.5 * clamp(P.blush, 0, 1);
    this.rig.glowMaterial.emissiveIntensity = 0.2 + 1.4 * clamp(P.glow, 0, 1.2);

    this.solveLegs(P);
  }

  /** Analytic two-bone IK in each leg's sagittal plane, plus foot flattening. */
  private solveLegs(P: Pose): void {
    const { bones, scaler } = this.rig;
    this.rig.group.updateMatrixWorld(true);
    for (const side of ['L', 'R'] as const) {
      const thigh = bones[`thigh${side}`], shin = bones[`shin${side}`], ankle = bones[`ankle${side}`];
      const target = this.restAnkle[side].clone();
      target.x += side === 'L' ? P.footLX : P.footRX;
      target.y += side === 'L' ? P.footLY : P.footRY;
      target.z += side === 'L' ? P.footLZ : P.footRZ;
      // To the hips' frame, relative to the hip joint.
      scaler.localToWorld(target);
      bones.hips.worldToLocal(target);
      target.sub(thigh.position);
      const s1 = shin.position, s2 = ankle.position;
      const l1 = Math.hypot(s1.y, s1.z), l2 = Math.hypot(s2.y, s2.z);
      const phi1Rest = Math.atan2(s1.z, -s1.y), phi2Rest = Math.atan2(s2.z, -s2.y);
      let d = Math.hypot(target.y, target.z);
      d = clamp(d, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
      const phiT = Math.atan2(target.z, -target.y);
      const a1 = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
      const phi1 = phiT + a1; // knee forward
      const kz = l1 * Math.sin(phi1), ky = -l1 * Math.cos(phi1);
      const tz = d * Math.sin(phiT), ty = -d * Math.cos(phiT);
      const phi2 = Math.atan2(tz - kz, -(ty - ky));
      const aThigh = phi1Rest - phi1;
      const aShin = phi2Rest - phi2 - aThigh;
      // Sideways: swing the thigh so the foot lands at the target x.
      const restTx = s1.x + s2.x;
      const roll = Math.atan2(target.x, d) - Math.atan2(restTx, d);
      thigh.rotation.set(aThigh, 0, roll);
      shin.rotation.set(aShin, 0, 0);
      // Keep the foot level with the ground (minus the body's pitch), plus foot pitch.
      ankle.rotation.set(P.footPitch - aThigh - aShin - P.bodyPitch, 0, -roll);
    }
  }
}

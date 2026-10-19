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
  'footLX', 'footLY', 'footLZ', 'footRX', 'footRY', 'footRZ', 'footPitch', 'footPlant',
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
  p.footPlant = 1;
  return p;
}

export interface ActionCtx {
  /** Hop phase in [0,1) for locomotion. */
  hopPhase: number;
  /** Ground speed (m/s). */
  speed: number;
  /** Hop cycles per second (so the feet can stay planted for the right stride). */
  hopRate: number;
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

/** Channels that place the body (not the face), for blending one posture into another. */
const BODY_CHANNELS: readonly Channel[] = CHANNELS.filter((c) => c.startsWith('body') || /^(spine|chest|neck|head|arm|elbow|tail|wing|ant|ear|foot|squash)/.test(c));

type ActionFn = (t: number, c: ActionCtx, p: Pose) => void;

const TAU = Math.PI * 2;

/** Relaxed standing pose shared by many actions. */
function stand(t: number, c: ActionCtx, p: Pose) {
  // Breathing whose rate drifts a little, so it never reads as a metronome.
  const br = Math.sin(t * 2.3 + 0.9 * noise1(t * 0.15, c.seed + 7));
  // Slow weight shifts from foot to foot (the feet stay planted, so the hips
  // sway over them) with the spine and head counter-rolling to stay level.
  const ws = noise1(t * 0.16, c.seed + 8);
  p.bodyX = 0.007 * ws;
  p.bodyRoll = -0.05 * ws;
  p.spineRoll = 0.03 * ws;
  p.bodyY = -0.004 + 0.0014 * br - 0.0015 * Math.abs(ws);
  p.squash = 0.014 * br;
  p.chestPitch = 0.035 * br - 0.04;
  p.bodyPitch = 0.06;
  p.bodyYaw = 0.06 * noise1(t * 0.35, c.seed);
  p.headRoll = 0.1 * noise1(t * 0.4, c.seed + 1) + 0.02 * ws;
  p.headPitch = -0.05 - 0.012 * br;
  p.armLPitch = -0.25 + 0.05 * br + 0.04 * noise1(t * 0.5, c.seed + 9);
  p.armRPitch = -0.25 + 0.05 * br + 0.04 * noise1(t * 0.5, c.seed + 10);
  p.armLRaise = 0.15 + 0.03 * ws;
  p.armRRaise = 0.15 - 0.03 * ws;
  p.elbowL = 0.5;
  p.elbowR = 0.5;
  // Lazy tail: a slow wander with the occasional lively swish.
  p.tailSide = 0.22 * noise1(t * 0.45, c.seed + 4) + 0.12 * Math.sin(t * 1.3 + c.seed) * (0.5 + 0.5 * noise1(t * 0.2, c.seed + 5));
  p.tailLift = 0.06 * Math.sin(t * 0.9) + 0.04 * br;
  p.antLift = 0.05 * noise1(t * 0.8, c.seed + 2);
  p.antSpread = 0.05 * noise1(t * 0.6, c.seed + 3);
  p.earLift = 0.1 * noise1(t * 0.7, c.seed + 6);
  p.wingSpread = 0.05 + 0.02 * br;
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

/**
 * Locomotion hop cycle: land → compress → push off → flight. `travel` is how
 * fast the pet really moves over the ground (m/s): while the feet are down
 * they slide back under the body at exactly that speed, so they stay planted.
 */
function hop(t: number, c: ActionCtx, p: Pose, travel = c.speed) {
  stand(t, c, p);
  const ph = c.hopPhase % 1;
  const sp = clamp(c.speed, 0, 1.5);
  const H = 0.016 + sp * 0.036;
  // Flight portion of the cycle; the rest is ground contact.
  const f0 = 0.22, f1 = 0.92;
  const contact = f0 + 1 - f1;
  let air = 0, compress = 0, stretch = 0, g = 0, u = 0;
  const flying = ph >= f0 && ph <= f1;
  if (flying) {
    u = (ph - f0) / (f1 - f0);
    air = 4 * u * (1 - u);
    stretch = u < 0.35 ? Math.sin((u / 0.35) * Math.PI) : 0;
  } else {
    // g: 0 at touch-down → 1 at push-off. The impact compresses fast, the
    // push-off extends a little slower.
    g = ph < f0 ? (ph + (1 - f1)) / contact : (ph - f1) / contact;
    compress = Math.sin(Math.pow(g, 0.75) * Math.PI);
  }
  const lean = 0.12 + sp * 0.25;
  p.bodyY = H * air - 0.012 * compress - 0.004;
  p.squash = -0.08 * compress + 0.06 * stretch;
  // Compression goes into squash and a deeper spine curl rather than a big
  // whole-body pitch, so the head rides level instead of nodding with each hop.
  p.bodyPitch = lean + 0.04 * compress - 0.04 * stretch;
  p.spinePitch = 0.06 * compress;
  p.headPitch = -lean * 0.8 - 0.14 * compress + 0.03 * stretch;
  // Head lags the bounce a touch: chin dips just after landing, lifts at the apex.
  p.neckPitch = 0.04 * compress - 0.03 * air;
  // Feet: planted while down (sliding back under the body at ground speed),
  // tucked and swung forward in flight to reach for the next landing.
  const stride = clamp(travel, 0, 2) / Math.max(0.5, c.hopRate);
  const h = 0.5 * stride * contact;
  // Feet snap up off the ground and come down late (no skimming the floor).
  const tuck = Math.pow(Math.sin(Math.PI * u), 0.35) * (0.6 + sp * 0.3);
  p.footLY = p.footRY = flying ? H * tuck : 0;
  let fz: number;
  if (flying) {
    // Trail behind on push-off, then swing through to reach ahead.
    const swing = smoothstep(0.15, 0.85, u);
    fz = -h + 2 * h * swing - 0.008 * (0.6 + sp) * Math.sin(Math.min(1, u / 0.45) * Math.PI) + 0.008 * sp * smoothstep(0.6, 1, u);
  } else fz = h - 2 * h * g;
  p.footLZ = p.footRZ = fz;
  p.footPitch = 0.35 * air;
  p.footPlant = flying ? 0 : 1;
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
    const late = smoothstep(0.62, 1, u);
    const mid = 1 - early - late;
    // Take-off: stretched long and leaning into the leap, legs trailing fully
    // extended behind. Apex: balled up, legs tucked. Descent: opening out with
    // the feet reaching forward for the landing and the body leaning back.
    p.squash = 0.15 * early - 0.04 * mid + 0.03 * late;
    p.bodyPitch = 0.22 * early + 0.02 * mid - 0.12 * late;
    p.spinePitch = -0.06 * early + 0.08 * mid - 0.04 * late;
    p.neckPitch = 0.05 * mid;
    p.headPitch = -0.38 * early - 0.1 * mid + 0.12 * late;
    p.footLY = p.footRY = 0.012 * early + 0.06 * mid + 0.022 * late;
    p.footLZ = p.footRZ = -0.05 * early + 0.008 * mid + 0.034 * late;
    p.footPitch = 0.9 * early + 0.5 * mid - 0.25 * late;
    p.footPlant = 0;
    p.armLPitch = p.armRPitch = -1.3 * early - 0.6 * mid - 0.35 * late;
    p.armLRaise = p.armRRaise = 0.7 * early + 0.9 * mid + 1.0 * late;
    p.elbowL = p.elbowR = 0.2 + 0.4 * mid;
    p.wingSpread = 1;
    p.wingFlap = 1;
    p.tailLift = -0.35 * early + 0.05 * mid + 0.35 * late;
    p.earLift = -0.8 * early - 0.2 * mid + 0.4 * late;
    p.antLift = -0.6 * early - 0.1 * mid + 0.2 * late;
    p.eyeOpen = 1.1;
    p.mouthOpen = 0.35 * mid;
    p.happy = 0.3 * mid;
    p.lookWeight = 0.2;
  },
  land(t, c, p) {
    stand(t, c, p);
    // Damped squash spring after impact; the head and arms carry on a moment
    // later (follow-through) and everything settles within ~0.4 s.
    const k = Math.exp(-t * 9) * Math.cos(t * 22);
    const lagT = Math.max(0, t - 0.05);
    const kh = Math.exp(-lagT * 8) * Math.sin(lagT * 18);
    p.squash = -0.2 * k;
    p.bodyY = -0.03 * Math.max(0, k);
    p.bodyPitch = 0.06 + 0.22 * Math.max(0, k);
    p.headPitch = -0.05 + 0.22 * kh;
    p.neckPitch = 0.1 * kh;
    p.armLRaise = p.armRRaise = 0.15 + 0.75 * Math.exp(-t * 6);
    p.armLPitch = p.armRPitch = -0.4 + 0.3 * kh;
    p.earLift = 0.6 * k;
    p.tailLift = -0.2 * kh;
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
    // Stays crouched (it may be giggling from a hiding spot) but the head comes
    // up, eyes squeeze into happy "^^" arcs and the whole body bounces with
    // each "hee".
    hideBase(t, c, p, false);
    const e = smoothstep(0, 0.2, t);
    const hee = Math.abs(Math.sin(t * 9));
    const shake = Math.sin(t * 30);
    p.bodyY += 0.01 + 0.007 * hee * e;
    p.squash += 0.07 + 0.05 * hee * e;
    p.bodyPitch -= 0.12 * e;
    p.spinePitch -= 0.06 * e;
    p.chestRoll = 0.05 * shake;
    p.neckPitch = -0.1 * e;
    // Chin up, a happy side-to-side head tilt and a little nod per giggle.
    p.headPitch = -0.12 - 0.12 * e - 0.08 * hee;
    p.headRoll = 0.2 * Math.sin(t * 4.5) * e;
    p.headYaw = 0.1 * Math.sin(t * 2.3);
    // Paws clasped under the chin.
    p.armLPitch = p.armRPitch = -1.15;
    p.armLRaise = p.armRRaise = -0.05;
    p.elbowL = p.elbowR = 1.25;
    p.happy = 1;
    p.eyeOpen = 0.9;
    p.smile = 1;
    p.mouthOpen = (0.3 + 0.3 * hee) * e;
    p.blush = 1;
    p.antLift = 0.25 + 0.3 * Math.sin(t * 14);
    p.antSpread = 0.2;
    p.earLift = 0.35 + 0.25 * Math.sin(t * 9);
    p.tailSide = 0.5 * Math.sin(t * 12);
    p.tailLift = 0.1;
    p.wingSpread = 0.2;
    p.lookWeight = 0.7;
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
    // A startled buzz that settles into a held flare (a steady flap reads as flicker).
    p.wingSpread = 1;
    p.wingFlap = 0.6 * Math.exp(-t * 5);
    p.tailLift = 0.6;
    p.glow = 1;
  },
  celebrate(t, c, p) {
    // Hop in place with a spin, arms up.
    const ph = (t / 0.9) % 1;
    hop(t, { ...c, hopPhase: ph, speed: 1.0 }, p, 0);
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
    // Nodding off: the lids get heavy and the head dips first, then the body
    // sinks into a curled-up sleep with slow, deep breaths.
    hideBase(t, c, p, true);
    const sink = smoothstep(0.5, 1.8, t);
    if (sink < 1) {
      const S = neutralPose();
      stand(t, c, S);
      for (const ch of BODY_CHANNELS) p[ch] = S[ch] + (p[ch] - S[ch]) * sink;
    }
    const nod = smoothstep(0, 0.6, t) * (1 - smoothstep(1.2, 1.8, t));
    p.headPitch += 0.25 * nod;
    p.eyeOpen = 1 - smoothstep(0, 0.9, t) + 0.25 * Math.max(0, Math.sin(Math.PI * clamp((t - 0.45) / 0.3, 0, 1)));
    // ~0.2 Hz breathing, the in-breath quicker than the out-breath.
    const ph = (t * 0.21 + 0.1 * noise1(t * 0.1, c.seed + 12)) % 1;
    const br = ph < 0.4 ? smoothstep(0, 0.4, ph) : 1 - smoothstep(0.4, 1, ph);
    const deep = sink;
    p.squash += 0.035 * br * deep;
    p.bodyY += 0.003 * br * deep;
    p.chestPitch -= 0.08 * br * deep;
    p.headPitch -= 0.05 * br * deep;
    p.happy = 0.4;
    p.smile = 0.6;
    p.mouthOpen = 0.05 * br * deep;
    p.antLift = -0.4 - 0.5 * sink + 0.12 * br * deep;
    p.earLift = -0.6 * sink - 0.1 * br * deep;
    p.tailSide = 0.04 * Math.sin(t * 0.4);
    p.lookWeight = 0.4 * (1 - sink);
    p.glow = 0.15 + 0.15 * br;
  },
};

interface Layer {
  name: ActionName;
  t: number;
  w: number;
  target: number;
  fade: number;
}

/** Small seeded PRNG (mulberry32): idle variation that looks random but replays exactly. */
function makeRng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
class Jiggle {
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
    this.chain[0].getWorldPosition(_j3);
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

type FootState = { locked: boolean; world: THREE.Vector3; off: THREE.Vector3; step: number; len: number };
const STEP_TIME = 0.14;

const _v = new THREE.Vector3();

export class Animator {
  readonly ctx: ActionCtx = { hopPhase: 0, speed: 0, hopRate: 2.6, jumpU: 0, peekSide: 1, seed: 0 };
  private layers: Layer[] = [{ name: 'idle', t: 0, w: 1, target: 1, fade: 4 }];
  readonly pose: Pose = neutralPose();
  private tmp: Pose = neutralPose();
  private time = 0;
  /** Look target (usually the camera), in the pet's parent frame (= world in the sim, map frame in AR). */
  lookTarget: THREE.Vector3 | null = null;
  private blinkT = 2;
  private blinkPhase = 1;
  private sinceBlink = 0;
  private rand: () => number;
  /** Head-and-neck share of the look-at, which lags the eyes (they lead the turn). */
  private gaze = { yaw: 0, pitch: 0, vy: 0, vp: 0 };
  /** Small darting eye movements around the look target. */
  private sacc = { x: 0, y: 0, tx: 0, ty: 0, t: 0.8 };
  /** An occasional single-ear flick. */
  private twitch = { t: 3, ph: 1, side: 1, amp: 1 };
  private jiggles: { ant: Jiggle[]; ear: Jiggle[]; tail: Jiggle; wing: Jiggle[] };
  private feet: Record<'L' | 'R', FootState>;
  private restAnkle: Record<'L' | 'R', THREE.Vector3>;
  /** Wing membranes and their motion-blur fans (absent on custom rigs). */
  private wingMat: THREE.Material | null = null;
  private wingBlur: Record<'L' | 'R', THREE.Object3D | undefined>;

  constructor(readonly rig: PetRig, seed = 0) {
    this.ctx.seed = seed;
    this.rand = makeRng(seed + 1);
    const b = rig.bones;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    this.jiggles = {
      ant: (['L', 'R'] as const).map((s) => new Jiggle([0, 1, 2, 3].map((q) => b[`ant${s}${q}` as BoneName]), V(0, 0, 0), 3.1, 0.2, 1.1, 0.7)),
      ear: ([['L', 1], ['R', -1]] as const).map(([s, k]) => new Jiggle([b[`ear${s}`]], V(0.044 * k, 0.023, -0.023), 4.2, 0.28, 0.9, 0.45)),
      tail: new Jiggle([0, 1, 2, 3, 4, 5].map((q) => b[`tail${q}` as BoneName]), V(0, 0, 0), 2.1, 0.3, 0.9, 0.55),
      wing: ([['L', 1], ['R', -1]] as const).map(([s, k]) => new Jiggle([b[`wing${s}`]], V(0.06 * k, 0.05, -0.07), 4.8, 0.32, 0.8, 0.35)),
    };
    const foot = (): FootState => ({ locked: false, world: new THREE.Vector3(), off: new THREE.Vector3(), step: 0, len: 0 });
    this.feet = { L: foot(), R: foot() };
    this.restAnkle = {
      L: rig.bones.ankleL.getWorldPosition(new THREE.Vector3()),
      R: rig.bones.ankleR.getWorldPosition(new THREE.Vector3()),
    };
    // Express in scaler (pet) space.
    rig.group.updateMatrixWorld(true);
    for (const s of ['L', 'R'] as const) rig.scaler.worldToLocal(this.restAnkle[s]);
    this.wingBlur = { L: rig.group.getObjectByName('wingBlurL'), R: rig.group.getObjectByName('wingBlurR') };
    const wm = rig.group.getObjectByName('wingMeshL') as THREE.Mesh | undefined;
    if (wm && !Array.isArray(wm.material)) this.wingMat = wm.material;
  }

  /** Back to a fresh idle with all simulated state cleared (pose lab, tests). */
  reset(): void {
    this.layers = [{ name: 'idle', t: 0, w: 1, target: 1, fade: 4 }];
    this.time = 0;
    this.blinkT = 2;
    this.blinkPhase = 1;
    this.sinceBlink = 0;
    this.rand = makeRng(this.ctx.seed + 1);
    Object.assign(this.gaze, { yaw: 0, pitch: 0, vy: 0, vp: 0 });
    Object.assign(this.sacc, { x: 0, y: 0, tx: 0, ty: 0, t: 0.8 });
    Object.assign(this.twitch, { t: 3, ph: 1 });
    const j = this.jiggles;
    for (const g of [...j.ant, ...j.ear, j.tail, ...j.wing]) g.reset();
    for (const f of Object.values(this.feet)) {
      Object.assign(f, { locked: false, step: 0, len: 0 });
      f.off.set(0, 0, 0);
    }
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
      // Ease in and out of each cross-fade rather than blending linearly.
      const w = l.w * l.w * (3 - 2 * l.w);
      for (const c of CHANNELS) P[c] += T[c] * w;
      wsum += w;
    }
    if (wsum > 0) for (const c of CHANNELS) P[c] /= wsum;
    else Object.assign(P, neutralPose());

    // Blinking: irregular gaps (mostly 2-4 s, sometimes long stares), now and
    // then a quick double blink; the lids drop fast and lift more slowly.
    this.blinkT -= dt;
    this.sinceBlink += dt;
    if (this.blinkT <= 0) this.startBlink();
    if (this.blinkPhase < 1) {
      this.blinkPhase = Math.min(1, this.blinkPhase + dt / 0.2);
      const x = this.blinkPhase;
      const close = x < 0.28 ? smoothstep(0, 0.28, x) : x < 0.4 ? 1 : 1 - smoothstep(0.4, 1, x);
      P.eyeOpen *= 1 - close;
    }

    this.apply(dt);
  }

  private startBlink(): void {
    this.blinkPhase = 0;
    this.sinceBlink = 0;
    const r = this.rand();
    this.blinkT = r < 0.15 ? 0.24 + 0.06 * this.rand() : 1.3 + Math.min(6, -Math.log(1 - this.rand()) * 2.3);
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
    const lt = this.lookTarget;
    if (lt && Number.isFinite(lt.x) && Number.isFinite(lt.y) && Number.isFinite(lt.z) && P.lookWeight > 0) {
      this.rig.group.updateMatrixWorld(true);
      // The target is in the pet's parent frame (the map frame in AR).
      _v.copy(lt);
      if (this.rig.group.parent) _v.applyMatrix4(this.rig.group.parent.matrixWorld);
      bones.chest.worldToLocal(_v);
      _v.sub(bones.neck.position);
      const yaw = Math.atan2(_v.x, _v.z);
      const pitch = -Math.atan2(_v.y - 0.05, Math.hypot(_v.x, _v.z));
      // Don't twist backwards for targets behind: fade out.
      const behind = smoothstep(1.9, 2.6, Math.abs(yaw));
      lookYaw = clamp(yaw, -1.3, 1.3) * P.lookWeight * (1 - behind);
      lookPitch = clamp(pitch, -0.8, 0.6) * P.lookWeight;
    }
    // The eyes jump to the target at once; head and neck follow on a
    // critically damped spring (~0.3 s), so a look starts in the eyes. A big
    // gaze shift brings a blink with it, as it does in people and animals.
    const g = this.gaze, gw = 9;
    if (dt > 0) {
      g.vy += (gw * gw * (lookYaw - g.yaw) - 2 * gw * g.vy) * dt;
      g.vp += (gw * gw * (lookPitch - g.pitch) - 2 * gw * g.vp) * dt;
      g.yaw += g.vy * dt;
      g.pitch += g.vp * dt;
    }
    if (Math.abs(lookYaw - g.yaw) > 0.5 && this.blinkPhase >= 1 && this.sinceBlink > 0.6 && P.eyeOpen > 0.5) this.startBlink();
    set('neck', P.neckPitch + g.pitch * 0.35, P.neckYaw + g.yaw * 0.42, P.neckRoll);
    set('head', P.headPitch + g.pitch * 0.5, P.headYaw + g.yaw * 0.5, P.headRoll);
    // Saccades: every so often the eyes dart a little around the target (and
    // back to it), which is most of what makes a still face look alive.
    const sc = this.sacc;
    sc.t -= dt;
    if (sc.t <= 0) {
      const back = this.rand() < 0.4;
      sc.tx = back ? 0 : (this.rand() - 0.5) * 0.18;
      sc.ty = back ? 0 : (this.rand() - 0.5) * 0.09;
      sc.t = 0.35 + this.rand() * 1.9;
    }
    const sk = Math.min(1, dt * 30);
    sc.x += (sc.tx - sc.x) * sk;
    sc.y += (sc.ty - sc.y) * sk;
    const saccW = clamp(P.lookWeight, 0, 1);

    // Arms (positive pitch swings back; raise lifts outward).
    set('shoulderL', P.armLPitch, 0, P.armLRaise);
    set('shoulderR', P.armRPitch, 0, -P.armRRaise);
    set('elbowL', -P.elbowL, 0, 0);
    set('elbowR', -P.elbowR, 0, 0);

    // Ear flicks: a quick twitch of one ear every few seconds.
    const tw = this.twitch;
    tw.t -= dt;
    if (tw.t <= 0) {
      tw.ph = 0;
      tw.side = this.rand() < 0.5 ? 1 : -1;
      tw.amp = 0.6 + 0.6 * this.rand();
      tw.t = 2.5 + this.rand() * 5.5;
    }
    tw.ph = Math.min(1, tw.ph + dt / 0.32);
    // Snap back, then spring forward again (a flick, not a wave).
    const flick = tw.ph < 1 ? Math.sin(tw.ph * Math.PI * 2) * (1 - tw.ph) * tw.amp : 0;

    // Fast flapping blurs: the membrane itself only flutters a little and fades,
    // while faint copies fanned across the stroke draw the blurred arc.
    const flapAmp = clamp(P.wingFlap, 0, 1.5) * 0.6;
    const blurK = smoothstep(0.15, 0.55, P.wingFlap);
    const flapNow = flapAmp * Math.sin(this.time * 55) * (1 - 0.75 * blurK);
    if (this.wingMat) this.wingMat.opacity = 1 - 0.55 * blurK;
    for (const side of ['L', 'R'] as const) {
      const s = side === 'L' ? 1 : -1;
      const fan = this.wingBlur[side];
      if (fan) {
        fan.visible = blurK > 0.01;
        if (fan.visible) {
          (fan.userData.mat as THREE.Material).opacity = 0.14 * blurK;
          for (const pv of fan.children) {
            const d = (pv.userData.f as number) * flapAmp - flapNow;
            pv.rotation.set(0, -s * d * 0.3, s * d * 0.7);
          }
        }
      }
      const lift = -P.antLift * 0.45;
      const spread = P.antSpread * 0.4 * s;
      for (let q = 0; q < 4; q++) {
        const wob = 0.04 * noise1(this.time * 1.3 + q * 0.4, this.ctx.seed + (s > 0 ? 11 : 13));
        set(`ant${side}${q}` as BoneName, lift * (0.5 + q * 0.3) + wob, spread * (0.6 + q * 0.2), -spread * 0.3);
      }
      // Positive earLift perks the ears up (their lag and flop comes from the jiggle below).
      const fl = s === tw.side ? flick : 0;
      set(`ear${side}` as BoneName, fl * 0.25, 0, s * (P.earLift * 0.5 + fl * 0.35));
      // Wings: fold back, spread out, flap.
      const flap = flapNow;
      // At rest the wings lie folded back along the shoulders. Spreading raises
      // them in the plane of the back (so they stay face-on and peek above the
      // shoulders) with a little outward swing.
      // (Tuned so the spread membrane still faces back and out rather than
      // turning edge-on; a horizontal wing reads as a flickering hairline.)
      set(`wing${side}` as BoneName, 0.1 + P.wingSpread * 0.4, -s * (P.wingSpread * 0.55 + flap * 0.3), s * (P.wingSpread * 0.3 + flap * 0.7));
    }
    // Tail chain: curl, lift and sway distributed along the bones, with spring lag.
    for (let q = 0; q < 6; q++) {
      const f = (q + 1) / 6;
      set(
        `tail${q}` as BoneName,
        -P.tailLift * 0.25 - P.tailCurl * 0.22 * f,
        P.tailSide * 0.18,
        0,
      );
    }

    // Face.
    const open = clamp(P.eyeOpen, 0, 1.25);
    const happy = clamp(P.happy, 0, 1);
    // Lids are hemispherical shells hinged at the eye's corners. Upper lid:
    // -1.65 is tucked back (open), 0.42 closed with the lash line low across
    // the eye ("‿", like a sleeping eye) instead of wrapping the whole ball.
    // Lower lid: 1.65 is tucked away, smaller values rise with an arched "◠" rim.
    // Happy squeezes both together into "^^" arcs: the upper lid's line arches
    // up over the raised lower lid.
    const o = clamp(open, 0, 1);
    let up = THREE.MathUtils.lerp(0.42, -1.65, o) - (open > 1 ? (open - 1) * 0.6 : 0);
    up = Math.max(up, THREE.MathUtils.lerp(-1.65, -0.1, happy * happy));
    const lo = Math.min(THREE.MathUtils.lerp(0.95, 1.65, o), THREE.MathUtils.lerp(1.65, 0.02, happy));
    face.lidUpL.rotation.x = face.lidUpR.rotation.x = up;
    face.lidLoL.rotation.x = face.lidLoR.rotation.x = lo;
    // How much of the eye the lids cover (sleep, blink or a "^^" squint).
    const closed = Math.max(smoothstep(-0.9, 0.35, up), smoothstep(1.0, 0.15, lo));
    // Upper lid fully down (sleep, blink), as opposed to a "^^" squint, whose
    // arched lash line must stay clear of the brow.
    const shut = smoothstep(-0.25, 0.38, up);
    if (face.eyeClosed) face.eyeClosed.value = closed;
    if (face.eyeFill) face.eyeFill.value = shut;
    if (face.eyeSquint) face.eyeSquint.value = smoothstep(1.0, 0.15, lo);
    // A closed eye sinks into the face, so the lid reads as a soft fold in the
    // fur rather than a dome standing proud of it.
    face.eyeL.scale.z = face.eyeR.scale.z = 0.82 * (1 - 0.12 * closed - 0.3 * shut);
    // When happy the lower lid grows over the upper one, so its arched lash
    // line is the one that shows.
    // Closed lids also widen a touch so their edge tucks under the face fur
    // (no visible seam / socket ring around a sleeping eye).
    const grow = 1 + 0.04 * closed + 0.04 * shut;
    face.lidUpL.scale.setScalar(grow);
    face.lidUpR.scale.setScalar(grow);
    const ls = (0.99 + 0.12 * smoothstep(0.2, 0.8, happy)) * grow;
    face.lidLoL.scale.set(ls, -ls, ls);
    face.lidLoR.scale.set(ls, -ls, ls);
    const ps = clamp(P.pupilSize, 0.5, 1.5);
    for (const ir of [face.irisL, face.irisR]) {
      const pupil = ir.getObjectByName('pupil')!;
      pupil.scale.set(ps, ps, 1);
    }
    // Remaining look offset goes to the eyes.
    // The head does most of the turning; the eyes only finish it. The eye on
    // the far side turns less, so it doesn't roll its iris into the corner and
    // show a big crescent of white.
    // While the head is still catching up, the eyes cover the difference.
    const eyeYaw = clamp(P.lookX * 0.5 + lookYaw * 0.18 + 0.75 * (lookYaw - g.yaw) + sc.x * saccW, -0.45, 0.45);
    const eyePitch = clamp(-P.lookY * 0.4 + lookPitch * 0.3 + 0.6 * (lookPitch - g.pitch) + sc.y * saccW, -0.4, 0.4);
    face.irisL.rotation.set(eyePitch, eyeYaw * (eyeYaw < 0 ? 0.55 : 1) - 0.25, 0);
    face.irisR.rotation.set(eyePitch, eyeYaw * (eyeYaw > 0 ? 0.55 : 1) + 0.25, 0);
    const mo = clamp(P.mouthOpen, 0, 1);
    face.mouthOpen.scale.set(0.8 + mo * 0.4, 0.2 + mo * 1.1, 0.01 + mo * 0.12);
    face.mouthOpen.visible = mo > 0.04;
    // A happy open mouth is a "D" (flat top, round bottom); a startled one an "O".
    if (face.mouthOpen.morphTargetInfluences) face.mouthOpen.morphTargetInfluences[0] = clamp(happy * 1.3, 0, 1) * clamp(P.smile, 0, 1);
    face.smile.visible = mo < 0.25;
    face.smile.scale.set(1, clamp(P.smile, 0.05, 1.2), 1);
    face.blushMat.opacity = 0.35 + 0.5 * clamp(P.blush, 0, 1);
    this.rig.glowMaterial.emissiveIntensity = 0.2 + 1.4 * clamp(P.glow, 0, 1.2);

    // Secondary motion on top of the finished primary pose.
    this.rig.group.updateMatrixWorld(true);
    const jg = this.jiggles;
    for (const j of jg.ant) j.update(dt);
    for (const j of jg.ear) j.update(dt);
    jg.tail.update(dt);
    // Not while flapping: the stroke itself is the motion there.
    const wingW = 1 - smoothstep(0.05, 0.3, P.wingFlap);
    for (const j of jg.wing) j.update(dt, wingW);

    this.solveLegs(P, dt);
  }

  /**
   * Foot planting: a foot that is down is pinned where it touched the ground
   * (in world space), so it doesn't skate when the body moves or turns over
   * it. If the body drifts too far from a pinned foot, the foot takes a little
   * step back under it, one foot at a time. `target` (scaler space) is
   * adjusted in place.
   */
  private plantFoot(side: 'L' | 'R', target: THREE.Vector3, down: boolean, dt: number): void {
    const f = this.feet[side], other = this.feet[side === 'L' ? 'R' : 'L'];
    const scaler = this.rig.scaler;
    if (down && f.step <= 0) {
      if (!f.locked) {
        f.locked = true;
        f.world.set(target.x + f.off.x, target.y, target.z + f.off.z);
        scaler.localToWorld(f.world);
      }
      const cur = scaler.worldToLocal(_v.copy(f.world));
      f.off.set(cur.x - target.x, 0, cur.z - target.z);
      const len = f.off.length();
      if (len > 0.09 || !Number.isFinite(len)) {
        // Teleported (placed somewhere new): just stand there.
        f.off.set(0, 0, 0);
        f.locked = false;
      } else if (len > 0.022 && other.step <= 0) {
        f.locked = false;
        f.step = STEP_TIME;
        f.len = len;
      }
    } else f.locked = false;
    let lift = 0;
    if (!f.locked) {
      f.off.multiplyScalar(Math.exp(-dt * (f.step > 0 ? 22 : 14)));
      if (f.step > 0) {
        lift = 0.012 * Math.min(1, f.len / 0.03) * Math.sin(Math.PI * (1 - f.step / STEP_TIME));
        f.step = Math.max(0, f.step - dt);
      }
    }
    target.x += f.off.x;
    target.y += lift;
    target.z += f.off.z;
  }

  /** Analytic two-bone IK in each leg's sagittal plane, plus foot flattening. */
  private solveLegs(P: Pose, dt: number): void {
    const { bones, scaler } = this.rig;
    this.rig.group.updateMatrixWorld(true);
    for (const side of ['L', 'R'] as const) {
      const thigh = bones[`thigh${side}`], shin = bones[`shin${side}`], ankle = bones[`ankle${side}`];
      const target = this.restAnkle[side].clone();
      target.x += side === 'L' ? P.footLX : P.footRX;
      target.y += side === 'L' ? P.footLY : P.footRY;
      target.z += side === 'L' ? P.footLZ : P.footRZ;
      this.plantFoot(side, target, P.footPlant > 0.5, dt);
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

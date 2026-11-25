import * as THREE from 'three';
import { clamp, noise1, smoothstep } from '../../core/math';
import { Jiggle } from '../jiggle';
import type { PetRig } from '../PetModel';
import { CHANNELS, neutralPose, type ActionCtx, type ActionFn, type ActionName, type Channel, type Pose } from '../pose';
import type { DogBoneName } from './skeleton';

/**
 * How the Vizsla moves: the same actions Hopper has, performed as a dog would.
 *
 *   idle        stands square, weight shifting, tail swinging; pants in spells, cocks its head
 *   hop         trots (diagonal pairs), opening into a bounding gallop when it runs
 *   jump…       gathers on its hocks, stretches over the jump, lands forehand first
 *   hide        lies down like a sphinx, ears back, chin low; hideLow: flat, chin on the floor
 *   peek        lifts its head over, or cranes round the side
 *   giggle      a wriggling, panting, tail-thumping laugh without getting up
 *   surprised   startles back, ears and tail up
 *   celebrate   bounces on the spot, spins, and drops into a play bow
 *   wave        sits and gives a paw
 *   lookAround  scans, ears pricked
 *   sniff       nose down, quartering, then freezes on point: foreleg up, tail out straight
 *   coverEyes   lies down and puts a paw over its nose
 *   sleep       settles chin on paws, tail tucked round
 *   petted      leans in, eyes soft, the whole back end wagging
 *
 * Actions write pose channels (pose.ts); DogBody turns the blended pose into
 * bone rotations: spine and tail directly, the four legs by two-bone IK to
 * paw targets (so paws stay planted whatever the body does), ears and tail
 * with spring lag on top.
 */
const TAU = Math.PI * 2;

/** Everything but the face: for blending one posture into another. */
const BODY: readonly Channel[] = CHANNELS.filter((c) => !/^(eyeOpen|happy|mouthOpen|smile|blush|pupilSize|look|glow)/.test(c));

/** p ← p + (q - p)·w on the body channels. */
function blendBody(p: Pose, q: Pose, w: number): void {
  for (const ch of BODY) p[ch] += (q[ch] - p[ch]) * w;
}

/** Panting: jaw dropped, tongue out and a quick shallow breath. `k` 0..1. */
function pant(t: number, p: Pose, k: number): void {
  if (k <= 0) return;
  const beat = Math.sin(t * TAU * 4.6);
  p.jaw = Math.max(p.jaw, k * (0.5 + 0.08 * beat));
  p.tongue = Math.max(p.tongue, k * (0.88 + 0.1 * beat));
  // The tongue humps up and flattens with each breath.
  p.tongueArch = Math.max(p.tongueArch, k * (0.45 + 0.3 * beat));
  p.squash += 0.035 * k * beat;
  p.chestPitch += 0.012 * k * beat;
  p.smile = 1;
}

/** Standing square: the base for everything done on four feet. */
function stand(t: number, c: ActionCtx, p: Pose): void {
  const br = Math.sin(t * 2.6 + 0.9 * noise1(t * 0.15, c.seed + 7));
  // Weight drifts from side to side over planted paws.
  const ws = noise1(t * 0.17, c.seed + 8);
  p.bodyX = 0.0045 * ws;
  p.bodyRoll = -0.028 * ws;
  p.spineRoll = 0.014 * ws;
  p.bodyY = -0.0025 + 0.0007 * br;
  p.squash = 0.03 * br;
  p.bodyYaw = 0.025 * noise1(t * 0.3, c.seed);
  p.spineYaw = 0.03 * noise1(t * 0.23, c.seed + 14);
  // Head carried proudly, a little above the line of the back.
  p.neckPitch = 0.06 - 0.01 * br;
  p.headPitch = 0.1 + 0.01 * br;
  p.headRoll = 0.07 * noise1(t * 0.4, c.seed + 1);
  // The tail swings in easy arcs, livelier in spells.
  const lively = 0.45 + 0.55 * smoothstep(-0.3, 0.5, noise1(t * 0.21, c.seed + 5));
  p.tailSide = 0.55 * lively * Math.sin(t * 6.4 + c.seed) + 0.1 * noise1(t * 0.5, c.seed + 4);
  p.tailLift = 0.06 + 0.04 * noise1(t * 0.3, c.seed + 9);
  p.earLift = 0.08 * noise1(t * 0.7, c.seed + 6);
  p.jaw = 0.02;
}

function idle(t: number, c: ActionCtx, p: Pose): void {
  stand(t, c, p);
  // Pants in spells, mouth closed in between.
  const panting = smoothstep(0.05, 0.45, noise1(t * 0.13 + 3.1, c.seed + 20));
  pant(t, p, panting);
  // Now and then, between pants, it cocks its head at you, ears pricked: what was that?
  const n = noise1(t * 0.19 + 7.7, c.seed + 31);
  const tilt = smoothstep(0.42, 0.6, Math.abs(n)) * (1 - panting);
  p.headRoll += 0.42 * Math.sign(n) * tilt;
  p.neckRoll = 0.08 * Math.sign(n) * tilt;
  p.earLift += 0.6 * tilt;
  p.tailSide *= 1 - 0.7 * tilt;
}

/** The play bow: elbows down, rump up, tail going. `k` 0..1 blends it over the pose. */
function playBow(t: number, p: Pose, k: number): void {
  if (k <= 0) return;
  const B = neutralPose();
  B.bodyY = -0.012;
  B.bodyZ = -0.012;
  B.bodyPitch = 0.44;
  B.spinePitch = 0.13;
  B.chestPitch = 0.08;
  B.handLY = B.handRY = -0.0235;
  B.handLZ = B.handRZ = 0.068;
  B.handLX = 0.012;
  B.handRX = -0.012;
  B.pawLCurl = B.pawRCurl = -1.42;
  B.neckPitch = -0.78;
  B.headPitch = 0.12;
  B.tailLift = 0.95;
  B.tailSide = 1.0 * Math.sin(t * 17);
  B.spineYaw = 0.07 * Math.sin(t * 17 + 0.8);
  B.earLift = 0.5;
  B.jaw = 0.5;
  B.tongue = 0.8;
  blendBody(p, B, k);
}

/** Lying down like a sphinx: brisket on the floor, forelegs out in front, hocks folded under. `flat` 0..1 sinks it chin-down. */
function down(p: Pose, flat: number): void {
  p.bodyY = -0.111 - 0.006 * flat;
  p.bodyPitch = -0.055 + 0.04 * flat;
  p.spinePitch = 0.03;
  p.handLY = p.handRY = -0.0235;
  p.handLZ = p.handRZ = 0.06 + 0.02 * flat;
  p.handLX = 0.004 + 0.012 * flat;
  p.handRX = -0.004 - 0.012 * flat;
  p.pawLCurl = p.pawRCurl = -1.42;
  p.footLZ = p.footRZ = 0.072;
  p.footLX = 0.013 + 0.006 * flat;
  p.footRX = -0.013 - 0.006 * flat;
  p.hockFlat = 1;
  // Neck out along the floor; the head stays level.
  p.neckPitch = 0.62 + 0.82 * flat;
  p.headPitch = -0.56 - 0.86 * flat;
  // Tail drawn in round its flank, out of the way.
  p.tailLift = -0.42;
  p.tailSide = 1.25;
  p.tailCurl = 0.1;
  p.earLift = -0.45;
  p.squash = 0;
}

/** Sitting: haunches down and tucked forward, forelegs straight, back sloping. */
function sit(p: Pose): void {
  p.bodyY = -0.113;
  p.bodyZ = 0.052;
  p.bodyPitch = -0.78;
  p.spinePitch = 0.12;
  p.chestPitch = 0.14;
  p.neckPitch = 0.36;
  p.headPitch = 0.26;
  p.handLZ = p.handRZ = 0.012;
  p.footLZ = p.footRZ = 0.118;
  p.footLX = 0.02;
  p.footRX = -0.02;
  p.hockFlat = 1;
  // The tail lies out along the floor behind (the hips are tipped back, so that is "up" for the tail).
  p.tailLift = 1.0;
  p.tailCurl = -0.35;
}

function hideBase(t: number, c: ActionCtx, p: Pose, low: boolean): void {
  const br = Math.sin(t * 1.7);
  down(p, low ? 1 : 0);
  p.bodyY += 0.0006 * br;
  p.squash = 0.03 * br;
  // Stock still, but the tail can't quite help itself (a hint for sharp eyes).
  const twitch = Math.max(0, noise1(t * 0.9, c.seed + 5));
  p.tailSide += 0.4 * twitch * Math.sin(t * 13);
  p.earLift = -0.5 + 0.35 * twitch;
  p.pupilSize = 1.22;
  p.eyeOpen = 0.96;
  p.glow = 0.25 + twitch * 0.4;
  p.jaw = 0.01;
}

/** Paw phase offsets within the stride: trot (diagonal pairs) and a rotary gallop. */
const TROT = { FL: 0, HR: 0.02, FR: 0.5, HL: 0.52 };
const GALLOP = { HL: 0.0, HR: 0.1, FR: 0.42, FL: 0.54 };

/**
 * Locomotion. Each paw has a stance (on the ground, sliding back under the
 * body at exactly ground speed) and a swing (lifted, reaching for the next
 * step); the gait is which paw does which when. `travel` is the true ground
 * speed (0 to trot or bounce on the spot).
 */
function gait(t: number, c: ActionCtx, p: Pose, travel = c.speed): void {
  stand(t, c, p);
  const ph = c.hopPhase % 1;
  const sp = clamp(c.speed, 0, 1.5);
  const stride = clamp(travel, 0, 2) / Math.max(0.5, c.hopRate);
  // Above a brisk trot it gathers itself and gallops.
  const g = smoothstep(0.78, 1.0, sp);
  // Short enough stances that the legs never over-reach: a slow trot overlaps
  // its diagonals, a fast one flies between them.
  const duty = clamp(0.068 / Math.max(stride, 0.01), 0.3, 0.6) * (1 - 0.25 * g);
  const half = 0.5 * stride * duty;
  const lift = 0.012 + 0.016 * sp + 0.01 * g;
  const paw = (off: number, front: boolean) => {
    const f = (ph + off) % 1;
    // A foreleg is nearly straight when it stands, so it works ahead of the
    // shoulder: it lands well forward and lifts off under the body. A hind leg
    // drives from under the hip to well behind it.
    const mid = (front ? 0.014 : -0.004) * Math.min(1, stride / 0.06);
    if (f < duty) return { y: 0, z: mid + half - 2 * half * (f / duty), plant: 1, curl: 0 };
    const u = (f - duty) / (1 - duty);
    // Snaps up, swings through, reaches, and comes down late.
    const sw = smoothstep(0.08, 0.92, u);
    const up = Math.pow(Math.sin(Math.PI * u), 0.6);
    return { y: lift * up, z: mid - half + 2 * half * sw + (front ? 0.004 : 0) * Math.sin(Math.PI * u), plant: 0, curl: Math.sin(Math.PI * Math.min(1, u / 0.75)) };
  };
  const off = (k: keyof typeof TROT) => {
    // Phase offsets blend the short way round the cycle.
    let d = GALLOP[k] - TROT[k];
    d -= Math.round(d);
    return (TROT[k] + d * g + 1) % 1;
  };
  const FL = paw(off('FL'), true), FR = paw(off('FR'), true), HL = paw(off('HL'), false), HR = paw(off('HR'), false);
  p.handLY = FL.y;
  p.handLZ = FL.z;
  p.handRY = FR.y;
  p.handRZ = FR.z;
  p.pawLCurl = 1.05 * FL.curl;
  p.pawRCurl = 1.05 * FR.curl;
  p.footLY = HL.y;
  p.footLZ = HL.z;
  p.footRY = HR.y;
  p.footRZ = HR.z;
  p.plantFL = FL.plant;
  p.plantFR = FR.plant;
  p.plantHL = HL.plant;
  p.plantHR = HR.plant;
  p.footPitch = 0.5 * Math.max(HL.curl, HR.curl);
  // Trot: the body rides nearly level, dipping a little into each diagonal.
  const dip = Math.cos(TAU * (2 * ph - duty));
  const trotY = -0.0065 - (0.0015 + 0.003 * sp) * dip;
  // Gallop: one big bound a stride. The back flexes to bring the hind legs
  // under, then straightens as the forehand reaches out.
  const bound = Math.sin(TAU * (ph - 0.16));
  const gather = Math.cos(TAU * (ph - 0.02));
  p.bodyY = trotY * (1 - g) + g * (0.004 + 0.013 * bound);
  p.bodyPitch = 0.015 * sp + g * 0.11 * Math.sin(TAU * (ph - 0.42));
  p.spinePitch = g * 0.16 * gather;
  p.chestPitch = -g * 0.1 * gather;
  p.bodyRoll = (1 - g) * 0.022 * Math.sin(TAU * ph);
  p.spineYaw = (1 - g) * 0.05 * Math.sin(TAU * ph + 0.6);
  p.bodyX = 0;
  p.spineRoll = 0;
  p.bodyYaw = 0;
  p.squash = 0.04 * g * bound;
  // The head reaches forward and stays steady while the body works under it.
  p.neckPitch = 0.1 + 0.22 * sp + 0.02 * dip * (1 - g) - g * 0.08 * Math.sin(TAU * (ph - 0.42));
  p.headPitch = -0.02 - 0.16 * sp - g * 0.05 * gather;
  p.headRoll = 0;
  p.tailLift = 0.1 + 0.1 * g * gather;
  p.tailSide = 0.3 * Math.sin(TAU * ph + 1);
  p.earLift = -0.15 * sp;
  // Mouth open at speed.
  p.jaw = 0.04 + 0.32 * smoothstep(0.35, 0.9, sp);
  p.tongue = 0.55 * smoothstep(0.5, 1, sp);
  p.lookWeight = 0.3;
}

export const DOG_ACTIONS: Record<ActionName, ActionFn> = {
  idle,
  hop: gait,
  jumpCrouch(t, c, p) {
    stand(t, c, p);
    const e = smoothstep(0, 0.22, t);
    // Weight back onto the hocks, forehand light, eyes on the landing.
    p.bodyY = -0.034 * e + Math.sin(t * 60) * 0.0012 * e;
    p.bodyZ = -0.012 * e;
    p.bodyPitch = -0.2 * e;
    p.spinePitch = 0.14 * e;
    p.neckPitch = 0.46 * e;
    p.headPitch = -0.2 * e;
    p.tailLift = 0.35 * e;
    p.tailSide = 0;
    p.earLift = 0.45 * e;
    p.pupilSize = 0.85;
    p.lookWeight = 0.4;
    p.jaw = 0.02;
  },
  jumpAir(t, c, p) {
    stand(t, c, p);
    const u = clamp(c.jumpU, 0, 1);
    const early = 1 - smoothstep(0.0, 0.35, u);
    const late = smoothstep(0.6, 1, u);
    const mid = 1 - early - late;
    // Take-off: stretched out, forelegs folded up under the chest, hind legs
    // driving out behind. Apex: gathered. Descent: forelegs reach for the
    // ground, hind legs fold under to follow.
    p.bodyX = p.bodyRoll = p.spineRoll = p.bodyYaw = p.spineYaw = 0;
    p.bodyY = 0.01 * mid;
    p.bodyPitch = -0.34 * early - 0.02 * mid + 0.26 * late;
    p.spinePitch = -0.1 * early + 0.14 * mid + 0.04 * late;
    p.chestPitch = -0.06 * early - 0.06 * mid + 0.02 * late;
    p.neckPitch = 0.3 * early + 0.18 * mid - 0.05 * late;
    p.headPitch = 0.1 * early - 0.1 * mid - 0.22 * late;
    p.handLY = p.handRY = 0.05 * early + 0.052 * mid + 0.006 * late;
    p.handLZ = p.handRZ = 0.03 * early + 0.022 * mid + 0.056 * late;
    p.pawLCurl = p.pawRCurl = 1.3 * early + 1.1 * mid - 0.25 * late;
    p.footLY = p.footRY = 0.012 * early + 0.05 * mid + 0.04 * late;
    p.footLZ = p.footRZ = -0.064 * early + 0.016 * mid + 0.05 * late;
    p.footPitch = 1.0 * early + 0.5 * mid + 0.1 * late;
    p.plantFL = p.plantFR = p.plantHL = p.plantHR = 0;
    p.tailLift = 0.05 * early + 0.3 * mid + 0.55 * late;
    p.tailSide = 0;
    p.earLift = -0.5 * early + 0.3 * mid + 0.7 * late;
    p.eyeOpen = 1.08;
    p.jaw = 0.3 * mid + 0.1;
    p.tongue = 0.3 * mid;
    p.lookWeight = 0.2;
  },
  land(t, c, p) {
    stand(t, c, p);
    // The forehand takes the landing and the hindquarters follow through.
    const k = Math.exp(-t * 9) * Math.cos(t * 20);
    const lagT = Math.max(0, t - 0.06);
    const kh = Math.exp(-lagT * 8) * Math.sin(lagT * 17);
    p.bodyY = -0.024 * Math.max(0, k) - 0.008 * Math.max(0, kh);
    p.bodyPitch = 0.16 * Math.max(0, k) - 0.07 * kh;
    p.spinePitch = 0.08 * kh;
    p.neckPitch = 0.06 + 0.22 * Math.max(0, k);
    p.headPitch = 0.1 - 0.18 * kh;
    p.earLift = 0.5 * k;
    p.tailLift = 0.3 * Math.exp(-t * 4);
    p.jaw = 0.12;
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
      // Head up over the top, forehand lifting a little.
      p.neckPitch -= 0.72 * e;
      p.headPitch += 0.5 * e;
      p.bodyPitch -= 0.1 * e;
      p.bodyY += 0.012 * e;
    } else {
      // Cranes round the side, head cocked.
      p.neckYaw = 0.55 * s * e;
      p.neckPitch -= 0.3 * e;
      p.headPitch += 0.22 * e;
      p.headRoll = -0.35 * s * e;
      p.chestYaw = 0.14 * s * e;
      p.bodyX = 0.012 * s * e;
    }
    p.earLift = -0.5 + 0.95 * e;
    p.eyeOpen = 1.1;
    p.pupilSize = 1.3;
    p.lookWeight = 1;
  },
  giggle(t, c, p) {
    // Stays down (it may be laughing from a hiding spot), but can't keep
    // still: head up, panting grin, wriggling, tail thumping.
    hideBase(t, c, p, false);
    const e = smoothstep(0, 0.2, t);
    const hee = Math.abs(Math.sin(t * 9));
    const wag = Math.sin(t * 15);
    p.bodyY += 0.003 * hee * e;
    p.bodyPitch -= 0.07 * e;
    p.spineYaw = 0.1 * wag * e;
    p.chestRoll = 0.05 * Math.sin(t * 7.5) * e;
    p.neckPitch -= (0.5 + 0.06 * hee) * e;
    p.headPitch += 0.3 * e - 0.07 * hee * e;
    p.headRoll = 0.24 * Math.sin(t * 4.5) * e;
    p.headYaw = 0.12 * Math.sin(t * 2.3);
    // One forepaw pats the floor.
    p.handLY += 0.014 * Math.max(0, Math.sin(t * 9)) * e;
    p.tailSide = 1.25 * (1 - e) + (0.5 + 0.8 * wag) * e;
    p.tailLift = -0.15;
    p.earLift = 0.1 + 0.2 * Math.sin(t * 9);
    p.happy = 0.85;
    p.eyeOpen = 0.9;
    pant(t * 1.3, p, e);
    p.lookWeight = 0.7;
    p.glow = 1;
  },
  surprised(t, c, p) {
    stand(t, c, p);
    // Startles: a hop back onto braced legs, head up and back, everything pricked.
    const hopUp = t < 0.32 ? Math.sin((t / 0.32) * Math.PI) : 0;
    const e = smoothstep(0, 0.12, t);
    p.bodyY = 0.022 * hopUp - 0.012 * e;
    p.bodyZ = -0.03 * smoothstep(0, 0.3, t);
    p.handLY = p.handRY = 0.03 * hopUp;
    p.footLY = p.footRY = 0.018 * hopUp;
    p.plantFL = p.plantFR = p.plantHL = p.plantHR = hopUp > 0.05 ? 0 : 1;
    p.handLX = 0.012 * e;
    p.handRX = -0.012 * e;
    p.handLZ = p.handRZ = 0.016 * e;
    p.bodyPitch = -0.1 * e;
    p.neckPitch = -0.3 * e;
    p.headPitch = 0.2 * e;
    p.eyeOpen = 1.2;
    p.pupilSize = 0.72;
    p.jaw = 0.4;
    p.smile = 0;
    p.earLift = 0.95;
    p.tailLift = 0.8;
    p.tailSide = 0;
    p.glow = 1;
  },
  celebrate(t, c, p) {
    // A bounce, a bounce with a spin, then a play bow: come on, again!
    const ph = (t / 0.9) % 1;
    const beat = Math.floor(t / 0.9) % 3;
    gait(t, { ...c, hopPhase: ph, speed: 1.05, hopRate: 1 / 0.9 }, p, 0);
    if (beat === 1 && ph > 0.15 && ph < 0.85) p.bodyYaw = TAU * smoothstep(0.15, 0.85, ph);
    p.bodyY += 0.012 * Math.max(0, Math.sin(TAU * (ph - 0.16)));
    p.neckPitch -= 0.3;
    p.headPitch += 0.25;

    p.happy = 0.8;
    p.eyeOpen = 0.9;
    p.jaw = 0.55;
    p.tongue = 0.7;
    p.tailLift = 0.5;
    p.tailSide = 0.9 * Math.sin(t * 14);
    p.earLift = 0.4;
    p.lookWeight = 0.6;
    p.glow = 1;
    const bow = beat === 2 ? smoothstep(0, 0.22, ph) * (1 - smoothstep(0.8, 1, ph)) : 0;
    if (bow > 0) {
      playBow(t, p, bow);
      if (bow > 0.5) p.plantFL = p.plantFR = p.plantHL = p.plantHR = 1;
    }
  },
  wave(t, c, p) {
    // Sits and gives a paw.
    stand(t, c, p);
    const e = smoothstep(0, 0.45, t);
    const S = neutralPose();
    sit(S);
    blendBody(p, S, e);
    const up = smoothstep(0.25, 0.6, t);
    const flap = Math.sin(t * 9) * up;
    p.handRY = 0.105 * up + 0.012 * flap;
    p.handRZ = S.handRZ * e + 0.07 * up + 0.012 * flap;
    p.handRX = 0.008 * up;
    p.pawRCurl = (0.5 + 0.45 * flap) * up;
    p.plantFR = up > 0.02 ? 0 : 1;
    // Weight over the other foreleg.
    p.bodyX = 0.006 * up;
    p.chestRoll = -0.05 * up;
    p.headRoll = 0.16 * e;
    p.tailSide = 0.8 * Math.sin(t * 11) * e;
    p.tailLift = S.tailLift * e;
    p.happy = 0.6 * e;
    pant(t, p, 0.8 * e);
    p.earLift = 0.35 * e;
  },
  lookAround(t, c, p) {
    stand(t, c, p);
    // Head high, scanning; ears pricked; tail still, listening.
    const sweep = Math.sin(t * 1.3);
    p.neckPitch = -0.14;
    p.headPitch = 0.16 + 0.06 * Math.sin(t * 0.7);
    p.headYaw = 0.6 * sweep;
    p.neckYaw = 0.42 * sweep;
    p.chestYaw = 0.07 * sweep;
    p.lookX = 0.6 * sweep;
    p.lookWeight = 0;
    p.earLift = 0.65 + 0.15 * Math.sin(t * 2.6);
    p.tailSide *= 0.3;
    p.tailLift = 0.2;
    p.jaw = 0.02;
  },
  sniff(t, c, p) {
    stand(t, c, p);
    // Quarters with its nose to the floor, then locks up on point: neck and
    // tail in one straight line, one foreleg lifted and folded, quite still.
    // (A fidget lasts a few seconds: the point comes soon enough to be seen in most of them.)
    const T = 3.8;
    const ph = t % T;
    const point = smoothstep(1.3, 1.7, ph) * (1 - smoothstep(3.35, 3.7, ph));
    const snuff = 1 - point;
    const nose = Math.sin(t * 16);
    p.bodyPitch = 0.1 * snuff + 0.03 * point;
    p.bodyY = -0.006 * snuff - 0.004 * point;
    p.bodyZ = 0.012 * point;
    p.neckPitch = 1.18 * snuff + 0.52 * point;
    p.headPitch = (0.2 + 0.03 * nose) * snuff - 0.42 * point;
    p.headYaw = 0.45 * Math.sin(t * 1.5) * snuff;
    p.neckYaw = 0.3 * Math.sin(t * 1.5 - 0.5) * snuff;
    p.headRoll *= snuff;
    p.handLY = 0.05 * point;
    p.handLZ = -0.012 * point;
    p.pawLCurl = 1.75 * point;
    p.plantFL = point > 0.02 ? 0 : 1;
    p.bodyX = -0.005 * point;
    p.bodyRoll *= snuff;
    p.tailLift = 0.12 * snuff + 0.02 * point;
    p.tailSide = 0.7 * Math.sin(t * 10) * snuff;
    p.earLift = 0.1 * snuff + 0.5 * point;
    p.jaw = 0.02;
    p.pupilSize = 1 - 0.12 * point;
    p.lookWeight = 0;
  },
  coverEyes(t, c, p) {
    // Lies down and puts a paw over its nose.
    stand(t, c, p);
    const e = smoothstep(0, 0.5, t);
    const D = neutralPose();
    down(D, 0.75);
    blendBody(p, D, e);
    const paw = smoothstep(0.3, 0.8, t);
    p.neckYaw = -0.16 * paw;
    p.headRoll = 0.2 * paw;
    // The paw comes up, across and down over the muzzle (a little pat as it settles).
    const pat = Math.exp(-Math.max(0, t - 0.8) * 3) * Math.sin(Math.max(0, t - 0.8) * 14);
    p.handRY += (0.088 + 0.02 * Math.sin(Math.PI * paw) + 0.004 * pat) * paw;
    p.handRZ += 0.07 * paw;
    p.handRX += 0.03 * paw;
    p.pawRCurl = D.pawRCurl * e + 0.52 * paw;
    p.plantFR = paw > 0.02 ? 0 : 1;
    p.eyeOpen = 1 - e;
    p.happy = 0.5 * e;
    p.tailSide = p.tailSide * (1 - e) + (D.tailSide + 0.3 * Math.sin(t * 9)) * e;
    p.earLift = -0.5 * e;
    p.lookWeight = 0;
    p.jaw = 0.01;
  },
  petted(t, c, p) {
    // Leans into the hand: chin up, head tipped towards it, eyes soft, and
    // the tail going so hard the whole back end goes with it.
    stand(t, c, p);
    const e = smoothstep(0, 0.25, t);
    const side = c.touchSide === 0 ? 1 : Math.sign(c.touchSide);
    const wag = Math.sin(t * 13);
    const nuzzle = Math.sin(t * 5.5);
    p.bodyX = (0.008 * side + 0.004 * wag) * e;
    p.bodyRoll = 0.07 * side * e;
    p.bodyY = -0.006 * e;
    p.spineYaw = -0.12 * wag * e;
    p.bodyYaw = 0.05 * wag * e;
    p.chestRoll = 0.04 * nuzzle * e;
    p.neckPitch = 0.06 - 0.3 * e;
    p.neckRoll = 0.14 * side * e;
    p.headPitch = 0.1 - (0.05 + 0.04 * nuzzle) * e;
    p.headRoll = (0.32 * side + 0.07 * nuzzle) * e;
    p.headYaw = 0.1 * side * e + 0.04 * Math.sin(t * 2.1);
    p.earLift = -0.4 * e;
    p.tailSide = 1.0 * wag * e + p.tailSide * (1 - e);
    p.tailLift = 0.25 * e;
    p.happy = 0.9 * e;
    p.eyeOpen = 1 - 0.12 * e;
    pant(t, p, 0.75 * e);
    p.lookWeight = 0.25;
    p.glow = 0.6 + 0.4 * e;
  },
  sleep(t, c, p) {
    // Settles: lies down, the head sinks onto its paws, eyes close, and the
    // breathing goes slow and deep.
    stand(t, c, p);
    const sink = smoothstep(0.3, 1.7, t);
    const D = neutralPose();
    down(D, 1);
    blendBody(p, D, sink);
    const nod = smoothstep(0, 0.6, t) * (1 - smoothstep(1.2, 1.8, t));
    p.headPitch += 0.2 * nod;
    p.eyeOpen = 1 - smoothstep(0, 0.9, t) + 0.25 * Math.max(0, Math.sin(Math.PI * clamp((t - 0.45) / 0.3, 0, 1)));
    // ~0.25 Hz, the in-breath quicker than the out-breath.
    const ph = (t * 0.25 + 0.1 * noise1(t * 0.1, c.seed + 12)) % 1;
    const br = ph < 0.4 ? smoothstep(0, 0.4, ph) : 1 - smoothstep(0.4, 1, ph);
    p.squash = 0.1 * br * sink;
    p.bodyY += 0.0015 * br * sink;
    // Head turned to rest along one foreleg; hips rolled onto one side, tail round.
    p.neckYaw = 0.3 * sink;
    p.headYaw = 0.14 * sink;
    p.headRoll = 0.3 * sink;
    p.spineRoll = -0.1 * sink;
    p.tailSide = p.tailSide * (1 - sink) + 1.6 * sink;
    p.tailCurl = 0.35 * sink;
    p.earLift = -0.2 * sink;
    p.happy = 0.3;
    p.jaw = 0.01;
    p.lookWeight = 0.4 * (1 - sink);
    p.glow = 0.15 + 0.15 * br;
  },
};

type FootKey = 'FL' | 'FR' | 'HL' | 'HR';
type FootState = { locked: boolean; world: THREE.Vector3; off: THREE.Vector3; step: number; len: number };
const FEET: readonly FootKey[] = ['FL', 'FR', 'HL', 'HR'];
const DIAGONAL: Record<FootKey, FootKey> = { FL: 'HR', HR: 'FL', FR: 'HL', HL: 'FR' };
const STEP_TIME = 0.15;

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _m = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _w = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);

export class DogBody {
  private readonly bones: Record<DogBoneName, THREE.Bone>;
  private readonly feet: Record<FootKey, FootState>;
  /** Rest position (pet space) of each leg's IK end: wrists in front, paws behind. */
  private readonly restEnd: Record<FootKey, THREE.Vector3>;
  /** Hock → paw in the rest pose (pet space). */
  private readonly pastern: THREE.Vector3;
  private readonly jiggles: { ear: Jiggle[]; tail: Jiggle };
  /** How far it is crouched under something (0..1) and drawn back from something ahead (0..1), smoothed. */
  private low = 0;
  private tuck = 0;

  constructor(private readonly rig: PetRig) {
    const b = (this.bones = rig.bones as Record<DogBoneName, THREE.Bone>);
    const foot = (): FootState => ({ locked: false, world: new THREE.Vector3(), off: new THREE.Vector3(), step: 0, len: 0 });
    this.feet = { FL: foot(), FR: foot(), HL: foot(), HR: foot() };
    rig.group.updateMatrixWorld(true);
    const at = (n: DogBoneName) => rig.scaler.worldToLocal(b[n].getWorldPosition(new THREE.Vector3()));
    this.restEnd = { FL: at('handL'), FR: at('handR'), HL: at('toeL'), HR: at('toeR') };
    this.pastern = at('toeL').sub(at('ankleL'));
    this.pastern.x = 0;
    this.jiggles = {
      // Long ear leathers swing and flap; the tail is stiffer and only whips at its tip.
      ear: ([['L', 1], ['R', -1]] as const).map(([s, k]) => new Jiggle([b[`ear${s}`], b[`ear${s}1`]], new THREE.Vector3(0.001 * k, -0.032, 0.009), 2.9, 0.24, 1.0, 0.55)),
      tail: new Jiggle([1, 2, 3, 4, 5].map((q) => b[`tail${q}` as DogBoneName]), new THREE.Vector3(0, -0.001, -0.0125), 3.4, 0.4, 0.7, 0.3),
    };
  }

  reset(): void {
    this.low = this.tuck = 0;
    for (const j of this.jiggles.ear) j.reset();
    this.jiggles.tail.reset();
    for (const f of Object.values(this.feet)) {
      Object.assign(f, { locked: false, step: 0, len: 0 });
      f.off.set(0, 0, 0);
    }
  }

  /**
   * Trunk: where the hips are and how the back bends (the Animator adds neck
   * and head). First the pose gives way to the room it has: a standing dog
   * with something low overhead drops to a belly-crawl, head and neck
   * stretched out level; one with something right in front of its nose lifts
   * its head, tucks its chin and leans back from it.
   */
  poseBody(P: Pose, ctx: ActionCtx, dt: number): void {
    const { rest, scaler } = this.rig;
    const b = this.bones;
    const k = dt > 0 ? 1 - Math.exp(-dt * 9) : 1;
    this.low += (smoothstep(0.36, 0.17, ctx.headroom) - this.low) * k;
    this.tuck += (smoothstep(0.3, 0.14, ctx.clearAhead) - this.tuck) * k;
    // (Only while it is up on its legs: lying down it is already low and curled.)
    const up = smoothstep(-0.07, -0.025, P.bodyY);
    const low = this.low * up, tuck = this.tuck * up * (1 - this.low);
    if (low > 1e-3 || tuck > 1e-3) {
      P.bodyY -= 0.095 * low;
      P.neckPitch += 1.05 * low - 0.7 * tuck;
      P.headPitch += -0.92 * low + 1.1 * tuck;
      P.bodyZ -= 0.028 * tuck;
      P.tailLift -= 0.5 * low;
      P.earLift -= 0.4 * low;
    }
    // A dog isn't rubbery: `squash` is its breathing, and only a hint of stretch.
    const sq = 1 + 0.3 * clamp(P.squash, -0.5, 0.5);
    scaler.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    b.hips.position.set(rest.hips.x + P.bodyX, rest.hips.y + P.bodyY, rest.hips.z + P.bodyZ);
    b.hips.rotation.set(P.bodyPitch, P.bodyYaw, P.bodyRoll);
    b.spine.rotation.set(P.spinePitch, P.spineYaw, P.spineRoll);
    b.chest.rotation.set(P.chestPitch, P.chestYaw, P.chestRoll);
  }

  /** Jaw, ears, tail, then the legs; `flick` is the Animator's ear twitch (signed by side). */
  finish(P: Pose, dt: number, flick: number): void {
    const b = this.bones;
    const face = this.rig.face;
    // Jaw and tongue.
    const jaw = clamp(P.jaw, 0, 1);
    b.jaw.rotation.set(0.5 * jaw, 0, 0);
    const tongue = face.tongue;
    if (tongue?.morphTargetInfluences) {
      // The tongue can only come out as far as the mouth is open.
      tongue.morphTargetInfluences[0] = clamp(P.tongue, 0, 1) * smoothstep(0.08, 0.4, jaw);
      tongue.morphTargetInfluences[1] = clamp(P.tongueArch, 0, 1);
    }
    // Ears: pricked, they lift at the set-on and swing forward to frame the
    // face; laid back, they fold flat against the neck.
    for (const [side, s] of [
      ['L', 1],
      ['R', -1],
    ] as const) {
      const fl = Math.sign(flick) === s ? Math.abs(flick) : 0;
      const lift = clamp(P.earLift, -1, 1.2);
      const up = Math.max(0, lift), back = Math.max(0, -lift);
      b[`ear${side}`].rotation.set(-0.34 * up + 0.3 * back - 0.25 * fl, s * (0.16 * up - 0.12 * back), s * (0.12 * up - 0.05 * back + 0.22 * fl));
      b[`ear${side}1`].rotation.set(-0.12 * up + 0.22 * back, 0, s * (-0.1 * up - 0.04 * back));
    }
    // Tail: lift and wag come mostly from the root, a little more along it.
    const lift = P.tailLift, side = P.tailSide, curl = P.tailCurl;
    b.tail0.rotation.set(0.55 * lift, -0.42 * side, 0);
    for (let q = 1; q < 6; q++) b[`tail${q}` as DogBoneName].rotation.set(0.1 * lift + 0.16 * curl, -0.13 * side, 0);

    this.rig.group.updateMatrixWorld(true);
    for (const j of this.jiggles.ear) j.update(dt);
    this.jiggles.tail.update(dt);
    this.restEars();
    this.solveLegs(P, dt);
  }

  /**
   * Ears don't hang through the floor: when the head is down on it (flat,
   * asleep, nose to the ground), each leather swings out from its set-on to
   * lie along the floor instead.
   */
  private restEars(): void {
    const b = this.bones, scaler = this.rig.scaler;
    const FLOOR = 0.006;
    for (const side of ['L', 'R'] as const) {
      const ear = b[`ear${side}`];
      ear.updateWorldMatrix(true, true);
      const base = scaler.worldToLocal(ear.getWorldPosition(_v));
      const tip = scaler.worldToLocal(b[`ant${side}3`].getWorldPosition(_t));
      if (tip.y >= FLOOR || base.y <= FLOOR + 0.004) continue;
      const cur = _m.subVectors(tip, base);
      const len = cur.length();
      const dy = Math.max(FLOOR - base.y, -len);
      const reach = Math.sqrt(Math.max(0, len * len - dy * dy));
      // Out to its own side of the head (not forward under the chin), keeping a little of the way it already leans.
      const out = _w.set(side === 'L' ? 1 : -1, 0, 0).applyQuaternion(b.head.getWorldQuaternion(_q)).applyQuaternion(scaler.getWorldQuaternion(_qs).invert());
      const hx = out.x + 4 * cur.x, hz = out.z + 4 * cur.z;
      const hl = Math.hypot(hx, hz) || 1;
      const want = _w.set((hx / hl) * reach, dy, (hz / hl) * reach);
      // The swing, from pet space into the ear's parent's frame.
      _qx.setFromUnitVectors(cur.normalize(), want.normalize());
      scaler.getWorldQuaternion(_qs);
      ear.parent!.getWorldQuaternion(_q);
      _qw.copy(_q).invert().multiply(_qs).multiply(_qx).multiply(_qs.invert()).multiply(_q);
      ear.quaternion.premultiply(_qw);
    }
  }

  /**
   * A paw that is down stays where it touched the ground (in world space)
   * while the body moves over it; if the body drifts too far it takes a
   * little step back under it — one paw at a time, or a diagonal pair.
   * `target` (pet space) is adjusted in place.
   */
  private plant(key: FootKey, target: THREE.Vector3, down: boolean, dt: number): void {
    const f = this.feet[key];
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
      if (len > 0.1 || !Number.isFinite(len)) {
        // Placed somewhere new: just stand there.
        f.off.set(0, 0, 0);
        f.locked = false;
      } else if (len > 0.024 && FEET.every((k) => k === key || k === DIAGONAL[key] || this.feet[k].step <= 0)) {
        f.locked = false;
        f.step = STEP_TIME;
        f.len = len;
      }
    } else f.locked = false;
    let lift = 0;
    if (!f.locked) {
      f.off.multiplyScalar(Math.exp(-dt * (f.step > 0 ? 22 : 14)));
      if (f.step > 0) {
        lift = 0.014 * Math.min(1, f.len / 0.03) * Math.sin(Math.PI * (1 - f.step / STEP_TIME));
        f.step = Math.max(0, f.step - dt);
      }
    }
    target.x += f.off.x;
    target.y += lift;
    target.z += f.off.z;
  }

  /**
   * Two-bone IK in the leg's fore-and-aft plane: turn `upper` and `lower` so
   * the joint after `lower` (at rest offset `end` from it) reaches `target`
   * (relative to `upper`'s joint, in the parent bone's frame). `bend` picks
   * the side the middle joint goes: +1 forward (stifle), -1 back (elbow).
   */
  private solve2(upper: THREE.Bone, lower: THREE.Bone, end: THREE.Vector3, target: THREE.Vector3, bend: number): void {
    const s1 = lower.position, s2 = end;
    const l1 = Math.hypot(s1.y, s1.z), l2 = Math.hypot(s2.y, s2.z);
    const phi1Rest = Math.atan2(s1.z, -s1.y), phi2Rest = Math.atan2(s2.z, -s2.y);
    const d = clamp(Math.hypot(target.y, target.z), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
    const phiT = Math.atan2(target.z, -target.y);
    const a1 = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const phi1 = phiT + bend * a1;
    const kz = l1 * Math.sin(phi1), ky = -l1 * Math.cos(phi1);
    const tz = d * Math.sin(phiT), ty = -d * Math.cos(phiT);
    const phi2 = Math.atan2(tz - kz, -(ty - ky));
    const aUpper = phi1Rest - phi1;
    // Sideways: swing the whole leg from its top joint.
    const roll = Math.atan2(target.x, d) - Math.atan2(s1.x + s2.x, d);
    upper.rotation.set(aUpper, 0, roll);
    lower.rotation.set(phi2Rest - phi2 - aUpper, 0, 0);
  }

  private solveLegs(P: Pose, dt: number): void {
    const b = this.bones;
    const scaler = this.rig.scaler;
    scaler.getWorldQuaternion(_qs);
    for (const side of ['L', 'R'] as const) {
      // --- Foreleg: shoulder and elbow reach the wrist; the paw stays flat, or curls when lifted.
      {
        const key: FootKey = `F${side}`;
        const upper = b[`shoulder${side}`], lower = b[`elbow${side}`], hand = b[`hand${side}`], paw = b[`paw${side}`];
        const target = _t.copy(this.restEnd[key]);
        target.x += side === 'L' ? P.handLX : P.handRX;
        target.y += side === 'L' ? P.handLY : P.handRY;
        target.z += side === 'L' ? P.handLZ : P.handRZ;
        this.plant(key, target, (side === 'L' ? P.plantFL : P.plantFR) > 0.5, dt);
        scaler.localToWorld(target);
        b.chest.worldToLocal(target);
        target.sub(upper.position);
        this.solve2(upper, lower, hand.position, target, -1);
        // The pastern stands upright under the wrist. Positive curl folds it
        // back and up (a lifted paw, the toes curling under with it); negative
        // lays it out forward along the floor (lying down), toes still flat.
        const curl = side === 'L' ? P.pawLCurl : P.pawRCurl;
        lower.getWorldQuaternion(_q).invert();
        hand.quaternion.copy(_q).multiply(_qs).multiply(_qx.setFromAxisAngle(X, curl));
        paw.rotation.set(curl < 0 ? -curl : 0.5 * curl, 0, 0);
      }
      // --- Hind leg: the paw target fixes the hock (through the rear pastern), then hip and stifle reach it.
      {
        const key: FootKey = `H${side}`;
        const thigh = b[`thigh${side}`], shin = b[`shin${side}`], ankle = b[`ankle${side}`], toe = b[`toe${side}`];
        const target = _t.copy(this.restEnd[key]);
        target.x += side === 'L' ? P.footLX : P.footRX;
        const liftY = side === 'L' ? P.footLY : P.footRY;
        target.y += liftY;
        target.z += side === 'L' ? P.footLZ : P.footRZ;
        this.plant(key, target, (side === 'L' ? P.plantHL : P.plantHR) > 0.5, dt);
        // The pastern stands upright, trails when the paw is lifted, and lies
        // forward along the floor when sitting or lying.
        const flat = clamp(P.hockFlat, 0, 1);
        const a = -1.42 * flat + (1 - flat) * 0.55 * clamp(P.footPitch, -1, 1.5) * smoothstep(0, 0.012, liftY);
        _m.copy(this.pastern).applyAxisAngle(X, a);
        target.sub(_m);
        scaler.localToWorld(target);
        b.hips.worldToLocal(target);
        target.sub(thigh.position);
        this.solve2(thigh, shin, ankle.position, target, 1);
        shin.getWorldQuaternion(_q).invert();
        ankle.quaternion.copy(_q).multiply(_qs).multiply(_qx.setFromAxisAngle(X, a));
        // Toes flat, pointing a little down while the paw is in the air.
        toe.rotation.set(-a + (1 - flat) * 0.4 * clamp(P.footPitch, -1, 1.5) * smoothstep(0, 0.012, liftY), 0, 0);
      }
    }
  }
}

import type { BoneName, V } from '../skeleton';

/**
 * The Vizsla's skeleton (pet space, metres, facing +Z, paws at y=0). A lean
 * pointer about 21 cm at the withers: the same height as Hopper, so it fits
 * the same hiding places.
 *
 * It keeps Hopper's bone names so the game can sample either pet the same
 * way, read as a quadruped:
 *   shoulder → elbow → hand → paw   foreleg (point of shoulder, elbow, wrist, toes)
 *   thigh → shin → ankle → toe      hind leg (hip, stifle, hock, toes)
 * plus a jaw and a second joint in each pendant ear. Hopper's antennae and
 * wings have no counterpart: those bones ride along unskinned (the antenna
 * tips sit at the ear tips, which is what visibility sampling wants).
 */
export type DogBoneName = BoneName | 'jaw' | 'earL1' | 'earR1' | 'pawL' | 'pawR';

export const DOG_BONES: [DogBoneName, DogBoneName | null, V][] = [
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 0.186, -0.078]],
  ['spine', 'hips', [0, 0.19, -0.025]],
  ['chest', 'spine', [0, 0.19, 0.035]],
  ['neck', 'chest', [0, 0.2, 0.082]],
  ['head', 'neck', [0, 0.262, 0.13]],
  // Hind legs: hip, stifle (knee, forward), hock (back), paw.
  ['thighL', 'hips', [0.027, 0.176, -0.086]],
  ['shinL', 'thighL', [0.031, 0.116, -0.058]],
  ['ankleL', 'shinL', [0.031, 0.06, -0.112]],
  ['toeL', 'ankleL', [0.031, 0.013, -0.104]],
  ['thighR', 'hips', [-0.027, 0.176, -0.086]],
  ['shinR', 'thighR', [-0.031, 0.116, -0.058]],
  ['ankleR', 'shinR', [-0.031, 0.06, -0.112]],
  ['toeR', 'ankleR', [-0.031, 0.013, -0.104]],
  // Forelegs: point of shoulder, elbow (back), wrist.
  ['shoulderL', 'chest', [0.029, 0.168, 0.078]],
  ['elbowL', 'shoulderL', [0.031, 0.122, 0.05]],
  ['handL', 'elbowL', [0.031, 0.036, 0.056]],
  ['pawL', 'handL', [0.031, 0.0128, 0.059]],
  ['shoulderR', 'chest', [-0.029, 0.168, 0.078]],
  ['elbowR', 'shoulderR', [-0.031, 0.122, 0.05]],
  ['handR', 'elbowR', [-0.031, 0.036, 0.056]],
  ['pawR', 'handR', [-0.031, 0.0128, 0.059]],
  // Tail: docked by a third, carried level with the back.
  ['tail0', 'hips', [0, 0.196, -0.112]],
  ['tail1', 'tail0', [0, 0.1955, -0.132]],
  ['tail2', 'tail1', [0, 0.194, -0.152]],
  ['tail3', 'tail2', [0, 0.192, -0.172]],
  ['tail4', 'tail3', [0, 0.19, -0.191]],
  ['tail5', 'tail4', [0, 0.1885, -0.209]],
  // Pendant ears: set on at the side of the skull, a second joint halfway down.
  ['earL', 'head', [0.022, 0.2832, 0.133]],
  ['earL1', 'earL', [0.0262, 0.2595, 0.135]],
  ['earR', 'head', [-0.022, 0.2832, 0.133]],
  ['earR1', 'earR', [-0.0262, 0.2595, 0.135]],
  ['jaw', 'head', [0, 0.2575, 0.152]],
  // Unskinned stand-ins for Hopper's antennae (tips at the ear tips) and wings.
  ['antL0', 'head', [0.012, 0.3, 0.145]],
  ['antL1', 'antL0', [0.014, 0.302, 0.145]],
  ['antL2', 'antL1', [0.016, 0.303, 0.145]],
  ['antL3', 'earL1', [0.0268, 0.2312, 0.1425]],
  ['antR0', 'head', [-0.012, 0.3, 0.145]],
  ['antR1', 'antR0', [-0.014, 0.302, 0.145]],
  ['antR2', 'antR1', [-0.016, 0.303, 0.145]],
  ['antR3', 'earR1', [-0.0268, 0.2312, 0.1425]],
  ['wingL', 'chest', [0.02, 0.205, 0.04]],
  ['wingR', 'chest', [-0.02, 0.205, 0.04]],
];

export const DOG_P = Object.fromEntries(DOG_BONES.map(([n, , p]) => [n, p])) as Record<DogBoneName, V>;

/** Middle of the skull, relative to the head joint (for visibility sampling). */
export const DOG_HEAD_SAMPLE: V = [0, 0.018, 0.03];

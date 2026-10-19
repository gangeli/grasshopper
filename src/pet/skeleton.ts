/**
 * Hopper's skeleton: bone names, parents and rest positions (pet space,
 * metres, facing +Z, feet at y=0). Shared by the model builder and the sculpt.
 */
export type BoneName =
  | 'root' | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'thighL' | 'shinL' | 'ankleL' | 'toeL' | 'thighR' | 'shinR' | 'ankleR' | 'toeR'
  | 'shoulderL' | 'elbowL' | 'handL' | 'shoulderR' | 'elbowR' | 'handR'
  | 'tail0' | 'tail1' | 'tail2' | 'tail3' | 'tail4' | 'tail5'
  | 'antL0' | 'antL1' | 'antL2' | 'antL3' | 'antR0' | 'antR1' | 'antR2' | 'antR3'
  | 'wingL' | 'wingR' | 'earL' | 'earR';

export type V = [number, number, number];

/** Absolute rest positions in pet space (meters) and parents. */
export const BONES: [BoneName, BoneName | null, V][] = [
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 0.085, -0.005]],
  ['spine', 'hips', [0, 0.115, 0]],
  ['chest', 'spine', [0, 0.145, 0.006]],
  ['neck', 'chest', [0, 0.17, 0.012]],
  ['head', 'neck', [0, 0.19, 0.016]],
  // Hind legs: thigh angles forward, shin back down, long foot.
  ['thighL', 'hips', [0.042, 0.082, 0]],
  ['shinL', 'thighL', [0.060, 0.05, 0.042]],
  ['ankleL', 'shinL', [0.052, 0.018, -0.022]],
  ['toeL', 'ankleL', [0.052, 0.008, 0.035]],
  ['thighR', 'hips', [-0.042, 0.082, 0]],
  ['shinR', 'thighR', [-0.060, 0.05, 0.042]],
  ['ankleR', 'shinR', [-0.052, 0.018, -0.022]],
  ['toeR', 'ankleR', [-0.052, 0.008, 0.035]],
  // Arms.
  ['shoulderL', 'chest', [0.045, 0.148, 0.03]],
  ['elbowL', 'shoulderL', [0.062, 0.122, 0.04]],
  ['handL', 'elbowL', [0.068, 0.1, 0.052]],
  ['shoulderR', 'chest', [-0.045, 0.148, 0.03]],
  ['elbowR', 'shoulderR', [-0.062, 0.122, 0.04]],
  ['handR', 'elbowR', [-0.068, 0.1, 0.052]],
  // Tail curls back and up.
  ['tail0', 'hips', [0, 0.075, -0.045]],
  ['tail1', 'tail0', [0, 0.06, -0.075]],
  ['tail2', 'tail1', [0, 0.058, -0.105]],
  ['tail3', 'tail2', [0, 0.072, -0.13]],
  ['tail4', 'tail3', [0, 0.098, -0.14]],
  ['tail5', 'tail4', [0, 0.122, -0.13]],
  // Antennae spring from the top of the head.
  ['antL0', 'head', [0.022, 0.305, 0.03]],
  ['antL1', 'antL0', [0.03, 0.335, 0.04]],
  ['antL2', 'antL1', [0.042, 0.36, 0.058]],
  ['antL3', 'antL2', [0.056, 0.372, 0.082]],
  ['antR0', 'head', [-0.022, 0.305, 0.03]],
  ['antR1', 'antR0', [-0.03, 0.335, 0.04]],
  ['antR2', 'antR1', [-0.042, 0.36, 0.058]],
  ['antR3', 'antR2', [-0.056, 0.372, 0.082]],
  ['wingL', 'chest', [0.022, 0.16, -0.04]],
  ['wingR', 'chest', [-0.022, 0.16, -0.04]],
  ['earL', 'head', [0.062, 0.255, 0.0]],
  ['earR', 'head', [-0.062, 0.255, 0.0]],
];

export const HEAD_CENTER: V = [0, 0.245, 0.02];
export const HEAD_RADIUS = 0.068;


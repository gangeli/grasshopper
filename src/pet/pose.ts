/**
 * The pose a pet's animation produces each frame: a flat set of channels that
 * actions write, layers blend and the Animator applies to the rig. Shared by
 * every species; each uses the channels its body has.
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
  // Quadrupeds (the Vizsla): forepaw targets, wrist curl, hocks laid on the ground, per-paw planting, jaw and tongue.
  'handLX', 'handLY', 'handLZ', 'handRX', 'handRY', 'handRZ', 'pawLCurl', 'pawRCurl', 'hockFlat',
  'plantFL', 'plantFR', 'plantHL', 'plantHR', 'jaw', 'tongue', 'tongueArch',
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
  p.plantFL = p.plantFR = p.plantHL = p.plantHR = 1;
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
  /** Where Hopper is being petted: +1 = on their left, -1 = right (they lean into it). */
  touchSide: number;
  /** A per-pet random seed for idle variation. */
  seed: number;
  /**
   * Room around the pet, from the mapped world (m; Infinity = open or
   * unknown): free space straight ahead at head height, and above its back.
   * A long, tall pet (the Vizsla) pulls its head in when it is up against
   * something and crawls under low furniture; Hopper, who is neither, ignores them.
   */
  clearAhead: number;
  headroom: number;
}

export type ActionName =
  | 'idle' | 'hop' | 'jumpCrouch' | 'jumpAir' | 'land' | 'hide' | 'hideLow' | 'peek' | 'giggle'
  | 'surprised' | 'celebrate' | 'wave' | 'lookAround' | 'sniff' | 'coverEyes' | 'sleep' | 'petted';

export type ActionFn = (t: number, c: ActionCtx, p: Pose) => void;

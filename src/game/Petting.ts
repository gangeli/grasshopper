import type { ActionName } from '../pet/Animator';

/** Which sound goes with a petting response. */
export type PetSound = 'pet' | 'love' | 'giggle' | 'greet' | 'surprised';

export interface PetResponse {
  /** The action Hopper performs ('petted' is the lean-into-your-hand one). */
  action: ActionName;
  /** How many little hearts float up. */
  hearts: number;
  /** Happiness after this pet (0..1). */
  happiness: number;
  sound: PetSound;
  /** True for the "that's enough love, I have to hop about!" climax. */
  big: boolean;
  /** Came from a held press / drag over Hopper rather than a tap. */
  stroke: boolean;
}

export interface PettingRng {
  next(): number;
}

/** Tuning (exported for tests). */
export const PETTING = {
  /** Happiness added per tap / per stroke beat. */
  tapGain: 0.24,
  strokeGain: 0.17,
  /** A held stroke counts as another pet this often (s). */
  strokeInterval: 0.55,
  /** Taps closer together than this are one tap (s). */
  minTapInterval: 0.12,
  /** Happiness starts to fade after this long without pets (s), at `decay` per second. */
  decayDelay: 2.5,
  decay: 0.12,
  /** Happiness kept after the big happy hop. */
  afterBig: 0.3,
  /** Chance that a tap gets one of the playful reactions instead of being petted. */
  altChance: 0.2,
} as const;

const ALT_REACTIONS: readonly ActionName[] = ['giggle', 'wave', 'surprised'];
const ALT_SOUND: Partial<Record<ActionName, PetSound>> = { giggle: 'giggle', wave: 'greet', surprised: 'surprised' };

/**
 * Petting Hopper: each tap (or each beat of a held stroke) is answered with
 * the happy lean-into-your-hand 'petted' reaction, a purr and a few hearts.
 * Happiness builds up with repeated pets (more hearts each time) and peaks
 * in a celebratory hop with a shower of hearts; now and then a tap gets one
 * of the old playful reactions (giggle, wave, a startled squeak) instead.
 * Pure logic on an explicit clock, so it is shared by the game and the
 * landing-page showcase and runs in node tests.
 */
export class Petting {
  happiness = 0;
  /** Pets since happiness was last zero. */
  streak = 0;
  /** Total pets (diagnostics). */
  count = 0;
  private lastPet = -Infinity;
  private lastAlt: ActionName | null = null;
  private altLast = false;

  constructor(private readonly rng: PettingRng = { next: Math.random }) {}

  /** Seconds since the last pet registered at clock `now`. */
  sinceLast(now: number): number {
    return now - this.lastPet;
  }

  /** Let happiness fade while nobody is petting. */
  update(dt: number, now: number): void {
    if (now - this.lastPet > PETTING.decayDelay) {
      this.happiness = Math.max(0, this.happiness - PETTING.decay * dt);
      if (this.happiness === 0) this.streak = 0;
    }
  }

  /**
   * A pet at clock `now` (s). Returns null when it is too soon after the last
   * one to count (a double tap, or a stroke between beats).
   */
  pet(now: number, stroke = false): PetResponse | null {
    const gap = now - this.lastPet;
    if (gap < (stroke ? PETTING.strokeInterval : PETTING.minTapInterval)) return null;
    this.lastPet = now;
    this.count++;
    this.streak++;
    this.happiness = Math.min(1, this.happiness + (stroke ? PETTING.strokeGain : PETTING.tapGain));
    if (this.happiness >= 1) {
      this.happiness = PETTING.afterBig;
      this.altLast = false;
      return { action: 'celebrate', hearts: 8, happiness: 1, sound: 'love', big: true, stroke };
    }
    // Hearts grow with happiness: 1 at first, up to 4 just before the big hop.
    const hearts = 1 + Math.round(this.happiness * 3);
    // A playful tap now and then (never the first pet, never two in a row, never while stroking).
    if (!stroke && this.streak > 1 && !this.altLast && this.rng.next() < PETTING.altChance) {
      const opts = ALT_REACTIONS.filter((a) => a !== this.lastAlt);
      const a = opts[Math.floor(this.rng.next() * opts.length) % opts.length];
      this.lastAlt = a;
      this.altLast = true;
      return { action: a, hearts: Math.max(1, hearts - 1), happiness: this.happiness, sound: ALT_SOUND[a] ?? 'giggle', big: false, stroke };
    }
    this.altLast = false;
    return { action: 'petted', hearts, happiness: this.happiness, sound: this.happiness > 0.7 ? 'love' : 'pet', big: false, stroke };
  }
}

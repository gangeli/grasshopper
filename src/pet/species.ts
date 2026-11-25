/**
 * Which pet is playing. "hopper" is the original fantasy creature; "vizsla"
 * swaps in a Hungarian Vizsla (see pet/vizsla). Chosen on the start page, or
 * with ?pet=vizsla|hopper (which wins and is not remembered).
 */
export type Species = 'hopper' | 'vizsla';

export const SPECIES: readonly Species[] = ['hopper', 'vizsla'];
const KEY = 'hopper-pet';
let override: Species | null = null;

const valid = (s: unknown): s is Species => s === 'hopper' || s === 'vizsla';

/** The pet to build when none is asked for: URL, then the remembered choice, then Hopper. */
export function currentSpecies(): Species {
  if (override) return override;
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('pet');
    if (valid(q)) return q;
  }
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (valid(s)) return s;
  } catch {
    /* storage unavailable */
  }
  return 'hopper';
}

/** Choose the pet for this page and (when `remember`) for later visits. */
export function setSpecies(s: Species, remember = true): void {
  override = s;
  if (!remember) return;
  try {
    localStorage.setItem(KEY, s);
  } catch {
    /* storage unavailable */
  }
}

/** The pet's display name. */
export function speciesLabel(s: Species): string {
  return s === 'vizsla' ? 'Vizsla' : 'Hopper';
}

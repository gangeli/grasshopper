/**
 * Which pet is playing, and in which coat. "hopper" is the original fantasy
 * creature; "vizsla" swaps in a Hungarian Vizsla (see pet/vizsla). Both are
 * chosen with the model selector (start page and in-game: app/PetPicker) and
 * remembered, or pinned for one visit with ?pet=vizsla|hopper and
 * ?coat=<name> (which win and are not remembered).
 */
export type Species = 'hopper' | 'vizsla';

export const SPECIES: readonly Species[] = ['hopper', 'vizsla'];

/**
 * The coats each pet comes in; the first is its default. The ids are palette
 * names: PALETTES in PetModel for Hopper, VIZSLA_PALETTES for the Vizsla.
 */
export const COATS: Record<Species, readonly { id: string; label: string }[]> = {
  hopper: [
    { id: 'mint', label: 'Mint' },
    { id: 'plum', label: 'Plum' },
    { id: 'ember', label: 'Ember' },
  ],
  vizsla: [
    { id: 'golden', label: 'Golden rust' },
    { id: 'russet', label: 'Russet' },
    { id: 'sandy', label: 'Sandy gold' },
  ],
};

const KEY = 'hopper-pet';
const coatKey = (s: Species) => `hopper-coat-${s}`;
let override: Species | null = null;
const coatOverride: Partial<Record<Species, string>> = {};

const valid = (s: unknown): s is Species => s === 'hopper' || s === 'vizsla';
const validCoat = (s: Species, c: unknown): c is string => typeof c === 'string' && COATS[s].some((k) => k.id === c);

const query = (name: string): string | null => (typeof location !== 'undefined' ? new URLSearchParams(location.search).get(name) : null);
function stored(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null; // storage unavailable
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** The pet to build when none is asked for: this page's choice, the URL, the remembered choice, then Hopper. */
export function currentSpecies(): Species {
  if (override) return override;
  const q = query('pet');
  if (valid(q)) return q;
  const s = stored(KEY);
  return valid(s) ? s : 'hopper';
}

/** Choose the pet for this page and (when `remember`) for later visits. */
export function setSpecies(s: Species, remember = true): void {
  override = s;
  if (remember) store(KEY, s);
}

/** The coat a pet wears when none is asked for: this page's choice, the URL, the remembered one, then its default. */
export function currentCoat(species: Species = currentSpecies()): string {
  const o = coatOverride[species];
  if (o) return o;
  const q = query('coat');
  if (validCoat(species, q)) return q;
  const s = stored(coatKey(species));
  return validCoat(species, s) ? s : COATS[species][0].id;
}

/** Choose a pet's coat for this page and (when `remember`) for later visits. Unknown coats are ignored. */
export function setCoat(species: Species, coat: string, remember = true): void {
  if (!validCoat(species, coat)) return;
  coatOverride[species] = coat;
  if (remember) store(coatKey(species), coat);
}

/** The pet's display name. */
export function speciesLabel(s: Species): string {
  return s === 'vizsla' ? 'Vizsla' : 'Hopper';
}

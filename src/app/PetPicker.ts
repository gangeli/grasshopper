import { coatPalette } from '../pet/PetModel';
import { COATS, currentCoat, currentSpecies, setCoat, setSpecies, SPECIES, speciesLabel, type Species } from '../pet/species';

/**
 * The model selector: which pet plays (Hopper or the Vizsla) and in which
 * coat. One control for both places it appears: the start page, and the HUD
 * while playing (the 🐾 button). A row of pets and, under it, the chosen
 * pet's coats as colour swatches.
 *
 * Choosing is remembered (species.ts); `onPick` then puts that model on
 * screen. Building a model takes a moment, so the choice shows at once, the
 * control dims, and the swap follows.
 */
export interface PetPicker {
  readonly el: HTMLElement;
  /** Show the current choice again (after it was changed somewhere else). */
  sync(): void;
}

export function createPetPicker(onPick: (species: Species, coat: string) => void): PetPicker {
  const root = document.createElement('div');
  root.className = 'petpick';
  // In AR the HUD is the WebXR DOM overlay: a tap here must not also be a tap on the room.
  root.addEventListener('beforexrselect', (e) => e.preventDefault());
  root.addEventListener('click', (e) => e.stopPropagation());

  const pets = radioGroup('pets', 'Pet');
  const coats = radioGroup('coats', 'Coat');
  const coatName = document.createElement('span');
  coatName.className = 'coat-name';
  coatName.setAttribute('aria-hidden', 'true');
  const coatRow = document.createElement('div');
  coatRow.className = 'coat-row';
  coatRow.append(coats, coatName);
  root.append(pets, coatRow);

  let busy = false;
  const choose = (species: Species, coat: string) => {
    const was = { species: currentSpecies(), coat: currentCoat() };
    if (busy || (species === was.species && coat === was.coat)) return;
    setSpecies(species);
    setCoat(species, coat);
    sync();
    busy = true;
    root.classList.add('busy');
    root.setAttribute('aria-busy', 'true');
    // (A timer, not an animation frame: page frames stop during an AR session.)
    setTimeout(() => {
      try {
        onPick(species, coat);
      } catch (e) {
        // The model did not build: the pet on screen stays the choice.
        console.error('pet picker:', e);
        setSpecies(was.species);
        setCoat(was.species, was.coat);
      } finally {
        busy = false;
        root.classList.remove('busy');
        root.removeAttribute('aria-busy');
        sync();
      }
    }, 40);
  };

  for (const s of SPECIES) {
    const b = radio('pet', speciesLabel(s), () => choose(s, currentCoat(s)));
    b.dataset.pet = s;
    b.textContent = speciesLabel(s);
    pets.append(b);
  }

  /** Whose coats the swatches show. */
  let coatsOf: Species | null = null;
  function sync() {
    const species = currentSpecies(), coat = currentCoat(species);
    for (const b of Array.from(pets.children) as HTMLButtonElement[]) check(b, b.dataset.pet === species);
    // The coats on offer are the chosen pet's.
    if (coatsOf !== species) {
      coatsOf = species;
      coats.replaceChildren(
        ...COATS[species].map((c) => {
          const b = radio('coat', c.label, () => choose(species, c.id));
          b.dataset.coat = c.id;
          b.title = c.label;
          // The swatch: the coat's colour over its paler belly (styled in index.html).
          const pal = coatPalette(species, c.id);
          for (const k of ['body', 'belly'] as const) b.style.setProperty(`--${k}`, `#${pal[k].toString(16).padStart(6, '0')}`);
          return b;
        }),
      );
    }
    for (const b of Array.from(coats.children) as HTMLButtonElement[]) check(b, b.dataset.coat === coat);
    coatName.textContent = COATS[species].find((c) => c.id === coat)?.label ?? '';
  }
  sync();
  return { el: root, sync };
}

function radioGroup(cls: string, label: string): HTMLElement {
  const g = document.createElement('div');
  g.className = cls;
  g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', label);
  // Arrow keys move through a radio group and choose as they go.
  g.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const all = Array.from(g.children) as HTMLButtonElement[];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // (Not also a step in the simulator, which walks on the arrow keys.)
    e.preventDefault();
    e.stopPropagation();
    const next = all[(at + step + all.length) % all.length];
    next.focus();
    next.click();
  });
  return g;
}

function radio(cls: string, label: string, onChoose: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onChoose);
  return b;
}

function check(b: HTMLButtonElement, on: boolean): void {
  b.classList.toggle('on', on);
  b.setAttribute('aria-checked', String(on));
  // Roving focus: Tab lands on the chosen one.
  b.tabIndex = on ? 0 : -1;
}

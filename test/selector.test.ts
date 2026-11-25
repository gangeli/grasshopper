import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { boneNames, buildPet, coatPalette, disposePet, PALETTES, rebuildPet, VIZSLA_PALETTES, type PetRig } from '../src/pet/PetModel';
import { Animator, type ActionName } from '../src/pet/Animator';
import { COATS, SPECIES, speciesLabel } from '../src/pet/species';
import { swapPet } from '../src/game/stack';
import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';

/**
 * The model selector: which pet plays and in which coat (species.ts), and
 * swapping the model in place while the game runs (rebuildPet, swapPet).
 * The control itself (app/PetPicker) is exercised in the browser tests.
 */
const ALL: ActionName[] = ['idle', 'hop', 'jumpCrouch', 'jumpAir', 'land', 'hide', 'hideLow', 'peek', 'giggle', 'surprised', 'celebrate', 'wave', 'lookAround', 'sniff', 'coverEyes', 'sleep', 'petted'];

/** A page visit: its address and what the browser remembers. Returns a fresh species module, as a page load would have. */
async function visit(search: string, storage: Map<string, string> | null) {
  vi.resetModules();
  vi.stubGlobal('location', { search });
  if (storage)
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    });
  else
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
  return await import('../src/pet/species');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('coats', () => {
  it('every pet has coats, each a real palette of its own, the first its default', () => {
    for (const s of SPECIES) {
      const table = s === 'vizsla' ? VIZSLA_PALETTES : PALETTES;
      expect(COATS[s].length, `${s} coats`).toBeGreaterThanOrEqual(2);
      expect(new Set(COATS[s].map((c) => c.id)).size, 'distinct ids').toBe(COATS[s].length);
      expect(new Set(COATS[s].map((c) => c.label)).size, 'distinct names').toBe(COATS[s].length);
      for (const c of COATS[s]) {
        expect(table[c.id], `${s} coat ${c.id} is a palette`).toBeDefined();
        expect(coatPalette(s, c.id)).toBe(table[c.id]);
        expect(c.label.length).toBeGreaterThan(2);
      }
      // Every palette is on offer, and they look different.
      expect(COATS[s].map((c) => c.id).sort()).toEqual(Object.keys(table).sort());
      expect(new Set(COATS[s].map((c) => coatPalette(s, c.id).body)).size).toBe(COATS[s].length);
      // Not one of its coats: the default.
      expect(coatPalette(s, 'no-such-coat')).toBe(table[COATS[s][0].id]);
      expect(speciesLabel(s).length).toBeGreaterThan(2);
    }
  });

  it('a pet is built in the coat asked for, or its default', () => {
    expect(buildPet(undefined, { species: 'hopper', furShells: 0 }).palette).toBe(PALETTES.mint);
    expect(buildPet(undefined, { species: 'vizsla', furShells: 0 }).palette).toBe(VIZSLA_PALETTES.golden);
    expect(buildPet('ember', { species: 'hopper', furShells: 0 }).palette).toBe(PALETTES.ember);
    expect(buildPet('sandy', { species: 'vizsla', furShells: 0 }).palette).toBe(VIZSLA_PALETTES.sandy);
    // Another pet's coat name: this pet's default.
    expect(buildPet('mint', { species: 'vizsla', furShells: 0 }).palette).toBe(VIZSLA_PALETTES.golden);
  });
});

describe('remembering the choice', () => {
  it('starts with Hopper in mint', async () => {
    const sp = await visit('', new Map());
    expect(sp.currentSpecies()).toBe('hopper');
    expect(sp.currentCoat()).toBe('mint');
    expect(sp.currentCoat('vizsla')).toBe('golden');
  });

  it('a chosen pet and coat hold for the page and are there on the next visit, each pet keeping its own coat', async () => {
    const storage = new Map<string, string>();
    let sp = await visit('', storage);
    sp.setSpecies('vizsla');
    sp.setCoat('vizsla', 'russet');
    sp.setCoat('hopper', 'plum');
    expect(sp.currentSpecies()).toBe('vizsla');
    expect(sp.currentCoat()).toBe('russet');
    expect(sp.currentCoat('hopper')).toBe('plum');
    sp = await visit('', storage);
    expect(sp.currentSpecies()).toBe('vizsla');
    expect(sp.currentCoat()).toBe('russet');
    expect(sp.currentCoat('hopper')).toBe('plum');
    // Back to Hopper: its coat is still the one chosen for it.
    sp.setSpecies('hopper');
    expect(sp.currentCoat()).toBe('plum');
    sp = await visit('', storage);
    expect(sp.currentSpecies()).toBe('hopper');
    expect(sp.currentCoat()).toBe('plum');
  });

  it('a coat that is not the pet’s is ignored', async () => {
    const storage = new Map<string, string>([['hopper-coat-hopper', 'russet'], ['hopper-pet', 'dragon']]);
    const sp = await visit('', storage);
    expect(sp.currentSpecies()).toBe('hopper');
    expect(sp.currentCoat()).toBe('mint');
    sp.setCoat('hopper', 'golden');
    expect(sp.currentCoat()).toBe('mint');
    expect(storage.get('hopper-coat-hopper')).toBe('russet');
  });

  it('a link can pin the pet and coat for one visit, without changing what is remembered', async () => {
    const storage = new Map<string, string>([['hopper-pet', 'hopper'], ['hopper-coat-vizsla', 'russet']]);
    let sp = await visit('?pet=vizsla&coat=sandy', storage);
    expect(sp.currentSpecies()).toBe('vizsla');
    expect(sp.currentCoat()).toBe('sandy');
    expect(storage.get('hopper-pet')).toBe('hopper');
    expect(storage.get('hopper-coat-vizsla')).toBe('russet');
    // A coat the pinned pet does not come in: the remembered one.
    sp = await visit('?pet=vizsla&coat=mint', storage);
    expect(sp.currentCoat()).toBe('russet');
    // Choosing in the selector wins over the link.
    sp = await visit('?pet=vizsla&coat=sandy', storage);
    sp.setSpecies('hopper');
    sp.setCoat('hopper', 'ember');
    expect(sp.currentSpecies()).toBe('hopper');
    expect(sp.currentCoat()).toBe('ember');
  });

  it('works for the page without storage (private mode)', async () => {
    const sp = await visit('', null);
    expect(sp.currentSpecies()).toBe('hopper');
    sp.setSpecies('vizsla');
    sp.setCoat('vizsla', 'sandy');
    expect(sp.currentSpecies()).toBe('vizsla');
    expect(sp.currentCoat()).toBe('sandy');
  });
});

function finite(rig: PetRig): boolean {
  rig.group.updateMatrixWorld(true);
  for (const n of boneNames(rig.species)) for (const e of rig.bones[n].matrixWorld.elements) if (!Number.isFinite(e)) return false;
  return true;
}

function resources(rig: PetRig) {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(rig.materials);
  rig.scaler.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    for (const x of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mats.add(x);
  });
  return { geos, mats };
}

/** Counts the `dispose` events of a set of GPU resources. */
function watch(items: Iterable<THREE.BufferGeometry | THREE.Material>): () => number {
  let n = 0;
  for (const it of items) (it as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => n++);
  return () => n;
}

describe('swapping the model in place', () => {
  it('rebuilds the rig under the same root, as the other pet', () => {
    const rig = buildPet('mint', { species: 'hopper', furShells: 2 });
    const group = rig.group, oldScaler = rig.scaler, oldBones = rig.bones;
    group.position.set(1, 0, 2);
    group.rotation.y = 0.7;
    expect(rebuildPet(rig, 'russet', { species: 'vizsla', furShells: 2 })).toBe(rig);
    expect(rig.group).toBe(group);
    expect(group.position.toArray()).toEqual([1, 0, 2]);
    expect(group.rotation.y).toBeCloseTo(0.7, 6);
    expect(group.children).toEqual([rig.scaler]);
    expect(rig.scaler).not.toBe(oldScaler);
    expect(oldScaler.parent).toBeNull();
    expect(rig.species).toBe('vizsla');
    expect(rig.palette).toBe(VIZSLA_PALETTES.russet);
    expect(rig.bones).not.toBe(oldBones);
    expect(Object.keys(rig.bones).sort()).toEqual(boneNames('vizsla').slice().sort());
    expect(rig.headSample).toBeDefined();
    expect(rig.face.tongue).toBeDefined();
    let skinned = 0;
    group.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      skinned++;
      expect(m.skeleton).toBe(rig.skeleton);
    });
    expect(skinned).toBeGreaterThanOrEqual(3);
    // ...and back: nothing of the dog is left on Hopper.
    rebuildPet(rig, 'plum', { species: 'hopper', furShells: 2 });
    expect(rig.species).toBe('hopper');
    expect(rig.palette).toBe(PALETTES.plum);
    expect(rig.headSample).toBeUndefined();
    expect(rig.face.tongue).toBeUndefined();
    expect(rig.face.mouth).toBeDefined();
    expect(Object.keys(rig.bones).sort()).toEqual(boneNames('hopper').slice().sort());
    expect(group.children).toEqual([rig.scaler]);
    expect(group.getObjectByName('wingMeshL')).toBeDefined();
  });

  it('frees what the old body held on the GPU, but not what the new one shares with it', () => {
    const rig = buildPet('mint', { species: 'hopper', furShells: 2 });
    const before = resources(rig);
    const body = (rig.group.getObjectByName('body') as THREE.Mesh).geometry;
    expect(before.geos.size).toBeGreaterThan(8);
    expect(before.mats.size).toBeGreaterThan(15);
    /** How many of a rig's old geometries the rebuilt rig still uses (cached shapes). */
    const shared = (old: Set<THREE.BufferGeometry>) => {
      const now = resources(rig).geos;
      return [...old].filter((g) => now.has(g)).length;
    };
    // Another coat: all the materials go, and all the geometry but the odd cached shape.
    let geos = watch(before.geos), mats = watch(before.mats), bodyGone = watch([body]);
    rebuildPet(rig, 'ember', { species: 'hopper', furShells: 2 });
    expect(mats()).toBe(before.mats.size);
    expect(bodyGone()).toBe(1);
    expect(shared(before.geos)).toBeLessThanOrEqual(3);
    expect(geos()).toBe(before.geos.size - shared(before.geos));
    // The same coat again: its body mesh is the cached one the new rig uses too, so it stays.
    const again = resources(rig);
    const sameBody = (rig.group.getObjectByName('body') as THREE.Mesh).geometry;
    expect(sameBody).not.toBe(body);
    bodyGone = watch([sameBody]);
    geos = watch(again.geos);
    mats = watch(again.mats);
    rebuildPet(rig, 'ember', { species: 'hopper', furShells: 2 });
    expect((rig.group.getObjectByName('body') as THREE.Mesh).geometry).toBe(sameBody);
    expect(bodyGone()).toBe(0);
    expect(mats()).toBe(again.mats.size);
    expect(geos()).toBe(again.geos.size - shared(again.geos));
    // Nothing that is still in use was freed.
    const live = resources(rig);
    const freed = new Set<object>();
    for (const g of again.geos) g.addEventListener('dispose', () => freed.add(g));
    expect([...live.geos].filter((g) => freed.has(g))).toEqual([]);
    // Leaving for good.
    geos = watch(live.geos);
    mats = watch(live.mats);
    disposePet(rig);
    expect(geos()).toBe(live.geos.size);
    expect(mats()).toBe(live.mats.size);
  });

  it.each([
    ['hopper', 'vizsla'],
    ['vizsla', 'hopper'],
  ] as const)('the animator carries every action over from %s to %s', (from, to) => {
    const rig = buildPet(undefined, { species: from, furShells: 0 });
    const anim = new Animator(rig, 3);
    anim.lookTarget = new THREE.Vector3(0.5, 1.4, 1.5);
    for (const name of ALL) {
      rebuildPet(rig, undefined, { species: from, furShells: 0 });
      anim.rebind();
      anim.play(name, 0, true);
      for (let i = 0; i < 20; i++) anim.update(1 / 30);
      const t = anim.currentTime;
      rebuildPet(rig, undefined, { species: to, furShells: 0 });
      anim.rebind();
      // Still in the same action, at the same moment of it.
      expect(anim.current).toBe(name);
      expect(anim.currentTime).toBeCloseTo(t, 6);
      for (let i = 0; i < 30; i++) {
        anim.update(1 / 30);
        expect(finite(rig), `${name} frame ${i}`).toBe(true);
      }
      // The new body is the one being moved.
      const bones = rig.bones as Record<string, THREE.Bone>;
      const moved = boneNames(to).some((n) => bones[n].rotation.x !== 0 || bones[n].rotation.y !== 0 || bones[n].rotation.z !== 0);
      expect(moved, `${name} moves the ${to}`).toBe(true);
      // It stays on the ground, about where it was.
      const hips = bones.hips.getWorldPosition(new THREE.Vector3());
      expect(hips.y, `${name} hips height`).toBeGreaterThan(0.02);
      expect(hips.y).toBeLessThan(0.5);
      expect(Math.hypot(hips.x, hips.z)).toBeLessThan(0.3);
    }
  });

  it('a Vizsla swapped in pants and wags like one built fresh', () => {
    const fresh = buildPet(undefined, { species: 'vizsla', furShells: 0 });
    const a = new Animator(fresh, 5);
    const rig = buildPet(undefined, { species: 'hopper', furShells: 0 });
    const b = new Animator(rig, 5);
    rebuildPet(rig, undefined, { species: 'vizsla', furShells: 0 });
    b.rebind();
    b.reset();
    for (const anim of [a, b]) {
      anim.play('celebrate', 0, true);
      for (let i = 0; i < 45; i++) anim.update(1 / 30);
    }
    for (const n of boneNames('vizsla')) {
      const p = fresh.bones[n], q = rig.bones[n];
      expect(q.rotation.x, `${n} rx`).toBeCloseTo(p.rotation.x, 5);
      expect(q.rotation.y, `${n} ry`).toBeCloseTo(p.rotation.y, 5);
      expect(q.rotation.z, `${n} rz`).toBeCloseTo(p.rotation.z, 5);
      expect(q.position.distanceTo(p.position), `${n} position`).toBeLessThan(1e-5);
    }
  });
});

describe('changing pets in the middle of a game', () => {
  it('the round carries on: a Vizsla takes over on the walk, Hopper comes back while hiding, and is found', () => {
    const sim = new Simulation({ room: 'living', seed: 2, species: 'hopper' });
    const bot = new SeekerBot(sim);
    const phases: string[] = [];
    let found: { revealed: boolean } | null = null;
    sim.game.events.onPhase = (p) => phases.push(p);
    sim.game.events.onFound = (info) => (found = info);
    const group = sim.rig.group;
    const swaps: string[] = [];
    let seekAt = -1;
    const dt = 1 / 30;
    while (bot.phase !== 'done' && sim.time < 260) {
      bot.step(dt);
      expect(finite(sim.rig), `finite at ${sim.time.toFixed(2)}s`).toBe(true);
      if (sim.game.phase === 'seek' && seekAt < 0) seekAt = sim.time;
      if (!swaps.length && sim.game.phase === 'roam' && sim.time > 3) {
        const at = { ...sim.pet.pos }, action = sim.anim.current;
        swapPet(sim, 'vizsla', 'russet');
        swaps.push('vizsla');
        // Same pet as far as the game is concerned: same root, same spot, same action.
        expect(sim.rig.group).toBe(group);
        expect(sim.rig.species).toBe('vizsla');
        expect(sim.rig.palette).toBe(VIZSLA_PALETTES.russet);
        expect(sim.pet.pos).toEqual(at);
        expect(sim.anim.current).toBe(action);
      } else if (swaps.length === 1 && seekAt >= 0 && sim.time > seekAt + 2) {
        const hiddenAt = { ...sim.pet.pos };
        swapPet(sim, 'hopper', 'plum');
        swaps.push('hopper');
        expect(sim.rig.species).toBe('hopper');
        expect(sim.rig.palette).toBe(PALETTES.plum);
        expect(sim.pet.pos).toEqual(hiddenAt);
        expect(sim.game.phase).toBe('seek');
      }
    }
    expect(swaps).toEqual(['vizsla', 'hopper']);
    expect(phases).toContain('countdown');
    expect(phases).toContain('seek');
    expect(found, 'round finished').not.toBeNull();
    expect(sim.game.phase).toBe('found');
    expect(sim.game.health.log, 'no recoveries needed').toEqual([]);
  }, 180_000);
});

import { HideAndSeek, type GameOptions } from './HideAndSeek';
import { Animator } from '../pet/Animator';
import { PetController } from '../pet/PetController';
import { buildPet, rebuildPet, type PetRig, type Species, PALETTES } from '../pet/PetModel';
import { WorldModel } from '../world/WorldModel';

/** The device-independent core: world model, pet and game. */
export interface GameStack {
  world: WorldModel;
  rig: PetRig;
  anim: Animator;
  pet: PetController;
  game: HideAndSeek;
}

export function createStack(
  opts: {
    seed?: number;
    /** The pet's coat (default: the one chosen for it in the model selector). */
    palette?: keyof typeof PALETTES;
    game?: Partial<GameOptions>;
    /** Which pet (default: the one chosen in the model selector). */
    species?: Species;
  } = {},
): GameStack {
  const world = new WorldModel();
  const rig = buildPet(opts.palette, { species: opts.species });
  const anim = new Animator(rig, opts.seed ?? 1);
  const pet = new PetController(rig, anim);
  const game = new HideAndSeek(world, pet, anim, rig, { seed: opts.seed ?? 1, ...opts.game });
  return { world, rig, anim, pet, game };
}

/**
 * Change the pet, or its coat, in the middle of a game: the rig is rebuilt in
 * place and the animator takes up the new body in the action it was playing,
 * so the round carries on where it was (same spot, same state, new friend).
 * With no coat it wears the one chosen for that pet.
 */
export function swapPet(stack: GameStack, species: Species, coat?: string): void {
  rebuildPet(stack.rig, coat, { species });
  stack.anim.rebind();
}

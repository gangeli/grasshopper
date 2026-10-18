import { HideAndSeek, type GameOptions } from './HideAndSeek';
import { Animator } from '../pet/Animator';
import { PetController } from '../pet/PetController';
import { buildPet, type PetRig, PALETTES } from '../pet/PetModel';
import { WorldModel } from '../world/WorldModel';

/** The device-independent core: world model, pet and game. */
export interface GameStack {
  world: WorldModel;
  rig: PetRig;
  anim: Animator;
  pet: PetController;
  game: HideAndSeek;
}

export function createStack(opts: { seed?: number; palette?: keyof typeof PALETTES; game?: Partial<GameOptions> } = {}): GameStack {
  const world = new WorldModel();
  const rig = buildPet(opts.palette ?? 'mint');
  const anim = new Animator(rig, opts.seed ?? 1);
  const pet = new PetController(rig, anim);
  const game = new HideAndSeek(world, pet, anim, rig, { seed: opts.seed ?? 1, ...opts.game });
  return { world, rig, anim, pet, game };
}

/** Times the pet body mesh build (SDF sculpt → surface nets → skinning/colour bake) at each LOD. */
import { creatureGeometry } from '../src/pet/sdf/meshCreature';
import { PALETTES } from '../src/pet/PetModel';

for (const [name, res] of [['low', 0.0045], ['mobile', 0.0034], ['desktop', 0.0028]] as const) {
  const t0 = performance.now();
  const g = creatureGeometry({ ...PALETTES.mint }, res);
  console.log(`${name.padEnd(8)} res=${res}  ${(performance.now() - t0).toFixed(0)} ms  ${g.attributes.position.count} verts  ${g.index!.count / 3} tris`);
}

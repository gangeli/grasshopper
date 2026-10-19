import { creatureGeometry } from '../src/pet/sdf/meshCreature';
import { PALETTES } from '../src/pet/PetModel';
const t = performance.now();
const g = creatureGeometry(PALETTES.mint);
const n = g.attributes.position.count;
let bad = 0; const sw = g.attributes.skinWeight;
for (let i = 0; i < n; i++) { const s = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i); if (Math.abs(s - 1) > 1e-3) bad++; }
console.log('verts', n, 'tris', g.index!.count / 3, 'ms', (performance.now() - t) | 0, 'bad weights', bad);

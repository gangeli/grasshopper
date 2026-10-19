/** Triangle / vertex budget of the pet at each LOD (what each fur shell redraws). */
import * as THREE from 'three';
import { buildPet } from '../src/pet/PetModel';

for (const [name, res] of [['low', 0.0045], ['mobile', 0.0034], ['desktop', 0.0028]] as const) {
  const rig = buildPet('mint', { meshResolution: res, furShells: 7 });
  const big: string[] = [];
  let tris = 0, meshes = 0;
  rig.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += t;
    meshes++;
    if (m.name === 'body') big.push(`body ${(t / 1000).toFixed(1)}k tris / ${(g.attributes.position.count / 1000).toFixed(1)}k verts`);
  });
  console.log(`${name.padEnd(8)} meshes ${meshes}  total tris (7 shells) ${(tris / 1000).toFixed(0)}k  ${big.join(' ')}`);
}

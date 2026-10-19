/**
 * Occluder meshing cost on a mapped room (and a fingerprint of the mesh, to
 * check optimisations don't change it):  npx tsx scripts/perf-occluder.ts
 */
import * as THREE from 'three';
import { scanRoom } from '../src/sim/scan';
import { roomFromName } from '../src/sim/SimRoom';
import { buildOccluderGeometry } from '../src/app/Occluder';

const { world } = scanRoom(roomFromName('living'), undefined, { noise: 'arcore' });
const g = world.grid!;
const ts: number[] = [];
let geo: THREE.BufferGeometry | null = null;
for (let q = 0; q < 12; q++) {
  const t0 = performance.now();
  geo = buildOccluderGeometry(g, new THREE.Vector3(0.3, 0, -0.2), 3.5, world.floorLayer);
  ts.push(performance.now() - t0);
}
ts.sort((a, b) => a - b);
const pos = geo!.attributes.position.array as Float32Array;
let h = 2166136261 >>> 0;
for (let i = 0; i < pos.length; i++) h = Math.imul(h ^ ((pos[i] * 1e4) | 0), 16777619) >>> 0;
console.log(`occluder: ${pos.length / 9} tris, hash ${h.toString(16)}, build min ${ts[0].toFixed(1)} median ${ts[6].toFixed(1)} ms`);

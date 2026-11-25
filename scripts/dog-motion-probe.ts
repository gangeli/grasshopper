/**
 * Motion probe for the Vizsla: drives the real PetController + Animator
 * headless and prints numbers that are hard to judge from stills — paw slip
 * while each paw is down, how straight the legs get (an over-reaching IK
 * target pulls a leg dead straight), body and head bob, and how much the
 * ears and tail swing.  Run: npx tsx scripts/dog-motion-probe.ts
 */
import * as THREE from 'three';
import { buildPet, type BoneName } from '../src/pet/PetModel';
import { Animator } from '../src/pet/Animator';
import { PetController } from '../src/pet/PetController';

const rig = buildPet('golden', { furShells: 0, species: 'vizsla' });
const anim = new Animator(rig, 3);
const w = (b: string) => (rig.bones as Record<string, THREE.Bone>)[b].getWorldPosition(new THREE.Vector3());
const dt = 1 / 60;
const LEGS = {
  FL: ['shoulderL', 'elbowL', 'handL'],
  FR: ['shoulderR', 'elbowR', 'handR'],
  HL: ['thighL', 'shinL', 'ankleL'],
  HR: ['thighR', 'shinR', 'ankleR'],
} as const;
const END = { FL: 'handL', FR: 'handR', HL: 'toeL', HR: 'toeR' } as const;
const PLANT = { FL: 'plantFL', FR: 'plantFR', HL: 'plantHL', HR: 'plantHR' } as const;
rig.group.updateMatrixWorld(true);
const len = Object.fromEntries(Object.entries(LEGS).map(([k, [a, b, c]]) => [k, w(a).distanceTo(w(b)) + w(b).distanceTo(w(c))])) as Record<keyof typeof LEGS, number>;

for (const cruise of [0.3, 0.5, 0.8, 1.0]) {
  anim.reset();
  const pet = new PetController(rig, anim);
  pet.placeAt(new THREE.Vector3(-1, 0, 0), Math.PI / 2);
  pet.follow([{ x: 2.5, y: 0, z: 0, jump: false, node: -1 }], cruise);
  const slip: Record<string, number> = {}, contact: Record<string, number> = {}, maxV: Record<string, number> = {}, straight: Record<string, number> = {}, bent: Record<string, number> = {};
  const prev: Record<string, THREE.Vector3> = {};
  const wasDown: Record<string, boolean> = {};
  const range = () => ({ lo: 1e9, hi: -1e9 });
  const r = { ear: range(), tail: range(), head: range(), hip: range(), chest: range(), headPitch: range() };
  const add = (k: keyof typeof r, v: number) => ((r[k].lo = Math.min(r[k].lo, v)), (r[k].hi = Math.max(r[k].hi, v)));
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  let frames = 0;
  for (let i = 0; i < 300; i++) {
    pet.update(dt);
    anim.update(dt);
    rig.group.updateMatrixWorld(true);
    const steady = i >= 90 && pet.state === 'walk';
    for (const k of Object.keys(LEGS) as (keyof typeof LEGS)[]) {
      const p = w(END[k]);
      // (Not the frame it lands on: the paw is still arriving then.)
      if (steady && prev[k] && anim.pose[PLANT[k]] > 0.5 && wasDown[k]) {
        const d = Math.hypot(p.x - prev[k].x, p.z - prev[k].z);
        slip[k] = (slip[k] ?? 0) + d;
        contact[k] = (contact[k] ?? 0) + 1;
        maxV[k] = Math.max(maxV[k] ?? 0, d / dt);
      }
      prev[k] = p;
      wasDown[k] = anim.pose[PLANT[k]] > 0.5;
      if (steady) {
        const [a, , c] = LEGS[k];
        const ratio = w(a).distanceTo(w(c)) / len[k];
        straight[k] = Math.max(straight[k] ?? 0, ratio);
        bent[k] = Math.min(bent[k] ?? 9, ratio);
      }
    }
    if (!steady) continue;
    frames++;
    const head = w('head'), hip = w('hips');
    add('ear', w('antL3').sub(head).z);
    add('tail', w('tail5').sub(hip).z);
    add('head', head.y);
    add('hip', hip.y);
    add('chest', w('chest').y);
    rig.bones.head.getWorldQuaternion(q);
    add('headPitch', e.setFromQuaternion(q, 'YXZ').x);
  }
  const cm = (k: keyof typeof r) => ((r[k].hi - r[k].lo) * 100).toFixed(2);
  console.log(`cruise ${cruise} (${frames} steady frames)`);
  for (const k of Object.keys(LEGS))
    console.log(
      `  ${k}: down ${(((contact[k] ?? 0) / Math.max(1, frames)) * 100).toFixed(0)}% of frames; slip while down mean ${((slip[k] ?? 0) / Math.max(1, (contact[k] ?? 0) * dt)).toFixed(3)} m/s, max ${(maxV[k] ?? 0).toFixed(3)} m/s; leg extension ${bent[k]?.toFixed(2)}..${straight[k]?.toFixed(2)} of full`,
    );
  console.log(`  bob: hips ${cm('hip')} cm, chest ${cm('chest')} cm, head ${cm('head')} cm, head pitch range ${(r.headPitch.hi - r.headPitch.lo).toFixed(3)} rad; ear tip sideways ${cm('ear')} cm, tail tip sideways ${cm('tail')} cm`);
}
void ({} as BoneName);

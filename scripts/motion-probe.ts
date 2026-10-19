/**
 * Motion probe for Hopper's animation: drives the real PetController +
 * Animator headless and prints numbers that are hard to judge from stills —
 * foot slip while feet are on the ground, body/head bob, and how much the
 * secondary parts (antennae, tail) swing.  Run: npx tsx scripts/motion-probe.ts
 */
import * as THREE from 'three';
import { buildPet, type BoneName } from '../src/pet/PetModel';
import { Animator } from '../src/pet/Animator';
import { PetController } from '../src/pet/PetController';

const rig = buildPet('mint', { furShells: 1 });
const anim = new Animator(rig, 3);
const w = (b: BoneName) => rig.bones[b].getWorldPosition(new THREE.Vector3());
const dt = 1 / 60;
// Height under which a foot counts as down (the ankle joint sits ~2 cm up).
const LOW = process.env.PROBE_BONE === "ankle" ? 0.026 : 0.012;

for (const [cruise, plantedOnly] of [[0.5, false], [0.5, true], [1.0, false], [1.0, true]] as const) {
  anim.reset();
  const pet = new PetController(rig, anim);
  pet.placeAt(new THREE.Vector3(-1, 0, 0), Math.PI / 2);
  pet.follow([{ x: 1.5, y: 0, z: 0, jump: false, node: -1 }], cruise);
  let slip = 0, contact = 0, frames = 0, maxSlipV = 0;
  const prev: Record<string, THREE.Vector3> = {};
  const range = () => ({ lo: 1e9, hi: -1e9 });
  const r = { ant: range(), tail: range(), head: range(), hip: range(), headPitch: range() };
  const add = (k: keyof typeof r, v: number) => ((r[k].lo = Math.min(r[k].lo, v)), (r[k].hi = Math.max(r[k].hi, v)));
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < 240; i++) {
    pet.update(dt);
    anim.update(dt);
    rig.group.updateMatrixWorld(true);
    for (const s of ['L', 'R'] as const) {
      const p = w(process.env.PROBE_BONE === "ankle" ? `ankle${s}` : `toe${s}`);
      if (i >= 60 && pet.state === "walk" && prev[s] && p.y < LOW && prev[s].y < LOW && (!plantedOnly || anim.pose.footPlant > 0.5)) {
        const d = Math.hypot(p.x - prev[s].x, p.z - prev[s].z);
        slip += d;
        contact++;
        maxSlipV = Math.max(maxSlipV, d / dt);
      }
      prev[s] = p;
    }
    if (i < 60 || pet.state !== "walk") continue;
    frames++;
    const head = w('head'), hip = w('hips');
    add('ant', w('antL3').sub(head).x);
    add('tail', w('tail5').sub(hip).y);
    add('head', head.y);
    add('hip', hip.y);
    rig.bones.head.getWorldQuaternion(q);
    add('headPitch', e.setFromQuaternion(q, 'YXZ').x);
  }
  const cm = (k: keyof typeof r) => ((r[k].hi - r[k].lo) * 100).toFixed(2);
  console.log(
    `cruise ${cruise}${plantedOnly ? ' (planted phase only)' : ''}: feet down ${((contact / frames / 2) * 100).toFixed(0)}% of frames; slip while down mean ${(slip / Math.max(1, contact * dt)).toFixed(3)} m/s, max ${maxSlipV.toFixed(3)} m/s (body ${cruise} m/s)`,
  );
  console.log(
    `  bob: hips ${cm('hip')} cm, head ${cm('head')} cm, head pitch range ${(r.headPitch.hi - r.headPitch.lo).toFixed(3)} rad; antenna tip fore-aft ${cm('ant')} cm, tail tip ${cm('tail')} cm`,
  );
}

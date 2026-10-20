import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPet, boneNames } from '../src/pet/PetModel';
import { Animator, CHANNELS, type ActionName } from '../src/pet/Animator';
import { PetController } from '../src/pet/PetController';

const ALL: ActionName[] = ['idle', 'hop', 'jumpCrouch', 'jumpAir', 'land', 'hide', 'hideLow', 'peek', 'giggle', 'surprised', 'celebrate', 'wave', 'lookAround', 'sniff', 'coverEyes', 'sleep', 'petted'];

function worldPos(rig: ReturnType<typeof buildPet>, b: string) {
  rig.group.updateMatrixWorld(true);
  return (rig.bones as Record<string, THREE.Bone>)[b].getWorldPosition(new THREE.Vector3());
}

function bounds(rig: ReturnType<typeof buildPet>) {
  rig.group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const n of boneNames()) box.expandByPoint(worldPos(rig, n));
  return box;
}

describe('Hopper rig', () => {
  it('has a complete skeleton and skinned meshes bound to it', () => {
    const rig = buildPet();
    expect(Object.keys(rig.bones).length).toBe(boneNames().length);
    let skinned = 0;
    rig.group.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        skinned++;
        expect(m.skeleton).toBe(rig.skeleton);
        const w = m.geometry.getAttribute('skinWeight');
        for (let i = 0; i < w.count; i++) expect(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i)).toBeCloseTo(1, 4);
      }
    });
    expect(skinned).toBeGreaterThanOrEqual(8);
  });

  it('rest pose stands on the ground and is pet-sized', () => {
    const rig = buildPet();
    const b = bounds(rig);
    expect(b.min.y).toBeGreaterThanOrEqual(-0.001);
    expect(b.max.y).toBeLessThan(0.42);
    expect(b.max.y).toBeGreaterThan(0.28);
  });
});

describe('Animator', () => {
  it.each(ALL)('%s produces finite poses and keeps the pet near the ground', (name) => {
    const rig = buildPet();
    const anim = new Animator(rig, 1);
    anim.lookTarget = new THREE.Vector3(0.5, 1.4, 1.5);
    anim.play(name, 0, true);
    for (let i = 0; i < 120; i++) {
      anim.ctx.hopPhase = (i / 30) % 1;
      anim.ctx.speed = 0.6;
      anim.ctx.jumpU = Math.min(1, i / 30);
      anim.update(1 / 30);
      for (const c of CHANNELS) expect(Number.isFinite(anim.pose[c]), c).toBe(true);
      for (const n of boneNames()) {
        const p = worldPos(rig, n);
        expect(Number.isFinite(p.x + p.y + p.z), n).toBe(true);
      }
      const b = bounds(rig);
      // No part sinks into the floor (jumpAir is airborne: the root rises along the arc); nothing flies away.
      if (name !== 'jumpAir') expect(b.min.y).toBeGreaterThan(-0.02);
      expect(b.max.y).toBeLessThan(0.6);
    }
  });

  it('IK keeps the feet planted while idling and crouching', () => {
    for (const name of ['idle', 'hide', 'hideLow', 'jumpCrouch'] as ActionName[]) {
      const rig = buildPet();
      const anim = new Animator(rig, 1);
      anim.play(name, 0, true);
      for (let i = 0; i < 60; i++) anim.update(1 / 30);
      for (const s of ['ankleL', 'ankleR']) expect(worldPos(rig, s).y, `${name} ${s}`).toBeLessThan(0.03);
    }
  });

  it('hiding makes the pet much lower than standing', () => {
    const height = (name: ActionName) => {
      const rig = buildPet();
      const anim = new Animator(rig, 1);
      anim.play(name, 0, true);
      for (let i = 0; i < 60; i++) anim.update(1 / 30);
      return worldPos(rig, 'head').y;
    };
    expect(height('hide')).toBeLessThan(height('idle') - 0.025);
    expect(height('hideLow')).toBeLessThan(height('hide'));
  });

  it('cross-fades smoothly between actions (no pops)', () => {
    const rig = buildPet();
    const anim = new Animator(rig, 1);
    anim.play('idle', 0, true);
    for (let i = 0; i < 30; i++) anim.update(1 / 60);
    let prev = worldPos(rig, 'head');
    anim.play('surprised', 0.2);
    for (let i = 0; i < 30; i++) {
      anim.update(1 / 60);
      const p = worldPos(rig, 'head');
      expect(p.distanceTo(prev)).toBeLessThan(0.02);
      prev = p;
    }
  });
});

describe('PetController', () => {
  it('follows a path with a jump and lands on the target', () => {
    const rig = buildPet();
    const anim = new Animator(rig, 1);
    const pet = new PetController(rig, anim);
    pet.placeAt(new THREE.Vector3(0, 0, 0));
    const states = new Set<string>();
    let landed = 0;
    pet.events.onLand = () => landed++;
    pet.follow(
      [
        { x: 0.5, y: 0, z: 0, jump: false, node: 0 },
        { x: 0.9, y: 0.75, z: 0.2, jump: true, node: 1 },
        { x: 1.2, y: 0.75, z: 0.2, jump: false, node: 2 },
      ],
      0.6,
    );
    let minY = 0;
    for (let i = 0; i < 600 && pet.moving; i++) {
      pet.update(1 / 60);
      anim.update(1 / 60);
      states.add(pet.state);
      minY = Math.min(minY, pet.pos.y);
    }
    expect(pet.moving).toBe(false);
    expect(pet.pos.distanceTo(new THREE.Vector3(1.2, 0.75, 0.2))).toBeLessThan(0.03);
    expect([...states]).toEqual(expect.arrayContaining(['walk', 'crouch', 'air', 'land']));
    expect(landed).toBe(1);
    expect(minY).toBeGreaterThanOrEqual(-1e-6);
  });
});

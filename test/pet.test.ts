import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPet as build, boneNames as names, type Species } from '../src/pet/PetModel';
import { Animator, CHANNELS, type ActionName } from '../src/pet/Animator';
import { PetController } from '../src/pet/PetController';
import { measurePoseSamples } from '../src/pet/poseSamples';

const ALL: ActionName[] = ['idle', 'hop', 'jumpCrouch', 'jumpAir', 'land', 'hide', 'hideLow', 'peek', 'giggle', 'surprised', 'celebrate', 'wave', 'lookAround', 'sniff', 'coverEyes', 'sleep', 'petted'];

function worldPos(rig: ReturnType<typeof build>, b: string) {
  rig.group.updateMatrixWorld(true);
  return (rig.bones as Record<string, THREE.Bone>)[b].getWorldPosition(new THREE.Vector3());
}

// Every pet has the same rig interface and the same actions: both are held to the same tests.
describe.each(['hopper', 'vizsla'] as Species[])('%s', (species) => {
const buildPet = () => build('mint', { species });
const boneNames = () => names(species);
// The joints that rest on the ground when the pet stands: Hopper's ankles; the dog's paws and wrists.
const GROUND: [string, number][] = species === 'vizsla' ? [['toeL', 0.022], ['toeR', 0.022], ['pawL', 0.022], ['pawR', 0.022]] : [['ankleL', 0.03], ['ankleR', 0.03]];

function bounds(rig: ReturnType<typeof build>) {
  rig.group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const n of boneNames()) box.expandByPoint(worldPos(rig, n));
  return box;
}

describe('rig', () => {
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
      for (const [s, max] of GROUND) expect(worldPos(rig, s).y, `${name} ${s}`).toBeLessThan(max);
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
});

describe('Vizsla', () => {
  const buildDog = () => build('golden', { species: 'vizsla' });
  const play = (name: ActionName, seconds: number, each?: (anim: Animator, rig: ReturnType<typeof build>, t: number) => void) => {
    const rig = buildDog();
    const anim = new Animator(rig, 2);
    anim.play(name, 0, true);
    for (let i = 0; i < seconds * 60; i++) {
      anim.update(1 / 60);
      each?.(anim, rig, (i + 1) / 60);
    }
    return { rig, anim };
  };

  it('is one skinned coat: body, jaw and both ears, every vertex fully weighted to real bones', () => {
    const rig = buildDog();
    const body = rig.group.getObjectByName('body') as THREE.SkinnedMesh;
    const g = body.geometry;
    for (const a of ['position', 'normal', 'color', 'skinIndex', 'skinWeight', 'furLen', 'flow', 'silk', 'socket', 'thin']) expect(g.getAttribute(a), a).toBeDefined();
    const idx = g.getAttribute('skinIndex'), w = g.getAttribute('skinWeight');
    const used = new Set<number>();
    for (let i = 0; i < idx.count; i++) for (let q = 0; q < 4; q++) if (w.getComponent(i, q) > 0.01) used.add(idx.getComponent(i, q));
    const bones = names('vizsla');
    for (const b of ['head', 'jaw', 'earL', 'earL1', 'earR1', 'tail5', 'pawL', 'toeR', 'elbowR', 'shinL']) expect(used.has(bones.indexOf(b as never)), b).toBe(true);
    // Hopper's antennae and wings have no counterpart: nothing is skinned to them.
    for (const b of ['antL0', 'antR3', 'wingL', 'wingR']) expect(used.has(bones.indexOf(b as never)), b).toBe(false);
    // No vertex colour is black or blown out (a baked NaN or a missed region shows up as one).
    const c = g.getAttribute('color');
    for (let i = 0; i < c.count; i += 7) {
      const lum = c.getX(i) + c.getY(i) + c.getZ(i);
      expect(Number.isFinite(lum) && lum > 0.01 && lum < 3).toBe(true);
    }
  });

  it('pants with its mouth open and tongue out, and closes its mouth to listen', () => {
    const { rig } = play('giggle', 1);
    const jaw = (rig.bones as Record<string, THREE.Bone>).jaw;
    expect(jaw.rotation.x).toBeGreaterThan(0.15);
    expect(rig.face.tongue!.morphTargetInfluences![0]).toBeGreaterThan(0.5);
    const quiet = play('lookAround', 1).rig;
    expect((quiet.bones as Record<string, THREE.Bone>).jaw.rotation.x).toBeLessThan(0.03);
    expect(quiet.face.tongue!.morphTargetInfluences![0]).toBeLessThan(0.05);
  });

  it('points: after quartering, one forepaw comes up while the other three stay planted', () => {
    const { rig } = play('sniff', 3.3);
    expect(worldPos(rig, 'pawL').y, 'lifted forepaw').toBeGreaterThan(0.035);
    for (const b of ['pawR', 'toeL', 'toeR']) expect(worldPos(rig, b).y, b).toBeLessThan(0.022);
    // Nose, back and tail in a line: the tail is out level, not drooping.
    expect(Math.abs(worldPos(rig, 'tail5').y - worldPos(rig, 'tail0').y)).toBeLessThan(0.03);
  });

  it('sits to give a paw, and lies flat with its chin on the floor', () => {
    const sit = play('wave', 1.5).rig;
    expect(worldPos(sit, 'hips').y, 'haunches down').toBeLessThan(0.1);
    expect(worldPos(sit, 'chest').y, 'chest up').toBeGreaterThan(0.14);
    expect(worldPos(sit, 'pawR').y, 'paw offered').toBeGreaterThan(0.08);
    expect(worldPos(sit, 'pawL').y, 'other paw down').toBeLessThan(0.022);
    const flat = play('hideLow', 1.5).rig;
    expect(worldPos(flat, 'head').y).toBeLessThan(0.07);
    expect(worldPos(flat, 'chest').y).toBeLessThan(0.1);
  });

  it('trots without skating: planted paws hold still, legs never lock straight', () => {
    const LEGS = { FL: ['shoulderL', 'elbowL', 'handL', 'handL'], FR: ['shoulderR', 'elbowR', 'handR', 'handR'], HL: ['thighL', 'shinL', 'ankleL', 'toeL'], HR: ['thighR', 'shinR', 'ankleR', 'toeR'] } as const;
    const rig = buildDog();
    const anim = new Animator(rig, 3);
    const len = Object.fromEntries(Object.entries(LEGS).map(([k, [a, b, c]]) => [k, worldPos(rig, a).distanceTo(worldPos(rig, b)) + worldPos(rig, b).distanceTo(worldPos(rig, c))]));
    for (const cruise of [0.35, 0.6]) {
      anim.reset();
      const pet = new PetController(rig, anim);
      pet.placeAt(new THREE.Vector3(-1, 0, 0), Math.PI / 2);
      pet.follow([{ x: 2.5, y: 0, z: 0, jump: false, node: -1 }], cruise);
      const prev: Record<string, THREE.Vector3> = {}, wasDown: Record<string, boolean> = {};
      let planted = 0, lifted = 0;
      for (let i = 0; i < 240; i++) {
        pet.update(1 / 60);
        anim.update(1 / 60);
        for (const [k, [a, , c, end]] of Object.entries(LEGS)) {
          const p = worldPos(rig, end);
          const down = anim.pose[`plant${k}` as 'plantFL'] > 0.5;
          if (i > 90 && pet.state === 'walk') {
            if (down && wasDown[k]) {
              planted++;
              // Half a millimetre a frame at the very most (measured: about a twentieth of one).
              expect(Math.hypot(p.x - prev[k].x, p.z - prev[k].z), `${k} slipped at ${cruise} m/s`).toBeLessThan(0.0005);
            } else if (!down) lifted++;
            expect(worldPos(rig, a).distanceTo(worldPos(rig, c)) / len[k], `${k} over-reached at ${cruise} m/s`).toBeLessThan(0.995);
          }
          prev[k] = p;
          wasDown[k] = down;
        }
      }
      // It really is stepping: each paw spends real time both on the ground and in the air.
      expect(planted).toBeGreaterThan(100);
      expect(lifted).toBeGreaterThan(100);
    }
  });

  it('makes room for its long body: draws its head back from something ahead, crawls under something low', () => {
    const stand = (set: (c: Animator['ctx']) => void) => {
      const rig = buildDog();
      const anim = new Animator(rig, 2);
      set(anim.ctx);
      anim.play('idle', 0, true);
      for (let i = 0; i < 90; i++) anim.update(1 / 60);
      rig.group.updateMatrixWorld(true);
      // The nose: ahead of the head joint along the muzzle.
      const nose = rig.bones.head.localToWorld(new THREE.Vector3(0, 0.008, 0.1));
      return { nose, head: worldPos(rig, 'head'), chest: worldPos(rig, 'chest'), paws: ['pawL', 'pawR', 'toeL', 'toeR'].map((b) => worldPos(rig, b).y) };
    };
    const open = stand(() => {});
    const blocked = stand((c) => (c.clearAhead = 0.12));
    expect(open.nose.z, 'reach in the open').toBeGreaterThan(0.2);
    expect(blocked.nose.z, 'reach with something 12 cm ahead').toBeLessThan(open.nose.z - 0.05);
    const under = stand((c) => (c.headroom = 0.17));
    expect(under.head.y, 'head height under 17 cm').toBeLessThan(0.15);
    expect(under.chest.y).toBeLessThan(open.chest.y - 0.07);
    // Still on its feet, not floating or sunk.
    for (const y of under.paws) expect(y).toBeLessThan(0.022);
  });

  it('hides lower and longer than Hopper: its measured hiding poses say so', () => {
    const dog = measurePoseSamples('hideLow', 'vizsla'), hopper = measurePoseSamples('hideLow', 'hopper');
    const top = (s: { y: number }[]) => Math.max(...s.map((p) => p.y));
    const length = (s: { z: number }[]) => Math.max(...s.map((p) => p.z)) - Math.min(...s.map((p) => p.z));
    expect(top(dog)).toBeLessThan(top(hopper));
    expect(length(dog)).toBeGreaterThan(length(hopper));
    expect(top(measurePoseSamples('hide', 'vizsla'))).toBeGreaterThan(top(dog));
  });
});

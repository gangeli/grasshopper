import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Simulation, type SimOptions } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { openRoom } from '../src/sim/SimRoom';
import { penetration } from '../src/sim/MapMetrics';
import { wrapAngle, type Vec3 } from '../src/core/math';
import { Activities, ACTIVITIES, HIDE_SEEK_MIN_AREA } from '../src/game/Activities';
import type { TapResult } from '../src/game/HideAndSeek';

/**
 * The "walk" activity (Hopper follows the player and explores), the
 * activities menu and tapping: tap the floor to send Hopper somewhere, tap
 * Hopper for a reaction.
 */
const DT = 1 / 30;

function lookAt(sim: Simulation, p: Vec3) {
  const c = sim.cam;
  const dx = p.x - c.pos.x, dy = p.y - c.pos.y, dz = p.z - c.pos.z;
  c.yaw = Math.atan2(-dx, -dz);
  c.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

/** Stand still and turn slowly, looking down, so the room gets mapped. */
function mapAround(sim: Simulation, seconds: number, onStep?: () => void) {
  for (let t = 0; t < seconds; t += DT) {
    sim.cam.yaw += DT * 0.7;
    sim.cam.pitch = -0.6 + 0.15 * Math.sin(t * 1.3);
    sim.step(DT);
    onStep?.();
  }
}

function run(sim: Simulation, seconds: number, onStep?: () => void) {
  for (let t = 0; t < seconds; t += DT) {
    sim.step(DT);
    onStep?.();
  }
}

/** A tap from the camera towards a world point (as the app does from a screen tap). */
function tapToward(sim: Simulation, p: Vec3): TapResult {
  const o = new THREE.Vector3(sim.cam.pos.x, sim.cam.pos.y, sim.cam.pos.z);
  const d = new THREE.Vector3(p.x, p.y, p.z).sub(o).normalize();
  return sim.game.tap(o, d);
}

function spawned(opts: SimOptions = {}) {
  const sim = new Simulation({ room: 'living', seed: 4, ...opts });
  run(sim, 0.3);
  sim.spawnPet();
  return sim;
}

/** Pet relative to the player: distance and angle off the view direction. */
function relative(sim: Simulation) {
  const v = sim.view();
  const dx = sim.pet.pos.x - v.pos.x, dz = sim.pet.pos.z - v.pos.z;
  return { dist: Math.hypot(dx, dz), angle: Math.abs(wrapAngle(Math.atan2(dx, dz) - Math.atan2(v.forward.x, v.forward.z))) };
}

describe('activities', () => {
  it('walk is the default; hide and seek unlocks once enough of the room is mapped', () => {
    const sim = spawned();
    const acts = sim.game.activities;
    expect(acts.current).toBe('walk');
    let st = acts.status();
    expect(st.map((s) => s.id)).toEqual(ACTIVITIES.map((a) => a.id));
    expect(st[0]).toMatchObject({ id: 'walk', active: true, unlocked: true });
    expect(st[1]).toMatchObject({ id: 'hideSeek', active: false, unlocked: false, ready: false });
    expect(st[1].progress).toBeLessThan(1);
    expect(st[1].hint).not.toBe('');

    const unlocks: string[] = [];
    const messages: string[] = [];
    sim.game.events.onUnlock = (a) => unlocks.push(a.id);
    sim.game.events.onMessage = (m) => messages.push(m);
    let celebrated = false;
    mapAround(sim, 30, () => {
      if (unlocks.length && sim.anim.current === 'celebrate') celebrated = true;
    });
    expect(sim.game.mappedArea()).toBeGreaterThan(HIDE_SEEK_MIN_AREA);
    expect(unlocks).toEqual(['hideSeek']);
    expect(celebrated, 'a little celebration when hide and seek unlocks').toBe(true);
    expect(messages.some((m) => /hide and seek/i.test(m))).toBe(true);
    run(sim, 3);
    st = acts.status();
    expect(st[1]).toMatchObject({ unlocked: true, ready: true, progress: 1, hint: '' });

    // Starting a round switches the activity; afterwards it's back to walking.
    expect(sim.game.start(sim.view())).toBe(true);
    expect(acts.current).toBe('hideSeek');
    expect(acts.status()[1].active).toBe(true);
    sim.game.forceAdvance(); // → seek
    sim.game.forceAdvance(); // → found (revealed)
    expect(acts.current).toBe('hideSeek');
    run(sim, 6);
    expect(sim.game.phase).toBe('roam');
    expect(acts.current).toBe('walk');
    // Unlocking is celebrated only once.
    expect(unlocks).toEqual(['hideSeek']);
  }, 60_000);

  it('the list is extensible: custom activities with their own availability predicates', () => {
    const sim = spawned();
    let ready = false;
    const acts = new Activities(sim.game, [
      ...ACTIVITIES,
      { id: 'fetch', label: 'Fetch', icon: '🎾', progress: () => (ready ? 1 : 0.5), lockedHint: () => 'soon', ready: () => ready },
    ]);
    const seen: string[] = [];
    acts.onUnlock = (d) => seen.push(d.label);
    acts.update();
    expect(acts.status()[2]).toMatchObject({ label: 'Fetch', unlocked: false, progress: 0.5, hint: 'soon' });
    ready = true;
    acts.update();
    expect(seen).toEqual(['Fetch']);
    expect(acts.status()[2]).toMatchObject({ unlocked: true, ready: true });
  });

  it('the seeker bot still plays through game.start directly', () => {
    const sim = new Simulation({ room: 'living', seed: 2 });
    const bot = new SeekerBot(sim);
    while (sim.game.phase !== 'countdown' && sim.time < 90) bot.step(DT);
    expect(sim.game.phase).toBe('countdown');
  }, 60_000);
});

describe('walk: Hopper follows the player', () => {
  it('trots after the player around the room, stays in front, never through furniture', () => {
    const sim = spawned();
    mapAround(sim, 14);
    let maxPen = 0;
    const p = new THREE.Vector3();
    const check = () => {
      sim.rig.group.updateMatrixWorld(true);
      for (const b of ['hips', 'chest'] as const) {
        sim.rig.bones[b].getWorldPosition(p);
        maxPen = Math.max(maxPen, penetration(sim.room, p));
      }
    };
    // Walk a loop through the open middle of the living room, looking ahead and down.
    const route: [number, number][] = [[0.9, 0.9], [1.0, -0.2], [-0.2, -0.3], [-0.6, 0.9], [0.2, 1.4]];
    const visits: { dist: number; angle: number }[] = [];
    const start = sim.pet.travelled;
    for (const [x, z] of route) {
      for (let guard = 0; guard < 400; guard++) {
        const c = sim.cam;
        const dx = x - c.pos.x, dz = z - c.pos.z, d = Math.hypot(dx, dz);
        if (d < 0.05) break;
        const step = Math.min(d, 0.5 * DT);
        c.pos.x += (dx / d) * step;
        c.pos.z += (dz / d) * step;
        c.yaw = Math.atan2(-dx, -dz);
        c.pitch = -0.5;
        sim.step(DT);
        check();
      }
      // Pause: Hopper should catch up and settle in view.
      run(sim, 5, check);
      visits.push(relative(sim));
    }
    console.log('follow visits', JSON.stringify(visits.map((v) => [+v.dist.toFixed(2), +v.angle.toFixed(2)])), 'stats', JSON.stringify(sim.game.companion.stats));
    expect(sim.pet.travelled - start, 'Hopper actually walked').toBeGreaterThan(3);
    expect(sim.game.companion.stats.follows).toBeGreaterThan(3);
    // After each stop Hopper is near and in front most of the time (some spots have furniture in the way).
    const good = visits.filter((v) => v.dist > 0.35 && v.dist < 2.8 && v.angle < 0.75).length;
    expect(good).toBeGreaterThanOrEqual(visits.length - 1);
    expect(maxPen, 'penetration').toBeLessThan(0.06);
  }, 90_000);

  it('explores nearby (sniffs around, short trips) while the player stands still', () => {
    const sim = spawned();
    mapAround(sim, 14);
    lookAt(sim, sim.pet.pos);
    const before = { ...sim.game.companion.stats };
    const start = sim.pet.travelled;
    const fidgets: string[] = [];
    sim.game.events.onFidget = (a) => fidgets.push(a);
    let outOfView = 0;
    run(sim, 40, () => {
      const r = relative(sim);
      if (!sim.pet.moving && r.angle > 0.7) outOfView += DT;
    });
    const s = sim.game.companion.stats;
    console.log('explore stats', JSON.stringify(s), 'fidgets', fidgets.join(','));
    expect(s.explores - before.explores).toBeGreaterThanOrEqual(2);
    expect(new Set(fidgets).size, 'varied fidgets').toBeGreaterThanOrEqual(2);
    expect(sim.pet.travelled - start).toBeGreaterThan(1);
    expect(outOfView, 'stays where the player can see').toBeLessThan(4);
  }, 60_000);

  it('camera mode: stays in front of where the phone points', () => {
    const sim = new Simulation({ room: openRoom(6, 6), seed: 3, game: { roamDistance: 1.8, eyeHeight: 1.35 } });
    sim.cam.pos.y = 1.35;
    sim.cam.pitch = -0.55;
    run(sim, 0.5);
    sim.spawnPet();
    run(sim, 6);
    // Turn the phone ~80° to the left and hold it there (the player can't walk).
    for (const yaw of [1.4, -1.0, 0.3]) {
      for (let t = 0; t < 1; t += DT) {
        sim.cam.yaw += (yaw - sim.cam.yaw) * 0.1;
        sim.step(DT);
      }
      run(sim, 8);
      const r = relative(sim);
      // A portrait phone sees about ±15° horizontally.
      expect(r.angle, `in view after turning to ${yaw}`).toBeLessThan(0.25);
      expect(r.dist).toBeGreaterThan(0.9);
      expect(r.dist).toBeLessThan(3);
    }
  }, 60_000);
});

describe('tapping', () => {
  it('tap the floor: Hopper walks to the nearest reachable spot', () => {
    const sim = spawned();
    mapAround(sim, 14);
    run(sim, 3);
    // A mapped floor spot ~1.3m from the pet, in the open.
    const nav = sim.game.refreshNav(true)!;
    let target: Vec3 | null = null;
    for (let a = 0; a < 32 && !target; a++) {
      const x = sim.pet.pos.x + Math.sin(a) * 1.3, z = sim.pet.pos.z + Math.cos(a) * 1.3;
      const n = nav.nearest({ x, y: 0, z }, 0.05);
      if (n >= 0 && Math.abs(nav.ny[n]) < 0.03 && nav.wallDist[n] > 0.25) target = nav.pos(n);
    }
    expect(target).not.toBeNull();
    lookAt(sim, target!);
    const taps: TapResult[] = [];
    sim.game.events.onTap = (r) => taps.push(r);
    const r = tapToward(sim, target!);
    expect(r.kind).toBe('goto');
    expect(taps).toEqual([r]);
    if (r.kind !== 'goto') return;
    expect(Math.hypot(r.target.x - target!.x, r.target.z - target!.z)).toBeLessThan(0.15);
    // Hopper goes there, then hangs around there (doesn't immediately run back).
    run(sim, 8);
    expect(Math.hypot(sim.pet.pos.x - r.target.x, sim.pet.pos.z - r.target.z)).toBeLessThan(0.3);
  }, 60_000);

  it('tap the floor while Hopper stands a little off the walkable graph: it still goes', () => {
    const sim = spawned();
    mapAround(sim, 14);
    run(sim, 3);
    const nav = sim.game.refreshNav(true)!;
    // A spot with no walkable node within 30cm but one within 80cm (as when
    // the map shifts under Hopper's feet in a real room).
    let off: Vec3 | null = null;
    for (let r = 0.35; r < 0.75 && !off; r += 0.05)
      for (let a = 0; a < 48 && !off; a++) {
        const p = { x: sim.pet.pos.x + Math.sin(a * 0.4) * r * 2, y: 0, z: sim.pet.pos.z + Math.cos(a * 0.4) * r * 2 };
        if (nav.nearest(p, 0.3) < 0 && nav.nearest(p, 0.8) >= 0 && !sim.room.solidAt({ ...p, y: 0.1 }, 0.1)) off = p;
      }
    expect(off).not.toBeNull();
    sim.pet.placeAt(new THREE.Vector3(off!.x, 0, off!.z));
    // Tap open, mapped floor ~1m away.
    let target: Vec3 | null = null;
    for (let a = 0; a < 32 && !target; a++) {
      const x = off!.x + Math.sin(a) * 1.0, z = off!.z + Math.cos(a) * 1.0;
      const n = nav.nearest({ x, y: 0, z }, 0.05);
      if (n >= 0 && Math.abs(nav.ny[n]) < 0.03 && nav.wallDist[n] > 0.25) target = nav.pos(n);
    }
    expect(target).not.toBeNull();
    lookAt(sim, target!);
    const r = tapToward(sim, target!);
    expect(r.kind).toBe('goto');
  }, 60_000);

  it('tap somewhere unknown: a puzzled look and a message, no walking', () => {
    const sim = spawned();
    run(sim, 4);
    for (let i = 0; i < 300 && sim.pet.moving; i++) sim.step(DT);
    const messages: string[] = [];
    sim.game.events.onMessage = (m) => messages.push(m);
    // Behind the player, never looked at: unknown floor.
    const r = tapToward(sim, { x: 0.3, y: 0, z: 2.2 });
    expect(r.kind).toBe('unreachable');
    expect(messages.length).toBe(1);
    expect(sim.pet.moving).toBe(false);
    // Straight up: nothing to go to.
    const up = sim.game.tap(new THREE.Vector3(0, 1.45, 0.6), new THREE.Vector3(0, 1, 0));
    expect(up.kind).toBe('unreachable');
  });

  it('tap Hopper: petted first (hearts), happiness builds to a happy hop, playful reactions now and then', () => {
    const sim = spawned();
    run(sim, 4);
    const taps: Extract<TapResult, { kind: 'pet' }>[] = [];
    for (let i = 0; i < 12; i++) {
      lookAt(sim, sim.pet.pos);
      const r = tapToward(sim, { x: sim.pet.pos.x, y: sim.pet.pos.y + 0.15, z: sim.pet.pos.z });
      expect(r.kind).toBe('pet');
      if (r.kind !== 'pet') continue;
      taps.push(r);
      expect(r.hearts).toBeGreaterThanOrEqual(1);
      expect(sim.anim.current).toBe(r.reaction);
      run(sim, 0.7);
    }
    const reactions = taps.map((r) => r.reaction);
    // Petting is the main response, and the first one.
    expect(reactions[0]).toBe('petted');
    expect(taps[0].sound).toBe('pet');
    expect(reactions.filter((a) => a === 'petted').length).toBeGreaterThanOrEqual(6);
    // Repeated pets: more hearts, then the big celebration hop with a shower of hearts.
    expect(taps[2].hearts).toBeGreaterThan(taps[0].hearts);
    const big = taps.findIndex((r) => r.big);
    expect(big).toBeGreaterThanOrEqual(3);
    expect(big).toBeLessThanOrEqual(5);
    expect(taps[big].reaction).toBe('celebrate');
    expect(taps[big].hearts).toBeGreaterThanOrEqual(6);
    // Playful reactions never come twice in a row.
    for (let i = 1; i < reactions.length; i++) if (reactions[i] !== 'petted' && reactions[i] !== 'celebrate') expect(reactions[i]).not.toBe(reactions[i - 1]);
  });

  it('stroking Hopper (a held press) pets on a steady beat, only while on Hopper', () => {
    const sim = spawned();
    run(sim, 4);
    lookAt(sim, sim.pet.pos);
    const o = new THREE.Vector3(sim.cam.pos.x, sim.cam.pos.y, sim.cam.pos.z);
    const target = new THREE.Vector3(sim.pet.pos.x, sim.pet.pos.y + 0.15, sim.pet.pos.z);
    let pets = 0;
    // ~2 s of holding, called every frame.
    for (let f = 0; f < 60; f++) {
      const d = target.set(sim.pet.pos.x, sim.pet.pos.y + 0.15, sim.pet.pos.z).clone().sub(o).normalize();
      const r = sim.game.stroke(o, d);
      if (r.kind === 'pet') {
        pets++;
        expect(r.stroke).toBe(true);
        expect(r.reaction === 'petted' || r.reaction === 'celebrate').toBe(true);
      }
      sim.step(DT);
    }
    expect(pets).toBeGreaterThanOrEqual(3);
    expect(pets).toBeLessThanOrEqual(5);
    // Off Hopper: nothing.
    expect(sim.game.stroke(o, new THREE.Vector3(0, 1, 0)).kind).toBe('none');
  });

  it('while seeking, taps keep their meaning: tapping the visible pet finds it, the floor does nothing', () => {
    const sim = spawned();
    mapAround(sim, 30);
    run(sim, 3);
    expect(sim.game.start(sim.view())).toBe(true);
    sim.game.forceAdvance();
    expect(sim.game.phase).toBe('seek');
    const pet = sim.pet.pos.clone();
    expect(tapToward(sim, { x: sim.cam.pos.x, y: 0, z: sim.cam.pos.z - 1 }).kind).toBe('none');
    expect(sim.game.phase).toBe('seek');
    // Make the pet visible to the game, then tap it.
    sim.game.visibility = 0.5;
    lookAt(sim, pet);
    expect(tapToward(sim, { x: pet.x, y: pet.y + 0.15, z: pet.z }).kind).toBe('found');
    expect(sim.game.phase).toBe('found');
  }, 60_000);
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ErrorBudget,
  TrackingMonitor,
  anchorCorrection,
  classifyPlacement,
  classifyViewerPose,
  clampDt,
  rayToHeight,
  transformDelta,
  validView,
} from '../src/app/runtime';

const ok = (x = 0) => ({ x, y: 1.4, z: 0 });

describe('TrackingMonitor', () => {
  it('freezes on the first bad frame, shows the message after a debounce, and resumes after settling', () => {
    const m = new TrackingMonitor(5, 0.6);
    let t = 0;
    for (let i = 0; i < 10; i++) m.update((t += 1 / 60), 'ok', ok());
    expect(m.frozen).toBe(false);
    m.update((t += 1 / 60), 'lost');
    expect(m.frozen).toBe(true);
    expect(m.showLost).toBe(false); // a blip is not worth a message
    for (let i = 0; i < 60; i++) m.update((t += 1 / 60), 'limited');
    expect(m.showLost).toBe(true);
    for (let i = 0; i < 4; i++) m.update((t += 1 / 60), 'ok', ok());
    expect(m.frozen).toBe(true); // still settling
    m.update((t += 1 / 60), 'ok', ok());
    expect(m.frozen).toBe(false);
    expect(m.showLost).toBe(false);
    expect(m.losses).toBe(1);
  });

  it('treats a pose jump (relocalisation) as a short freeze', () => {
    const m = new TrackingMonitor(3);
    let t = 0;
    for (let i = 0; i < 5; i++) m.update((t += 1 / 60), 'ok', ok());
    m.update((t += 1 / 60), 'ok', ok(2));
    expect(m.frozen).toBe(true);
    expect(m.jumps).toBe(1);
    for (let i = 0; i < 3; i++) m.update((t += 1 / 60), 'ok', ok(2));
    expect(m.frozen).toBe(false);
  });

  it('reset() forces a settle period (after a pause)', () => {
    const m = new TrackingMonitor(3);
    for (let i = 0; i < 5; i++) m.update(i / 60, 'ok', ok());
    m.reset();
    expect(m.frozen).toBe(true);
    for (let i = 0; i < 3; i++) m.update(1 + i / 60, 'ok', ok(5)); // no jump detection across the reset
    expect(m.frozen).toBe(false);
    expect(m.jumps).toBe(0);
  });
});

describe('pose and frame sanity', () => {
  it('classifies viewer poses', () => {
    const I = new THREE.Matrix4().toArray();
    expect(classifyViewerPose(null)).toBe('lost');
    expect(classifyViewerPose({ transform: { matrix: I } })).toBe('ok');
    expect(classifyViewerPose({ transform: { matrix: I }, emulatedPosition: true })).toBe('limited');
    const bad = [...I];
    bad[13] = NaN;
    expect(classifyViewerPose({ transform: { matrix: bad } })).toBe('invalid');
    bad[13] = 1e9;
    expect(classifyViewerPose({ transform: { matrix: bad } })).toBe('invalid');
  });

  it('clamps frame time (gaps never become one huge step)', () => {
    expect(clampDt(0, 1000)).toBeCloseTo(1 / 60);
    expect(clampDt(1000, 1016)).toBeCloseTo(0.016);
    expect(clampDt(1000, 1100)).toBe(0.05);
    expect(clampDt(1000, 31000)).toBe(0.05); // backgrounded for 30s
    expect(clampDt(1000, 900)).toBeCloseTo(1 / 60); // clock went backwards
    expect(clampDt(1000, NaN)).toBeCloseTo(1 / 60);
  });

  it('validates views before they reach the game', () => {
    const v = { pos: { x: 0, y: 1.4, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, fovY: 1, aspect: 0.5 };
    expect(validView(v)).toBe(true);
    expect(validView({ ...v, pos: { x: NaN, y: 0, z: 0 } })).toBe(false);
    expect(validView({ ...v, forward: { x: 0, y: 0, z: 0 } })).toBe(false);
    expect(validView({ ...v, fovY: NaN })).toBe(false);
    expect(validView({ ...v, aspect: Infinity })).toBe(false);
    expect(validView(null)).toBe(false);
  });
});

describe('ErrorBudget', () => {
  it('counts errors in a sliding window', () => {
    const b = new ErrorBudget(2);
    const log = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 10; i++) b.record(i * 0.1, 'x', new Error('boom'));
    } finally {
      console.error = log;
    }
    expect(b.recent(1)).toBe(10);
    expect(b.recent(3.5)).toBe(0);
    expect(b.total).toBe(10);
    expect(b.last).toContain('boom');
  });
});

describe('anchor correction', () => {
  it('maps the drifted tracking frame back onto the map frame', () => {
    const a0 = new THREE.Matrix4().makeTranslation(1, 0, -1);
    // Tracking drifted: the anchor now appears 10cm further +x and rotated 2°.
    const drift = new THREE.Matrix4().makeRotationY(0.035).setPosition(0.1, 0, 0);
    const at = drift.clone().multiply(a0);
    const C = new THREE.Matrix4().fromArray(anchorCorrection(a0.toArray(), at.toArray()));
    // A point seen now (tracking frame) at the anchor maps to where the anchor was.
    const seen = new THREE.Vector3().setFromMatrixPosition(at);
    expect(seen.applyMatrix4(C).distanceTo(new THREE.Vector3(1, 0, -1))).toBeLessThan(1e-6);
    // Any other point moves rigidly with it.
    const p = new THREE.Vector3(0.3, 0.5, -2);
    const pNow = p.clone().applyMatrix4(drift);
    expect(pNow.applyMatrix4(C).distanceTo(p)).toBeLessThan(1e-6);
    const d = transformDelta(new THREE.Matrix4().toArray(), C.toArray());
    expect(d.angle).toBeCloseTo(0.035, 4);
  });
});

describe('placement', () => {
  const floor = { pos: { x: 0, y: 0, z: -1 }, normal: { x: 0, y: 1, z: 0 } };
  it('accepts the floor, refuses walls and ceilings, questions raised surfaces', () => {
    expect(classifyPlacement(floor, 1.4, 0)).toEqual({ ok: true });
    expect(classifyPlacement(floor, 1.4, null)).toEqual({ ok: true });
    expect(classifyPlacement({ ...floor, normal: { x: 0, y: 0, z: 1 } }, 1.4, 0)).toMatchObject({ ok: false, reason: 'wall' });
    expect(classifyPlacement({ ...floor, normal: { x: 0, y: -1, z: 0 } }, 1.4, 0)).toMatchObject({ ok: false, reason: 'ceiling' });
    const table = { pos: { x: 0, y: 0.75, z: -1 }, normal: { x: 0, y: 1, z: 0 } };
    expect(classifyPlacement(table, 1.5, 0)).toMatchObject({ ok: false, reason: 'raised' });
    // No floor estimate, but the surface is just below the phone: probably a table.
    expect(classifyPlacement(table, 1.1, null)).toMatchObject({ ok: false, reason: 'raised' });
  });

  it('falls back to a floor estimate along the view ray', () => {
    expect(rayToHeight({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -Math.SQRT1_2, z: -Math.SQRT1_2 }, 0)).toMatchObject({ y: 0, z: expect.closeTo(-1.5, 5) });
    expect(rayToHeight({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 0)).toBeNull(); // looking at the horizon
    expect(rayToHeight({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -0.25, z: -0.97 }, 0)).toBeNull(); // too far away to trust
  });
});

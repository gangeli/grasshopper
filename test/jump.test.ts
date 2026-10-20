import { describe, expect, it } from 'vitest';
import { livingRoom } from '../src/sim/SimRoom';
import { SimSensor, type SimCamera } from '../src/sim/SimSensor';
import { senseFrame } from '../src/sim/scan';
import { WorldModel } from '../src/world/WorldModel';
import { DriftMonitor } from '../src/world/DriftMonitor';

/**
 * A tracking loss that ends with the tracker's frame persistently moved
 * (ARCore relocalising wrongly): bigger than the post-loss snapshot check can
 * search (±0.5m, ±0.1 rad), so place memory finds it (±1m, ±0.3 rad).
 */
function run(dx: number, dz: number, dyaw: number) {
  const room = livingRoom();
  const sensor = new SimSensor(room, { depth: true, planes: false, mesh: false }, 3, 'arcore');
  const world = new WorldModel();
  world.setFloor(0, { x: 0, y: 0, z: 0 });
  const drift = new DriftMonitor(world);
  let t = 0;
  const look = (seconds: number) => {
    for (let f = 0; f < seconds * 10; f++) {
      t += 0.1;
      room.time = t;
      const cam: SimCamera = { pos: { x: 0.3 * Math.sin(t * 0.3), y: 1.4, z: 0.5 }, yaw: Math.sin(t * 0.5) * 1.6, pitch: -0.5, fovY: 1.05, aspect: 0.75 };
      senseFrame(world, sensor, cam);
      drift.update(t);
    }
  };
  look(30);
  world.noteTrackingEvent(t);
  sensor.injectPoseJump(dx, dz, dyaw);
  look(1.5);
  world.noteTrackingEvent(t);
  look(20);
  const J = sensor.trackingFromTruth();
  const p = { x: 1, y: 0.5, z: -1 };
  const m = world.toMapPoint({ x: J[0] * p.x + J[8] * p.z + J[12], y: p.y, z: J[2] * p.x + J[10] * p.z + J[14] });
  return { frameErr: Math.hypot(m.x - p.x, m.z - p.z), corrections: drift.corrections };
}

describe('a tracking loss that moves the frame for good', () => {
  it('60cm and 0.15 rad: found from place memory and corrected', () => {
    const r = run(0.45, -0.3, 0.15);
    expect(r.corrections).toBeGreaterThan(0);
    expect(r.frameErr).toBeLessThan(0.08);
  }, 90_000);
  it('the other way round, with more yaw', () => {
    const r = run(-0.3, -0.3, 0.25);
    expect(r.corrections).toBeGreaterThan(0);
    // (A quarter radian: what's left is a little yaw, measured 1.5m away.)
    expect(r.frameErr).toBeLessThan(0.1);
  }, 90_000);
});

describe('the platform reports the tracking origin moved (XRReferenceSpace reset)', () => {
  it('with its transform: the map frame follows at once, nothing to rediscover', () => {
    const room = livingRoom();
    const sensor = new SimSensor(room, { depth: true, planes: false, mesh: false }, 3, 'arcore');
    const world = new WorldModel();
    world.setFloor(0, { x: 0, y: 0, z: 0 });
    const drift = new DriftMonitor(world);
    let t = 0;
    const look = (seconds: number) => {
      for (let f = 0; f < seconds * 10; f++) {
        t += 0.1;
        room.time = t;
        const cam: SimCamera = { pos: { x: 0.3 * Math.sin(t * 0.3), y: 1.4, z: 0.5 }, yaw: Math.sin(t * 0.5) * 1.6, pitch: -0.5, fovY: 1.05, aspect: 0.75 };
        senseFrame(world, sensor, cam);
        drift.update(t);
      }
    };
    const frameErr = () => {
      const J = sensor.trackingFromTruth();
      const p = { x: 1, y: 0.5, z: -1 };
      const m = world.toMapPoint({ x: J[0] * p.x + J[8] * p.z + J[12], y: p.y, z: J[2] * p.x + J[10] * p.z + J[14] });
      return Math.hypot(m.x - p.x, m.z - p.z);
    };
    const inv = (T: number[]) => {
      const R = [T[0], T[4], T[8], 0, T[1], T[5], T[9], 0, T[2], T[6], T[10], 0, 0, 0, 0, 1];
      R[12] = -(R[0] * T[12] + R[4] * T[13] + R[8] * T[14]);
      R[13] = -(R[1] * T[12] + R[5] * T[13] + R[9] * T[14]);
      R[14] = -(R[2] * T[12] + R[6] * T[13] + R[10] * T[14]);
      return R;
    };
    const mul = (A: number[], B: number[]) => {
      const o = new Array(16).fill(0);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
      return o;
    };
    look(15);
    const before = Array.from(sensor.trackingFromTruth());
    sensor.injectPoseJump(0.7, -0.4, 0.3);
    const after = Array.from(sensor.trackingFromTruth());
    expect(frameErr()).toBeGreaterThan(0.5);
    // The new origin in old tracking coordinates: p_old = before · after⁻¹ · p_new.
    world.trackingOriginReset(mul(before, inv(after)), t);
    expect(frameErr()).toBeLessThan(0.01);
    look(5);
    expect(frameErr()).toBeLessThan(0.03);
    expect(world.detaches).toBe(0);
  }, 60_000);
});

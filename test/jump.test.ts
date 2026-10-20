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

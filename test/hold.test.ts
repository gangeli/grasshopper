import { describe, expect, it } from 'vitest';
import { livingRoom } from '../src/sim/SimRoom';
import { SimSensor, type SimCamera } from '../src/sim/SimSensor';
import { senseFrame } from '../src/sim/scan';
import { WorldModel } from '../src/world/WorldModel';
import { DriftMonitor } from '../src/world/DriftMonitor';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';

/**
 * A view that contradicts the map wholesale (the tracking frame slid by
 * 30cm without the device reporting a loss) is held back instead of being
 * written in as a second copy of the room, until the drift monitor finds the
 * correction; then the held frames go in corrected.
 */
function run(jump: boolean, hold: boolean) {
  const room = livingRoom();
  const sensor = new SimSensor(room, { depth: true, planes: false, mesh: false }, 3, 'arcore');
  const world = new WorldModel();
  world.holdOnConflict = hold;
  world.setFloor(0, { x: 0, y: 0, z: 0 });
  const drift = new DriftMonitor(world, { loopMaxShift: 0.6 });
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
  look(25);
  if (jump) sensor.injectPoseJump(0.3, 0, 0);
  look(15);
  // Where the map puts a real point now (through tracking and the correction).
  const J = sensor.trackingFromTruth();
  const p = { x: 1, y: 0.5, z: -1 };
  const m = world.toMapPoint({ x: J[0] * p.x + J[8] * p.z + J[12], y: p.y, z: J[2] * p.x + J[10] * p.z + J[14] });
  const g = world.grid!;
  let occ = 0;
  for (let n = 0; n < g.data.length; n++) if (g.data[n] > OCC_THRESHOLD && g.data[n] !== 127) occ++;
  return { world, drift, frameErr: Math.hypot(m.x - p.x, m.z - p.z), occ };
}

describe('holding back contradicting frames', () => {
  it('a silent 30cm frame shift: frame corrected, no doubled room', () => {
    const calm = run(false, true);
    const shifted = run(true, true);
    expect(shifted.world.heldFrames).toBeGreaterThan(0);
    expect(shifted.drift.holdFixes).toBeGreaterThan(0);
    expect(shifted.frameErr).toBeLessThan(0.08);
    expect(shifted.occ).toBeLessThan(calm.occ * 1.2);
    // Nothing held when nothing moved.
    expect(calm.world.heldFrames).toBeLessThan(10);
  }, 60_000);
});

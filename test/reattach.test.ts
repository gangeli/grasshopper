import { describe, expect, it } from 'vitest';
import { livingRoom } from '../src/sim/SimRoom';
import { SimSensor, type SimCamera } from '../src/sim/SimSensor';
import { senseFrame } from '../src/sim/scan';
import { WorldModel } from '../src/world/WorldModel';
import { DriftMonitor } from '../src/world/DriftMonitor';
import { OCC_THRESHOLD } from '../src/world/VoxelGrid';

/**
 * A tracking jump nothing could resolve no longer costs the map: it is put
 * aside (detachMap), mapping goes on in a fresh map, and when the camera is
 * found in the old map again (relocalisation against its place memory) the
 * old map comes back, in one frame with what was learnt meanwhile.
 */
describe('a map put aside after an unresolved jump comes back', () => {
  it('detach, relocalise, re-attach', () => {
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
    const occupied = () => {
      const g = world.grid!;
      let n = 0;
      for (let q = 0; q < g.data.length; q++) if (g.data[q] > OCC_THRESHOLD && g.data[q] !== 127) n++;
      return n;
    };
    look(30);
    const before = occupied();
    expect(world.placeMemory!.submaps.length).toBeGreaterThan(3);
    // The frame jumps 60cm and turns; the health monitor gave up on it: map put aside.
    sensor.injectPoseJump(0.45, -0.35, 0.12);
    world.detachMap();
    expect(world.dormant).not.toBeNull();
    expect(occupied()).toBeLessThan(before * 0.2);
    look(25);
    if (process.env.DBG) console.log(drift.trace.filter((l) => /reloc|REATT/.test(l)).join('\n'));
    expect(world.reattaches).toBe(1);
    expect(world.dormant).toBeNull();
    look(3);
    // The frame lines up with the old map again...
    const J = sensor.trackingFromTruth();
    const p = { x: 1, y: 0.5, z: -1 };
    const m = world.toMapPoint({ x: J[0] * p.x + J[8] * p.z + J[12], y: p.y, z: J[2] * p.x + J[10] * p.z + J[14] });
    expect(Math.hypot(m.x - p.x, m.z - p.z)).toBeLessThan(0.08);
    // ...and the old map is back (not a second copy of the room).
    const after = occupied();
    expect(after).toBeGreaterThan(before * 0.8);
    expect(after).toBeLessThan(before * 1.5);
  }, 90_000);
});

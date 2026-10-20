import { describe, expect, it } from 'vitest';
import { WorldModel, type AnchorSource } from '../src/world/WorldModel';
import { SimAnchors } from '../src/sim/SimAnchors';
import { SimSensor } from '../src/sim/SimSensor';
import { generateHouse } from '../src/sim/House';

const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 1.4, z, 1];
const depth = () => ({ w: 2, h: 2, depth: new Float32Array(4), invProj: I(), camToWorld: I() });

/** A stub platform: anchors whose poses the test moves by hand. */
class StubAnchors implements AnchorSource {
  poses = new Map<number, number[] | null | 'lost'>();
  failNext = false;
  throwOnPose = false;
  released: number[] = [];
  private next = 1;
  create(pose: number[], done: (h: unknown) => void): void {
    if (this.failNext) return done(null);
    const id = this.next++;
    this.poses.set(id, pose.slice());
    done(id);
  }
  pose(h: unknown): number[] | null | 'lost' {
    if (this.throwOnPose) throw new Error('dead session');
    return this.poses.get(h as number) ?? 'lost';
  }
  release(h: unknown): void {
    this.released.push(h as number);
  }
  shift(id: number, dx: number, dz: number): void {
    const p = this.poses.get(id);
    if (Array.isArray(p)) this.poses.set(id, [...p.slice(0, 12), p[12] + dx, p[13], p[14] + dz, 1]);
  }
}

/** A world with structure laid down at known times (one voxel per second, along x). */
function world(src: AnchorSource) {
  const w = new WorldModel();
  w.sliceWarps = false;
  w.setFloor(0, { x: 0, y: 0, z: 0 });
  w.setAnchorSource(src);
  w.submapSeconds = 10;
  w.submapWalk = 0.5;
  return w;
}
/** One "depth frame" at time t with the camera at (x, z): drives the submap bookkeeping, then stamps a voxel. */
function frame(w: WorldModel, t: number, x: number, z: number, mark?: { x: number; z: number }) {
  w.ingestDepthImage({ ...depth(), camToWorld: at(x, z) }, t);
  if (mark) {
    const g = w.grid!;
    g.stamp = w.timeCode(t);
    g.set(g.cellX(mark.x), g.cellY(0.525), g.cellZ(mark.z), 80);
  }
}
const occ = (w: WorldModel, x: number, z: number) => w.grid!.get(w.grid!.cellX(x), w.grid!.cellY(0.525), w.grid!.cellZ(z));

describe('submaps glued to anchors', () => {
  it('moves what was laid down during a submap when its anchor moves, and nothing else', () => {
    const src = new StubAnchors();
    const w = world(src);
    // Submap 1: t 0..14 (camera at x=0), structure at (1.025, 0.025); submap 2 from t=15 (camera at x=1).
    for (let t = 0; t < 15; t++) frame(w, t, 0, 0, t === 5 ? { x: 1.025, z: 0.025 } : undefined);
    for (let t = 15; t < 30; t++) frame(w, t, 1, 0, t === 20 ? { x: 2.025, z: 0.025 } : undefined);
    expect(w.submaps.length).toBe(2);
    expect(occ(w, 1.025, 0.025)).toBe(80);
    // The tracker corrects itself: submap 1's anchor moves 30 cm in z.
    src.shift(1, 0, 0.3);
    frame(w, 30, 1, 0);
    expect(w.submapWarps).toBe(1);
    expect(occ(w, 1.025, 0.025)).toBe(0);
    expect(occ(w, 1.025, 0.325)).toBe(80);
    expect(occ(w, 2.025, 0.025)).toBe(80);
    // Small wobble below the threshold moves nothing.
    src.shift(2, 0.01, 0);
    frame(w, 31, 1, 0);
    expect(w.submapWarps).toBe(1);
  });

  it('turns about the anchor: structure near it barely moves, far structure swings', () => {
    const src = new StubAnchors();
    const w = world(src);
    for (let t = 0; t < 15; t++) frame(w, t, 0, 0, t === 3 ? { x: 2.025, z: 0.025 } : undefined);
    // Yaw the anchor by 0.1 rad in place.
    const c = Math.cos(0.1), s = Math.sin(0.1);
    src.poses.set(1, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 1.4, 0, 1]);
    frame(w, 15, 0, 0);
    // x' = c·x + s·z, z' = −s·x + c·z about the anchor at the origin: (2.025, 0.025) → (~2.02, ~−0.18).
    expect(occ(w, 2.025, 0.025)).toBe(0);
    expect(occ(w, 2.0175, -0.1775)).toBe(80);
  });

  it('only moves what was laid down before the anchor moved (the submap goes on in the corrected frame)', () => {
    const src = new StubAnchors();
    const w = world(src);
    for (let t = 0; t < 8; t++) frame(w, t, 0, 0, t === 2 ? { x: 1.025, z: 0.025 } : undefined);
    src.shift(1, 0.3, 0);
    frame(w, 8, 0, 0, { x: 3.025, z: 0.025 });
    expect(occ(w, 1.325, 0.025)).toBe(80);
    expect(occ(w, 3.025, 0.025)).toBe(80);
  });

  it('falls back to doing nothing when anchors fail, are lost, or the platform throws', () => {
    const src = new StubAnchors();
    src.failNext = true;
    const w = world(src);
    for (let t = 0; t < 15; t++) frame(w, t, 0, 0, t === 5 ? { x: 1.025, z: 0.025 } : undefined);
    expect(w.submaps[0].state).toBe('failed');
    src.failNext = false;
    for (let t = 15; t < 30; t++) frame(w, t, 1, 0);
    expect(w.submaps[w.submaps.length - 1].state).toBe('live');
    // Lost: released, its submap stays where it is.
    const id = w.submaps[w.submaps.length - 1].h as number;
    src.poses.set(id, 'lost');
    frame(w, 30, 1, 0);
    expect(w.submaps.find((s) => s.h === null && s.state === 'lost')).toBeTruthy();
    expect(src.released).toContain(id);
    // A platform that throws (session ended under us) must not break mapping.
    src.throwOnPose = true;
    expect(() => frame(w, 31, 1, 0)).not.toThrow();
    expect(occ(w, 1.025, 0.025)).toBe(80);
    // Session end: everything released.
    w.releaseAnchors();
    expect(w.submaps.every((s) => s.state === 'lost' || s.state === 'failed')).toBe(true);
  });
});

describe('simulated anchors', () => {
  it('follow the tracker: unchanged while it drifts, moved by a loop closure, back after a merged jump', () => {
    const house = generateHouse(1, 10, 12);
    const sensor = new SimSensor(house.room, { depth: true, planes: true, mesh: false }, 3, 'house-hard');
    const A = new SimAnchors(sensor, { fail: 0, loseRate: 0, jitterPos: 0, jitterRot: 0, miss: 0, frac: [1, 1], delay: [0, 0], mergeChance: 1, mergeDelay: [1, 1], mergeErrPos: 0, mergeErrRot: 0 });
    const id = A.create(at(1, 2))!;
    expect(id).not.toBeNull();
    const p0 = A.pose(id) as number[];
    expect(p0[12]).toBeCloseTo(1, 6);
    // A frame jump: the anchor pauses, then comes back moved by the jump.
    sensor.injectPoseJump(0.4, -0.2, 0);
    A.step(0.5, 0.5);
    expect(A.pose(id)).toBeNull();
    A.step(2, 1.5);
    const p1 = A.pose(id) as number[];
    expect(p1[12]).toBeCloseTo(1.4, 5);
    expect(p1[14]).toBeCloseTo(1.8, 5);
  });

  it('oracle anchors report through the tracking frame as it is now', () => {
    const house = generateHouse(1, 10, 12);
    const sensor = new SimSensor(house.room, { depth: true, planes: true, mesh: false }, 3, 'house-hard');
    const A = new SimAnchors(sensor, { oracle: true, fail: 0, jitterPos: 0, jitterRot: 0 });
    const id = A.create(at(0, 0))!;
    sensor.injectPoseJump(0.25, 0, 0);
    const p = A.pose(id) as number[];
    expect(p[12]).toBeCloseTo(0.25, 6);
  });
});

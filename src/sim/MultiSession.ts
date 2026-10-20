import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { WorldModel } from '../world/WorldModel';
import { DriftMonitor } from '../world/DriftMonitor';
import type { PlaneInput } from '../world/WorldModel';
import { OCC_THRESHOLD } from '../world/VoxelGrid';
import { applyPose, composePose, invertPose, poseFromMatrix, poseToMatrix, type Pose2 } from '../world/persist/pose';
import { CS, CS2, type ChunkedMap } from '../world/persist/ChunkedMap';
import type { SimRoom } from './SimRoom';
import { SimSensor, type NoiseName, type NoiseProfile, type SensorCaps, type SimCamera } from './SimSensor';
import { homeScanPath, type Home } from './Home';
import { CameraDepthSource, senseFrame } from './scan';

/**
 * Multi-session harness: every session is a fresh WebXR-like tracking frame
 * (unknown yaw and offset, floor at an arbitrary height), mapping some part
 * of a home. FramedSensor reports everything — depth poses and planes — in
 * that session's frame.
 */
export class FramedSensor extends SimSensor {
  private planeCache = new Map<string, { src: PlaneInput; out: PlaneInput }>();
  /** room → tracking frame (yaw + x/z) and the floor's height in the tracking frame. */
  constructor(room: SimRoom, caps: SensorCaps, seed: number, noise: NoiseProfile | NoiseName, readonly frame: Pose2, readonly floorY: number) {
    super(room, caps, seed, noise);
    this.jump = poseToMatrix(frame, floorY);
  }
  /**
   * Rooms of a multi-room home: planes (floor, outer walls) are clipped to the
   * rooms the camera has been in, as a real plane detector only extends a
   * plane over what it has seen.
   */
  home: Home | null = null;
  private visited = new Set<number>();
  planes(cam: SimCamera): PlaneInput[] {
    const all = super.planes(cam);
    let src = all;
    if (this.home) {
      const r = this.home.rooms.find((q) => cam.pos.x >= q.x0 && cam.pos.x <= q.x1 && cam.pos.z >= q.z0 && cam.pos.z <= q.z1);
      if (r) this.visited.add(r.id);
      src = [];
      for (const p of all)
        for (const id of this.visited) {
          const q = this.home.rooms[id], m = 0.12;
          const poly = p.polygon.map((v) => ({ x: Math.max(q.x0 - m, Math.min(q.x1 + m, v.x)), y: v.y, z: Math.max(q.z0 - m, Math.min(q.z1 + m, v.z)) }));
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
          for (const v of poly) {
            x0 = Math.min(x0, v.x);
            x1 = Math.max(x1, v.x);
            z0 = Math.min(z0, v.z);
            z1 = Math.max(z1, v.z);
          }
          // Off this room (clamped flat onto its border), or the plane doesn't reach it.
          const offX = p.polygon.every((v) => v.x < q.x0 - m) || p.polygon.every((v) => v.x > q.x1 + m);
          const offZ = p.polygon.every((v) => v.z < q.z0 - m) || p.polygon.every((v) => v.z > q.z1 + m);
          if (offX || offZ || Math.max(x1 - x0, z1 - z0) < 0.2) continue;
          src.push({ ...p, id: `${p.id}_r${id}`, polygon: poly });
        }
    }
    return src.map((p) => {
      const c = this.planeCache.get(p.id);
      if (c && samePoly(c.src, p)) return c.out;
      const out = { ...p, polygon: p.polygon.map((q) => this.toFrame(q)), normal: this.dirToFrame(p.normal) };
      this.planeCache.set(p.id, { src: p, out });
      return out;
    });
  }
  floorEstimate(): number {
    return super.floorEstimate() + this.floorY;
  }
  toFrame(p: Vec3): Vec3 {
    const q = applyPose(this.frame, p.x, p.z);
    return { x: q.x, y: p.y + this.floorY, z: q.z };
  }
  dirToFrame(d: Vec3): Vec3 {
    const c = Math.cos(this.frame.yaw), s = Math.sin(this.frame.yaw);
    return { x: c * d.x - s * d.z, y: d.y, z: s * d.x + c * d.z };
  }
}

function samePoly(a: PlaneInput, b: PlaneInput): boolean {
  if (a.polygon.length !== b.polygon.length) return false;
  for (let i = 0; i < a.polygon.length; i++) if (a.polygon[i].x !== b.polygon[i].x || a.polygon[i].y !== b.polygon[i].y || a.polygon[i].z !== b.polygon[i].z) return false;
  return true;
}

export interface SessionOptions {
  home: Home;
  /** Rooms this session may walk through (first = where it starts). */
  rooms: number[];
  seconds: number;
  seed: number;
  noise?: NoiseName | NoiseProfile;
  /** Override the random frame (room → tracking). */
  frame?: Pose2;
  floorY?: number;
  start?: Vec3;
  /** Depth from motion stereo on rendered camera frames instead of a depth sensor. */
  cameraDepth?: boolean;
  /** SimRoom to sense (e.g. a rearranged copy of the home). Default home.room. */
  room?: SimRoom;
  /** Horizontal half extent of the live grid (the app uses 6m; default 10m). */
  halfExtent?: number;
  /** Run the drift monitor as the app does (default true). */
  drift?: boolean;
}

export function randomFrame(rng: Rng, maxShift = 4): { frame: Pose2; floorY: number } {
  return { frame: { yaw: rng.range(-Math.PI, Math.PI), tx: rng.range(-maxShift, maxShift), tz: rng.range(-maxShift, maxShift), dj: 0 }, floorY: rng.chance(0.5) ? rng.range(-0.03, 0.03) : rng.range(-1.7, -1.2) };
}

/** One mapping session, stepped at 10Hz so a persistence manager can run alongside. */
export class SimSession {
  readonly world: WorldModel;
  readonly drift: DriftMonitor | null;
  readonly sensor: FramedSensor;
  readonly path: { t: number; cam: SimCamera; angVel: number }[];
  readonly camera: CameraDepthSource | undefined;
  private i = 0;
  private lost = false;
  frames = 0;
  t = 0;
  readonly room: SimRoom;

  constructor(readonly opts: SessionOptions) {
    const rng = new Rng(opts.seed * 7 + 3);
    this.world = new WorldModel({ halfExtent: opts.halfExtent ?? 10 });
    this.drift = opts.drift === false ? null : new DriftMonitor(this.world);
    const fr = opts.frame ? { frame: opts.frame, floorY: opts.floorY ?? 0 } : randomFrame(rng);
    this.room = opts.room ?? opts.home.room;
    this.sensor = new FramedSensor(this.room, { depth: true, planes: true, mesh: false }, opts.seed, opts.noise ?? 'real', fr.frame, fr.floorY);
    this.sensor.home = opts.home;
    this.path = homeScanPath({ ...opts.home, room: this.room }, opts.rooms, opts.seed, opts.seconds, opts.start);
    if (opts.cameraDepth) this.camera = new CameraDepthSource(this.room, this.sensor, { seed: opts.seed, every: 1 });
    const s0 = this.path[0]?.cam.pos ?? { x: 0, y: 0, z: 0 };
    const c = this.sensor.toFrame({ x: s0.x, y: 0, z: s0.z });
    this.world.setFloor(this.sensor.floorEstimate(), c);
  }

  /** room → map frame of this session (truth). */
  get truth(): Pose2 {
    const t2m = poseFromMatrix(this.world.trackingToMap());
    return composePose(t2m, this.sensor.frame);
  }

  get done(): boolean {
    return this.i >= this.path.length;
  }

  /** Advance one 10Hz step. */
  step(): boolean {
    if (this.done) return false;
    const st = this.path[this.i++];
    this.t = st.t;
    this.room.time = st.t;
    const ok = this.sensor.trackingOk(st.angVel);
    if (this.sensor.trackingLost !== this.lost) {
      this.lost = this.sensor.trackingLost;
      this.world.noteTrackingEvent(st.t);
    }
    if (!ok) {
      this.camera?.lost();
      return true;
    }
    senseFrame(this.world, this.sensor, st.cam, undefined, this.camera);
    this.world.refineFloor();
    this.drift?.update(st.t);
    this.frames++;
    return true;
  }
}

/**
 * Ground-truth quality of a stored map whose frame relates to the room by
 * `roomToMap` (room → map). Evaluated on voxels within the home.
 */
export interface StoredMapQuality {
  /** Occupied voxels within 1 voxel (+ a little) of real geometry. */
  precision: number;
  occupied: number;
  /** Voxels well inside real furniture (pet band) that the map believes free. */
  falseFree: number;
  /** Observed floor columns / real free floor area (m²). */
  coveredArea: number;
  coverage: number;
  /** Occupied voxels far (>15cm) from any real geometry: ghosts (misaligned merges show up here). */
  ghosts: number;
}

export function storedMapQuality(m: ChunkedMap, room: SimRoom, roomToMap: Pose2): StoredMapQuality {
  const inv = invertPose(roomToMap);
  const res = m.res;
  let occ = 0, good = 0, ghosts = 0, inside = 0, insideFree = 0, cov = 0;
  for (const c of m.chunks.values())
    for (let lz = 0; lz < CS; lz++)
      for (let lx = 0; lx < CS; lx++) {
        const I = c.cx * CS + lx, K = c.cz * CS + lz;
        const xm = m.origin.x + (I + 0.5) * res, zm = m.origin.z + (K + 0.5) * res;
        const p = applyPose(inv, xm, zm);
        if (Math.abs(p.x) > room.halfW + 0.3 || Math.abs(p.z) > room.halfD + 0.3) continue;
        if (c.observed[lz * CS + lx] && !room.solidAt({ x: p.x, y: 0.3, z: p.z }, 0) && Math.abs(p.x) < room.halfW && Math.abs(p.z) < room.halfD) cov++;
        for (let j = 1; j < m.ny; j++) {
          const v = c.occ[j * CS2 + lz * CS + lx];
          if (v === 0) continue;
          const y = (j + 0.5) * res;
          if (v > OCC_THRESHOLD) {
            occ++;
            if (room.solidAt({ x: p.x, y, z: p.z }, res * 1.2)) good++;
            else if (!room.solidAt({ x: p.x, y, z: p.z }, 0.15)) ghosts++;
          } else if (y < 0.3 && room.solidAt({ x: p.x, y, z: p.z }, -0.07)) {
            inside++;
            if (v < -2) insideFree++;
          } else if (y < 0.3 && room.solidAt({ x: p.x, y, z: p.z }, -0.07)) inside++;
        }
      }
  // Real free floor area of the home (approx.).
  let freeArea = 0;
  for (let x = -room.halfW + 0.025; x < room.halfW; x += 0.05) for (let z = -room.halfD + 0.025; z < room.halfD; z += 0.05) if (!room.solidAt({ x, y: 0.3, z }, 0)) freeArea += 0.0025;
  return { precision: occ ? good / occ : 1, occupied: occ, falseFree: inside ? insideFree / inside : 0, coveredArea: cov * res * res, coverage: freeArea ? (cov * res * res) / freeArea : 0, ghosts };
}

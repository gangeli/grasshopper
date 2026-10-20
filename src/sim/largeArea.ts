import * as THREE from 'three';
import { writeFileSync } from 'node:fs';
import { renderTopDown } from './topdown';
import type { Vec3 } from '../core/math';
import { createStack, type GameStack } from '../game/stack';
import { DepthConsistency } from '../world/DepthFrame';
import { NavGrid } from '../world/NavGrid';
import { OCC_THRESHOLD } from '../world/VoxelGrid';
import { WorldModel } from '../world/WorldModel';
import { generateHouse, type House } from './House';
import { houseWalk, type WalkOptions } from './HouseWalk';
import { evaluateMap, pathPenetration } from './MapMetrics';
import { Rng } from '../core/rng';
import { CameraDepthSource, senseFrame } from './scan';
import { cameraBasis, SimSensor, type NoiseName, type NoiseProfile, type SimCamera } from './SimSensor';
import type { SimRoom } from './SimRoom';

/**
 * Large-area mapping benchmark: a person walks through a whole multi-room
 * home with the phone (realistic fast motion, odometry drift, tracking
 * hiccups), the full game stack runs as on the device (pet following,
 * health monitor, drift correction, nav rebuilds), and the map is scored
 * against the ground truth over time:
 *
 *  - coverage: share of truly walkable floor (pet-sized clearance) in the
 *    rooms visited so far that the nav graph covers (node within 10cm);
 *  - precision: share of mapped obstacle voxels (5cm–1.2m) within 8cm of
 *    real geometry; ghosts: obstacle voxels >20cm from anything real
 *    (doubled walls after a loop, smeared furniture) as footprint m²;
 *  - falseFree: inside of real furniture the map believes it saw empty;
 *  - retention: each room's coverage/precision when the walker leaves it
 *    the first time vs at the end;
 *  - frame error: where the map puts what the camera sees now vs reality;
 *  - memory and per-frame CPU (mean / p95 / max) on the main thread
 *    (nav builds counted separately: on the device they run in a worker).
 *
 * The map frame is the tracking frame at the start, which is the truth
 * frame, so metrics compare map coordinates with the room directly.
 */
export interface LargeAreaOptions {
  house?: House;
  houseSeed?: number;
  size?: [number, number];
  seed?: number;
  seconds?: number;
  noise?: NoiseName | NoiseProfile;
  walk?: Partial<WalkOptions>;
  /** Camera frames (30 Hz) per depth frame. */
  depthEvery?: number;
  /** Multi-view depth consistency gate (on in AR). */
  multiView?: boolean;
  /** Seconds between metric samples. */
  evalEvery?: number;
  /** Run the game (pet + health monitor); off = mapping only. */
  game?: boolean;
  /** Drift check search steps per frame (see DriftMonitor.budgetSteps). */
  driftBudgetSteps?: number;
  depthFrom?: 'sensor' | 'camera';
  /** Configure the world model before mapping starts. */
  setup?: (world: WorldModel, stack: GameStack, sensor: SimSensor) => void;
  log?: (line: string) => void;
  /** Write a top-down picture of the final map (PNG) here. */
  png?: string;
  /** Called at every metric interval (diagnostics). */
  inspect?: (ctx: { t: number; world: WorldModel; sensor: SimSensor; cam: SimCamera; room: SimRoom; house: House }) => void;
}

export interface LargeAreaSample {
  t: number;
  walked: number;
  /** Walkable-floor coverage in rooms visited so far, and over the whole home. */
  coverage: number;
  coverageAll: number;
  precision: number;
  ghostM2: number;
  falseFree: number;
  frameErr: number;
  /**
   * The map around the player as the camera sees it now: share of mapped
   * obstacle voxels within 3.5m that are real (through the current frame),
   * averaged over the interval (sampled every 2s), and the ghost footprint.
   */
  localPrecision: number;
  localGhostM2: number;
  /** Local precision of structure last observed ≥15s ago / within 15s, and the old share. */
  localPrecOld: number;
  localPrecRecent: number;
  localOldShare: number;
  /**
   * Hopper's paths near the player, walked in reality through the current
   * frame: share that run into real furniture (>2cm), sampled every 6s.
   */
  localPathColl: number;
  /** Max frame error over the last interval. */
  frameErrMax: number;
  memMB: number;
  navNodes: number;
  roomsVisited: number;
  recoveries: string;
}

export interface RoomRetention {
  id: number;
  kind: string;
  firstLeftT: number;
  coverageFirst: number;
  coverageEnd: number;
  precisionFirst: number;
  precisionEnd: number;
}

export interface Stat {
  mean: number;
  p95: number;
  max: number;
  n: number;
}

export interface LargeAreaReport {
  house: { width: number; depth: number; rooms: number; walkableM2: number };
  seconds: number;
  walked: number;
  samples: LargeAreaSample[];
  rooms: RoomRetention[];
  cpu: { sense: Stat; game: Stat; frame: Stat; nav: Stat; frameOver16: number };
  final: LargeAreaSample & { pathsColliding: number; pathsTested: number; pathMaxPen: number; nodesColliding: number };
  events: { trackingLosses: number; loopClosures: number; depthFrames: number; depthRejected: number; health: Record<string, number>; mvKept: number; mvDropped: number; recenters: number; gate: Record<string, number>; healthLog: string[]; loopsClosed: number; realigns: { t: number; before: number; after: number; what: string }[] };
  /** Retention summary: mean over rooms of (end - first) coverage / precision. */
  retention: { coverageDrop: number; precisionDrop: number; worstCoverageDrop: number };
  heapMB: number;
  /** All typed-array memory of the process (map, recovery copies, nav, scratch): the honest total. */
  arrayBuffersMB: number;
  /** Peak of arrayBuffers over the run (sampled at each metric interval). */
  arrayBuffersPeakMB: number;
}

function stat(xs: number[]): Stat {
  if (!xs.length) return { mean: 0, p95: 0, max: 0, n: 0 };
  const s = xs.slice().sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: s.length };
}

/** Truly walkable floor cells (pet clearance), per room, at `cell` spacing. */
export function walkableTruth(house: House, cell = 0.1): { x: number; z: number; room: number }[] {
  const room = house.room, out: { x: number; z: number; room: number }[] = [];
  const blockers = room.boxes.filter((b) => b.min.y < 0.2 && b.max.y > 0.03);
  for (const q of house.rooms)
    for (let x = q.min.x + 0.15; x < q.max.x - 0.15; x += cell)
      for (let z = q.min.z + 0.15; z < q.max.z - 0.15; z += cell) {
        let ok = true;
        for (const b of blockers)
          if (x > b.min.x - 0.12 && x < b.max.x + 0.12 && z > b.min.z - 0.12 && z < b.max.z + 0.12) {
            ok = false;
            break;
          }
        if (ok) out.push({ x, z, room: q.id });
      }
  return out;
}

export function runLargeArea(o: LargeAreaOptions = {}): LargeAreaReport {
  const seed = o.seed ?? 1;
  const house = o.house ?? generateHouse(o.houseSeed ?? seed, o.size?.[0] ?? 10, o.size?.[1] ?? 12);
  const room: SimRoom = house.room;
  const seconds = o.seconds ?? 300;
  const sensor = new SimSensor(room, { depth: true, planes: true, mesh: false }, seed + 11, o.noise ?? 'house');
  const stack = createStack({ seed });
  const { world, game } = stack;
  if (o.multiView !== false) world.multiView = new DepthConsistency();
  // Drift checks spread over frames as on a phone (~3 ms per frame there),
  // paced by search steps so runs don't depend on this machine's speed.
  game.health.drift.budgetSteps = o.driftBudgetSteps ?? 10;
  world.setFloor(sensor.floorEstimate(), { x: house.start.x, y: 0, z: house.start.z });
  o.setup?.(world, stack, sensor);
  const camera = o.depthFrom === 'camera' ? new CameraDepthSource(room, sensor, { seed, every: 1 }) : null;
  const path = houseWalk(house, seed, { seconds, ...o.walk });
  const depthEvery = o.depthEvery ?? 3;
  const evalEvery = o.evalEvery ?? 30;
  const truth = walkableTruth(house);
  const log = o.log ?? (() => {});

  // Nav builds run in a worker on the device: time them separately.
  const navTimes: number[] = [];
  const origBuild = NavGrid.prototype.build;
  NavGrid.prototype.build = function (this: NavGrid) {
    const t0 = performance.now();
    origBuild.call(this);
    navTimes.push(performance.now() - t0);
  };
  const senseT: number[] = [], gameT: number[] = [], frameT: number[] = [];
  const samples: LargeAreaSample[] = [];
  const visited = new Set<number>();
  const firstLeft = new Map<number, number>();
  const roomFirst = new Map<number, { cov: number; prec: number; t: number }>();
  let lastRoom = -1, lost = false, losses = 0, depthFrames = 0, depthRejected = 0;
  let frameErrMax = 0, walked = 0, spawned = false;
  let abPeak = 0;
  let localSum = 0, ghostSum = 0, localN = 0, oldGood = 0, oldOcc = 0, recGood = 0, recOcc = 0, pathTested = 0, pathHit = 0;
  const pathRng = new Rng(seed * 13 + 1);
  const dt = 1 / 30;
  // Every map-frame correction, scored against the truth (frame error before → after).
  const realigns: { t: number; before: number; after: number; what: string }[] = [];
  let curCam: SimCamera | null = null;
  const origRealign = world.realign.bind(world);
  world.realign = (dx, dz, dyaw, pivot, since) => {
    const before = curCam ? frameError(world, sensor, curCam) : 0;
    origRealign(dx, dz, dyaw, pivot, since);
    const after = curCam ? frameError(world, sensor, curCam) : 0;
    realigns.push({ t: world.now, before, after, what: game.health.drift.trace[game.health.drift.trace.length - 1] ?? '' });
    if (process.env.TRACE) log(`  realign at ${world.now.toFixed(1)}s: frame error ${(before * 100).toFixed(0)} → ${(after * 100).toFixed(0)}cm`);
  };
  try {
    for (let f = 0; f < path.length; f++) {
      const step = path[f];
      curCam = step.cam;
      room.time = step.t;
      if (f > 0) walked += Math.hypot(step.cam.pos.x - path[f - 1].cam.pos.x, step.cam.pos.z - path[f - 1].cam.pos.z);
      sensor.moveTo(step.cam, step.t, dt);
      // Rooms: note the first time the walker leaves each one (retention baseline).
      const r = step.roomId;
      if (r >= 0) {
        visited.add(r);
        if (lastRoom >= 0 && r !== lastRoom && !firstLeft.has(lastRoom)) {
          firstLeft.set(lastRoom, step.t);
          const full = fullMap(world, house);
          roomFirst.set(lastRoom, { ...roomScore(full.world, full.nav, house, truth, lastRoom), t: step.t });
        }
        lastRoom = r;
      }
      const navBefore = navTimes.length;
      const t0 = performance.now();
      if (f % depthEvery === 0) {
        const ok = sensor.trackingOk(step.angVel);
        if (sensor.trackingLost !== lost) {
          lost = sensor.trackingLost;
          if (lost) losses++;
          world.noteTrackingEvent(step.t);
          if (lost) camera?.lost();
        }
        if (ok) {
          const before = world.poseGate.rejected;
          senseFrame(world, sensor, step.cam, undefined, camera ?? undefined);
          depthFrames++;
          if (world.poseGate.rejected !== before) depthRejected++;
        }
      }
      const t1 = performance.now();
      if (o.game !== false) {
        if (!spawned && step.t > 2) {
          spawned = true;
          const { forward } = cameraBasis(step.cam);
          const p = { x: step.cam.pos.x + forward.x, y: 0, z: step.cam.pos.z + forward.z };
          world.ingestHit(p);
          game.refreshNav(true);
          const nav = game.nav!;
          const n = nav.nearest(world.toMapPoint(p), 1.0);
          const at = n >= 0 ? nav.pos(n) : p;
          game.spawn(new THREE.Vector3(at.x, at.y, at.z), new THREE.Vector3(step.cam.pos.x, 0, step.cam.pos.z));
        }
        if (spawned) game.update(dt, trackedView(sensor, step.cam));
      }
      const t2 = performance.now();
      // Nav builds inside this frame run in the worker on the device, not on the main thread.
      let navInFrame = 0;
      for (let q = navBefore; q < navTimes.length; q++) navInFrame += navTimes[q];
      senseT.push(t1 - t0);
      gameT.push(t2 - t1 - navInFrame);
      frameT.push(t2 - t0 - navInFrame);
      if (f % 30 === 0) frameErrMax = Math.max(frameErrMax, frameError(world, sensor, step.cam));
      if (f % 180 === 90 && world.grid && game.nav && game.nav.g === world.grid && game.nav.count > 50) {
        const lc = localPathCollisions(world, game.nav, sensor, room, step.cam, 12, pathRng);
        pathTested += lc.tested;
        pathHit += lc.colliding;
      }
      if (f % 60 === 0 && world.grid) {
        const lp = localPrecision(world, sensor, room, step.cam);
        if (lp.occ > 20) {
          localSum += lp.precision;
          ghostSum += lp.ghostM2;
          localN++;
          oldGood += lp.oldGood;
          oldOcc += lp.oldOcc;
          recGood += lp.good - lp.oldGood;
          recOcc += lp.occ - lp.oldOcc;
        }
      }
      const last = f === path.length - 1;
      if (Math.floor(step.t / evalEvery) !== Math.floor((step.t - dt) / evalEvery) || last) {
        o.inspect?.({ t: step.t, world, sensor, cam: step.cam, room, house });
        // (Before building the scoring copy of the whole map.)
        (globalThis as { gc?: () => void }).gc?.();
        abPeak = Math.max(abPeak, process.memoryUsage().arrayBuffers);
        const full = fullMap(world, house);
        const s = sample(world, full.world, full.nav, house, truth, visited, step, sensor, game.health.counts as Record<string, number>);
        s.walked = walked;
        s.frameErrMax = Math.max(frameErrMax, s.frameErr);
        frameErrMax = 0;
        s.localPrecision = localN ? localSum / localN : 1;
        s.localGhostM2 = localN ? ghostSum / localN : 0;
        s.localPrecOld = oldOcc ? oldGood / oldOcc : 1;
        s.localPrecRecent = recOcc ? recGood / recOcc : 1;
        s.localOldShare = oldOcc + recOcc ? oldOcc / (oldOcc + recOcc) : 0;
        s.localPathColl = pathTested ? pathHit / pathTested : 0;
        localSum = ghostSum = localN = oldGood = oldOcc = recGood = recOcc = pathTested = pathHit = 0;
        samples.push(s);
        log(fmtSample(s));
      }
    }
  } finally {
    NavGrid.prototype.build = origBuild;
  }
  const { world: fw, nav } = fullMap(world, house);
  if (o.png) {
    const pts = path.filter((_, q) => q % 10 === 0).map((p) => p.cam.pos);
    writeFileSync(o.png, renderTopDown(fw, nav, room, pts));
  }
  room.time = 1e6; // people have left
  const fin = samples[samples.length - 1];
  const em = evaluateMap(fw, nav, room, { paths: 80, seed: 5 });
  const rooms: RoomRetention[] = [];
  for (const q of house.rooms) {
    const first = roomFirst.get(q.id);
    if (!first) continue;
    const end = roomScore(fw, nav, house, truth, q.id);
    rooms.push({ id: q.id, kind: q.kind, firstLeftT: first.t, coverageFirst: first.cov, coverageEnd: end.cov, precisionFirst: first.prec, precisionEnd: end.prec });
  }
  const drops = rooms.map((q) => q.coverageFirst - q.coverageEnd);
  const pdrops = rooms.map((q) => q.precisionFirst - q.precisionEnd);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fs = stat(frameT);
  if (process.env.TRACE) for (const l of game.health.drift.trace) if (process.env.TRACE === 'all' || /loop|LOOP|REALIGN|event/.test(l)) log(`  drift ${l}`);
  return {
    house: { width: house.width, depth: house.depth, rooms: house.rooms.length, walkableM2: truth.length * 0.01 },
    seconds,
    walked,
    samples,
    rooms,
    cpu: { sense: stat(senseT), game: stat(gameT), frame: fs, nav: stat(navTimes), frameOver16: frameT.filter((x) => x > 16).length },
    final: { ...fin, pathsColliding: em.pathsColliding, pathsTested: em.pathsTested, pathMaxPen: em.pathMaxPenetration, nodesColliding: em.nodesColliding },
    events: { trackingLosses: losses, loopClosures: sensor.loopClosures, depthFrames, depthRejected, health: { ...(game.health.counts as Record<string, number>) }, mvKept: world.multiView?.kept ?? 0, mvDropped: world.multiView?.dropped ?? 0, recenters: world.recenters, loopsClosed: game.health.drift.loopClosures, realigns, gate: { ...world.poseGate.reasons }, healthLog: game.health.log.map((e) => `${e.t.toFixed(0)}s ${e.issue}: ${e.detail}`) },
    retention: { coverageDrop: mean(drops), precisionDrop: mean(pdrops), worstCoverageDrop: drops.length ? Math.max(...drops) : 0 },
    heapMB: process.memoryUsage().heapUsed / 1e6,
    arrayBuffersMB: process.memoryUsage().arrayBuffers / 1e6,
    arrayBuffersPeakMB: abPeak / 1e6,
  };
}

/** The view the device reports: the true camera seen through the tracking frame. */
function trackedView(sensor: SimSensor, cam: SimCamera) {
  const M = sensor.trackingFromTruth();
  const { forward, up } = cameraBasis(cam);
  const p = cam.pos;
  const tp = (v: Vec3, w: number) => ({ x: M[0] * v.x + M[4] * v.y + M[8] * v.z + M[12] * w, y: M[1] * v.x + M[5] * v.y + M[9] * v.z + M[13] * w, z: M[2] * v.x + M[6] * v.y + M[10] * v.z + M[14] * w });
  return { pos: tp(p, 1), forward: tp(forward, 0), up: tp(up, 0), fovY: cam.fovY, aspect: cam.aspect };
}

/** Where the map puts real points around the camera now vs where they are (m, worst of a few). */
export function frameError(world: WorldModel, sensor: SimSensor, cam: SimCamera): number {
  const T = sensor.trackingFromTruth();
  const { forward } = cameraBasis(cam);
  let worst = 0;
  for (const [a, b] of [[1, 0], [1.5, 0.5], [1.5, -0.5]]) {
    const fx = forward.x, fz = forward.z, L = Math.hypot(fx, fz) || 1;
    const p = { x: cam.pos.x + (fx / L) * a - (fz / L) * b, y: 0.3, z: cam.pos.z + (fz / L) * a + (fx / L) * b };
    const tr = { x: T[0] * p.x + T[4] * p.y + T[8] * p.z + T[12], y: T[1] * p.x + T[5] * p.y + T[9] * p.z + T[13], z: T[2] * p.x + T[6] * p.y + T[10] * p.z + T[14] };
    const m = world.toMapPoint(tr);
    worst = Math.max(worst, Math.hypot(m.x - p.x, m.z - p.z));
  }
  return worst;
}

/**
 * The whole map (window + archive) in one big fixed grid with its nav graph,
 * for scoring: the live window only covers the area around the player.
 */
export function fullMap(world: WorldModel, house: House): { world: WorldModel; nav: NavGrid } {
  const m = world.exportMap()!;
  const half = Math.max(house.width, house.depth) / 2 + 1.2;
  const w = new WorldModel({ halfExtent: half });
  w.followCamera = false;
  // Centre so that the lattices line up (the import is then a plain copy).
  const n = w.windowChunks * 32, r = w.res;
  const ox = m.originX + Math.round((-n / 2) * r / r - m.originX / r) * r;
  const oz = m.originZ + Math.round((-n / 2) * r / r - m.originZ / r) * r;
  w.setFloor(world.floorY, { x: ox + (n / 2) * r, y: 0, z: oz + (n / 2) * r });
  w.importMap(m);
  return { world: w, nav: new NavGrid(w) };
}

/** Obstacle voxels within `radius` of the camera, taken to reality through the current frame chain. */
export function localPrecision(world: WorldModel, sensor: SimSensor, room: SimRoom, cam: SimCamera, radius = 3.5): { precision: number; ghostM2: number; occ: number; good: number; oldOcc: number; oldGood: number } {
  const g = world.grid!;
  // map → tracking → truth
  const m2t = world.mapToTracking();
  const T = sensor.trackingFromTruth();
  // Rigid inverse of T.
  const Ti = [T[0], T[4], T[8], 0, T[1], T[5], T[9], 0, T[2], T[6], T[10], 0, 0, 0, 0, 1];
  Ti[12] = -(Ti[0] * T[12] + Ti[4] * T[13] + Ti[8] * T[14]);
  Ti[13] = -(Ti[1] * T[12] + Ti[5] * T[13] + Ti[9] * T[14]);
  Ti[14] = -(Ti[2] * T[12] + Ti[6] * T[13] + Ti[10] * T[14]);
  const M = mulCM(Ti, m2t);
  // Where the camera is in the map frame.
  const tr = T, p = cam.pos;
  const ct = { x: tr[0] * p.x + tr[4] * p.y + tr[8] * p.z + tr[12], y: 0, z: tr[2] * p.x + tr[6] * p.y + tr[10] * p.z + tr[14] };
  const cm = world.toMapPoint({ x: ct.x, y: 1, z: ct.z });
  const i0 = Math.max(0, g.cellX(cm.x - radius)), i1 = Math.min(g.nx - 1, g.cellX(cm.x + radius));
  const k0 = Math.max(0, g.cellZ(cm.z - radius)), k1 = Math.min(g.nz - 1, g.cellZ(cm.z + radius));
  const j0 = world.floorLayer + 1, j1 = Math.min(g.ny - 1, g.cellY(world.floorY + 1.2));
  const near = (x: number, y: number, z: number, pad: number) => {
    for (const b of room.boxes) if (x > b.min.x - pad && x < b.max.x + pad && y > b.min.y - pad && y < b.max.y + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
    return false;
  };
  let occ = 0, good = 0, ghostCols = 0, oldOcc = 0, oldGood = 0;
  const oldStamp = g.stamp - 15;
  for (let k = k0; k <= k1; k += 2)
    for (let i = i0; i <= i1; i += 2) {
      const x = g.centerX(i), z = g.centerZ(k);
      if ((x - cm.x) ** 2 + (z - cm.z) ** 2 > radius * radius) continue;
      let ghost = false;
      for (let j = j0; j <= j1; j++) {
        if (g.data[g.idx(i, j, k)] <= OCC_THRESHOLD) continue;
        const y = g.centerY(j);
        const rx = M[0] * x + M[4] * y + M[8] * z + M[12], ry = M[1] * x + M[5] * y + M[9] * z + M[13], rz = M[2] * x + M[6] * y + M[10] * z + M[14];
        occ++;
        const isOld = !!g.hitTime && (g.hitTime[g.idx(i, j, k)] & 0xffff) < oldStamp;
        if (isOld) oldOcc++;
        if (near(rx, ry, rz, 0.08)) {
          good++;
          if (isOld) oldGood++;
        } else if (!ghost && !near(rx, ry, rz, 0.2)) ghost = true;
      }
      if (ghost) ghostCols++;
    }
  return { precision: occ ? good / occ : 1, ghostM2: ghostCols * (g.res * 2) ** 2, occ, good, oldOcc, oldGood };
}

/** Random nav paths between nodes within 3m of the player, checked against reality through the current frame. */
function localPathCollisions(world: WorldModel, nav: NavGrid, sensor: SimSensor, room: SimRoom, cam: SimCamera, n: number, rng: Rng): { tested: number; colliding: number } {
  const T = sensor.trackingFromTruth();
  const Ti = [T[0], T[4], T[8], 0, T[1], T[5], T[9], 0, T[2], T[6], T[10], 0, 0, 0, 0, 1];
  Ti[12] = -(Ti[0] * T[12] + Ti[4] * T[13] + Ti[8] * T[14]);
  Ti[13] = -(Ti[1] * T[12] + Ti[5] * T[13] + Ti[9] * T[14]);
  Ti[14] = -(Ti[2] * T[12] + Ti[6] * T[13] + Ti[10] * T[14]);
  const M = mulCM(Ti, world.mapToTracking());
  const p = cam.pos;
  const cm = world.toMapPoint({ x: T[0] * p.x + T[8] * p.z + T[12], y: 1, z: T[2] * p.x + T[10] * p.z + T[14] });
  const near: number[] = [];
  for (let a = 0; a < nav.count; a += 3) {
    const q = nav.pos(a);
    if (Math.hypot(q.x - cm.x, q.z - cm.z) < 3) near.push(a);
  }
  if (near.length < 20) return { tested: 0, colliding: 0 };
  let tested = 0, colliding = 0;
  for (let q = 0; q < n * 3 && tested < n; q++) {
    const a = near[rng.int(0, near.length - 1)], b = near[rng.int(0, near.length - 1)];
    if (a === b) continue;
    const path = nav.pathBetween(a, b, 8, 4000, false);
    if (!path || path.length < 2) continue;
    tested++;
    const real = path.map((w) => ({ ...w, x: M[0] * w.x + M[4] * w.y + M[8] * w.z + M[12], y: M[1] * w.x + M[5] * w.y + M[9] * w.z + M[13], z: M[2] * w.x + M[6] * w.y + M[10] * w.z + M[14] }));
    if (pathPenetration(room, real) > 0.02) colliding++;
  }
  return { tested, colliding };
}

function mulCM(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
  return o;
}

function covered(nav: NavGrid, world: WorldModel, x: number, z: number): boolean {
  const n = nav.nearest({ x, y: world.floorY, z }, 0.1);
  return n >= 0 && Math.abs(nav.ny[n] - world.floorY) < 0.05;
}

function roomScore(world: WorldModel, nav: NavGrid, house: House, truth: { x: number; z: number; room: number }[], id: number): { cov: number; prec: number } {
  let n = 0, c = 0;
  for (const p of truth)
    if (p.room === id) {
      n++;
      if (covered(nav, world, p.x, p.z)) c++;
    }
  const q = house.rooms[id];
  const pr = precisionIn(world, house.room, q.min.x, q.min.z, q.max.x, q.max.z, 1);
  return { cov: n ? c / n : 0, prec: pr.precision };
}

/** Obstacle-voxel precision and ghost footprint inside a rectangle (map frame = truth frame). */
function precisionIn(world: WorldModel, room: SimRoom, x0: number, z0: number, x1: number, z1: number, stride = 2): { precision: number; ghostM2: number; occ: number } {
  const g = world.grid!;
  const i0 = Math.max(0, g.cellX(x0)), i1 = Math.min(g.nx - 1, g.cellX(x1)), k0 = Math.max(0, g.cellZ(z0)), k1 = Math.min(g.nz - 1, g.cellZ(z1));
  const j0 = world.floorLayer + 1, j1 = Math.min(g.ny - 1, g.cellY(world.floorY + 1.2));
  let occ = 0, good = 0, ghostCols = 0;
  const bvh = room.boxes;
  const near = (x: number, y: number, z: number, pad: number) => {
    for (const b of bvh) if (x > b.min.x - pad && x < b.max.x + pad && y > b.min.y - pad && y < b.max.y + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
    return false;
  };
  for (let k = k0; k <= k1; k += stride)
    for (let i = i0; i <= i1; i += stride) {
      let ghost = false;
      for (let j = j0; j <= j1; j++) {
        if (g.data[g.idx(i, j, k)] <= OCC_THRESHOLD) continue;
        const x = g.centerX(i), y = g.centerY(j), z = g.centerZ(k);
        occ++;
        if (near(x, y, z, 0.08)) good++;
        else if (!ghost && !near(x, y, z, 0.2)) ghost = true;
      }
      if (ghost) ghostCols++;
    }
  return { precision: occ ? good / occ : 1, ghostM2: ghostCols * (g.res * stride) ** 2, occ };
}

/** Real furniture insides (3–25cm up, 6–11cm in from the faces) the map believes it saw empty. */
function falseFreeShare(world: WorldModel, room: SimRoom): number {
  const g = world.grid!;
  let shell = 0, bad = 0;
  for (const b of room.boxes) {
    const pc = room.pieces[b.piece];
    if (pc.label === 'wall') continue;
    if (Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < 0.16) continue;
    for (let y = Math.max(b.min.y, 0.03) + 0.02; y < Math.min(b.max.y, 0.25); y += 0.04)
      for (let x = b.min.x; x <= b.max.x + 1e-6; x += 0.04)
        for (let z = b.min.z; z <= b.max.z + 1e-6; z += 0.04) {
          const edge = Math.min(x - b.min.x, b.max.x - x, z - b.min.z, b.max.z - z);
          if (edge <= 0.06 || edge >= 0.11) continue;
          const i = g.cellX(x), j = g.cellY(y), k = g.cellZ(z);
          if (!g.inBounds(i, j, k)) continue;
          const v = g.data[g.idx(i, j, k)];
          if (v === 0) continue; // never seen: says nothing
          shell++;
          if (v < -2) bad++;
        }
  }
  return shell ? bad / shell : 0;
}

function sample(live: WorldModel, world: WorldModel, nav: NavGrid, house: House, truth: { x: number; z: number; room: number }[], visited: Set<number>, step: { t: number; cam: SimCamera }, sensor: SimSensor, counts: Record<string, number>): LargeAreaSample {
  let nv = 0, cv = 0, ca = 0;
  for (let q = 0; q < truth.length; q += 2) {
    const p = truth[q];
    const c = covered(nav, world, p.x, p.z);
    if (c) ca++;
    if (visited.has(p.room)) {
      nv++;
      if (c) cv++;
    }
  }
  const pr = precisionIn(world, house.room, -house.width / 2, -house.depth / 2, house.width / 2, house.depth / 2, 2);
  const rec = Object.entries(counts)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  return {
    t: step.t,
    walked: 0,
    coverage: nv ? cv / nv : 0,
    coverageAll: ca / Math.max(1, Math.ceil(truth.length / 2)),
    precision: pr.precision,
    ghostM2: pr.ghostM2,
    falseFree: falseFreeShare(world, house.room),
    frameErr: frameError(live, sensor, step.cam),
    localPrecision: 0,
    localGhostM2: 0,
    localPrecOld: 0,
    localPrecRecent: 0,
    localOldShare: 0,
    localPathColl: 0,
    frameErrMax: 0,
    memMB: live.memoryBytes().total / 1e6,
    navNodes: nav.count,
    roomsVisited: visited.size,
    recoveries: rec,
  };
}

export function fmtSample(s: LargeAreaSample): string {
  const pc = (x: number) => (x * 100).toFixed(0).padStart(3) + '%';
  return `t ${s.t.toFixed(0).padStart(4)}s walked ${s.walked.toFixed(0).padStart(4)}m rooms ${String(s.roomsVisited).padStart(2)} | cover ${pc(s.coverage)} (all ${pc(s.coverageAll)}) prec ${pc(s.precision)} ghost ${s.ghostM2.toFixed(2).padStart(5)}m² falseFree ${pc(s.falseFree)} | frameErr ${(s.frameErr * 100).toFixed(0).padStart(3)}cm (max ${(s.frameErrMax * 100).toFixed(0).padStart(3)}) local paths coll ${pc(s.localPathColl)} prec ${pc(s.localPrecision)} (old ${pc(s.localPrecOld)} x${pc(s.localOldShare)}, new ${pc(s.localPrecRecent)}) ghost ${s.localGhostM2.toFixed(2)}m² | mem ${s.memMB.toFixed(0).padStart(3)}MB nodes ${s.navNodes} | ${s.recoveries}`;
}

export function fmtReport(r: LargeAreaReport): string {
  const pc = (x: number) => (x * 100).toFixed(1) + '%';
  const ms = (s: Stat) => `${s.mean.toFixed(2)}/${s.p95.toFixed(2)}/${s.max.toFixed(1)}ms`;
  const f = r.final;
  const lines = [
    `house ${r.house.width}x${r.house.depth}m, ${r.house.rooms} rooms, walkable ${r.house.walkableM2.toFixed(0)}m²; ${r.seconds}s, walked ${r.walked.toFixed(0)}m`,
    `final: coverage ${pc(f.coverage)} (whole home ${pc(f.coverageAll)}), precision ${pc(f.precision)}, ghost ${f.ghostM2.toFixed(2)}m², falseFree ${pc(f.falseFree)}, frameErr ${(f.frameErr * 100).toFixed(0)}cm (max ${(Math.max(...r.samples.map((s) => s.frameErrMax)) * 100).toFixed(0)}cm), paths colliding ${f.pathsColliding}/${f.pathsTested} (max pen ${(f.pathMaxPen * 100).toFixed(0)}cm)`,
    `local (around the player, through the current frame): precision ${pc(r.samples.slice(1).reduce((a, s) => a + s.localPrecision, 0) / Math.max(1, r.samples.length - 1))}, ghost ${(r.samples.slice(1).reduce((a, s) => a + s.localGhostM2, 0) / Math.max(1, r.samples.length - 1)).toFixed(2)}m² (session means)`,
    `retention: mean coverage drop ${pc(r.retention.coverageDrop)} (worst ${pc(r.retention.worstCoverageDrop)}), precision drop ${pc(r.retention.precisionDrop)}`,
    `memory: map ${f.memMB.toFixed(0)}MB, typed arrays ${r.arrayBuffersPeakMB.toFixed(0)}MB peak, heap ${r.heapMB.toFixed(0)}MB | cpu mean/p95/max: sense ${ms(r.cpu.sense)} game ${ms(r.cpu.game)} frame ${ms(r.cpu.frame)} (>16ms: ${r.cpu.frameOver16}) nav(worker) ${ms(r.cpu.nav)} x${r.cpu.nav.n}`,
    `events: losses ${r.events.trackingLosses}, tracker loop closures ${r.events.loopClosures}, depth frames ${r.events.depthFrames} (gated ${r.events.depthRejected}: ${JSON.stringify(r.events.gate)}), multi-view kept ${(r.events.mvKept / Math.max(1, r.events.mvKept + r.events.mvDropped) * 100).toFixed(0)}%, window moves ${r.events.recenters}, loops closed ${r.events.loopsClosed}, realigns ${r.events.realigns.map((q) => `${q.t.toFixed(0)}s ${(q.before * 100).toFixed(0)}→${(q.after * 100).toFixed(0)}cm`).join(' ')}, health ${JSON.stringify(r.events.health)}`,
  ];
  return lines.join('\n');
}

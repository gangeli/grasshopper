import * as THREE from 'three';
import { Rng } from '../core/rng';
import { Simulation, type SimOptions } from './Simulation';
import { SeekerBot } from './SeekerBot';
import { roomFromName } from './SimRoom';
import { dressRoom } from './Realism';
import { penetration } from './MapMetrics';
import { ALL_FAULTS, injectFault, type FaultKind } from './Faults';

/**
 * Long, continuous play with faults injected at random: the robustness
 * acceptance test. Measures whether the game ever gets stuck, how long the
 * pet spends inside real furniture, and whether the map ends up lined up
 * with reality.
 */
export interface SoakReport {
  room: string;
  seed: number;
  seconds: number;
  rounds: number;
  faults: { t: number; kind: FaultKind; what: string }[];
  recoveries: { t: number; issue: string; detail: string }[];
  /** Longest stretch with no round in progress or finishing while the bot wanted to play (s). */
  longestStall: number;
  /** Total time the pet's body was >4cm inside real furniture (s), and the longest such stretch. */
  insideTime: number;
  longestInside: number;
  /** Same, counting only while the pet was in the camera's view within 4m (what a player would notice). */
  insideVisibleTime: number;
  /** Frames where the pet's position was not a finite number. */
  nanFrames: number;
  /** How far the map frame is from reality at the end (m, near the room centre). */
  finalFrameError: number;
  finalFloorError: number;
  /** Share of mapped obstacle voxels (pet height band) that are real geometry, as the camera currently sees it. */
  mapPrecision: number;
  errors: string[];
  driftTrace: string[];
  /** Map precision sampled every 15s. */
  precisionTimeline: { t: number; p: number }[];
}

export function runSoak(room: string, seed: number, seconds: number, opts: Partial<SimOptions> & { faults?: FaultKind[]; faultEvery?: [number, number]; quietStart?: number } = {}): SoakReport {
  const rng = new Rng(seed * 101 + 7);
  const sim = new Simulation({ seed, noise: 'real', ...opts, room: dressRoom(roomFromName(room), seed) });
  const bot = new SeekerBot(sim);
  bot.continuous = true;
  bot.timeout = 120;
  const rep: SoakReport = { room, seed, seconds, rounds: 0, faults: [], recoveries: [], longestStall: 0, insideTime: 0, longestInside: 0, insideVisibleTime: 0, nanFrames: 0, finalFrameError: 0, finalFloorError: 0, mapPrecision: 0, errors: [], driftTrace: [], precisionTimeline: [] };
  const kinds = opts.faults ?? ALL_FAULTS;
  const [fMin, fMax] = opts.faultEvery ?? [25, 45];
  let nextFault = (opts.quietStart ?? 45) + rng.range(0, 10);
  let lastActive = 0, inside = 0;
  const dt = 1 / 30;
  const p = new THREE.Vector3();
  while (sim.time < seconds) {
    try {
      bot.step(dt);
    } catch (e) {
      rep.errors.push(`${sim.time.toFixed(1)}s ${String(e)}`);
      if (rep.errors.length > 5) break;
    }
    if (sim.time >= nextFault && kinds.length) {
      const kind = rng.pick(kinds);
      rep.faults.push({ t: sim.time, kind, what: injectFault(sim, kind, rng) });
      nextFault = sim.time + rng.range(fMin, fMax);
    }
    // Stalls: the bot is ready to play (or searching) but no round is going anywhere.
    const g = sim.game.phase;
    if (g === 'countdown' || g === 'found' || bot.phase === 'mapping') lastActive = sim.time;
    if (g === 'seek' && bot.phase === 'searching') lastActive = Math.max(lastActive, sim.time - 0); // searching is progress until the watchdog
    rep.longestStall = Math.max(rep.longestStall, sim.time - lastActive);
    if (!Number.isFinite(sim.pet.pos.x + sim.pet.pos.y + sim.pet.pos.z)) rep.nanFrames++;
    if (process.env.SOAK_FLOOR && sim.time > Number(process.env.SOAK_FLOOR) && Math.floor(sim.time / 3) !== Math.floor((sim.time - dt) / 3)) {
      const f = sim.world.floorEvidence(), pl = sim.world.floorPlaneEstimate();
      if (process.env.SOAK_HIST) console.log('hist', Array.from((sim.world as any).floorWatch as Float32Array).map((v, i) => `${i - 25}:${v.toFixed(0)}`).filter((x) => !x.endsWith(':0')).join(' '));
      console.log(`${sim.time.toFixed(0)}s floorY ${(sim.world.floorY * 100).toFixed(1)} evidence ${(f.offset * 100).toFixed(1)} kmode ${(f.kernelMode * 100).toFixed(0)} gain ${f.kernelGain.toFixed(2)} median ${(f.median * 100).toFixed(1)} below ${(f.below * 100).toFixed(0)} above ${(f.above * 100).toFixed(0)} share ${(f.share * 100).toFixed(0)} mass ${f.mass.toFixed(0)} plane ${pl ? (pl.y * 100).toFixed(1) : '-'} phase ${sim.game.phase} bot ${bot.phase}`);
    }
    if (Math.floor(sim.time / 15) !== Math.floor((sim.time - dt) / 15)) rep.precisionTimeline.push({ t: sim.time, p: mapPrecision(sim) });
    // The pet's body against the real room (after any frame correction, the map
    // frame should match reality, so compare in the map frame).
    sim.rig.group.updateMatrixWorld(true);
    let pen = 0;
    const toReal = realFromMap(sim);
    for (const b of ['hips', 'chest'] as const) {
      sim.rig.bones[b].getWorldPosition(p);
      if (Number.isFinite(p.x)) pen = Math.max(pen, penetration(sim.room, p.applyMatrix4(toReal)));
    }
    if (pen > 0.04) {
      // In view? (frustum and distance, from the true camera to the pet's real position)
      sim.rig.bones.chest.getWorldPosition(p);
      p.applyMatrix4(toReal);
      const v = sim.view();
      const dx = p.x - v.pos.x, dy = p.y - v.pos.y, dz = p.z - v.pos.z, d = Math.hypot(dx, dy, dz);
      if (d < 4 && (dx * v.forward.x + dy * v.forward.y + dz * v.forward.z) / d > Math.cos(0.6)) rep.insideVisibleTime += dt;
      rep.insideTime += dt;
      if (process.env.SOAK_DEBUG && Math.floor(inside) !== Math.floor(inside + dt)) {
        const g = sim.world.grid!, pp = sim.pet.pos;
        let occ = 0, sh = 0, free = 0;
        for (const h of [0.08, 0.13, 0.18]) {
          const i = g.cellX(pp.x), j = g.cellY(pp.y + h), k = g.cellZ(pp.z);
          const v = g.data[g.idx(i, j, k)];
          if (v > 35) occ++;
          else if (g.shadowAt(i, j, k)) sh++;
          else if (v < 0) free++;
        }
        console.log(`${sim.time.toFixed(0)}s INSIDE pen ${(pen * 100).toFixed(0)}cm phase ${sim.game.phase} pet ${sim.pet.state} map(${pp.x.toFixed(2)},${pp.y.toFixed(2)},${pp.z.toFixed(2)}) real(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) body voxels occ ${occ} shadow ${sh} free ${free} piece ${sim.room.pieceAt(p)?.label}`);
      }
      inside += dt;
      rep.longestInside = Math.max(rep.longestInside, inside);
    } else inside = 0;
  }
  rep.rounds = bot.rounds + (bot.phase === 'done' ? 1 : 0);
  rep.recoveries = sim.game.health.log.slice();
  rep.driftTrace = sim.game.health.drift.trace.slice();
  // Final frame error: where the map puts real points vs where they are.
  const M = sim.world.trackingToMap(), J = sim.sensor.jump;
  let worst = 0;
  for (const q of [{ x: 0, y: 0.5, z: 0 }, { x: 1.5, y: 0.5, z: 0 }, { x: 0, y: 0.5, z: 1.5 }, { x: -1.5, y: 0.5, z: -1.5 }]) {
    const rx = J[0] * q.x + J[4] * q.y + J[8] * q.z + J[12], ry = J[1] * q.x + J[5] * q.y + J[9] * q.z + J[13], rz = J[2] * q.x + J[6] * q.y + J[10] * q.z + J[14];
    const mx = M[0] * rx + M[4] * ry + M[8] * rz + M[12], mz = M[2] * rx + M[6] * ry + M[10] * rz + M[14];
    worst = Math.max(worst, Math.hypot(mx - q.x, mz - q.z));
  }
  rep.finalFrameError = worst;
  rep.finalFloorError = Math.abs(sim.world.floorY);
  rep.mapPrecision = mapPrecision(sim);
  return rep;
}

/**
 * Does the map describe the room as the camera now sees it? Share of mapped
 * obstacle voxels (pet height band) that are real geometry when taken to
 * reality through the current frame chain.
 */
function mapPrecision(sim: Simulation): number {
  const g = sim.world.grid;
  if (!g) return 1;
  const toReal = realFromMap(sim);
  let occ = 0, good = 0;
  const q = new THREE.Vector3();
  for (let j = sim.world.floorLayer + 1; j < sim.world.floorLayer + 12; j++)
    for (let k = 0; k < g.nz; k += 2)
      for (let i = 0; i < g.nx; i += 2) {
        if (!g.occ(i, j, k)) continue;
        occ++;
        q.set(g.centerX(i), g.centerY(j), g.centerZ(k)).applyMatrix4(toReal);
        if (sim.room.solidAt(q, 0.08)) good++;
      }
  return occ ? good / occ : 1;
}

/** Map frame → where it really is: tracking frame (inverse correction) → reality (inverse injected jump). */
function realFromMap(sim: Simulation): THREE.Matrix4 {
  const m2t = new THREE.Matrix4().fromArray(sim.world.mapToTracking());
  const J = new THREE.Matrix4().fromArray(sim.sensor.jump);
  return J.invert().multiply(m2t);
}

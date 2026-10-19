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
    if (process.env.SOAK_EST && Math.abs(sim.time - Number(process.env.SOAK_EST)) < dt / 2) {
      const toReal = realFromMap(sim), g = sim.world.grid!;
      sim.world.debugScore = (score, pts, data) => {
        sim.world.debugScore = null;
        console.log('score profile dz=0.09 yaw=0.037:', [-0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.52].map((x) => `${x}:${score(x, 0.09, 0.037).toFixed(0)}`).join(' '));
        console.log('score profile dz=0 yaw=0, dx:', [-0.1, 0, 0.1].map((x) => `${x}:${score(x, 0, 0).toFixed(0)}`).join(' '), 'dz:', [-0.1, -0.05, 0.05, 0.1].map((z) => `${z}:${score(0, z, 0).toFixed(0)}`).join(' '));
        const where: Record<string, number> = {};
        const q = new THREE.Vector3();
        for (let i = 0; i < pts.length; i += 3) {
          q.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(toReal);
          const v = data[g.idx(g.cellX(pts[i]), g.cellY(pts[i + 1]), g.cellZ(pts[i + 2]))];
          const k = `${sim.room.pieceAt(q)?.label ?? (sim.room.solidAt(q, 0.05) ? 'wall' : 'air')}/${v > 45 ? 'S' : v > 20 ? 'o' : v < -20 ? 'F' : v < 0 ? 'f' : v === 0 ? 'u' : 'w'} x${(Math.round(q.x * 2) / 2).toFixed(1)} z${(Math.round(q.z * 2) / 2).toFixed(1)}`;
          where[k] = (where[k] ?? 0) + 1;
        }
        console.log('points (real piece / snapshot class / real x,z):', Object.entries(where).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `${k}: ${v}`).join(' | '));
        const sh: Record<string, number> = {};
        const c = Math.cos(0.037), sn = Math.sin(0.037);
        for (let i = 0; i < pts.length; i += 3) {
          const piv = sim.cam.pos; // approx
          const rx = pts[i] - piv.x, rz = pts[i + 2] - piv.z;
          const x = piv.x + c * rx + sn * rz + 0.52, z = piv.z - sn * rx + c * rz + 0.09;
          q.set(x, pts[i + 1], z).applyMatrix4(toReal);
          const v = data[g.idx(g.cellX(x), g.cellY(pts[i + 1]), g.cellZ(z))];
          const k = `${sim.room.pieceAt(q)?.label ?? (sim.room.solidAt(q, 0.05) ? 'wall' : 'air')}/${v > 45 ? 'S' : v > 20 ? 'o' : v < -20 ? 'F' : v < 0 ? 'f' : v === 0 ? 'u' : 'w'}`;
          sh[k] = (sh[k] ?? 0) + 1;
        }
        console.log('shifted by best:', Object.entries(sh).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}: ${v}`).join(' | '));
      };
    }
    if (process.env.SOAK_WATCH && Math.floor(sim.time) !== Math.floor(sim.time - dt) && sim.world.grid) {
      const [x, y, z] = process.env.SOAK_WATCH.split(',').map(Number), g = sim.world.grid;
      const vals = [-1, 0, 1].map((d) => g.data[g.idx(g.cellX(x), g.cellY(y), g.cellZ(z + d * g.res))]);
      console.log(`${sim.time.toFixed(0)}s WATCH ${vals.join(' ')} cam (${sim.cam.pos.x.toFixed(2)},${sim.cam.pos.y.toFixed(2)},${sim.cam.pos.z.toFixed(2)}) yaw ${sim.cam.yaw.toFixed(2)} pitch ${sim.cam.pitch.toFixed(2)} epoch ${sim.world.epoch} bot ${bot.phase}`);
    }
    if (process.env.SOAK_FRAME && sim.time > Number(process.env.SOAK_FRAME) && Math.floor(sim.time) !== Math.floor(sim.time - dt)) {
      const se = (sim.sensor as any).smoothErr, w = sim.world, M = w.trackingToMap();
      console.log(`${sim.time.toFixed(0)}s track err (${(se.x * 100).toFixed(0)},${(se.z * 100).toFixed(0)})cm yaw ${((se.yaw * 180) / Math.PI).toFixed(1)}° jump (${(sim.sensor.jump[12] * 100).toFixed(0)},${(sim.sensor.jump[14] * 100).toFixed(0)}) map corr (${(M[12] * 100).toFixed(0)},${(M[14] * 100).toFixed(0)}) lost ${sim.sensor.trackingLost} lastEvent ${w.lastTrackingEvent.toFixed(1)} snap ${w.eventSnapshot?.t.toFixed(1)} epoch ${w.epoch}`);
    }
    if (process.env.SOAK_ALIGN && sim.time > Number(process.env.SOAK_ALIGN) && Math.floor(sim.time) !== Math.floor(sim.time - dt)) {
      const toReal = realFromMap(sim), rep_ = (sim.world as any).replay.slice(-10), q = new THREE.Vector3();
      let n = 0, ok = 0, okSnap = 0;
      const hist: Record<string, number> = {};
      const ev = sim.world.eventSnapshot, g = sim.world.grid!;
      for (const f of rep_)
        for (let i = 0; i < f.pts.length; i += 3) {
          if (f.pts[i + 1] < sim.world.floorY + 0.06) continue;
          n++;
          q.set(f.pts[i], f.pts[i + 1], f.pts[i + 2]).applyMatrix4(toReal);
          if (sim.room.solidAt(q, 0.05)) ok++;
          if (ev && ev.data[g.idx(g.cellX(f.pts[i]), g.cellY(f.pts[i + 1]), g.cellZ(f.pts[i + 2]))] > 45) okSnap++;
          if (process.env.SOAK_ALIGN_V && ev && ev.data[g.idx(g.cellX(f.pts[i]), g.cellY(f.pts[i + 1]), g.cellZ(f.pts[i + 2]))] < 0 && Math.random() < 0.003) console.log(`    free-in-snapshot wall voxel map (${f.pts[i].toFixed(2)},${f.pts[i + 1].toFixed(2)},${f.pts[i + 2].toFixed(2)})`);
          if (ev && process.env.SOAK_ALIGN_V) {
            const v = ev.data[g.idx(g.cellX(f.pts[i]), g.cellY(f.pts[i + 1]), g.cellZ(f.pts[i + 2]))], lv = g.data[g.idx(g.cellX(f.pts[i]), g.cellY(f.pts[i + 1]), g.cellZ(f.pts[i + 2]))];
            const key = `${v === 0 ? 'unk' : v < 0 ? 'free' : v > 45 ? 'strong' : 'weak'}/${lv === 0 ? 'unk' : lv < 0 ? 'free' : lv > 45 ? 'strong' : 'weak'}:${sim.room.pieceAt(q)?.label ?? (sim.room.solidAt(q, 0.05) ? 'wall' : '-')}`;
            hist[key] = (hist[key] ?? 0) + 1;
          }
        }
      console.log(`${sim.time.toFixed(0)}s recent pts ${n} on real geometry ${((ok / Math.max(1, n)) * 100).toFixed(0)}% on snapshot occ ${((okSnap / Math.max(1, n)) * 100).toFixed(0)}% cam (${sim.cam.pos.x.toFixed(2)},${sim.cam.pos.z.toFixed(2)}) bot ${bot.phase}`);
      if (process.env.SOAK_ALIGN_V) console.log('   ', Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' | '));
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

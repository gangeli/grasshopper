import * as THREE from 'three';
import { Simulation, type SimOptions } from './Simulation';
import { SeekerBot } from './SeekerBot';
import type { FoundInfo } from '../game/HideAndSeek';

export interface RoundReport {
  room: string;
  seed: number;
  started: boolean;
  spotKind: string | null;
  spotWhere: string | null;
  /** Ground-truth visibility of the pet from the seeker when seeking began. */
  truthVisAtSeek: number;
  /** Distance between the pet and its chosen spot when seeking began. */
  petToSpot: number;
  found: FoundInfo | null;
  truthVisAtFound: number;
  /** Max penetration of the pet's body into real furniture during the round (m). */
  maxPenetration: number;
  jumps: number;
  simSeconds: number;
  planMs: number;
  messages: string[];
}

/** Play one full automated round: map, start, hide, seek, find. */
export function runRound(room: string, seed: number, opts: Partial<SimOptions> = {}): RoundReport {
  const sim = new Simulation({ room, seed, ...opts });
  const bot = new SeekerBot(sim);
  const r: RoundReport = {
    room,
    seed,
    started: false,
    spotKind: null,
    spotWhere: null,
    truthVisAtSeek: -1,
    petToSpot: -1,
    found: null,
    truthVisAtFound: -1,
    maxPenetration: 0,
    jumps: 0,
    simSeconds: 0,
    planMs: 0,
    messages: [],
  };
  sim.game.events.onMessage = (m) => r.messages.push(m);
  sim.game.events.onPhase = (p) => {
    if (p === 'countdown') {
      r.started = true;
      r.spotKind = sim.game.spot?.kind ?? null;
      r.planMs = sim.game.stats.planMs;
    }
    if (p === 'seek') {
      r.truthVisAtSeek = sim.truthVisibility();
      const s = sim.game.spot;
      r.petToSpot = s ? Math.hypot(s.pos.x - sim.pet.pos.x, s.pos.z - sim.pet.pos.z) : -1;
    }
  };
  sim.game.events.onFound = (info) => {
    r.found = info;
    r.spotWhere = info.where;
    r.truthVisAtFound = sim.truthVisibility();
  };
  const dt = 1 / 30;
  const p = new THREE.Vector3();
  while (bot.phase !== 'done' && sim.time < 260) {
    bot.step(dt);
    // Body penetration check against the real room (hips & chest).
    sim.rig.group.updateMatrixWorld(true);
    for (const b of ['hips', 'chest'] as const) {
      sim.rig.bones[b].getWorldPosition(p);
      r.maxPenetration = Math.max(r.maxPenetration, penetration(sim, p));
    }
  }
  r.jumps = sim.pet.jumpsMade;
  r.simSeconds = sim.time;
  return r;
}

/** How deep a point is inside the nearest thick solid box (0 if outside). */
function penetration(sim: Simulation, p: THREE.Vector3): number {
  let worst = 0;
  for (const b of sim.room.boxes) {
    if (Math.min(b.max.x - b.min.x, b.max.z - b.min.z) < 0.1) continue; // thin legs: below sensing resolution
    const d = Math.min(p.x - b.min.x, b.max.x - p.x, p.y - b.min.y, b.max.y - p.y, p.z - b.min.z, b.max.z - p.z);
    if (d > worst) worst = d;
  }
  return worst;
}

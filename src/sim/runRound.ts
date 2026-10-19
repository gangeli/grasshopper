import * as THREE from 'three';
import { Simulation, type SimOptions } from './Simulation';
import { roomFromName } from './SimRoom';
import { dressRoom } from './Realism';
import { penetration as truthPenetration } from './MapMetrics';
import { SeekerBot } from './SeekerBot';
import type { FoundInfo } from '../game/HideAndSeek';

export interface RoundReport {
  room: string;
  seed: number;
  started: boolean;
  spotKind: string | null;
  spotWhere: string | null;
  /** The game had to relax its hiding criteria (bare room). */
  relaxed: boolean;
  /** Ground-truth visibility of the pet from the seeker when seeking began. */
  truthVisAtSeek: number;
  /** Same, for the core body only (head, neck, chest, hips). */
  truthCoreVisAtSeek: number;
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
export function runRound(room: string, seed: number, opts: Partial<SimOptions> & { dress?: boolean } = {}): RoundReport {
  const simRoom = opts.dress ? dressRoom(roomFromName(room), seed) : roomFromName(room);
  const sim = new Simulation({ seed, ...opts, room: simRoom });
  const bot = new SeekerBot(sim);
  const r: RoundReport = {
    room,
    seed,
    started: false,
    spotKind: null,
    spotWhere: null,
    relaxed: false,
    truthVisAtSeek: -1,
    truthCoreVisAtSeek: -1,
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
      r.relaxed = sim.game.stats.relaxed;
    }
    if (p === 'seek') {
      r.truthVisAtSeek = sim.truthVisibility();
      r.truthCoreVisAtSeek = sim.truthVisibility(true);
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

/** How deep a point is inside real furniture (incl. toys and legs; not rugs/cables). */
function penetration(sim: Simulation, p: THREE.Vector3): number {
  return truthPenetration(sim.room, p);
}

import * as THREE from 'three';
import type { Rng } from '../core/rng';
import type { Simulation } from './Simulation';

/**
 * Fault injection for robustness tests: the things that go wrong on real
 * devices (and a few that "can't happen"), applied to a running simulation.
 */
export type FaultKind = 'jump' | 'silentJump' | 'floorLow' | 'floorHigh' | 'covered' | 'nanView' | 'petInside' | 'petFloat' | 'petNaN' | 'mapWipe';
export const ALL_FAULTS: FaultKind[] = ['jump', 'silentJump', 'floorLow', 'floorHigh', 'covered', 'nanView', 'petInside', 'petFloat', 'petNaN', 'mapWipe'];

export function injectFault(sim: Simulation, kind: FaultKind, rng: Rng): string {
  const w = sim.world, pet = sim.pet;
  const sign = () => (rng.chance(0.5) ? 1 : -1);
  switch (kind) {
    case 'jump': {
      // Tracking lost and relocalised with a big error (the device reports the loss).
      const dx = sign() * rng.range(0.15, 0.35), dz = sign() * rng.range(0.1, 0.3), dyaw = sign() * rng.range(0.02, 0.07);
      sim.sensor.injectPoseJump(dx, dz, dyaw);
      w.noteTrackingEvent(sim.room.time);
      return `tracking jump ${(Math.hypot(dx, dz) * 100).toFixed(0)}cm ${((dyaw * 180) / Math.PI).toFixed(1)}°`;
    }
    case 'silentJump': {
      // A loop-closure style correction with no tracking loss: drift-sized.
      const dx = sign() * rng.range(0.06, 0.15), dz = sign() * rng.range(0.04, 0.12);
      sim.sensor.injectPoseJump(dx, dz, sign() * rng.range(0.005, 0.02));
      return `silent jump ${(Math.hypot(dx, dz) * 100).toFixed(0)}cm`;
    }
    case 'floorLow':
    case 'floorHigh': {
      // The floor estimate goes wrong (e.g. re-placed on a rug or low table).
      const d = (kind === 'floorLow' ? -1 : 1) * rng.range(0.05, 0.1);
      w.relevelFloor(w.floorY + d);
      sim.game.mapChanged();
      return `floor shifted ${(d * 100).toFixed(1)}cm`;
    }
    case 'covered':
      sim.faults.coveredUntil = sim.time + rng.range(2, 5);
      return 'camera covered';
    case 'nanView':
      sim.faults.nanViewUntil = sim.time + rng.range(0.3, 1.5);
      return 'NaN camera pose';
    case 'petInside': {
      // Drop the pet inside the nearest piece of furniture (a drift artefact).
      let best: { x: number; z: number; d: number } | null = null;
      for (const b of sim.room.boxes) {
        if (sim.room.pieces[b.piece].label === 'wall' || b.max.y < 0.25 || b.min.y > 0.05) continue;
        const c = { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2 };
        const d = Math.hypot(c.x - pet.pos.x, c.z - pet.pos.z);
        if (!best || d < best.d) best = { ...c, d };
      }
      if (!best) return 'no furniture to drop the pet into';
      pet.placeAt(new THREE.Vector3(best.x, w.floorY, best.z));
      return `pet dropped inside furniture at (${best.x.toFixed(2)}, ${best.z.toFixed(2)})`;
    }
    case 'petFloat':
      pet.placeAt(pet.pos.clone().add(new THREE.Vector3(0, rng.range(0.3, 0.8), 0)));
      return 'pet floating';
    case 'petNaN':
      pet.pos.set(NaN, NaN, NaN);
      return 'pet NaN';
    case 'mapWipe':
      w.hardReset();
      sim.game.mapChanged();
      return 'map wiped';
  }
}

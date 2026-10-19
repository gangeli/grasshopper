import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { Rng } from '../src/core/rng';
import { injectFault } from '../src/sim/Faults';
for (const [room, seed, kind] of [['r37', 8, 'floorLow'], ['living', 4, 'floorHigh'], ['r19', 11, 'floorHigh']] as const) {
  const sim = new Simulation({ seed, noise: 'real', room: dressRoom(roomFromName(room), seed) });
  const bot = new SeekerBot(sim);
  bot.continuous = true;
  while (sim.time < 45) bot.step(1 / 30);
  injectFault(sim, kind, new Rng(seed));
  const t0 = sim.time;
  let fixedAt = -1, last = -1;
  while (sim.time < t0 + 90) {
    bot.step(1 / 30);
    if (fixedAt < 0 && Math.abs(sim.world.floorY) < 0.03) fixedAt = sim.time - t0;
    if (Math.floor(sim.time / 5) !== last) {
      last = Math.floor(sim.time / 5);
      const f = sim.world.floorEvidence(), pl = sim.world.floorPlaneEstimate();
      console.log(room, (sim.time - t0).toFixed(0), 'floorY', sim.world.floorY.toFixed(3), 'evidence', (f.offset * 100).toFixed(1), 'share', (f.share * 100).toFixed(0), 'mass', f.mass.toFixed(0), 'plane', pl ? pl.y.toFixed(3) + '/' + pl.area.toFixed(1) : '-', 'bot', bot.phase);
    }
  }
  console.log(room, kind, 'fixed after', fixedAt.toFixed(1), 's', JSON.stringify(sim.game.health.log.filter((l) => l.t > t0 - 1)));
}

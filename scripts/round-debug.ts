import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { petSamplePoints, petVisibility } from '../src/game/Visibility';
const sim = new Simulation({ room: process.argv[2] ?? 'living', seed: Number(process.argv[3] ?? 1) });
const bot = new SeekerBot(sim);
bot.timeout = 60;
let best = 0, bestAt = '';
let bestNoFrustum = 0, bestNF = '';
const dt = 1 / 30;
while (bot.phase !== 'done' && sim.time < 120) {
  bot.step(dt);
  if (bot.phase === 'searching') {
    const v = sim.game.visibility;
    if (v > best) { best = v; bestAt = `${sim.cam.pos.x.toFixed(2)},${sim.cam.pos.y.toFixed(2)},${sim.cam.pos.z.toFixed(2)}`; }
    // Ignore the frustum: is the pet visible at all from here?
    const view = sim.view();
    const pts = petSamplePoints(sim.rig);
    const nf = petVisibility(sim.world.grid!, { ...view, fovY: 3.0, aspect: 1 }, pts, 10, 50);
    if (nf > bestNoFrustum) { bestNoFrustum = nf; bestNF = `${sim.cam.pos.x.toFixed(2)},${sim.cam.pos.y.toFixed(2)},${sim.cam.pos.z.toFixed(2)} truth ${sim.truthVisibility().toFixed(2)}`; }
  }
}
console.log('spot', sim.game.spot?.kind, sim.game.spot?.pos, 'cov', sim.game.spot?.coverage);
console.log('best vis', best.toFixed(2), bestAt, ' best ignoring frustum', bestNoFrustum.toFixed(2), bestNF);
console.log('tour', JSON.stringify((bot as any).tour));

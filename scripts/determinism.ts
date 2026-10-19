/**
 * Fingerprint of complete automated rounds (map hash, nav graph hash, spot,
 * outcome, timings in sim time). Performance work must leave it unchanged:
 *   npx tsx scripts/determinism.ts > before.txt   (on the base commit)
 *   npx tsx scripts/determinism.ts > after.txt && diff before.txt after.txt
 */
import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';

function hash(a: ArrayLike<number>): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ ((a[i] * 1000) | 0), 16777619) >>> 0;
  return h.toString(16);
}

const cases: [string, number, string][] = [
  ['living', 3, 'arcore'],
  ['bedroom', 5, 'real'],
  ['living', 8, 'ideal'],
];
for (const [room, seed, noise] of cases) {
  const sim = new Simulation({ seed, noise: noise as 'arcore', room: dressRoom(roomFromName(room), seed) });
  const bot = new SeekerBot(sim);
  const lines: string[] = [];
  let f = 0;
  while (bot.phase !== 'done' && sim.time < 200) {
    bot.step(1 / 30);
    if (++f % 150 === 0) {
      const g = sim.world.grid!, nav = sim.game.nav;
      lines.push(`t=${sim.time.toFixed(2)} v=${g.version} grid=${hash(g.data)} obs=${hash(g.observed)} top=${hash(g.topFrac)} nav=${nav ? `${nav.count}:${hash(nav.ny)}:${hash(nav.ni)}:${hash(nav.wallDist)}` : '-'} pet=${sim.pet.pos.x.toFixed(4)},${sim.pet.pos.z.toFixed(4)} ${sim.game.phase}`);
    }
  }
  console.log(`== ${room} seed ${seed} ${noise}: ${bot.phase} at ${sim.time.toFixed(2)} spot=${sim.game.spot?.kind} ${JSON.stringify(sim.game.spot?.pos)}`);
  console.log(lines.join('\n'));
}

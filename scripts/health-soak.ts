import { runRound } from '../src/sim/runRound';
// Healthy-session check: play rounds with no injected faults and list every
// recovery the health monitor takes (ideally none). Usage: health-soak.ts <rooms> <seeds> <noise>
const rooms = (process.argv[2] ?? 'living,bedroom,r7').split(',');
const seeds = (process.argv[3] ?? '1,2').split(',').map(Number);
const noise = (process.argv[4] ?? 'real') as 'real';
let rounds = 0, issues = 0;
for (const room of rooms)
  for (const seed of seeds) {
    const r = runRound(room, seed, { dress: noise === 'real', noise });
    rounds++;
    issues += r.health.length;
    console.log(`${room} s${seed} ${noise}: found ${!!r.found} revealed ${r.found?.revealed ?? '-'} pen ${(r.maxPenetration * 100).toFixed(1)}cm ${r.simSeconds.toFixed(0)}s floor ${(r.floorStart * 100).toFixed(1)}→${(r.floorEnd * 100).toFixed(1)}cm | ${r.health.map((h) => `${h.t.toFixed(0)}s ${h.issue}: ${h.detail}`).join(' | ') || 'no recoveries'}`);
  }
console.log(`TOTAL ${rounds} rounds, ${issues} recoveries`);

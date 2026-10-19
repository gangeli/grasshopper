import { runRound } from '../src/sim/runRound';
// Stress sweep over many random rooms: npx tsx scripts/sweep.ts [count] [startSeed]
const n = Number(process.argv[2] ?? 20), s0 = Number(process.argv[3] ?? 100);
let found = 0, issues = 0;
for (let i = 0; i < n; i++) {
  const r = runRound(`r${s0 + i}`, i + 1);
  const bad: string[] = [];
  if (!r.started) bad.push('not started');
  if (r.truthVisAtSeek > 0.25) bad.push(`visible at seek ${r.truthVisAtSeek}`);
  if (r.petToSpot > 0.15) bad.push(`missed spot ${r.petToSpot.toFixed(2)}`);
  if (r.maxPenetration >= 0.06) bad.push(`penetration ${r.maxPenetration.toFixed(2)}`);
  if (r.found && !r.found.revealed && r.truthVisAtFound <= 0.2) bad.push(`found while hidden ${r.truthVisAtFound}`);
  if (r.found && !r.found.revealed) found++;
  if (bad.length) issues++;
  console.log(`r${s0 + i}: ${r.spotKind} ${r.found ? (r.found.revealed ? 'revealed' : 'found') : 'unfinished'} ${r.found?.seconds}s jumps ${r.jumps} plan ${r.planMs | 0}ms ${bad.join('; ')}`);
}
console.log(`found ${found}/${n}, rounds with issues ${issues}`);

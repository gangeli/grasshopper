import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
// Run scripts/la-hide.ts over several homes in parallel and sum the policies.
// Usage: npx tsx scripts/la-hide-batch.ts <outdir> [parallel=4] [homes=10]   (env POLICIES, WORLD, NOISE, PROFILE, SECONDS, EVERY)
const out = process.argv[2] ?? '/tmp/la-hide';
const par = Number(process.argv[3] ?? 4);
const nh = Number(process.argv[4] ?? 10);
mkdirSync(out, { recursive: true });
const HOMES: [string, number][] = [['10x12', 1], ['12x15', 2], ['15x20', 3], ['8x12', 4], ['10x12', 5], ['14x16', 6], ['12x12', 7], ['11x14', 8], ['9x13', 9], ['13x15', 10], ['10x10', 11], ['12x16', 12]].slice(0, nh) as [string, number][];
let next = 0, active = 0;
await new Promise<void>((done) => {
  const launch = () => {
    while (active < par && next < HOMES.length) {
      const [h, s] = HOMES[next++];
      const p = spawn('npx', ['tsx', 'scripts/la-hide.ts', h, String(s), process.env.SECONDS ?? '600', process.env.PROFILE ?? 'house-hard'], { env: { ...process.env, JSON: `${out}/${h}s${s}.json` }, stdio: 'ignore' });
      active++;
      p.on('close', () => {
        active--;
        if (next >= HOMES.length && active === 0) done();
        else launch();
      });
    }
  };
  launch();
});
const tot: Record<string, { rounds: number; none: number; spots: number; bad: number; perHome: number[] }> = {};
for (const [h, s] of HOMES) {
  let r: Record<string, { rounds: number; none: number; spots: number; bad: number }>;
  try {
    r = JSON.parse(readFileSync(`${out}/${h}s${s}.json`, 'utf8'));
  } catch {
    console.log(`(no result for ${h}s${s})`);
    continue;
  }
  for (const [k, v] of Object.entries(r)) {
    const t = (tot[k] ??= { rounds: 0, none: 0, spots: 0, bad: 0, perHome: [] });
    t.rounds += v.rounds;
    t.none += v.none;
    t.spots += v.spots;
    t.bad += v.bad;
    t.perHome.push(v.spots ? v.bad / v.spots : 0);
  }
}
console.log('| policy | rounds | no spot % | spots | inside furniture % | homes with any |');
console.log('|---|---|---|---|---|---|');
for (const [k, t] of Object.entries(tot)) console.log(`| ${k} | ${t.rounds} | ${((t.none / Math.max(1, t.rounds)) * 100).toFixed(1)} | ${t.spots} | ${((t.bad / Math.max(1, t.spots)) * 100).toFixed(1)} | ${t.perHome.filter((x) => x > 0).length}/${t.perHome.length} |`);

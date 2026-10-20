import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// Run several large-area benchmark variants in parallel and print a comparison table.
// Usage: npx tsx scripts/large-area-batch.ts <spec.json> [outdir] [parallel=4]
// spec: [{ "name": "ideal", "house": "15x20", "seed": 3, "seconds": 240, "profile": "house", "env": { "NOISE": "{...}" } }, ...]
// A spec may also be { "suite": true, "env": {...}, "name": "x", "scale": 1 } to expand to the standard three homes.
type Run = { name: string; house?: string; seed?: number; seconds?: number; profile?: string; env?: Record<string, string> };
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8')) as (Run & { suite?: boolean; quick?: boolean; scale?: number })[];
const out = process.argv[3] ?? '/tmp/large-area-batch';
const par = Number(process.argv[4] ?? 4);
mkdirSync(out, { recursive: true });
const SUITE: [string, number, number][] = [['10x12', 1, 600], ['12x15', 2, 600], ['15x20', 3, 900]];
// "quick": six homes, five minutes each.
const QUICK: [string, number, number][] = [['10x12', 1, 300], ['12x15', 2, 300], ['15x20', 3, 300], ['8x12', 4, 300], ['10x12', 5, 300], ['14x16', 6, 300]];
const runs: Run[] = [];
for (const s of spec) {
  if (s.quick) QUICK.forEach(([h, seed, secs]) => runs.push({ ...s, name: `${s.name}:${h}s${seed}`, house: h, seed, seconds: Math.round(secs * (s.scale ?? 1)) }));
  else if (s.suite) SUITE.forEach(([h, seed, secs]) => runs.push({ ...s, name: `${s.name}:${h}`, house: h, seed, seconds: Math.round(secs * (s.scale ?? 1)) }));
  else runs.push(s);
}
const results: { name: string; json: string; ok: boolean }[] = [];
let next = 0;
const t0 = Date.now();
await new Promise<void>((done) => {
  let active = 0;
  const launch = () => {
    while (active < par && next < runs.length) {
      const r = runs[next++];
      const file = `${out}/${r.name.replace(/[^a-z0-9_.-]+/gi, '_')}`;
      const env = { ...process.env, QUIET: '1', JSON: `${file}.json`, PNG: `${file}.png`, ...(r.env ?? {}) };
      const p = spawn('npx', ['tsx', 'scripts/large-area.ts', r.house ?? '10x12', String(r.seed ?? 1), String(r.seconds ?? 300), r.profile ?? 'house'], { env });
      let log = '';
      p.stdout.on('data', (d) => (log += d));
      p.stderr.on('data', (d) => (log += d));
      active++;
      p.on('close', (code) => {
        writeFileSync(`${file}.txt`, log);
        results.push({ name: r.name, json: `${file}.json`, ok: code === 0 });
        if (code !== 0) console.log(`!! ${r.name} failed:\n${log.slice(-2000)}`);
        active--;
        if (next >= runs.length && active === 0) done();
        else launch();
      });
    }
  };
  launch();
});
const order = new Map(runs.map((r, i) => [r.name, i]));
results.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
const hdr = ['run', 'cover%', 'prec%', 'locPrc', 'locGh', 'locPC%', 'ghost', 'fFree%', 'fErr', 'fErrMx', 'retDrp', 'worst', 'pathC%', 'memMB', 'cpu', 'p95', 'max', 'resets'];
console.log(hdr.map((h, i) => (i ? h.padStart(7) : h.padEnd(22))).join(' '));
const agg = new Map<string, number[][]>();
for (const r of results) {
  if (!r.ok) continue;
  const j = JSON.parse(readFileSync(r.json, 'utf8'));
  const f = j.final;
  const feMax = Math.max(...j.samples.map((s: { frameErrMax: number }) => s.frameErrMax));
  const resets = (j.events.health.mapReset ?? 0) + (j.events.health.mapContradictory ?? 0);
  const ss = j.samples.filter((x: { t: number }) => x.t > 0);
  const locP = ss.reduce((a: number, x: { localPrecision: number }) => a + x.localPrecision, 0) / Math.max(1, ss.length);
  const locG = ss.reduce((a: number, x: { localGhostM2: number }) => a + x.localGhostM2, 0) / Math.max(1, ss.length);
  const locPC = ss.reduce((a: number, x: { localPathColl?: number }) => a + (x.localPathColl ?? 0), 0) / Math.max(1, ss.length);
  const row = [f.coverage * 100, f.precision * 100, locP * 100, locG, locPC * 100, f.ghostM2, f.falseFree * 100, f.frameErr * 100, feMax * 100, j.retention.coverageDrop * 100, j.retention.worstCoverageDrop * 100, (f.pathsColliding / Math.max(1, f.pathsTested)) * 100, f.memMB, j.cpu.frame.mean, j.cpu.frame.p95, j.cpu.frame.max, resets];
  console.log([r.name.padEnd(22), ...row.map((v) => v.toFixed(1).padStart(7))].join(' '));
  const base = r.name.split(':')[0];
  if (!agg.has(base)) agg.set(base, []);
  agg.get(base)!.push(row);
}
for (const [name, rows] of agg)
  if (rows.length > 1) {
    const mean = rows[0].map((_, c) => rows.reduce((a, r) => a + r[c], 0) / rows.length);
    console.log([`${name} (mean)`.padEnd(22), ...mean.map((v) => v.toFixed(1).padStart(7))].join(' '));
  }
console.log(`(${runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);

/**
 * Multi-session map persistence benchmark.
 *   npx tsx scripts/persist-bench.ts [--seeds 1-4] [--sessions 8] [--seconds 60]
 *       [--layout 2x2] [--symmetric] [--move 0.3] [--noise real] [--camera] [--quiet]
 * Prints per-session events and a summary line per home, then totals.
 */
import { runBench, type BenchOptions } from '../src/sim/PersistBench';
import type { NoiseName } from '../src/sim/SimSensor';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true') : def;
};
const [s0, s1] = (opt('seeds', '1-3') as string).split('-').map(Number);
const layout = (opt('layout', '2x2') as string).split('x').map(Number);
const quiet = !!opt('quiet');
const totals = { known: 0, ok: 0, wrong: 0, wrongKept: 0, restores: 0, err: [] as number[], deg: [] as number[], ttr: [] as number[], bytes: [] as number[], cov: [] as number[], prec: [] as number[], wprec: [] as number[], ff: [] as number[], frags: [] as number[], maxTick: 0, saveMs: [] as number[], loadMs: [] as number[] };
for (let seed = s0; seed <= (s1 ?? s0); seed++) {
  const o: BenchOptions = {
    seed,
    sessions: Number(opt('sessions', '8')),
    seconds: Number(opt('seconds', '60')),
    cols: layout[0],
    rows: layout[1],
    symmetric: !!opt('symmetric'),
    moveChance: Number(opt('move', '0.3')),
    moveShare: Number(opt('moveShare', '0.25')),
    noise: (opt('noise', 'real') as NoiseName),
    cameraDepth: !!opt('camera'),
    newRoomChance: Number(opt('newRoom', '0.35')),
    twoRoomChance: Number(opt('twoRoom', '0.4')),
    budgetMs: Number(opt('budget', '8')),
    halfExtent: opt('extent') ? Number(opt('extent')) : undefined,
    log: quiet ? undefined : (s) => console.log(s),
  };
  const r = await runBench(o);
  const known = r.sessions.filter((x) => x.known);
  totals.known += known.length;
  totals.ok += known.filter((x) => x.restoredAt !== null).length;
  totals.wrong += r.wrongRestores;
  totals.wrongKept += r.wrongKept;
  totals.restores += r.restores;
  for (const x of r.sessions) {
    for (const e of x.restores) if (!e.wrong) (totals.err.push(e.errCm), totals.deg.push(e.errDeg));
    if (x.known && x.restoredAt !== null) totals.ttr.push(x.restoredAt);
    totals.maxTick = Math.max(totals.maxTick, x.maxTickMs);
    totals.saveMs.push(x.saveMs);
    totals.loadMs.push(x.loadMs);
  }
  console.log(
    'JSON ' +
      JSON.stringify({
        seed,
        known: known.length,
        ok: known.filter((x) => x.restoredAt !== null).length,
        wrong: r.wrongRestores,
        wrongKept: r.wrongKept,
        restores: r.restores,
        ttr: known.filter((x) => x.restoredAt !== null).map((x) => x.restoredAt),
        err: r.sessions.flatMap((x) => x.restores.filter((e) => !e.wrong).map((e) => e.errCm)),
        deg: r.sessions.flatMap((x) => x.restores.filter((e) => !e.wrong).map((e) => e.errDeg)),
        fragments: r.fragments,
        bytes: r.storedBytes,
        coverage: r.coverage,
        quality: r.quality,
        saveMs: r.sessions.map((x) => x.saveMs),
        loadMs: r.sessions.map((x) => x.loadMs),
        busyMs: r.sessions.map((x) => x.busyMs),
        maxStep: Math.max(...r.sessions.map((x) => x.maxStep.ms)),
        undos: r.sessions.reduce((a, x) => a + x.undos, 0),
      }),
  );
  totals.bytes.push(r.storedBytes);
  totals.cov.push(r.coverage);
  totals.frags.push(r.fragments);
  for (const q of r.quality) (totals.prec.push(q.precision), totals.ff.push(q.falseFree), totals.wprec.push(q.wallPrecision));
  console.log(
    `HOME ${seed}: reloc ${known.filter((x) => x.restoredAt !== null).length}/${known.length}, wrong ${r.wrongRestores} (kept ${r.wrongKept}), ` +
      `ttr ${r.meanTimeToReloc.toFixed(1)}s, err ${r.meanErrCm.toFixed(1)}cm ${r.meanErrDeg.toFixed(2)}°, fragments ${r.fragments}, ${(r.storedBytes / 1024).toFixed(0)}KB, ` +
      `coverage ${(r.coverage * 100).toFixed(0)}%, quality ${r.quality.map((q) => `[${q.fragment.slice(-4)} prec ${q.precision.toFixed(3)} wall ${q.wallPrecision.toFixed(3)} ff ${q.falseFree.toFixed(3)} ghosts ${q.ghosts}/${q.wallGhosts} cov ${(q.coverage * 100).toFixed(0)}%]`).join(' ')}`,
  );
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
console.log(
  `TOTAL reloc ${totals.ok}/${totals.known} (${((100 * totals.ok) / Math.max(1, totals.known)).toFixed(0)}%), WRONG ${totals.wrong} (kept ${totals.wrongKept}) of ${totals.restores} restores, ` +
    `ttr ${mean(totals.ttr).toFixed(1)}s, err ${mean(totals.err).toFixed(1)}cm/${mean(totals.deg).toFixed(2)}° (max ${max(totals.err).toFixed(1)}cm), ` +
    `fragments ${mean(totals.frags).toFixed(1)}, store ${(mean(totals.bytes) / 1024).toFixed(0)}KB, coverage ${(mean(totals.cov) * 100).toFixed(0)}%, ` +
    `precision ${mean(totals.prec).toFixed(3)} (walls ${mean(totals.wprec).toFixed(3)}), falseFree ${mean(totals.ff).toFixed(3)}, save ${mean(totals.saveMs).toFixed(0)}ms load ${mean(totals.loadMs).toFixed(0)}ms, max tick ${totals.maxTick.toFixed(1)}ms`,
);

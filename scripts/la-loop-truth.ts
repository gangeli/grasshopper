// Loop-closure candidates vs the true correction (simulator ground truth):
// for each candidate / closure / hold resolution, the estimated correction
// next to the one that would really put the current frame onto the matched
// structure (as it was mapped at the structure's birth time).
// Usage: npx tsx scripts/la-loop-truth.ts [WxD] [seed] [seconds]   (env PROFILE, WALK, WORLD, DRIFT)
import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { NOISE_PROFILES } from '../src/sim/SimSensor';
const [w, d] = (process.argv[2] ?? '15x20').split('x').map(Number);
const seed = Number(process.argv[3] ?? 3);
const seconds = Number(process.argv[4] ?? 600);
const house = generateHouse(seed, w, d);
type M = number[];
const mul = (A: M, B: M): M => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return o; };
const inv = (M: M): M => { const o = [M[0], M[4], M[8], 0, M[1], M[5], M[9], 0, M[2], M[6], M[10], 0, 0, 0, 0, 1]; o[12] = -(o[0] * M[12] + o[4] * M[13] + o[8] * M[14]); o[13] = -(o[1] * M[12] + o[5] * M[13] + o[9] * M[14]); o[14] = -(o[2] * M[12] + o[6] * M[13] + o[10] * M[14]); return o; };
const ap = (M: M, p: { x: number; y: number; z: number }) => ({ x: M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12], y: M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13], z: M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14] });
const hist: { t: number; M: M }[] = []; // map <- truth
let camTrue = { x: 0, y: 0, z: 0 };
const rows: string[] = [];
let errs: number[] = [];
runLargeArea({
  house, seed, seconds,
  noise: { ...NOISE_PROFILES[(process.env.PROFILE ?? 'house-hard') as 'house-hard'] },
  evalEvery: 120,
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world, stack, sensor) => {
    Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
    const dm = stack.game.health.drift as any;
    Object.assign(dm.opts, JSON.parse(process.env.DRIFT ?? '{}'));
    const orig = world.ingestDepthImage.bind(world);
    (world as any).ingestDepthImage = (...a: any[]) => {
      const T = sensor.trackingFromTruth();
      const Mt = mul(inv(world.mapToTracking()), T);
      if (!hist.length || world.now - hist[hist.length - 1].t >= 0.25) hist.push({ t: world.now, M: Mt });
      const eye = a[0];
      if (eye && typeof eye.x === 'number') camTrue = ap(inv(T), eye);
      return (orig as any)(...a);
    };
    const on = dm.note.bind(dm);
    dm.note = (s: string) => {
      on(s);
      const kind = s.startsWith('loop candidate') ? 'loop' : s.startsWith('hold candidate') ? 'hold' : s.startsWith('LOOP CLOSED') ? 'LOOP' : s.startsWith('HOLD RESOLVED') ? 'HOLD' : null;
      if (!kind) return;
      const P = kind === 'loop' ? dm.pendingLoop : kind === 'hold' ? dm.pendingHold : null;
      const m = P?.m ?? dm.last?.m;
      if (!m || !Number.isFinite(m.oldT)) return;
      const now = hist[hist.length - 1];
      let old = hist[0];
      for (const h of hist) if (h.t <= m.oldT) old = h;
      const p = camTrue;
      const a1 = ap(old.M, p), a0 = ap(now.M, p);
      const tx = a1.x - a0.x, tz = a1.z - a0.z;
      const e = Math.hypot(m.dx - tx, m.dz - tz);
      errs.push(e);
      rows.push(`${world.now.toFixed(1)} ${kind.padEnd(4)} est (${m.dx.toFixed(2)},${m.dz.toFixed(2)}) true (${tx.toFixed(2)},${tz.toFixed(2)}) err ${(e * 100).toFixed(0)}cm |true| ${(Math.hypot(tx, tz) * 100).toFixed(0)}cm oldT ${m.oldT.toFixed(0)} sup ${m.best}/${m.n} base ${m.base}`);
    };
  },
});
console.log(rows.join('\n'));
errs = errs.sort((a, b) => a - b);
console.log('candidates', errs.length, 'err<10cm', errs.filter((e) => e < 0.1).length, 'median', (errs[errs.length >> 1] * 100).toFixed(0));

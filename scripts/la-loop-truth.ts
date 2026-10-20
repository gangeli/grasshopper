// Loop-closure candidates vs the true correction (simulator ground truth):
// for each candidate / closure / hold resolution, the estimated correction
// next to the one that would really put the current frame onto the matched
// structure (as it was mapped at the structure's birth time).
// Usage: npx tsx scripts/la-loop-truth.ts [WxD] [seed] [seconds]   (env PROFILE, WALK, WORLD, DRIFT)
import { generateHouse } from '../src/sim/House';
import { runLargeArea } from '../src/sim/largeArea';
import { NOISE_PROFILES } from '../src/sim/SimSensor';
import { PlaceMemory, type Submap } from '../src/world/PlaceMemory';
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
const atTruth = new Map<number, number>();
const histAt = (t: number) => {
  let h = hist[0];
  for (const e of hist) if (e.t <= t) h = e;
  return h.M;
};
// Each submap's truth -> map transform: the map frame of its time, then every move applied to it since
// (warps after loop closures move submaps: the true correction to a visit is relative to where it is now).
const subM = new Map<Submap, M>();
// Each depth frame's truth -> map transform as its stored points have it: the registration when it came
// in, then every realignment that corrected it (realign moves buffered frames from `since` on).
const frameM: { t: number; M: M }[] = [];
const frameAt = (t: number) => {
  let lo = 0, hi = frameM.length - 1, best = frameM[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frameM[mid].t <= t) (best = frameM[mid]), (lo = mid + 1);
    else hi = mid - 1;
  }
  return best ? best.M : hist[0].M;
};
const proto = PlaceMemory.prototype as unknown as { transform: (s: Submap, cs: number, sn: number, tx: number, tz: number, p: { x: number; z: number }) => void };
const origT = proto.transform;
proto.transform = function (sm, cs, sn, tx, tz, p) {
  const T = [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, p.x - (cs * p.x + sn * p.z) + tx, 0, p.z - (-sn * p.x + cs * p.z) + tz, 1];
  subM.set(sm, mul(T, subM.get(sm) ?? frameAt(sm.t0)));
  origT.call(this, sm, cs, sn, tx, tz, p);
};
let subsOf: (t0: number) => M | null = () => null;
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
      frameM.push({ t: a[1], M: Mt });
      if (frameM.length > 4000) frameM.splice(0, 1000);
      // (The camera in the truth frame: the image pose is in the tracking frame.)
      const C = a[0]?.camToWorld;
      if (C) camTrue = ap(inv(T), { x: C[12], y: C[13], z: C[14] });
      return (orig as any)(...a);
    };
    const origRealign = world.realign.bind(world);
    world.realign = (dx: number, dz: number, dyaw: number, pivot: { x: number; y: number; z: number }, since: number) => {
      const c = Math.cos(dyaw), sn = Math.sin(dyaw);
      const T = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, pivot.x - (c * pivot.x + sn * pivot.z) + dx, 0, pivot.z - (-sn * pivot.x + c * pivot.z) + dz, 1];
      for (const f of frameM) if (f.t >= since) f.M = mul(T, f.M);
      origRealign(dx, dz, dyaw, pivot, since);
    };
    // Support of the true correction in each place alignment (is the truth even in the data?).
    if (world.placeMemory)
      world.placeMemory.debug = (score, visit) => {
        const now = hist[hist.length - 1];
        const oldM = subsOf(visit.t0) ?? histAt(visit.t1);
        const a1 = ap(oldM, camTrue), a0 = ap(now.M, camTrue);
        const tyaw = Math.atan2(oldM[8], oldM[0]) - Math.atan2(now.M[8], now.M[0]);
        atTruth.set(visit.t0, score(a1.x - a0.x, a1.z - a0.z, tyaw));
      };
    subsOf = (t0) => {
      const sm = world.placeMemory?.submaps.find((x) => x.t0 === t0);
      return sm ? subM.get(sm) ?? frameAt(sm.t0) : null;
    };
    const on = dm.note.bind(dm);
    dm.note = (s: string) => {
      on(s);
      // ALL=1: every loop check with an estimate (also those the gate turned down).
      const kind = s.startsWith('loop candidate') ? 'loop' : s.startsWith('hold candidate') ? 'hold' : s.startsWith('LOOP CLOSED') ? 'LOOP' : s.startsWith('HOLD RESOLVED') ? 'HOLD' : process.env.ALL && s.startsWith('loop: none') ? 'none' : null;
      if (!kind) return;
      const P = kind === 'loop' ? dm.pendingLoop : kind === 'hold' ? dm.pendingHold : null;
      const m = P?.m ?? dm.last?.m;
      if (!m || !Number.isFinite(m.oldT)) return;
      const now = hist[hist.length - 1];
      const old = { M: (m.visitT0 !== undefined ? subsOf(m.visitT0) : null) ?? histAt(m.oldT) };
      const p = camTrue;
      const a1 = ap(old.M, p), a0 = ap(now.M, p);
      const tx = a1.x - a0.x, tz = a1.z - a0.z;
      const e = Math.hypot(m.dx - tx, m.dz - tz);
      const tyaw = Math.atan2(old.M[8], old.M[0]) - Math.atan2(now.M[8], now.M[0]);
      if (kind !== 'none') errs.push(e);
      rows.push(`${world.now.toFixed(1)} ${kind.padEnd(4)} est (${m.dx.toFixed(2)},${m.dz.toFixed(2)}) true (${tx.toFixed(2)},${tz.toFixed(2)}) err ${(e * 100).toFixed(0)}cm |true| ${(Math.hypot(tx, tz) * 100).toFixed(0)}cm yaw ${m.dyaw.toFixed(3)} true ${tyaw.toFixed(3)} oldT ${m.oldT.toFixed(0)} sup ${m.best}/${m.n} base ${m.base} truth ${(atTruth.get(m.visitT0) ?? NaN).toFixed(0)}${m.second !== undefined ? ` 2nd ${m.second} uniq ${m.unique?.toFixed(2)} c ${m.constraint?.toFixed(3)}` : ''}${m.degenerate ? ' DEG' : ''}`);
    };
  },
});
console.log(rows.join('\n'));
errs = errs.sort((a, b) => a - b);
console.log('candidates', errs.length, 'err<10cm', errs.filter((e) => e < 0.1).length, 'median', (errs[errs.length >> 1] * 100).toFixed(0));

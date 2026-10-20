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
// Bookkeep each submap from its creation (a later realignment corrects the frames' truth too: a
// submap made earlier must start from the truth of its frames as they were when it was made).
const protoC = PlaceMemory.prototype as unknown as { close: () => void; submaps: Submap[] };
const origClose = protoC.close;
protoC.close = function (this: { submaps: Submap[] }) {
  origClose.call(this);
  for (const sm of this.submaps) if (!subM.has(sm)) subM.set(sm, frameAt(sm.t0));
};
let subsOf: (t0: number) => M | null = () => null;
const visitQ = new Map<number, number>();
// The visit's truth transform measured directly: its cells fitted (ICP, x/z + yaw) onto the real
// geometry, starting from the bookkept transform. Robust to bookkeeping gaps (re-attaches, warps).
const fitCache = new Map<string, M>();
const room = house.room;
function fitToTruth(cells: number[], M0: M): M {
  let G = inv(M0); // map -> truth
  for (let it = 0; it < 10; it++) {
    const P: number[] = [], Q: number[] = [];
    for (let q = 0; q < cells.length; q += 3) {
      const p = ap(G, { x: cells[q], y: cells[q + 1], z: cells[q + 2] });
      let bd = 0.3, bx = 0, bz = 0;
      for (const b of room.boxes) {
        if (p.x < b.min.x - bd || p.x > b.max.x + bd || p.z < b.min.z - bd || p.z > b.max.z + bd || p.y < b.min.y - 0.1 || p.y > b.max.y + 0.1) continue;
        // Nearest point on the box's vertical faces (x/z).
        const inside = p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z;
        let qx: number, qz: number;
        if (inside) {
          const dl = p.x - b.min.x, dr = b.max.x - p.x, dn = p.z - b.min.z, df = b.max.z - p.z, m = Math.min(dl, dr, dn, df);
          (qx = m === dl ? b.min.x : m === dr ? b.max.x : p.x), (qz = m === dn ? b.min.z : m === df ? b.max.z : p.z);
        } else (qx = Math.max(b.min.x, Math.min(b.max.x, p.x))), (qz = Math.max(b.min.z, Math.min(b.max.z, p.z)));
        const d = Math.hypot(qx - p.x, qz - p.z);
        if (d < bd) (bd = d), (bx = qx), (bz = qz);
      }
      if (bd >= 0.3 || bd > (it < 4 ? 0.3 : 0.12)) continue;
      P.push(p.x, p.z);
      Q.push(bx, bz);
    }
    const n = P.length / 2;
    if (n < 30) break;
    let mpx = 0, mpz = 0, mqx = 0, mqz = 0;
    for (let q = 0; q < P.length; q += 2) (mpx += P[q]), (mpz += P[q + 1]), (mqx += Q[q]), (mqz += Q[q + 1]);
    (mpx /= n), (mpz /= n), (mqx /= n), (mqz /= n);
    let A = 0, B = 0;
    for (let q = 0; q < P.length; q += 2) {
      const ax = P[q] - mpx, az = P[q + 1] - mpz, bx = Q[q] - mqx, bz = Q[q + 1] - mqz;
      A += bx * ax + bz * az;
      B += bx * az - bz * ax;
    }
    const th = Math.atan2(B, A), c = Math.cos(th), sn = Math.sin(th);
    // x' = c x + s z + t (same convention as the estimator)
    const D = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, mqx - (c * mpx + sn * mpz), 0, mqz - (-sn * mpx + c * mpz), 1];
    G = mul(D, G);
  }
  return inv(G); // truth -> map
}
runLargeArea({
  house, seed, seconds,
  noise: { ...NOISE_PROFILES[(process.env.PROFILE ?? 'house-hard') as 'house-hard'] },
  evalEvery: 120,
  walk: JSON.parse(process.env.WALK ?? '{"panSpeed":[2,5],"glanceRate":0.15}'),
  setup: (world, stack, sensor) => {
    Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
    if (process.env.NOPEOPLE) sensor.room.dynamic.length = 0;
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
    // A re-attach corrects the frames since the detach (in the replay buffer) the same way.
    const origRe = world.reattach.bind(world);
    world.reattach = (c: { dx: number; dz: number; dyaw: number; pivot: { x: number; y: number; z: number } }) => {
      const since = world.dormant?.t ?? Infinity;
      const cs = Math.cos(c.dyaw), sn = Math.sin(c.dyaw), p = c.pivot;
      const T = [cs, 0, -sn, 0, 0, 1, 0, 0, sn, 0, cs, 0, p.x - (cs * p.x + sn * p.z) + c.dx, 0, p.z - (-sn * p.x + cs * p.z) + c.dz, 1];
      for (const f of frameM) if (f.t >= since) f.M = mul(T, f.M);
      console.log(`# reattach at ${world.now.toFixed(1)} (dormant since ${since.toFixed(1)})`);
      origRe(c);
    };
    const origDetach = world.detachMap.bind(world);
    world.detachMap = () => {
      console.log(`# detach at ${world.now.toFixed(1)}`);
      origDetach();
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
      const pmem = world.placeMemory;
      const sm = pmem?.submaps.find((x) => x.t0 === t0);
      if (!sm || !pmem) return null;
      const M0 = subM.get(sm) ?? frameAt(sm.t0);
      // How well the visit's cells sit on real geometry through this transform (bookkeeping check).
      const Mi = inv(M0);
      let good = 0, n = 0;
      for (const x of pmem.submaps.filter((y) => y.t0 >= t0 && y.t0 <= t0 + 60))
        for (let q = 0; q < x.cells.length; q += 3 * 8) {
          const p = ap(Mi, { x: x.cells[q] / 100, y: x.cells[q + 1] / 100, z: x.cells[q + 2] / 100 });
          n++;
          for (const b of house.room.boxes)
            if (p.x > b.min.x - 0.08 && p.x < b.max.x + 0.08 && p.y > b.min.y - 0.08 && p.y < b.max.y + 0.08 && p.z > b.min.z - 0.08 && p.z < b.max.z + 0.08) {
              good++;
              break;
            }
        }
      visitQ.set(t0, n ? good / n : NaN);
      if (!process.env.REFIT) return M0;
      // The whole visit (submaps close in time from t0 on).
      const subs = pmem.submaps.filter((x) => x.t0 >= t0 && x.t0 <= t0 + 60);
      const key = `${t0}:${subs.length}:${subs.reduce((a, x) => a + x.cells[0], 0)}`;
      let G = fitCache.get(key);
      if (!G) {
        const cells: number[] = [];
        for (const x of subs) for (let q = 0; q < x.cells.length; q += 3 * 4) cells.push(x.cells[q] / 100, x.cells[q + 1] / 100, x.cells[q + 2] / 100);
        G = fitToTruth(cells.slice(0, 6000), M0);
        fitCache.set(key, G);
      }
      return G;
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
      const pivErr = m.pivot ? Math.hypot(m.pivot.x - a0.x, m.pivot.z - a0.z) : NaN;
      const tx = a1.x - a0.x, tz = a1.z - a0.z;
      const e = Math.hypot(m.dx - tx, m.dz - tz);
      const tyaw = Math.atan2(old.M[8], old.M[0]) - Math.atan2(now.M[8], now.M[0]);
      if (kind !== 'none') errs.push(e);
      rows.push(`${world.now.toFixed(1)} ${kind.padEnd(4)} est (${m.dx.toFixed(2)},${m.dz.toFixed(2)}) true (${tx.toFixed(2)},${tz.toFixed(2)}) err ${(e * 100).toFixed(0)}cm |true| ${(Math.hypot(tx, tz) * 100).toFixed(0)}cm yaw ${m.dyaw.toFixed(3)} true ${tyaw.toFixed(3)} oldT ${m.oldT.toFixed(0)} sup ${m.best}/${m.n} base ${m.base} truth ${(atTruth.get(m.visitT0) ?? NaN).toFixed(0)} vq ${(visitQ.get(m.visitT0) ?? NaN).toFixed(2)} piv ${(pivErr * 100).toFixed(0)}cm${m.second !== undefined ? ` 2nd ${m.second} uniq ${m.unique?.toFixed(2)} c ${m.constraint?.toFixed(3)} open ${m.openShare?.toFixed(2)}` : ''}${m.degenerate ? ' DEG' : ''}`);
    };
  },
});
console.log(rows.join('\n'));
errs = errs.sort((a, b) => a - b);
console.log('candidates', errs.length, 'err<10cm', errs.filter((e) => e < 0.1).length, 'median', (errs[errs.length >> 1] * 100).toFixed(0));

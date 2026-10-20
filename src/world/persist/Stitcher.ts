import { CS, CS2, chunkKey, emptyMap, getOrCreateChunk, newChunk, type ChunkedMap, type MapChunk } from './ChunkedMap';
import { invertPose, type Pose2 } from './pose';
import { every, runToEnd, type Work } from './gen';

/**
 * Moving maps between frames and fusing evidence:
 *  - transformMap: resample a map into another frame/lattice (nearest voxel);
 *  - combinePrior: what the live grid holds after a stored map is restored
 *    into it (live observations win; the stored map fills the rest, with its
 *    confidence capped so the live session can overrule it quickly);
 *  - fuseEvidence: fold one session's own observations into a stored map
 *    (again: where they disagree, the newer observation wins);
 *  - liveEvidence: recover the session's own observations from the live grid
 *    after stored maps were restored into it.
 */
const OCC = 20;
/** Evidence at least this confident is an observation, not a guess. */
export const STRONG_LIVE = 12;
/** Restored obstacles: obstacles, but below STRONG_OCC (45) so they do not count as contradictions for the drift and health checks, and ~12 rays clear them. */
export const PRIOR_OCC_CAP = 44;
export const PRIOR_FREE_CAP = -30;
const MAX_LO = 120, MIN_LO = -60;

export interface Lattice {
  res: number;
  ny: number;
  origin: { x: number; y: number; z: number };
}

export function transformMap(src: ChunkedMap, T: Pose2, dst: Lattice, limit?: { i0: number; k0: number; i1: number; k1: number }): ChunkedMap {
  return runToEnd(transformMapGen(src, T, dst, limit));
}

/**
 * Resample `src` into the frame where p_dst = T(p_src), on `dst`'s lattice.
 * `limit`: only produce dst columns in [i0, i1) × [k0, k1).
 */
export function* transformMapGen(src: ChunkedMap, T: Pose2, dst: Lattice, limit?: { i0: number; k0: number; i1: number; k1: number }, per = 4): Work<ChunkedMap> {
  const y = every(per);
  const out = emptyMap(dst.res, dst.ny, dst.origin);
  const inv = invertPose(T);
  const ci = Math.cos(inv.yaw), si = Math.sin(inv.yaw), c = Math.cos(T.yaw), s = Math.sin(T.yaw);
  const dj = T.dj ?? 0;
  const sr = src.res, dr = dst.res;
  const ny = Math.min(dst.ny, src.ny);
  for (const sc of src.chunks.values()) {
    if (y()) yield;
    // Destination column box covering this source chunk.
    let i0 = Infinity, k0 = Infinity, i1 = -Infinity, k1 = -Infinity;
    for (const [u, v] of [
      [0, 0],
      [CS, 0],
      [0, CS],
      [CS, CS],
    ]) {
      const x = src.origin.x + (sc.cx * CS + u) * sr, z = src.origin.z + (sc.cz * CS + v) * sr;
      const px = c * x - s * z + T.tx, pz = s * x + c * z + T.tz;
      const I = (px - dst.origin.x) / dr, K = (pz - dst.origin.z) / dr;
      i0 = Math.min(i0, I);
      i1 = Math.max(i1, I);
      k0 = Math.min(k0, K);
      k1 = Math.max(k1, K);
    }
    let I0 = Math.floor(i0) - 1, I1 = Math.ceil(i1) + 1, K0 = Math.floor(k0) - 1, K1 = Math.ceil(k1) + 1;
    if (limit) {
      I0 = Math.max(I0, limit.i0);
      K0 = Math.max(K0, limit.k0);
      I1 = Math.min(I1, limit.i1 - 1);
      K1 = Math.min(K1, limit.k1 - 1);
    }
    for (let K = K0; K <= K1; K++)
      for (let I = I0; I <= I1; I++) {
        const x = dst.origin.x + (I + 0.5) * dr, z = dst.origin.z + (K + 0.5) * dr;
        const sx = ci * x - si * z + inv.tx, sz = si * x + ci * z + inv.tz;
        const SI = Math.floor((sx - src.origin.x) / sr), SK = Math.floor((sz - src.origin.z) / sr);
        if (Math.floor(SI / CS) !== sc.cx || Math.floor(SK / CS) !== sc.cz) continue;
        const sl = (SK - sc.cz * CS) * CS + (SI - sc.cx * CS);
        // Skip columns with nothing in them (don't allocate chunks for nothing).
        let any = sc.observed[sl] !== 0;
        if (!any) for (let j = 0; j < src.ny; j++) if (sc.occ[j * CS2 + sl] !== 0) { any = true; break; }
        if (!any) continue;
        const cx = Math.floor(I / CS), cz = Math.floor(K / CS);
        const dc = getOrCreateChunk(out, cx, cz);
        const dl = (K - cz * CS) * CS + (I - cx * CS);
        if (sc.observed[sl]) dc.observed[dl] = 1;
        for (let j = 0; j < ny; j++) {
          const jd = j + dj;
          if (jd < 0 || jd >= dst.ny || j >= src.ny) continue;
          dc.occ[jd * CS2 + dl] = sc.occ[j * CS2 + sl];
          if (sc.underside && sc.underside[j * CS2 + sl]) (dc.underside ??= new Uint8Array(CS2 * dst.ny))[jd * CS2 + dl] = sc.underside[j * CS2 + sl];
          if (sc.topFrac && sc.topFrac[j * CS2 + sl] !== 255) (dc.topFrac ??= new Uint8Array(CS2 * dst.ny).fill(255))[jd * CS2 + dl] = sc.topFrac[j * CS2 + sl];
        }
      }
  }
  return out;
}

function capPrior(p: number): number {
  if (p > OCC) return Math.max(OCC + 1, Math.min(PRIOR_OCC_CAP, p));
  if (p < 0) return Math.max(PRIOR_FREE_CAP, p);
  return p;
}

const clampLO = (v: number) => (v > MAX_LO ? MAX_LO : v < MIN_LO ? MIN_LO : v);

/** Per-chunk union of keys. */
function keysOf(...maps: (ChunkedMap | null)[]): Set<number> {
  const s = new Set<number>();
  for (const m of maps) if (m) for (const k of m.chunks.keys()) s.add(k);
  return s;
}

export function combinePrior(live: ChunkedMap, prior: ChunkedMap): ChunkedMap {
  return runToEnd(combinePriorGen(live, prior));
}

/**
 * The live grid's contents after restoring `prior` (already on the live
 * lattice) into `live`.
 */
export function* combinePriorGen(live: ChunkedMap, prior: ChunkedMap, per = 6, fillOnly = false): Work<ChunkedMap> {
  const y = every(per);
  const out = emptyMap(live.res, live.ny, live.origin);
  const ny = live.ny;
  for (const key of keysOf(live, prior)) {
    if (y()) yield;
    const l = live.chunks.get(key), p = prior.chunks.get(key);
    if (!p) {
      out.chunks.set(key, l!);
      continue;
    }
    const c = newChunk(p.cx, p.cz, ny);
    for (let q = 0; q < CS2 * ny; q++) {
      const lv = l ? l.occ[q] : 0;
      const pv = q < p.occ.length ? capPrior(p.occ[q]) : 0;
      // fillOnly: only where the live grid knows nothing (re-applying a restore
      // after the world model rewrote its grid; never counts a prior twice).
      c.occ[q] = lv >= STRONG_LIVE || lv <= -STRONG_LIVE ? lv : lv === 0 ? pv : fillOnly ? lv : clampLO(lv + pv);
    }
    for (let q = 0; q < CS2; q++) c.observed[q] = (l?.observed[q] ?? 0) | p.observed[q];
    mergeAux(c, l ?? null, p, ny);
    out.chunks.set(key, c);
  }
  return out;
}

/** Underside bits (union) and surface heights (first map wins) of two chunks into c. */
function mergeAux(c: MapChunk, first: MapChunk | null, second: MapChunk | null, ny: number) {
  if (first?.underside || second?.underside) {
    c.underside = new Uint8Array(CS2 * ny);
    for (let q = 0; q < CS2 * ny; q++) c.underside[q] = (first?.underside?.[q] ?? 0) | (second?.underside?.[q] ?? 0);
  }
  if (first?.topFrac || second?.topFrac) {
    c.topFrac = new Uint8Array(CS2 * ny).fill(255);
    for (let q = 0; q < CS2 * ny; q++) {
      const a = first?.topFrac?.[q] ?? 255;
      c.topFrac[q] = a !== 255 ? a : (second?.topFrac?.[q] ?? 255);
    }
  }
}

export function fuseEvidence(m: ChunkedMap, e: ChunkedMap): ChunkedMap {
  return runToEnd(fuseEvidenceGen(m, e));
}

/**
 * Fold a session's own evidence `e` (on the stored map's lattice) into the
 * stored map `m`. Returns a new map (unchanged chunks are shared).
 */
export function* fuseEvidenceGen(m: ChunkedMap, e: ChunkedMap, per = 6): Work<ChunkedMap> {
  const y = every(per);
  const out = emptyMap(m.res, m.ny, m.origin);
  for (const [k, c] of m.chunks) out.chunks.set(k, c);
  const ny = m.ny;
  for (const [key, ec] of e.chunks) {
    if (y()) yield;
    const mc = m.chunks.get(key);
    const c = newChunk(ec.cx, ec.cz, ny);
    for (let q = 0; q < CS2 * ny; q++) {
      const ev = q < ec.occ.length ? ec.occ[q] : 0, mv = mc ? mc.occ[q] : 0;
      let v: number;
      if (ev === 0) v = mv;
      else if (mv === 0) v = ev;
      else if (ev > 0 === mv > 0) v = ev > 0 ? Math.max(ev, mv) : Math.min(ev, mv);
      else v = Math.abs(ev) >= STRONG_LIVE ? ev : clampLO(ev + mv);
      c.occ[q] = v;
    }
    for (let q = 0; q < CS2; q++) c.observed[q] = (mc?.observed[q] ?? 0) | ec.observed[q];
    mergeAux(c, ec, mc ?? null, ny);
    out.chunks.set(key, c);
  }
  return out;
}

/**
 * Chunks the live map has (mostly) forgotten since `base`: at least `minKnown`
 * voxels known in base, and `frac` of them unknown (0) now. The world model
 * doesn't zero voxels during normal mapping (rays and hits change them
 * gradually; its own resets are reported through its counters), so this
 * means data was dropped — e.g. archived chunks lost when the window moved
 * twice in quick succession.
 */
export function* forgottenChunksGen(now: ChunkedMap, base: ChunkedMap, minKnown = 200, frac = 0.6, per = 8): Work<number[]> {
  const y = every(per);
  const out: number[] = [];
  for (const [key, b] of base.chunks) {
    if (y()) yield;
    const g = now.chunks.get(key);
    let known = 0, lost = 0;
    for (let q = 0; q < b.occ.length; q++) {
      if (b.occ[q] === 0) continue;
      known++;
      if (!g || g.occ[q] === 0) lost++;
    }
    if (known >= minKnown && lost >= frac * known) out.push(key);
  }
  return out;
}

export function liveEvidence(now: ChunkedMap, base: ChunkedMap, liveOnly: ChunkedMap): ChunkedMap {
  return runToEnd(liveEvidenceGen(now, base, liveOnly));
}

/**
 * The session's own evidence: liveOnly + (now − base), voxel by voxel, where
 * `base` is the live grid right after the last restore and `liveOnly` the
 * session's own evidence at that moment.
 *
 * Columns the live map has forgotten entirely (known in `base`, nothing at
 * all now — the world model dropped them, e.g. an archived chunk lost when
 * its window moved) keep `liveOnly`: "now − base" there would turn every
 * restored free voxel into an obstacle and every restored obstacle into
 * free space.
 */
export function* liveEvidenceGen(now: ChunkedMap, base: ChunkedMap, liveOnly: ChunkedMap, per = 6): Work<ChunkedMap> {
  const y = every(per);
  const out = emptyMap(now.res, now.ny, now.origin);
  const ny = now.ny;
  const forgot = new Uint8Array(CS2);
  for (const key of keysOf(now, base, liveOnly)) {
    if (y()) yield;
    const g = now.chunks.get(key), b = base.chunks.get(key), lo = liveOnly.chunks.get(key);
    const ref = g ?? b ?? lo!;
    const c = newChunk(ref.cx, ref.cz, ny);
    let any = false;
    // Forgotten columns: base knew something, now holds nothing.
    let anyForgot = false;
    if (b) {
      for (let q = 0; q < CS2; q++) forgot[q] = g?.observed[q] ? 0 : 1;
      if (g)
        for (let q = 0; q < CS2 * ny; q++) if (g.occ[q] !== 0) forgot[q % CS2] = 0;
      for (let q = 0; q < CS2; q++) {
        if (!forgot[q]) continue;
        let known = b.observed[q] !== 0;
        for (let j = 0; j < ny && !known; j++) if (b.occ[j * CS2 + q] !== 0) known = true;
        forgot[q] = known ? 1 : 0;
        if (known) anyForgot = true;
      }
    }
    for (let q = 0; q < CS2 * ny; q++) {
      const v = anyForgot && forgot[q % CS2] ? (lo ? lo.occ[q] : 0) : clampLO((lo ? lo.occ[q] : 0) + (g ? g.occ[q] : 0) - (b ? b.occ[q] : 0));
      c.occ[q] = v;
      if (v) any = true;
    }
    for (let q = 0; q < CS2; q++) {
      const o = (lo?.observed[q] ?? 0) | ((g?.observed[q] ?? 0) & ((b?.observed[q] ?? 0) ^ 1));
      c.observed[q] = o;
      if (o) any = true;
    }
    if (!any) continue;
    mergeAux(c, g ?? null, null, ny);
    out.chunks.set(key, c);
  }
  return out;
}

/** Shift a map by whole layers (floor correction between sessions). */
export function shiftLayers(m: ChunkedMap, dj: number): ChunkedMap {
  if (!dj) return m;
  const out = emptyMap(m.res, m.ny, m.origin);
  for (const [k, c] of m.chunks) {
    const n = newChunk(c.cx, c.cz, m.ny);
    for (let j = 0; j < m.ny; j++) {
      const jd = j + dj;
      if (jd < 0 || jd >= m.ny) continue;
      n.occ.set(c.occ.subarray(j * CS2, (j + 1) * CS2), jd * CS2);
    }
    n.observed.set(c.observed);
    out.chunks.set(k, n);
  }
  return out;
}

export { chunkKey };

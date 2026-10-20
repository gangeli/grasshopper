import type { WorldModel } from '../WorldModel';
import { sameStamp, WorldSource, type LiveSource, type LiveStamp } from './adapter';
import { observedColumns, type ChunkedMap } from './ChunkedMap';
import { encodeBody, packBody } from './codec';
import { extractFeaturesGen, FragmentLookup, type MapFeatures } from './features';
import { runToEnd, type Work } from './gen';
import { MapStore, type FragmentMeta } from './MapStore';
import { composePose, invertPose, isFinitePose, poseDelta, type Pose2 } from './pose';
import { FragmentIndex, relocalize, verifyPose, type RelocOptions, type RelocResult, type VerifyMetrics } from './Relocalizer';
import { combinePriorGen, fuseEvidenceGen, liveEvidenceGen, transformMapGen } from './Stitcher';

/**
 * Remembering rooms across sessions.
 *
 *   load ─► search (relocalize the live map in each stored fragment, again
 *   and again as the live map grows) ─► the same unambiguous answer twice ─►
 *   restore (the stored map is transformed into the live frame and fused
 *   into the live grid) ─► keep verifying with the session's own
 *   observations ─► confirmed after a while ─► the session's observations are
 *   folded into the stored fragment on save. If the session never
 *   relocalizes, it is saved as a new fragment; a later session that
 *   overlaps two fragments stitches them into one.
 *
 * Safety: a wrong merge is much worse than none. A restore needs strong,
 * unambiguous, repeated evidence; it is re-checked against the session's own
 * observations and undone (and that placement blocked) if they disagree; and
 * nothing is written into a stored fragment until the restore is confirmed.
 * Stored fragments are never modified in memory (each save re-derives the
 * new version from the loaded one), so an undo can always put them back.
 *
 * All heavy work is in a resumable job that tick() runs for a few ms per frame.
 */
export interface MemoryHooks {
  /** A stored map was restored into the live map. */
  onRestored?(info: { fragment: string; area: number; pose: Pose2 }): void;
  /** A restore was taken back (the session's own observations disagreed). */
  onUndone?(info: { fragment: string; reason: string }): void;
  /** The live grid's contents were replaced (rebuild nav / occluder). */
  onMapChanged?(): void;
  onSaved?(info: { fragment: string; bytes: number; ms: number }): void;
  /** Two stored fragments were stitched: `other` (gone) placed into `base` by `pose` (other → base). */
  onStitched?(info: { base: string; other: string; pose: Pose2 }): void;
  log?(msg: string): void;
}

export interface MemoryOptions {
  /** Seconds between relocalization attempts. */
  attemptEvery: number;
  /** Seconds between tries at stitching two stored fragments (when nothing else is due). */
  consolidateEvery: number;
  /** Seconds between re-verifications of a restore. */
  verifyEvery: number;
  /** Seconds between saves. */
  saveEvery: number;
  /** Agreeing accepted attempts needed before restoring. */
  agree: number;
  /** A restore is confirmed (and written to storage) after this long and this many good checks. */
  confirmAfter: number;
  confirmChecks: number;
  /** Bad checks (in a row) that undo a restore. */
  undoAfter: number;
  /** Observed floor (m²) before a session is worth saving on its own. */
  minSaveArea: number;
  /** Observed floor (m²) before searching. */
  minSearchArea: number;
  /** Fragments tried per attempt. */
  perAttempt: number;
  reloc: RelocOptions;
}

export const DEFAULT_MEMORY: MemoryOptions = {
  attemptEvery: 4,
  consolidateEvery: 20,
  verifyEvery: 5,
  saveEvery: 30,
  agree: 2,
  confirmAfter: 25,
  confirmChecks: 3,
  undoAfter: 2,
  minSaveArea: 4,
  minSearchArea: 1.0,
  perAttempt: 3,
  reloc: {},
};

interface Frag {
  meta: FragmentMeta;
  /** As loaded (never modified: saves re-derive from it). */
  map: ChunkedMap;
  index: FragmentIndex | null;
  lastTried: number;
  /** Back-off: no full search of this fragment before this time unless the live map changed a lot. */
  nextTry: number;
  backoff: number;
  /** Live map size (occupied + free voxels) at the last full search. */
  triedAt: number;
}

export interface Link {
  fragment: string;
  /** live → fragment. */
  pose: Pose2;
  since: number;
  good: number;
  bad: number;
  confirmed: boolean;
  last: VerifyMetrics | null;
}

interface Hypothesis {
  pose: Pose2;
  /** The other placements the search considered (re-checked along with it). */
  rivals: Pose2[];
  count: number;
  t: number;
  occ: number;
}

export interface MemoryStatus {
  state: 'off' | 'loading' | 'searching' | 'restored' | 'idle';
  fragments: number;
  storedBytes: number;
  persistent: boolean;
  attempts: number;
  restores: number;
  undos: number;
  saves: number;
  lastReason: string;
  lastError: string;
}

type Job = Generator<void, void, void>;

interface Write {
  id: string;
  map: ChunkedMap;
  area: number;
  sessions: number;
  created?: number;
  /** Serialized body (uncompressed). */
  body?: Uint8Array;
}

export class MapMemory {
  readonly opts: MemoryOptions;
  readonly fragments = new Map<string, Frag>();
  links: Link[] = [];
  readonly sessionId: string;
  private source: LiveSource | null = null;
  private job: Job | null = null;
  private jobName = '';
  private tracker: { liveOnly: ChunkedMap; base: ChunkedMap } | null = null;
  private evidence: { t: number; map: ChunkedMap } | null = null;
  private hyps = new Map<string, Hypothesis>();
  private blocked = new Map<string, Pose2[]>();
  private nextAttempt = 0;
  private nextVerify = 0;
  private nextSave = 0;
  private watch: LiveStamp | null = null;
  private writing: Promise<void> | null = null;
  /** This session's own fragment has been written (id = sessionId). */
  private ownSaved = false;
  private sessionCounted = new Set<string>();
  /** Stored fragments replaced by a stitched one (deleted on the next save). */
  private absorbed = new Set<string>();
  now = 0;
  readonly status: MemoryStatus = { state: 'off', fragments: 0, storedBytes: 0, persistent: false, attempts: 0, restores: 0, undos: 0, saves: 0, lastReason: '', lastError: '' };
  /** Last relocalization result per fragment (diagnostics). */
  readonly lastResult = new Map<string, RelocResult>();
  /** Milliseconds spent in tick() (diagnostics). */
  busyMs = 0;
  /** Longest single tick (ms). */
  maxTickMs = 0;
  /** Longest single slice of work, and which job it was in (diagnostics). */
  maxStep = { ms: 0, job: '' };

  constructor(
    readonly store: MapStore | null,
    readonly hooks: MemoryHooks = {},
    opts: Partial<MemoryOptions> = {},
  ) {
    this.opts = { ...DEFAULT_MEMORY, ...opts };
    this.sessionId = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.status.persistent = !!store?.persistent;
  }

  /** Read every stored fragment (corrupted ones are skipped). */
  async load(): Promise<void> {
    if (!this.store) return;
    this.status.state = 'loading';
    await this.store.sweep();
    for (const meta of this.store.list()) {
      const map = await this.store.load(meta.id);
      if (!map) {
        this.log(`fragment ${meta.id} unreadable: skipped`);
        continue;
      }
      this.fragments.set(meta.id, { meta, map, index: null, lastTried: -Infinity, nextTry: -Infinity, backoff: 0, triedAt: 0 });
    }
    this.status.fragments = this.fragments.size;
    this.status.storedBytes = this.store.totalBytes;
    this.status.lastError = this.store.lastError;
    this.status.state = 'idle';
  }

  /** The live map to work with: a WorldModel in this thread, or any LiveSource (e.g. snapshots in a worker). */
  attach(world: WorldModel | LiveSource): void {
    this.source = 'exportGen' in world ? world : new WorldSource(world);
    this.watch = null;
  }

  get restored(): boolean {
    return this.links.length > 0;
  }

  private log(msg: string) {
    this.hooks.log?.(msg);
  }

  /** Run background work for up to `budgetMs` (call every frame). */
  tick(now: number, budgetMs = 3, maxSteps = Infinity): void {
    let steps = 0;
    const t0 = performance.now();
    this.now = now;
    try {
      const src = this.source;
      if (!src || !src.ready) return;
      this.checkWorldEvents(src);
      if (!this.job) this.job = this.nextJob(now);
      while (this.job) {
        const s0 = performance.now();
        const r = this.job.next();
        const ds = performance.now() - s0;
        if (ds > this.maxStep.ms) this.maxStep = { ms: ds, job: this.jobName };
        if (r.done) {
          this.job = null;
          break;
        }
        if (performance.now() - t0 >= budgetMs || src.waiting || ++steps >= maxSteps) break;
      }
    } catch (e) {
      // Never let persistence break the game: drop the job and carry on.
      this.job = null;
      this.status.lastError = `${this.jobName}: ${(e as Error)?.message ?? e}`;
      this.log(`error in ${this.jobName}: ${(e as Error)?.stack ?? e}`);
    } finally {
      const dt = performance.now() - t0;
      this.busyMs += dt;
      this.maxTickMs = Math.max(this.maxTickMs, dt);
    }
  }

  /** Finish the current job and everything due now (tests, harness). */
  runUntilIdle(now: number, maxSteps = 1e7): void {
    this.now = now;
    for (let k = 0; k < 4; k++) {
      this.tick(now, Infinity);
      if (!this.job) break;
      for (let s = 0; this.job && s < maxSteps; s++) this.tick(now, Infinity);
    }
  }

  get busy(): boolean {
    return !!this.job;
  }

  private nextJob(now: number): Job | null {
    this.status.state = this.links.length ? 'restored' : this.fragments.size ? 'searching' : 'idle';
    if (this.needRebase) {
      this.jobName = 'rebase';
      return this.rebaseJob();
    }
    if (this.links.length && now >= this.nextVerify) {
      this.nextVerify = now + this.opts.verifyEvery;
      this.jobName = 'verify';
      return this.verifyJob();
    }
    const unlinked = [...this.fragments.values()].filter((f) => !this.links.some((l) => l.fragment === f.meta.id) && f.meta.id !== this.sessionId && !this.absorbed.has(f.meta.id));
    if (unlinked.length && now >= this.nextAttempt && this.source && unlinked.some((f) => this.isDue(f, this.source!.observedColumns()))) {
      this.nextAttempt = now + this.opts.attemptEvery;
      this.jobName = 'relocalize';
      return this.relocJob(unlinked);
    }
    if (this.store && now >= this.nextSave && !this.writing) {
      this.nextSave = now + this.opts.saveEvery;
      this.jobName = 'save';
      return this.saveJob();
    }
    if (this.store && now >= this.nextConsolidate && !this.writing) {
      this.nextConsolidate = now + this.opts.consolidateEvery;
      const pair = this.nextPair();
      if (pair) {
        this.jobName = 'consolidate';
        return this.consolidateJob(pair[0], pair[1]);
      }
    }
    return null;
  }

  // --- Offline stitching ------------------------------------------------------------
  private nextConsolidate = 0;
  private compared = new Set<string>();

  /** Two stored fragments (neither in use this session) not compared yet in their current versions. */
  private nextPair(): [Frag, Frag] | null {
    const idle = [...this.fragments.values()].filter((f) => f.meta.id !== this.sessionId && !this.absorbed.has(f.meta.id) && !this.links.some((l) => l.fragment === f.meta.id));
    for (let a = 0; a < idle.length; a++)
      for (let b = a + 1; b < idle.length; b++) {
        const key = `${idle[a].meta.id}:${idle[a].meta.gen}|${idle[b].meta.id}:${idle[b].meta.gen}`;
        if (this.compared.has(key)) continue;
        this.compared.add(key);
        return [idle[a], idle[b]];
      }
    return null;
  }

  /**
   * Two stored fragments of the same place (sessions that never recognised
   * it) become one. Stricter than a live restore — no live check follows:
   * the search must agree from both sides, with a clear margin, and the
   * walls (or several pieces of furniture) must pin the placement.
   */
  private *consolidateJob(X: Frag, Y: Frag): Job {
    const ix = yield* this.fragIndex(X), iy = yield* this.fragIndex(Y);
    const r1: RelocResult = yield* relocalize({ features: ix.features, lookup: ix.lookup }, iy, this.opts.reloc);
    const m = r1.best?.metrics;
    if (!r1.accepted || !r1.best || !m || r1.ambiguity > 0.5 || (m.wallWeak < 80 && m.lowObjects < 3)) return;
    const back = invertPose(r1.best.pose);
    const r2: RelocResult = yield* relocalize({ features: iy.features, lookup: iy.lookup }, ix, { ...this.opts.reloc, hint: [back, ...r1.candidates.slice(1).map(invertPose)] });
    if (!r2.accepted || !r2.best) return;
    const d = poseDelta(r2.best.pose, back);
    if (d.dist > 0.1 || d.dyaw > 0.035) return;
    // Keep the bigger fragment's frame; fold the other one in.
    const [base, other, T] = Y.meta.area >= X.meta.area ? [Y, X, r1.best.pose] : [X, Y, back];
    const map = yield* fuseEvidenceGen(base.map, yield* transformMapGen(other.map, T, base.map));
    const area = observedColumns(map) * map.res * map.res;
    const body = yield* encodeBody(map);
    this.log(`stitched stored ${other.meta.id} into ${base.meta.id}`);
    this.hooks.onStitched?.({ base: base.meta.id, other: other.meta.id, pose: T });
    this.absorbed.add(other.meta.id);
    base.map = map;
    base.index = null;
    this.fragments.delete(other.meta.id);
    this.status.fragments = this.fragments.size;
    const sessions = base.meta.sessions + other.meta.sessions;
    this.writing = this.write([{ id: base.meta.id, map, area, sessions, created: Math.min(base.meta.created, other.meta.created), body }], [other.meta.id]).finally(() => (this.writing = null));
  }

  // --- Live evidence bookkeeping --------------------------------------------------

  /**
   * The world model rebuilt or rewrote its grid behind our back (floor
   * correction, drift realignment, map aging, rescan): the restored-prior
   * bookkeeping is re-based on the evidence computed most recently.
   */
  private checkWorldEvents(src: LiveSource) {
    const cur = src.stamp();
    const prev = this.watch;
    this.watch = cur;
    if (!prev || sameStamp(prev, cur)) return;
    // Any job in flight was computing against the old grid.
    this.job = null;
    if (cur.hard !== prev.hard) {
      // "Rescan": the live map was wiped, restored rooms with it.
      if (this.links.length) this.log('live map reset: restored rooms dropped');
      this.links = [];
      this.tracker = null;
      this.evidence = null;
      this.hyps.clear();
      this.needRebase = false;
      return;
    }
    if (this.tracker) {
      // A floor relevel or drift realignment may have dropped (part of) the
      // restored maps (a realignment restores a snapshot from before them):
      // fill them in again where the grid now knows nothing. (Not after the
      // map was aged: that is the world model reacting to contradictions,
      // and the next check decides whether the restore stays.)
      this.needRebase = true;
      this.reapplyAfter = this.reapplyAfter || cur.soft === prev.soft;
      if (cur.soft !== prev.soft) this.reapplyAfter = false;
    }
  }
  private needRebase = false;
  private reapplyAfter = false;

  /**
   * Re-base the restored-map bookkeeping on the grid as the world model left
   * it (own evidence = the last computed), then fill the restored maps back
   * in where the grid now knows nothing.
   */
  private *rebaseJob(): Job {
    const src = this.source!;
    const tr = this.tracker;
    this.needRebase = false;
    if (!tr) return;
    const cur = yield* src.exportGen();
    if (!cur) return;
    const e = this.evidence?.map ?? tr.liveOnly;
    this.tracker = { liveOnly: e, base: cur };
    const reapply = this.reapplyAfter;
    this.reapplyAfter = false;
    this.log(`grid rewritten by the world model: re-based${reapply ? ', re-applying restored maps' : ''}`);
    if (!reapply || !this.links.length) return;
    const stamp = src.stamp();
    let g = cur;
    for (const l of this.links) {
      const f = this.fragments.get(l.fragment);
      const prior = f ? yield* this.priorGen(f, l.pose) : null;
      if (prior) g = yield* combinePriorGen(g, prior, 6, true);
    }
    if (!(yield* src.importGen(g, stamp.grid))) return;
    this.tracker = { liveOnly: e, base: g };
    this.watch = src.stamp();
    this.hooks.onMapChanged?.();
  }

  /** The session's own observations right now (stored maps excluded). Sliced. */
  private *evidenceGen(): Work<ChunkedMap | null> {
    const g = yield* this.source!.exportGen();
    if (!g) return null;
    const tr = this.tracker;
    const e = tr ? yield* liveEvidenceGen(g, tr.base, tr.liveOnly) : g;
    // The bookkeeping may have been re-based meanwhile (then this is stale).
    if (tr !== this.tracker) return null;
    this.evidence = { t: this.now, map: e };
    return e;
  }

  private computeEvidence(): ChunkedMap | null {
    return runToEnd(this.evidenceGen());
  }

  private *liveSearchData(e: ChunkedMap): Work<{ features: MapFeatures; lookup: FragmentLookup }> {
    const features = yield* extractFeaturesGen(e);
    const lookup = yield* FragmentLookup.create(e);
    return { features, lookup };
  }

  private *fragIndex(f: Frag): Work<FragmentIndex> {
    if (!f.index) {
      const features = yield* extractFeaturesGen(f.map);
      const lookup = yield* FragmentLookup.create(f.map);
      f.index = new FragmentIndex(features, lookup);
    }
    return f.index;
  }

  /** A fragment transformed into the live grid's frame and lattice (clipped to the grid). */
  private *priorGen(f: Frag, pose: Pose2): Work<ChunkedMap | null> {
    const lat = this.source!.lattice();
    if (!lat) return null;
    return yield* transformMapGen(f.map, invertPose(pose), lat, { i0: 0, k0: 0, i1: lat.nx, k1: lat.nz });
  }

  // --- Jobs ----------------------------------------------------------------------------

  /**
   * Fragments that keep saying no are searched less often (the global search
   * is the expensive part), unless the live map has grown a lot since.
   */
  private isDue(f: Frag, size: number): boolean {
    return this.hyps.has(f.meta.id) || this.now >= f.nextTry || size > f.triedAt * 1.3 + 400;
  }

  private *relocJob(unlinked: Frag[]): Job {
    const e = yield* this.evidenceGen();
    if (!e) return;
    const area = observedColumns(e) * e.res * e.res;
    if (area < this.opts.minSearchArea) return;
    const live = yield* this.liveSearchData(e);
    const at = live.features.bbox ? { x: (live.features.bbox.x0 + live.features.bbox.x1) / 2, z: (live.features.bbox.z0 + live.features.bbox.z1) / 2 } : { x: 0, z: 0 };
    const size = this.source!.observedColumns();
    const picks = unlinked.filter((f) => this.isDue(f, size)).sort((a, b) => a.lastTried - b.lastTried).slice(0, this.opts.perAttempt);
    for (const f of picks) {
      f.lastTried = this.now;
      if (!this.hyps.has(f.meta.id)) {
        f.triedAt = size;
        f.backoff = Math.min(32, f.backoff ? f.backoff * 2 : this.opts.attemptEvery);
        f.nextTry = this.now + f.backoff;
      }
      const index = yield* this.fragIndex(f);
      this.status.attempts++;
      // With a candidate already, re-check it (and its rivals) instead of searching again.
      const prev = this.hyps.get(f.meta.id);
      const r: RelocResult = yield* relocalize(live, index, prev ? { ...this.opts.reloc, hint: [prev.pose, ...prev.rivals] } : this.opts.reloc);
      this.lastResult.set(f.meta.id, r);
      const id = f.meta.id;
      const best = r.best;
      this.status.lastReason = `${id}: ${r.reason}`;
      if (!r.accepted || !best || !isFinitePose(best.pose)) {
        this.log(`${id}: no (${r.reason})`);
        // A clear "no" (not just "not enough data yet") resets the hypothesis.
        const h = this.hyps.get(id);
        if (h && (!best || poseDelta(best.pose, h.pose, at).dist > 0.15)) this.hyps.delete(id);
        continue;
      }
      if ((this.blocked.get(id) ?? []).some((p) => { const d = poseDelta(p, best.pose, at); return d.dist < 0.5 && d.dyaw < 0.17; })) {
        this.status.lastReason = `${id}: placement was undone earlier`;
        continue;
      }
      // Rooms already restored this session must agree with this one where
      // the two stored maps overlap (two maps claiming the same space with
      // different contents can't both be right).
      const clash = yield* this.clashWithLinks(f, index, best.pose);
      if (clash) {
        this.status.lastReason = `${id}: ${clash}`;
        this.log(`${id}: no (${clash})`);
        this.hyps.delete(id);
        continue;
      }
      const h = this.hyps.get(id);
      const occ = live.features.occTotal + live.features.freeTotal;
      const rivals = r.candidates.filter((p) => poseDelta(p, best.pose, at).dist > 0.3 || poseDelta(p, best.pose, at).dyaw > 0.09).slice(0, 4);
      const fresh = (): Hypothesis => ({ pose: best.pose, rivals, count: 1, t: this.now, occ });
      if (h) {
        const d = poseDelta(h.pose, best.pose, at);
        if (d.dist < 0.1 && d.dyaw < 0.035) {
          // Count it only with new evidence: a few seconds later, the live map changed.
          if (occ !== h.occ && this.now - h.t >= 3) {
            h.count++;
            h.pose = best.pose;
            h.t = this.now;
            h.occ = occ;
          }
        } else this.hyps.set(id, fresh());
      } else this.hyps.set(id, fresh());
      const hh = this.hyps.get(id)!;
      f.backoff = 0;
      f.nextTry = -Infinity;
      // Walls alone (bare rooms: little furniture seen) fit any room of the
      // same shape: ask for one more agreeing look.
      const need = this.opts.agree + ((best.metrics?.lowObjects ?? 0) < 2 ? 1 : 0);
      this.log(`${id}: candidate ${fmtPose(best.pose)} (${hh.count}/${need}) inlier ${best.metrics?.inlier.toFixed(2)} amb ${r.ambiguity.toFixed(2)}`);
      if (hh.count >= need) {
        this.hyps.delete(id);
        yield* this.restore(f, hh.pose, best.metrics ?? null, e);
        return; // the live grid changed: start the next job afresh
      }
      yield;
    }
  }

  /** Why placing fragment f at `pose` (live → f) contradicts a restored fragment, or null. */
  private *clashWithLinks(f: Frag, index: FragmentIndex, pose: Pose2): Work<string | null> {
    for (const l of this.links) {
      const pf = this.fragments.get(l.fragment);
      if (!pf || pf === f) continue;
      const pIndex = yield* this.fragIndex(pf);
      const T = composePose(l.pose, invertPose(pose)); // f → live → P
      const m = verifyPose({ features: index.features, lookup: index.lookup }, pIndex, T);
      yield;
      if (m.fwdKnown < 150) continue; // they don't overlap: neighbouring rooms
      const furnN = m.lowN + m.bwdLowN, furnBad = (m.lowConf + m.bwdLowConf) / Math.max(1, furnN);
      if (m.inlier < 0.75 || (furnN >= 100 && furnBad > 0.35)) return `contradicts restored ${l.fragment} (inlier ${m.inlier.toFixed(2)})`;
    }
    return null;
  }

  /** Restore fragment f into the live grid at `pose` (live → fragment); `e` = the session's own evidence. */
  private *restore(f: Frag, pose: Pose2, metrics: VerifyMetrics | null, e: ChunkedMap): Work<void> {
    const src = this.source!;
    const stamp = src.stamp();
    const prior = yield* this.priorGen(f, pose);
    const g = yield* src.exportGen();
    if (!prior || !g) return;
    const merged = yield* combinePriorGen(g, prior);
    // Only if nothing rewrote the grid meanwhile (a later attempt will retry).
    if (!sameStamp(stamp, src.stamp()) || !(yield* src.importGen(merged, stamp.grid))) return;
    // Right after the import the grid is exactly `merged`.
    this.tracker = { liveOnly: e, base: merged };
    this.watch = src.stamp();
    this.links.push({ fragment: f.meta.id, pose, since: this.now, good: 0, bad: 0, confirmed: false, last: metrics });
    this.nextVerify = this.now + this.opts.verifyEvery;
    this.status.restores++;
    this.status.state = 'restored';
    const area = observedColumns(prior) * prior.res * prior.res;
    this.log(`restored ${f.meta.id} at ${fmtPose(pose)} (${area.toFixed(1)} m²)`);
    this.hooks.onMapChanged?.();
    this.hooks.onRestored?.({ fragment: f.meta.id, area, pose });
  }

  private *verifyJob(): Job {
    const e = yield* this.evidenceGen();
    if (!e) return;
    const live = yield* this.liveSearchData(e);
    for (const link of [...this.links]) {
      const f = this.fragments.get(link.fragment);
      if (!f) continue;
      const index = yield* this.fragIndex(f);
      const m = verifyPose(live, index, link.pose);
      link.last = m;
      const conf = m.fwdConf + m.bwdConf + m.freeConf;
      const ok = m.inlier >= 0.75 && conf < Math.max(80, 0.2 * (m.fwdHit + m.bwdHit));
      if (ok) {
        link.good++;
        link.bad = 0;
        if (!link.confirmed && link.good >= this.opts.confirmChecks && this.now - link.since >= this.opts.confirmAfter) {
          link.confirmed = true;
          this.log(`${link.fragment}: restore confirmed`);
          this.nextSave = Math.min(this.nextSave, this.now);
        }
      } else {
        link.bad++;
        this.log(`${link.fragment}: check failed (inlier ${m.inlier.toFixed(2)}, ${conf} conflicts) ${link.bad}/${this.opts.undoAfter}`);
        if (link.bad >= this.opts.undoAfter) {
          yield* this.undoGen(link, `inlier ${m.inlier.toFixed(2)}`, e);
          return;
        }
      }
      yield;
    }
  }

  /** Take a restore back: the live grid returns to the session's own observations (+ other restores). */
  undo(link: Link, reason: string): void {
    runToEnd(this.undoGen(link, reason, null));
  }

  private *undoGen(link: Link, reason: string, evidence: ChunkedMap | null): Work<void> {
    const src = this.source;
    this.links = this.links.filter((l) => l !== link);
    this.absorbed.delete(link.fragment);
    const bl = this.blocked.get(link.fragment) ?? [];
    bl.push(link.pose);
    this.blocked.set(link.fragment, bl);
    this.status.undos++;
    // If it had been written into storage, put the stored version back on the next save.
    if (link.confirmed) this.restoreStored.add(link.fragment);
    if (src && src.ready) {
      const stamp = src.stamp();
      const e = evidence ?? (yield* this.evidenceGen());
      if (e) {
        let g = e;
        for (const l of this.links) {
          const f = this.fragments.get(l.fragment);
          const prior = f ? yield* this.priorGen(f, l.pose) : null;
          if (prior) g = yield* combinePriorGen(g, prior);
        }
        if (sameStamp(stamp, src.stamp()) && (yield* src.importGen(g, stamp.grid))) {
          this.tracker = this.links.length ? { liveOnly: e, base: g } : null;
          this.watch = src.stamp();
          this.hooks.onMapChanged?.();
        }
      }
    }
    this.log(`undid ${link.fragment}: ${reason}`);
    this.hooks.onUndone?.({ fragment: link.fragment, reason });
  }
  private restoreStored = new Set<string>();

  private *saveJob(): Job {
    if (!this.store) return;
    const e = yield* this.evidenceGen();
    if (!e) return;
    const writes: Write[] = [];
    const deletes: string[] = [];
    // Fragments to put back as they were (a confirmed restore was undone).
    for (const id of this.restoreStored) {
      const f = this.fragments.get(id);
      if (f) writes.push({ id, map: f.map, area: f.meta.area, sessions: f.meta.sessions });
    }
    this.restoreStored.clear();
    const confirmed = this.links.filter((l) => l.confirmed);
    if (confirmed.length) {
      const P = confirmed[0];
      const pf = this.fragments.get(P.fragment)!;
      let map = pf.map;
      // Stitch the other confirmed fragments into the first (through the live frame).
      for (const Q of confirmed.slice(1)) {
        const qf = this.fragments.get(Q.fragment);
        if (!qf) continue;
        const T = composePose(P.pose, invertPose(Q.pose)); // Q → live → P
        map = yield* fuseEvidenceGen(map, yield* transformMapGen(qf.map, T, map));
        deletes.push(Q.fragment);
        this.absorbed.add(Q.fragment);
      }
      map = yield* fuseEvidenceGen(map, yield* transformMapGen(e, P.pose, map));
      const first = !this.sessionCounted.has(P.fragment);
      this.sessionCounted.add(P.fragment);
      writes.push({ id: P.fragment, map, area: observedColumns(map) * map.res * map.res, sessions: pf.meta.sessions + (first ? 1 : 0), created: pf.meta.created });
      if (this.ownSaved) deletes.push(this.sessionId);
    } else {
      const area = observedColumns(e) * e.res * e.res;
      if (area >= this.opts.minSaveArea) writes.push({ id: this.sessionId, map: e, area, sessions: 1 });
    }
    if (!writes.length && !deletes.length) return;
    // Serialize here, in slices; compression and storage are asynchronous.
    for (const wr of writes) wr.body = yield* encodeBody(wr.map);
    this.writing = this.write(writes, deletes).finally(() => (this.writing = null));
  }

  private async write(writes: Write[], deletes: string[]) {
    const store = this.store!;
    for (const wr of writes) {
      const t0 = performance.now();
      const encoded = wr.body ? await packBody(wr.body) : undefined;
      const meta = await store.save(wr.id, wr.map, { area: wr.area, sessions: wr.sessions, created: wr.created }, encoded);
      if (!meta) {
        this.status.lastError = store.lastError;
        this.log(`save failed: ${store.lastError}`);
        continue;
      }
      if (wr.id === this.sessionId) this.ownSaved = true;
      // Keep the loaded (pristine) map for fragments in use; update metadata.
      const f = this.fragments.get(wr.id);
      if (f) f.meta = meta;
      this.status.saves++;
      this.hooks.onSaved?.({ fragment: wr.id, bytes: meta.bytes, ms: performance.now() - t0 });
    }
    for (const id of deletes) {
      await store.remove(id);
      if (id === this.sessionId) this.ownSaved = false;
    }
    this.status.storedBytes = store.totalBytes;
  }

  /** Save now (page hidden / leaving). Resolves when written. */
  async flush(): Promise<void> {
    if (!this.store || !this.source?.ready) return;
    if (this.writing) await this.writing.catch(() => undefined);
    this.job = null;
    await this.runAsync(this.saveJob());
    if (this.writing) await (this.writing as Promise<void>).catch(() => undefined);
  }

  /** Run a job to completion, letting other work (messages from the page) in while the source is waiting. */
  private async runAsync<T>(g: Work<T>): Promise<T> {
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      if (this.source?.waiting) await new Promise((res) => setTimeout(res, 2));
    }
  }

  /** Forget every stored map, and take back anything restored into the live map. */
  async forget(): Promise<boolean> {
    this.job = null;
    for (const l of [...this.links]) await this.runAsync(this.undoGen(l, 'forgotten', null));
    this.blocked.clear();
    this.hyps.clear();
    this.fragments.clear();
    this.absorbed.clear();
    this.restoreStored.clear();
    this.ownSaved = false;
    this.job = null;
    this.status.fragments = 0;
    // Don't save the current session straight back either.
    this.nextSave = this.now + this.opts.saveEvery;
    const ok = this.store ? await this.store.clear() : true;
    this.status.storedBytes = 0;
    return ok;
  }

  /** The session's own evidence (diagnostics, harness). */
  sessionEvidence(): ChunkedMap | null {
    return this.source?.ready ? this.computeEvidence() : null;
  }
}

function fmtPose(p: Pose2): string {
  return `(${p.tx.toFixed(2)}, ${p.tz.toFixed(2)}, ${((p.yaw * 180) / Math.PI).toFixed(1)}°${p.dj ? `, ${p.dj} layer` : ''})`;
}

export { MapStore };

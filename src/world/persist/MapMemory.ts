import type { WorldModel } from '../WorldModel';
import { exportLive, importLive, liveLattice } from './adapter';
import { observedColumns, type ChunkedMap } from './ChunkedMap';
import { extractFeatures, FragmentLookup, type MapFeatures } from './features';
import { MapStore, type FragmentMeta } from './MapStore';
import { composePose, invertPose, isFinitePose, poseDelta, type Pose2 } from './pose';
import { FragmentIndex, relocalize, verifyPose, type RelocOptions, type RelocResult, type VerifyMetrics } from './Relocalizer';
import { combinePrior, fuseEvidence, liveEvidence, transformMap } from './Stitcher';

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
  log?(msg: string): void;
}

export interface MemoryOptions {
  /** Seconds between relocalization attempts. */
  attemptEvery: number;
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
  verifyEvery: 5,
  saveEvery: 30,
  agree: 2,
  confirmAfter: 25,
  confirmChecks: 3,
  undoAfter: 2,
  minSaveArea: 1.5,
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

export class MapMemory {
  readonly opts: MemoryOptions;
  readonly fragments = new Map<string, Frag>();
  links: Link[] = [];
  readonly sessionId: string;
  private world: WorldModel | null = null;
  private job: Job | null = null;
  private jobName = '';
  private tracker: { liveOnly: ChunkedMap; base: ChunkedMap } | null = null;
  private evidence: { t: number; map: ChunkedMap } | null = null;
  private hyps = new Map<string, Hypothesis>();
  private blocked = new Map<string, Pose2[]>();
  private nextAttempt = 0;
  private nextVerify = 0;
  private nextSave = 0;
  private watch: { grid: unknown; epoch: number; hard: number; other: number } | null = null;
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
      this.fragments.set(meta.id, { meta, map, index: null, lastTried: -Infinity });
    }
    this.status.fragments = this.fragments.size;
    this.status.storedBytes = this.store.totalBytes;
    this.status.lastError = this.store.lastError;
    this.status.state = 'idle';
  }

  attach(world: WorldModel): void {
    this.world = world;
    this.watch = null;
  }

  get restored(): boolean {
    return this.links.length > 0;
  }

  private log(msg: string) {
    this.hooks.log?.(msg);
  }

  /** Run background work for up to `budgetMs` (call every frame). */
  tick(now: number, budgetMs = 3): void {
    const t0 = performance.now();
    this.now = now;
    try {
      const w = this.world;
      if (!w || !w.grid) return;
      this.checkWorldEvents(w);
      if (!this.job) this.job = this.nextJob(now);
      while (this.job) {
        const r = this.job.next();
        if (r.done) {
          this.job = null;
          break;
        }
        if (performance.now() - t0 >= budgetMs) break;
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
    if (this.links.length && now >= this.nextVerify) {
      this.nextVerify = now + this.opts.verifyEvery;
      this.jobName = 'verify';
      return this.verifyJob();
    }
    const unlinked = [...this.fragments.values()].filter((f) => !this.links.some((l) => l.fragment === f.meta.id) && f.meta.id !== this.sessionId && !this.absorbed.has(f.meta.id));
    if (unlinked.length && now >= this.nextAttempt) {
      this.nextAttempt = now + this.opts.attemptEvery;
      this.jobName = 'relocalize';
      return this.relocJob(unlinked);
    }
    if (this.store && now >= this.nextSave && !this.writing) {
      this.nextSave = now + this.opts.saveEvery;
      this.jobName = 'save';
      return this.saveJob();
    }
    return null;
  }

  // --- Live evidence bookkeeping --------------------------------------------------

  /**
   * The world model rebuilt or rewrote its grid behind our back (floor
   * correction, drift realignment, map aging, rescan): the restored-prior
   * bookkeeping is re-based on the evidence computed most recently.
   */
  private checkWorldEvents(w: WorldModel) {
    const rec = w.recoveries;
    const cur = { grid: w.grid, epoch: w.epoch, hard: rec.hard, other: rec.relevel + rec.soft + rec.realign };
    const prev = this.watch;
    this.watch = cur;
    if (!prev) return;
    if (prev.grid === cur.grid && prev.epoch === cur.epoch && prev.hard === cur.hard && prev.other === cur.other) return;
    // Any job in flight was computing against the old grid.
    this.job = null;
    if (cur.hard !== prev.hard) {
      // "Rescan": the live map was wiped, restored rooms with it.
      if (this.links.length) this.log('live map reset: restored rooms dropped');
      this.links = [];
      this.tracker = null;
      this.evidence = null;
      this.hyps.clear();
      return;
    }
    if (this.tracker) {
      const g = exportLive(w);
      if (!g) return;
      this.tracker = { liveOnly: this.evidence?.map ?? this.tracker.liveOnly, base: g };
      this.log('grid rewritten by the world model: re-based restored-map bookkeeping');
    }
  }

  /** The session's own observations right now (stored maps excluded). */
  private computeEvidence(): ChunkedMap | null {
    const g = exportLive(this.world!);
    if (!g) return null;
    const e = this.tracker ? liveEvidence(g, this.tracker.base, this.tracker.liveOnly) : g;
    this.evidence = { t: this.now, map: e };
    return e;
  }

  private liveSearchData(e: ChunkedMap): { features: MapFeatures; lookup: FragmentLookup } {
    return { features: extractFeatures(e), lookup: new FragmentLookup(e) };
  }

  // --- Jobs ----------------------------------------------------------------------------

  private *relocJob(unlinked: Frag[]): Job {
    const e = this.computeEvidence();
    if (!e) return;
    const area = observedColumns(e) * e.res * e.res;
    if (area < this.opts.minSearchArea) return;
    yield;
    const live = this.liveSearchData(e);
    yield;
    const at = live.features.bbox ? { x: (live.features.bbox.x0 + live.features.bbox.x1) / 2, z: (live.features.bbox.z0 + live.features.bbox.z1) / 2 } : { x: 0, z: 0 };
    const picks = unlinked.sort((a, b) => a.lastTried - b.lastTried).slice(0, this.opts.perAttempt);
    for (const f of picks) {
      f.lastTried = this.now;
      if (!f.index) {
        f.index = new FragmentIndex(extractFeatures(f.map), new FragmentLookup(f.map));
        yield;
      }
      this.status.attempts++;
      const r: RelocResult = yield* relocalize(live, f.index, this.opts.reloc);
      this.lastResult.set(f.meta.id, r);
      const id = f.meta.id;
      const best = r.best;
      this.status.lastReason = `${id}: ${r.reason}`;
      if (!r.accepted || !best || !isFinitePose(best.pose)) {
        // A clear "no" (not just "not enough data yet") resets the hypothesis.
        const h = this.hyps.get(id);
        if (h && best && poseDelta(best.pose, h.pose, at).dist > 0.15) this.hyps.delete(id);
        continue;
      }
      if ((this.blocked.get(id) ?? []).some((p) => { const d = poseDelta(p, best.pose, at); return d.dist < 0.5 && d.dyaw < 0.17; })) {
        this.status.lastReason = `${id}: placement was undone earlier`;
        continue;
      }
      const h = this.hyps.get(id);
      const occ = live.features.occTotal;
      if (h) {
        const d = poseDelta(h.pose, best.pose, at);
        if (d.dist < 0.1 && d.dyaw < 0.035) {
          // Count it only with new evidence (the live map grew since).
          if (occ >= h.occ * 1.05 + 20 && this.now - h.t >= 2) {
            h.count++;
            h.pose = best.pose;
            h.t = this.now;
            h.occ = occ;
          }
        } else this.hyps.set(id, { pose: best.pose, count: 1, t: this.now, occ });
      } else this.hyps.set(id, { pose: best.pose, count: 1, t: this.now, occ });
      const hh = this.hyps.get(id)!;
      this.log(`${id}: candidate ${fmtPose(best.pose)} (${hh.count}/${this.opts.agree}) inlier ${best.metrics?.inlier.toFixed(2)} amb ${r.ambiguity.toFixed(2)}`);
      if (hh.count >= this.opts.agree) {
        this.hyps.delete(id);
        this.restore(f, hh.pose, best.metrics ?? null);
        return; // the live grid changed: start the next job afresh
      }
      yield;
    }
  }

  /** Restore fragment f into the live grid at `pose` (live → fragment). */
  private restore(f: Frag, pose: Pose2, metrics: VerifyMetrics | null): void {
    const w = this.world!;
    const lat = liveLattice(w);
    const g = exportLive(w);
    if (!lat || !g) return;
    const e = this.computeEvidence()!;
    const prior = transformMap(f.map, invertPose(pose), lat, { i0: 0, k0: 0, i1: lat.nx, k1: lat.nz });
    const merged = combinePrior(g, prior);
    if (!importLive(w, merged)) return;
    this.tracker = { liveOnly: e, base: exportLive(w)! };
    this.watch = { grid: w.grid, epoch: w.epoch, hard: w.recoveries.hard, other: w.recoveries.relevel + w.recoveries.soft + w.recoveries.realign };
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
    const e = this.computeEvidence();
    if (!e) return;
    yield;
    const live = this.liveSearchData(e);
    yield;
    for (const link of [...this.links]) {
      const f = this.fragments.get(link.fragment);
      if (!f) continue;
      if (!f.index) {
        f.index = new FragmentIndex(extractFeatures(f.map), new FragmentLookup(f.map));
        yield;
      }
      const m = verifyPose(live, f.index, link.pose);
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
        if (link.bad >= this.opts.undoAfter) this.undo(link, `inlier ${m.inlier.toFixed(2)}`);
      }
      yield;
    }
  }

  /** Take a restore back: the live grid returns to the session's own observations (+ other restores). */
  undo(link: Link, reason: string): void {
    const w = this.world;
    this.links = this.links.filter((l) => l !== link);
    this.absorbed.delete(link.fragment);
    const bl = this.blocked.get(link.fragment) ?? [];
    bl.push(link.pose);
    this.blocked.set(link.fragment, bl);
    this.status.undos++;
    if (w && w.grid) {
      const e = this.computeEvidence();
      const lat = liveLattice(w);
      if (e && lat) {
        let g = e;
        for (const l of this.links) {
          const f = this.fragments.get(l.fragment);
          if (f) g = combinePrior(g, transformMap(f.map, invertPose(l.pose), lat, { i0: 0, k0: 0, i1: lat.nx, k1: lat.nz }));
        }
        importLive(w, g);
        this.tracker = this.links.length ? { liveOnly: e, base: exportLive(w)! } : null;
        this.watch = { grid: w.grid, epoch: w.epoch, hard: w.recoveries.hard, other: w.recoveries.relevel + w.recoveries.soft + w.recoveries.realign };
        this.hooks.onMapChanged?.();
      }
    }
    // If it had been written into storage, put the stored version back on the next save.
    if (link.confirmed) this.restoreStored.add(link.fragment);
    this.log(`undid ${link.fragment}: ${reason}`);
    this.hooks.onUndone?.({ fragment: link.fragment, reason });
  }
  private restoreStored = new Set<string>();

  private *saveJob(): Job {
    if (!this.store) return;
    const e = this.computeEvidence();
    if (!e) return;
    yield;
    const writes: { id: string; map: ChunkedMap; area: number; sessions: number; created?: number }[] = [];
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
        map = fuseEvidence(map, transformMap(qf.map, T, map));
        yield;
        deletes.push(Q.fragment);
        this.absorbed.add(Q.fragment);
      }
      map = fuseEvidence(map, transformMap(e, P.pose, map));
      yield;
      const first = !this.sessionCounted.has(P.fragment);
      this.sessionCounted.add(P.fragment);
      writes.push({ id: P.fragment, map, area: observedColumns(map) * map.res * map.res, sessions: pf.meta.sessions + (first ? 1 : 0), created: pf.meta.created });
      if (this.ownSaved) deletes.push(this.sessionId);
    } else {
      const area = observedColumns(e) * e.res * e.res;
      if (area >= this.opts.minSaveArea) {
        writes.push({ id: this.sessionId, map: e, area, sessions: 1 });
      }
    }
    if (!writes.length && !deletes.length) return;
    this.writing = this.write(writes, deletes).finally(() => (this.writing = null));
  }

  private async write(writes: { id: string; map: ChunkedMap; area: number; sessions: number; created?: number }[], deletes: string[]) {
    const store = this.store!;
    for (const wr of writes) {
      const t0 = performance.now();
      const meta = await store.save(wr.id, wr.map, { area: wr.area, sessions: wr.sessions, created: wr.created });
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
    if (!this.store || !this.world?.grid) return;
    if (this.writing) await this.writing.catch(() => undefined);
    this.job = null;
    const g = this.saveJob();
    for (let r = g.next(); !r.done; r = g.next());
    if (this.writing) await (this.writing as Promise<void>).catch(() => undefined);
  }

  /** Forget every stored map, and take back anything restored into the live map. */
  async forget(): Promise<boolean> {
    for (const l of [...this.links]) this.undo(l, 'forgotten');
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
    return this.world?.grid ? this.computeEvidence() : null;
  }
}

function fmtPose(p: Pose2): string {
  return `(${p.tx.toFixed(2)}, ${p.tz.toFixed(2)}, ${((p.yaw * 180) / Math.PI).toFixed(1)}°${p.dj ? `, ${p.dj} layer` : ''})`;
}

export { MapStore };

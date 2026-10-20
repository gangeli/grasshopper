import type { WorldModel } from './WorldModel';

/**
 * Watches for the tracking frame sliding against the map (slow drift, or a
 * relocalisation jump the platform didn't fix through anchors) and corrects
 * it. Every `interval` seconds it asks the world model how recent depth lines
 * up with the map; a correction is applied only when it is well supported
 * (many readings land on known surfaces after it, far more than without it)
 * and two consecutive estimates agree, so a few stray readings in a
 * half-mapped area can't yank the map around.
 */
export interface DriftOptions {
  interval: number;
  minPoints: number;
  /** Share of readings on known surfaces after the correction. */
  minSupport: number;
  /** Support after / support before (before floored at 10% of the readings). */
  minRatio: number;
  /** Two consecutive estimates must agree to within this (m, at ±1m around the camera). */
  agree: number;
  /** Ignore corrections smaller than this (m, at ±1m around the camera). */
  minCorrection: number;
  /** Largest shift searched without a recent tracking loss (drift-sized). */
  maxDriftShift: number;
  /** Seconds after a tracking loss/recovery during which big jumps are searched for. */
  eventWindow: number;
  /**
   * Loop closure: the camera is back where it mapped a while ago (structure
   * not re-observed for `loopMinAge` s) and the odometry has drifted since.
   * Searched up to loopMaxShift / loopMaxYaw; 0 shift turns it off.
   */
  loopMinAge: number;
  loopMaxShift: number;
  loopMaxYaw: number;
  /** A first loop-closure estimate waits this long (s) for a second, agreeing one. */
  loopPendingSeconds: number;
  /** Resolve a hold on one clear-cut estimate (otherwise two agreeing ones, or one undoing a pose jump). */
  holdSingle: boolean;
  loopMinPoints: number;
  /** Share of the readings that land on that older structure after the correction. */
  loopMinSupport: number;
  /** Also correct what was mapped since the old structure (see WorldModel.warpSince). */
  loopWarp: boolean;
  /**
   * The tracker corrected itself (its pose jumped, PoseGate.lastJump) and
   * the view now lines up with older structure: move what was mapped in
   * between by its share of the jump (the tracker closed a loop we hadn't).
   */
  jumpWarp: boolean;
  /**
   * Loop closure against place memory (submaps of one earlier visit, see
   * PlaceMemory) instead of the voxel map's old structure (which holds every
   * drifted copy of a wall).
   */
  placeLoop: boolean;
  /**
   * Place-memory estimates: share of all the readings that must land on the
   * visit after the correction (the current view usually overlaps an old
   * visit only partly: estimates that proved right had 10–60%).
   */
  placeMinSupport: number;
  /** Place loops: the best correction must beat any distinct one by this factor. */
  loopUnique: number;
  /** Held frames are matched against place memory first (the voxel map's old structure if that finds nothing). */
  placeHold: boolean;
  /** Relocalisation against a dormant map (see WorldModel.detachMap): search range. */
  relocMaxShift: number;
  relocMaxYaw: number;
}

export const DEFAULT_DRIFT: DriftOptions = { interval: 1, minPoints: 500, minSupport: 0.5, minRatio: 2, agree: 0.1, minCorrection: 0.04, maxDriftShift: 0.2, eventWindow: 20, loopMinAge: 15, loopMaxShift: 0.6, loopMaxYaw: 0.18, loopPendingSeconds: 8, holdSingle: false, loopMinPoints: 300, loopMinSupport: 0.4, loopWarp: true, jumpWarp: false, placeLoop: true, placeMinSupport: 0.15, loopUnique: 1.3, relocMaxShift: 1.0, relocMaxYaw: 0.3, placeHold: false };

type Est = NonNullable<ReturnType<WorldModel['estimateMisalignment']>>;

export class DriftMonitor {
  readonly opts: DriftOptions;
  private lastT = -Infinity;
  private pending: { m: Est; t: number; wt: number } | null = null;
  corrections = 0;
  /** Last decision, for HUD/debugging. */
  last: { t: number; m: Est | null; fired: boolean; why?: string } | null = null;
  /** Recent decisions (debugging/tests). */
  readonly trace: string[] = [];
  private note(why: string) {
    if (this.last) this.last.why = why;
    this.trace.push(`${this.lastT.toFixed(1)} ${why}`);
    if (this.trace.length > 400) this.trace.shift();
  }
  constructor(readonly world: WorldModel, opts: Partial<DriftOptions> = {}) {
    this.opts = { ...DEFAULT_DRIFT, ...opts };
  }

  /** Returns true if the map frame was corrected. */
  update(t: number): boolean {
    if (t - this.lastT < this.opts.interval && t >= this.lastT) return false;
    this.lastT = t;
    const ev = this.world.eventSnapshot;
    const sinceEvent = this.world.now - this.world.lastTrackingEvent;
    const inEvent = !!ev && sinceEvent < this.opts.eventWindow;
    // A new loss inside the window can move the frame again: earlier looks
    // (for or against a jump) describe the frame before it.
    const newEvent = this.world.lastTrackingEvent !== this.seenEvent;
    this.seenEvent = this.world.lastTrackingEvent;
    if (inEvent && (!this.inWindow || newEvent)) {
      this.contra = 0;
      this.contraMag = 0;
      this.contradicted = false;
      this.votes = [];
      this.against = 0;
      this.eventSeen = [];
    }
    this.inWindow = inEvent;
    this.inEvent = inEvent && !this.contradicted;
    if (this.task) return this.resume(); // the previous check is still running
    if (this.world.warpBusy) return false; // the map is being moved: estimates would mix before and after
    this.turn++;
    // Frames are being held back as contradicting the map: find their correction first.
    if (this.world.heldSince !== null) this.task = this.resolving(t);
    // A map put aside after a jump we couldn't resolve: look for where we are in it.
    else if (this.world.dormant && this.turn % 4 === 0) this.task = this.relocating(t);
    // Every other check looks for a loop closure (also while judging a
    // tracking loss: losses are frequent when walking around a home).
    else if (this.opts.loopMaxShift > 0 && this.turn % 2 === 1 && this.loopWorthIt()) this.task = this.closing(t);
    else if (this.inEvent) this.task = this.afterEvent(t);
    else if (inEvent) return false; // contradicted: waiting for the verdict to be taken
    else this.task = this.drifting(t);
    return this.resume();
  }

  /**
   * Milliseconds of searching per call: checks are resumable, so in the app
   * they can be spread over several frames instead of stalling one. Infinite
   * (the default) runs each check to completion right away.
   */
  budgetMs = Infinity;
  /**
   * Alternatively a fixed number of search steps per call (deterministic:
   * benchmarks use it to pace checks like a phone would, independent of the
   * machine's speed). Takes precedence over budgetMs when finite.
   */
  budgetSteps = Infinity;
  private task: Generator<void, boolean, void> | null = null;
  /** A check is in progress (call resume() each frame). */
  get busy(): boolean {
    return this.task !== null;
  }
  /** Continue a check in progress; true if it finished by realigning the map. */
  resume(): boolean {
    const task = this.task;
    if (!task) return false;
    const steps = this.budgetSteps;
    const until = Number.isFinite(steps) ? Infinity : Number.isFinite(this.budgetMs) ? performance.now() + this.budgetMs : Infinity;
    let n = 0;
    for (;;) {
      const r = task.next();
      if (r.done) {
        this.task = null;
        return r.value;
      }
      if (++n >= steps || performance.now() >= until) return false;
    }
  }
  private seenEvent = -Infinity;
  /** Inside the post-loss window (even if the event was already settled early). */
  private inWindow = false;
  /** Currently checking for a jump after a tracking loss. */
  inEvent = false;
  /** Just after a loss, or a jump looks likely and nothing says the map still fits. */
  get suspicious(): boolean {
    if (!this.inEvent) return false;
    // A jump vote keeps it suspicious only while votes keep coming.
    const lastVote = this.votes.length ? this.votes[this.votes.length - 1].t : -Infinity;
    return this.world.now - this.world.lastTrackingEvent < 4 || (this.votes.length > 0 && this.against === 0 && this.lastT - lastVote < 6);
  }

  /**
   * Just after tracking was lost and recovered: did the frame jump? Compare
   * the new data with the map as it was before the loss (no contamination),
   * over a wide search range, and if two looks agree, realign everything
   * since the loss.
   */
  private *afterEvent(t: number): Generator<void, boolean, void> {
    const O = this.opts;
    let m: Est | null = yield* this.world.misalignmentSearch({ maxShift: 0.5, maxYaw: 0.1, snapshot: 'event' });
    // The snapshot taken at the loss is gone once the window moves (or never
    // existed): look for the frames since the loss in place memory instead
    // (wide: a relocalisation can be off by a lot).
    let place: (Est & { unique: number; constraint: number }) | null = null;
    if (!m && O.placeLoop) {
      place = yield* this.world.placeSearch({ since: this.world.lastTrackingEvent, minAge: 0.5, maxShift: O.relocMaxShift, maxYaw: O.relocMaxYaw, penalty: 0.005, frames: 60, span: 6 });
      m = place;
    }
    this.last = { t, m, fired: false };
    if (!m) {
      this.note('event: no estimate yet');
      return false;
    }
    // Place estimates count support over all readings (not only those near old structure) and have their own ambiguity tests.
    const clear = !place || (place.unique >= O.loopUnique && place.best >= O.placeMinSupport * place.n);
    // Only looks that line up with known structure somehow say anything:
    // nothing matching at any shift is new territory, not a contradiction.
    // (Place looks: how much of the best fit holds without the correction.)
    if (place) {
      if (m.best >= O.placeMinSupport * m.n && clear) this.eventSeen.push(m.base / m.best);
    } else if (m.n && m.best >= 0.2 * m.n) this.eventSeen.push(m.base / m.n);
    // Look after look, the map as it stands fits nothing while a shifted map
    // fits clearly: no need to wait out the window to know the map is off.
    // (Readings landing in space the old map saw clearly empty count even when
    // the right correction can't be pinned down.)
    const intoFree = m.n >= 100 && m.base <= -0.12 * m.n;
    if (intoFree || (!m.degenerate && clear && m.n >= 100 && m.best >= 0.2 * m.n && m.base <= (place ? 0.1 : 0.05) * m.n && displacement(m, null) >= O.minCorrection)) {
      this.contra++;
      this.contraMag = Math.max(this.contraMag, displacement(m, null));
    } else if (m.n >= 100 && m.base >= 0.3 * m.n) this.contra = 0;
    if (this.contra >= 6 && this.world.now - this.world.lastTrackingEvent >= 4) {
      this.contradicted = true;
      this.note(`event: map contradicted by ${this.contra} looks in a row (~${(this.contraMag * 100).toFixed(0)}cm)`);
      return false;
    }
    const mag = displacement(m, null);
    const ok = place ? !m.degenerate && clear && m.n >= O.loopMinPoints && m.best >= O.minRatio * Math.max(m.base, 0.05 * m.n) : !m.degenerate && m.n >= O.minPoints && m.best >= O.minSupport * m.n && m.best >= O.minRatio * Math.max(m.base, 0.1 * m.n);
    // A confident "nothing moved" (most readings on known surfaces as they are) votes against a jump.
    if (!m.degenerate && m.n >= 800 && m.base >= 0.6 * m.n && mag < O.minCorrection) this.against++;
    // Fewer readings, but the old map plainly doesn't fit where it is and does
    // fit shifted: a weaker vote, so it takes more of them agreeing.
    const weak = !ok && !place && !m.degenerate && m.n >= 150 && m.best >= 0.3 * m.n && m.best >= 4 * Math.max(m.base, 0.05 * m.n);
    if ((!ok && !weak) || mag < O.minCorrection) {
      this.note(`event: ${ok ? "aligned" : "unsure"}${place ? ` (place uniq ${place.unique.toFixed(2)} c ${place.constraint.toFixed(3)})` : ''}${m.degenerate ? " (degenerate)" : ""} contra ${this.contra} n ${m.n} base ${m.base} best ${m.best} mag ${(mag * 100).toFixed(0)}cm`);
      return false;
    }
    // Votes: estimates from different moments that agree on the same correction.
    const agreeing = this.votes.filter((v) => t - v.t >= 0.9 && displacement(m, v.m) <= O.agree);
    this.votes.push({ m, t, weak });
    const strong = agreeing.filter((v) => !v.weak).length + (weak ? 0 : 1);
    const enough = strong >= 2 || agreeing.length + 1 >= 4;
    if (enough && agreeing.length + 1 > this.against) {
      this.world.realign(m.dx, m.dz, m.dyaw, m.pivot, Math.min(this.world.eventSnapshot?.t ?? Infinity, this.world.lastTrackingEvent) - 0.5);
      this.votes = [];
      this.against = 0;
      this.corrections++;
      this.last.fired = true;
      this.eventSeen = [];
      this.note(`event: REALIGNED ${(mag * 100).toFixed(0)}cm (${agreeing.length + 1} votes)`);
      return true;
    }
    this.note(`event: ${weak ? 'weak ' : ''}vote ${(mag * 100).toFixed(0)}cm (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n} (agreeing ${agreeing.length}, against ${this.against})`);
    return false;
  }
  private votes: { m: Est; t: number; weak: boolean }[] = [];
  private contra = 0;
  private contraMag = 0;
  private contradicted = false;
  private against = 0;

  /** Share of post-event readings that matched the pre-event map without correction (per check). */
  private eventSeen: number[] = [];

  /**
   * After an event window with no realignment: was the map mostly
   * contradicting what we saw (low support in well-observed views)? Then the
   * frame probably jumped in a way we couldn't pin down.
   */
  eventVerdict(): { verdict: 'fine' | 'unresolved' | 'unknown'; mag: number } {
    const v = this.eventSeen, votes = this.votes, against = this.against;
    this.eventSeen = [];
    this.votes = [];
    this.against = 0;
    const contradicted = this.contradicted, contraMag = this.contraMag;
    this.contra = 0;
    this.contraMag = 0;
    const sure = votes.filter((x) => !x.weak);
    // Size of the likely jump (weak looks count here: they pick how hard to reset, not whether to).
    const mag = votes.length ? Math.max(...votes.map((x) => displacement(x.m, null))) : 0;
    // Repeated confident jump estimates that never agreed enough to fix, with
    // nothing confidently saying the map still fits: stop trusting the old map.
    if (sure.length >= 2 && against === 0) return { verdict: 'unresolved', mag };
    if (contradicted) return { verdict: 'unresolved', mag: Math.max(mag, contraMag) };
    if (v.length < 4) return { verdict: 'unknown', mag };
    const sorted = v.slice().sort((a, b) => a - b);
    return { verdict: sorted[sorted.length >> 1] < 0.2 ? 'unresolved' : 'fine', mag };
  }

  private turn = 0;
  /**
   * A loop-closure estimate waiting for a second, agreeing one. Kept across
   * checks that see nothing usable (old structure goes in and out of view
   * while walking), until it is too old, the frame was corrected meanwhile,
   * or a confident check finds the map aligned.
   */
  private pendingLoop: { m: Est; t: number; wt: number; corr: number } | null = null;
  /** Loop closures applied. */
  loopClosures = 0;

  /**
   * Back in a place mapped a while ago? Match the recent frames against the
   * structure that predates them by loopMinAge seconds (what the camera
   * added since may be in a drifted frame); two agreeing, well-supported
   * estimates realign everything since just before the first.
   */
  private pendingHold: { m: Est; t: number; since: number } | null = null;
  /** Corrections found for held-back frames (see WorldModel.holdOnConflict). */
  holdFixes = 0;

  /**
   * Frames are held back because they contradict the map. Match them against
   * the structure that existed before the hold (born at least a few seconds
   * earlier): a confident correction realigns everything since the hold
   * began (the held frames are replayed corrected, what was mapped in
   * between is warped); a confident "nothing to correct" lets them in.
   */
  private *resolving(t: number): Generator<void, boolean, void> {
    const O = this.opts, w = this.world, since = w.heldSince!;
    const held = Math.max(1, w.replayFramesSince(since));
    const pm = O.placeHold ? yield* w.placeSearch({ since, frames: Math.min(30, held), minAge: 1, maxShift: O.relocMaxShift, maxYaw: O.relocMaxYaw, penalty: 0.01 }) : null;
    if (w.heldSince !== since) return false; // released or resolved meanwhile
    const placeOk = !!pm && pm.unique >= O.loopUnique;
    const m = pm && placeOk ? pm : yield* w.misalignmentSearch({ snapshot: 'aged', minAge: 6, frames: Math.min(15, held), maxShift: Math.max(O.loopMaxShift, 0.6), maxYaw: O.loopMaxYaw });
    if (w.heldSince !== since) return false; // released or resolved meanwhile
    this.last = { t, m, fired: false };
    if (!m) {
      this.note('hold: nothing to match yet');
      return false;
    }
    const mag = displacement(m, null);
    // A pose jump just before the hold that this correction would undo is
    // strong prior evidence: accept weaker support then.
    const J = w.poseGate.lastJump;
    const undoesJump = !!J && since - J.t < 2.5 && since >= J.t - 0.5 && Math.hypot(m.dx + J.dx, m.dz + J.dz) < Math.max(0.06, 0.3 * Math.hypot(J.dx, J.dz));
    const support = m === pm ? O.placeMinSupport : undoesJump ? 0.25 : 0.3, ratio = undoesJump ? 1.4 : 1.6;
    const ok = (!m.degenerate || undoesJump) && m.n >= O.loopMinPoints * (undoesJump ? 0.5 : 1) && m.best >= support * m.n && m.best >= ratio * Math.max(m.base, 0.1 * m.n) && mag >= O.minCorrection;
    if (!ok) {
      // The map as it stands fits after all, or nothing fits: let them in.
      if (!m.degenerate && m.n >= O.loopMinPoints && (m.base >= 0.5 * m.n || mag < O.minCorrection)) {
        this.pendingHold = null;
        w.releaseHeld();
        this.note(`hold: released (base ${m.base}/${m.n}, best ${m.best} ${(mag * 100).toFixed(0)}cm)`);
      } else this.note(`hold: unsure (${m.degenerate ? 'degenerate ' : ''}n ${m.n} base ${m.base} best ${m.best} ${(mag * 100).toFixed(0)}cm)`);
      return false;
    }
    // One clear-cut estimate is enough (frames are waiting); otherwise two that agree.
    const clearCut = O.holdSingle && !m.degenerate && m.n >= O.loopMinPoints && m.best >= 0.5 * m.n && m.best >= 3 * Math.max(m.base, 0.1 * m.n);
    if (undoesJump || clearCut || (this.pendingHold && this.pendingHold.since === since && displacement(m, this.pendingHold.m) <= O.agree)) {
      w.realign(m.dx, m.dz, m.dyaw, m.pivot, since - 0.05);
      w.heldResolved();
      // (A jump moved the frame at once: what was mapped before it is fine.)
      if (O.loopWarp && !undoesJump && Number.isFinite(m.oldT) && m.oldT < since - 1) w.warpSince(m.oldT, since, { dx: m.dx, dz: m.dz, dyaw: m.dyaw, pivot: m.pivot });
      this.pendingHold = null;
      this.corrections++;
      this.holdFixes++;
      this.last.fired = true;
      this.note(`HOLD RESOLVED ${(mag * 100).toFixed(0)}cm (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n} map since ${m.oldT.toFixed(0)}s`);
      return true;
    }
    this.pendingHold = { m, t, since };
    this.note(`hold candidate ${(mag * 100).toFixed(0)}cm (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n} base ${m.base}`);
    return false;
  }

  /** Re-attachments of a dormant map (see WorldModel.detachMap). */
  reattached = 0;
  private pendingReloc: { m: Est; t: number } | null = null;
  /**
   * Relocalise against the dormant map's place memory (wide search: the
   * jump is unknown). Two agreeing, clear-cut estimates re-attach it.
   */
  private *relocating(t: number): Generator<void, boolean, void> {
    const O = this.opts, w = this.world, d = w.dormant!;
    const m = yield* w.placeSearch({ memory: d.places, minAge: 0, maxShift: O.relocMaxShift, maxYaw: O.relocMaxYaw, penalty: 0.003, since: d.t, frames: 80, span: 8 });
    if (w.dormant !== d) return false;
    this.last = { t, m, fired: false };
    if (!m) {
      this.note(`reloc: nothing to match (${w.placeWhy})`);
      return false;
    }
    const ok = !m.degenerate && m.n >= O.loopMinPoints && m.best >= O.placeMinSupport * m.n && m.unique >= O.loopUnique;
    if (!ok) {
      const sa = m.secondAt;
      this.note(`reloc: none (${m.degenerate ? 'degenerate ' : ''}c ${m.constraint.toFixed(3)} n ${m.n} best ${m.best} at (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) uniq ${m.unique.toFixed(2)} 2nd ${m.second}${sa ? ` at (${sa.dx.toFixed(2)},${sa.dz.toFixed(2)},${sa.dyaw.toFixed(3)})` : ''})`);
      return false;
    }
    const P = this.pendingReloc;
    if (P && t - P.t >= 0.9 && t - P.t < 12 && displacement(m, P.m) <= 1.5 * O.agree) {
      w.reattach(m);
      this.pendingReloc = null;
      this.reattached++;
      this.corrections++;
      this.last.fired = true;
      this.note(`REATTACHED dormant map (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n}`);
      return true;
    }
    this.pendingReloc = { m, t };
    this.note(`reloc candidate (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n} 2nd ${m.second}`);
    return false;
  }

  /**
   * A loop check costs tens of ms of (sliced) search: only look again once
   * the view has changed (moved 0.4m or turned 0.6 rad since the last look),
   * or a candidate waits for its confirmation.
   */
  private lastLoopLook: { x: number; z: number; h: number } | null = null;
  private loopWorthIt(): boolean {
    const v = this.world.viewNow();
    if (!v) return true;
    const L = this.lastLoopLook;
    const changed = !L || Math.hypot(v.x - L.x, v.z - L.z) > 0.4 || Math.abs(Math.atan2(Math.sin(v.h - L.h), Math.cos(v.h - L.h))) > 0.6;
    if (!changed && !this.pendingLoop) return false;
    this.lastLoopLook = v;
    return true;
  }

  private consumedJumpT = -Infinity;
  /** Map warps after the tracker's own loop closures (see jumpWarp). */
  jumpWarps = 0;

  private *closing(t: number): Generator<void, boolean, void> {
    const O = this.opts;
    const pm = O.placeLoop ? yield* this.world.placeSearch({ minAge: O.loopMinAge, maxShift: O.loopMaxShift, maxYaw: O.loopMaxYaw }) : null;
    const m = O.placeLoop ? pm : yield* this.world.misalignmentSearch({ snapshot: 'aged', minAge: O.loopMinAge, maxShift: O.loopMaxShift, maxYaw: O.loopMaxYaw });
    this.last = { t, m, fired: false };
    const J = this.world.poseGate.lastJump;
    if (O.jumpWarp && m && J && J.t > this.consumedJumpT && this.world.now - J.t < 10 && Math.hypot(J.dx, J.dz) >= 0.05) {
      const aligned = !m.degenerate && m.n >= O.loopMinPoints && m.base >= O.loopMinSupport * m.n && displacement(m, null) < O.minCorrection;
      if (aligned && Number.isFinite(m.oldT) && m.oldT < J.t - 10) {
        this.consumedJumpT = J.t;
        const moved = this.world.warpSince(m.oldT, J.t, { dx: J.dx, dz: J.dz, dyaw: 0, pivot: m.pivot });
        this.jumpWarps++;
        this.note(`tracker jump ${(Math.hypot(J.dx, J.dz) * 100).toFixed(0)}cm lines up with the map of ${m.oldT.toFixed(0)}s: warped ${moved} voxels mapped since`);
      }
    }
    const P = this.pendingLoop;
    if (P && (this.world.now - P.wt > O.loopPendingSeconds || P.corr !== this.corrections)) this.pendingLoop = null;
    if (!m) {
      this.note('loop: no old structure in view');
      return false;
    }
    const mag = displacement(m, null);
    const unique = !pm || pm.unique >= O.loopUnique;
    const sup = pm ? O.placeMinSupport : O.loopMinSupport;
    const ok = !m.degenerate && unique && m.n >= O.loopMinPoints && m.best >= sup * m.n && m.best >= O.minRatio * Math.max(m.base, (pm ? 0.03 : 0.1) * m.n) && mag >= O.minCorrection;
    if (!ok) {
      // The map clearly fits as it is: whatever was pending was wrong.
      if (!m.degenerate && m.n >= O.loopMinPoints && m.base >= sup * m.n && mag < O.minCorrection) this.pendingLoop = null;
      this.note(`loop: none (${m.degenerate ? 'degenerate ' : ''}${unique ? '' : `ambiguous ${pm!.second} `}n ${m.n} base ${m.base} best ${m.best} mag ${(mag * 100).toFixed(0)}cm)`);
      return false;
    }
    if (this.pendingLoop && displacement(m, this.pendingLoop.m) <= O.agree) {
      const since = this.pendingLoop.wt - 2;
      this.world.realign(m.dx, m.dz, m.dyaw, m.pivot, since);
      // What was mapped between then and now drifted by a growing share of
      // the same error: move it too, so the loop lines up all the way round.
      if (this.opts.loopWarp && Number.isFinite(m.oldT) && m.oldT < since - 1) this.world.warpSince(m.oldT, since, { dx: m.dx, dz: m.dz, dyaw: m.dyaw, pivot: m.pivot });
      this.pendingLoop = null;
      this.pending = null;
      this.corrections++;
      this.loopClosures++;
      this.last.fired = true;
      this.note(`LOOP CLOSED (map since ${m.oldT.toFixed(0)}s) ${(mag * 100).toFixed(0)}cm (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n}`);
      return true;
    }
    this.pendingLoop = { m, t, wt: this.world.now, corr: this.corrections };
    this.note(`loop candidate ${(mag * 100).toFixed(0)}cm (${m.dx.toFixed(2)},${m.dz.toFixed(2)},${m.dyaw.toFixed(3)}) ${m.best}/${m.n} base ${m.base}`);
    return false;
  }

  private *drifting(t: number): Generator<void, boolean, void> {
    const O = this.opts;
    const maxShift = O.maxDriftShift;
    const m = yield* this.world.misalignmentSearch({ maxShift, maxYaw: 0.05 });
    this.last = { t, m, fired: false };
    if (!m) {
      this.pending = null;
      this.note('no estimate (no snapshot / too few points)');
      return false;
    }
    const mag = displacement(m, null);
    const ok = !m.degenerate && m.n >= O.minPoints && m.best >= O.minSupport * m.n && m.best >= O.minRatio * Math.max(m.base, 0.1 * m.n) && mag >= O.minCorrection;
    if (!ok) {
      this.pending = null;
      this.note(`rejected: ${m.degenerate ? 'degenerate ' : ''}n ${m.n} base ${m.base} best ${m.best} mag ${(mag * 100).toFixed(0)}cm`);
      return false;
    }
    // Must also hold against an older snapshot of the map: real drift moves
    // everything the same way, a person walking by doesn't.
    const m2 = yield* this.world.misalignmentSearch({ maxShift, maxYaw: 0.05, snapshot: 'oldest' });
    if (!m2 || m2.snapT === m.snapT || displacement(m, m2) > O.agree) {
      this.pending = null;
      this.note(`second snapshot ${!m2 ? 'missing' : m2.snapT === m.snapT ? 'same' : `disagrees ${(displacement(m, m2) * 100).toFixed(0)}cm`} (mag ${(mag * 100).toFixed(0)}cm)`);
      return false;
    }
    if (this.pending && displacement(m, this.pending.m) <= O.agree) {
      // The frame started sliding somewhere before the first of the two estimates.
      this.world.realign(m.dx, m.dz, m.dyaw, m.pivot, this.pending.wt - 3);
      this.pending = null;
      this.corrections++;
      this.last.fired = true;
      this.note(`REALIGNED ${(mag * 100).toFixed(0)}cm`);
      return true;
    }
    this.pending = { m, t, wt: this.world.now };
    this.note(`candidate mag ${(mag * 100).toFixed(0)}cm best ${m.best}/${m.n}`);
    return false;
  }
}

/** Max displacement between two corrections (or one and identity) at points ±1m around the camera. */
function displacement(a: Est, b: Est | null): number {
  const ap = (m: Est, p: { x: number; z: number }) => {
    const c = Math.cos(m.dyaw), s = Math.sin(m.dyaw), rx = p.x - m.pivot.x, rz = p.z - m.pivot.z;
    return { x: m.pivot.x + c * rx + s * rz + m.dx, z: m.pivot.z - s * rx + c * rz + m.dz };
  };
  let worst = 0;
  for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const p = { x: a.pivot.x + ox, z: a.pivot.z + oz };
    const q1 = ap(a, p), q2 = b ? ap(b, p) : p;
    worst = Math.max(worst, Math.hypot(q1.x - q2.x, q1.z - q2.z));
  }
  return worst;
}

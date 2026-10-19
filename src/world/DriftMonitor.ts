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
}

export const DEFAULT_DRIFT: DriftOptions = { interval: 1, minPoints: 500, minSupport: 0.5, minRatio: 2, agree: 0.1, minCorrection: 0.04, maxDriftShift: 0.2, eventWindow: 20 };

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
    if (this.inEvent) return this.afterEvent(t);
    if (inEvent) return false; // contradicted: waiting for the verdict to be taken
    return this.drifting(t);
  }
  private seenEvent = -Infinity;
  /** Inside the post-loss window (even if the event was already settled early). */
  private inWindow = false;
  /** Currently checking for a jump after a tracking loss. */
  inEvent = false;
  /** Just after a loss, or a jump looks likely and nothing says the map still fits. */
  get suspicious(): boolean {
    if (!this.inEvent) return false;
    return this.world.now - this.world.lastTrackingEvent < 4 || (this.votes.length > 0 && this.against === 0);
  }

  /**
   * Just after tracking was lost and recovered: did the frame jump? Compare
   * the new data with the map as it was before the loss (no contamination),
   * over a wide search range, and if two looks agree, realign everything
   * since the loss.
   */
  private afterEvent(t: number): boolean {
    const O = this.opts;
    const m = this.world.estimateMisalignment({ maxShift: 0.5, maxYaw: 0.1, snapshot: 'event' });
    this.last = { t, m, fired: false };
    if (!m) {
      this.note('event: no estimate yet');
      return false;
    }
    // Only looks that line up with known structure somehow say anything:
    // nothing matching at any shift is new territory, not a contradiction.
    if (m.n && m.best >= 0.2 * m.n) this.eventSeen.push(m.base / m.n);
    // Look after look, the map as it stands fits nothing while a shifted map
    // fits clearly: no need to wait out the window to know the map is off.
    // (Readings landing in space the old map saw clearly empty count even when
    // the right correction can't be pinned down.)
    const intoFree = m.n >= 100 && m.base <= -0.12 * m.n;
    if (intoFree || (!m.degenerate && m.n >= 100 && m.best >= 0.2 * m.n && m.base <= 0.05 * m.n && displacement(m, null) >= O.minCorrection)) {
      this.contra++;
      this.contraMag = Math.max(this.contraMag, displacement(m, null));
    } else if (m.n >= 100 && m.base >= 0.3 * m.n) this.contra = 0;
    if (this.contra >= 6 && this.world.now - this.world.lastTrackingEvent >= 4) {
      this.contradicted = true;
      this.note(`event: map contradicted by ${this.contra} looks in a row (~${(this.contraMag * 100).toFixed(0)}cm)`);
      return false;
    }
    const mag = displacement(m, null);
    const ok = !m.degenerate && m.n >= O.minPoints && m.best >= O.minSupport * m.n && m.best >= O.minRatio * Math.max(m.base, 0.1 * m.n);
    // A confident "nothing moved" (most readings on known surfaces as they are) votes against a jump.
    if (!m.degenerate && m.n >= 800 && m.base >= 0.6 * m.n && mag < O.minCorrection) this.against++;
    // Fewer readings, but the old map plainly doesn't fit where it is and does
    // fit shifted: a weaker vote, so it takes more of them agreeing.
    const weak = !ok && !m.degenerate && m.n >= 150 && m.best >= 0.3 * m.n && m.best >= 4 * Math.max(m.base, 0.05 * m.n);
    if ((!ok && !weak) || mag < O.minCorrection) {
      this.note(`event: ${ok ? "aligned" : "unsure"}${m.degenerate ? " (degenerate)" : ""} contra ${this.contra} n ${m.n} base ${m.base} best ${m.best} mag ${(mag * 100).toFixed(0)}cm`);
      return false;
    }
    // Votes: estimates from different moments that agree on the same correction.
    const agreeing = this.votes.filter((v) => t - v.t >= 0.9 && displacement(m, v.m) <= O.agree);
    this.votes.push({ m, t, weak });
    const strong = agreeing.filter((v) => !v.weak).length + (weak ? 0 : 1);
    const enough = strong >= 2 || agreeing.length + 1 >= 4;
    if (enough && agreeing.length + 1 > this.against) {
      this.world.realign(m.dx, m.dz, m.dyaw, m.pivot, (this.world.eventSnapshot?.t ?? this.world.lastTrackingEvent) - 0.5);
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

  private drifting(t: number): boolean {
    const O = this.opts;
    const maxShift = O.maxDriftShift;
    const m = this.world.estimateMisalignment({ maxShift, maxYaw: 0.05 });
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
    const m2 = this.world.estimateMisalignment({ maxShift, maxYaw: 0.05, snapshot: 'oldest' });
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

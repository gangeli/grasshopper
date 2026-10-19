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
    if (inEvent && !this.inEvent) {
      this.votes = [];
      this.against = 0;
      this.eventSeen = [];
    }
    this.inEvent = inEvent;
    if (this.inEvent) return this.afterEvent(t);
    return this.drifting(t);
  }
  /** Currently checking for a jump after a tracking loss. */
  inEvent = false;

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
    this.eventSeen.push(m.n ? m.base / m.n : 0);
    const mag = displacement(m, null);
    const ok = !m.degenerate && m.n >= O.minPoints && m.best >= O.minSupport * m.n && m.best >= O.minRatio * Math.max(m.base, 0.1 * m.n);
    // A confident "nothing moved" (most readings on known surfaces as they are) votes against a jump.
    if (!m.degenerate && m.n >= 800 && m.base >= 0.6 * m.n && mag < O.minCorrection) this.against++;
    if (!ok || mag < O.minCorrection) {
      this.note(`event: ${ok ? 'aligned' : 'unsure'} n ${m.n} base ${m.base} best ${m.best} mag ${(mag * 100).toFixed(0)}cm`);
      return false;
    }
    // Votes: estimates from different moments that agree on the same correction.
    const agreeing = this.votes.filter((v) => t - v.t >= 0.9 && displacement(m, v.m) <= O.agree);
    this.votes.push({ m, t });
    if (agreeing.length >= 1 && agreeing.length + 1 > this.against) {
      this.world.realign(m.dx, m.dz, m.dyaw, m.pivot, (this.world.eventSnapshot?.t ?? this.world.lastTrackingEvent) - 0.5);
      this.votes = [];
      this.against = 0;
      this.corrections++;
      this.last.fired = true;
      this.eventSeen = [];
      this.note(`event: REALIGNED ${(mag * 100).toFixed(0)}cm (${agreeing.length + 1} votes)`);
      return true;
    }
    this.note(`event: vote ${(mag * 100).toFixed(0)}cm ${m.best}/${m.n} (agreeing ${agreeing.length}, against ${this.against})`);
    return false;
  }
  private votes: { m: Est; t: number }[] = [];
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
    const mag = votes.length ? Math.max(...votes.map((x) => displacement(x.m, null))) : 0;
    // Repeated confident jump estimates that never agreed enough to fix, with
    // nothing confidently saying the map still fits: stop trusting the old map.
    if (votes.length >= 2 && against === 0) return { verdict: 'unresolved', mag };
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

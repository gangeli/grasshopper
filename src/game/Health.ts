import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { DriftMonitor } from '../world/DriftMonitor';
import { NAV_NONE } from '../world/NavGrid';
import type { WorldModel } from '../world/WorldModel';
import type { HideAndSeek } from './HideAndSeek';
import type { ViewPose } from './Visibility';

/**
 * The game's immune system. Real sensors drift, jump and lie; a mistake is
 * bad, but getting *stuck* in a broken state is worse. Every check here
 * watches for a state that should be impossible (or is no longer
 * believable) and gets out of it, preferring the gentlest fix that works:
 *
 *  - map frame slid against reality (drift / relocalisation) → realign
 *    (DriftMonitor); if contradictions persist with no consistent fix → age
 *    the evidence (soft reset) → forget the depth map (hard reset);
 *  - floor height wrong (the floor shows up as an obstacle, or the real
 *    floor is below ours) → relevel the floor and re-integrate recent depth;
 *  - pet in an impossible place (NaN, inside an obstacle, floating, under
 *    the floor, off the map) → hop to the nearest valid spot, or come back
 *    to the player;
 *  - pet walking forever, or a game phase that never ends → stop / move on;
 *  - nowhere to play for a long time → tell the player what to do.
 *
 * Every recovery is counted and reported (events + `log`) so tests can
 * assert both that faults are fixed and that healthy sessions are left alone.
 */
export type HealthIssue =
  | 'drift'
  | 'mapContradictory'
  | 'mapReset'
  | 'floorTooLow'
  | 'floorTooHigh'
  | 'petNaN'
  | 'petInside'
  | 'petFloating'
  | 'petUnderFloor'
  | 'petOffMap'
  | 'petStuckMoving'
  | 'phaseStuck'
  | 'noPlayArea'
  | 'badView';

export interface HealthOptions {
  /** Floor: minimum |offset| (m), dominant share and evidence mass before acting. */
  floorMinOffset: number;
  floorMinShare: number;
  floorMinMass: number;
  floorCooldown: number;
  /** Contradictions above this rate, sustained this long, with no realignment → soft reset. */
  conflictHigh: number;
  conflictSustain: number;
  /** Pet must be in an invalid place this long before we intervene (sensor noise flickers). */
  petGrace: number;
  maxMoveSeconds: number;
  enabled: boolean;
}

export const DEFAULT_HEALTH: HealthOptions = {
  floorMinOffset: 0.03,
  floorMinShare: 0.55,
  floorMinMass: 3000,
  floorCooldown: 8,
  conflictHigh: 0.4,
  conflictSustain: 6,
  petGrace: 1.5,
  maxMoveSeconds: 90,
  enabled: true,
};

export class HealthMonitor {
  readonly opts: HealthOptions;
  readonly drift: DriftMonitor;
  /** Every recovery taken, newest last. */
  readonly log: { t: number; issue: HealthIssue; detail: string }[] = [];
  readonly counts: Partial<Record<HealthIssue, number>> = {};
  onIssue?: (issue: HealthIssue, detail: string) => void;
  private t = 0;
  private floorCand: { off: number; t: number } | null = null;
  private lastRelevel = -Infinity;
  private conflictSince: number | null = null;
  private softResetAt = -Infinity;
  private lastRealign = -Infinity;
  private badSince: { kind: HealthIssue; t: number } | null = null;
  private movingSince: number | null = null;
  private phaseSince = 0;
  private lastPhase = '';
  private noAreaSince: number | null = null;
  private lastCheck = -Infinity;

  constructor(readonly game: HideAndSeek, readonly world: WorldModel, opts: Partial<HealthOptions> = {}) {
    this.opts = { ...DEFAULT_HEALTH, ...opts };
    this.drift = new DriftMonitor(world);
  }

  private report(issue: HealthIssue, detail: string) {
    this.log.push({ t: this.t, issue, detail });
    if (this.log.length > 200) this.log.shift();
    this.counts[issue] = (this.counts[issue] ?? 0) + 1;
    this.onIssue?.(issue, detail);
  }

  /** Called every frame by the game (view already in the map frame). */
  update(dt: number, view: ViewPose | null): void {
    if (!this.opts.enabled) return;
    this.t += dt;
    const w = this.world;
    if (!w.grid) return;
    // Cheap checks every frame; the rest ~3x/s.
    this.checkPetNumbers(view);
    if (this.t - this.lastCheck < 0.33) return;
    this.lastCheck = this.t;
    this.checkDrift();
    this.checkFloor();
    this.checkPetPlace(view);
    this.checkMotion();
    this.checkPhase();
    this.checkPlayArea();
  }

  // --- Map frame -------------------------------------------------------------------
  private checkDrift() {
    const w = this.world;
    const wasInEvent = this.drift.inEvent;
    const fixed = this.drift.update(this.t);
    const verdict = wasInEvent && !this.drift.inEvent && !fixed ? this.drift.eventVerdict() : null;
    if (verdict?.verdict === 'unresolved') {
      // After a tracking loss the new view and the old map disagree and no
      // consistent correction exists: don't keep a map we can't trust. If the
      // world frame clearly moved a lot, the pet moved with it: re-anchor it.
      w.softReset(0.15);
      this.softResetAt = this.t;
      const big = verdict.mag > 0.15;
      this.report('mapContradictory', `after a tracking loss the map no longer matched what the camera sees: evidence aged${big ? ', pet re-anchored' : ''}`);
      this.game.mapChanged();
      if (big) this.game.reanchorPet();
    }
    if (fixed) {
      this.lastRealign = this.t;
      this.conflictSince = null;
      const m = this.drift.last?.m;
      this.report('drift', m ? `realigned by ${(Math.hypot(m.dx, m.dz) * 100).toFixed(0)}cm, ${((m.dyaw * 180) / Math.PI).toFixed(1)}°` : 'realigned');
      this.game.mapChanged();
    }
    // Sustained contradictions that no consistent realignment explains: the
    // map has gone bad (e.g. it absorbed a big drift before we caught it).
    if (w.conflictRate > this.opts.conflictHigh) this.conflictSince ??= this.t;
    else this.conflictSince = null;
    if (this.conflictSince !== null && w.conflictRate > this.opts.conflictHigh && this.t - this.conflictSince > this.opts.conflictSustain && this.t - this.lastRealign > this.opts.conflictSustain) {
      const rate = (w.conflictRate * 100).toFixed(0);
      if (this.t - this.softResetAt < 20) {
        w.hardReset();
        this.report('mapReset', `contradictions ${rate}% persisted after ageing: map cleared`);
        this.game.say('I got confused about your room — look around a little so I can learn it again!');
      } else {
        w.softReset(0.3);
        this.softResetAt = this.t;
        this.report('mapContradictory', `contradictions ${rate}% for ${this.opts.conflictSustain}s: evidence aged`);
      }
      this.conflictSince = null;
      this.game.mapChanged();
    }
  }

  // --- Floor ---------------------------------------------------------------------------
  private floorUndo: { prevY: number; areaBefore: number; t: number } | null = null;
  private floorBanUntil = -Infinity;

  private checkFloor() {
    const w = this.world, game = this.game, O = this.opts;
    // Did the last floor move make things worse? Fresh evidence pointing back
    // towards the old floor says so: put it back and stop trying for a while.
    if (this.floorUndo && this.t - this.floorUndo.t > 8) {
      const u = this.floorUndo, fe = w.floorEvidence();
      if (fe.mass >= 1500) {
        this.floorUndo = null;
        const back = u.prevY - w.floorY;
        if (fe.share >= O.floorMinShare && Math.abs(back) > 0.02 && Math.sign(fe.offset) === Math.sign(back) && Math.abs(fe.offset - back) < 0.02) {
          w.relevelFloor(u.prevY);
          this.floorBanUntil = this.t + 60;
          this.report('floorTooHigh', `undid floor move: fresh evidence points back ${(fe.offset * 100).toFixed(1)}cm`);
          game.mapChanged();
          return;
        }
      }
    }
    if (this.t < 8 || this.t < this.floorBanUntil || this.t - this.lastRelevel < O.floorCooldown) return;
    const f = w.floorEvidence();
    // Detected floor planes are fitted over many points and don't inherit the
    // local, persistent bias of depth near the floor: if they agree with the
    // current floor, depth alone doesn't get to move it.
    const plane = w.floorPlaneEstimate();
    if (plane && Math.abs(plane.y - w.floorY) < 0.02) {
      this.floorCand = null;
      return;
    }
    if (f.mass < O.floorMinMass || f.share < O.floorMinShare || Math.abs(f.offset) < O.floorMinOffset) {
      this.floorCand = null;
      return;
    }
    // With a plane available, depth and plane must agree on the new height.
    if (plane && Math.abs(plane.y - (w.floorY + f.offset)) > 0.02) {
      this.floorCand = null;
      return;
    }
    // Consistent over a few seconds before rebuilding anything.
    if (!this.floorCand || Math.abs(this.floorCand.off - f.offset) > 0.015) {
      this.floorCand = { off: f.offset, t: this.t };
      return;
    }
    if (this.t - this.floorCand.t < 3) return;
    // A plane that agrees is the more precise height.
    const off = plane ? plane.y - w.floorY : Math.max(-0.2, Math.min(0.2, (this.floorCand.off + f.offset) / 2));
    this.floorUndo = { prevY: w.floorY, areaBefore: game.mappedArea(), t: this.t };
    w.relevelFloor(w.floorY + off);
    this.lastRelevel = this.t;
    this.floorCand = null;
    this.report(off > 0 ? 'floorTooLow' : 'floorTooHigh', `floor moved ${(off * 100).toFixed(1)}cm (evidence share ${(f.share * 100).toFixed(0)}%${plane ? ', plane agrees' : ''})`);
    game.mapChanged();
  }

  // --- Pet -------------------------------------------------------------------------------
  private checkPetNumbers(view: ViewPose | null) {
    const p = this.game.pet;
    if (Number.isFinite(p.pos.x + p.pos.y + p.pos.z + p.yaw)) return;
    this.report('petNaN', 'pet pose was not a number');
    this.rescuePet(view, true);
  }

  private checkPetPlace(view: ViewPose | null) {
    const pet = this.game.pet, w = this.world, g = w.grid!;
    let bad: HealthIssue | null = null;
    const airborne = pet.state === 'air' || pet.state === 'crouch' || pet.state === 'land';
    if (g.cellX(pet.pos.x) < 0 || g.cellZ(pet.pos.z) < 0 || g.cellX(pet.pos.x) >= g.nx || g.cellZ(pet.pos.z) >= g.nz) bad = 'petOffMap';
    else if (!airborne && pet.pos.y < w.floorY - 0.05) bad = 'petUnderFloor';
    else if (!airborne && !pet.moving) {
      // Inside: confident obstacles through the body core.
      let inside = 0;
      for (const h of [0.08, 0.13, 0.18])
        for (const [ox, oz] of [[0, 0], [0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03]]) {
          const i = g.cellX(pet.pos.x + ox), j = g.cellY(pet.pos.y + h), k = g.cellZ(pet.pos.z + oz);
          if (g.inBounds(i, j, k) && g.data[g.idx(i, j, k)] > 35) inside++;
        }
      if (inside >= 4) bad = 'petInside';
      else if (pet.pos.y > w.floorY + 0.06) {
        // Standing on something: there must be a surface right below.
        let support = false;
        for (const [ox, oz] of [[0, 0], [0.04, 0], [-0.04, 0], [0, 0.04], [0, -0.04]])
          for (let dy = 0.0; dy <= 0.08 && !support; dy += g.res / 2) {
            const i = g.cellX(pet.pos.x + ox), j = g.cellY(pet.pos.y - dy - 0.01), k = g.cellZ(pet.pos.z + oz);
            if (g.occ(i, j, k)) support = true;
          }
        if (!support) bad = 'petFloating';
      }
    }
    if (!bad) {
      this.badSince = null;
      return;
    }
    if (!this.badSince || this.badSince.kind !== bad) {
      this.badSince = { kind: bad, t: this.t };
      return;
    }
    if (this.t - this.badSince.t < this.opts.petGrace) return;
    this.badSince = null;
    this.report(bad, `at (${pet.pos.x.toFixed(2)}, ${pet.pos.y.toFixed(2)}, ${pet.pos.z.toFixed(2)})`);
    this.rescuePet(view, false);
  }

  /** Move the pet to the nearest believable spot (or back to the player). */
  private rescuePet(view: ViewPose | null, hard: boolean) {
    const game = this.game, pet = game.pet, w = this.world;
    const nav = game.refreshNav(true);
    const here: Vec3 = Number.isFinite(pet.pos.x + pet.pos.y + pet.pos.z) ? { x: pet.pos.x, y: pet.pos.y, z: pet.pos.z } : view ? { x: view.pos.x, y: w.floorY, z: view.pos.z } : { x: 0, y: w.floorY, z: 0 };
    let target: Vec3 | null = null;
    if (nav && nav.count) {
      for (const r of [0.5, 1, 2, 4]) {
        const n = nav.nearest(here, r);
        if (n !== NAV_NONE) {
          target = nav.pos(n);
          break;
        }
      }
    }
    if (!target && view) {
      // No mapped ground near: come back to the player's feet, ~1m ahead.
      const f = new THREE.Vector3(view.forward.x, 0, view.forward.z);
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      target = { x: view.pos.x + f.x, y: w.floorY, z: view.pos.z + f.z };
    }
    if (!target) target = { x: here.x, y: w.floorY, z: here.z };
    game.relocatePet(target, hard || Math.hypot(target.x - here.x, target.z - here.z) > 1.5);
  }

  /**
   * Walking without getting anywhere: the distance left along the current
   * path hasn't shrunk for 8s (e.g. bouncing between replans), or one move
   * takes absurdly long.
   */
  private checkMotion() {
    const pet = this.game.pet;
    if (!pet.moving) {
      this.movingSince = null;
      this.progress = null;
      return;
    }
    this.movingSince ??= this.t;
    const path = pet.path;
    let rem = 0, from = { x: pet.pos.x, y: pet.pos.y, z: pet.pos.z };
    for (let s = pet.segment; s < path.length; s++) {
      rem += Math.hypot(path[s].x - from.x, path[s].y - from.y, path[s].z - from.z);
      from = path[s];
    }
    if (!this.progress || this.progress.path !== path || rem < this.progress.best - 0.1) this.progress = { path, best: rem, t: this.t };
    const stuck = this.t - this.progress.t > 8;
    if (stuck || this.t - this.movingSince > this.opts.maxMoveSeconds) {
      this.report('petStuckMoving', stuck ? 'no progress along its path for 8s' : `one move lasted ${this.opts.maxMoveSeconds}s`);
      pet.stop('idle');
      this.movingSince = null;
      this.progress = null;
    }
  }
  private progress: { path: unknown; best: number; t: number } | null = null;


  // --- Game flow ----------------------------------------------------------------------
  private checkPhase() {
    const game = this.game;
    if (game.phase !== this.lastPhase) {
      this.lastPhase = game.phase;
      this.phaseSince = this.t;
      return;
    }
    const age = this.t - this.phaseSince;
    const limit = game.phase === 'countdown' ? game.opts.countdown + 20 : game.phase === 'seek' ? 50 + game.opts.difficulty * 50 + 30 : game.phase === 'found' ? 12 : Infinity;
    if (age > limit) {
      this.report('phaseStuck', `${game.phase} for ${age.toFixed(0)}s`);
      game.forceAdvance();
      this.phaseSince = this.t;
    }
  }

  private checkPlayArea() {
    const game = this.game;
    if (game.phase === 'waiting') return;
    if (game.mappedArea() >= 1) {
      this.noAreaSince = null;
      return;
    }
    this.noAreaSince ??= this.t;
    if (this.t - this.noAreaSince > 30) {
      this.report('noPlayArea', `walkable ${game.mappedArea().toFixed(1)}m² for 30s`);
      game.say('I can’t see enough floor to play on yet — slowly point the camera at the floor around you (good light helps).');
      this.noAreaSince = this.t;
    }
  }
}

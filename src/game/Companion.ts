import type { Rng } from '../core/rng';
import { wrapAngle, type Vec3 } from '../core/math';
import type { ActionName } from '../pet/Animator';
import type { PetController } from '../pet/PetController';
import { NAV_NONE, type NavGrid, type Waypoint } from '../world/NavGrid';
import type { ViewPose } from './Visibility';

/** Path search limits (travel cost ≈ metres): follow targets and explore trips are close by. */
const FOLLOW_MAX_COST = 8;
const EXPLORE_MAX_COST = 3;

/**
 * "Walk" activity: what Hopper does between rounds. Hopper keeps the player
 * company: it stays a metre or two in front of (and a little beside) where
 * they are looking, trots after them when they move or turn away, and in
 * between it explores nearby — sniffing at furniture edges, short trips to
 * mapped spots in view, and now and then a hop onto a low surface.
 *
 * Every move is planned on the nav graph, which only contains mapped,
 * observed-free floor (and surfaces whose jumps passed a clearance test), so
 * Hopper never walks into unknown space or through obstacles.
 *
 * In camera mode the player can't walk (orientation-only tracking): following
 * then simply means staying in front of where the phone points.
 */
export interface CompanionHost {
  readonly nav: NavGrid | null;
  readonly pet: PetController;
  readonly floorY: number;
  /** Plan-and-walk with runtime path guarding (HideAndSeek.follow). */
  follow(path: Waypoint[], cruise: number, action: ActionName, yaw: number | null): void;
  fidget(action: string): void;
}

export interface CompanionOptions {
  /** Preferred distance in front of the player (m). */
  roamDistance: number;
  /** Allow occasional hops onto low surfaces while exploring. */
  hops: boolean;
}

export type CompanionMode = 'idle' | 'follow' | 'explore' | 'goto';

/**
 * The nav node Hopper is standing on, or NAV_NONE when Hopper isn't on
 * walkable ground (mid-air after a glitch, inside something): no walk starts
 * from there — the health monitor puts Hopper back first.
 */
export function standingNode(nav: NavGrid, p: Vec3): number {
  const n = nav.nearest(p, 0.3);
  return n !== NAV_NONE && Math.abs(nav.ny[n] - p.y) <= 0.1 ? n : NAV_NONE;
}

/** Highest surface (above the floor) Hopper hops onto by itself while exploring. */
const MAX_EXPLORE_HEIGHT = 0.55;

export class Companion {
  mode: CompanionMode = 'idle';
  /** Hard delay: no new decisions (reactions, the intro wave). */
  private busy = 0;
  /** Soft delay: the next idea (fidget/explore) — cut short if the player wanders off. */
  private idea = 0;
  private replan = 0;
  private goal: Vec3 | null = null;
  /** Player position when Hopper last settled near them. */
  private anchor: Vec3 | null = null;
  /** Seconds the pet has been out of the comfortable zone. */
  private away = 0;
  /** Seconds the pet has been outside the player's view. */
  private offscreen = 0;
  /** After a tap-to-go: stay at the target this long (s) unless the player leaves. */
  private hold = 0;
  private side = 1;
  readonly stats = { follows: 0, explores: 0, hops: 0, fidgets: 0, gotos: 0 };

  constructor(readonly host: CompanionHost, readonly rng: Rng, readonly opts: CompanionOptions) {}

  /** Don't start anything new for `seconds` (a reaction or an intro is playing). */
  delay(seconds: number): void {
    this.busy = Math.max(this.busy, seconds);
  }

  /** Forget the current plan (round start, respawn, recovery). */
  reset(delay = 0): void {
    this.mode = 'idle';
    this.goal = null;
    this.anchor = null;
    this.hold = 0;
    this.away = 0;
    this.offscreen = 0;
    this.busy = delay;
    this.idea = 0;
  }

  /** Walking to a tapped spot: keep away from the player-following logic for a while. */
  startGoto(goal: Vec3): void {
    this.mode = 'goto';
    this.goal = goal;
    this.hold = 5;
    this.busy = 0;
    this.stats.gotos++;
  }

  update(dt: number, view: ViewPose): void {
    const pet = this.host.pet;
    this.busy -= dt;
    this.idea -= dt;
    this.replan -= dt;
    const geo = this.geometry(view);
    // Out of the comfortable zone (behind the player, far away, off screen)?
    const comfy = geo.dist > 0.45 && geo.dist < this.opts.roamDistance + 1.3 && Math.abs(geo.angle) < geo.halfFov * 0.95;
    this.away = comfy ? 0 : this.away + dt;
    this.offscreen = Math.abs(geo.angle) < geo.halfFov * 1.1 ? 0 : this.offscreen + dt;
    const playerMoved = this.anchor ? Math.hypot(view.pos.x - this.anchor.x, view.pos.z - this.anchor.z) : 0;

    if (pet.moving) {
      if (this.mode === 'follow' && this.replan <= 0 && this.goal) {
        // The player keeps moving: re-aim when where we want to be has moved on.
        const want = this.followTarget(view);
        if (want && Math.hypot(want.x - this.goal.x, want.z - this.goal.z) > 0.35) this.goFollow(view, want);
        this.replan = 0.8;
      }
      return;
    }
    if (this.busy > 0) return;

    if (this.mode === 'goto') {
      // Arrived at the tapped spot: hang out there until the player leaves or looks elsewhere.
      this.hold -= dt;
      if (this.hold > 0 && playerMoved < 1.2 && this.offscreen < 1.2 && geo.dist < 5) {
        if (this.idea <= 0) this.fidget(view, true);
        return;
      }
      this.mode = 'idle';
      this.anchor = null;
    }

    const needFollow = !this.anchor || playerMoved > 0.5 || this.away > 0.8 || geo.dist > this.opts.roamDistance + 2 || geo.dist < 0.35;
    if (needFollow) {
      const want = this.followTarget(view);
      if (want && Math.hypot(want.x - pet.pos.x, want.z - pet.pos.z) > 0.35 && this.goFollow(view, want)) return;
      // Nowhere better to be (or no way there): settle here.
      this.anchor = { ...view.pos };
      this.away = 0;
    }
    if (this.idea > 0) return;
    if (this.mode === 'explore' || this.rng.next() < 0.45) {
      // Just explored (or felt like staying put): a fidget, facing the player.
      this.fidget(view, false);
      this.mode = 'idle';
      return;
    }
    if (!this.explore(view)) this.fidget(view, false);
  }

  /** Player-relative geometry of the pet. */
  private geometry(view: ViewPose) {
    const pet = this.host.pet;
    const fx = view.forward.x, fz = view.forward.z, fl = Math.hypot(fx, fz) || 1;
    const dx = pet.pos.x - view.pos.x, dz = pet.pos.z - view.pos.z;
    const dist = Math.hypot(dx, dz);
    const angle = wrapAngle(Math.atan2(dx, dz) - Math.atan2(fx / fl, fz / fl));
    // Horizontal half field of view (portrait phones are narrow: ~15°).
    const halfFov = Math.max(0.2, Math.atan(Math.tan((view.fovY || 1) / 2) * (view.aspect || 0.6)));
    return { dist, angle, halfFov, fx: fx / fl, fz: fz / fl };
  }

  /** Where Hopper likes to be: in front of the player, slightly to one side. */
  private followTarget(view: ViewPose): Vec3 | null {
    const nav = this.host.nav;
    if (!nav || !nav.count) return null;
    const { fx, fz } = this.geometry(view);
    const rd = this.gazeDistance(view);
    // Try the preferred spot, then closer/other side if that's not mapped floor.
    for (const [d, s] of [[rd, this.side], [rd, -this.side], [rd * 0.75, 0], [rd * 1.3, this.side], [rd * 0.55, 0]] as const) {
      const off = 0.3 * s * Math.min(1, rd / 1.2);
      const p = { x: view.pos.x + fx * d + fz * off, y: this.host.floorY, z: view.pos.z + fz * d - fx * off };
      const n = nav.nearest(p, 0.45);
      if (n !== NAV_NONE && Math.abs(nav.ny[n] - this.host.floorY) < 0.1) return nav.pos(n);
    }
    return null;
  }

  /**
   * How far ahead to be: roughly where the player's gaze (a little below the
   * middle of the screen) meets the floor, within 0.8–1.4× roamDistance. So
   * Hopper comes closer when they look down, and stays visible above the HUD.
   */
  gazeDistance(view: ViewPose): number {
    const rd = this.opts.roamDistance;
    const h = view.pos.y - this.host.floorY;
    const fl = Math.hypot(view.forward.x, view.forward.y, view.forward.z) || 1;
    const a = Math.asin(Math.max(-1, Math.min(1, view.forward.y / fl))) - 0.18;
    const d = a < -0.05 && h > 0.2 ? h / Math.tan(-a) : rd * 1.4;
    return Math.max(rd * 0.8, Math.min(rd * 1.4, d));
  }

  private goFollow(view: ViewPose, want: Vec3): boolean {
    const nav = this.host.nav;
    if (!nav) return false;
    const pet = this.host.pet;
    const s = standingNode(nav, pet.pos);
    let t = nav.nearest(want, 0.2);
    if (s === NAV_NONE || t === NAV_NONE) return false;
    // One bounded search (follow targets are a few metres away; an unbounded
    // search for an unreachable target would sweep the whole map, every replan).
    // Following across the floor needs no jumps (their arcs are costly to work
    // out on a freshly rebuilt graph): only consider them when Hopper is up on
    // something or the spot is.
    const fy = this.host.floorY, step = nav.p.maxStep;
    const needJumps = Math.abs(nav.ny[s] - fy) > step || Math.abs(nav.ny[t] - fy) > step;
    const { cost, prev } = nav.search(s, t, FOLLOW_MAX_COST, needJumps);
    if (s !== t && prev[t] === NAV_NONE) {
      // No way there yet (the floor in between isn't mapped): get as close as we can.
      t = this.closestReachable(nav, cost, want);
      if (t === NAV_NONE) return false;
      want = nav.pos(t);
      if (Math.hypot(want.x - pet.pos.x, want.z - pet.pos.z) < 0.35) return false;
    }
    const path = nav.reconstruct(prev, s, t);
    // Already on the way there: don't restart the walk.
    if (pet.moving && this.goal && Math.hypot(want.x - this.goal.x, want.z - this.goal.z) < 0.3) return true;
    const far = Math.hypot(want.x - pet.pos.x, want.z - pet.pos.z);
    // A trot when the player has got away, an amble otherwise.
    const cruise = Math.min(1.0, Math.max(0.5, 0.45 + far * 0.22));
    const face = Math.atan2(view.pos.x - want.x, view.pos.z - want.z);
    this.host.follow(path, cruise, 'idle', face);
    this.mode = 'follow';
    this.goal = want;
    this.anchor = { ...view.pos };
    this.away = 0;
    this.replan = 0.8;
    this.idea = 1.2 + this.rng.next() * 1.5;
    if (this.rng.next() < 0.3) this.side = -this.side;
    this.stats.follows++;
    return true;
  }

  /** Of the floor nodes a search reached (finite `cost`), the closest to `p` (NAV_NONE if none is closer than 3m). */
  private closestReachable(nav: NavGrid, cost: Float32Array, p: Vec3): number {
    const g = nav.g, fy = this.host.floorY;
    let best = NAV_NONE, bd = 3;
    for (let q = 0; q < nav.count; q++) {
      if (!Number.isFinite(cost[q]) || Math.abs(nav.ny[q] - fy) > 0.1) continue;
      const d = Math.hypot(g.centerX(nav.ni[q]) - p.x, g.centerZ(nav.nk[q]) - p.z);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  /** A short trip to something interesting nearby that the player can see. */
  private explore(view: ViewPose): boolean {
    const nav = this.host.nav;
    if (!nav || !nav.count) return false;
    const pet = this.host.pet;
    const geo = this.geometry(view);
    const rd = this.gazeDistance(view);
    const s = standingNode(nav, pet.pos);
    if (s === NAV_NONE) return false;
    const wantHop = this.opts.hops && this.rng.next() < 0.3;
    let best = NAV_NONE, bestScore = -Infinity;
    for (let i = 0; i < 18; i++) {
      // Random points around the pet, kept in front of the player.
      const a = this.rng.next() * Math.PI * 2, r = 0.4 + this.rng.next() * 0.9;
      const p = { x: pet.pos.x + Math.sin(a) * r, y: this.host.floorY, z: pet.pos.z + Math.cos(a) * r };
      // Raised candidates: look up to the explore height in this column.
      const n = wantHop ? nav.nearest({ ...p, y: this.host.floorY + 0.4 }, 0.2) : nav.nearest(p, 0.2);
      if (n === NAV_NONE || n === s) continue;
      const q = nav.pos(n);
      const h = q.y - this.host.floorY;
      if (h > MAX_EXPLORE_HEIGHT) continue;
      const dx = q.x - view.pos.x, dz = q.z - view.pos.z, d = Math.hypot(dx, dz);
      const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - Math.atan2(geo.fx, geo.fz)));
      if (d < 0.6 || d > rd + 0.7 || ang > geo.halfFov * 0.65) continue;
      let score = this.rng.next() * 0.5;
      if (nav.isEdge(n)) score += 1; // next to furniture or a step: worth a sniff
      if (h > 0.1) score += wantHop ? 1.5 : -3;
      score -= Math.abs(d - rd) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best === NAV_NONE) return false;
    // Trips are short (≤ 2.2m below): no need to search further than that.
    const { prev } = nav.search(s, best, EXPLORE_MAX_COST, wantHop || Math.abs(nav.ny[s] - this.host.floorY) > nav.p.maxStep);
    if (prev[best] === NAV_NONE) return false;
    const path = nav.reconstruct(prev, s, best);
    if (path.length < 2) return false;
    // Short trips only, at most one jump each way.
    let len = 0, jumps = 0;
    for (let i = 1; i < path.length; i++) {
      len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      if (path[i].jump) jumps++;
    }
    if (len > 2.2 || jumps > 1) return false;
    const action: ActionName = this.rng.next() < 0.6 ? 'sniff' : 'lookAround';
    this.host.follow(path, 0.45, action, null);
    this.host.fidget(action);
    this.mode = 'explore';
    this.idea = 2 + this.rng.next() * 2;
    this.stats.explores++;
    if (jumps) this.stats.hops++;
    return true;
  }

  private fidget(view: ViewPose, curious: boolean): void {
    const pet = this.host.pet;
    const r = this.rng.next();
    const fidget: ActionName = curious
      ? r < 0.5 ? 'sniff' : r < 0.8 ? 'lookAround' : 'idle'
      : r < 0.3 ? 'lookAround' : r < 0.55 ? 'sniff' : r < 0.65 ? 'wave' : 'idle';
    pet.perform(fidget, 0.3);
    this.host.fidget(fidget);
    pet.arriveAction = fidget;
    pet.arriveYaw = Math.atan2(view.pos.x - pet.pos.x, view.pos.z - pet.pos.z);
    pet.state = 'idle';
    this.idea = 2 + this.rng.next() * 2.5;
    this.stats.fidgets++;
  }
}

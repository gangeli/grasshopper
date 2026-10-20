import * as THREE from 'three';
import { clamp, dampAngle, wrapAngle } from '../core/math';
import { NavGrid, type Waypoint } from '../world/NavGrid';
import { Animator, type ActionName } from './Animator';
import type { PetRig } from './PetModel';

/**
 * Moves Hopper through the world along nav paths: hop-walking on flat
 * stretches, and anticipate → leap → land for jump links. Drives the
 * animator's locomotion parameters and emits events for sound/game logic.
 */
export type MoveState = 'idle' | 'walk' | 'turn' | 'crouch' | 'air' | 'land' | 'perform';

export interface PetEvents {
  onHop?: () => void;
  onJump?: () => void;
  onLand?: (impact: number) => void;
  onArrive?: () => void;
}

const CROUCH_TIME = 0.28;
const LAND_TIME = 0.3;

export class PetController {
  readonly pos = new THREE.Vector3();
  yaw = 0;
  state: MoveState = 'idle';
  path: Waypoint[] = [];
  private seg = 0;
  /** Index of the waypoint currently being travelled to. */
  get segment(): number {
    return this.seg;
  }
  private stateT = 0;
  private speed = 0;
  private hopPhase = 0;
  private jumpFrom = new THREE.Vector3();
  private jumpTo = new THREE.Vector3();
  private jumpDur = 0.5;
  private jumpLift = 0;
  /** Ground speed target (m/s): walk ≈ 0.45, run ≈ 1.0. */
  cruise = 0.5;
  /** Action to settle into after arriving. */
  arriveAction: ActionName = 'idle';
  arriveYaw: number | null = null;
  events: PetEvents = {};
  /** Total distance travelled (diagnostics). */
  travelled = 0;
  private turning = false;
  jumpsMade = 0;

  constructor(readonly rig: PetRig, readonly anim: Animator) {}

  placeAt(p: THREE.Vector3, yaw = this.yaw): void {
    this.pos.copy(p);
    this.yaw = yaw;
    this.path = [];
    this.state = 'idle';
    this.anim.play('idle', 0.2);
    this.sync();
  }

  get moving(): boolean {
    return this.state !== 'idle' && this.state !== 'perform';
  }

  follow(path: Waypoint[], cruise = 0.5, arriveAction: ActionName = 'idle', arriveYaw: number | null = null): void {
    this.path = path.slice();
    // Drop a first waypoint that is basically where we stand.
    if (this.path.length && !this.path[0].jump && this.dist2D(this.path[0]) < 0.06) this.path.shift();
    this.seg = 0;
    this.cruise = cruise;
    this.arriveAction = arriveAction;
    this.arriveYaw = arriveYaw;
    if (!this.path.length) {
      this.arrive();
      return;
    }
    this.beginSegment();
  }

  stop(action: ActionName = 'idle'): void {
    this.path = [];
    this.state = 'idle';
    this.speed = 0;
    this.anim.play(action, 0.25);
  }

  /** Play a non-locomotion action in place. */
  perform(action: ActionName, fade = 0.2, restart = true): void {
    this.path = [];
    this.state = 'perform';
    this.speed = 0;
    this.anim.play(action, fade, restart);
  }

  private dist2D(w: { x: number; z: number }) {
    return Math.hypot(w.x - this.pos.x, w.z - this.pos.z);
  }

  private beginSegment(): void {
    const w = this.path[this.seg];
    this.stateT = 0;
    if (w.jump) {
      this.state = 'turn';
      this.jumpFrom.copy(this.pos);
      this.jumpTo.set(w.x, w.y, w.z);
      this.jumpLift = w.lift ?? 0;
      this.anim.play('idle', 0.15);
    } else {
      this.state = 'walk';
      this.anim.play('hop', 0.18);
    }
  }

  private arrive(): void {
    this.state = 'idle';
    this.turning = false;
    this.speed = 0;
    this.anim.ctx.speed = 0;
    this.anim.play(this.arriveAction, 0.3);
    this.events.onArrive?.();
  }

  update(dt: number): void {
    this.stateT += dt;
    const a = this.anim;
    switch (this.state) {
      case 'walk': {
        const w = this.path[this.seg];
        const dx = w.x - this.pos.x, dz = w.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        const desiredYaw = Math.atan2(dx, dz);
        const turnErr = Math.abs(wrapAngle(desiredYaw - this.yaw));
        this.yaw = dampAngle(this.yaw, desiredYaw, 10, dt);
        // Slow down for sharp turns and on approach to the end or a jump.
        const remaining = this.remainingWalk();
        const nextIsJump = this.seg + 1 < this.path.length && this.path[this.seg + 1].jump;
        const brake = clamp(remaining / (nextIsJump ? 0.25 : 0.35), 0.25, 1);
        const target = this.cruise * brake * clamp(1.4 - turnErr, 0.15, 1);
        this.speed += clamp(target - this.speed, -2.5 * dt, 2.0 * dt);
        const step = Math.min(d, this.speed * dt);
        if (d > 1e-6) {
          this.pos.x += (dx / d) * step;
          this.pos.z += (dz / d) * step;
          // Interpolate height towards the waypoint (small steps only).
          this.pos.y += (w.y - this.pos.y) * clamp(step / Math.max(d, 1e-3), 0, 1);
        }
        this.travelled += step;
        // Hop cadence scales gently with speed so stride length grows.
        const prev = this.hopPhase;
        const rate = 2.2 + this.speed * 1.6;
        this.hopPhase += dt * rate;
        a.ctx.hopRate = rate;
        if (Math.floor(prev) !== Math.floor(this.hopPhase)) this.events.onHop?.();
        a.ctx.hopPhase = this.hopPhase % 1;
        a.ctx.speed = this.speed;
        if (d < 0.02) {
          this.pos.set(w.x, w.y, w.z);
          this.seg++;
          if (this.seg >= this.path.length) {
            this.finishWalk();
          } else this.beginSegment();
        }
        break;
      }
      case 'turn': {
        // Face the jump target before crouching.
        const desiredYaw = Math.atan2(this.jumpTo.x - this.pos.x, this.jumpTo.z - this.pos.z);
        this.yaw = dampAngle(this.yaw, desiredYaw, 12, dt);
        if (Math.abs(wrapAngle(desiredYaw - this.yaw)) < 0.12 || this.stateT > 0.6) {
          this.state = 'crouch';
          this.stateT = 0;
          a.play('jumpCrouch', 0.1, true);
        }
        break;
      }
      case 'crouch': {
        if (this.stateT >= CROUCH_TIME) {
          this.state = 'air';
          this.stateT = 0;
          this.jumpFrom.copy(this.pos);
          const h = Math.abs(this.jumpTo.y - this.jumpFrom.y);
          const horiz = Math.hypot(this.jumpTo.x - this.jumpFrom.x, this.jumpTo.z - this.jumpFrom.z);
          this.jumpDur = 0.32 + 0.35 * Math.sqrt(h + this.jumpLift) + 0.18 * horiz;
          this.jumpsMade++;
          a.play('jumpAir', 0.06, true);
          this.events.onJump?.();
        }
        break;
      }
      case 'air': {
        const u = clamp(this.stateT / this.jumpDur, 0, 1);
        // Ease time slightly so the apex hangs (cartoon timing).
        const ue = u < 0.5 ? 0.5 * Math.pow(2 * u, 0.85) : 1 - 0.5 * Math.pow(2 * (1 - u), 0.85);
        const p = NavGrid.arcPoint(this.jumpFrom, this.jumpTo, ue, undefined, this.jumpLift);
        this.pos.set(p.x, p.y, p.z);
        a.ctx.jumpU = u;
        if (u >= 1) {
          this.pos.copy(this.jumpTo);
          this.state = 'land';
          this.stateT = 0;
          a.play('land', 0.05, true);
          this.events.onLand?.(Math.abs(this.jumpTo.y - this.jumpFrom.y) + 0.2);
        }
        break;
      }
      case 'land': {
        if (this.stateT >= LAND_TIME) {
          this.seg++;
          if (this.seg >= this.path.length) this.arrive();
          else this.beginSegment();
        }
        break;
      }
      case 'idle':
      case 'perform': {
        if (this.arriveYaw !== null && this.state === 'idle') {
          const err = wrapAngle(this.arriveYaw - this.yaw);
          // Big turns are done with little hops on the spot instead of sliding round.
          if (Math.abs(err) > 0.5 && !this.turning) {
            this.turning = true;
            a.play('hop', 0.15);
          }
          if (this.turning) {
            this.yaw += Math.sign(err) * Math.min(Math.abs(err), 3.2 * dt);
            this.hopPhase += dt * 3;
            a.ctx.hopRate = 3;
            a.ctx.hopPhase = this.hopPhase % 1;
            a.ctx.speed = 0.15;
            if (Math.abs(err) < 0.05) {
              this.turning = false;
              a.play(this.arriveAction, 0.25);
            }
          } else this.yaw = dampAngle(this.yaw, this.arriveYaw, 4, dt);
        }
        break;
      }
    }
    this.sync();
  }

  private finishWalk(): void {
    this.arrive();
  }

  private remainingWalk(): number {
    let d = 0;
    let px = this.pos.x, pz = this.pos.z;
    for (let s = this.seg; s < this.path.length; s++) {
      const w = this.path[s];
      if (w.jump) break;
      d += Math.hypot(w.x - px, w.z - pz);
      px = w.x;
      pz = w.z;
    }
    return d;
  }

  private sync(): void {
    this.rig.group.position.copy(this.pos);
    this.rig.group.rotation.set(0, this.yaw, 0);
  }
}

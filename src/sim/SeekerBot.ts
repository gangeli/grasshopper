import { clamp, wrapAngle } from '../core/math';
import type { Simulation } from './Simulation';

/**
 * An automated player. It looks around to map the room, starts a round,
 * "covers its eyes" (stands still), then searches: walking a tour of open
 * floor points and turning in place at each, until the pet is found.
 */
export type BotPhase = 'mapping' | 'waiting' | 'counting' | 'searching' | 'done';

export class SeekerBot {
  phase: BotPhase = 'mapping';
  private t = 0;
  private tour: { x: number; z: number }[] = [];
  private tourIdx = 0;
  private spin = 0;
  readonly log: string[] = [];
  /** Max search time before giving up (s). */
  timeout = 150;
  searchTime = 0;

  constructor(readonly sim: Simulation, readonly useHearing = true) {
    // Like a person, walk towards giggles (with some error in where we think they came from).
    const prev = sim.game.events.onGiggle;
    sim.game.events.onGiggle = (pos, loud) => {
      prev?.(pos, loud);
      if (this.phase !== 'searching' || !this.useHearing) return;
      this.heard++;
      const c = sim.cam.pos;
      const dx = c.x - pos.x, dz = c.z - pos.z;
      const d = Math.hypot(dx, dz) || 1;
      // Stand ~1.1m from the sound, on our side of it, with up to ±0.4m error.
      const err = () => (Math.sin(this.t * 13.7 + this.heard) * 0.4);
      for (const r of [1.1, 0.8, 1.5, 0.6]) {
        for (const rot of [0, 0.6, -0.6, 1.2, -1.2, 2, -2]) {
          const ca = Math.cos(rot), sa = Math.sin(rot);
          const ux = (dx / d) * ca - (dz / d) * sa, uz = (dx / d) * sa + (dz / d) * ca;
          const x = pos.x + ux * r + err(), z = pos.z + uz * r + err();
          if (this.standable(x, z)) {
            this.tour.splice(this.tourIdx, 0, { x, z });
            this.spin = 0;
            return;
          }
        }
      }
    };
  }

  heard = 0;

  private standable(x: number, z: number): boolean {
    const room = this.sim.room;
    if (Math.abs(x) > room.halfW - 0.25 || Math.abs(z) > room.halfD - 0.25) return false;
    return !room.solidAt({ x, y: 0.3, z }, 0.25) && !room.solidAt({ x, y: 1.2, z }, 0.25);
  }

  private buildTour() {
    const room = this.sim.room;
    const pts: { x: number; z: number }[] = [];
    // A ~1m grid over the open floor, like someone walking every part of the room.
    const nx = Math.max(2, Math.round(room.width - 0.6)), nz = Math.max(2, Math.round(room.depth - 0.6));
    for (let gz = 0; gz < nz; gz++)
      for (let gx = 0; gx < nx; gx++) {
        const x = -room.halfW + 0.5 + ((room.width - 1) * gx) / (nx - 1);
        const z = -room.halfD + 0.5 + ((room.depth - 1) * gz) / (nz - 1);
        if (this.standable(x, z)) pts.push({ x, z });
      }
    // Nearest-neighbour ordering from the current position.
    const out: { x: number; z: number }[] = [];
    let cur = { x: this.sim.cam.pos.x, z: this.sim.cam.pos.z };
    while (pts.length) {
      pts.sort((a, b) => Math.hypot(a.x - cur.x, a.z - cur.z) - Math.hypot(b.x - cur.x, b.z - cur.z));
      cur = pts.shift()!;
      out.push(cur);
    }
    this.tour = out;
    this.tourIdx = 0;
  }

  step(dt: number): void {
    const sim = this.sim;
    const cam = sim.cam;
    const game = sim.game;
    this.t += dt;
    switch (this.phase) {
      case 'mapping': {
        // Turn around slowly, looking down, to map the room.
        cam.yaw += dt * 0.9;
        cam.pitch = -0.55 + 0.2 * Math.sin(this.t * 0.8);
        if (this.t > 1 && game.phase === 'waiting') sim.spawnPet();
        if (this.t > 9) {
          this.phase = 'waiting';
          this.t = 0;
        }
        break;
      }
      case 'waiting': {
        // Look at the pet, then start.
        this.lookAt(sim.pet.pos.x, sim.pet.pos.y + 0.1, sim.pet.pos.z, dt);
        if (this.t > 1.5 && game.canStart()) {
          if (game.start(sim.view())) {
            this.log.push(`round ${game.round}: hiding ${game.spot?.kind} at ${game.spot?.pos.x.toFixed(2)},${game.spot?.pos.y.toFixed(2)},${game.spot?.pos.z.toFixed(2)}`);
            this.phase = 'counting';
            this.t = 0;
          }
        }
        break;
      }
      case 'counting': {
        // Eyes covered: don't move the camera.
        if (game.phase === 'seek') {
          this.phase = 'searching';
          this.searchTime = 0;
          this.buildTour();
        }
        break;
      }
      case 'searching': {
        this.searchTime += dt;
        if (game.phase === 'found' || game.phase === 'roam') {
          this.phase = 'done';
          break;
        }
        if (this.searchTime > this.timeout) {
          this.log.push('gave up');
          this.phase = 'done';
          break;
        }
        // Walk to the next tour point, then spin around looking down.
        if (this.tourIdx >= this.tour.length) this.buildTour();
        const target = this.tour[this.tourIdx];
        const dx = target.x - cam.pos.x, dz = target.z - cam.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.1) {
          const want = Math.atan2(-dx, -dz);
          cam.yaw += clamp(wrapAngle(want - cam.yaw), -2 * dt, 2 * dt);
          const sp = Math.min(d, 0.9 * dt);
          cam.pos.x += (dx / d) * sp;
          cam.pos.z += (dz / d) * sp;
          cam.pitch = -0.5;
        } else {
          this.spin += dt;
          cam.yaw += dt * 1.1;
          cam.pitch = -0.65 + 0.25 * Math.sin(this.spin * 2);
          if (this.spin > (Math.PI * 2) / 1.1) {
            this.spin = 0;
            this.tourIdx++;
          }
        }
        // Crouch to look under things now and then.
        cam.pos.y = 1.45 - 0.75 * Math.max(0, Math.sin(this.searchTime * 0.5));
        break;
      }
      case 'done':
        break;
    }
    sim.step(dt);
  }

  private lookAt(x: number, y: number, z: number, dt: number) {
    const cam = this.sim.cam;
    const dx = x - cam.pos.x, dy = y - cam.pos.y, dz = z - cam.pos.z;
    const want = Math.atan2(-dx, -dz);
    cam.yaw += clamp(wrapAngle(want - cam.yaw), -3 * dt, 3 * dt);
    cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
}

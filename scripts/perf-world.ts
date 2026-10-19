/**
 * Per-frame CPU cost of the device-independent work (world model, nav,
 * health, game, pet animation) during realistic automated rounds: the seeker
 * bot maps a room with ARCore-like depth noise, starts a round and searches.
 * Every subsystem is timed by wrapping its methods, so the numbers say where
 * a frame's JS time goes (and how often a frame is a long one).
 *
 *   npx tsx scripts/perf-world.ts [rounds=3] [room=living]
 */
import { Simulation } from '../src/sim/Simulation';
import { SeekerBot } from '../src/sim/SeekerBot';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { WorldModel } from '../src/world/WorldModel';
import { VoxelGrid } from '../src/world/VoxelGrid';
import { NavGrid } from '../src/world/NavGrid';
import { HealthMonitor } from '../src/game/Health';
import { HideAndSeek } from '../src/game/HideAndSeek';
import { Animator } from '../src/pet/Animator';
import { PetController } from '../src/pet/PetController';
import { SimSensor } from '../src/sim/SimSensor';

type Acc = { ms: number; calls: number; max: number };
const acc = new Map<string, Acc>();
let depth = 0;
function wrap(proto: object, name: string, label = name) {
  const p = proto as Record<string, (...a: unknown[]) => unknown>;
  const orig = p[name];
  if (typeof orig !== 'function') throw new Error(`no method ${label}`);
  p[name] = function (this: unknown, ...a: unknown[]) {
    // Only time the outermost call of each label (no double counting of recursion).
    depth++;
    const t0 = performance.now();
    try {
      return orig.apply(this, a);
    } finally {
      const dt = performance.now() - t0;
      depth--;
      let e = acc.get(label);
      if (!e) acc.set(label, (e = { ms: 0, calls: 0, max: 0 }));
      e.ms += dt;
      e.calls++;
      e.max = Math.max(e.max, dt);
    }
  };
}

wrap(SimSensor.prototype, 'depthImage', 'sim: sensor raycast (not on device)');
wrap(SimSensor.prototype, 'planes', 'sim: planes (not on device)');
wrap(WorldModel.prototype, 'ingestDepthImage', 'world.ingestDepthImage');
wrap(WorldModel.prototype, 'ingestDepth', '  world.ingestDepth (rays)');
wrap(WorldModel.prototype, 'ingestPlane', 'world.ingestPlane');
wrap(VoxelGrid.prototype, 'updateShadow', 'grid.updateShadow');
wrap(NavGrid.prototype, 'build', 'nav.build');
wrap(HideAndSeek.prototype, 'update', 'game.update (total)');
wrap(HideAndSeek.prototype, 'start', 'game.start (plan)');
wrap(HealthMonitor.prototype, 'update', '  health.update');
wrap(PetController.prototype, 'update', '  pet.update');
wrap(Animator.prototype, 'update', '  anim.update');

const rounds = Number(process.argv[2] ?? 3);
const roomName = process.argv[3] ?? 'living';
const frameMs: number[] = [];
let frames = 0;
const tAll = performance.now();
for (let r = 0; r < rounds; r++) {
  const sim = new Simulation({ seed: 11 + r, noise: 'arcore', room: dressRoom(roomFromName(roomName), 11 + r) });
  const bot = new SeekerBot(sim);
  const dt = 1 / 30;
  while (bot.phase !== 'done' && sim.time < 200) {
    const t0 = performance.now();
    bot.step(dt);
    frameMs.push(performance.now() - t0);
    frames++;
  }
  console.log(`round ${r}: ${bot.phase} after ${sim.time.toFixed(1)}s, depth points ${sim.world.depthPoints}`);
}
const total = performance.now() - tAll;
frameMs.sort((a, b) => a - b);
const pct = (q: number) => frameMs[Math.min(frameMs.length - 1, Math.floor(q * frameMs.length))].toFixed(2);
console.log(`\n${frames} sim frames (30 Hz game steps, sense every 3rd), ${total.toFixed(0)} ms total`);
console.log(`frame ms: mean ${(total / frames).toFixed(2)}  p50 ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${pct(1)}`);
console.log(`frames > 16.7ms: ${frameMs.filter((x) => x > 16.7).length}, > 33ms: ${frameMs.filter((x) => x > 33).length}`);
console.log('\nsubsystem                               ms/frame   calls   ms/call    max');
for (const [k, e] of [...acc].sort((a, b) => b[1].ms - a[1].ms))
  console.log(`${k.padEnd(40)}${(e.ms / frames).toFixed(3).padStart(8)}${String(e.calls).padStart(8)}${(e.ms / e.calls).toFixed(3).padStart(10)}${e.max.toFixed(1).padStart(8)}`);

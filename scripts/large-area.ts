import { generateHouse } from '../src/sim/House';
import { MethodProfiler } from '../src/sim/profile';
import { HideAndSeek } from '../src/game/HideAndSeek';
import { Companion } from '../src/game/Companion';
import { HealthMonitor } from '../src/game/Health';
import { DriftMonitor } from '../src/world/DriftMonitor';
import { WorldModel } from '../src/world/WorldModel';
import { NavGrid } from '../src/world/NavGrid';
import { PetController } from '../src/pet/PetController';
import { Animator } from '../src/pet/Animator';
import { fmtReport, runLargeArea } from '../src/sim/largeArea';
import { NOISE_PROFILES, type NoiseName } from '../src/sim/SimSensor';
// Large-area mapping benchmark: one walk through a multi-room home.
// Usage: npx tsx scripts/large-area.ts [WxD=10x12] [seed=1] [seconds=300] [profile=house]
// Env: JSON=path (write the report), EVERY (metric interval s), DEPTH_EVERY, WALK (JSON walk options),
//      NOISE (JSON overrides of the profile), WORLD (JSON world-model fields), NOGAME=1, CAMERA=1, QUIET=1
const [w, d] = (process.argv[2] ?? '10x12').split('x').map(Number);
const seed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 300);
const prof = (process.argv[5] ?? 'house') as NoiseName;
const noise = { ...NOISE_PROFILES[prof], ...JSON.parse(process.env.NOISE ?? '{}') };
const house = generateHouse(seed, w, d);
const t0 = performance.now();
// PROF=1: per-method timings (inclusive) of the main-thread work.
const profiler = process.env.PROF ? new MethodProfiler() : null;
if (profiler) {
  profiler.wrap('HideAndSeek', HideAndSeek.prototype, ['update']);
  profiler.wrap('Companion', Companion.prototype);
  profiler.wrap('Health', HealthMonitor.prototype, ['update']);
  profiler.wrap('Drift', DriftMonitor.prototype);
  profiler.wrap('World', WorldModel.prototype, ['ingestDepth', 'toMapPoint', 'toMapDir', 'toTrackingPoint', 'trackingToMap', 'mapToTracking']);
  profiler.wrap('NavGrid', NavGrid.prototype, ['pos', 'neighborAt', 'nearest']);
  profiler.wrap('Pet', PetController.prototype);
  profiler.wrap('Animator', Animator.prototype);
}
const rep = runLargeArea({
  house,
  seed,
  seconds,
  noise,
  evalEvery: Number(process.env.EVERY ?? 30),
  depthEvery: Number(process.env.DEPTH_EVERY ?? 3),
  walk: JSON.parse(process.env.WALK ?? '{}'),
  game: !process.env.NOGAME,
  multiView: !process.env.NOMULTIVIEW,
  depthFrom: process.env.CAMERA ? 'camera' : 'sensor',
  windowChurn: Number(process.env.CHURN ?? 0),
  moveFurniture: process.env.MOVE ? JSON.parse(process.env.MOVE) : undefined,
  jumps: process.env.JUMPS ? JSON.parse(process.env.JUMPS) : undefined,
  setup: (world, stack) => {
    Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
    Object.assign(stack.game.health.drift.opts, JSON.parse(process.env.DRIFT ?? '{}'));
    Object.assign(world.poseGate, JSON.parse(process.env.GATE ?? '{}'));
    Object.assign(stack.game.health.opts, JSON.parse(process.env.HEALTH ?? '{}'));
  },
  png: process.env.PNG,
  log: process.env.QUIET ? undefined : (l) => console.log(l),
});
console.log(fmtReport(rep));
if (profiler) console.log(profiler.report(30));
console.log(`(ran in ${((performance.now() - t0) / 1000).toFixed(0)}s)`);
if (process.env.JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.JSON, JSON.stringify(rep, null, 1));
}

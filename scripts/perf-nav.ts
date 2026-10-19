/**
 * Micro-benchmarks of the world model's expensive operations on a mapped
 * room: shadow mask, nav graph build, a depth frame's ingestion, and the
 * drift checks' misalignment search (with its result, to compare versions).
 *   npx tsx scripts/perf-nav.ts
 */
import { scanRoom, scanRoomHuman } from '../src/sim/scan';
import { roomFromName } from '../src/sim/SimRoom';
import { NavGrid } from '../src/world/NavGrid';
import { SimSensor } from '../src/sim/SimSensor';

const room = roomFromName('living');
const { world } = scanRoom(room, undefined, { noise: 'arcore' });
const g = world.grid!;
const time = (label: string, n: number, fn: () => void) => {
  fn();
  const ts: number[] = [];
  for (let q = 0; q < n; q++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  // The minimum is the least disturbed by other load on the machine.
  console.log(`${label.padEnd(30)} min ${ts[0].toFixed(2)}  median ${ts[n >> 1].toFixed(2)} ms`);
};
time('grid.updateShadow (forced)', 20, () => {
  g.version++;
  g.updateShadow();
});
const nav = new NavGrid(world);
time('nav.build', 10, () => nav.build());
console.log(`nav nodes ${nav.count}`);
const sensor = new SimSensor(room, { depth: true, planes: true, mesh: false }, 9, 'arcore');
const cams = Array.from({ length: 40 }, (_, a) => ({ pos: { x: 0.2, y: 1.4, z: 0.5 }, yaw: (a / 40) * Math.PI * 2, pitch: -0.5, fovY: 1.05, aspect: 0.75 }));
const imgs = cams.map((c) => sensor.depthImage(c));
let f = 0;
world.gateFrames = false;
time('world.ingestDepthImage', 40, () => {
  room.time += 0.25;
  world.ingestDepthImage(imgs[f++ % imgs.length], room.time);
});

// Drift check (every second) and the wide search after a tracking loss.
const { world: w2 } = scanRoomHuman(roomFromName('living'), { seed: 4, seconds: 30, noise: 'real' });
for (const [label, o] of [
  ['misalignment (drift check)', { maxShift: 0.2, maxYaw: 0.05 }],
  ['misalignment (after loss)', { maxShift: 0.5, maxYaw: 0.1 }],
] as const) {
  const r = w2.estimateMisalignment(o);
  console.log(`  ${JSON.stringify(r && { ...r, pivot: undefined })}`);
  time(label, 6, () => void w2.estimateMisalignment(o));
}

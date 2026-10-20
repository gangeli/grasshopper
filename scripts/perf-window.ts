import { WorldModel } from '../src/world/WorldModel';
// Cost of moving the map window (main thread): a full window with data, three recovery snapshots.
// Usage: npx tsx scripts/perf-window.ts
const w = new WorldModel();
w.setFloor(0, { x: 0, y: 0, z: 0 });
const g = w.grid!;
for (let n = g.nx * g.nz * 2; n < g.data.length; n += 7) g.data[n] = (n % 13) - 5;
for (let n = 0; n < g.observed.length; n += 3) g.observed[n] = 1;
// Snapshots come from depth frames; fake three by calling the private method.
const anyW = w as unknown as { takeSnapshot(t: number): void };
for (let t = 0; t < 3; t++) anyW.takeSnapshot(t * 4);
const times: number[] = [];
for (let q = 0; q < 12; q++) {
  const t0 = performance.now();
  w.moveWindow(q % 4 < 2 ? 2 : -2, q % 3 === 0 ? 2 : 0);
  times.push(performance.now() - t0);
  // Frames between moves (archive the rest, prepare arrays): not timed.
  const c = w.grid!;
  for (let f = 0; f < 20; f++) w.follow({ x: c.origin.x + (c.nx / 2) * c.res, y: 1.4, z: c.origin.z + (c.nz / 2) * c.res });
}
times.sort((a, b) => a - b);
console.log(`moveWindow: median ${times[times.length >> 1].toFixed(1)}ms max ${times[times.length - 1].toFixed(1)}ms (archive ${w.archive.size} chunks)`);

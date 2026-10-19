import { roomFromName } from '../src/sim/SimRoom';
import { scanRoom } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { evaluateMap } from '../src/sim/MapMetrics';
import { WorldModel } from '../src/world/WorldModel';
import type { NoiseName } from '../src/sim/SimSensor';
const prof = (process.argv[2] ?? 'arcore') as NoiseName;
const rooms = (process.argv[3] ?? 'living,bedroom,r3,r11').split(',');
const variants: [string, (w: WorldModel) => void, Record<string, number>][] = [
  ['all defenses', () => {}, {}],
  ['- pose gate', (w) => (w.gateFrames = false), {}],
  ['- weighted carving', (w) => (w.weightedCarving = false), {}],
  ['- edge filter', (w) => (w.filterEdges = false), {}],
  ['floorTol 0.07', (w) => (w.floorTolCap = 0.07), {}],
  ['maxStep 0.08', () => {}, { maxStep: 0.08 }],
  ['seenFreeMin 1', () => {}, { seenFreeMin: 1 }],
  ['radius 0.1', () => {}, { radius: 0.1 }],
  ['minPlatform 0', () => {}, { minPlatform: 0 }],
];
for (const [label, setup, navp] of variants) {
  let area = 0, coll = 0, ff = 0, pen = 0, bad = 0;
  for (const name of rooms) {
    const room = roomFromName(name);
    const world = new WorldModel();
    setup(world);
    scanRoom(room, undefined, { noise: prof, seed: 11, world });
    const nav = new NavGrid(world, navp);
    const m = evaluateMap(world, nav, room, { paths: 100 });
    area += m.walkableArea; coll += m.pathsColliding / Math.max(1, m.pathsTested); ff += m.falseFree; pen = Math.max(pen, m.pathMaxPenetration); bad += m.jumpsBadLanding;
  }
  const n = rooms.length;
  console.log(`${label.padEnd(20)} area ${(area / n).toFixed(1)}m²  pathsColliding ${(coll / n * 100).toFixed(1)}%  maxPen ${(pen * 100).toFixed(0)}cm  falseFree ${(ff / n * 100).toFixed(1)}%  badLand ${bad}`);
}

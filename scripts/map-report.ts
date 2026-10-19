import { roomFromName } from '../src/sim/SimRoom';
import { scanRoom, defaultScanSpots } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { evaluateMap } from '../src/sim/MapMetrics';
import type { NoiseName } from '../src/sim/SimSensor';
// Usage: npx tsx scripts/map-report.ts [profiles] [rooms]
const profiles = (process.argv[2] ?? 'ideal,arcore,harsh').split(',') as NoiseName[];
const rooms = (process.argv[3] ?? 'living,bedroom,r3,r7,r11,r19').split(',');
const f = (x: number) => x.toFixed(2), cm = (x: number) => (x * 100).toFixed(1).padStart(5), pc = (x: number) => (x * 100).toFixed(0).padStart(3) + '%';
console.log('profile  room     | surfErr med  p95  >5cm >10cm | falseFree missedLow | nodes coll(maxPen) unsup | paths coll(maxPen) jumps badLand | area');
for (const prof of profiles)
  for (const name of rooms) {
    const room = roomFromName(name);
    const { world } = scanRoom(room, { depth: true, planes: true, mesh: false }, { noise: prof, seed: 11 });
    const nav = new NavGrid(world);
    const eyes = defaultScanSpots(room).map((p) => ({ x: p.x, y: 1.45, z: p.z }));
    const m = evaluateMap(world, nav, room, { paths: 100, eyes });
    console.log(`${prof.padEnd(8)} ${name.padEnd(8)} |      ${cm(m.surfErrMedian)} ${cm(m.surfErrP95)} ${pc(m.surfErrOver5)} ${pc(m.surfErrOver10)} |    ${pc(m.falseFree)}      ${pc(m.missedLow)} | ${String(m.nodeCount).padStart(5)} ${String(m.nodesColliding).padStart(3)}(${f(m.nodeMaxPenetration)}) ${String(m.nodesUnsupported).padStart(5)} | ${String(m.pathsTested).padStart(4)} ${String(m.pathsColliding).padStart(3)}(${f(m.pathMaxPenetration)}) ${String(m.jumpsTested).padStart(4)} ${String(m.jumpsBadLanding).padStart(4)} | ${f(m.walkableArea)}`);
  }

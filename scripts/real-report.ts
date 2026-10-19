import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { scanRoomHuman } from '../src/sim/scan';
import { NavGrid } from '../src/world/NavGrid';
import { WorldModel } from '../src/world/WorldModel';
import { evaluateMap } from '../src/sim/MapMetrics';
import type { NoiseName } from '../src/sim/SimSensor';
// Realistic conditions: dressed rooms + human scanning + 'real' sensor profile.
// Usage: npx tsx scripts/real-report.ts [profile] [rooms] [seconds]
const prof = (process.argv[2] ?? 'real') as NoiseName;
const rooms = (process.argv[3] ?? 'living,bedroom,r3,r7,r11,r19,r23,r29,r31,r37,r41,r43').split(',');
const secs = Number(process.argv[4] ?? 45);
const f = (x: number) => x.toFixed(2), cm = (x: number) => (x * 100).toFixed(1).padStart(5), pc = (x: number) => (x * 100).toFixed(0).padStart(3) + '%';
console.log(`profile=${prof} scan=${secs}s human path, dressed rooms, depth from ${process.env.CAMERA ? 'CAMERA motion stereo' : 'depth-sensor model'}`);
console.log('room     frames(drop) | surfErr med  p95  >5cm >10cm | falseFree missedLow | nodes coll(maxPen) unsup | paths coll(maxPen) jumps badLand | area');
const agg = { ff: 0, coll: 0, pen: [] as number[], bad: 0, jumps: 0, area: 0, err95: 0, nodesColl: 0, nodes: 0, unsup: 0, gateRej: 0, gateAll: 0 };
// Seeds come from the room's place in the canonical list, so subsets (and parallel runs) see the same rooms.
const CANON = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
for (const [pos, name] of rooms.entries()) {
  const idx = CANON.includes(name) ? CANON.indexOf(name) : pos;
  const room = dressRoom(roomFromName(name), idx + 1);
  const w0 = new WorldModel();
  Object.assign(w0, JSON.parse(process.env.WORLD ?? '{}'));
  const { world, eyes, frames, dropped, camera } = scanRoomHuman(room, { seed: idx + 3, noise: prof, seconds: secs, world: w0, cameraDepth: !!process.env.CAMERA, cameraEvery: Number(process.env.CAMERA_EVERY ?? 2), stereo: JSON.parse(process.env.STEREO ?? '{}') });
  if (camera) console.log(`  camera: ${camera.frames} frames, ${camera.depthFrames} with stereo depth`);
  room.time = 1e6; // the walker has left
  const nav = new NavGrid(world, JSON.parse(process.env.NAV ?? '{}'));
  const m = evaluateMap(world, nav, room, { paths: 100, eyes });
  agg.ff += m.falseFree; agg.coll += m.pathsColliding / Math.max(1, m.pathsTested); agg.pen.push(m.pathMaxPenetration); agg.bad += m.jumpsBadLanding; agg.jumps += m.jumpsTested; agg.area += m.walkableArea; agg.err95 += m.surfErrP95; agg.nodesColl += m.nodesColliding; agg.nodes += m.nodeCount; agg.unsup += m.nodesUnsupported; agg.gateRej += world.poseGate.rejected; agg.gateAll += world.poseGate.rejected + world.poseGate.accepted;
  console.log(`${name.padEnd(8)} ${String(frames).padStart(4)}(${String(dropped).padStart(3)}) |      ${cm(m.surfErrMedian)} ${cm(m.surfErrP95)} ${pc(m.surfErrOver5)} ${pc(m.surfErrOver10)} |    ${pc(m.falseFree)}      ${pc(m.missedLow)} | ${String(m.nodeCount).padStart(5)} ${String(m.nodesColliding).padStart(3)}(${f(m.nodeMaxPenetration)}) ${String(m.nodesUnsupported).padStart(5)} | ${String(m.pathsTested).padStart(4)} ${String(m.pathsColliding).padStart(3)}(${f(m.pathMaxPenetration)}) ${String(m.jumpsTested).padStart(4)} ${String(m.jumpsBadLanding).padStart(4)} | ${f(m.walkableArea)}`);
}
const n = rooms.length;
agg.pen.sort((a, b) => a - b);
console.log(`\nSUMMARY over ${n} rooms (${prof}): surface err p95 ${(agg.err95 / n * 100).toFixed(1)}cm | falseFree ${(agg.ff / n * 100).toFixed(1)}% | paths colliding ${(agg.coll / n * 100).toFixed(1)}% (worst pen median ${(agg.pen[n >> 1] * 100).toFixed(0)}cm, max ${(agg.pen[n - 1] * 100).toFixed(0)}cm) | nodes colliding ${(agg.nodesColl / agg.nodes * 100).toFixed(2)}% | nodes unsupported ${(agg.unsup / agg.nodes * 100).toFixed(2)}% | bad landings ${agg.bad}/${agg.jumps} | walkable ${(agg.area / n).toFixed(1)} m² | frames gated ${(agg.gateRej / Math.max(1, agg.gateAll) * 100).toFixed(0)}%`);

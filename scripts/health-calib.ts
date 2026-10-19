import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom, humanScanPath } from '../src/sim/Realism';
import { SimSensor } from '../src/sim/SimSensor';
import { WorldModel } from '../src/world/WorldModel';
import { senseFrame } from '../src/sim/scan';
// Health-signal calibration: contradiction rate and floor evidence over a
// human scan, with an optional injected relocalisation jump at t=JUMP_T.
// Usage: npx tsx scripts/health-calib.ts [room] [jumpMetres] [floorOffset]
const CANON = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
const name = process.argv[2] ?? 'living', jump = Number(process.argv[3] ?? 0), floorOff = Number(process.argv[4] ?? 0);
const idx = CANON.indexOf(name);
const room = dressRoom(roomFromName(name), idx + 1);
const sensor = new SimSensor(room, { depth: true, planes: true, mesh: false }, idx + 3, 'real');
const world = new WorldModel();
world.setFloor(sensor.floorEstimate() + floorOff, { x: 0, y: 0, z: 0 });
const JUMP_T = 30;
let jumped = false;
for (const step of humanScanPath(room, idx + 3, 60)) {
  room.time = step.t;
  if (!jumped && jump && step.t >= JUMP_T) {
    sensor.injectPoseJump(jump, jump * 0.5, jump * 0.3);
    jumped = true;
  }
  if (!sensor.trackingOk(step.angVel)) continue;
  senseFrame(world, sensor, step.cam);
  if (Math.round(step.t * 10) % 20 === 0) {
    const f = world.floorEvidence();
    console.log(`${step.t.toFixed(0)} ${(world.conflictRate * 100).toFixed(1)} ${(f.offset * 100).toFixed(1)} ${(f.share * 100).toFixed(0)} ${f.mass.toFixed(0)}`);
  }
}

import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom, humanScanPath } from '../src/sim/Realism';
import { SimSensor, type NoiseName } from '../src/sim/SimSensor';
import { WorldModel } from '../src/world/WorldModel';
import { senseFrame } from '../src/sim/scan';
import { DriftMonitor } from '../src/world/DriftMonitor';
// Does estimateMisalignment recover an injected rigid jump? Prints, every
// second after the jump, the estimate's error against the true inverse.
// Usage: npx tsx scripts/align-test.ts [room] [profile] [jump m] [yaw rad]
const CANON = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
const name = process.argv[2] ?? 'living', prof = (process.argv[3] ?? 'arcore') as NoiseName;
const J = Number(process.argv[4] ?? 0.25), Y = Number(process.argv[5] ?? 0.06);
const idx = Math.max(0, CANON.indexOf(name));
const room = dressRoom(roomFromName(name), idx + 1);
const sensor = new SimSensor(room, { depth: true, planes: true, mesh: false }, idx + 3, prof);
const world = new WorldModel();
world.setFloor(sensor.floorEstimate(), { x: 0, y: 0, z: 0 });
const JT = 30;
const jd = { x: J, z: J * 0.5 };
const inv = (p: { x: number; z: number }) => {
  // J^-1: undo shift, then rotate by -Y about the origin.
  const x = p.x - jd.x, z = p.z - jd.z, c = Math.cos(-Y), s = Math.sin(-Y);
  return { x: c * x + s * z, z: -s * x + c * z };
};
let jumped = false, lastPrint = -1;
const drift = process.env.APPLY ? new DriftMonitor(world) : null;
const stats = { n: 0, good: 0, detected: 0 };
for (const step of humanScanPath(room, idx + 3, 55)) {
  room.time = step.t;
  if (!jumped && J && step.t >= JT) {
    sensor.injectPoseJump(jd.x, jd.z, Y);
    jumped = true;
  }
  if (!sensor.trackingOk(step.angVel)) continue;
  senseFrame(world, sensor, step.cam);
  if (drift) {
    if (drift.update(step.t)) console.log(`${step.t.toFixed(1)} CORRECTED -> residual ${(residual() * 100).toFixed(1)}cm`);
    if (Math.floor(step.t) !== lastPrint) {
      lastPrint = Math.floor(step.t);
      if (lastPrint % 3 === 0) console.log(`${lastPrint} ${jumped ? 'J' : '-'} residual ${(residual() * 100).toFixed(1)}cm conflict ${(world.conflictRate * 100).toFixed(0)}%`);
    }
    continue;
  }
  if (Math.floor(step.t) !== lastPrint && step.t > 6) {
    lastPrint = Math.floor(step.t);
    const m = world.estimateMisalignment();
    if (!m) continue;
    const apply = (p: { x: number; z: number }) => {
      const c = Math.cos(m.dyaw), s = Math.sin(m.dyaw), rx = p.x - m.pivot.x, rz = p.z - m.pivot.z;
      return { x: m.pivot.x + c * rx + s * rz + m.dx, z: m.pivot.z - s * rx + c * rz + m.dz };
    };
    // Error of the estimated correction at points around the camera (where it matters).
    let err = 0;
    for (const o of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const p = { x: m.pivot.x + o[0], z: m.pivot.z + o[1] };
      const want = jumped ? inv(p) : p, got = apply(p);
      err = Math.max(err, Math.hypot(want.x - got.x, want.z - got.z));
    }
    const ratio = m.best / Math.max(1, m.base), sup = m.best / m.n;
    const fire = sup >= 0.25 && ratio >= 1.6 && (m.best - m.base) >= 0.12 * m.n;
    if (jumped) { stats.n++; if (err < 0.06) stats.good++; if (fire) stats.detected++; }
    console.log(`${step.t.toFixed(0)} ${jumped ? "J" : "-"} ${m.degenerate ? "DEGEN" : ""} base ${m.base} best ${m.best} n ${m.n} sup ${(sup * 100).toFixed(0)}% ratio ${ratio.toFixed(2)} | est err ${(err * 100).toFixed(1)}cm ${fire ? 'FIRE' : ''}`);
  }
}
function residual() {
  // How far the map frame is from where it should be (truth), at points around the room.
  const M = world.trackingToMap();
  let worst = 0;
  for (const p of [{ x: 0, z: 0 }, { x: 1.5, z: 0 }, { x: 0, z: 1.5 }, { x: -1.5, z: -1.5 }]) {
    // A true point p is reported at J·p (after the jump); the map should place it back at p.
    const c = Math.cos(Y), s = Math.sin(Y);
    const rep = jumped ? { x: c * p.x + s * p.z + jd.x, z: -s * p.x + c * p.z + jd.z } : p;
    const mx = M[0] * rep.x + M[8] * rep.z + M[12], mz = M[2] * rep.x + M[10] * rep.z + M[14];
    worst = Math.max(worst, Math.hypot(mx - p.x, mz - p.z));
  }
  return worst;
}
console.log(`after jump: ${stats.n} checks, estimate within 6cm: ${stats.good}, would fire: ${stats.detected}`);

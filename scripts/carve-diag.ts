import { roomFromName, rayBox } from '../src/sim/SimRoom';
import { dressRoom } from '../src/sim/Realism';
import { scanRoomHuman } from '../src/sim/scan';
import { WorldModel } from '../src/world/WorldModel';
import { VoxelGrid } from '../src/world/VoxelGrid';
import type { Vec3 } from '../src/core/math';
import { MotionStereo, type StereoResult } from '../src/world/StereoDepth';
let lastRes: StereoResult | null = null;
const origCompute = MotionStereo.prototype.compute;
MotionStereo.prototype.compute = function (this: MotionStereo) {
  lastRes = origCompute.call(this);
  return lastRes;
};
/** Stereo reason code of the output pixel a world point projects to (-1 if none). */
function reasonAt(p: Vec3): number {
  if (!lastRes) return -1;
  const { image, reason } = lastRes;
  const M = image.camToWorld, P = image.invProj;
  const ox = p.x - M[12], oy = p.y - M[13], oz = p.z - M[14];
  const cx = M[0] * ox + M[1] * oy + M[2] * oz, cy = M[4] * ox + M[5] * oy + M[6] * oz, cz = M[8] * ox + M[9] * oy + M[10] * oz;
  if (cz > -0.05) return -1;
  const nx = (cx / -cz - (P[12] - P[8])) / P[0], ny = (cy / -cz - (P[13] - P[9])) / P[5];
  const x = Math.floor(((nx + 1) / 2) * image.w), y = Math.floor(((1 - ny) / 2) * image.h);
  if (x < 0 || y < 0 || x >= image.w || y >= image.h) return -1;
  return reason[y * image.w + x];
}
// Which depth rays carve free space inside real furniture (the falseFree shell, 6–25cm up)?
// Usage: CAMERA=1 [STEREO=...] npx tsx scripts/carve-diag.ts <room>
const name = process.argv[2] ?? 'r41';
const CANON = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
const idx = CANON.indexOf(name);
const room = dressRoom(roomFromName(name), idx + 1);
const inner = room.boxes
  .filter((b) => room.pieces[b.piece].label !== 'wall' && Math.min(b.max.x - b.min.x, b.max.z - b.min.z) >= 0.16)
  .map((b) => ({ label: room.pieces[b.piece].label, min: { x: b.min.x + 0.06, y: Math.max(b.min.y, 0.03) + 0.02, z: b.min.z + 0.06 }, max: { x: b.max.x - 0.06, y: Math.min(b.max.y, 0.25), z: b.max.z - 0.06 } }))
  .filter((b) => b.max.y > b.min.y);
const hist: Record<string, number> = {};
const PH = process.env.PHANTOM ? process.env.PHANTOM.split(',').map(Number) : null;
const orig = VoxelGrid.prototype.integrateRay;
VoxelGrid.prototype.integrateRay = function (this: VoxelGrid, from: Vec3, to: Vec3, hit: boolean, hitDelta = 14, missDelta = -3, carveShort = this.res * 1.5) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, len = Math.hypot(dx, dy, dz);
  const carve = len - carveShort;
  if (PH && hit && Math.hypot(to.x - PH[0], to.y - PH[1], to.z - PH[2]) < 0.06) {
    // Who puts an obstacle at the phantom? Truth along the ray, and the stereo source of the pixel.
    let tTrue = Infinity, lab = 'floor/none';
    for (const bb of room.boxes) {
      if (bb.material === 'glass') continue;
      const q = rayBox(from, { x: dx / len, y: dy / len, z: dz / len }, bb.min, bb.max);
      if (q && q.t > 1e-3 && q.t < tTrue) {
        tTrue = q.t;
        lab = room.pieces[bb.piece].label;
      }
    }
    const tf = dy < 0 ? -from.y / (dy / len) : Infinity;
    if (tf < tTrue) {
      tTrue = tf;
      lab = 'floor';
    }
    const dyn = room.dynamic.some((dd) => dd.at(room.time));
    const key = `phantom hit: reading ${len.toFixed(2)} true ${tTrue.toFixed(2)} (${lab}) reason ${reasonAt(to)}${dyn ? ' person in room' : ''} t=${room.time.toFixed(0)}`;
    hist[key] = (hist[key] ?? 0) + 1;
  }
  if (carve > 0)
    for (const b of inner) {
      const r = rayBox(from, { x: dx / len, y: dy / len, z: dz / len }, b.min, b.max);
      if (r && r.t < carve) {
        let tTrue = Infinity;
        for (const bb of room.boxes) {
          if (bb.material === 'glass') continue;
          const q = rayBox(from, { x: dx / len, y: dy / len, z: dz / len }, bb.min, bb.max);
          if (q && q.t > 1e-3 && q.t < tTrue) tTrue = q.t;
        }
        const why = tTrue < len - 0.15 ? 'reading too far (true surface nearer)' : 'reading ok (pose/map error)';
        const kind = `${reasonAt(to) === 6 ? 'FLOORPRIOR' : 'std'} ${why} ${b.label} ${hit ? 'hit' : 'free'} end@y${to.y < 0.07 ? '<7cm(floor ray)' : to.y < 0.3 ? '<30cm' : '>30cm'} range ${len < 1.5 ? '<1.5' : len < 3 ? '<3' : '>3'} miss ${missDelta}`;
        hist[kind] = (hist[kind] ?? 0) + 1;
      }
    }
  return orig.call(this, from, to, hit, hitDelta, missDelta, carveShort);
};
const w0 = new WorldModel();
scanRoomHuman(room, { seed: idx + 3, noise: 'real', seconds: 45, world: w0, cameraDepth: !!process.env.CAMERA, cameraEvery: Number(process.env.CAMERA_EVERY ?? 2), stereo: JSON.parse(process.env.STEREO ?? '{}') });
for (const [k, v] of Object.entries(hist).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  ${k}`);

import { writeFileSync } from 'node:fs';
import { roomFromName } from '../src/sim/SimRoom';
import { dressRoom, humanScanPath } from '../src/sim/Realism';
import { SimSensor, type NoiseName } from '../src/sim/SimSensor';
import { CameraSim } from '../src/sim/CameraSim';
import { MotionStereo } from '../src/world/StereoDepth';
// Quick look: render a few frames of a human scan and run motion stereo on them.
// Usage: npx tsx scripts/camera-depth.ts [room] [frames] [profile]
const name = process.argv[2] ?? 'living';
const nFrames = Number(process.argv[3] ?? 30);
const prof = (process.argv[4] ?? 'real') as NoiseName;
const CANON = ['living', 'bedroom', 'r3', 'r7', 'r11', 'r19', 'r23', 'r29', 'r31', 'r37', 'r41', 'r43'];
const room = dressRoom(roomFromName(name), CANON.indexOf(name) + 1);
const sensor = new SimSensor(room, { depth: true, planes: true, mesh: false }, 3, prof);
const cam = new CameraSim(room, process.env.CLEAN ? { blurSamples: 1, readNoise: 0, shotNoise: 0 } : process.env.CAM ? JSON.parse(process.env.CAM) : {});
const stereo = new MotionStereo();
const path = humanScanPath(room, 3, 30);
let k = 0;
const errs: number[] = [];
const signed: number[] = [];
let acc = 0, cand = 0;
for (const step of path) {
  if (k >= nFrames) break;
  room.time = step.t;
  if (!sensor.trackingOk(step.angVel)) { stereo.reset(); continue; }
  const t0 = performance.now();
  const frame = cam.render(step.cam, sensor.trackedCamToWorld(step.cam), { truth: true });
  const t1 = performance.now();
  stereo.push(frame);
  const res = stereo.compute();
  const t2 = performance.now();
  k++;
  if (!res) { console.log(k, 'no sources', (t1 - t0).toFixed(0) + 'ms'); continue; }
  const { image } = res, st = stereo.opts.step;
  const fe: number[] = [];
  for (let gy = 0; gy < image.h; gy++) for (let gx = 0; gx < image.w; gx++) {
    const d = image.depth[gy * image.w + gx];
    if (!d) continue;
    const tr = frame.truthDepth![(gy * st + 1) * frame.w + gx * st + 1];
    fe.push(Math.abs(d - tr) / tr);
    signed.push((d - tr) / tr);
  }
  fe.sort((a, b) => a - b);
  errs.push(...fe);
  acc += res.stats.accepted; cand += res.stats.candidates;
  console.log(k, `render ${(t1 - t0).toFixed(0)}ms stereo ${(t2 - t1).toFixed(0)}ms src ${res.sources} dens ${(res.stats.accepted / res.stats.candidates * 100).toFixed(0)}% med ${((fe[fe.length >> 1] ?? 0) * 100).toFixed(1)}% >10% ${(fe.filter((e) => e > 0.1).length / Math.max(1, fe.length) * 100).toFixed(0)}%`, JSON.stringify(res.stats));
  if (k % 10 === 0) {
    // Dump gray + stereo depth + truth as PGMs side by side.
    const W = frame.w * 3, H = frame.h, buf = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < frame.w; x++) {
      buf[y * W + x] = frame.gray[y * frame.w + x];
      const gx = Math.floor(x / st), gy = Math.floor(y / st);
      const d = gx < image.w && gy < image.h ? image.depth[gy * image.w + gx] : 0;
      buf[y * W + frame.w + x] = d ? Math.min(255, 40 + d * 50) : 0;
      buf[y * W + 2 * frame.w + x] = Math.min(255, 40 + frame.truthDepth![y * frame.w + x] * 50);
    }
    writeFileSync(`artifacts/cam/${name}-${k}.pgm`, Buffer.concat([Buffer.from(`P5 ${W} ${H} 255\n`), buf]));
  }
}
errs.sort((a, b) => a - b);
signed.sort((a, b) => a - b);
console.log(`signed rel err: p10 ${(signed[Math.floor(signed.length*0.1)]*100).toFixed(2)}% median ${(signed[signed.length>>1]*100).toFixed(2)}% p90 ${(signed[Math.floor(signed.length*0.9)]*100).toFixed(2)}%`);
console.log(`TOTAL density ${(acc / Math.max(1, cand) * 100).toFixed(1)}% median rel err ${(errs[errs.length >> 1] * 100).toFixed(2)}% p90 ${(errs[Math.floor(errs.length * 0.9)] * 100).toFixed(1)}% >10% ${(errs.filter((e) => e > 0.1).length / errs.length * 100).toFixed(1)}% >25% ${(errs.filter((e) => e > 0.25).length / errs.length * 100).toFixed(1)}%`);

/**
 * Replay a real RGB-D recording through the world model and navigation, and
 * evaluate against held-out real frames. Input is either a TUM sequence
 * prepared by scripts/tum/prep_tum.py (<prefix>.json + <prefix>.bin) or a
 * session recorded on a phone with the app's ?record=1 mode (*.hopperrec).
 * Usage:
 *   npx tsx scripts/tum-replay.ts data/tum/fr1_room [--pose-noise] [--phone] [--png out.png]
 *   npx tsx scripts/tum-replay.ts my-living-room.hopperrec
 *
 *   --pose-noise  corrupt the mapping frames' poses with phone-like drift,
 *                 jitter and relocalisation jumps (held-out frames keep the
 *                 motion-capture ground truth)
 *   --phone       resample to a 40x30 depth grid like the app uses on ARCore
 *   --stereo      build the map from motion stereo on the real colour images
 *                 (prep with --rgb) instead of the Kinect depth; held-out
 *                 frames still use the Kinect for evaluation
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { WorldModel } from '../src/world/WorldModel';
import { NavGrid } from '../src/world/NavGrid';
import { DepthConsistency, depthImageToPoints, type DepthImage } from '../src/world/DepthFrame';
import { Rng } from '../src/core/rng';
import { MotionStereo, type StereoOptions } from '../src/world/StereoDepth';
import type { Vec3 } from '../src/core/math';

const args = process.argv.slice(2);
const prefix = args[0] ?? 'data/tum/fr1_room';
const poseNoise = args.includes('--pose-noise');
const phone = args.includes('--phone');
const stereoMode = args.includes('--stereo');
const pngOut = args.includes('--png') ? args[args.indexOf('--png') + 1] : null;

type Meta = {
  w: number;
  h: number;
  invProj: number[];
  frames: { t: number; camToWorld: number[] }[];
  rgb?: { w: number; h: number; fx: number; fy: number; cx: number; cy: number; poses: number[][]; t: number[] };
};
let meta: Meta, all: Float32Array;
if (prefix.endsWith('.hopperrec')) {
  // A session recorded on a phone by the app (?record=1), see src/app/Recorder.ts.
  const buf = readFileSync(prefix);
  const hl = buf.readUInt32LE(0);
  meta = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
  const start = 4 + hl + ((4 - ((4 + hl) % 4)) % 4);
  const data = buf.subarray(start);
  all = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
} else {
  meta = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
  const bin = readFileSync(`${prefix}.bin`);
  all = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
}
const W = meta.w, H = meta.h;

function frame(i: number): DepthImage {
  let depth = all.slice(i * W * H, (i + 1) * W * H);
  let w = W, h = H;
  if (phone) {
    // Nearest-sample a 40x30 grid (what ArMode samples from ARCore's depth).
    const pw = 40, ph = 30, d2 = new Float32Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) d2[y * pw + x] = depth[Math.floor(((y + 0.5) * H) / ph) * W + Math.floor(((x + 0.5) * W) / pw)];
    depth = d2;
    w = pw;
    h = ph;
  }
  return { w, h, depth, invProj: meta.invProj, camToWorld: meta.frames[i].camToWorld };
}

// --- Phone-like tracking error on the mapping frames -------------------------------------
const rng = new Rng(5);
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rng.next()))) * Math.cos(2 * Math.PI * rng.next());
const err = { x: 0, y: 0, z: 0, yaw: 0 };
function corrupt(M: number[]): number[] {
  // Mean-reverting drift + jitter + occasional relocalisation jumps (per 10Hz frame).
  err.x += -0.05 * err.x + gauss() * 0.004;
  err.z += -0.05 * err.z + gauss() * 0.004;
  err.y += -0.05 * err.y + gauss() * 0.002;
  err.yaw += -0.05 * err.yaw + gauss() * 0.0016;
  if (rng.chance(0.01)) {
    err.x += gauss() * 0.08;
    err.z += gauss() * 0.08;
    err.yaw += gauss() * 0.03;
  }
  const c = Math.cos(err.yaw), s = Math.sin(err.yaw);
  const out = M.slice();
  // Rotate the camera axes and position about the world Y axis, then translate.
  for (const col of [0, 4, 8]) {
    const x = M[col], z = M[col + 2];
    out[col] = c * x + s * z;
    out[col + 2] = -s * x + c * z;
  }
  const px = M[12], pz = M[14];
  out[12] = c * px + s * pz + err.x;
  out[13] = M[13] + err.y;
  out[14] = -s * px + c * pz + err.z;
  return out;
}

// VIO-like error for camera frames: the same drift and jumps, but smooth frame to frame.
const errS = { x: 0, y: 0, z: 0, yaw: 0 };
function corruptSmooth(M: number[]): number[] {
  const before = { ...err };
  corrupt(M);
  const jump = { x: err.x - before.x, z: err.z - before.z, yaw: err.yaw - before.yaw };
  const isJump = Math.abs(jump.x) > 0.02 || Math.abs(jump.z) > 0.02;
  for (const k of ['x', 'y', 'z', 'yaw'] as const) errS[k] += isJump && k !== 'y' ? jump[k] : (err[k] - errS[k]) * 0.03;
  const c = Math.cos(errS.yaw), s = Math.sin(errS.yaw);
  const out = M.slice();
  for (const col of [0, 4, 8]) {
    const x = M[col], z = M[col + 2];
    out[col] = c * x + s * z;
    out[col + 2] = -s * x + c * z;
  }
  const px = M[12], pz = M[14];
  out[12] = c * px + s * pz + errS.x + gauss() * 0.0004;
  out[13] = M[13] + errS.y + gauss() * 0.0004;
  out[14] = -s * px + c * pz + errS.z + gauss() * 0.0004;
  return out;
}

// --- Build the map from even frames -----------------------------------------------------------
const world = new WorldModel();
Object.assign(world, JSON.parse(process.env.WORLD ?? '{}'));
if (process.env.MULTIVIEW) world.multiView = new DepthConsistency(JSON.parse(process.env.MULTIVIEW === '1' ? '{}' : process.env.MULTIVIEW));
const first = meta.frames[0].camToWorld;
// Emulate the placement tap (a hit-test on the floor, ~1cm accurate on ARCore):
// the mode of steep, close floor readings in the first second of data.
const tapFloor = (() => {
  const hist = new Map<number, number>();
  for (let i = 0; i < Math.min(10, meta.frames.length); i++) {
    const img = frame(i);
    const M = img.camToWorld;
    for (const p of depthImageToPoints(img)) {
      const d = Math.hypot(p.x - M[12], p.y - M[13], p.z - M[14]);
      if (d > 2 || (p.y - M[13]) / d > -0.6 || Math.abs(p.y) > 0.3) continue;
      const b = Math.round(p.y * 100);
      hist.set(b, (hist.get(b) ?? 0) + 1);
    }
  }
  let best = 0, bn = -1;
  for (const [b, n] of hist) if (n > bn) (bn = n), (best = b);
  return best / 100 + (rng.next() - 0.5) * 0.02;
})();
world.setFloor(tapFloor, { x: first[12], y: tapFloor, z: first[14] });
const mapIdx: number[] = [], heldIdx: number[] = [];
for (let i = 0; i < meta.frames.length; i++) (i % 2 === 0 ? mapIdx : heldIdx).push(i);
let rejected = 0;
const t0 = performance.now();
const stereo = new MotionStereo(JSON.parse(process.env.STEREO ?? '{}') as Partial<StereoOptions>);
const gray = stereoMode ? readFileSync(`${prefix}.gray`) : null;
const d160 = stereoMode ? (() => { const b = readFileSync(`${prefix}.d160`); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); })() : null;
const stereoErr: number[] = [];
let stereoPx = 0, stereoFrames = 0, stereoCand = 0;
for (const i of mapIdx) {
  if (stereoMode) {
    const R = meta.rgb!;
    const truePose = R.poses[i];
    const pose = poseNoise ? corruptSmooth(Array.from(truePose)) : truePose;
    stereo.push({ w: R.w, h: R.h, gray: new Uint8Array(gray!.buffer, gray!.byteOffset + i * R.w * R.h, R.w * R.h), fx: R.fx, fy: R.fy, cx: R.cx, cy: R.cy, camToWorld: pose, t: R.t[i] });
    const res = stereo.compute();
    if (process.env.DUMP && i % 40 === 0) dumpStereo(i, res?.image.depth ?? null, res?.image.w ?? 0);
    if (!res) continue;
    stereoFrames++;
    stereoCand += res.stats.candidates;
    // Accuracy against the Kinect: lift each stereo pixel with the true colour pose,
    // project it into the depth frame (true pose) and compare depths there.
    const pts = depthImageToPoints({ ...res.image, camToWorld: truePose });
    const D = meta.frames[i].camToWorld, inv = invRigid(D);
    for (const p of pts) {
      stereoPx++;
      const cx = inv[0] * p.x + inv[4] * p.y + inv[8] * p.z + inv[12], cy = inv[1] * p.x + inv[5] * p.y + inv[9] * p.z + inv[13], cz = inv[2] * p.x + inv[6] * p.y + inv[10] * p.z + inv[14];
      if (cz > -0.1) continue;
      const u = Math.floor((R.fx * cx) / -cz + R.cx), v = Math.floor((-R.fy * cy) / -cz + R.cy);
      if (u < 0 || v < 0 || u >= R.w || v >= R.h) continue;
      const k = d160![i * R.w * R.h + v * R.w + u];
      if (k > 0.3 && k < 4.5) stereoErr.push((-cz - k) / k);
    }
    if (!world.ingestDepthImage(res.image, R.t[i])) rejected++;
    world.refineFloor();
    continue;
  }
  const img = frame(i);
  if (poseNoise) img.camToWorld = corrupt(Array.from(img.camToWorld));
  if (!world.ingestDepthImage(img, meta.frames[i].t)) rejected++;
  world.refineFloor();
}
function dumpStereo(i: number, dep: Float32Array | null, gw: number) {
  const R = meta.rgb!, W2 = R.w * 3, buf = Buffer.alloc(W2 * R.h);
  for (let y = 0; y < R.h; y++)
    for (let x = 0; x < R.w; x++) {
      buf[y * W2 + x] = gray![i * R.w * R.h + y * R.w + x];
      const gx = Math.floor(x / 3), gy = Math.floor(y / 3);
      const d = dep && gx < gw ? dep[gy * gw + gx] ?? 0 : 0;
      buf[y * W2 + R.w + x] = d ? Math.min(255, 40 + d * 50) : 0;
      const k = d160![i * R.w * R.h + y * R.w + x];
      buf[y * W2 + 2 * R.w + x] = k ? Math.min(255, 40 + k * 50) : 0;
    }
  writeFileSync(`artifacts/cam/tum-${i}.pgm`, Buffer.concat([Buffer.from(`P5 ${W2} ${R.h} 255\n`), buf]));
}
function invRigid(M: ArrayLike<number>): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = M[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * M[12] + o[4 + r] * M[13] + o[8 + r] * M[14]);
  o[15] = 1;
  return o;
}
if (stereoMode) {
  const a = stereoErr.map(Math.abs).sort((x, y) => x - y), sg = stereoErr.slice().sort((x, y) => x - y);
  const q = (arr: number[], f: number) => (arr[Math.floor(arr.length * f)] * 100).toFixed(1) + '%';
  console.log(`  motion stereo on real RGB: ${stereoFrames}/${mapIdx.length} frames with depth, density ${((stereoPx / Math.max(1, stereoCand)) * 100).toFixed(1)}%, vs Kinect (${a.length} px): |err| median ${q(a, 0.5)} p90 ${q(a, 0.9)}, signed median ${q(sg, 0.5)}, >10% ${((a.filter((e) => e > 0.1).length / a.length) * 100).toFixed(1)}%, >25% ${((a.filter((e) => e > 0.25).length / a.length) * 100).toFixed(1)}%`);
}
const mapMs = performance.now() - t0;
const g = world.grid!;
const nav = new NavGrid(world, JSON.parse(process.env.NAV ?? '{}'));

// --- Evaluate against held-out frames (ground-truth poses) -------------------------------------
let surfPts = 0, surfHit = 0, rays = 0, raysPhantom = 0, ffPts = 0, ffBad = 0;
const heldPts: (Vec3 & { f: number })[] = [];
let ffPts8 = 0, ffBad8 = 0;
for (const i of heldIdx) {
  const img = frame(i);
  const M = img.camToWorld;
  const eye = { x: M[12], y: M[13], z: M[14] };
  const pts = depthImageToPoints(img);
  for (let q = 0; q < pts.length; q += 2) {
    const p = pts[q];
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    if (d > 3 || d < 0.3) continue;
    heldPts.push({ ...p, f: i });
    if (p.y < world.floorY + 0.05) continue; // floor: not an obstacle surface
    const dir = { x: (p.x - eye.x) / d, y: (p.y - eye.y) / d, z: (p.z - eye.z) / d };
    // Surface consistency: mapped obstacle within ~1 voxel.
    surfPts++;
    if (near(p, 1)) surfHit++;
    // Phantoms: occupied voxels well before the observed surface.
    rays++;
    const hit = g.raycast(eye, dir, d - 0.15);
    if (hit && hit.t < d - 0.15) raysPhantom++;
    // False free: a point 4cm behind the surface (inside the object) that the map claims it saw empty.
    if (d < 2.5) {
      const b = { x: p.x + dir.x * 0.04, y: p.y + dir.y * 0.04, z: p.z + dir.z * 0.04 };
      ffPts++;
      if (g.data[g.idx(g.cellX(b.x), g.cellY(b.y), g.cellZ(b.z))] <= -3) ffBad++;
    }
    // Robust variant: 8cm behind, within 2m (beyond the reference data's own noise).
    if (d < 2) {
      const b = { x: p.x + dir.x * 0.08, y: p.y + dir.y * 0.08, z: p.z + dir.z * 0.08 };
      ffPts8++;
      if (g.data[g.idx(g.cellX(b.x), g.cellY(b.y), g.cellZ(b.z))] <= -3) ffBad8++;
    }
  }
}
// Pet body intrusion: held-out surface points inside the pet's body at any nav node.
const bodyHits = new Map<number, number>();
const bodyHitsRobust = new Set<number>();
const bodyHitsObject = new Set<number>();
const nodeHeightErr: number[] = [];
const colOf = (x: number, z: number) => g.cellZ(z) * g.nx + g.cellX(x);
const byCol = new Map<number, (Vec3 & { f: number })[]>();
for (const p of heldPts) {
  const c = colOf(p.x, p.z);
  (byCol.get(c) ?? byCol.set(c, []).get(c)!).push(p);
}
for (let a = 0; a < nav.count; a++) {
  const n = nav.pos(a);
  let hits = 0, robust = 0;
  const frames = new Set<number>();
  for (let dk = -2; dk <= 2; dk++)
    for (let di = -2; di <= 2; di++) {
      const list = byCol.get(colOf(n.x + di * g.res, n.z + dk * g.res));
      if (!list) continue;
      for (const p of list) {
        if (Math.hypot(p.x - n.x, p.z - n.z) >= 0.07) continue;
        if (p.y > n.y + 0.04 && p.y < n.y + 0.22) hits++;
        if (p.y > n.y + 0.06 && p.y < n.y + 0.22) {
          robust++;
          frames.add(p.f);
        }
      }
    }
  if (hits >= 2) bodyHits.set(a, hits);
  if (robust >= 3 && frames.size >= 2) bodyHitsRobust.add(a);
  // Noise-aware: a real object occupies a good fraction of the footprint's readings.
  const local: { dh: number; f: number }[] = [];
  for (let dk = -2; dk <= 2; dk++)
    for (let di = -2; di <= 2; di++)
      for (const p of byCol.get(colOf(n.x + di * g.res, n.z + dk * g.res)) ?? [])
        if (Math.hypot(p.x - n.x, p.z - n.z) < 0.07 && Math.abs(p.y - n.y) < 0.3) local.push({ dh: p.y - n.y, f: p.f });
  const inBody = local.filter((q) => q.dh > 0.08 && q.dh < 0.22);
  if (inBody.length >= 3 && inBody.length >= 0.25 * local.length && new Set(inBody.map((q) => q.f)).size >= 2) bodyHitsObject.add(a);
  if (local.length >= 5) {
    const sorted = local.map((q) => q.dh).sort((x, y) => x - y);
    nodeHeightErr.push(Math.abs(sorted[sorted.length >> 1]));
  }
}
nodeHeightErr.sort((x, y) => x - y);
// Landing support: real surface points within 4cm of every jump landing height.
let landings = 0, landingsBad = 0, landingsObs = 0, landingsObsBad = 0;
const seenLand = new Set<number>();
for (let a = 0; a < nav.count; a += 7) {
  for (const b of nav.jumps(a)) {
    if (seenLand.has(b)) continue;
    seenLand.add(b);
    landings++;
    const n = nav.pos(b);
    const list = byCol.get(colOf(n.x, n.z)) ?? [];
    if (!list.some((p) => Math.abs(p.y - n.y) < 0.04)) landingsBad++;
    // Observed variant: only judge landings whose ~10cm neighbourhood the held-out frames saw.
    const area: number[] = [];
    for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) for (const q of byCol.get(colOf(n.x + di * g.res, n.z + dk * g.res)) ?? []) if (Math.hypot(q.x - n.x, q.z - n.z) < 0.1) area.push(q.y - n.y);
    if (area.length >= 5) {
      landingsObs++;
      // Real support: a decent share of readings at the landing height (±4cm).
      if (area.filter((v) => Math.abs(v) < 0.04).length < 0.2 * area.length) landingsObsBad++;
    }
  }
}

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : 'n/a');
console.log(`TUM replay ${prefix}${poseNoise ? ' +pose-noise' : ''}${phone ? ' +phone-res' : ''}${stereoMode ? ' +STEREO-from-RGB' : ''}: ${mapIdx.length} mapping frames (${rejected} gated), ${heldIdx.length} held-out, map ${(mapIdx.length / (mapMs / 1000)).toFixed(0)} fps`);
console.log(`  floor ${world.floorY.toFixed(3)} (refined ${world.floorRefinements}x), walkable ${(nav.count * g.res * g.res).toFixed(1)} m², nodes ${nav.count}`);
console.log(`  held-out surface consistency ${pct(surfHit, surfPts)} | rays through phantoms ${pct(raysPhantom, rays)} | false-free strict(4cm) ${pct(ffBad, ffPts)} robust(8cm,<2m) ${pct(ffBad8, ffPts8)}`);
console.log(`  pet-body intrusions: strict ${pct(bodyHits.size, nav.count)} | ≥3pts/2frames ${pct(bodyHitsRobust.size, nav.count)} | real object (≥25% of footprint readings 8-22cm up) ${pct(bodyHitsObject.size, nav.count)}`);
console.log(`  standing-height error |real surface - node| median ${(nodeHeightErr[nodeHeightErr.length >> 1] * 100).toFixed(1)}cm p90 ${(nodeHeightErr[Math.floor(nodeHeightErr.length * 0.9)] * 100).toFixed(1)}cm | jump landings without real support: any ${landingsBad}/${landings}, among observed landings ${landingsObsBad}/${landingsObs}`);

if (pngOut) writeTopDown(pngOut);

function near(p: Vec3, r: number) {
  const ci = g.cellX(p.x), cj = g.cellY(p.y), ck = g.cellZ(p.z);
  for (let dj = -r; dj <= r; dj++) for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) if (g.occ(ci + di, cj + dj, ck + dk)) return true;
  return false;
}

/** Top-down image: obstacles by height, walkable floor green, bad nodes red, trajectory blue. */
function writeTopDown(path: string) {
  const S = 4; // pixels per cell
  const nx = g.nx, nz = g.nz;
  const img = new Uint8Array(nx * nz * S * S * 3).fill(30);
  const put = (i: number, k: number, r: number, gg: number, b: number) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const o = ((k * S + y) * nx * S + i * S + x) * 3;
      img[o] = r;
      img[o + 1] = gg;
      img[o + 2] = b;
    }
  };
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      if (g.isObserved(i, k)) put(i, k, 70, 70, 70);
      let top = -1;
      for (let j = world.floorLayer + 1; j < g.ny; j++) if (g.occ(i, j, k)) top = j;
      if (top > 0) {
        const hgt = Math.min(1, ((top - world.floorLayer) * g.res) / 1.5);
        put(i, k, 120 + 135 * hgt, 110 + 60 * (1 - hgt), 60);
      }
    }
  for (let a = 0; a < nav.count; a++) put(nav.ni[a], nav.nk[a], bodyHitsObject.has(a) ? 255 : 40, bodyHitsObject.has(a) ? 0 : 200 + (nav.ny[a] > 0.1 ? 55 : 0), bodyHitsObject.has(a) ? 0 : 80);
  for (const f of meta.frames) {
    const i = g.cellX(f.camToWorld[12]), k = g.cellZ(f.camToWorld[14]);
    if (i >= 0 && k >= 0 && i < nx && k < nz) put(i, k, 80, 140, 255);
  }
  writeFileSync(path + '.rgb', img);
  writeFileSync(path + '.json', JSON.stringify({ w: nx * S, h: nz * S }));
}

if (args.includes('--diag')) {
  // Where are the intrusions? Split by node height, and look at intruding point heights.
  const hist: Record<string, number> = {};
  let floorBad = 0, elevBad = 0, floorN = 0, elevN = 0;
  for (let a = 0; a < nav.count; a++) {
    const elev = nav.ny[a] > world.floorY + 0.1;
    if (elev) elevN++;
    else floorN++;
    if (!bodyHits.has(a)) continue;
    if (elev) elevBad++;
    else floorBad++;
    const n = nav.pos(a);
    for (const p of byCol.get(colOf(n.x, n.z)) ?? []) {
      const dh = p.y - n.y;
      if (dh > -0.1 && dh < 0.3) {
        const b = (Math.floor(dh * 50) / 50).toFixed(2);
        hist[`${elev ? 'elev' : 'floor'} ${b}`] = (hist[`${elev ? 'elev' : 'floor'} ${b}`] ?? 0) + 1;
      }
    }
  }
  console.log(`  floor nodes bad ${pct(floorBad, floorN)}, elevated nodes bad ${pct(elevBad, elevN)}`);
  console.log('  held-out point height above bad node (2cm bins):', Object.entries(hist).sort().map(([k, v]) => `${k}:${v}`).join(' '));
  // Node height vs real surface height under elevated nodes.
  const diffs: number[] = [];
  for (let a = 0; a < nav.count; a += 3) {
    if (nav.ny[a] <= world.floorY + 0.1) continue;
    const n = nav.pos(a);
    const list = (byCol.get(colOf(n.x, n.z)) ?? []).map((p) => p.y).filter((y) => Math.abs(y - n.y) < 0.15).sort((x, y) => x - y);
    if (list.length >= 3) diffs.push(list[list.length >> 1] - n.y);
  }
  diffs.sort((x, y) => x - y);
  console.log(`  elevated surfaces: median (real - node) height ${(diffs[diffs.length >> 1] * 100).toFixed(1)}cm, p10 ${(diffs[Math.floor(diffs.length * 0.1)] * 100).toFixed(1)} p90 ${(diffs[Math.floor(diffs.length * 0.9)] * 100).toFixed(1)}cm over ${diffs.length} nodes`);
  // Floor: real floor height distribution near floor nodes.
  const fl: number[] = [];
  for (const p of heldPts) if (Math.abs(p.y - world.floorY) < 0.15) fl.push(p.y - world.floorY);
  fl.sort((x, y) => x - y);
  console.log(`  real floor points vs map floor: median ${(fl[fl.length >> 1] * 100).toFixed(1)}cm p10 ${(fl[Math.floor(fl.length * 0.1)] * 100).toFixed(1)} p90 ${(fl[Math.floor(fl.length * 0.9)] * 100).toFixed(1)}cm`);
}

if (args.includes('--diag2')) {
  // For robust intrusions: what does the MAP say at the intruding points?
  const cls: Record<string, number> = {};
  const dhs: number[] = [];
  let elevBad = 0, floorBad = 0;
  for (const a of bodyHitsRobust) {
    const n = nav.pos(a);
    if (n.y > world.floorY + 0.1) elevBad++;
    else floorBad++;
    for (const p of byCol.get(colOf(n.x, n.z)) ?? []) {
      if (Math.hypot(p.x - n.x, p.z - n.z) >= 0.07 || p.y <= n.y + 0.06 || p.y >= n.y + 0.22) continue;
      dhs.push(p.y - n.y);
      const v = g.data[g.idx(g.cellX(p.x), g.cellY(p.y), g.cellZ(p.z))];
      const k = v > 20 ? 'occupied' : v >= 10 ? 'soft' : v <= -3 ? 'seen-free' : v < 0 ? 'weak-free' : 'unknown';
      cls[k] = (cls[k] ?? 0) + 1;
    }
  }
  dhs.sort((x, y) => x - y);
  console.log(`  robust-bad nodes: floor ${floorBad}, elevated ${elevBad}; map state at intruding points: ${JSON.stringify(cls)}; intrusion height median ${(dhs[dhs.length >> 1] * 100).toFixed(0)}cm p90 ${(dhs[Math.floor(dhs.length * 0.9)] * 100).toFixed(0)}cm`);
}

if (args.includes('--diag3')) {
  // Height distribution of ALL held-out points around robust-bad nodes (unimodal at +7cm = height bias; bimodal = objects).
  const hist = new Array(30).fill(0);
  let shown = 0;
  for (const a of bodyHitsRobust) {
    const n = nav.pos(a);
    const hs: number[] = [];
    for (const p of byCol.get(colOf(n.x, n.z)) ?? []) if (Math.hypot(p.x - n.x, p.z - n.z) < 0.07 && Math.abs(p.y - n.y) < 0.3) hs.push(p.y - n.y);
    for (const h of hs) hist[Math.max(0, Math.min(29, Math.floor((h + 0.3) * 50)))]++;
    if (shown < 6 && hs.length > 10) {
      hs.sort((x, y) => x - y);
      console.log(`  node ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}: ${hs.length} pts, quantiles 10/50/90 = ${[0.1, 0.5, 0.9].map((q) => (hs[Math.floor(q * hs.length)] * 100).toFixed(0)).join('/')}cm`);
      shown++;
    }
  }
  console.log('  histogram (2cm bins from -30cm):', hist.map((v, i) => `${(i * 2 - 30)}:${v}`).join(' '));
}

if (args.includes('--diag4')) {
  const seen2 = new Set<number>();
  let shown = 0;
  for (let a = 0; a < nav.count && shown < 10; a += 7) {
    for (const b of nav.jumps(a)) {
      if (seen2.has(b)) continue;
      seen2.add(b);
      const n = nav.pos(b);
      const list = byCol.get(colOf(n.x, n.z)) ?? [];
      if (list.some((p) => Math.abs(p.y - n.y) < 0.04)) continue;
      const near = list.map((p) => p.y - n.y).sort((x, y) => x - y);
      const around: number[] = [];
      for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) for (const p of byCol.get(colOf(n.x + di * g.res, n.z + dk * g.res)) ?? []) around.push(p.y - n.y);
      around.sort((x, y) => x - y);
      const from = nav.pos(a);
      console.log(`  landing ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)} from y=${from.y.toFixed(2)} | column pts ${near.length} (${near.slice(0, 5).map((v) => (v * 100).toFixed(0)).join(',')}cm) | 25cm area pts ${around.length} median ${around.length ? (around[around.length >> 1] * 100).toFixed(0) : '-'}cm, within±4cm ${around.filter((v) => Math.abs(v) < 0.04).length}`);
      shown++;
    }
  }
}

if (args.includes('--diag5')) {
  const seen3 = new Set<number>();
  let shown = 0;
  for (let a = 0; a < nav.count && shown < 12; a += 7)
    for (const b of nav.jumps(a)) {
      if (seen3.has(b) || shown >= 12) continue;
      seen3.add(b);
      const n = nav.pos(b);
      const area: number[] = [];
      for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) for (const q of byCol.get(colOf(n.x + di * g.res, n.z + dk * g.res)) ?? []) if (Math.hypot(q.x - n.x, q.z - n.z) < 0.1) area.push(q.y - n.y);
      if (area.length < 5 || area.filter((v) => Math.abs(v) < 0.04).length >= 0.2 * area.length) continue;
      area.sort((x, y) => x - y);
      const q = (f: number) => (area[Math.floor(f * (area.length - 1))] * 100).toFixed(0);
      console.log(`  landing y=${n.y.toFixed(2)} from y=${nav.pos(a).y.toFixed(2)} at ${n.x.toFixed(2)},${n.z.toFixed(2)}: ${area.length} pts, real-node height quantiles 10/25/50/75/90 = ${q(0.1)}/${q(0.25)}/${q(0.5)}/${q(0.75)}/${q(0.9)} cm`);
      shown++;
    }
}

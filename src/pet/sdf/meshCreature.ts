import * as THREE from 'three';
import { BONES, type BoneName, type V } from '../skeleton';
import { buildCreatureSculpt, EYE, EYE_RADIUS, FUR_LENGTH } from './creature';
import { alignX, type Region } from './sdf';
import { surfaceNets } from './surfaceNets';

export interface CreaturePalette {
  body: number;
  bodyDark: number;
  belly: number;
  blush: number;
  glow: number;
  eye: number;
  wing: number;
}

/** Smooth 3D value noise in [0,1]. */
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v), l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v), w);
}
const fbm = (x: number, y: number, z: number) => vnoise(x, y, z) * 0.6 + vnoise(x * 2.1, y * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3, z * 4.3) * 0.1;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * SDF ambient occlusion at a surface point: march a few steps out along the
 * normal; wherever the field is closer than the step, something is nearby.
 * Returns 1 (open) .. 0 (fully occluded).
 */
function occlusion(S: { d(x: number, y: number, z: number): number }, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  let occ = 0, w = 1, wsum = 0;
  for (let i = 0; i < 5; i++) {
    const h = 0.003 + 0.0055 * i;
    const d = S.d(x + nx * h, y + ny * h, z + nz * h);
    occ += w * Math.max(0, Math.min(1, (h - d) / h));
    wsum += w;
    w *= 0.72;
  }
  return Math.max(0, Math.min(1, 1 - 1.6 * (occ / wsum)));
}

const boneIndex = new Map(BONES.map(([n], i) => [n as string, i]));

const cache = new Map<string, THREE.BufferGeometry>();
let sculpt: ReturnType<typeof buildCreatureSculpt> | null = null;
const getSculpt = () => (sculpt ??= buildCreatureSculpt());

/**
 * Snap a point onto the sculpted skin (a few gradient steps) and return the
 * surface point and outward normal — for placing face details on the body.
 */
export function surfaceAt(x: number, y: number, z: number): { p: THREE.Vector3; n: THREE.Vector3 } {
  const S = getSculpt();
  const e = 0.0005;
  const n = new THREE.Vector3();
  for (let it = 0; it < 8; it++) {
    n.set(S.d(x + e, y, z) - S.d(x - e, y, z), S.d(x, y + e, z) - S.d(x, y - e, z), S.d(x, y, z + e) - S.d(x, y, z - e)).normalize();
    const dv = S.d(x, y, z);
    x -= n.x * dv;
    y -= n.y * dv;
    z -= n.z * dv;
  }
  return { p: new THREE.Vector3(x, y, z), n };
}

/** Fur length at a surface point (for lifting decals above the fur). */
export function furLengthAt(x: number, y: number, z: number): number {
  let fl = 0;
  for (const [r, w] of getSculpt().attribution(x, y, z).regionWeights) fl += FUR_LENGTH[r] * w;
  return fl;
}

/**
 * Mesh the creature sculpt and bake skinning, colour and fur length into a
 * BufferGeometry (cached per palette; cloned by callers if they mutate it).
 */
export function creatureGeometry(pal: CreaturePalette, resolution = 0.0028): THREE.BufferGeometry {
  const key = JSON.stringify(pal) + resolution;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = getSculpt();
  const d = (x: number, y: number, z: number) => S.d(x, y, z);
  const mesh = surfaceNets(d, [-0.13, -0.012, -0.19], [0.13, 0.33, 0.135], resolution, 0);
  const n = mesh.positions.length / 3;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), color = new Float32Array(n * 3), furLen = new Float32Array(n), thin = new Float32Array(n);
  // Ear frames (same as the sculpt's fins): along the fin, and across it in its plane.
  const earFrame = (['L', 'R'] as const).map((side) => {
    const s = side === 'L' ? 1 : -1;
    const base = BONES.find(([nm]) => nm === (`ear${side}` as BoneName))![2] as V;
    const r = alignX([0.8 * s, 0.42, -0.42], [0, 1, 0.3]);
    return { s, base, X: [r[0], r[1], r[2]], Z: [r[6], r[7], r[8]] };
  });
  const cBody = new THREE.Color(pal.body), cDark = new THREE.Color(pal.bodyDark), cBelly = new THREE.Color(pal.belly), cBlush = new THREE.Color(pal.blush);
  const cPink = new THREE.Color(0xf4a7b1), cEar = new THREE.Color(0xf7b9c4), cVein = new THREE.Color(0xd65a6e);
  const c = new THREE.Color();
  for (let v = 0; v < n; v++) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
    const att = S.attribution(x, y, z);
    att.bones.forEach((b, q) => {
      skinIndex[v * 4 + q] = boneIndex.get(b.bone) ?? 0;
      skinWeight[v * 4 + q] = b.w;
    });
    const rw = (r: Region) => att.regionWeights.get(r) ?? 0;
    let fl = 0;
    for (const [r, w] of att.regionWeights) fl += FUR_LENGTH[r] * w;
    // Around the eye sockets the fur gets short and the skin a little darker:
    // a clean soft "eyeliner" instead of hairs stabbing into the eyeball.
    const eyeD = Math.min(
      Math.hypot(x - EYE.L[0], (y - EYE.L[1]) / 1.08, z - EYE.L[2]),
      Math.hypot(x - EYE.R[0], (y - EYE.R[1]) / 1.08, z - EYE.R[2]),
    ) / EYE_RADIUS;
    const rim = 1 - smooth(1.0, 1.42, eyeD);
    furLen[v] = fl * (1 - 0.85 * rim);
    // Wispy fluff inside the ear cups.
    if (att.region === 'ear') furLen[v] *= 1 + 0.9 * smooth(0.2, 0.7, 0.6 * ny + 0.6 * nz);
    // --- colour ---
    c.copy(cBody);
    // Subtle mottling so it never looks like flat plastic.
    const mott = fbm(x * 60, y * 60, z * 60);
    c.lerp(cDark, 0.12 * mott);
    // Darker crown and back.
    if (ny > 0.45 && (att.region === 'head' || att.region === 'brow')) c.lerp(cDark, 0.45 * smooth(0.45, 1, ny));
    if (nz < -0.25 && y > 0.08) c.lerp(cDark, 0.3 * smooth(-0.25, -0.8, nz));
    // Soft leopard-ish spots on the back and haunches.
    if (nz < -0.1 || att.region === 'thigh') {
      const sp = vnoise(x * 70 + 11, y * 70, z * 70);
      if (sp > 0.62) c.lerp(cDark, smooth(0.62, 0.72, sp) * 0.75);
    }
    // Cream belly / chest / muzzle / cheeks.
    const front = smooth(0.15, 0.6, nz);
    const bellyMask = (rw('belly') + rw('chest') + rw('neck') * 0.6) * front * smooth(0.205, 0.15, y);
    c.lerp(cBelly, Math.min(1, bellyMask * 1.1 + (rw('belly') + rw('chest')) * front * 0.6));
    c.lerp(cBelly, Math.min(1, rw('muzzle') * 1.0 + rw('cheek') * smooth(0.0, 0.7, nz) * smooth(0.25, -0.2, ny) * 0.85));
    // Rosy cheeks.
    if (att.region === 'cheek') c.lerp(cBlush, 0.18 * smooth(0.2, 0.7, nz) * smooth(0.3, -0.1, ny));
    // Pink inner ears.
    // Pink inner ears (the fins face up and forward), darker backs.
    if (rw('ear') > 0.05) {
      const inner = 0.6 * ny + 0.6 * nz;
      const f = earFrame[x > 0 ? 0 : 1];
      const dx = x - f.base[0], dy = y - f.base[1], dz = z - f.base[2];
      const u = (dx * f.X[0] + dy * f.X[1] + dz * f.X[2]) / 0.075; // 0 root .. 1 tip
      const w = (dx * f.Z[0] + dy * f.Z[1] + dz * f.Z[2]) / 0.018; // across the fin
      // A central vein from the root that forks twice towards the tip.
      const vein = Math.max(
        1 - smooth(0.0, 0.14, Math.abs(w - 0.05)),
        (1 - smooth(0.0, 0.12, Math.abs(w - 0.05 - 0.75 * (u - 0.3)))) * smooth(0.3, 0.4, u),
        (1 - smooth(0.0, 0.12, Math.abs(w - 0.05 + 0.7 * (u - 0.45)))) * smooth(0.45, 0.55, u),
      ) * smooth(0.12, 0.3, u) * (1 - smooth(0.8, 1.0, u));
      if (att.region === 'ear') {
        c.lerp(cDark, 0.5 * smooth(-0.1, -0.6, inner));
        c.lerp(cEar, 0.85 * smooth(0.15, 0.55, inner));
        // Deeper, warmer pink down in the cup, fading lighter towards the thin rim.
        c.lerp(cBlush, 0.3 * smooth(0.5, 0.9, inner) * (1 - smooth(0.6, 1.0, u)));
        // Faint rosy veins on the pink side.
        c.lerp(cVein, 0.6 * vein * smooth(0.1, 0.5, inner));
      }
      // Thin towards the tip and rim; veins block a little of the glow.
      thin[v] = rw('ear') * smooth(0.05, 0.45, u) * (1 - 0.45 * vein);
    }
    // Paws: cream soles, pink beans.
    if (att.region === 'foot' && ny < -0.4) c.lerp(cBelly, 0.85);
    // Pink beans only underneath (seen when it lifts a paw), not as painted tips.
    if (att.region === 'toe' || att.region === 'finger') c.lerp(cPink, 0.75 * smooth(-0.2, -0.6, ny));
    if (att.region === 'hand') c.lerp(cPink, 0.45 * smooth(-0.45, -0.8, ny));
    if (att.region === 'hand' && nz > 0.4) c.lerp(cBelly, 0.4);
    // Tail stripes and a dark tuft.
    if (att.region === 'tail') {
      const st = Math.sin(z * 140 - y * 60);
      if (st > 0.35 && ny + -nz > -0.2) c.lerp(cDark, 0.6);
    }
    if (att.region === 'tuft') c.lerp(cDark, 0.7);
    // Socket liner.
    c.lerp(cDark, 0.22 * rim).multiplyScalar(1 - 0.18 * rim);
    // Baked ambient occlusion: creases (armpits, under the chin, between the
    // toes, ear roots, eye sockets) get darker, like dense fur self-shadowing.
    const ao = occlusion(S, x, y, z, mesh.normals[v * 3], ny, nz);
    // Paws get deeper creases so the toes read as separate beans.
    const paw = rw('toe') + rw('foot') * 0.6 + rw('finger');
    c.multiplyScalar(0.5 + 0.5 * ao - 0.25 * paw * (1 - ao));
    // Toe tops a touch lighter, like worn fur on the knuckles.
    c.lerp(cBelly, 0.18 * rw('toe') * smooth(0.2, 0.8, ny + nz * 0.5) * ao);
    // Tiny brightness variation.
    const varn = 0.94 + 0.12 * vnoise(x * 300, y * 300, z * 300);
    color[v * 3] = c.r * varn;
    color[v * 3 + 1] = c.g * varn;
    color[v * 3 + 2] = c.b * varn;
  }
  // Fix triangle winding to agree with the SDF normals.
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, cc = idx[t + 2] * 3;
    const P = mesh.positions;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[cc] - P[a], wy = P[cc + 1] - P[a + 1], wz = P[cc + 2] - P[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const N = mesh.normals;
    if (fx * (N[a] + N[b] + N[cc]) + fy * (N[a + 1] + N[b + 1] + N[cc + 1]) + fz * (N[a + 2] + N[b + 2] + N[cc + 2]) < 0) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setAttribute('furLen', new THREE.BufferAttribute(furLen, 1));
  geo.setAttribute('thin', new THREE.BufferAttribute(thin, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  cache.set(key, geo);
  return geo;
}

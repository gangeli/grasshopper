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
  /** Strength of the dark back spots and saddle (1 = full; lighter for palettes whose dark tone is strong). */
  markings?: number;
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

/** Broad occlusion (a few cm out): under the head, between the legs, behind the arms. */
function broadOcclusion(S: { d(x: number, y: number, z: number): number }, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  let occ = 0;
  for (let h = 0.016; h < 0.04; h += 0.016) {
    const d = S.d(x + nx * h, y + ny * h, z + nz * h);
    occ += Math.max(0, Math.min(1, (h - d) / h));
  }
  return Math.max(0, 1 - 0.75 * (occ / 2));
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
  // Eye-socket rim (0..1), the brightness ratio that removes the socket liner when the
  // eyes are closed, and how much the hollow above the eye fills in then.
  const socket = new Float32Array(n * 3);
  // Groom direction per vertex (the fur shader lays the strands along its tangential part).
  const flow = new Float32Array(n * 3);
  const tailPts = (['hips', 'tail0', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5'] as BoneName[]).map((b) => BONES.find(([nm]) => nm === b)![2] as V);
  tailPts[0] = [0, 0.082, -0.025];
  const bonePos = (b: BoneName) => BONES.find(([nm]) => nm === b)![2] as V;
  const F = [0, 0, 0];
  const armDir = (['L', 'R'] as const).map((sd) => {
    const a = bonePos(`shoulder${sd}`), b = bonePos(`hand${sd}`);
    return [b[0] - a[0], b[1] - a[1] - 0.02, b[2] - a[2]];
  });
  const addF = (w: number, ax: number, ay: number, az: number) => {
    const l = Math.hypot(ax, ay, az) || 1;
    F[0] += (w * ax) / l;
    F[1] += (w * ay) / l;
    F[2] += (w * az) / l;
  };
  const mk = pal.markings ?? 1;
  const cSpot = new THREE.Color(pal.body).lerp(new THREE.Color(pal.bodyDark), 0.55 + 0.45 * mk);
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
    // Tufty, not uniform: low-frequency length variation.
    furLen[v] *= 0.78 + 0.44 * vnoise(x * 38 + 3, y * 38, z * 38);
    // Wispy fluff inside the ear cups.
    if (att.region === 'ear') furLen[v] *= 1 + 0.9 * smooth(0.2, 0.7, 0.6 * ny + 0.6 * nz);
    // --- groom direction ---
    {
      const nx = mesh.normals[v * 3];
      F[0] = F[1] = F[2] = 0;
      const sx = x >= 0 ? 1 : -1;
      for (const [r, w] of att.regionWeights) {
        switch (r) {
          case 'head':
          case 'brow':
          case 'muzzle':
            // Away from the nose: back over the crown, out across the face.
            addF(w, x, y - 0.228, z - 0.11);
            break;
          case 'cheek':
            addF(w, sx * 0.9, -0.5, -0.45);
            break;
          case 'ear': {
            const f = earFrame[x > 0 ? 0 : 1];
            addF(w, f.X[0], f.X[1], f.X[2]);
            break;
          }
          case 'neck':
          case 'chest':
          case 'belly':
            addF(w, sx * 0.15 * Math.abs(nx), -1, 0.1);
            break;
          case 'body':
            addF(w, sx * 0.2 * Math.abs(nx), -0.75, -0.65);
            break;
          case 'thigh':
            addF(w, sx * 0.1, -0.6, -0.8);
            break;
          case 'shin':
            addF(w, 0, -1, -0.25);
            break;
          case 'foot':
          case 'toe':
          case 'hand':
          case 'finger':
            addF(w, 0, -0.3, 1);
            break;
          case 'arm': {
            const d = armDir[sx > 0 ? 0 : 1];
            addF(w, d[0], d[1], d[2]);
            break;
          }
          case 'tail': {
            // Along the nearest tail segment, towards the tip.
            let best = Infinity, dx = 0, dy = 0, dz = -1;
            for (let q = 0; q < tailPts.length - 1; q++) {
              const A = tailPts[q], B = tailPts[q + 1];
              const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2];
              const t = Math.max(0, Math.min(1, ((x - A[0]) * ex + (y - A[1]) * ey + (z - A[2]) * ez) / (ex * ex + ey * ey + ez * ez)));
              const dd = Math.hypot(x - A[0] - ex * t, y - A[1] - ey * t, z - A[2] - ez * t);
              if (dd < best) {
                best = dd;
                dx = ex;
                dy = ey;
                dz = ez;
              }
            }
            addF(w, dx, dy, dz);
            break;
          }
          case 'tuft':
            addF(w, 0, 0.9, 0.35);
            break;
        }
      }
      // Gentle swirls so it never looks machine-combed.
      const fx = F[0] + 0.17 * Math.sin(y * 140 + z * 60);
      const fy = F[1] + 0.17 * Math.sin(z * 130 + x * 70);
      const fz = F[2] + 0.17 * Math.sin(x * 150 + y * 50);
      // How flat the coat lies: the tail brush stands out from the tail like a bottlebrush.
      const lay = 1 - 0.55 * rw('tuft') - 0.2 * rw('tail');
      const fl2 = (Math.hypot(fx, fy, fz) || 1) / lay;
      flow[v * 3] = fx / fl2;
      flow[v * 3 + 1] = fy / fl2;
      flow[v * 3 + 2] = fz / fl2;
    }
    // --- colour ---
    c.copy(cBody);
    // Subtle mottling so it never looks like flat plastic.
    const mott = fbm(x * 60, y * 60, z * 60);
    c.lerp(cDark, 0.12 * mott);
    // Broad, gentle hue and value drift across the body (no animal is one flat colour).
    const hv = vnoise(x * 14 + 20, y * 14, z * 14) - 0.5;
    c.offsetHSL(hv * 0.06, -0.04, hv * 0.05);
    // Darker crown and back.
    if (ny > 0.45 && (att.region === 'head' || att.region === 'brow')) c.lerp(cDark, 0.45 * smooth(0.45, 1, ny));
    if (nz < -0.25 && y > 0.08) c.lerp(cDark, (0.12 + 0.16 * mk) * smooth(-0.25, -0.8, nz));
    // Countershading: a darker stripe down the spine, from the crown to the tail.
    if (y > 0.06 && z < 0.03 && (ny > 0.2 || nz < -0.2)) c.lerp(cDark, 0.38 * (1 - smooth(0.004, 0.022, Math.abs(x))) * smooth(0.2, 0.7, Math.max(ny, -nz)) * (att.region === 'tail' || att.region === 'tuft' ? 0 : 1));
    // Soft dapples on the back and haunches: domain-warped so they're rounded,
    // irregular and feathered at the edges (not hard blotches), fading in
    // towards the spine.
    const backM = Math.max(smooth(-0.05, -0.4, nz), att.region === 'thigh' ? smooth(-0.3, 0.2, -nz) : 0);
    if (backM > 0) {
      const wx = vnoise(x * 22 + 5, y * 22, z * 22) - 0.5, wy = vnoise(x * 22, y * 22 + 7, z * 22) - 0.5;
      const sp = vnoise(x * 52 + 11 + wx * 1.6, y * 52 + wy * 1.6, z * 52);
      c.lerp(cSpot, smooth(0.55, 0.75, sp) * (0.62 + 0.38 * mk) * backM);
    }
    // Cream belly / chest / muzzle / cheeks.
    // Feathered, irregular edge where the cream front meets the coat.
    const front = smooth(0.15, 0.6, nz + 0.3 * (vnoise(x * 42, y * 42 + 3, z * 42) - 0.5));
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
        // Pale furnishings (the fluff inside the ear) low in the cup.
        c.lerp(cBelly, 0.4 * smooth(0.45, 0.85, inner) * (1 - smooth(0.15, 0.45, u)));
      }
      // Thin towards the tip and rim; veins block a little of the glow.
      thin[v] = rw('ear') * smooth(0.05, 0.45, u) * (1 - 0.45 * vein);
      // A little lynx tuft at the tip.
      furLen[v] *= 1 + 2.2 * smooth(0.78, 0.98, u) * rw('ear');
    }
    // Paws: cream soles, pink beans.
    if (att.region === 'foot' && ny < -0.4) c.lerp(cBelly, 0.85);
    // Pink beans only underneath (seen when it lifts a paw), not as painted tips.
    // Pink beans underneath, peeking out along the front-lower edge of each toe
    // so the paw reads as three beans even from standing height.
    if (att.region === 'toe') c.lerp(cPink, 0.8 * smooth(0.1, -0.45, ny) * smooth(-0.2, 0.3, nz - ny));
    if (att.region === 'finger') c.lerp(cPink, 0.75 * smooth(-0.2, -0.6, ny));
    if (att.region === 'hand') c.lerp(cPink, 0.45 * smooth(-0.45, -0.8, ny));
    if (att.region === 'hand' && nz > 0.4) c.lerp(cBelly, 0.4);
    // Tail stripes and a dark tuft.
    if (att.region === 'tail') {
      const st = Math.sin(z * 140 - y * 60);
      if (st > 0.35 && ny + -nz > -0.2) c.lerp(cDark, 0.6);
    }
    if (att.region === 'tuft') c.lerp(cDark, 0.45);
    // Socket liner (the shader fades it out while the eyes are closed, so a
    // closed lid melts into the face instead of sitting in a dark goggle ring).
    const lumBefore = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    c.lerp(cDark, 0.22 * rim).multiplyScalar(1 - 0.18 * rim);
    // Baked ambient occlusion: creases (armpits, under the chin, between the
    // toes, ear roots, eye sockets) get darker, like dense fur self-shadowing.
    const ao = occlusion(S, x, y, z, mesh.normals[v * 3], ny, nz);
    // Paws get deeper creases so the toes read as separate beans.
    const paw = rw('toe') + rw('foot') * 0.6 + rw('finger');
    // Broad occlusion and a gentle darkening towards the ground give the body form.
    const aoB = broadOcclusion(S, x, y, z, mesh.normals[v * 3], ny, nz);
    const aoK = (0.5 + 0.5 * ao - 0.32 * paw * (1 - ao)) * (0.6 + 0.4 * aoB) * (0.86 + 0.14 * smooth(0.0, 0.07, y));
    c.multiplyScalar(aoK);
    if (rim > 0) {
      const lumOpen = (c.r * 0.3 + c.g * 0.59 + c.b * 0.11);
      const lumClosed = lumBefore * THREE.MathUtils.lerp(aoK, Math.max(aoK, 0.92), rim);
      socket[v * 3] = rim;
      socket[v * 3 + 1] = Math.min(3, lumClosed / Math.max(1e-4, lumOpen));
      // Only the brow side fills: the lash line along the bottom must stay visible.
      socket[v * 3 + 2] = rim * rim * smooth(-0.35, 0.45, (y - EYE.L[1]) / EYE_RADIUS);
    } else socket[v * 3 + 1] = 1;
    // Painted grooves between the toes (the sculpted ones are soft at a distance).
    const toeW = rw('toe') + rw('foot');
    if (toeW > 0.05 && y < 0.03 && z > 0.008) {
      const gx = Math.abs(Math.abs(x) - 0.052);
      const groove = Math.exp(-Math.pow((gx - 0.00625) / 0.0019, 2)) * smooth(0.008, 0.02, z);
      c.multiplyScalar(1 - 0.55 * groove * Math.min(1, toeW));
    }
    // Toe tops a touch lighter, like worn fur on the knuckles.
    c.lerp(cBelly, 0.3 * rw('toe') * smooth(0.2, 0.8, ny + nz * 0.5) * ao);
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
  geo.setAttribute('flow', new THREE.BufferAttribute(flow, 3));
  geo.setAttribute('socket', new THREE.BufferAttribute(socket, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  cache.set(key, geo);
  return geo;
}

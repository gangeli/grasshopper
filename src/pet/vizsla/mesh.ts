import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { broadOcclusion, fbm, occlusion, smooth, vnoise } from '../sdf/meshCreature';
import type { Sculpt } from '../sdf/sdf';
import { surfaceNets } from '../sdf/surfaceNets';
import type { V } from '../skeleton';
import { DOG_BONES, DOG_P, type DogBoneName } from './skeleton';
import {
  buildJawSculpt, buildVizslaSculpt, DOG_COLLAR, DOG_EYE, DOG_EYE_RADIUS, DOG_EYE_SCALE, DOG_FUR, DOG_JAW, DOG_PAW_F, DOG_PAW_H, DOG_TOE_DX, mouthHollows, mouthRim,
  type DogRegion,
} from './sculpt';

/** Coat and leather colours of a Vizsla (the first seven fields are the shared pet palette). */
export interface VizslaPalette {
  /** The coat: golden rust, solid all over. */
  body: number;
  /** A shade deeper, along the back, crown and ears. */
  bodyDark: number;
  /** The lighter shadings: underline, breeches, inside of the legs, throat. */
  belly: number;
  /** Inside of the mouth and ears. */
  blush: number;
  /** The glowing tag on the collar (hints). */
  glow: number;
  eye: number;
  /** The collar. */
  wing: number;
  /** Nose, lips, eye rims, pads and nails: a Vizsla has no black anywhere. */
  leather: number;
}

const boneIndex = new Map(DOG_BONES.map(([n], i) => [n as string, i]));

let sculpt: Sculpt<DogRegion> | null = null;
let jawSculpt: Sculpt<DogRegion> | null = null;
const getSculpt = () => (sculpt ??= buildVizslaSculpt());
const getJaw = () => (jawSculpt ??= buildJawSculpt());

/** Snap a point onto the Vizsla's skin: surface point and outward normal. */
export function dogSurfaceAt(x: number, y: number, z: number, S: { d(x: number, y: number, z: number): number } = getSculpt()): { p: THREE.Vector3; n: THREE.Vector3 } {
  const e = 0.0004;
  const n = new THREE.Vector3();
  for (let it = 0; it < 10; it++) {
    n.set(S.d(x + e, y, z) - S.d(x - e, y, z), S.d(x, y + e, z) - S.d(x, y - e, z), S.d(x, y, z + e) - S.d(x, y, z - e)).normalize();
    const dv = S.d(x, y, z);
    x -= n.x * dv;
    y -= n.y * dv;
    z -= n.z * dv;
  }
  return { p: new THREE.Vector3(x, y, z), n };
}

/** A point on the lower jaw's surface (rest pose, pet space). */
export function jawSurfaceAt(x: number, y: number, z: number) {
  return dogSurfaceAt(x, y, z, getJaw());
}

/** Signed distance to the Vizsla's skin (m; negative inside). */
export function dogSkinDistance(x: number, y: number, z: number): number {
  return getSculpt().d(x, y, z);
}

export function dogFurAt(x: number, y: number, z: number): number {
  let fl = 0;
  for (const [r, w] of getSculpt().attribution(x, y, z).regionWeights) fl += DOG_FUR[r] * w;
  return fl;
}

interface Baked {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  furLen: Float32Array;
  thin: Float32Array;
  flow: Float32Array;
  silk: Float32Array;
  socket: Float32Array;
}

function toGeometry(b: Baked): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(b.color, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(b.skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(b.skinWeight, 4));
  geo.setAttribute('furLen', new THREE.BufferAttribute(b.furLen, 1));
  geo.setAttribute('thin', new THREE.BufferAttribute(b.thin, 1));
  geo.setAttribute('flow', new THREE.BufferAttribute(b.flow, 3));
  geo.setAttribute('silk', new THREE.BufferAttribute(b.silk, 1));
  geo.setAttribute('socket', new THREE.BufferAttribute(b.socket, 3));
  geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
  return geo;
}

function blank(n: number): Omit<Baked, 'positions' | 'normals' | 'indices'> {
  return {
    color: new Float32Array(n * 3),
    skinIndex: new Uint16Array(n * 4),
    skinWeight: new Float32Array(n * 4),
    furLen: new Float32Array(n),
    thin: new Float32Array(n),
    flow: new Float32Array(n * 3),
    silk: new Float32Array(n),
    socket: new Float32Array(n * 3),
  };
}

/** Make triangle winding agree with the field's normals. */
function fixWinding(idx: Uint32Array, P: Float32Array, N: Float32Array): void {
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    if (fx * (N[a] + N[b] + N[c]) + fy * (N[a + 1] + N[b + 1] + N[c + 1]) + fz * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  }
}

/** Direction of the nearest segment of a polyline (towards its end). */
function alongPolyline(pts: V[], x: number, y: number, z: number, out: number[]): void {
  let best = Infinity;
  for (let q = 0; q < pts.length - 1; q++) {
    const A = pts[q], B = pts[q + 1];
    const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2];
    const t = Math.max(0, Math.min(1, ((x - A[0]) * ex + (y - A[1]) * ey + (z - A[2]) * ez) / (ex * ex + ey * ey + ez * ez)));
    const dd = Math.hypot(x - A[0] - ex * t, y - A[1] - ey * t, z - A[2] - ez * t);
    if (dd < best) {
      best = dd;
      out[0] = ex;
      out[1] = ey;
      out[2] = ez;
    }
  }
}

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * The Vizsla's skin: the body sculpt, the lower jaw and the two ears, meshed,
 * skinned, coloured and groomed, merged into one geometry (so the coat's
 * shells draw everything at once). Cached per palette and resolution.
 */
export function vizslaGeometry(pal: VizslaPalette, resolution = 0.0026): THREE.BufferGeometry {
  const key = JSON.stringify(pal) + resolution;
  const hit = cache.get(key);
  if (hit) return hit;
  const geo = mergeGeometries([toGeometry(bakeBody(pal, resolution)), toGeometry(bakeJaw(pal, Math.min(resolution, 0.0022))), earGeometry(1, pal), earGeometry(-1, pal)]);
  geo.computeBoundingSphere();
  cache.set(key, geo);
  return geo;
}

function bakeBody(pal: VizslaPalette, resolution: number): Baked {
  const S = getSculpt();
  const mesh = surfaceNets((x, y, z) => S.d(x, y, z), [-0.075, -0.008, -0.245], [0.075, 0.322, 0.25], resolution, 0);
  const n = mesh.positions.length / 3;
  const out = blank(n);
  const { color, skinIndex, skinWeight, furLen, flow, silk, socket } = out;
  const hollows = mouthHollows();
  const mouthD = (x: number, y: number, z: number) => Math.min(hollows[0].d(x, y, z), hollows[1].d(x, y, z));
  const cBody = new THREE.Color(pal.body), cDark = new THREE.Color(pal.bodyDark), cLight = new THREE.Color(pal.belly);
  const cLeather = new THREE.Color(pal.leather), cMouth = new THREE.Color(pal.blush);
  const cPad = cLeather.clone().multiplyScalar(0.62);
  const tailPts: V[] = [[0, 0.1895, -0.098], DOG_P.tail0, DOG_P.tail1, DOG_P.tail2, DOG_P.tail3, DOG_P.tail4, DOG_P.tail5, [0, 0.1875, -0.2215]];
  const leg = (side: 'L' | 'R'): { fore: V[]; hind: V[] } => ({
    fore: [DOG_P[`shoulder${side}`], DOG_P[`elbow${side}`], DOG_P[`hand${side}`], [DOG_P[`hand${side}`][0], 0, DOG_P[`hand${side}`][2] + 0.012]],
    hind: [DOG_P[`thigh${side}`], DOG_P[`shin${side}`], DOG_P[`ankle${side}`], DOG_P[`toe${side}`]],
  });
  const legs = { L: leg('L'), R: leg('R') };
  const F = [0, 0, 0], D = [0, 0, 0];
  const addF = (w: number, ax: number, ay: number, az: number) => {
    const l = Math.hypot(ax, ay, az) || 1;
    F[0] += (w * ax) / l;
    F[1] += (w * ay) / l;
    F[2] += (w * az) / l;
  };
  const c = new THREE.Color();
  for (let v = 0; v < n; v++) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const nx = mesh.normals[v * 3], ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
    const att = S.attribution(x, y, z);
    att.bones.forEach((b, q) => {
      skinIndex[v * 4 + q] = boneIndex.get(b.bone) ?? 0;
      skinWeight[v * 4 + q] = b.w;
    });
    const rw = (r: DogRegion) => att.regionWeights.get(r) ?? 0;
    const sx = x >= 0 ? 1 : -1, side = x >= 0 ? 'L' : 'R';
    let fl = 0;
    for (const [r, w] of att.regionWeights) fl += DOG_FUR[r] * w;
    // Inside the mouth (the hollow under the muzzle that the jaw closes into): bare palate.
    const mouthK = y < 0.262 && z > DOG_JAW.back - 0.004 ? 1 - smooth(0.0005, 0.002, Math.abs(mouthD(x, y, z))) : 0;
    // Eye rims: bare, pigmented skin right at the lids.
    const e = DOG_EYE[side];
    const eyeD = Math.hypot(x - e[0], (y - e[1]) / DOG_EYE_SCALE[1], z - e[2]) / DOG_EYE_RADIUS;
    const rim = 1 - smooth(1.0, 1.45, eyeD);
    // Pads under the paws.
    const paw = rw('finger') + rw('hand') * 0.7 + rw('toe');
    const pad = paw > 0.3 && y < 0.02 ? smooth(-0.45, -0.8, ny) : 0;
    // (Bare only on the leather itself, which the nose's own mesh covers: a wide bald
    // patch round it would show as a pale disc on the end of the muzzle.)
    const noseK = smooth(0.55, 0.85, rw('nose'));
    const leather = Math.max(noseK, pad);
    fl *= (1 - 0.85 * rim) * (1 - mouthK) * (1 - leather);
    // Sleek, but not machine-even.
    fl *= 0.86 + 0.28 * vnoise(x * 45 + 3, y * 45, z * 45);
    // Pressed flat under the collar.
    if (rw('neck') > 0.2) {
      const K = DOG_COLLAR;
      const along = (x - K.at[0]) * K.axis[0] + (y - K.at[1]) * K.axis[1] + (z - K.at[2]) * K.axis[2];
      fl *= 0.22 + 0.78 * smooth(K.half + 0.001, K.half + 0.007, Math.abs(along));
    }
    furLen[v] = fl;
    // --- groom: nose to tail along the body, down the legs ---
    F[0] = F[1] = F[2] = 0;
    for (const [r, w] of att.regionWeights) {
      switch (r) {
        case 'head':
        case 'brow':
        case 'cheek':
        case 'muzzle':
        case 'lip':
        case 'nose':
          // Away from the nose: back along the muzzle, up over the skull, out and down across the cheeks.
          addF(w, x * 0.8, (y - 0.262) * 0.8, z - 0.24);
          break;
        case 'neck':
          // Down the neck towards the shoulders; a parting down the throat.
          addF(w, sx * 0.25 * Math.abs(nx), -0.75, -0.65);
          break;
        case 'chest':
          addF(w, sx * 0.5 * Math.abs(nx), -1, -0.1);
          break;
        case 'body':
          addF(w, 0, -0.42 * Math.abs(nx), -1);
          break;
        case 'belly':
          addF(w, 0, -0.2, -1);
          break;
        case 'thigh':
          addF(w, 0, -0.75, -0.65);
          break;
        case 'arm':
        case 'forearm':
        case 'hand':
        case 'finger':
          alongPolyline(legs[side].fore, x, y, z, D);
          addF(w, D[0], D[1], D[2]);
          break;
        case 'shin':
        case 'foot':
        case 'toe':
          alongPolyline(legs[side].hind, x, y, z, D);
          addF(w, D[0], D[1], D[2] + (r === 'toe' ? 0.03 : 0));
          break;
        case 'tail':
          alongPolyline(tailPts, x, y, z, D);
          addF(w, D[0], D[1], D[2]);
          break;
      }
    }
    {
      const fx = F[0] + 0.06 * Math.sin(y * 140 + z * 60);
      const fy = F[1] + 0.06 * Math.sin(z * 130 + x * 70);
      const fz = F[2] + 0.06 * Math.sin(x * 150 + y * 50);
      // The coat lies close.
      const fl2 = (Math.hypot(fx, fy, fz) || 1) / 1.25;
      flow[v * 3] = fx / fl2;
      flow[v * 3 + 1] = fy / fl2;
      flow[v * 3 + 2] = fz / fl2;
    }
    // A short smooth coat doesn't part into locks.
    silk[v] = 0.75;
    // --- colour: solid golden rust, with the breed's lighter shadings ---
    c.copy(cBody);
    const hv = vnoise(x * 16 + 20, y * 16, z * 16) - 0.5;
    c.offsetHSL(hv * 0.012, 0, hv * 0.035);
    c.lerp(cDark, 0.06 * fbm(x * 70, y * 70, z * 70));
    const trunk = rw('body') + rw('belly') + rw('chest') + rw('neck');
    const limbW = rw('arm') + rw('forearm') + rw('hand') + rw('finger') + rw('thigh') + rw('shin') + rw('foot') + rw('toe');
    // A shade deeper along the top line: crown, crest of the neck, back, top of the tail.
    // (Fading out down the muzzle, not stopping at the stop: a hard edge there reads as a mask.)
    const faceTop = 0.8 * (rw('head') + rw('brow')) + (0.8 - 0.55 * smooth(0.175, 0.215, z)) * rw('muzzle');
    c.lerp(cDark, 0.34 * smooth(0.45, 0.98, ny) * (trunk + rw('tail') + faceTop + 0.5 * rw('thigh')));
    // Lighter underneath, feathered at the edge: brisket, belly, flank.
    const feather = 0.25 * (vnoise(x * 48, y * 48 + 3, z * 48) - 0.5);
    c.lerp(cLight, 0.62 * smooth(-0.1, -0.8, ny + feather) * trunk);
    // Forechest and throat.
    c.lerp(cLight, 0.26 * smooth(0.25, 0.9, nz + feather) * (rw('chest') + 0.6 * rw('neck')) * smooth(0.22, 0.14, y));
    c.lerp(cLight, 0.34 * rw('neck') * smooth(-0.1, -0.7, ny - 0.5 * nz + feather));
    // Inside of the legs and the breeches behind the thighs.
    c.lerp(cLight, 0.5 * smooth(0.15, 0.85, -nx * sx + feather) * limbW);
    c.lerp(cLight, 0.26 * smooth(0.3, 0.95, -nz) * (rw('thigh') + 0.5 * rw('shin')) * smooth(0.19, 0.12, y));
    // Under the tail.
    c.lerp(cLight, 0.35 * rw('tail') * smooth(-0.2, -0.8, ny));
    // Face: a little lighter round the lips and under the cheeks, as the coat thins.
    c.lerp(cLight, 0.22 * (rw('lip') + 0.5 * rw('muzzle')) * smooth(0.1, -0.5, ny));
    c.lerp(cLight, 0.18 * rw('cheek') * smooth(0.2, -0.6, ny));
    // Feet: the short hair between the toes is a touch paler on top.
    c.lerp(cLight, 0.16 * (rw('finger') + rw('toe')) * smooth(0.2, 0.8, ny));
    // The toes are parted by shadowed grooves (the sculpted ones are too fine to read at a distance).
    if (paw > 0.3 && y < 0.024) {
      const front = z > 0;
      const pz = front ? DOG_PAW_F[2] : DOG_PAW_H[2];
      const gx = Math.abs(Math.abs(x) - DOG_PAW_F[0]);
      const gap = 0.5 * (DOG_TOE_DX[2] + DOG_TOE_DX[3]);
      const groove = Math.max(Math.exp(-Math.pow(gx / 0.001, 2)), Math.exp(-Math.pow((gx - gap) / 0.001, 2))) * smooth(pz + 0.002, pz + 0.008, z) * smooth(0.022, 0.014, y);
      c.multiplyScalar(1 - 0.5 * groove * Math.min(1, paw));
    }
    // Nose leather, lip line and pads (flesh-brown, never black).
    c.lerp(cLeather, noseK);
    c.lerp(cLeather, 0.85 * rw('lip') * smooth(-0.25, -0.75, ny) * (1 - mouthK));
    c.lerp(cPad, pad);
    // Mouth lining: darker towards the throat, ridged like a palate.
    if (mouthK > 0) {
      const deep = smooth(DOG_JAW.c[2] + 0.02, DOG_JAW.back, z);
      const ridge = 0.5 + 0.5 * Math.sin(z * 1500);
      const lining = cMouth.clone().multiplyScalar((0.92 - 0.38 * deep) * (0.9 + 0.1 * ridge));
      // The lips' inner edge is leather; the lining begins just inside it.
      const inside = smooth(0.93, 0.74, mouthRim(x, z));
      c.lerp(cLeather.clone().multiplyScalar(0.62).lerp(lining, inside), mouthK);
    }
    // Eye rims: a liner of leather that fades out while the eyes are shut.
    const lumBefore = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    c.lerp(cLeather, 0.5 * rim).multiplyScalar(1 - 0.12 * rim);
    // Baked occlusion: under the jaw, between the legs, the elbows, between the toes.
    const ao = occlusion(S, x, y, z, nx, ny, nz);
    const aoB = broadOcclusion(S, x, y, z, nx, ny, nz);
    const toes = rw('finger') + rw('toe');
    const hollow = 1 - smooth(1.0, 1.9, eyeD);
    let aoK = (0.52 + 0.48 * ao - 0.3 * toes * (1 - ao)) * (0.62 + 0.38 * aoB) * (0.9 + 0.1 * smooth(0.0, 0.06, y));
    // (The socket is filled by the eye: don't let its hollow black out the lids' surround.)
    aoK = THREE.MathUtils.lerp(aoK, Math.max(aoK, 0.78), hollow);
    // (Nor the mouth: an open mouth should read as pink, not as a black hole.)
    aoK = THREE.MathUtils.lerp(aoK, Math.max(aoK, 0.72), mouthK);
    c.multiplyScalar(aoK);
    if (hollow > 0) {
      const lumOpen = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
      const lumClosed = (rim > 0 ? lumBefore : lumOpen / Math.max(1e-4, aoK)) * THREE.MathUtils.lerp(aoK, Math.max(aoK, 0.95), hollow);
      socket[v * 3] = rim;
      socket[v * 3 + 1] = Math.min(3, lumClosed / Math.max(1e-4, lumOpen));
      socket[v * 3 + 2] = rim * rim * smooth(-0.35, 0.45, (y - e[1]) / DOG_EYE_RADIUS);
    } else socket[v * 3 + 1] = 1;
    const varn = 0.965 + 0.07 * vnoise(x * 300, y * 300, z * 300);
    color[v * 3] = c.r * varn;
    color[v * 3 + 1] = c.g * varn;
    color[v * 3 + 2] = c.b * varn;
  }
  fixWinding(mesh.indices, mesh.positions, mesh.normals);
  return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, ...out };
}

function bakeJaw(pal: VizslaPalette, resolution: number): Baked {
  const S = getJaw();
  const mesh = surfaceNets((x, y, z) => S.d(x, y, z), [-0.024, 0.228, 0.146], [0.024, 0.26, 0.23], resolution, 1);
  const n = mesh.positions.length / 3;
  const out = blank(n);
  const jaw = boneIndex.get('jaw')!;
  const cBody = new THREE.Color(pal.body), cLight = new THREE.Color(pal.belly), cLeather = new THREE.Color(pal.leather), cMouth = new THREE.Color(pal.blush);
  const body = getSculpt();
  const c = new THREE.Color();
  for (let v = 0; v < n; v++) {
    const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
    const nx = mesh.normals[v * 3], ny = mesh.normals[v * 3 + 1], nz = mesh.normals[v * 3 + 2];
    out.skinIndex[v * 4] = jaw;
    out.skinWeight[v * 4] = 1;
    // The top of the jaw is the floor of the mouth; its rim is the lower lip.
    // (Only well inside the lips: the band below the lip line is coat, like the chin.)
    const rimK = mouthRim(x, z);
    const top = smooth(0.2, 0.6, ny) * smooth(0.86, 0.76, rimK);
    const lip = smooth(0.05, 0.4, ny) * (1 - top);
    out.furLen[v] = DOG_FUR.jaw * (1 - top) * (1 - 0.8 * lip) * (0.86 + 0.28 * vnoise(x * 45 + 3, y * 45, z * 45));
    const fl = Math.hypot(0.15 * nx, 0.3, 1) / 1.25;
    out.flow[v * 3] = (0.15 * nx) / fl;
    out.flow[v * 3 + 1] = -0.3 / fl;
    out.flow[v * 3 + 2] = -1 / fl;
    out.silk[v] = 0.75;
    out.socket[v * 3 + 1] = 1;
    // Chin and underjaw are among the lighter shadings.
    c.copy(cBody).lerp(cLight, 0.3 + 0.25 * smooth(0, -0.8, ny));
    c.lerp(cLeather, 0.9 * lip);
    const deep = smooth(DOG_JAW.c[2] + 0.02, DOG_JAW.back, z);
    c.lerp(cMouth.clone().multiplyScalar(0.9 - 0.36 * deep), top);
    // Shaded by its own creases and by the muzzle above it.
    const ao = occlusion(S, x, y, z, nx, ny, nz);
    const under = broadOcclusion(body, x, y, z, nx, ny, nz);
    c.multiplyScalar((0.55 + 0.45 * ao) * (0.7 + 0.3 * under) * (1 - 0.25 * smooth(-0.3, -0.9, ny)));
    out.color[v * 3] = c.r;
    out.color[v * 3 + 1] = c.g;
    out.color[v * 3 + 2] = c.b;
  }
  fixWinding(mesh.indices, mesh.positions, mesh.normals);
  return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, ...out };
}

/** Length of the ear leather and where its second joint is along it. */
export const EAR_LENGTH = 0.06;

/**
 * A point on the ear's mid-surface (pet space, rest pose). u runs from the
 * set-on (0) to the tip (1), v from the back edge (-1) to the front edge (1).
 * The leather leaves the skull sideways, folds over and hangs close to the
 * cheek, long and thin with a rounded tip, its edges curling in a little.
 */
function earPoint(s: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const base = DOG_P.earL;
  // Centre line: out of the skull over a soft fold, then down close to the cheek, swinging a little forward.
  const fold = Math.sin(Math.min(1, u / 0.26) * Math.PI * 0.5);
  const cx = base[0] - 0.004 + 0.0112 * fold + 0.002 * u;
  const cy = base[1] + 0.0018 * Math.sin(Math.min(1, u / 0.14) * Math.PI) - EAR_LENGTH * Math.pow(u, 1.08);
  const cz = base[2] + 0.001 + 0.012 * u * u;
  // Half-width: broadest a third of the way down, tapering to a rounded tip.
  const w = u < 0.35 ? THREE.MathUtils.lerp(0.0112, 0.0146, smooth(0, 0.35, u)) : 0.0146 * Math.pow(Math.max(0, 1 - Math.pow((u - 0.35) / 0.65, 2.5)), 0.55);
  // The edges curl in towards the head, the front edge more.
  const curl = (0.003 * v * v + 0.001 * v) * smooth(0.12, 0.6, u);
  out.set((cx - curl) * s, cy - 0.003 * v * (1 - u), cz + w * v * (1 - 0.08 * u));
  return out;
}

/** One pendant ear as a thin closed surface with the same attributes as the body skin. */
function earGeometry(s: number, pal: VizslaPalette): THREE.BufferGeometry {
  const NU = 26, NV = 12;
  const side = s > 0 ? 'L' : 'R';
  const iHead = boneIndex.get('head')!, iEar = boneIndex.get(`ear${side}` as DogBoneName)!, iEar1 = boneIndex.get(`ear${side}1` as DogBoneName)!;
  const count = (NU + 1) * (NV + 1) * 2;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const out = blank(count);
  const cOut = new THREE.Color(pal.body).lerp(new THREE.Color(pal.bodyDark), 0.55);
  const cIn = new THREE.Color(pal.body).lerp(new THREE.Color(pal.belly), 0.45).lerp(new THREE.Color(pal.blush), 0.08);
  const p = new THREE.Vector3(), pu = new THREE.Vector3(), pv = new THREE.Vector3(), nrm = new THREE.Vector3(), tan = new THREE.Vector3();
  const c = new THREE.Color();
  const joint = (DOG_P.earL[1] - DOG_P.earL1[1]) / EAR_LENGTH;
  for (let layer = 0; layer < 2; layer++)
    for (let i = 0; i <= NU; i++)
      for (let j = 0; j <= NV; j++) {
        const u = i / NU, v = (j / NV) * 2 - 1;
        const k = (layer * (NU + 1) + i) * (NV + 1) + j;
        earPoint(s, u, v, p);
        // (The surface's frame is taken a little in from the tip and the edges, where the leather closes to a point.)
        const un = Math.min(u, 0.94), vn = THREE.MathUtils.clamp(v, -0.9, 0.9);
        earPoint(s, un + 0.01, vn, pu).sub(earPoint(s, Math.max(0, un - 0.01), vn, tan));
        earPoint(s, un, vn + 0.02, pv).sub(earPoint(s, un, vn - 0.02, tan));
        // Outward normal of the mid-surface (away from the head).
        nrm.crossVectors(pv, pu).normalize();
        if (nrm.x * s < 0) nrm.negate();
        // Thin leather: thickest down the middle near the set-on, a fine edge all round.
        const edge = Math.sqrt(Math.max(0, 1 - v * v)) * Math.sqrt(Math.max(0, 1 - Math.pow(u, 6)));
        const half = (0.0016 - 0.0007 * u) * (0.12 + 0.88 * edge);
        const sign = layer === 0 ? 1 : -1;
        positions.set([p.x + nrm.x * half * sign, p.y + nrm.y * half * sign, p.z + nrm.z * half * sign], k * 3);
        normals.set([nrm.x * sign, nrm.y * sign, nrm.z * sign], k * 3);
        // Skinning: head at the set-on, then the two ear joints.
        const w0 = 1 - smooth(0.0, 0.14, u), w2 = smooth(joint - 0.14, joint + 0.14, u);
        out.skinIndex.set([iHead, iEar, iEar1, 0], k * 4);
        out.skinWeight.set([w0, (1 - w0) * (1 - w2), (1 - w0) * w2, 0], k * 4);
        // Velvet outside, almost bare inside.
        out.furLen[k] = (layer === 0 ? 0.0015 : 0.0006) * (0.9 + 0.2 * vnoise(p.x * 60, p.y * 60, p.z * 60)) * (0.3 + 0.7 * edge);
        tan.copy(pu).normalize().multiplyScalar(1.25);
        out.flow.set([tan.x, tan.y, tan.z], k * 3);
        out.silk[k] = 0.9;
        out.socket[k * 3 + 1] = 1;
        // Light glows faintly through the leather.
        out.thin[k] = 0.22 * smooth(0.1, 0.5, u);
        if (layer === 0) c.copy(cOut).multiplyScalar(0.94 + 0.1 * vnoise(p.x * 90, p.y * 90, p.z * 90));
        // (The lining turns to the coat's colour at the rim, or the edge would show as a pale line.)
        else c.copy(cIn).multiplyScalar(0.55 + 0.22 * edge).lerp(cOut, 0.85 * smooth(0.45, 0.1, edge));
        // Shaded where it lies against the head.
        c.multiplyScalar(layer === 0 ? 0.88 + 0.12 * smooth(0.0, 0.2, u) : 0.75);
        out.color.set([c.r, c.g, c.b], k * 3);
      }
  const idx: number[] = [];
  for (let layer = 0; layer < 2; layer++)
    for (let i = 0; i < NU; i++)
      for (let j = 0; j < NV; j++) {
        const a = (layer * (NU + 1) + i) * (NV + 1) + j, b = a + NV + 1;
        // Outer layer faces out; the inner layer is wound the other way.
        if ((layer === 0) === (s > 0)) idx.push(a, a + 1, b, b, a + 1, b + 1);
        else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
  return toGeometry({ positions, normals, indices: new Uint32Array(idx), ...out });
}

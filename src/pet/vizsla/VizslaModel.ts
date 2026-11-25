import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addSocketFade, addTranslucency, DEFAULT_FUR, makeFurShellMaterial, type FurOptions } from '../furMaterial';
import { buildEye, catchlightTexture, irisTexture, noseGeometry, pebbleTexture, radialTexture, scleraMaterial, smooth, tubeGeometry } from '../parts';
import type { FaceRig, PetOptions, PetRig } from '../PetModel';
import type { BoneName } from '../skeleton';
import { dogFurAt, dogSkinDistance, dogSurfaceAt, jawSurfaceAt, vizslaGeometry, type VizslaPalette } from './mesh';
import { DOG_EYE, DOG_EYE_PITCH, DOG_EYE_RADIUS, DOG_EYE_SCALE, DOG_EYE_SPLAY, DOG_MOUTH, DOG_NOSE, DOG_PAW_F, DOG_PAW_H, DOG_TOE_DX } from './sculpt';
import { DOG_BONES, DOG_HEAD_SAMPLE, type DogBoneName } from './skeleton';

/**
 * A Hungarian Vizsla: lean and golden-rust all over (nose, eye rims and nails
 * included), with long silky ears, amber eyes and a docked tail that rarely
 * stops wagging.
 *
 * Built the way Hopper is (see PetModel): the body is a signed-distance
 * sculpt, meshed and skinned automatically, under a short shell coat; the
 * eyes are Hopper's eye rig at a dog's size. What differs is what a dog
 * needs: a lower jaw that opens (its own little sculpt on a jaw bone, closing
 * into a channel carved under the muzzle) over a tongue and teeth, thin
 * two-jointed ear leathers, four legs, and a collar whose tag glows for hints
 * in place of Hopper's antennae.
 */
export const VIZSLA_PALETTES: Record<string, VizslaPalette> = {
  // The breed's golden rust.
  golden: { body: 0xb5672f, bodyDark: 0x8e4a20, belly: 0xd09c68, blush: 0xc0606c, glow: 0xffd56a, eye: 0x9c6524, wing: 0x2f8f78, leather: 0x8f5038 },
  // Deeper, redder.
  russet: { body: 0xa2532a, bodyDark: 0x7a3a1b, belly: 0xc48a5c, blush: 0xb85864, glow: 0x9ffcff, eye: 0x8a5520, wing: 0x33507f, leather: 0x7d4230 },
  // Pale, sandy gold.
  sandy: { body: 0xc68a4c, bodyDark: 0xa2662f, belly: 0xe0b98a, blush: 0xc66a74, glow: 0xfff07a, eye: 0xa87430, wing: 0xb5483e, leather: 0x9a5c40 },
};

export function buildVizsla(paletteName: string | VizslaPalette = 'golden', opts: PetOptions = {}): PetRig {
  const pal: VizslaPalette = typeof paletteName === 'string' ? (VIZSLA_PALETTES[paletteName] ?? VIZSLA_PALETTES.golden) : paletteName;
  const group = new THREE.Group();
  group.name = 'Hopper';
  const scaler = new THREE.Group();
  scaler.name = 'scaler';
  group.add(scaler);

  // --- Skeleton -------------------------------------------------------------
  const bones = {} as Record<DogBoneName, THREE.Bone>;
  const rest = {} as Record<DogBoneName, THREE.Vector3>;
  const abs = {} as Record<DogBoneName, THREE.Vector3>;
  for (const [name, parent, p] of DOG_BONES) {
    const b = new THREE.Bone();
    b.name = name;
    abs[name] = new THREE.Vector3(...p);
    const local = parent ? abs[name].clone().sub(abs[parent]) : abs[name].clone();
    b.position.copy(local);
    rest[name] = local.clone();
    bones[name] = b;
    if (parent) bones[parent].add(b);
  }
  scaler.add(bones.root);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(DOG_BONES.map(([n]) => bones[n]));

  // --- Materials --------------------------------------------------------------
  const cBody = new THREE.Color(pal.body), cDark = new THREE.Color(pal.bodyDark), cLight = new THREE.Color(pal.belly), cLeather = new THREE.Color(pal.leather);
  // A short coat over tight skin: a little sheen, where Hopper's fluff is matte.
  const skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0 });
  const eyeClosed = { value: 0 }, eyeFill = { value: 0 }, eyeSquint = { value: 0 };
  const underCoat = { value: 1 };
  skin.onBeforeCompile = (shader) => {
    addTranslucency(shader);
    addSocketFade(shader, eyeClosed, eyeFill, eyeSquint);
    shader.uniforms.uUnderCoat = underCoat;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float furLen;\nuniform float uUnderCoat;\nvarying float vUnderK;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUnderK = mix(1.0, uUnderCoat, smoothstep(0.003, 0.008, furLen));');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vUnderK;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vUnderK;');
  };
  skin.customProgramCacheKey = () => 'skin-thin-sock-under';
  // The collar tag glows (hints), as Hopper's antenna bulbs do.
  const glowHsl = new THREE.Color(pal.glow).getHSL({ h: 0, s: 0, l: 0 });
  const glowDeep = new THREE.Color().setHSL(glowHsl.h, Math.min(1, glowHsl.s * 1.1 + 0.1), glowHsl.l * 0.78);
  const glowMaterial = new THREE.MeshStandardMaterial({ color: pal.glow, emissive: glowDeep, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.35 });
  const lidColor = cBody.clone().lerp(cDark, 0.2);
  const lowerLidColor = cBody.clone();
  // Dogs show very little white: the "sclera" is a warm, shaded brown-white.
  const sclera = scleraMaterial(cLeather.clone().multiplyScalar(0.8));
  sclera.color.set(0xe9dccb);
  const irisMat = new THREE.MeshStandardMaterial({ map: irisTexture(pal.eye), roughness: 0.4 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.3 });
  const corneaMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false, envMapIntensity: 2.2 });
  const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: catchlightTexture(), transparent: true, depthWrite: false });
  const lidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const lashMat = new THREE.MeshStandardMaterial({ color: cLeather.clone().multiplyScalar(0.5), roughness: 0.7 });
  const tearMat = new THREE.MeshPhysicalMaterial({ color: 0xd9a08e, vertexColors: true, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, depthWrite: false });
  const pebble = pebbleTexture();
  // Nose leather: flesh-brown, moist.
  const noseMat = new THREE.MeshPhysicalMaterial({ color: cLeather.clone().multiplyScalar(0.92), vertexColors: true, roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.25, bumpMap: pebble, bumpScale: 0.6, envMapIntensity: 0.7 });
  const whiskerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, transparent: true, opacity: 0.8 });
  const tongueMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xf6f1e4, roughness: 0.32 });
  const nailMat = new THREE.MeshStandardMaterial({ color: cLeather.clone().lerp(cLight, 0.25), roughness: 0.38 });
  const collarMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0xd8c9a0, roughness: 0.3, metalness: 0.85 });
  const materials: THREE.Material[] = [skin, glowMaterial, sclera, irisMat, pupilMat, corneaMat, shineMat, lidMat, lashMat, tearMat, noseMat, whiskerMat, tongueMat, toothMat, nailMat, collarMat, metalMat];

  // --- Body and coat ----------------------------------------------------------
  const addSkinned = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string) => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    m.frustumCulled = false;
    scaler.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    return m;
  };
  const url = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const low = url?.get('lod') === 'low';
  const mobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|Quest|OculusBrowser/.test(navigator.userAgent);
  // Finer than Hopper's mesh: a dog's lips, toes and hocks are small.
  const bodyGeo = vizslaGeometry(pal, opts.meshResolution ?? (low ? 0.004 : mobile ? 0.003 : 0.0025));
  const body = addSkinned(bodyGeo, skin, 'body');
  body.castShadow = true;
  // A sleek coat needs fewer layers than Hopper's fluff.
  const furOpts: FurOptions = { ...DEFAULT_FUR, shells: 8, density: 1500, clump: 260, gravity: 0.08, ...opts.fur };
  const urlFur = url?.get('fur') ?? null;
  const shells = opts.furShells ?? (urlFur !== null ? Number(urlFur) : low ? 2 : mobile ? 5 : furOpts.shells);
  furOpts.lengthScale ??= 1;
  const few = Math.pow(THREE.MathUtils.clamp((8 - shells) / 6, 0, 1), 1.3);
  furOpts.tone ??= 1 - 0.04 * few;
  for (let q = 1; q <= shells; q++) {
    const mat = makeFurShellMaterial(q / shells, furOpts, skin, { closed: eyeClosed, fill: eyeFill, squint: eyeSquint });
    materials.push(mat);
    const shell = addSkinned(bodyGeo, mat, `fur${q}`);
    shell.castShadow = false;
    shell.renderOrder = q;
  }

  const toHead = (v: THREE.Vector3) => v.clone().sub(abs.head);
  const toJaw = (v: THREE.Vector3) => v.clone().sub(abs.jaw);

  // --- Eyes ----------------------------------------------------------------------
  const R = DOG_EYE_RADIUS;
  // Lid colours: the baked coat just above and below each socket.
  const P = bodyGeo.attributes.position, C = bodyGeo.attributes.color, K = bodyGeo.attributes.socket;
  const near: number[] = [];
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), e = DOG_EYE[x > 0 ? 'L' : 'R'];
    if (Math.hypot(x - e[0], P.getY(i) - e[1], P.getZ(i) - e[2]) < R * 2.4) near.push(i);
  }
  const sockCol = (upper: boolean) => {
    const acc = new THREE.Color(0, 0, 0);
    let w = 0;
    for (const i of near) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const e = DOG_EYE[x > 0 ? 'L' : 'R'];
      const d = Math.hypot(x - e[0], y - e[1], z - e[2]) / R;
      if (d < 1.3 || d > 1.85 || y > e[1] !== upper || z < e[2] - 0.003) continue;
      acc.r += C.getX(i);
      acc.g += C.getY(i);
      acc.b += C.getZ(i);
      w++;
    }
    return w ? acc.multiplyScalar(1 / w) : null;
  };
  const skinColor = (p: THREE.Vector3) => {
    let best = -1, bd = Infinity;
    for (const i of near) {
      const d = (P.getX(i) - p.x) ** 2 + (P.getY(i) - p.y) ** 2 + (P.getZ(i) - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const k = best < 0 ? 1 : K.getY(best) || 1;
    return best < 0 ? lidColor.clone() : new THREE.Color(C.getX(best), C.getY(best), C.getZ(best)).multiplyScalar(Math.min(1.6, k) * 1.15);
  };
  const upCol = sockCol(true), loCol = sockCol(false);
  if (upCol) lidColor.copy(upCol).multiplyScalar(1.1);
  if (loCol) lowerLidColor.copy(loCol).multiplyScalar(1.06);
  const lidShells = shells > 0 ? Math.min(6, shells) : 0;
  const lidFur = makeFurShellMaterial(-1, furOpts, lidMat);
  materials.push(lidFur);
  const mkEye = (side: 'L' | 'R') =>
    buildEye(side, {
      head: bones.head,
      headAbs: abs.head,
      center: DOG_EYE[side],
      radius: R,
      pitch: DOG_EYE_PITCH,
      splay: DOG_EYE_SPLAY,
      scale: DOG_EYE_SCALE,
      skinDistance: dogSkinDistance,
      mats: { sclera, irisMat, pupilMat, corneaMat, shineMat, lidMat, lowerLidMat: lidMat, lashMat, tearMat },
      lid: { upper: lidColor, lower: lowerLidColor, fur: lidFur, shells: lidShells, skinColor },
      // A dog's eye is nearly all iris.
      irisFrac: 0.8,
      lashes: false,
      lidFur: 0.0016,
    });
  const L = mkEye('L'), Rr = mkEye('R');

  // --- Nose: a broad leather with open, comma-shaped nostrils ----------------------
  {
    const { p, n } = dogSurfaceAt(...DOG_NOSE);
    const nose = new THREE.Mesh(noseGeometry(), noseMat);
    nose.name = 'nose';
    nose.scale.set(0.0102, 0.0079, 0.0052);
    nose.position.copy(toHead(p.clone().addScaledVector(n, -0.0016)));
    nose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.clone().lerp(new THREE.Vector3(0, 0, 1), 0.5).normalize());
    bones.head.add(nose);
  }

  // --- Whiskers: fine and coat-coloured ---------------------------------------------
  for (const s of [1, -1]) {
    const hairs: THREE.BufferGeometry[] = [];
    const cW = cLight.clone().lerp(new THREE.Color(1, 1, 1), 0.35);
    [
      [0.0105, 0.2615, 0.214, 0.021, 0.25],
      [0.0125, 0.2575, 0.209, 0.025, 0.05],
      [0.0125, 0.2535, 0.206, 0.022, -0.2],
      [0.0135, 0.2625, 0.203, 0.019, 0.4],
    ].forEach(([x, y, z, len, fan]) => {
      const { p } = dogSurfaceAt(x * s, y, z);
      const dir = new THREE.Vector3(s, fan, 0.35).normalize();
      const p0 = toHead(p);
      const pts = [p0, p0.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, 0.0012, 0)), p0.clone().addScaledVector(dir, len).add(new THREE.Vector3(0, -0.002, -0.002))];
      hairs.push(tubeGeometry(pts, [0, 0, 0], (t) => THREE.MathUtils.lerp(0.00032, 0.00008, t), (t) => cW.clone().multiplyScalar(0.85 + 0.15 * t), 5, 18));
    });
    const wh = new THREE.Mesh(mergeGeometries(hairs), whiskerMat);
    wh.name = `whiskers${s > 0 ? 'L' : 'R'}`;
    bones.head.add(wh);
  }

  // --- Teeth and tongue -------------------------------------------------------------
  const tooth = (base: THREE.Vector3, tip: THREE.Vector3, r: number) => {
    const len = base.distanceTo(tip);
    const g = new THREE.ConeGeometry(r, len, 7);
    // Blunt the point a little and flatten side to side.
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(base).normalize()));
    g.translate(base.x, base.y, base.z);
    return g;
  };
  {
    const M = DOG_MOUTH;
    // Lower teeth stand on the jaw, either side of the tongue's bed.
    const lower: THREE.BufferGeometry[] = [];
    const jawTop = (x: number, z: number) => toJaw(jawSurfaceAt(x, 0.262, z).p);
    for (const s of [1, -1]) {
      const c0 = jawTop(0.0056 * s, 0.2105);
      lower.push(tooth(c0.clone().add(new THREE.Vector3(0, -0.001, 0)), c0.clone().add(new THREE.Vector3(0.0006 * s, 0.0052, -0.0008)), 0.00165));
      for (let q = 0; q < 4; q++) {
        const b = jawTop((0.0068 + 0.0004 * q) * s, 0.2035 - q * 0.0052);
        lower.push(tooth(b.clone().add(new THREE.Vector3(0, -0.0008, 0)), b.clone().add(new THREE.Vector3(0, 0.0022 + 0.0004 * (q % 2), 0)), 0.0015));
      }
    }
    for (let q = 0; q < 6; q++) {
      const a = ((q + 0.5) / 6 - 0.5) * 1.9;
      const b = jawTop(Math.sin(a) * 0.0046, 0.2128 + Math.cos(a) * 0.0034);
      lower.push(tooth(b.clone().add(new THREE.Vector3(0, -0.0006, 0)), b.clone().add(new THREE.Vector3(0, 0.0019, 0.0003)), 0.00085));
    }
    const lowerTeeth = new THREE.Mesh(mergeGeometries(lower), toothMat);
    lowerTeeth.name = 'teethLower';
    bones.jaw.add(lowerTeeth);
    // Upper teeth hang from the roof of the channel; the closed jaw hides them.
    const upper: THREE.BufferGeometry[] = [];
    const roof = (x: number, z: number) => {
      const t = THREE.MathUtils.clamp((z - M.back[2]) / (M.front[2] - M.back[2]), 0, 1);
      const r = THREE.MathUtils.lerp(M.rBack, M.rFront, t);
      return toHead(new THREE.Vector3(x, M.back[1] + Math.sqrt(Math.max(1e-8, r * r - x * x)) + 0.0006, z));
    };
    for (const s of [1, -1]) {
      const c0 = roof(0.0074 * s, 0.2135);
      upper.push(tooth(c0, c0.clone().add(new THREE.Vector3(0.0004 * s, -0.0062, 0.0004)), 0.0018));
      for (let q = 0; q < 4; q++) {
        const b = roof((0.0082 + 0.0005 * q) * s, 0.2055 - q * 0.0055);
        upper.push(tooth(b, b.clone().add(new THREE.Vector3(0, -0.0026 - 0.0005 * (q % 2), 0)), 0.0016));
      }
    }
    for (let q = 0; q < 6; q++) {
      const a = ((q + 0.5) / 6 - 0.5) * 1.9;
      const b = roof(Math.sin(a) * 0.0056, 0.2148 + Math.cos(a) * 0.0036);
      upper.push(tooth(b, b.clone().add(new THREE.Vector3(0, -0.0024, 0.0002)), 0.00095));
    }
    const upperTeeth = new THREE.Mesh(mergeGeometries(upper), toothMat);
    upperTeeth.name = 'teethUpper';
    bones.head.add(upperTeeth);
  }
  const tongue = new THREE.Mesh(tongueGeometry(abs.jaw, new THREE.Color(pal.blush)), tongueMat);
  tongue.name = 'tongue';
  tongue.updateMorphTargets();
  bones.jaw.add(tongue);

  // --- Nails: short, strong, flesh-brown ------------------------------------------------
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    for (const [bone, paw] of [
      [`hand${side}`, DOG_PAW_F],
      [`toe${side}`, DOG_PAW_H],
    ] as const) {
      const nails: THREE.BufferGeometry[] = [];
      for (const dx of DOG_TOE_DX) {
        const g = new THREE.ConeGeometry(0.00165, 0.0054, 7);
        g.rotateX(Math.PI / 2 + 0.75);
        g.rotateY(dx * s * 14);
        g.translate(paw[0] * s + dx * s * 1.06, paw[1] - 0.0066, paw[2] + 0.0128 - Math.abs(dx) * 0.42 + 0.0072);
        nails.push(g);
      }
      const mesh = new THREE.Mesh(mergeGeometries(nails), nailMat);
      mesh.name = `nails${bone}`;
      mesh.position.copy(abs[bone as DogBoneName]).negate();
      bones[bone as DogBoneName].add(mesh);
    }
  }

  // --- Collar with a glowing tag ----------------------------------------------------------
  {
    // Fitted to the neck: a ring of points on the skin in a plane across it.
    const a = new THREE.Vector3(0, 0.19, 0.066), b = new THREE.Vector3(0, 0.2625, 0.128);
    const axis = b.clone().sub(a).normalize();
    const centre = a.clone().lerp(b, 0.47).add(new THREE.Vector3(0, -0.006, 0.006));
    const side = new THREE.Vector3(1, 0, 0), fwd = new THREE.Vector3().crossVectors(side, axis).normalize();
    const N = 48;
    const ringPts: THREE.Vector3[] = [], outs: THREE.Vector3[] = [];
    for (let q = 0; q < N; q++) {
      const ang = (q / N) * Math.PI * 2;
      const dir = side.clone().multiplyScalar(Math.sin(ang)).addScaledVector(fwd, Math.cos(ang));
      // March out from the middle of the neck to the skin.
      let t = 0.012;
      for (let it = 0; it < 60; it++) {
        const p = centre.clone().addScaledVector(dir, t);
        const d = dogSkinDistance(p.x, p.y, p.z);
        if (d > -0.0002) break;
        t += Math.max(0.0004, -d * 0.8);
      }
      const p = centre.clone().addScaledVector(dir, t);
      ringPts.push(p.addScaledVector(dir, dogFurAt(p.x, p.y, p.z) * 0.6 + 0.0012));
      outs.push(dir);
    }
    const collar = new THREE.Mesh(bandGeometry(ringPts, outs, axis, 0.0042, 0.0011, new THREE.Color(pal.wing)), collarMat);
    collar.name = 'collar';
    collar.castShadow = true;
    collar.position.copy(abs.neck).negate();
    bones.neck.add(collar);
    // The tag hangs from a little ring at the front of the throat (q = 0 is straight ahead and down).
    const front = ringPts[0].clone().addScaledVector(outs[0], 0.0016);
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.0024, 0.00055, 6, 14), metalMat);
    loop.position.copy(front.clone().add(new THREE.Vector3(0, -0.0022, 0)).sub(abs.neck));
    loop.rotation.y = Math.PI / 2;
    bones.neck.add(loop);
    const tag = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.0014, 22).rotateX(Math.PI / 2), glowMaterial);
    tag.name = 'tag';
    tag.castShadow = true;
    tag.position.copy(front.clone().add(new THREE.Vector3(0, -0.0102, 0.0006)).sub(abs.neck));
    tag.rotation.x = 0.35;
    bones.neck.add(tag);
    const haloMat = new THREE.SpriteMaterial({ map: radialTexture(), color: pal.glow, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    materials.push(haloMat);
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(0.034);
    halo.renderOrder = 50;
    halo.onBeforeRender = () => {
      haloMat.opacity = Math.min(0.7, Math.max(0, 0.36 * (glowMaterial.emissiveIntensity - 0.75)));
    };
    tag.add(halo);
  }

  const face: FaceRig = {
    eyeL: L.eye,
    eyeR: Rr.eye,
    irisL: L.iris,
    irisR: Rr.iris,
    lidUpL: L.up,
    lidUpR: Rr.up,
    lidLoL: L.lo,
    lidLoR: Rr.lo,
    eyeClosed,
    eyeFill,
    eyeSquint,
    lidMats: [lidMat, lidFur],
    eyeDepth: DOG_EYE_SCALE[2],
    irisToe: DOG_EYE_SPLAY * 0.8,
    tongue,
  };
  group.traverse((o) => {
    if ((o as THREE.Mesh).material === tearMat) o.onBeforeRender = () => (tearMat.opacity = 0.85 * (1 - Math.min(1, eyeClosed.value * 1.6)));
  });
  return {
    species: 'vizsla',
    group,
    bones: bones as Record<BoneName, THREE.Bone>,
    rest: rest as Record<BoneName, THREE.Vector3>,
    skeleton,
    scaler,
    face,
    materials,
    glowMaterial,
    palette: { ...pal },
    headSample: new THREE.Vector3(...DOG_HEAD_SAMPLE),
  };
}

/**
 * The tongue, in the jaw bone's frame: a flat, round-tipped blade lying in
 * its bed, with a groove down the middle. Morph target 0 lolls it out over
 * the lower teeth (panting); morph target 1 arches the middle (a lick, a yawn).
 */
function tongueGeometry(jawAbs: THREE.Vector3, pink: THREE.Color): THREE.BufferGeometry {
  const NU = 22, NV = 14;
  const M = DOG_MOUTH;
  const z0 = M.back[2] - 0.004, z1 = 0.2125, yBed = 0.2535;
  const pos: number[] = [], out: number[] = [], arch: number[] = [], col: number[] = [], idx: number[] = [];
  const cTip = pink.clone().lerp(new THREE.Color(0xff9aa5), 0.55), cRoot = pink.clone().multiplyScalar(0.72);
  const c = new THREE.Color();
  for (let i = 0; i <= NU; i++) {
    const t = i / NU;
    // Half-width: even along the blade, rounding off at the tip.
    const w = 0.0064 * (0.82 + 0.18 * smooth(t / 0.5)) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 5)));
    const th = 0.0019 * (1 - 0.35 * t) * Math.sqrt(Math.max(0.02, 1 - Math.pow(t, 8)));
    for (let j = 0; j <= NV; j++) {
      const a = (j / NV) * Math.PI * 2;
      const cx = Math.sin(a), cy = Math.cos(a);
      const groove = cy > 0 ? 0.00055 * Math.exp(-(cx * cx) / 0.05) * (1 - 0.6 * t) : 0;
      const x = cx * w, y = cy * th - groove, z = THREE.MathUtils.lerp(z0, z1, t);
      pos.push(x - jawAbs.x, yBed + y - jawAbs.y, z - jawAbs.z);
      // Out: slides forward, widens, and the front third drapes over the teeth and hangs.
      const reach = 0.0215 * Math.pow(t, 1.25);
      const droop = smooth((t - 0.5) / 0.5);
      const zz = z + reach - 0.0065 * droop * droop;
      const yy = yBed + 0.0016 * Math.sin(Math.PI * Math.min(1, t / 0.6)) + y * (1 - 0.25 * droop) - 0.0128 * droop * droop - (cy > 0 ? 0 : 0.0006 * droop);
      out.push(x * (1 + 0.16 * smooth(t / 0.7)) - x, yy - (yBed + y), zz - z);
      // Arch: the middle lifts.
      arch.push(0, 0.0034 * Math.sin(Math.PI * t) * (1 - 0.5 * cx * cx), 0.002 * t);
      c.copy(cRoot).lerp(cTip, smooth(t / 0.8)).multiplyScalar(cy > 0 ? 1 - 1.6 * groove * 1000 * 0.25 : 0.82);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NU; i++)
    for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j, b = a + NV + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(out, 3), new THREE.Float32BufferAttribute(arch, 3)];
  g.morphTargetsRelative = true;
  return g;
}

/**
 * A flat band (a collar) through a closed ring of points: `width` along
 * `axis`, `thick` along each point's outward direction, with rounded edges
 * and a line of stitching.
 */
function bandGeometry(ring: THREE.Vector3[], outs: THREE.Vector3[], axis: THREE.Vector3, width: number, thick: number, color: THREE.Color): THREE.BufferGeometry {
  const N = ring.length, M = 10;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i <= N; i++) {
    const p = ring[i % N], o = outs[i % N];
    for (let j = 0; j < M; j++) {
      const a = (j / M) * Math.PI * 2;
      // Rounded-rectangle cross-section.
      const ca = Math.cos(a), sa = Math.sin(a);
      const u = Math.sign(ca) * Math.pow(Math.abs(ca), 0.45) * width, w = Math.sign(sa) * Math.pow(Math.abs(sa), 0.7) * thick;
      pos.push(p.x + axis.x * u + o.x * w, p.y + axis.y * u + o.y * w, p.z + axis.z * u + o.z * w);
      // Stitching near both edges on the outside.
      const stitch = sa > 0.3 && Math.abs(Math.abs(ca) - 0.72) < 0.2 && i % 2 === 0 ? 1.35 : 1;
      c.copy(color).multiplyScalar((sa > 0 ? 1 : 0.6) * stitch);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < N; i++)
    for (let j = 0; j < M; j++) {
      const a = i * M + j, b = i * M + ((j + 1) % M), a2 = a + M, b2 = b + M;
      idx.push(a, a2, b, b, a2, b2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * "Hopper": a small fantasy creature, part baby dragon and part grasshopper.
 * It has a big round head with huge eyes, glowing antennae, leaf-like ear
 * fins, stubby arms, strong hind legs for hopping, little wings and a curly
 * tail with a leaf tuft.
 *
 * The body is one continuous mesh sculpted as a signed distance field (see
 * sdf/creature.ts), meshed with surface nets and skinned automatically to a
 * real bone hierarchy. Fur is drawn as shells on top of the body. The eyes,
 * nose, mouth and antennae are separate parts attached to bones. Rest-pose
 * bones have identity rotation, so animation is plain local rotations. The pet
 * faces +Z with Y up and feet at y=0.
 */

import { BONES, type BoneName } from './skeleton';
import { creatureGeometry, furLengthAt, surfaceAt } from './sdf/meshCreature';
import { EYE, EYE_RADIUS, MOUTH, NOSE } from './sdf/creature';
import { DEFAULT_FUR, makeFurShellMaterial, type FurOptions } from './furMaterial';
export { HEAD_CENTER, HEAD_RADIUS, type BoneName } from './skeleton';

export interface PetPalette {
  body: number;
  bodyDark: number;
  belly: number;
  blush: number;
  glow: number;
  eye: number;
  wing: number;
}

export const PALETTES: Record<string, PetPalette> = {
  mint: { body: 0x5ccf9f, bodyDark: 0x2f9a78, belly: 0xfff0c4, blush: 0xff8fa3, glow: 0xffd56a, eye: 0x2e6b3f, wing: 0x9ff3ff },
  plum: { body: 0xa98bea, bodyDark: 0x6a4fb8, belly: 0xffe7f2, blush: 0xff8fb8, glow: 0x9ffcff, eye: 0x5a2d82, wing: 0xffc8f0 },
  ember: { body: 0xff9f5a, bodyDark: 0xd2633a, belly: 0xfff3d6, blush: 0xff6f7f, glow: 0xfff07a, eye: 0x6b5a14, wing: 0xffe39a },
};

export interface PetRig {
  group: THREE.Group;
  bones: Record<BoneName, THREE.Bone>;
  rest: Record<BoneName, THREE.Vector3>;
  skeleton: THREE.Skeleton;
  /** Squash/stretch pivot between the root group and the bones. */
  scaler: THREE.Group;
  face: FaceRig;
  materials: THREE.Material[];
  /** Emissive antenna tips, so hints can make them glow. */
  glowMaterial: THREE.MeshStandardMaterial;
  palette: PetPalette;
}

export interface FaceRig {
  eyeL: THREE.Group;
  eyeR: THREE.Group;
  /** Rotating iris groups (look direction). */
  irisL: THREE.Group;
  irisR: THREE.Group;
  lidUpL: THREE.Mesh;
  lidUpR: THREE.Mesh;
  lidLoL: THREE.Mesh;
  lidLoR: THREE.Mesh;
  mouth: THREE.Group;
  mouthOpen: THREE.Mesh;
  smile: THREE.Mesh;
  blushL: THREE.Mesh;
  blushR: THREE.Mesh;
  blushMat: THREE.MeshBasicMaterial;
}

export interface PetOptions {
  /** Body mesh resolution (m); coarser is cheaper. */
  meshResolution?: number;
  /** Fur shells (0 = no fur; phones may want fewer). */
  furShells?: number;
  fur?: Partial<FurOptions>;
}

export function buildPet(paletteName: keyof typeof PALETTES | PetPalette = 'mint', opts: PetOptions = {}): PetRig {
  const pal = typeof paletteName === 'string' ? PALETTES[paletteName] : paletteName;
  const group = new THREE.Group();
  group.name = 'Hopper';
  const scaler = new THREE.Group();
  scaler.name = 'scaler';
  group.add(scaler);

  // --- Skeleton -------------------------------------------------------------
  const bones = {} as Record<BoneName, THREE.Bone>;
  const rest = {} as Record<BoneName, THREE.Vector3>;
  const abs = {} as Record<BoneName, THREE.Vector3>;
  for (const [name, parent, p] of BONES) {
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
  const boneList = BONES.map(([n]) => bones[n]);
  const boneIndex = (n: BoneName) => BONES.findIndex(([m]) => m === n);
  // Inverse bind matrices come from the rest pose, so update matrices first.
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);

  // --- Materials --------------------------------------------------------------
  const skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const glowMaterial = new THREE.MeshStandardMaterial({ color: pal.glow, emissive: pal.glow, emissiveIntensity: 0.9, roughness: 0.3 });
  // Glowing orbs are brighter in the middle than at the rim, which gives them volume.
  glowMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      float orb = abs(dot(normalize(vNormal), normalize(vViewPosition)));
      totalEmissiveRadiance *= mix(0.35, 1.2, orb * orb);
      diffuseColor.rgb *= mix(0.6, 1.0, orb);`,
    );
  };
  glowMaterial.customProgramCacheKey = () => 'glow-orb';
  const lidColor = new THREE.Color(pal.body).lerp(new THREE.Color(pal.bodyDark), 0.1);
  const sclera = scleraMaterial(lidColor);
  const irisMat = new THREE.MeshStandardMaterial({ map: irisTexture(pal.eye), roughness: 0.4 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.3 });
  const corneaMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.05,
    roughness: 0.02,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    depthWrite: false,
    envMapIntensity: 2.2,
  });
  const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  // Lids are vertex-coloured (darker towards the lash line) and get their own fur shells.
  const lidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  const lowerLidMat = lidMat;
  const lowerLidColor = new THREE.Color(pal.body).lerp(new THREE.Color(pal.belly), 0.3);
  const lashMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.bodyDark).multiplyScalar(0.35), roughness: 0.7 });
  const noseMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(pal.bodyDark).lerp(new THREE.Color(0x5c2a36), 0.88), roughness: 0.32, clearcoat: 0.5 });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x3a1420, roughness: 0.6 });
  // The open mouth is a painted cavity (dark palate, tongue, little fangs, lip rim).
  const tongueMat = new THREE.MeshStandardMaterial({ map: mouthTexture(), roughness: 0.45 });
  const hornMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42 });
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xfffbf0, roughness: 0.3 });
  const blushMat = new THREE.MeshBasicMaterial({ color: pal.blush, map: radialTexture(), transparent: true, opacity: 0.55, depthWrite: false });
  const wingMat = new THREE.MeshPhysicalMaterial({
    color: pal.wing,
    map: wingTexture(new THREE.Color(pal.bodyDark)),
    transparent: true,
    opacity: 0.95,
    roughness: 0.15,
    side: THREE.DoubleSide,
    iridescence: 1,
    iridescenceIOR: 1.6,
    depthWrite: false,
  });
  const clawMat = new THREE.MeshStandardMaterial({ color: pal.belly, roughness: 0.4 });
  const materials: THREE.Material[] = [skin, glowMaterial, sclera, irisMat, pupilMat, corneaMat, shineMat, lidMat, lashMat, noseMat, mouthMat, tongueMat, toothMat, blushMat, wingMat, clawMat, hornMat];

  const cBody = new THREE.Color(pal.body), cDark = new THREE.Color(pal.bodyDark);

  // --- Sculpted body + fur shells -------------------------------------------------------
  const addSkinned = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string) => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    m.frustumCulled = false;
    scaler.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    return m;
  };
  // ?fur=N and ?lod=low override the defaults, e.g. for slow devices or software-rendered tests.
  const url = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const low = url?.get('lod') === 'low';
  // Phones and headsets get a lighter mesh and fewer shells: each shell redraws the whole body.
  const mobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|Quest|OculusBrowser/.test(navigator.userAgent);
  const bodyGeo = creatureGeometry(pal, opts.meshResolution ?? (low ? 0.0045 : mobile ? 0.0034 : 0.0028));
  const body = addSkinned(bodyGeo, skin, 'body');
  body.castShadow = true;
  const furOpts: FurOptions = { ...DEFAULT_FUR, ...opts.fur };
  const urlFur = url?.get('fur') ?? null;
  const shells = opts.furShells ?? (urlFur !== null ? Number(urlFur) : low ? 3 : mobile ? 7 : furOpts.shells);
  for (let q = 1; q <= shells; q++) {
    const mat = makeFurShellMaterial(q / shells, furOpts, skin);
    materials.push(mat);
    const shell = addSkinned(bodyGeo, mat, `fur${q}`);
    shell.castShadow = false;
    shell.renderOrder = q;
  }

  // Antennae: thin skinned stalks.
  for (const side of ['L', 'R'] as const) {
    addSkinned(
      tubeGeometry(
        [abs[`ant${side}0`].clone().add(new THREE.Vector3(0, -0.012, -0.004)), abs[`ant${side}1`], abs[`ant${side}2`], abs[`ant${side}3`]],
        [boneIndex(`ant${side}0`), boneIndex(`ant${side}1`), boneIndex(`ant${side}2`)],
        // Beaded like an insect's antenna, darkening towards the tip.
        (t) => THREE.MathUtils.lerp(0.0056, 0.0029, t) * (0.84 + 0.2 * Math.sqrt(Math.abs(Math.sin(Math.PI * t * 9)))),
        (t) => cBody.clone().lerp(cDark, 0.15 + t * 0.6).multiplyScalar(0.8 + 0.2 * Math.sqrt(Math.abs(Math.sin(Math.PI * t * 9)))),
        8,
        80,
      ),
      skin,
      `antenna${side}`,
    ).castShadow = true;
  }

  // --- Rigid parts -----------------------------------------------------------------
  const attach = (boneName: BoneName, mesh: THREE.Object3D, absPos: THREE.Vector3) => {
    bones[boneName].add(mesh);
    mesh.position.copy(absPos.clone().sub(abs[boneName]));
    return mesh;
  };

  // Little horn nubs behind the antennae.
  for (const s of [1, -1]) {
    const { p, n } = surfaceAt(0.036 * s, 0.3, -0.03);
    const horn = new THREE.Mesh(hornGeometry(cDark, new THREE.Color(pal.belly)), hornMat);
    horn.castShadow = true;
    horn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().add(new THREE.Vector3(0, 0.6, -0.5)).normalize());
    attach('head', horn, p.clone().addScaledVector(n, -0.002));
  }

  // Antenna tip bulbs.
  const haloMat = new THREE.SpriteMaterial({ map: radialTexture(), color: pal.glow, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  materials.push(haloMat);
  for (const side of ['L', 'R'] as const) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 18, 12), glowMaterial);
    bulb.name = `bulb${side}`;
    attach(`ant${side}3`, bulb, abs[`ant${side}3`].clone().add(new THREE.Vector3(side === 'L' ? 0.004 : -0.004, 0.002, 0.008)));
    // Soft halo that brightens with the glow (hints).
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(0.042);
    halo.renderOrder = 50;
    halo.onBeforeRender = () => {
      haloMat.opacity = Math.min(0.75, 0.1 + 0.32 * glowMaterial.emissiveIntensity);
    };
    bulb.add(halo);
  }

  // Wings: folded back along the shoulders at rest, outside the fur.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const wing = new THREE.Mesh(wingGeometry(s), wingMat);
    wing.name = `wingMesh${side}`;
    wing.renderOrder = 20;
    attach(`wing${side}`, wing, abs[`wing${side}`].clone().add(new THREE.Vector3(0.006 * s, 0.006, -0.018)));
  }

  // Tiny claws peeking out of the toe fur.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    for (const dx of [-0.011, 0, 0.011]) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.0022, 0.0065, 8), clawMat);
      claw.rotation.x = Math.PI / 2 + 0.5;
      attach(`ankle${side}`, claw, abs[`ankle${side}`].clone().add(new THREE.Vector3(dx * s, -0.009, 0.0505 - Math.abs(dx) * 0.35)));
    }
  }

  // --- Face --------------------------------------------------------------------------
  const lidShells = shells > 0 ? Math.max(2, Math.min(6, Math.round(shells * 0.5))) : 0;
  const lidFur = makeFurShellMaterial(-1, { ...furOpts, density: furOpts.density * 1.4 }, lidMat);
  materials.push(lidFur);
  const face = buildFace(
    bones,
    abs,
    { sclera, irisMat, pupilMat, corneaMat, shineMat, lidMat, lowerLidMat, lashMat, noseMat, mouthMat, tongueMat, toothMat, blushMat },
    { upper: lidColor, lower: lowerLidColor, fur: lidFur, shells: lidShells },
  );

  return { group, bones, rest, skeleton, scaler, face, materials, glowMaterial, palette: pal };
}

type FaceMats = Record<'sclera' | 'irisMat' | 'pupilMat' | 'corneaMat' | 'shineMat' | 'lidMat' | 'lowerLidMat' | 'lashMat' | 'noseMat' | 'mouthMat' | 'tongueMat' | 'toothMat', THREE.Material> & {
  blushMat: THREE.MeshBasicMaterial;
};

interface LidOptions {
  upper: THREE.Color;
  lower: THREE.Color;
  fur: THREE.Material;
  shells: number;
}

function buildFace(bones: Record<BoneName, THREE.Bone>, abs: Record<BoneName, THREE.Vector3>, m: FaceMats, lid: LidOptions): FaceRig {
  const headBone = bones.head;
  const toHead = (v: THREE.Vector3) => v.clone().sub(abs.head);
  const R = EYE_RADIUS;
  // Lid shell radius (eye radii): clear of the cornea and catchlights (which reach ~1.05).
  const LID_R = 1.07;
  const mkEye = (side: 'L' | 'R') => {
    const s = side === 'L' ? 1 : -1;
    const eye = new THREE.Group();
    eye.name = `eye${side}`;
    eye.position.copy(toHead(new THREE.Vector3(...EYE[side])));
    // Splayed a little outward and tipped up: big eyes that look *at* you.
    eye.rotation.set(-0.08, s * 0.3, 0);
    headBone.add(eye);
    // Everything inside the eye is spherical; the group's scale makes it a
    // tall oval, so the iris can rotate without poking through the white.
    // Shallow in depth, so in profile it doesn't bulge out of the face.
    eye.scale.set(1, 1.08, 0.82);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 24), m.sclera);
    eye.add(ball);
    const iris = new THREE.Group();
    eye.add(iris);
    // Lifted just enough off the eyeball not to z-fight at its rim (a polygon
    // offset would push it through closed lids at grazing angles).
    const irisCap = new THREE.Mesh(capGeometry(R * 1.006, 0.6, true), pupilIrisMaterial(m.irisMat as THREE.MeshStandardMaterial));
    iris.add(irisCap);
    // The pupil is painted by the iris shader; this node only carries its size
    // (the Animator scales it), read back just before the iris draws.
    const pupil = new THREE.Object3D();
    pupil.name = 'pupil';
    iris.add(pupil);
    irisCap.onBeforeRender = () => {
      (irisCap.material as THREE.MeshStandardMaterial).userData.pupil.value = 0.44 * pupil.scale.x;
    };
    // Cornea: a clear glossy dome that catches the environment.
    const cornea = new THREE.Mesh(capGeometry(R * 1.025, 0.75, false), m.corneaMat);
    cornea.renderOrder = 40;
    eye.add(cornea);
    // Painted catchlights don't rotate with the iris: that's what makes eyes read as wet.
    for (const [x, y, r] of [
      [-0.32, 0.36, 0.19],
      [0.28, -0.3, 0.08],
    ]) {
      const shine = new THREE.Mesh(new THREE.CircleGeometry(R * r, 16), m.shineMat);
      const dir = new THREE.Vector3(x * s, y, Math.sqrt(Math.max(0, 1 - x * x - y * y)));
      shine.position.copy(dir).multiplyScalar(R * 1.035);
      shine.lookAt(shine.position.clone().multiplyScalar(2));
      shine.renderOrder = 41;
      eye.add(shine);
    }
    const furryLid = (color: THREE.Color, arch: number) => {
      const geo = lidGeometry(R * LID_R, color, arch);
      const mesh = new THREE.Mesh(geo, m.lidMat);
      if (lid.shells > 0) {
        const fur = new THREE.Mesh(shellStack(geo, lid.shells), lid.fur);
        fur.renderOrder = 2;
        mesh.add(fur);
      }
      return mesh;
    };
    const UP_ARCH = 0.2;
    const up = furryLid(lid.upper, UP_ARCH);
    eye.add(up);
    // Lash line along the (curved) lid edge and three flicked lashes at the outer corner.
    const rimPts = Array.from({ length: 25 }, (_, q) => lidRimPoint(R * (LID_R + 0.005), UP_ARCH, -Math.PI * 0.47 + (q / 24) * Math.PI * 0.94));
    const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts), 40, 0.0011, 6), m.lashMat);
    up.add(rim);
    for (let q = 0; q < 3; q++) {
      const phi = s * (Math.PI / 2 - 0.18 - q * 0.22);
      const lash = new THREE.Mesh(new THREE.ConeGeometry(0.0011, 0.0075 - q * 0.0012, 5), m.lashMat);
      const base = lidRimPoint(R * LID_R, UP_ARCH, phi);
      lash.position.copy(base);
      lash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(base.x, -0.55 * R, base.z).normalize());
      up.add(lash);
    }
    const LO_ARCH = 0.38;
    const lo = furryLid(lid.lower, LO_ARCH);
    // A softer lash line defines the lower lid when it rises into a happy squint.
    const loPts = Array.from({ length: 25 }, (_, q) => lidRimPoint(R * (LID_R + 0.002), LO_ARCH, -Math.PI * 0.42 + (q / 24) * Math.PI * 0.84));
    lo.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loPts), 40, 0.0007, 5), m.lashMat));
    lo.scale.set(0.99, -1, 0.99);
    eye.add(lo);
    return { eye, iris, up, lo };
  };
  const L = mkEye('L'), Rr = mkEye('R');

  // Nose: a little soft triangle-ish button.
  {
    const { p, n } = surfaceAt(...NOSE);
    const nose = new THREE.Mesh(noseGeometry(), m.noseMat);
    nose.scale.set(0.0074, 0.005, 0.0048);
    nose.position.copy(toHead(p.clone().addScaledVector(n, 0.0018)));
    nose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    headBone.add(nose);
  }

  // Mouth: a "ω" smile with a tiny fang, and an open mouth for squeals.
  const mouth = new THREE.Group();
  {
    const { p, n } = surfaceAt(...MOUTH);
    mouth.position.copy(toHead(p.clone().addScaledVector(n, 0.0016)));
    mouth.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }
  headBone.add(mouth);
  const arcL = new THREE.TorusGeometry(0.0056, 0.0009, 6, 18, Math.PI);
  arcL.rotateZ(Math.PI);
  const arcR = arcL.clone();
  arcL.translate(0.0055, 0, 0);
  arcR.translate(-0.0055, 0, 0);
  const philtrum = new THREE.CylinderGeometry(0.0008, 0.0008, 0.005, 6);
  philtrum.translate(0, 0.0025, 0);
  const smile = new THREE.Mesh(mergeGeometries([arcL, arcR, philtrum]), m.mouthMat);
  mouth.add(smile);
  const fang = new THREE.Mesh(new THREE.ConeGeometry(0.0014, 0.0032, 8), m.toothMat);
  fang.rotation.z = Math.PI;
  fang.position.set(0.0072, -0.0068, 0.0004);
  smile.add(fang);
  // Dome facing out of the face: scale x = width, y = height, z = how far it bulges.
  const mouthGeo = new THREE.SphereGeometry(0.0105, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  mouthGeo.rotateX(Math.PI / 2);
  {
    // Planar UVs so the painted cavity stretches with the mouth's shape.
    const pos = mouthGeo.attributes.position, uv = mouthGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 0.021 + 0.5, pos.getY(i) / 0.021 + 0.5);
  }
  const mouthOpen = new THREE.Mesh(mouthGeo, m.tongueMat);
  mouthOpen.scale.set(1, 0.35, 0.01);
  mouthOpen.position.set(0, -0.004, -0.001);
  mouth.add(mouthOpen);

  // Blush sits on top of the cheek fluff so it tints the fur, not the skin under it.
  const mkBlush = (s: number) => {
    const { p, n } = surfaceAt(0.047 * s, 0.222, 0.068);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.022), m.blushMat);
    b.position.copy(toHead(p.clone().addScaledVector(n, furLengthAt(p.x, p.y, p.z) * 0.95 + 0.0005)));
    b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    b.renderOrder = 30;
    headBone.add(b);
    return b;
  };

  return {
    eyeL: L.eye,
    eyeR: Rr.eye,
    irisL: L.iris,
    irisR: Rr.iris,
    lidUpL: L.up,
    lidUpR: Rr.up,
    lidLoL: L.lo,
    lidLoR: Rr.lo,
    mouth,
    mouthOpen,
    smile,
    blushL: mkBlush(1),
    blushR: mkBlush(-1),
    blushMat: m.blushMat,
  };
}

// ---------------------------------------------------------------------------
// Geometry & texture builders

const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/**
 * Spherical cap facing +Z covering polar angle [0, frac·π/2], with planar
 * UVs (so a radial texture maps onto it as an iris).
 */
function capGeometry(r: number, frac: number, uv: boolean): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 32, 10, 0, Math.PI * 2, 0, (Math.PI / 2) * frac);
  g.rotateX(Math.PI / 2);
  if (uv) {
    const pos = g.attributes.position, uvs = g.attributes.uv;
    const rm = r * Math.sin((Math.PI / 2) * frac);
    for (let i = 0; i < pos.count; i++) uvs.setXY(i, pos.getX(i) / (2 * rm) + 0.5, pos.getY(i) / (2 * rm) + 0.5);
  }
  return g;
}

/** Soft rounded inverted triangle (unit size), facing +Z. */
function noseGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 24, 16);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Narrower towards the bottom, a slightly flat top, and a little bulge forward.
    pos.setXYZ(i, x * (0.72 + 0.38 * smooth((y + 1) / 2)), y > 0 ? y * 0.8 : y, z * (1 + 0.25 * Math.max(0, -y)));
  }
  g.computeVertexNormals();
  return g;
}

/** Per-eye iris material that paints a round pupil of adjustable size. */
function pupilIrisMaterial(base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const mat = base.clone();
  const uPupil = { value: 0.37 };
  mat.userData.pupil = uPupil;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPupil = uPupil;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uPupil;').replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      float pr = length(vMapUv * 2.0 - 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.01, 0.012, 0.018), 1.0 - smoothstep(uPupil - 0.025, uPupil + 0.01, pr));`,
    );
  };
  mat.customProgramCacheKey = () => 'iris-pupil';
  return mat;
}

let rng = 1;
const rand = () => ((rng = (rng * 16807) % 2147483647) - 1) / 2147483646;

function dataTexture(size: number, fn: (u: number, v: number) => [number, number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const c = fn((i + 0.5) / size, (j + 0.5) / size);
      data.set(c.map((x) => Math.max(0, Math.min(255, Math.round(x * 255)))), (j * size + i) * 4);
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Radial iris: dark limbal ring, fibrous streaks, a warm ring around the pupil. */
function irisTexture(hex: number): THREE.DataTexture {
  rng = 7;
  // Vivid, light irises read as friendly; the dark eye colour only tints them.
  const hsl = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 });
  const base = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.4), 0.3);
  const light = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.3), 0.62);
  const warm = base.clone().lerp(new THREE.Color(0xffc060), 0.6);
  const streaks = Array.from({ length: 64 }, () => rand());
  const c = new THREE.Color();
  return dataTexture(128, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const r = Math.hypot(x, y);
    const a = (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1;
    const k = a * 64, k0 = Math.floor(k) % 64, k1 = (k0 + 1) % 64;
    const st = streaks[k0] + (streaks[k1] - streaks[k0]) * smooth(k - Math.floor(k));
    // Gradient: lighter towards the bottom (light enters the eye from above and pools low).
    c.copy(base).lerp(light, 0.1 + 0.55 * smooth((0.35 - y) / 1.3) + 0.3 * st * smooth((r - 0.3) / 0.5));
    // The upper lid shades the top of the iris.
    c.multiplyScalar(0.6 + 0.4 * smooth((0.75 - y) / 0.7));
    if (r < 0.48) c.lerp(warm, 0.55 * smooth((0.48 - r) / 0.2));
    // Limbal ring.
    c.multiplyScalar(1 - 0.62 * smooth((r - 0.8) / 0.16));
    return [c.r, c.g, c.b, 1];
  });
}

/**
 * Eyelid shell: the top half of a sphere, vertex-coloured darker towards the
 * lash line, with a `furLen` attribute so fur shells can grow on it.
 */
function lidGeometry(r: number, color: THREE.Color, arch: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = g.attributes.position;
  // Curve the lash line: the lid reaches further around the eye at the front
  // (+Z) than at the corners, so a closed lid reads as a soft "‿" and a raised
  // lower lid as a smiling "◠" instead of a straight cut.
  const v = new THREE.Vector3();
  const rimT = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).divideScalar(r);
    const theta = Math.acos(THREE.MathUtils.clamp(v.y, -1, 1));
    const phi = Math.atan2(v.x, v.z);
    const front = Math.pow(Math.max(0, Math.cos(phi)), 2);
    rimT[i] = theta / (Math.PI / 2);
    const t2 = theta * (1 + (arch * front) / (Math.PI / 2));
    v.set(Math.sin(t2) * Math.sin(phi), Math.cos(t2), Math.sin(t2) * Math.cos(phi));
    g.attributes.normal.setXYZ(i, v.x, v.y, v.z);
    v.multiplyScalar(r);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const col = new Float32Array(pos.count * 3), fl = new Float32Array(pos.count);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = smooth((1 - rimT[i]) / 0.35); // 1 on top of the lid, 0 at the lash line
    c.copy(color).multiplyScalar(0.72 + 0.28 * k);
    col.set([c.r, c.g, c.b], i * 3);
    fl[i] = 0.0036 * (0.3 + 0.7 * k);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('furLen', new THREE.BufferAttribute(fl, 1));
  return g;
}

/** A point on a lid's (arched) lash line at azimuth phi (0 = front, +X = π/2). */
function lidRimPoint(r: number, arch: number, phi: number): THREE.Vector3 {
  const t2 = (Math.PI / 2) * (1 + (arch * Math.pow(Math.max(0, Math.cos(phi)), 2)) / (Math.PI / 2));
  return new THREE.Vector3(Math.sin(t2) * Math.sin(phi), Math.cos(t2), Math.sin(t2) * Math.cos(phi)).multiplyScalar(r);
}

/** `n` copies of a geometry tagged with shell heights 1/n..1, for single-draw fur shells. */
function shellStack(geo: THREE.BufferGeometry, n: number): THREE.BufferGeometry {
  const copies = [];
  for (let q = 1; q <= n; q++) {
    const g = geo.clone();
    g.setAttribute('shellH', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(q / n), 1));
    copies.push(g);
  }
  return mergeGeometries(copies);
}

/**
 * Eyeball material. The visible opening is almond-shaped: towards the corners
 * the sclera turns into eyelid skin with a soft dark liner, and the white is
 * shaded greyer near the lids, so the eye sits *in* the face instead of
 * bulging out of it like a ball.
 */
function scleraMaterial(skin: THREE.Color): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xf7f4ee, roughness: 0.35, clearcoat: 0.6 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSkin = { value: skin.clone() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeP = position;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSkin;\nvarying vec3 vEyeP;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec3 en = normalize(vEyeP);
      float ap = length(vec2(en.x / 0.88, en.y / 1.3));
      float inside = (1.0 - smoothstep(0.92, 0.99, ap)) * smoothstep(-0.1, 0.15, en.z);
      diffuseColor.rgb *= mix(vec3(0.6, 0.62, 0.72), vec3(1.0), smoothstep(1.0, 0.5, ap));
      vec3 skinC = uSkin * mix(0.38, 0.85, smoothstep(0.98, 1.2, ap));
      diffuseColor.rgb = mix(skinC, diffuseColor.rgb, inside);`,
    );
  };
  mat.customProgramCacheKey = () => 'sclera-aperture';
  return mat;
}

/** Painted open-mouth cavity: dark palate, tongue with a groove, two tiny fangs, lip rim. */
function mouthTexture(): THREE.DataTexture {
  const c = new THREE.Color(), deep = new THREE.Color(0.16, 0.03, 0.06), warm = new THREE.Color(0.5, 0.13, 0.19);
  const tongue = new THREE.Color(1.0, 0.52, 0.58), lip = new THREE.Color(0.34, 0.11, 0.16), tooth = new THREE.Color(0.98, 0.96, 0.92);
  return dataTexture(128, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const r = Math.hypot(x, y);
    c.copy(deep).lerp(warm, 0.85 * smooth((0.2 - y) / 1.2));
    // Tongue: a soft mound at the bottom, lit on top, with a centre groove.
    const tx = x / 0.72, ty = (y + 0.66) / 0.52;
    const tr = Math.hypot(tx, ty);
    if (tr < 1.05) {
      const t = tongue.clone().multiplyScalar(0.72 + 0.32 * smooth((ty + 0.2) / 1.1));
      t.multiplyScalar(1 - 0.22 * (1 - smooth(Math.abs(x) / 0.07)) * smooth((ty + 0.6) / 0.6));
      c.lerp(t, smooth((1.05 - tr) / 0.14));
    }
    // Two little fangs hanging from the upper lip.
    for (const sx of [-0.4, 0.4]) {
      const h = (0.86 - y) / 0.34; // 0 at the gum, 1 at the tip
      if (h > 0 && h < 1) {
        const w = 0.12 * (1 - h);
        c.lerp(tooth.clone().multiplyScalar(0.82 + 0.18 * (1 - h)), smooth((w - Math.abs(x - sx)) / 0.03));
      }
    }
    // Lip rim.
    c.lerp(lip, smooth((r - 0.8) / 0.16));
    return [c.r, c.g, c.b, 1];
  });
}

/** Little curved, ridged horn (local +Y up, curving back towards -Z), dark at the root, cream at the tip. */
function hornGeometry(root: THREE.Color, tip: THREE.Color): THREE.BufferGeometry {
  const pts = [new THREE.Vector3(0, -0.004, 0.001), new THREE.Vector3(0, 0.007, 0), new THREE.Vector3(0, 0.015, -0.004), new THREE.Vector3(0, 0.02, -0.011)];
  return tubeGeometry(
    pts,
    [0, 0, 0],
    (t) => THREE.MathUtils.lerp(0.0064, 0.0016, Math.pow(t, 0.8)) * (1 - 0.09 * Math.pow(Math.abs(Math.cos(Math.PI * t * 5)), 6)),
    (t) => root.clone().multiplyScalar(0.8).lerp(tip, smooth((t - 0.15) / 0.7)).multiplyScalar(1 - 0.12 * Math.pow(Math.abs(Math.cos(Math.PI * t * 5)), 6)),
    12,
    40,
  );
}

/** Soft round falloff (white, alpha = falloff) for blush decals. */
function radialTexture(): THREE.DataTexture {
  return dataTexture(64, (u, v) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    return [1, 1, 1, Math.pow(Math.max(0, 1 - r), 1.6)];
  });
}

/** Wing membrane: translucent, with veins radiating from the root, a crossing vein and a darker rim (alpha in A). */
function wingTexture(vein: THREE.Color): THREE.DataTexture {
  const c = new THREE.Color();
  const veinC = vein.clone().lerp(new THREE.Color(1, 1, 1), 0.25);
  return dataTexture(128, (u, v) => {
    const a = Math.atan2(v - 0.5, u + 0.02);
    const d = Math.hypot(u, v - 0.5);
    // Radial veins fade out towards the tip; one curved cross vein.
    const radial = Math.pow(Math.max(0, 1 - Math.abs(Math.sin(a * 7)) / 0.12), 1.5) * smooth((0.95 - d) / 0.4);
    const cross = Math.max(0, 1 - Math.abs(d - 0.45 - 0.05 * Math.sin(a * 5)) / 0.018);
    const k = Math.min(1, radial + cross);
    // Membrane is lighter (and more see-through) away from the root.
    c.setRGB(0.85, 0.85, 0.85).multiplyScalar(0.9 + 0.1 * smooth(d / 0.8));
    c.lerp(veinC, k * 0.85);
    return [c.r, c.g, c.b, 0.42 + 0.5 * k + 0.25 * (1 - smooth(d / 0.35))];
  });
}

/**
 * A tapered tube through `pts`, with rounded closed ends. Segment s (from
 * pts[s] to pts[s+1]) is driven by bones[s]; rings blend between adjacent
 * bones near the joints.
 */
function tubeGeometry(
  pts: THREE.Vector3[],
  bones: number[],
  radius: (t: number) => number,
  color: (t: number, angle: number) => THREE.Color,
  radial = 10,
  ringCount = 0,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const rings = ringCount || Math.max(12, pts.length * 8);
  // Segment parameter boundaries along the curve, by joint arc length.
  const lens = [0];
  for (let s = 1; s < pts.length; s++) lens.push(lens[s - 1] + pts[s].distanceTo(pts[s - 1]));
  const total = lens[lens.length - 1];

  const positions: number[] = [], normals: number[] = [], colors: number[] = [], si: number[] = [], sw: number[] = [];
  const indices: number[] = [];
  // Parallel-transport frames.
  let prevT = curve.getTangentAt(0);
  let nrm = new THREE.Vector3(0, 0, 1).cross(prevT);
  if (nrm.lengthSq() < 1e-6) nrm = new THREE.Vector3(1, 0, 0).cross(prevT);
  nrm.normalize();
  const capLen = 0.08;
  for (let r = 0; r <= rings; r++) {
    const u = r / rings;
    const P = curve.getPointAt(u);
    const T = curve.getTangentAt(u);
    const axis = new THREE.Vector3().crossVectors(prevT, T);
    if (axis.lengthSq() > 1e-10) {
      const ang = Math.acos(THREE.MathUtils.clamp(prevT.dot(T), -1, 1));
      nrm.applyAxisAngle(axis.normalize(), ang);
    }
    prevT = T;
    const bin = new THREE.Vector3().crossVectors(T, nrm).normalize();
    // Rounded caps: radius → 0 at both ends along a quarter circle.
    const cap = u < capLen ? Math.sqrt(1 - Math.pow(1 - u / capLen, 2)) : u > 1 - capLen ? Math.sqrt(1 - Math.pow(1 - (1 - u) / capLen, 2)) : 1;
    const rad = radius(u) * Math.max(cap, 0.001);
    // Bone weights from arc length.
    const d = u * total;
    let s = 0;
    while (s < lens.length - 2 && d > lens[s + 1]) s++;
    const segT = (d - lens[s]) / Math.max(1e-6, lens[s + 1] - lens[s]);
    let a = bones[Math.min(s, bones.length - 1)], b = a, w = 0;
    if (segT > 0.65 && s + 1 < bones.length) {
      b = bones[s + 1];
      w = smooth((segT - 0.65) / 0.7);
    } else if (segT < 0.35 && s > 0) {
      b = bones[s - 1];
      w = smooth((0.35 - segT) / 0.7);
    }
    for (let q = 0; q <= radial; q++) {
      const ang = (q / radial) * Math.PI * 2;
      const dir = nrm.clone().multiplyScalar(Math.cos(ang)).add(bin.clone().multiplyScalar(Math.sin(ang)));
      positions.push(P.x + dir.x * rad, P.y + dir.y * rad, P.z + dir.z * rad);
      normals.push(dir.x, dir.y, dir.z);
      // Angle relative to world up for colouring (top vs underside).
      const c = color(u, Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1)));
      colors.push(c.r, c.g, c.b);
      si.push(a, b, 0, 0);
      sw.push(1 - w, w, 0, 0);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let q = 0; q < radial; q++) {
      const a = r * (radial + 1) + q, b = a + radial + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Two-lobed wing (a big fore-lobe and a smaller hind-lobe), root at the
 * origin. At rest it lies folded back along the shoulders: spanning out, up
 * and back, with the membrane roughly parallel to the back. s = +1 left, -1 right.
 */
function wingGeometry(s: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.03, 0.028, 0.08, 0.034, 0.096, 0.01);
  shape.bezierCurveTo(0.102, -0.004, 0.075, -0.012, 0.05, -0.008);
  shape.bezierCurveTo(0.068, -0.022, 0.062, -0.044, 0.036, -0.035);
  shape.bezierCurveTo(0.02, -0.027, 0.008, -0.013, 0, 0);
  const geo = new THREE.ShapeGeometry(shape, 16);
  // Shape UVs are in metres; stretch them over the vein texture.
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 0.1, uv.getY(i) / 0.08 + 0.5);
  // A gentle camber so the membrane catches light like a real wing.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, 0.06 * x * x + 0.04 * y * y);
  }
  const X = new THREE.Vector3(0.62 * s, 0.5, -0.6).normalize();
  const N = new THREE.Vector3(0.35 * s, 0.15, -1);
  N.addScaledVector(X, -N.dot(X)).normalize();
  const Y = new THREE.Vector3().crossVectors(N, X);
  if (s < 0) Y.negate();
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(X, Y, N));
  geo.computeVertexNormals();
  return geo;
}

export function boneNames(): BoneName[] {
  return BONES.map(([n]) => n);
}

import * as THREE from 'three';

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
import { creatureGeometry, furLengthAt, skinDistance, surfaceAt } from './sdf/meshCreature';
import { EYE, EYE_RADIUS, MOUTH, NOSE, TOE_DX } from './sdf/creature';
import { addSocketFade, addTranslucency, DEFAULT_FUR, makeFurShellMaterial, type FurOptions } from './furMaterial';
import {
  buildEye, catchlightTexture, fangGeometry, hornGeometry, irisTexture, lipLineTexture, MOUTH_H, MOUTH_W, MOUTH_Y0, mouthTexture, noseGeometry,
  pebbleTexture, radialTexture, scleraMaterial, tubeGeometry, whiskerGeometry, wingGeometry, wingTexture, type EyeMats, type LidOptions,
} from './parts';
import { currentCoat, currentSpecies, type Species } from './species';
import { buildVizsla, VIZSLA_PALETTES } from './vizsla/VizslaModel';
import { DOG_BONES } from './vizsla/skeleton';
export { HEAD_CENTER, HEAD_RADIUS, type BoneName } from './skeleton';
export { VIZSLA_PALETTES };
export type { Species };

export interface PetPalette {
  body: number;
  bodyDark: number;
  belly: number;
  blush: number;
  glow: number;
  eye: number;
  wing: number;
  /** Strength of the dark back dapples (1 = full). */
  markings?: number;
}

export const PALETTES: Record<string, PetPalette> = {
  // Coats are kept a little earthy (sage, heather, fox) so they read as fur, not plastic.
  mint: { body: 0x74b897, bodyDark: 0x3a7a62, belly: 0xf4e8cc, blush: 0xf2909f, glow: 0xffd56a, eye: 0x3c6b3a, wing: 0xb9bce8, markings: 0.9 },
  plum: { body: 0x9a86c4, bodyDark: 0x5a4688, belly: 0xf5e8ee, blush: 0xf28fb2, glow: 0x9ffcff, eye: 0x5a3a78, wing: 0xf0cbe6, markings: 0.55 },
  ember: { body: 0xe0975e, bodyDark: 0xa45a34, belly: 0xfaefdc, blush: 0xf07280, glow: 0xfff07a, eye: 0x6b5418, wing: 0xf4bed4, markings: 0.6 },
};

/** The palette behind a coat (species.ts lists each pet's), or the pet's default when the name is not one of its coats. */
export function coatPalette(species: Species, coat: string): PetPalette {
  return species === 'vizsla' ? (VIZSLA_PALETTES[coat] ?? VIZSLA_PALETTES.golden) : (PALETTES[coat] ?? PALETTES.mint);
}

export interface PetRig {
  /** Which pet this is (the Animator picks its motion set from it). */
  species: Species;
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
  /** The middle of the head in the head bone's frame (visibility sampling); Hopper's is 5.5 cm above the joint. */
  headSample?: THREE.Vector3;
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
  /** Hopper's painted mouth and blush (the Vizsla has a jaw bone and a tongue instead). */
  mouth?: THREE.Group;
  mouthOpen?: THREE.Mesh;
  smile?: THREE.Mesh;
  blushL?: THREE.Mesh;
  blushR?: THREE.Mesh;
  blushMat?: THREE.MeshBasicMaterial;
  /** The Vizsla's tongue (morph 0 lolls it out, morph 1 arches it). */
  tongue?: THREE.Mesh;
  /** Eyeball depth scale at rest, and how far the irises toe in to look straight ahead (defaults: Hopper's). */
  eyeDepth?: number;
  irisToe?: number;
  /**
   * Lid angles with the eyes open (defaults: Hopper's, tucked right back so
   * the whole round eye shows). A dog's lids rest part-way over the eye,
   * which gives it an almond shape.
   */
  lidUpOpen?: number;
  lidLoOpen?: number;
  /** Pupil size relative to Hopper's. */
  pupilScale?: number;
  /** 0 = eyes open .. 1 = closed; fades the socket liner so closed lids blend into the face (set by the Animator). */
  eyeClosed?: { value: number };
  /** 0..1: how far the face fur fills in over a shut (not squinting) eye (set by the Animator). */
  eyeFill?: { value: number };
  /** 0..1: how far the cheek fur fills in below a "^^" squint (set by the Animator). */
  eyeSquint?: { value: number };
  /** Lid skin and lid fur (the Animator lifts their tone in a "^^" squint). */
  lidMats?: THREE.MeshStandardMaterial[];
}

export interface PetOptions {
  /** Body mesh resolution (m); coarser is cheaper. */
  meshResolution?: number;
  /** Fur shells (0 = no fur; phones may want fewer). */
  furShells?: number;
  fur?: Partial<FurOptions>;
  /** Which pet to build (default: the one chosen on the start page, see species.ts). */
  species?: Species;
}

/**
 * Build a pet. With no palette it wears the coat chosen for it in the model
 * selector (species.ts): mint for Hopper and golden rust for the Vizsla
 * unless something else was picked.
 */
export function buildPet(paletteName?: keyof typeof PALETTES | PetPalette, opts: PetOptions = {}): PetRig {
  const species = opts.species ?? currentSpecies();
  paletteName ??= currentCoat(species);
  // The Vizsla has its own palettes: a Hopper palette name falls back to golden rust.
  if (species === 'vizsla') return buildVizsla(typeof paletteName === 'string' ? paletteName : 'golden', opts);
  const pal = typeof paletteName === 'string' ? (PALETTES[paletteName] ?? PALETTES.mint) : paletteName;
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
  // Ears are thin: backlight glows through them (fur shells add the same term).
  const eyeClosed = { value: 0 }, eyeFill = { value: 0 }, eyeSquint = { value: 0 };
  // Skin showing between the strands where the coat is long. With many shells
  // the dark lower layers hide it; with few (phones, lod=low) it shows through
  // and would make the coat read paler, so it is dimmed to match (set below).
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
  // The emissive is a deeper, more saturated version of the glow colour, so the
  // bulbs stay coloured instead of tone-mapping to pale cream when they light up.
  const glowHsl = new THREE.Color(pal.glow).getHSL({ h: 0, s: 0, l: 0 });
  const glowDeep = new THREE.Color().setHSL(glowHsl.h, Math.min(1, glowHsl.s * 1.1 + 0.1), glowHsl.l * 0.78);
  const glowMaterial = new THREE.MeshStandardMaterial({ color: pal.glow, emissive: glowDeep, emissiveIntensity: 0.9, roughness: 0.3 });
  // Glowing orbs are brighter in the middle than at the rim, which gives them volume.
  glowMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      float orb = abs(dot(normalize(vNormal), normalize(vViewPosition)));
      // A hot, paler core inside a saturated shell.
      totalEmissiveRadiance *= mix(0.45, 1.15, orb * orb);
      totalEmissiveRadiance += emissive * 0.35 * pow(orb, 6.0);
      diffuseColor.rgb *= mix(0.55, 1.0, orb);`,
    );
  };
  glowMaterial.customProgramCacheKey = () => 'glow-orb';
  const lidColor = new THREE.Color(pal.body).lerp(new THREE.Color(pal.bodyDark), 0.2);
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
  const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: catchlightTexture(), transparent: true, depthWrite: false });
  // Lids are vertex-coloured (darker towards the lash line) and get their own fur shells.
  const lidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
  const lowerLidMat = lidMat;
  const lowerLidColor = new THREE.Color(pal.body).lerp(new THREE.Color(pal.belly), 0.04);
  const lashMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.bodyDark).multiplyScalar(0.35), roughness: 0.7 });
  // Moist, pebbled nose leather: a glossy wet film (clearcoat) over a matte, bumpy skin.
  const pebble = pebbleTexture();
  const noseMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(pal.bodyDark).lerp(new THREE.Color(0x52222f), 0.9),
    vertexColors: true,
    roughness: 0.55,
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    bumpMap: pebble,
    bumpScale: 0.6,
    envMapIntensity: 0.6,
  });
  pebble.repeat.set(3, 3);
  const whiskerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, transparent: true, opacity: 0.85 });
  // Wet tear-film line; fades out while the eyes are shut (set per frame from eyeClosed).
  const tearMat = new THREE.MeshPhysicalMaterial({ color: 0xe9a7a3, vertexColors: true, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, depthWrite: false });
  const mouthMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x3a1720).lerp(new THREE.Color(pal.bodyDark), 0.1), opacity: 0.9, map: lipLineTexture(), transparent: true, depthWrite: false, roughness: 0.7 });
  // The open mouth is a painted cavity (dark palate, tongue, little fangs, lip rim).
  // Soft-edged, so the open mouth's rim melts into the muzzle fur.
  const tongueMat = new THREE.MeshStandardMaterial({ map: mouthTexture(), roughness: 0.38, transparent: true });
  const hornMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42 });
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xfffbf0, roughness: 0.3 });
  const blushMat = new THREE.MeshBasicMaterial({ color: pal.blush, map: radialTexture(), transparent: true, opacity: 0.55, depthWrite: false });
  const wingMat = new THREE.MeshPhysicalMaterial({
    color: pal.wing,
    map: wingTexture(new THREE.Color(pal.bodyDark)),
    transparent: true,
    opacity: 1,
    roughness: 0.2,
    side: THREE.DoubleSide,
    iridescence: 1,
    iridescenceIOR: 1.5,
    iridescenceThicknessRange: [250, 500],
    sheen: 0.6,
    sheenColor: new THREE.Color(pal.wing),
    depthWrite: false,
  });
  // Seen edge-on a membrane would vanish into a flickering hairline; keep a
  // little more opacity at grazing angles, like light skimming a real wing.
  wingMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
      float wingGraze = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
      diffuseColor.a = min(1.0, diffuseColor.a + 0.35 * pow(wingGraze, 3.0));`,
    );
  };
  wingMat.customProgramCacheKey = () => 'wing-graze';
  const wingGhostMat = wingMat.clone();
  wingGhostMat.onBeforeCompile = wingMat.onBeforeCompile;
  wingGhostMat.customProgramCacheKey = wingMat.customProgramCacheKey;
  wingGhostMat.opacity = 0;
  const clawMat = new THREE.MeshStandardMaterial({ color: pal.belly, roughness: 0.4 });
  const materials: THREE.Material[] = [skin, glowMaterial, sclera, irisMat, pupilMat, corneaMat, shineMat, lidMat, lashMat, noseMat, mouthMat, tongueMat, toothMat, blushMat, wingMat, wingGhostMat, clawMat, hornMat, whiskerMat, tearMat];

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
  // With few shells long fur shows as stacked layers; keep it a little shorter there.
  furOpts.lengthScale ??= THREE.MathUtils.clamp(0.45 + shells * 0.05, 0.6, 1);
  // ...and fewer dark root layers would make the coat read paler (measured ~6% at 3 shells).
  const few = Math.pow(THREE.MathUtils.clamp((12 - shells) / 9, 0, 1), 1.3);
  furOpts.tone ??= 1 - 0.05 * few;
  underCoat.value = 1 - 0.24 * few;
  for (let q = 1; q <= shells; q++) {
    const mat = makeFurShellMaterial(q / shells, furOpts, skin, { closed: eyeClosed, fill: eyeFill, squint: eyeSquint });
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
    // Motion blur for fast flapping: faint copies fanned along the flap arc
    // (the Animator spreads them and fades them in), so a ~9 Hz flap reads as
    // a soft blur instead of a strobing membrane.
    const blur = new THREE.Group();
    blur.name = `wingBlur${side}`;
    blur.visible = false;
    blur.userData.mat = wingGhostMat;
    bones[`wing${side}`].add(blur);
    for (let q = 0; q < 9; q++) {
      // Denser towards the ends of the stroke, where a flapping wing lingers.
      const f = -Math.cos((q / 8) * Math.PI);
      const pivot = new THREE.Group();
      pivot.userData.f = f;
      const ghost = new THREE.Mesh(wing.geometry, wingGhostMat);
      ghost.position.copy(wing.position);
      ghost.renderOrder = 19;
      pivot.add(ghost);
      blur.add(pivot);
    }
  }

  // Tiny claws peeking out of the toe fur.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    for (const dx of TOE_DX) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.0021, 0.0062, 8), clawMat);
      claw.rotation.set(Math.PI / 2 + 0.55, 0, 0);
      claw.rotation.y = dx * s * 9;
      attach(`ankle${side}`, claw, abs[`ankle${side}`].clone().add(new THREE.Vector3(dx * s * 1.08, -0.0105, 0.0545 - Math.abs(dx) * 0.3)));
    }
  }

  // --- Face --------------------------------------------------------------------------
  // Lids get the same coat as the head (same strands, as many layers), so a shut
  // eye is a fold in the fur rather than a patch.
  const lidShells = shells > 0 ? Math.min(8, shells) : 0;
  const lidFur = makeFurShellMaterial(-1, furOpts, lidMat);
  // Lid colours: the average baked coat colour just above / below each socket.
  const sockCol = (upper: boolean) => {
    const P = bodyGeo.attributes.position, C = bodyGeo.attributes.color;
    const acc = new THREE.Color(0, 0, 0);
    let w = 0;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const e = EYE[x > 0 ? 'L' : 'R'];
      const d = Math.hypot(x - e[0], y - e[1], z - e[2]) / EYE_RADIUS;
      if (d < 1.25 || d > 1.75 || (y > e[1]) !== upper || z < e[2] - 0.004) continue;
      acc.r += C.getX(i);
      acc.g += C.getY(i);
      acc.b += C.getZ(i);
      w++;
    }
    return w ? acc.multiplyScalar(1 / w) : null;
  };
  const upCol = sockCol(true), loCol = sockCol(false);
  // Nearest baked body colour around the eyes, without the socket liner (as it looks with the eyes shut).
  const near: number[] = [];
  {
    const P = bodyGeo.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), e = EYE[x > 0 ? 'L' : 'R'];
      if (Math.hypot(x - e[0], P.getY(i) - e[1], P.getZ(i) - e[2]) < EYE_RADIUS * 2.4) near.push(i);
    }
  }
  const skinColor = (p: THREE.Vector3) => {
    const P = bodyGeo.attributes.position, C = bodyGeo.attributes.color, K = bodyGeo.attributes.socket;
    let best = -1, bd = Infinity;
    for (const i of near) {
      const d = (P.getX(i) - p.x) ** 2 + (P.getY(i) - p.y) ** 2 + (P.getZ(i) - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const k = best < 0 ? 1 : K.getY(best) || 1;
    // (x1.2: the socket's baked occlusion is deeper than a shut lid's.)
    return best < 0 ? lidColor.clone() : new THREE.Color(C.getX(best), C.getY(best), C.getZ(best)).multiplyScalar(Math.min(1.6, k) * 1.2);
  };
  if (upCol) lidColor.copy(upCol).multiplyScalar(1.12);
  if (loCol) lowerLidColor.copy(loCol).multiplyScalar(1.08);
  materials.push(lidFur);
  const face = buildFace(
    bones,
    abs,
    { sclera, irisMat, pupilMat, corneaMat, shineMat, lidMat, lowerLidMat, lashMat, noseMat, mouthMat, tongueMat, toothMat, blushMat, whiskerMat, tearMat },
    { upper: lidColor, lower: lowerLidColor, fur: lidFur, shells: lidShells, skinColor },
  );

  face.eyeClosed = eyeClosed;
  group.traverse((o) => {
    if ((o as THREE.Mesh).material === tearMat) o.onBeforeRender = () => (tearMat.opacity = 0.9 * (1 - Math.min(1, eyeClosed.value * 1.6)));
  });
  face.eyeFill = eyeFill;
  face.eyeSquint = eyeSquint;
  face.lidMats = [lidMat, lidFur];
  materials.push(face.blushL!.material as THREE.Material, face.blushR!.material as THREE.Material);
  return { species: 'hopper', group, bones, rest, skeleton, scaler, face, materials, glowMaterial, palette: pal };
}

type FaceMats = EyeMats & Record<'noseMat' | 'mouthMat' | 'tongueMat' | 'toothMat' | 'whiskerMat', THREE.Material> & {
  blushMat: THREE.MeshBasicMaterial;
};

function buildFace(bones: Record<BoneName, THREE.Bone>, abs: Record<BoneName, THREE.Vector3>, m: FaceMats, lid: LidOptions): FaceRig {
  const headBone = bones.head;
  const toHead = (v: THREE.Vector3) => v.clone().sub(abs.head);
  const mkEye = (side: 'L' | 'R') =>
    buildEye(side, { head: headBone, headAbs: abs.head, center: EYE[side], radius: EYE_RADIUS, pitch: -0.08, splay: 0.3, scale: [1, 1.08, 0.82], skinDistance, mats: m, lid });
  const L = mkEye('L'), Rr = mkEye('R');

  // Nose: a little soft triangle-ish button.
  {
    const { p, n } = surfaceAt(...NOSE);
    const nose = new THREE.Mesh(noseGeometry(), m.noseMat);
    nose.scale.set(0.0078, 0.0054, 0.005);
    nose.position.copy(toHead(p.clone().addScaledVector(n, 0.0018)));
    nose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    headBone.add(nose);
  }

  // Whiskers from the whisker pads.
  for (const s of [1, -1]) {
    const roots = [0.2165, 0.2125, 0.2085].map((y, q) => {
      const { p } = surfaceAt((0.017 + q * 0.002) * s, y, 0.095);
      return toHead(p);
    });
    const wh = new THREE.Mesh(whiskerGeometry(roots, s, new THREE.Color(0xfffaf0)), m.whiskerMat);
    wh.name = `whiskers${s > 0 ? 'L' : 'R'}`;
    headBone.add(wh);
  }

  // Mouth: a "ω" smile with a tiny fang, and an open mouth for squeals.
  const mouth = new THREE.Group();
  // Mouth frame in pet space (for fitting the lip line onto the muzzle).
  const mouthFrame = new THREE.Matrix4();
  {
    const { p, n } = surfaceAt(...MOUTH);
    mouth.position.copy(toHead(p.clone().addScaledVector(n, 0.0016)));
    mouth.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    mouthFrame.compose(p.clone().addScaledVector(n, 0.0016), mouth.quaternion, new THREE.Vector3(1, 1, 1));
  }
  headBone.add(mouth);
  // The "ω" lip line is painted (a soft, tapering crease with a faint shadow
  // around it) on a little patch fitted to the curve of the muzzle, so it reads
  // as a fold in the fur rather than a tube lying on top of it.
  const smileGeo = new THREE.PlaneGeometry(MOUTH_W, MOUTH_H, 24, 12);
  {
    smileGeo.translate(0, MOUTH_Y0 + MOUTH_H / 2, 0);
    const pos = smileGeo.attributes.position;
    const inv = mouthFrame.clone().invert();
    const q = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      q.set(pos.getX(i), pos.getY(i), 0).applyMatrix4(mouthFrame);
      const { p, n } = surfaceAt(q.x, q.y, q.z);
      q.copy(p).addScaledVector(n, 0.0011).applyMatrix4(inv);
      pos.setZ(i, q.z);
    }
    smileGeo.computeVertexNormals();
  }
  const smile = new THREE.Mesh(smileGeo, m.mouthMat);
  smile.renderOrder = 31;
  mouth.add(smile);
  const fang = new THREE.Mesh(fangGeometry(), m.toothMat);
  fang.position.set(0.0072, -0.0054, 0.0004);
  smile.add(fang);
  // Dome facing out of the face: scale x = width, y = height, z = how far it bulges.
  const mouthGeo = new THREE.SphereGeometry(0.0105, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  mouthGeo.rotateX(Math.PI / 2);
  {
    // Planar UVs so the painted cavity stretches with the mouth's shape.
    const pos = mouthGeo.attributes.position, uv = mouthGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 0.021 + 0.5, pos.getY(i) / 0.021 + 0.5);
    // Morph target: a grin. The top lip flattens and its corners curl up, so
    // the open mouth becomes a "D" smile.
    const grin = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const xn = x / 0.0105;
      grin.set([x * 1.08, y > 0 ? y * 0.22 + 0.0042 * xn * xn : y * 1.05 + 0.0016 * xn * xn, z], i * 3);
    }
    mouthGeo.morphAttributes.position = [new THREE.Float32BufferAttribute(grin, 3)];
  }
  const mouthOpen = new THREE.Mesh(mouthGeo, m.tongueMat);
  mouthOpen.updateMorphTargets();
  mouthOpen.scale.set(1, 0.35, 0.01);
  mouthOpen.position.set(0, -0.004, -0.001);
  mouth.add(mouthOpen);

  // Blush sits on top of the cheek fluff so it tints the fur, not the skin under it.
  const mkBlush = (s: number) => {
    // Low and outboard on the cheek, clear of the lower lids (a shut eye sinks
    // behind the cheek fur, where a higher blush would tint the lid).
    const { p, n } = surfaceAt(0.05 * s, 0.214, 0.064);
    // Each cheek has its own copy of the (Animator-driven) blush material, so
    // it can fade as the cheek turns away: seen edge-on, a flat patch on the
    // far cheek would poke out past the face's outline.
    const mat = m.blushMat.clone();
    const b = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.019), mat);
    b.position.copy(toHead(p.clone().addScaledVector(n, furLengthAt(p.x, p.y, p.z) * 0.95 + 0.0005)));
    b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    b.renderOrder = 30;
    const wp = new THREE.Vector3(), wn = new THREE.Vector3(), cp = new THREE.Vector3();
    b.onBeforeRender = (_r, _s, camera) => {
      b.getWorldPosition(wp);
      wn.set(0, 0, 1).transformDirection(b.matrixWorld);
      cp.setFromMatrixPosition(camera.matrixWorld).sub(wp).normalize();
      const facing = THREE.MathUtils.smoothstep(wn.dot(cp), 0.1, 0.45);
      mat.opacity = m.blushMat.opacity * facing;
      mat.color.copy(m.blushMat.color);
    };
    b.name = s > 0 ? 'blushL' : 'blushR';
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


/**
 * Turn a rig into another pet, or the same pet in another coat, in place. The
 * root group stays, so the pet keeps its place in the scene and everyone who
 * holds the rig (game, controller, stage) still holds the right one;
 * everything under the group is built afresh and what the old body held on
 * the GPU is freed. An Animator bound to the rig must rebind() afterwards
 * (swapPet in game/stack does both).
 */
export function rebuildPet(rig: PetRig, paletteName?: keyof typeof PALETTES | PetPalette, opts: PetOptions = {}): PetRig {
  const next = buildPet(paletteName, opts);
  disposePet(rig, next);
  rig.group.remove(rig.scaler);
  rig.group.add(next.scaler);
  // (headSample is named so that a pet without one clears the last pet's.)
  Object.assign(rig, next, { group: rig.group, headSample: next.headSample });
  rig.group.updateMatrixWorld(true);
  return rig;
}

/**
 * Free what a rig holds on the GPU: its geometry and materials. Geometry that
 * `keep` also uses (the body mesh is cached per coat) is left alone, and so
 * are textures, which are small and shared between pets.
 */
export function disposePet(rig: PetRig, keep?: PetRig): void {
  const kept = new Set<THREE.BufferGeometry>();
  keep?.scaler.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) kept.add(g);
  });
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(rig.materials);
  rig.scaler.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !kept.has(m.geometry)) geos.add(m.geometry);
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mats.add(mat);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  rig.skeleton.dispose();
}

export function boneNames(species: Species = 'hopper'): BoneName[] {
  return (species === 'vizsla' ? DOG_BONES : BONES).map(([n]) => n as BoneName);
}

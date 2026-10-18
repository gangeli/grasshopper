import * as THREE from 'three';

/**
 * "Hopper" — a small fantasy creature (part baby dragon, part grasshopper):
 * a big round head with huge eyes, glowing antennae, leaf-like ear fins,
 * stubby arms, powerful folded hind legs for hopping, little wings and a
 * curly tail with a leaf tuft.
 *
 * Everything is built procedurally: a real bone hierarchy, smoothly skinned
 * tube/lathe meshes for the soft parts, and rigid parts (head, eyes, feet)
 * parented to bones. Rest pose bones have identity rotation, so animation is
 * expressed as plain local rotations. The pet faces +Z, Y up, feet at y=0.
 */

export type BoneName =
  | 'root' | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'thighL' | 'shinL' | 'ankleL' | 'toeL' | 'thighR' | 'shinR' | 'ankleR' | 'toeR'
  | 'shoulderL' | 'elbowL' | 'handL' | 'shoulderR' | 'elbowR' | 'handR'
  | 'tail0' | 'tail1' | 'tail2' | 'tail3' | 'tail4' | 'tail5'
  | 'antL0' | 'antL1' | 'antL2' | 'antL3' | 'antR0' | 'antR1' | 'antR2' | 'antR3'
  | 'wingL' | 'wingR' | 'earL' | 'earR';

type V = [number, number, number];

/** Absolute rest positions in pet space (meters) and parents. */
const BONES: [BoneName, BoneName | null, V][] = [
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 0.085, -0.005]],
  ['spine', 'hips', [0, 0.115, 0]],
  ['chest', 'spine', [0, 0.145, 0.006]],
  ['neck', 'chest', [0, 0.17, 0.012]],
  ['head', 'neck', [0, 0.19, 0.016]],
  // Hind legs: thigh angles forward, shin back down, long foot.
  ['thighL', 'hips', [0.042, 0.082, 0]],
  ['shinL', 'thighL', [0.054, 0.05, 0.04]],
  ['ankleL', 'shinL', [0.052, 0.018, -0.022]],
  ['toeL', 'ankleL', [0.052, 0.008, 0.035]],
  ['thighR', 'hips', [-0.042, 0.082, 0]],
  ['shinR', 'thighR', [-0.054, 0.05, 0.04]],
  ['ankleR', 'shinR', [-0.052, 0.018, -0.022]],
  ['toeR', 'ankleR', [-0.052, 0.008, 0.035]],
  // Arms.
  ['shoulderL', 'chest', [0.045, 0.148, 0.03]],
  ['elbowL', 'shoulderL', [0.062, 0.122, 0.04]],
  ['handL', 'elbowL', [0.068, 0.1, 0.052]],
  ['shoulderR', 'chest', [-0.045, 0.148, 0.03]],
  ['elbowR', 'shoulderR', [-0.062, 0.122, 0.04]],
  ['handR', 'elbowR', [-0.068, 0.1, 0.052]],
  // Tail curls back and up.
  ['tail0', 'hips', [0, 0.075, -0.045]],
  ['tail1', 'tail0', [0, 0.06, -0.075]],
  ['tail2', 'tail1', [0, 0.058, -0.105]],
  ['tail3', 'tail2', [0, 0.072, -0.13]],
  ['tail4', 'tail3', [0, 0.098, -0.14]],
  ['tail5', 'tail4', [0, 0.122, -0.13]],
  // Antennae spring from the top of the head.
  ['antL0', 'head', [0.022, 0.305, 0.03]],
  ['antL1', 'antL0', [0.03, 0.335, 0.04]],
  ['antL2', 'antL1', [0.042, 0.36, 0.058]],
  ['antL3', 'antL2', [0.056, 0.372, 0.082]],
  ['antR0', 'head', [-0.022, 0.305, 0.03]],
  ['antR1', 'antR0', [-0.03, 0.335, 0.04]],
  ['antR2', 'antR1', [-0.042, 0.36, 0.058]],
  ['antR3', 'antR2', [-0.056, 0.372, 0.082]],
  ['wingL', 'chest', [0.022, 0.16, -0.04]],
  ['wingR', 'chest', [-0.022, 0.16, -0.04]],
  ['earL', 'head', [0.062, 0.255, 0.0]],
  ['earR', 'head', [-0.062, 0.255, 0.0]],
];

export const HEAD_CENTER: V = [0, 0.245, 0.02];
export const HEAD_RADIUS = 0.068;

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
  ember: { body: 0xff9f5a, bodyDark: 0xd2633a, belly: 0xfff3d6, blush: 0xff6f7f, glow: 0xfff07a, eye: 0x7a3a12, wing: 0xffe39a },
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

export function buildPet(paletteName: keyof typeof PALETTES | PetPalette = 'mint'): PetRig {
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
  const skin = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.78,
    metalness: 0,
    // Velvety rim instead of plastic shine.
    sheen: 1,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(pal.belly).lerp(new THREE.Color(0xffffff), 0.2),
  });
  const glowMaterial = new THREE.MeshStandardMaterial({ color: pal.glow, emissive: pal.glow, emissiveIntensity: 0.9, roughness: 0.3 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15 });
  const irisMat = new THREE.MeshStandardMaterial({ color: pal.eye, roughness: 0.25 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.1 });
  const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lidMat = new THREE.MeshPhysicalMaterial({ color: pal.body, roughness: 0.78, sheen: 1, sheenRoughness: 0.75, sheenColor: new THREE.Color(pal.belly) });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x3a1420, roughness: 0.6 });
  const tongueMat = new THREE.MeshStandardMaterial({ color: 0xff7a8c, roughness: 0.5 });
  const blushMat = new THREE.MeshBasicMaterial({ color: pal.blush, transparent: true, opacity: 0.55, depthWrite: false });
  const wingMat = new THREE.MeshPhysicalMaterial({
    color: pal.wing,
    transparent: true,
    opacity: 0.55,
    roughness: 0.15,
    side: THREE.DoubleSide,
    iridescence: 1,
    iridescenceIOR: 1.6,
    depthWrite: false,
  });
  const clawMat = new THREE.MeshStandardMaterial({ color: pal.belly, roughness: 0.4 });
  const materials: THREE.Material[] = [skin, glowMaterial, white, irisMat, pupilMat, shineMat, lidMat, mouthMat, tongueMat, blushMat, wingMat, clawMat];

  const cBody = new THREE.Color(pal.body), cDark = new THREE.Color(pal.bodyDark), cBelly = new THREE.Color(pal.belly);

  // --- Skinned soft parts --------------------------------------------------------
  const addSkinned = (geo: THREE.BufferGeometry, name: string) => {
    const m = new THREE.SkinnedMesh(geo, skin);
    m.name = name;
    m.castShadow = true;
    m.frustumCulled = false;
    scaler.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    return m;
  };

  addSkinned(bodyGeometry(abs, boneIndex, cBody, cDark, cBelly), 'body');

  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    // Thigh: chunky drumstick, shin: slim.
    addSkinned(
      tubeGeometry(
        [abs[`thighL`].clone().setX(0.03 * s), abs[`shin${side}`], abs[`ankle${side}`]],
        [boneIndex(`thigh${side}`), boneIndex(`shin${side}`)],
        (t) => (t < 0.5 ? THREE.MathUtils.lerp(0.03, 0.019, smooth(t * 2)) : THREE.MathUtils.lerp(0.019, 0.011, (t - 0.5) * 2)),
        (t, a) => cBody.clone().lerp(cDark, 0.35 * smooth(t) + 0.15 * Math.max(0, -Math.cos(a))),
      ),
      `leg${side}`,
    );
    // Arm.
    addSkinned(
      tubeGeometry(
        [abs[`shoulder${side}`].clone().add(new THREE.Vector3(-0.01 * s, 0.006, -0.005)), abs[`elbow${side}`], abs[`hand${side}`]],
        [boneIndex(`shoulder${side}`), boneIndex(`elbow${side}`)],
        (t) => THREE.MathUtils.lerp(0.0135, 0.0105, t),
        () => cBody.clone(),
      ),
      `arm${side}`,
    );
    // Antenna.
    addSkinned(
      tubeGeometry(
        [abs[`ant${side}0`].clone().add(new THREE.Vector3(0, -0.012, -0.004)), abs[`ant${side}1`], abs[`ant${side}2`], abs[`ant${side}3`]],
        [boneIndex(`ant${side}0`), boneIndex(`ant${side}1`), boneIndex(`ant${side}2`)],
        (t) => THREE.MathUtils.lerp(0.0055, 0.0032, t),
        (t) => cBody.clone().lerp(cDark, t * 0.6),
        6,
      ),
      `antenna${side}`,
    );
  }

  // Tail.
  const tailPts = (['tail0', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5'] as BoneName[]).map((n) => abs[n]);
  addSkinned(
    tubeGeometry(
      [abs.hips.clone().add(new THREE.Vector3(0, -0.005, -0.02)), ...tailPts],
      [boneIndex('tail0'), boneIndex('tail0'), boneIndex('tail1'), boneIndex('tail2'), boneIndex('tail3'), boneIndex('tail4')],
      (t) => THREE.MathUtils.lerp(0.03, 0.007, Math.pow(t, 0.8)),
      (t, a) => {
        // Dark stripes along the top of the tail.
        const stripe = Math.sin(t * 28) > 0.3 && Math.cos(a) > 0 ? 0.55 : 0;
        return cBody.clone().lerp(cDark, stripe + 0.2 * t);
      },
      10,
    ),
    'tail',
  );

  // --- Rigid parts -----------------------------------------------------------------
  const attach = (boneName: BoneName, mesh: THREE.Object3D, absPos: THREE.Vector3) => {
    bones[boneName].add(mesh);
    mesh.position.copy(absPos.clone().sub(abs[boneName]));
    return mesh;
  };

  // Head.
  const head = new THREE.Mesh(headGeometry(cBody, cDark, cBelly), skin);
  head.castShadow = true;
  head.name = 'headMesh';
  attach('head', head, new THREE.Vector3(...HEAD_CENTER));

  // Horn nubs.
  for (const s of [1, -1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.026, 10), clawMat);
    horn.rotation.set(-0.5, 0, s * -0.35);
    attach('head', horn, new THREE.Vector3(0.04 * s, 0.305, -0.02));
  }

  // Antenna tip bulbs.
  for (const side of ['L', 'R'] as const) {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.011, 14, 10), glowMaterial);
    bulb.name = `bulb${side}`;
    attach(`ant${side}3`, bulb, abs[`ant${side}3`].clone().add(new THREE.Vector3(side === 'L' ? 0.004 : -0.004, 0.002, 0.008)));
  }

  // Ear fins: leaf shapes.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const fin = new THREE.Mesh(leafGeometry(0.06, 0.03, cBody, cBelly), skin);
    fin.castShadow = true;
    fin.rotation.set(0.15, s * 0.5, s * -0.5);
    if (s < 0) fin.scale.x = -1;
    attach(`ear${side}`, fin, abs[`ear${side}`]);
  }

  // Wings.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const wing = new THREE.Mesh(wingGeometry(), wingMat);
    wing.name = `wingMesh${side}`;
    wing.scale.x = s;
    attach(`wing${side}`, wing, abs[`wing${side}`]);
  }

  // Feet: long padded feet with three toes.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const foot = new THREE.Group();
    const sole = new THREE.Mesh(colorize(new THREE.SphereGeometry(1, 16, 10), (p) => (p.y < -0.2 ? cBelly : cBody)), skin);
    sole.scale.set(0.019, 0.011, 0.034);
    sole.position.set(0, 0.002, 0.012);
    sole.castShadow = true;
    foot.add(sole);
    for (const tx of [-0.011, 0, 0.011]) {
      const toe = new THREE.Mesh(colorize(new THREE.SphereGeometry(0.0075, 10, 8), () => cBody), skin);
      toe.position.set(tx, 0.001, 0.042 - Math.abs(tx) * 0.4);
      foot.add(toe);
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.0032, 0.008, 6), clawMat);
      claw.rotation.x = Math.PI / 2;
      claw.position.set(tx, 0.0, 0.05 - Math.abs(tx) * 0.4);
      foot.add(claw);
    }
    attach(`ankle${side}`, foot, abs[`ankle${side}`].clone().add(new THREE.Vector3(0, -0.008, 0)));
    // Hands: little mitts.
    const hand = new THREE.Mesh(colorize(new THREE.SphereGeometry(0.0125, 12, 10), () => cBody), skin);
    hand.scale.set(1, 0.85, 1.1);
    attach(`hand${side}`, hand, abs[`hand${side}`]);
    void s;
  }

  // Dorsal leaf crest on the back.
  for (let q = 0; q < 3; q++) {
    const leaf = new THREE.Mesh(leafGeometry(0.024 - q * 0.004, 0.014, cDark, cBody), skin);
    leaf.rotation.set(-1.9 - q * 0.15, Math.PI / 2, 0);
    attach(q === 0 ? 'chest' : 'spine', leaf, new THREE.Vector3(0, 0.15 - q * 0.024, -0.048 + q * 0.002));
  }

  // Tail tuft leaf.
  const tuft = new THREE.Mesh(leafGeometry(0.05, 0.03, cDark, cBelly), skin);
  tuft.rotation.set(-0.4, Math.PI / 2, 0);
  attach('tail5', tuft, abs.tail5.clone().add(new THREE.Vector3(0, 0.004, 0.006)));

  // --- Face --------------------------------------------------------------------------
  const face = buildFace(bones, abs, { white, irisMat, pupilMat, shineMat, lidMat, mouthMat, tongueMat, blushMat });

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });

  return { group, bones, rest, skeleton, scaler, face, materials, glowMaterial, palette: pal };
}

function buildFace(
  bones: Record<BoneName, THREE.Bone>,
  abs: Record<BoneName, THREE.Vector3>,
  m: Record<'white' | 'irisMat' | 'pupilMat' | 'shineMat' | 'lidMat' | 'mouthMat' | 'tongueMat', THREE.Material> & { blushMat: THREE.MeshBasicMaterial },
): FaceRig {
  const headBone = bones.head;
  const hc = new THREE.Vector3(...HEAD_CENTER);
  const toHead = (v: THREE.Vector3) => v.clone().sub(abs.head);
  const R = 0.024;
  const mkEye = (s: number) => {
    const eye = new THREE.Group();
    // Eyes sit on the front of the head, splayed outward a little.
    const center = hc.clone().add(new THREE.Vector3(0.03 * s, 0.006, HEAD_RADIUS * 0.74));
    eye.position.copy(toHead(center));
    eye.rotation.set(0, s * 0.42, 0);
    headBone.add(eye);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 18), m.white);
    ball.scale.set(1, 1.12, 0.8);
    eye.add(ball);
    const iris = new THREE.Group();
    eye.add(iris);
    const irisDisc = new THREE.Mesh(new THREE.SphereGeometry(R * 0.72, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.32), m.irisMat);
    irisDisc.rotation.x = Math.PI / 2;
    irisDisc.scale.set(1, 1, 1.14);
    irisDisc.position.z = R * 0.15;
    iris.add(irisDisc);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(R * 0.66, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.2), m.pupilMat);
    pupil.name = 'pupil';
    pupil.rotation.x = Math.PI / 2;
    pupil.scale.set(1, 1, 1.15);
    pupil.position.z = R * 0.19;
    iris.add(pupil);
    // Highlights don't rotate with the iris: that's what makes eyes read as glossy.
    for (const [x, y, r] of [
      [-0.32, 0.34, 0.24],
      [0.28, -0.3, 0.11],
    ]) {
      const shine = new THREE.Mesh(new THREE.CircleGeometry(R * r, 12), m.shineMat);
      shine.position.set(R * x * s, R * y * 1.1, R * 0.86);
      eye.add(shine);
    }
    const lidGeo = new THREE.SphereGeometry(R * 1.1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const up = new THREE.Mesh(lidGeo, m.lidMat);
    up.scale.set(1, 1.12, 0.86);
    eye.add(up);
    const lo = new THREE.Mesh(lidGeo, m.lidMat);
    lo.scale.set(0.98, -1.1, 0.84);
    eye.add(lo);
    return { eye, iris, up, lo };
  };
  const L = mkEye(1), Rr = mkEye(-1);

  const mouth = new THREE.Group();
  mouth.position.copy(toHead(hc.clone().add(new THREE.Vector3(0, -0.033, HEAD_RADIUS * 0.93))));
  mouth.rotation.x = -0.3;
  headBone.add(mouth);
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0019, 6, 16, Math.PI), m.mouthMat);
  smile.rotation.z = Math.PI;
  mouth.add(smile);
  const mouthOpen = new THREE.Mesh(new THREE.SphereGeometry(0.0105, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), m.mouthMat);
  mouthOpen.rotation.x = Math.PI / 2;
  mouthOpen.scale.set(1, 0.35, 0.01);
  mouthOpen.position.set(0, -0.002, -0.001);
  mouth.add(mouthOpen);
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 8), m.tongueMat);
  tongue.scale.set(1.2, 0.5, 0.5);
  tongue.position.set(0, -0.004, 0.001);
  mouthOpen.add(tongue);

  const mkBlush = (s: number) => {
    const b = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16), m.blushMat);
    const p = hc.clone().add(new THREE.Vector3(0.048 * s, -0.02, HEAD_RADIUS * 0.7));
    b.position.copy(toHead(p));
    b.lookAt(b.position.clone().add(new THREE.Vector3(0.55 * s, -0.1, 1)));
    b.scale.set(1.3, 0.8, 1);
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
// Geometry builders

const smooth = (t: number) => t * t * (3 - 2 * t);

function colorize(geo: THREE.BufferGeometry, fn: (p: THREE.Vector3) => THREE.Color): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const c = fn(p);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Pear-shaped lathe body, skinned to hips/spine/chest by height. */
function bodyGeometry(abs: Record<BoneName, THREE.Vector3>, boneIndex: (n: BoneName) => number, cBody: THREE.Color, cDark: THREE.Color, cBelly: THREE.Color): THREE.BufferGeometry {
  const y0 = 0.035, y1 = 0.2;
  const prof: THREE.Vector2[] = [];
  const N = 22;
  for (let q = 0; q <= N; q++) {
    const t = q / N;
    // Wider at the bottom (belly), narrowing to the neck.
    const r = Math.sin(Math.PI * Math.pow(t, 0.85)) * (0.064 - 0.03 * t) + 0.0001;
    prof.push(new THREE.Vector2(Math.max(r, 0.0001), y0 + (y1 - y0) * t));
  }
  const geo = new THREE.LatheGeometry(prof, 28);
  const pos = geo.attributes.position;
  const n = pos.count;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), col = new Float32Array(n * 3);
  const iH = boneIndex('hips'), iS = boneIndex('spine'), iC = boneIndex('chest'), iN = boneIndex('neck');
  const yH = abs.hips.y, yS = abs.spine.y, yC = abs.chest.y, yN = abs.neck.y;
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    // Flatten front-to-back slightly and push the belly forward.
    const front = p.z > 0 ? 1.08 : 0.86;
    p.z = p.z * front + 0.004;
    pos.setXYZ(i, p.x, p.y, p.z);
    let a: number, b: number, w: number;
    if (p.y < yS) {
      a = iH;
      b = iS;
      w = THREE.MathUtils.clamp((p.y - yH) / (yS - yH), 0, 1);
    } else if (p.y < yC) {
      a = iS;
      b = iC;
      w = (p.y - yS) / (yC - yS);
    } else {
      a = iC;
      b = iN;
      w = THREE.MathUtils.clamp((p.y - yC) / (yN - yC), 0, 1) * 0.6;
    }
    w = smooth(w);
    skinIndex.set([a, b, 0, 0], i * 4);
    skinWeight.set([1 - w, w, 0, 0], i * 4);
    // Belly patch on the front, darker back with spots.
    const r = Math.hypot(p.x, p.z) || 1;
    const facing = p.z / r;
    let c = cBody.clone();
    const bellyMask = smooth(THREE.MathUtils.clamp((facing - 0.35) * 3, 0, 1)) * smooth(THREE.MathUtils.clamp((0.185 - p.y) * 30, 0, 1));
    c.lerp(cBelly, bellyMask);
    if (facing < -0.2) {
      const spot = Math.sin(p.y * 160 + Math.atan2(p.x, p.z) * 5) > 0.6 ? 0.7 : 0.25;
      c = c.lerp(cDark, spot * smooth(THREE.MathUtils.clamp((-facing - 0.2) * 2, 0, 1)));
    }
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
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
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const rings = Math.max(12, pts.length * 8);
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

/** Big round head: slightly squashed sphere with full cheeks and a little muzzle. */
function headGeometry(cBody: THREE.Color, cDark: THREE.Color, cBelly: THREE.Color): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(HEAD_RADIUS, 40, 30);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n = p.clone().normalize();
    // Squash vertically, widen cheeks at the lower half.
    let sx = 1.08, sy = 0.9, sz = 0.95;
    if (n.y < 0.1) sx += (0.1 - n.y) * 0.12;
    // Muzzle bump at the lower front.
    const muzzle = Math.exp(-((n.x * n.x) / 0.08 + Math.pow(n.y + 0.38, 2) / 0.05 + Math.pow(n.z - 0.9, 2) / 0.08));
    sz += muzzle * 0.1;
    p.set(p.x * sx, p.y * sy, p.z * sz);
    pos.setXYZ(i, p.x, p.y, p.z);
    let c = cBody.clone();
    // Lighter muzzle/face mask, darker crown.
    const mask = Math.exp(-((n.x * n.x) / 0.18 + Math.pow(n.y + 0.45, 2) / 0.12 + Math.pow(n.z - 0.85, 2) / 0.2));
    c.lerp(cBelly, THREE.MathUtils.clamp(mask * 1.4, 0, 0.9));
    if (n.y > 0.55) c = c.lerp(cDark, (n.y - 0.55) * 0.9);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Double-sided leaf/fin blade lying in the XY plane, pointing +X, with a darker midrib. */
function leafGeometry(len: number, wid: number, c0: THREE.Color, c1: THREE.Color): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(len * 0.3, wid * 0.9, len * 0.75, wid * 0.7, len, 0);
  shape.bezierCurveTo(len * 0.75, -wid * 0.55, len * 0.3, -wid * 0.75, 0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.003, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelSegments: 2, curveSegments: 10 });
  geo.translate(0, 0, -0.0015);
  return colorize(geo, (p) => c0.clone().lerp(c1, THREE.MathUtils.clamp(Math.abs(p.y) / (wid * 0.6), 0, 1) * 0.6));
}

/** Two-lobed insect wing, root at origin, extending back (-Z) and out (+X). */
function wingGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.03, 0.025, 0.075, 0.03, 0.09, 0.008);
  shape.bezierCurveTo(0.095, -0.004, 0.07, -0.012, 0.045, -0.008);
  shape.bezierCurveTo(0.065, -0.02, 0.06, -0.04, 0.035, -0.032);
  shape.bezierCurveTo(0.02, -0.025, 0.008, -0.012, 0, 0);
  const geo = new THREE.ShapeGeometry(shape, 12);
  // Lay the wing back along the body: shape X → back/out, shape Y → up.
  geo.rotateY(-Math.PI / 2 + 0.5);
  geo.rotateX(0.5);
  return geo;
}

export function boneNames(): BoneName[] {
  return BONES.map(([n]) => n);
}

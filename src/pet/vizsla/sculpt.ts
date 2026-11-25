import type { V } from '../skeleton';
import { alignX, carve, ellipsoid, ring, roundCone, Sculpt, type BoneWeight, type Prim } from '../sdf/sdf';
import { DOG_P as P, type DogBoneName } from './skeleton';

/**
 * The Vizsla's sculpt: a lean, deep-chested pointer with a tucked-up waist,
 * long neck, a clean wedge of a head with a squared-off muzzle, long legs
 * with tight cat-like paws and a docked tail. Proportions are those of a
 * young dog (the head and eyes a touch larger than an adult's), so the face
 * still reads at arm's length on a phone.
 *
 * The lower jaw is its own sculpt (meshed separately, rigid on the jaw bone)
 * that sits in a channel carved under the muzzle, so the mouth really opens.
 * The ears are thin leather and are built as surfaces, not sculpted (see mesh.ts).
 */
export type DogRegion =
  | 'head' | 'cheek' | 'muzzle' | 'brow' | 'lip' | 'nose' | 'jaw' | 'neck' | 'body' | 'belly' | 'chest'
  | 'thigh' | 'shin' | 'foot' | 'toe' | 'arm' | 'forearm' | 'hand' | 'finger' | 'tail';

type DP = Prim<DogRegion>;

/** Eye centres (pet space): the eyeballs sit in carved sockets under the brow. */
export const DOG_EYE: Record<'L' | 'R', V> = { L: [0.013, 0.2834, 0.1732], R: [-0.013, 0.2834, 0.1732] };
/** Medium-sized: a dog's eyes are small in its head (big round ones make it a toy). */
export const DOG_EYE_RADIUS = 0.0074;
/** Eyes face forward and only a little outward, and are wider than they are tall. */
export const DOG_EYE_SPLAY = 0.28;
export const DOG_EYE_PITCH = -0.04;
export const DOG_EYE_SCALE: V = [1, 0.92, 0.8];
export const DOG_NOSE: V = [0, 0.2702, 0.226];
/** Paw centres (pet space, left side) and the sideways offsets of the four toes. */
export const DOG_PAW_F: V = [0.031, 0.0098, 0.0645];
export const DOG_PAW_H: V = [0.031, 0.0094, -0.0995];
export const DOG_TOE_DX = [-0.0072, -0.0025, 0.0025, 0.0072];
/** The collar: where it sits along the neck (a point on the neck's axis, the axis, and half its width). */
export const DOG_COLLAR = { at: [0, 0.2148, 0.1022] as V, axis: [0, 0.7907, 0.6122] as V, half: 0.0042 };
/**
 * The lower jaw: a shallow ellipsoid, narrower than the muzzle and set up
 * inside it, so the upper lips close down over its sides and only its
 * underside and chin show (a jaw as wide as the muzzle reads as a slack
 * lower lip). The muzzle is hollowed to its shape ahead of the corner of the
 * mouth (`back`, z); behind that the jaw runs under the cheeks.
 */
export const DOG_JAW = { c: [0, 0.2462, 0.1845] as V, r: [0.0112, 0.0052, 0.03] as V, back: 0.1705 };
/** Room for the tongue: a hollow in the roof of the mouth and a bed in the jaw (centre, radii). */
const PALATE = { c: [0, 0.2516, 0.1895] as V, r: [0.0066, 0.0048, 0.0185] as V };
const TONGUE_BED = { c: [0, 0.2524, 0.1885] as V, r: [0.0072, 0.0038, 0.0205] as V };

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/** Torso weights blend hips → spine → chest along the back (by z). */
function torso(_x: number, _y: number, z: number): BoneWeight[] {
  const zs: [DogBoneName, number][] = [
    ['hips', P.hips[2] + 0.012],
    ['spine', P.spine[2]],
    ['chest', P.chest[2]],
  ];
  if (z <= zs[0][1]) return [{ bone: 'hips', w: 1 }];
  for (let q = 0; q < zs.length - 1; q++) {
    const [a, za] = zs[q], [b, zb] = zs[q + 1];
    if (z <= zb) {
      const w = smooth((z - za) / (zb - za));
      return [
        { bone: a, w: 1 - w },
        { bone: b, w },
      ];
    }
  }
  return [{ bone: 'chest', w: 1 }];
}

/** A primitive with its own bone weights. */
const weighted = (p: DP, bones: (x: number, y: number, z: number) => BoneWeight[]): DP => ({ ...p, bones });

/**
 * A limb segment from joint a to joint b. It is rigid on `bone` (the joint at
 * a) and only blends at its ends, half-way into the joint before (`prev`) and
 * after (`next`), so knees, hocks and elbows bend like joints and the long
 * bones between them stay straight.
 */
function limb(region: DogRegion, a: V, b: V, ra: number, rb: number, bone: DogBoneName, next: DogBoneName | null, prev: DogBoneName | null, k: number, blend = 0.24): DP {
  const ab: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const il2 = 1 / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]);
  return weighted(roundCone(region, a, b, ra, rb, bone, bone, k), (x, y, z) => {
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) * il2));
    if (next && t > 1 - blend) {
      const w = 0.5 * smooth((t - (1 - blend)) / blend);
      return [
        { bone, w: 1 - w },
        { bone: next, w },
      ];
    }
    if (prev && t < blend) {
      const w = 0.5 * smooth((blend - t) / blend);
      return [
        { bone, w: 1 - w },
        { bone: prev, w },
      ];
    }
    return [{ bone, w: 1 }];
  });
}

/** The jaw's ellipsoid, grown by `grow` (m). */
function jawBody(grow: number, bone: DogBoneName): DP {
  const J = DOG_JAW;
  return ellipsoid<DogRegion>('jaw', J.c, [J.r[0] + grow, J.r[1] + grow, J.r[2] + grow], bone, 0);
}

/**
 * The hollows of the mouth in the head: the socket the closed jaw fills
 * (ahead of the corner of the mouth only) and the arch of the palate above
 * the tongue.
 */
export function mouthHollows(): DP[] {
  const e = jawBody(0.0006, 'head');
  const socket: DP = { ...e, region: 'lip', d: (x, y, z) => Math.max(e.d(x, y, z), DOG_JAW.back - z), min: [e.min[0], e.min[1], DOG_JAW.back] };
  return [socket, ellipsoid<DogRegion>('lip', PALATE.c, PALATE.r, 'head', 0)];
}

/** Height of the roof of the mouth above (x, z), in pet space (the upper teeth hang from it). */
export function mouthRoof(x: number, z: number): number {
  const J = DOG_JAW, e = [J.r[0] + 0.0006, J.r[1] + 0.0006, J.r[2] + 0.0006];
  const k = 1 - (x / e[0]) ** 2 - ((z - J.c[2]) / e[2]) ** 2;
  const kp = 1 - (x / PALATE.r[0]) ** 2 - ((z - PALATE.c[2]) / PALATE.r[2]) ** 2;
  return Math.max(J.c[1] + e[1] * Math.sqrt(Math.max(0, k)), kp > 0 ? PALATE.c[1] + PALATE.r[1] * Math.sqrt(kp) : -Infinity);
}

/** 0 at the middle of the mouth .. 1 at the lips (how far out a point is across the jaw's plan). */
export function mouthRim(x: number, z: number): number {
  const J = DOG_JAW;
  return Math.sqrt((x / J.r[0]) ** 2 + ((z - J.c[2]) / J.r[2]) ** 2);
}

export function buildVizslaSculpt(): Sculpt<DogRegion> {
  const S = new Sculpt<DogRegion>();
  // ---- Torso: deep ribcage, level back, waist tucked up towards the loin ------------------------
  S.add(
    ellipsoid<DogRegion>('body', [0, 0.1665, 0.03], [0.0345, 0.05, 0.058], torso, 0),
    // Forechest between the shoulders.
    ellipsoid<DogRegion>('chest', [0, 0.163, 0.079], [0.0255, 0.033, 0.024], torso, 0.02),
    // Loin: narrower and well off the ground (the tuck-up).
    weighted(roundCone<DogRegion>('body', [0, 0.1825, -0.012], [0, 0.182, -0.07], 0.0295, 0.0272, 'spine', 'hips', 0.022), torso),
    // Croup, sloping gently to the tail.
    ellipsoid<DogRegion>('body', [0, 0.1785, -0.085], [0.031, 0.0295, 0.033], torso, 0.022),
    // Withers: where the back begins, hardly higher than it.
    ellipsoid<DogRegion>('body', [0, 0.1985, 0.056], [0.018, 0.016, 0.03], torso, 0.02),
    // The brisket's keel, reaching the elbows.
    ellipsoid<DogRegion>('belly', [0, 0.132, 0.04], [0.022, 0.017, 0.04], torso, 0.016),
  );
  // ---- Neck: long, muscled, a little arch along the crest ------------------------------------------
  const neckW = (a: V, b: V) => {
    const ab: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const il2 = 1 / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]);
    return (x: number, y: number, z: number): BoneWeight[] => {
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) * il2));
      if (t < 0.3) {
        const w = smooth(t / 0.3);
        return [
          { bone: 'chest', w: 1 - w },
          { bone: 'neck', w },
        ];
      }
      const w = smooth((t - 0.62) / 0.36);
      return [
        { bone: 'neck', w: 1 - w },
        { bone: 'head', w },
      ];
    };
  };
  {
    const a: V = [0, 0.1845, 0.068], b: V = [0, 0.262, 0.128];
    const ta: V = [0, 0.168, 0.088], tb: V = [0, 0.2445, 0.139];
    S.add(
      weighted(roundCone<DogRegion>('neck', a, b, 0.031, 0.0225, 'neck', 'head', 0.026), neckW(a, b)),
      // Throat: the underline of the neck, into the forechest.
      weighted(roundCone<DogRegion>('neck', ta, tb, 0.0245, 0.0175, 'neck', 'head', 0.02), neckW(ta, tb)),
    );
  }
  // ---- Head: a lean skull, a defined brow and stop, a tapering muzzle that ends square --------------------
  S.add(
    ellipsoid<DogRegion>('head', [0, 0.2765, 0.146], [0.0245, 0.0215, 0.032], 'head', 0.012),
    // Occiput: the back of the skull is a little prominent.
    ellipsoid<DogRegion>('head', [0, 0.2852, 0.1245], [0.014, 0.0108, 0.011], 'head', 0.012),
    // Forehead: between the eyes, ending in the stop.
    ellipsoid<DogRegion>('head', [0, 0.2802, 0.162], [0.0195, 0.017, 0.017], 'head', 0.01),
  );
  for (const s of [1, -1]) {
    S.add(
      // Brow ridges: the eyes look out from under these (they give the face its thought).
      ellipsoid<DogRegion>('brow', [0.0132 * s, 0.2916, 0.1668], [0.009, 0.005, 0.0092], 'head', 0.009),
      // The orbit's outer rim and the cheekbone running back from it: the eye sits in front of these.
      ellipsoid<DogRegion>('cheek', [0.0182 * s, 0.2798, 0.159], [0.0058, 0.0076, 0.012], 'head', 0.008),
      ellipsoid<DogRegion>('cheek', [0.0188 * s, 0.2695, 0.158], [0.0076, 0.01, 0.02], 'head', 0.011),
      // Jowl: the cheek comes down over the back of the jaw.
      ellipsoid<DogRegion>('cheek', [0.011 * s, 0.2532, 0.1635], [0.006, 0.0098, 0.013], 'head', 0.008),
    );
  }
  S.add(
    // Bridge of the muzzle: straight from the stop to the nose.
    roundCone<DogRegion>('muzzle', [0, 0.2712, 0.174], [0, 0.27, 0.2115], 0.0135, 0.0098, 'head', 'head', 0.012),
  );
  for (const s of [1, -1]) {
    S.add(
      // Sides of the muzzle: deep, clearly narrower than the skull, tapering a little, ending square rather than snipy.
      roundCone<DogRegion>('muzzle', [0.0064 * s, 0.2655, 0.178], [0.0048 * s, 0.2644, 0.2118], 0.0112, 0.0088, 'head', 'head', 0.008),
      // Flews: the upper lips, close-fitting, just covering the lower jaw.
      ellipsoid<DogRegion>('lip', [0.0094 * s, 0.2542, 0.1925], [0.0054, 0.009, 0.0205], 'head', 0.006),
      // ...meeting under the nose (neatly: two fat lobes here would be jowls).
      ellipsoid<DogRegion>('lip', [0.0035 * s, 0.2546, 0.2128], [0.0043, 0.0078, 0.0054], 'head', 0.005),
    );
  }
  // Nose leather: set flush on the end of the muzzle, its top in line with the bridge.
  S.add(ellipsoid<DogRegion>('nose', [0, 0.2702, 0.2192], [0.0068, 0.0058, 0.0064], 'head', 0.004));
  for (const s of [1, -1]) S.add(ellipsoid<DogRegion>('nose', [0.0038 * s, 0.2692, 0.2202], [0.0038, 0.0042, 0.0048], 'head', 0.003));
  // ---- Forelegs: laid-back shoulder, straight forearm, tight paw ----------------------------------------
  for (const [s, side] of [
    [1, 'L'],
    [-1, 'R'],
  ] as const) {
    const sh = P[`shoulder${side}`], el = P[`elbow${side}`], wr = P[`hand${side}`];
    const shB = `shoulder${side}` as const, elB = `elbow${side}` as const, haB = `hand${side}` as const, paB = `paw${side}` as const;
    const pawF: V = [DOG_PAW_F[0] * s, DOG_PAW_F[1], DOG_PAW_F[2]];
    S.add(
      // Shoulder blade and its muscle, lying on the ribs (it mostly rides with the chest).
      weighted(ellipsoid<DogRegion>('arm', [0.029 * s, 0.176, 0.062], [0.0115, 0.033, 0.0215], 'chest', 0.018), () => [
        { bone: 'chest', w: 0.65 },
        { bone: shB, w: 0.35 },
      ]),
      limb('arm', add(sh, [0, 0.004, -0.002]), el, 0.0158, 0.0122, shB, elB, 'chest', 0.015),
      // Point of the elbow.
      ellipsoid<DogRegion>('arm', add(el, [0.001 * s, 0.003, -0.007]), [0.0072, 0.0085, 0.0075], shB, 0.007),
      // Forearm: muscled below the elbow, tapering to a fine wrist.
      limb('forearm', el, add(wr, [0, 0.001, 0]), 0.0112, 0.0072, elB, haB, shB, 0.007),
      ellipsoid<DogRegion>('forearm', add(el, [0.001 * s, -0.02, -0.003]), [0.0086, 0.02, 0.0102], elB, 0.007),
      // Wrist and pastern, sloping a little into the paw.
      limb('hand', wr, add(pawF, [0, 0.0062, -0.0055]), 0.0073, 0.0078, haB, paB, elB, 0.005, 0.3),
      ellipsoid<DogRegion>('hand', pawF, [0.0102, 0.0088, 0.012], paB, 0.005),
    );
    // Four arched toes, the middle two a little ahead.
    for (const dx of DOG_TOE_DX) S.add(ellipsoid<DogRegion>('finger', add(pawF, [dx * s, -0.0026, 0.0106 - Math.abs(dx) * 0.42]), [0.0035, 0.0056, 0.0062], paB, 0.002));
    // ---- Hind legs: broad muscled thigh, long second thigh, hocks well let down ----------------------------
    const hip = P[`thigh${side}`], kn = P[`shin${side}`], hk = P[`ankle${side}`];
    const thB = `thigh${side}` as const, shinB = `shin${side}` as const, anB = `ankle${side}` as const, toB = `toe${side}` as const;
    const pawH: V = [DOG_PAW_H[0] * s, DOG_PAW_H[1], DOG_PAW_H[2]];
    S.add(
      // The thigh is a broad flat sheet of muscle seen from the side, lean from behind.
      weighted(ellipsoid<DogRegion>('thigh', [0.0255 * s, 0.156, -0.083], [0.0138, 0.036, 0.0275], thB, 0.018), () => [
        { bone: thB, w: 0.7 },
        { bone: 'hips', w: 0.3 },
      ]),
      limb('thigh', add(hip, [0, -0.004, 0.002]), kn, 0.0205, 0.013, thB, shinB, 'hips', 0.018),
      // ...its front edge running in one line from the flank to the stifle.
      ellipsoid<DogRegion>(
        'thigh',
        [0.0285 * s, 0.5 * (hip[1] + kn[1]) - 0.004, 0.5 * (hip[2] + kn[2]) + 0.005],
        [0.033, 0.0118, 0.0168],
        thB,
        0.014,
        alignX([0, kn[1] - hip[1], kn[2] - hip[2]], [1, 0, 0]),
      ),
      // Second thigh (gaskin): its muscle sits high at the back, the tendon runs to the point of the hock.
      limb('shin', kn, hk, 0.0122, 0.0064, shinB, anB, thB, 0.012),
      ellipsoid<DogRegion>('shin', [kn[0], kn[1] - 0.019, kn[2] - 0.0155], [0.0088, 0.02, 0.0112], shinB, 0.009),
      ellipsoid<DogRegion>('shin', add(hk, [0, 0.003, -0.004]), [0.0056, 0.0085, 0.0058], shinB, 0.005),
      // Rear pastern, upright from hock to paw.
      limb('foot', hk, add(pawH, [0, 0.008, -0.0045]), 0.0066, 0.0071, anB, toB, shinB, 0.005),
      ellipsoid<DogRegion>('toe', pawH, [0.0098, 0.0086, 0.0116], toB, 0.005),
    );
    for (const dx of DOG_TOE_DX) S.add(ellipsoid<DogRegion>('toe', add(pawH, [dx * s, -0.0024, 0.0102 - Math.abs(dx) * 0.42]), [0.0034, 0.0054, 0.006], toB, 0.002));
  }
  // ---- Tail: thick at the root, tapering, docked ----------------------------------------------------------
  const tail: V[] = [[0, 0.19, -0.098], P.tail0, P.tail1, P.tail2, P.tail3, P.tail4, P.tail5, add(P.tail5, [0, -0.001, -0.0125])];
  const radii = [0.0125, 0.0098, 0.0085, 0.0076, 0.0068, 0.0061, 0.0054, 0.0046];
  const tb: DogBoneName[] = ['hips', 'tail0', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5', 'tail5'];
  // (No blend between the segments: they already meet exactly, and a blend would swell each joint into a ring.)
  for (let q = 0; q < tail.length - 1; q++) S.add(roundCone<DogRegion>('tail', tail[q], tail[q + 1], radii[q], radii[q + 1], tb[q], tb[q + 1], q === 0 ? 0.014 : 0));
  // ---- Mouth: the socket the lower jaw closes into, and the palate ---------------------------------------
  for (const h of mouthHollows()) S.add(carve(h, 0.0028));
  // ---- Eye sockets and lid folds ---------------------------------------------------------------------------
  const R = DOG_EYE_RADIUS;
  for (const side of ['L', 'R'] as const) {
    const e = DOG_EYE[side], s = side === 'L' ? 1 : -1;
    const ax: V = [Math.sin(DOG_EYE_SPLAY) * s, 0.05, Math.cos(DOG_EYE_SPLAY)];
    S.add(carve(ellipsoid<DogRegion>('head', add(e, [ax[0] * 0.0014, 0, ax[2] * 0.0014]), [R * 0.94, R * 0.92, R * 0.74], 'head', 0), 0.0026));
    const o = R * 0.42;
    S.add(ring<DogRegion>('brow', add(e, [ax[0] * o, ax[1] * o, ax[2] * o]), ax, R * 1.02, R * 0.25, 'head', 0.0026, 0.96));
  }
  return S;
}

/**
 * The lower jaw: broad and shallow with a neat chin; its back end runs under
 * the cheeks to the hinge, so it turns without opening a gap.
 */
export function buildJawSculpt(): Sculpt<DogRegion> {
  const S = new Sculpt<DogRegion>();
  const J = DOG_JAW;
  S.add(
    jawBody(0, 'jaw'),
    // Chin: blunt, a little behind the upper lip.
    ellipsoid<DogRegion>('jaw', [0, J.c[1] - 0.0006, J.c[2] + J.r[2] - 0.0082], [0.0058, 0.0048, 0.0064], 'jaw', 0.004),
  );
  // A bed for the tongue between the rows of teeth.
  S.add(carve(ellipsoid<DogRegion>('jaw', TONGUE_BED.c, TONGUE_BED.r, 'jaw', 0), 0.002));
  return S;
}

/** Coat length (m) per region: short, smooth and close-lying all over. */
export const DOG_FUR: Record<DogRegion, number> = {
  head: 0.0016,
  cheek: 0.0015,
  muzzle: 0.001,
  brow: 0.0013,
  lip: 0.0008,
  nose: 0,
  jaw: 0.0009,
  neck: 0.0024,
  body: 0.0023,
  belly: 0.0019,
  chest: 0.0027,
  thigh: 0.0022,
  shin: 0.0015,
  foot: 0.0012,
  toe: 0.0009,
  arm: 0.0021,
  forearm: 0.0015,
  hand: 0.0012,
  finger: 0.0009,
  tail: 0.002,
};

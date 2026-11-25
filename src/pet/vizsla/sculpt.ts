import type { V } from '../skeleton';
import { carve, ellipsoid, ring, roundCone, Sculpt, type BoneWeight, type Prim } from '../sdf/sdf';
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
 * The ears are thin leather and are built as surfaces, not sculpted (see ears.ts).
 */
export type DogRegion =
  | 'head' | 'cheek' | 'muzzle' | 'brow' | 'lip' | 'nose' | 'jaw' | 'neck' | 'body' | 'belly' | 'chest'
  | 'thigh' | 'shin' | 'foot' | 'toe' | 'arm' | 'forearm' | 'hand' | 'finger' | 'tail';

type DP = Prim<DogRegion>;

/** Eye centres (pet space): the eyeballs sit in carved sockets. */
export const DOG_EYE: Record<'L' | 'R', V> = { L: [0.0172, 0.2852, 0.1715], R: [-0.0172, 0.2852, 0.1715] };
export const DOG_EYE_RADIUS = 0.0102;
/** Eyes face forward and a little outward, and are slightly oval. */
export const DOG_EYE_SPLAY = 0.42;
export const DOG_EYE_PITCH = -0.06;
export const DOG_EYE_SCALE: V = [1, 0.97, 0.8];
export const DOG_NOSE: V = [0, 0.2705, 0.2335];
/** Front paw centre (pet space, left) and the sideways offsets of the four toes. */
export const DOG_PAW_F: V = [0.031, 0.0115, 0.066];
export const DOG_PAW_H: V = [0.031, 0.011, -0.098];
export const DOG_TOE_DX = [-0.0086, -0.003, 0.003, 0.0086];
/** Where the lower jaw's channel under the muzzle runs (also the tongue's bed). */
export const DOG_MOUTH = { back: [0, 0.2465, 0.176] as V, front: [0, 0.2465, 0.2195] as V, rBack: 0.0122, rFront: 0.0096 };

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/** Torso weights blend hips → spine → chest → neck along the back (by z). */
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

/** The channel under the muzzle that the lower jaw closes into. */
export function mouthChannel(grow = 0): DP {
  const M = DOG_MOUTH;
  return roundCone<DogRegion>('lip', M.back, M.front, M.rBack + grow, M.rFront + grow, 'head', 'head', 0);
}

export function buildVizslaSculpt(): Sculpt<DogRegion> {
  const S = new Sculpt<DogRegion>();
  // ---- Torso: deep ribcage, level back, waist tucked up towards the loin ------------------------
  S.add(
    ellipsoid<DogRegion>('body', [0, 0.1665, 0.03], [0.0355, 0.05, 0.06], torso, 0),
    // Forechest between the shoulders.
    ellipsoid<DogRegion>('chest', [0, 0.163, 0.081], [0.0265, 0.034, 0.024], torso, 0.022),
    // Loin: narrower and well off the ground (the tuck-up).
    weighted(roundCone<DogRegion>('body', [0, 0.1765, -0.002], [0, 0.1795, -0.068], 0.0345, 0.0305, 'spine', 'hips', 0.03), torso),
    // Croup, sloping gently to the tail.
    ellipsoid<DogRegion>('body', [0, 0.1765, -0.084], [0.0325, 0.0315, 0.035], torso, 0.026),
    // Withers.
    ellipsoid<DogRegion>('body', [0, 0.2005, 0.058], [0.019, 0.0165, 0.03], torso, 0.022),
    // The underline, from the brisket up into the flank.
    ellipsoid<DogRegion>('belly', [0, 0.136, 0.03], [0.027, 0.02, 0.05], torso, 0.02),
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
    const a: V = [0, 0.19, 0.066], b: V = [0, 0.2625, 0.128];
    const ta: V = [0, 0.168, 0.088], tb: V = [0, 0.2445, 0.139];
    S.add(
      weighted(roundCone<DogRegion>('neck', a, b, 0.0345, 0.0235, 'neck', 'head', 0.028), neckW(a, b)),
      // Throat: the underline of the neck, into the forechest.
      weighted(roundCone<DogRegion>('neck', ta, tb, 0.0265, 0.0185, 'neck', 'head', 0.022), neckW(ta, tb)),
    );
  }
  // ---- Head: a lean skull, moderate stop, squared-off muzzle ----------------------------------------
  S.add(
    ellipsoid<DogRegion>('head', [0, 0.279, 0.148], [0.027, 0.0252, 0.0325], 'head', 0.012),
    // Occiput: the back of the skull is a little prominent.
    ellipsoid<DogRegion>('head', [0, 0.289, 0.127], [0.016, 0.012, 0.012], 'head', 0.012),
  );
  for (const s of [1, -1]) {
    S.add(
      // Brow ridges over the eyes, with a furrow between them down the forehead.
      ellipsoid<DogRegion>('brow', [0.0118 * s, 0.2945, 0.1655], [0.011, 0.0068, 0.011], 'head', 0.009),
      // Cheeks: flat and clean, not bulging.
      ellipsoid<DogRegion>('cheek', [0.0195 * s, 0.2665, 0.158], [0.0098, 0.0125, 0.019], 'head', 0.012),
    );
  }
  S.add(
    // Bridge of the muzzle: straight from the stop to the nose.
    roundCone<DogRegion>('muzzle', [0, 0.2725, 0.172], [0, 0.2702, 0.2175], 0.0162, 0.0128, 'head', 'head', 0.014),
  );
  for (const s of [1, -1]) {
    S.add(
      // Sides of the muzzle: deep enough that it ends square rather than snipy.
      roundCone<DogRegion>('muzzle', [0.0078 * s, 0.2672, 0.178], [0.0066 * s, 0.2645, 0.2185], 0.0128, 0.0104, 'head', 'head', 0.008),
      // Flews: the upper lips, covering the lower jaw without hanging loose.
      ellipsoid<DogRegion>('lip', [0.0112 * s, 0.2572, 0.2], [0.0072, 0.0082, 0.021], 'head', 0.006),
    );
  }
  // Nose leather: broad, well ahead of the lips.
  S.add(ellipsoid<DogRegion>('nose', [0, 0.2705, 0.2262], [0.0098, 0.0082, 0.0082], 'head', 0.004));
  for (const s of [1, -1]) S.add(ellipsoid<DogRegion>('nose', [0.0056 * s, 0.2695, 0.2275], [0.0056, 0.0056, 0.0062], 'head', 0.003));
  // ---- Forelegs: laid-back shoulder, straight forearm, tight paw ----------------------------------------
  for (const [s, side] of [
    [1, 'L'],
    [-1, 'R'],
  ] as const) {
    const sh = P[`shoulder${side}`], el = P[`elbow${side}`], wr = P[`hand${side}`];
    const shB = `shoulder${side}` as const, elB = `elbow${side}` as const, haB = `hand${side}` as const;
    const pawF: V = [DOG_PAW_F[0] * s, DOG_PAW_F[1], DOG_PAW_F[2]];
    S.add(
      // Shoulder blade and its muscle, lying on the ribs (it mostly rides with the chest).
      weighted(ellipsoid<DogRegion>('arm', [0.0295 * s, 0.176, 0.062], [0.0125, 0.034, 0.0225], 'chest', 0.018), () => [
        { bone: 'chest', w: 0.65 },
        { bone: shB, w: 0.35 },
      ]),
      limb('arm', add(sh, [0, 0.004, -0.002]), el, 0.0172, 0.0138, shB, elB, 'chest', 0.016),
      // Point of the elbow.
      ellipsoid<DogRegion>('arm', add(el, [0.001 * s, 0.003, -0.0075]), [0.0085, 0.0095, 0.0085], shB, 0.008),
      // Forearm: muscled below the elbow, tapering to a fine wrist.
      limb('forearm', el, add(wr, [0, 0.001, 0]), 0.0128, 0.0084, elB, haB, shB, 0.008),
      ellipsoid<DogRegion>('forearm', add(el, [0.001 * s, -0.021, -0.0035]), [0.0102, 0.021, 0.0118], elB, 0.008),
      // Wrist and pastern, sloping a little into the paw.
      limb('hand', wr, add(pawF, [0, 0.0065, -0.006]), 0.0088, 0.0094, haB, null, elB, 0.006, 0.35),
      ellipsoid<DogRegion>('hand', pawF, [0.0124, 0.0102, 0.0148], haB, 0.006),
    );
    // Four arched toes, the middle two a little ahead.
    for (const dx of DOG_TOE_DX)
      S.add(ellipsoid<DogRegion>('finger', add(pawF, [dx * s, -0.0028, 0.0128 - Math.abs(dx) * 0.42]), [0.0041, 0.0064, 0.0072], haB, 0.0022));
    // ---- Hind legs: broad muscled thigh, long second thigh, hocks well let down ----------------------------
    const hip = P[`thigh${side}`], kn = P[`shin${side}`], hk = P[`ankle${side}`];
    const thB = `thigh${side}` as const, shinB = `shin${side}` as const, anB = `ankle${side}` as const, toB = `toe${side}` as const;
    const pawH: V = [DOG_PAW_H[0] * s, DOG_PAW_H[1], DOG_PAW_H[2]];
    S.add(
      // The thigh is a broad flat sheet of muscle seen from the side, lean from behind.
      weighted(ellipsoid<DogRegion>('thigh', [0.0265 * s, 0.158, -0.082], [0.0148, 0.036, 0.0285], thB, 0.02), () => [
        { bone: thB, w: 0.7 },
        { bone: 'hips', w: 0.3 },
      ]),
      limb('thigh', add(hip, [0, -0.004, 0.002]), kn, 0.0225, 0.0152, thB, shinB, 'hips', 0.018),
      ellipsoid<DogRegion>('thigh', add(kn, [0, 0.004, 0.0045]), [0.0118, 0.013, 0.0105], thB, 0.01),
      // Second thigh (gaskin): its muscle sits high at the back, the tendon runs to the point of the hock.
      limb('shin', kn, hk, 0.0138, 0.0074, shinB, anB, thB, 0.01),
      ellipsoid<DogRegion>('shin', [kn[0], kn[1] - 0.02, kn[2] - 0.0165], [0.0098, 0.02, 0.012], shinB, 0.009),
      ellipsoid<DogRegion>('shin', add(hk, [0, 0.003, -0.0045]), [0.0068, 0.0095, 0.0068], shinB, 0.006),
      // Rear pastern, upright from hock to paw.
      limb('foot', hk, add(pawH, [0, 0.0085, -0.005]), 0.0076, 0.0084, anB, toB, shinB, 0.006),
      ellipsoid<DogRegion>('toe', pawH, [0.0116, 0.0098, 0.0142], toB, 0.006),
    );
    for (const dx of DOG_TOE_DX)
      S.add(ellipsoid<DogRegion>('toe', add(pawH, [dx * s, -0.0026, 0.0122 - Math.abs(dx) * 0.42]), [0.0039, 0.0061, 0.0069], toB, 0.0022));
  }
  // ---- Tail: thick at the root, tapering, docked ----------------------------------------------------------
  const tail: V[] = [[0, 0.1895, -0.098], P.tail0, P.tail1, P.tail2, P.tail3, P.tail4, P.tail5, add(P.tail5, [0, -0.001, -0.0125])];
  const radii = [0.0142, 0.0112, 0.0098, 0.0088, 0.0079, 0.0071, 0.0063, 0.0054];
  const tb: DogBoneName[] = ['hips', 'tail0', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5', 'tail5'];
  for (let q = 0; q < tail.length - 1; q++) S.add(roundCone<DogRegion>('tail', tail[q], tail[q + 1], radii[q], radii[q + 1], tb[q], tb[q + 1], q === 0 ? 0.016 : 0.005));
  // ---- Mouth: the channel the lower jaw closes into ------------------------------------------------------
  S.add(carve(mouthChannel(), 0.0025));
  // ---- Eye sockets and lid folds ---------------------------------------------------------------------------
  const R = DOG_EYE_RADIUS;
  for (const side of ['L', 'R'] as const) {
    const e = DOG_EYE[side], s = side === 'L' ? 1 : -1;
    const ax: V = [Math.sin(DOG_EYE_SPLAY) * s, 0.06, Math.cos(DOG_EYE_SPLAY)];
    S.add(carve(ellipsoid<DogRegion>('head', add(e, [ax[0] * 0.0018, 0, ax[2] * 0.0018]), [R * 0.94, R * 0.94, R * 0.74], 'head', 0), 0.003));
    const o = R * 0.42;
    S.add(ring<DogRegion>('brow', add(e, [ax[0] * o, ax[1] * o, ax[2] * o]), ax, R * 1.02, R * 0.24, 'head', 0.0028, 0.98));
  }
  return S;
}

/**
 * The lower jaw: a slim mandible with a neat chin, rounded off at the hinge so
 * it turns inside the cheeks without opening a gap.
 */
export function buildJawSculpt(): Sculpt<DogRegion> {
  const S = new Sculpt<DogRegion>();
  const M = DOG_MOUTH;
  S.add(
    roundCone<DogRegion>('jaw', [0, 0.2478, 0.16], [0, 0.2462, 0.2125], 0.0116, 0.0083, 'jaw', 'jaw', 0),
    ellipsoid<DogRegion>('jaw', [0, 0.2452, 0.2135], [0.0086, 0.0072, 0.0082], 'jaw', 0.004),
    // Hinge end, tucked under the cheeks.
    ellipsoid<DogRegion>('jaw', [0, 0.25, 0.156], [0.0125, 0.0125, 0.0125], 'jaw', 0.006),
  );
  // A shallow bed for the tongue between the teeth.
  S.add(carve(roundCone<DogRegion>('jaw', add(M.back, [0, 0.0128, 0.004]), add(M.front, [0, 0.0098, -0.006]), 0.0078, 0.0058, 'jaw', 'jaw', 0), 0.003));
  return S;
}

/** Coat length (m) per region: short, smooth and close-lying all over. */
export const DOG_FUR: Record<DogRegion, number> = {
  head: 0.0022,
  cheek: 0.0021,
  muzzle: 0.0014,
  brow: 0.0018,
  lip: 0.0011,
  nose: 0,
  jaw: 0.0013,
  neck: 0.0034,
  body: 0.0032,
  belly: 0.0027,
  chest: 0.0037,
  thigh: 0.0031,
  shin: 0.0021,
  foot: 0.0016,
  toe: 0.0013,
  arm: 0.0029,
  forearm: 0.0021,
  hand: 0.0016,
  finger: 0.0012,
  tail: 0.0028,
};

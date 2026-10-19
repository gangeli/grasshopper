import { BONES, type BoneName, type V } from '../skeleton';
import { alignX, carve, ellipsoid, ring, roundCone, Sculpt, type BoneWeight, type Region } from './sdf';

/**
 * Hopper's sculpt: one continuous body built from smoothly blended shapes on
 * top of the skeleton. Proportions follow the "baby schema" that reads as
 * cute: big round head, big low-set eyes, chubby cheeks, small muzzle, round
 * tummy, short limbs and little paws.
 */
const P = Object.fromEntries(BONES.map(([n, , p]) => [n, p])) as Record<BoneName, V>;

/** Eye centres (pet space) — the eyeballs are placed here, inside carved sockets. */
export const EYE: Record<'L' | 'R', V> = { L: [0.03, 0.247, 0.066], R: [-0.03, 0.247, 0.066] };
export const EYE_RADIUS = 0.0235;
export const NOSE: V = [0, 0.228, 0.097];
export const MOUTH: V = [0, 0.213, 0.093];
/** Lid fold ring around each eye, in eye radii: offset along the eye axis, ring radius, tube radius. */
export const LID_FOLD = { offset: 0.4, R: 1.03, r: 0.25 };

/** Torso weights blend hips → spine → chest → neck by height. */
function torsoBones(_x: number, y: number): BoneWeight[] {
  const ys: [BoneName, number][] = [
    ['hips', P.hips[1]],
    ['spine', P.spine[1]],
    ['chest', P.chest[1]],
    ['neck', P.neck[1]],
  ];
  if (y <= ys[0][1]) return [{ bone: 'hips', w: 1 }];
  for (let q = 0; q < ys.length - 1; q++) {
    const [a, ya] = ys[q], [b, yb] = ys[q + 1];
    if (y <= yb) {
      const t = (y - ya) / (yb - ya);
      const w = t * t * (3 - 2 * t);
      return [
        { bone: a, w: 1 - w },
        { bone: b, w },
      ];
    }
  }
  return [{ bone: 'neck', w: 1 }];
}

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mirror = (p: V, s: number): V => [p[0] * s, p[1], p[2]];

export function buildCreatureSculpt(): Sculpt {
  const S = new Sculpt();
  // ---- Head ---------------------------------------------------------------------------------
  S.add(
    ellipsoid('head', [0, 0.246, 0.02], [0.071, 0.064, 0.066], 'head', 0),
    // Rounder skull behind, slightly higher: a big domed baby head.
    ellipsoid('head', [0, 0.258, -0.008], [0.062, 0.058, 0.056], 'head', 0.03),
  );
  for (const s of [1, -1]) {
    S.add(
      // Chubby cheeks low on the face.
      ellipsoid('cheek', [0.043 * s, 0.221, 0.044], [0.035, 0.029, 0.031], 'head', 0.028),
      // Soft brow pads above the eyes.
      ellipsoid('brow', [0.029 * s, 0.272, 0.066], [0.02, 0.009, 0.012], 'head', 0.016),
    );
  }
  S.add(
    // Small button muzzle and chin.
    ellipsoid('muzzle', [0, 0.219, 0.079], [0.027, 0.019, 0.019], 'head', 0.02),
    ellipsoid('muzzle', [0, 0.2, 0.06], [0.019, 0.012, 0.016], 'head', 0.018),
  );
  // ---- Ears: soft leaf-shaped fins sweeping out and back ---------------------------------------
  for (const [s, side] of [
    [1, 'L'],
    [-1, 'R'],
  ] as const) {
    const base = P[`ear${side}`];
    const dir: V = [0.8 * s, 0.42, -0.42];
    const rot = alignX(dir, [0, 1, 0.3]);
    const c = add(base, [0.022 * s, 0.012, -0.012]);
    // Leaf-shaped fin: a broad blade plus a narrower one reaching to a soft point.
    S.add(ellipsoid('ear', c, [0.036, 0.0075, 0.017], `ear${side}`, 0.014, rot));
    const X: V = [rot[0], rot[1], rot[2]], Y: V = [rot[3], rot[4], rot[5]];
    const at = (x: number, y: number): V => [c[0] + X[0] * x + Y[0] * y, c[1] + X[1] * x + Y[1] * y, c[2] + X[2] * x + Y[2] * y];
    S.add(ellipsoid('ear', at(0.02, -0.0005), [0.026, 0.0055, 0.0095], `ear${side}`, 0.008, rot));
    // Cupped inner face, leaving a soft rim (the pink side faces up and forward).
    S.add(carve(ellipsoid('ear', at(0.008, 0.0068), [0.028, 0.0042, 0.0112], `ear${side}`, 0, rot), 0.004));
  }
  // ---- Neck & torso -------------------------------------------------------------------------------
  S.add(
    roundCone('neck', [0, 0.163, 0.004], [0, 0.205, 0.016], 0.036, 0.04, 'chest', 'head', 0.025),
    ellipsoid('body', [0, 0.124, -0.003], [0.056, 0.067, 0.051], torsoBones, 0.03),
    // Round tummy.
    ellipsoid('belly', [0, 0.108, 0.02], [0.05, 0.05, 0.041], torsoBones, 0.03),
    // Fluffy chest.
    ellipsoid('chest', [0, 0.163, 0.034], [0.034, 0.024, 0.02], 'chest', 0.022),
  );
  // ---- Hind legs: chunky haunches, short shins, long padded feet ------------------------------------
  for (const [s, side] of [
    [1, 'L'],
    [-1, 'R'],
  ] as const) {
    const thigh = P[`thigh${side}`], shin = P[`shin${side}`], ankle = P[`ankle${side}`];
    S.add(
      roundCone('thigh', add(thigh, [0.004 * s, 0, -0.006]), shin, 0.035, 0.022, `thigh${side}`, `shin${side}`, 0.024),
      roundCone('shin', shin, ankle, 0.018, 0.0115, `shin${side}`, `ankle${side}`, 0.01),
      ellipsoid('foot', add(ankle, [0, -0.005, 0.017]), [0.019, 0.0105, 0.031], `ankle${side}`, 0.012),
    );
    for (const dx of [-0.011, 0, 0.011]) S.add(ellipsoid('toe', add(ankle, [dx * s, -0.008, 0.043 - Math.abs(dx) * 0.35]), [0.0078, 0.0068, 0.0078], `ankle${side}`, 0.006));
    // ---- Arms: stubby, with little mitten paws -------------------------------------------------------------
    const sh = P[`shoulder${side}`], el = P[`elbow${side}`], ha = P[`hand${side}`];
    S.add(
      roundCone('arm', add(sh, [-0.006 * s, 0.004, -0.004]), el, 0.0145, 0.0118, `shoulder${side}`, `elbow${side}`, 0.016),
      roundCone('arm', el, ha, 0.0118, 0.0102, `elbow${side}`, `hand${side}`, 0.006),
      ellipsoid('hand', add(ha, [0.001 * s, -0.002, 0.003]), [0.0128, 0.0105, 0.0135], `hand${side}`, 0.006),
    );
    for (const dx of [-0.0065, 0, 0.0065]) S.add(ellipsoid('finger', add(ha, [dx * s + 0.001 * s, -0.004, 0.0145]), [0.0042, 0.0042, 0.0046], `hand${side}`, 0.003));
  }
  // ---- Tail: curls back and up, ending in a plush leaf tuft -----------------------------------------------
  const tail: V[] = [[0, 0.082, -0.025], P.tail0, P.tail1, P.tail2, P.tail3, P.tail4, P.tail5];
  const radii = [0.03, 0.026, 0.021, 0.016, 0.0125, 0.0095, 0.0075];
  const tb: BoneName[] = ['hips', 'tail0', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5'];
  for (let q = 0; q < tail.length - 1; q++) S.add(roundCone('tail', tail[q], tail[q + 1], radii[q], radii[q + 1], tb[q], tb[q + 1], q === 0 ? 0.025 : 0.006));
  const tip = P.tail5, dirTip: V = [0, 0.024, 0.01];
  S.add(ellipsoid('tuft', add(tip, [0, 0.016, 0.006]), [0.024, 0.009, 0.016], 'tail5', 0.012, alignX(dirTip, [1, 0, 0])));
  // ---- Eye sockets (carved), so the eyes sit *in* the face -------------------------------------------------
  for (const side of ['L', 'R'] as const) {
    const e = EYE[side];
    S.add(carve(ellipsoid('head', add(e, [0, 0, 0.004]), [0.0215, 0.0235, 0.017], 'head', 0), 0.007));
  }
  // Soft lid folds wrapping the eyeballs, so from the side the eye sits in the
  // face rather than bulging out of it like a ball.
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? 1 : -1;
    const ax: V = [0.2955 * s, 0.0763, 0.9522];
    const o = EYE_RADIUS * LID_FOLD.offset;
    S.add(ring('brow', add(EYE[side], [ax[0] * o, ax[1] * o, ax[2] * o]), ax, EYE_RADIUS * LID_FOLD.R, EYE_RADIUS * LID_FOLD.r, 'head', 0.006, 1.08));
  }
  return S;
}

/** Fur length (m) per region: short on face and paws, fluffy cheeks/chest/tail tip. */
export const FUR_LENGTH: Record<Region, number> = {
  head: 0.0045,
  cheek: 0.0075,
  muzzle: 0.0011,
  brow: 0.003,
  ear: 0.0028,
  neck: 0.007,
  body: 0.006,
  belly: 0.0065,
  chest: 0.009,
  thigh: 0.0055,
  shin: 0.0035,
  foot: 0.0022,
  toe: 0.0008,
  arm: 0.0035,
  hand: 0.0016,
  finger: 0.0008,
  tail: 0.005,
  tuft: 0.011,
};

export { mirror };

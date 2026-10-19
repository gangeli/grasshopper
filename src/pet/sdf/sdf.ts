/**
 * Tiny signed-distance-field sculpting kit. Shapes are blended with smooth
 * unions so the creature is one continuous organic surface (cheeks flowing
 * into the face, a neck into the body) instead of glued-together spheres.
 *
 * Every primitive also says which bones it belongs to, so the meshed surface
 * can be skinned automatically.
 */
export type V3 = [number, number, number];

export interface BoneWeight {
  bone: string;
  w: number;
}

/** A region label used for colouring and fur length. */
export type Region =
  | 'head' | 'cheek' | 'muzzle' | 'brow' | 'ear' | 'neck' | 'body' | 'belly' | 'chest'
  | 'thigh' | 'shin' | 'foot' | 'toe' | 'arm' | 'hand' | 'finger' | 'tail' | 'tuft';

export interface Prim {
  region: Region;
  /** Signed distance at p. */
  d(x: number, y: number, z: number): number;
  /** Bone weights at p (on or near the surface). */
  bones(x: number, y: number, z: number): BoneWeight[];
  /** Smooth-union blend radius with what came before (m). */
  k: number;
  /** Subtractive primitive (carves, e.g. eye sockets). */
  carve?: boolean;
  /** Axis-aligned bounds (for culling), padded by k. */
  min: V3;
  max: V3;
}

const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

/** Ellipsoid (iq's bound-corrected approximation), optionally rotated by a 3x3 (row-major) matrix. */
export function ellipsoid(region: Region, c: V3, r: V3, bone: string | ((x: number, y: number, z: number) => BoneWeight[]), k = 0.01, rot?: number[]): Prim {
  const pad = Math.max(r[0], r[1], r[2]) + k;
  return {
    region,
    k,
    min: [c[0] - pad, c[1] - pad, c[2] - pad],
    max: [c[0] + pad, c[1] + pad, c[2] + pad],
    d(x, y, z) {
      let px = x - c[0], py = y - c[1], pz = z - c[2];
      if (rot) {
        const qx = rot[0] * px + rot[1] * py + rot[2] * pz;
        const qy = rot[3] * px + rot[4] * py + rot[5] * pz;
        const qz = rot[6] * px + rot[7] * py + rot[8] * pz;
        px = qx;
        py = qy;
        pz = qz;
      }
      const k0 = len3(px / r[0], py / r[1], pz / r[2]);
      const k1 = len3(px / (r[0] * r[0]), py / (r[1] * r[1]), pz / (r[2] * r[2]));
      return k1 === 0 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1;
    },
    bones: typeof bone === 'string' ? () => [{ bone, w: 1 }] : bone,
  };
}

/**
 * Round cone between a (radius ra) and b (radius rb): a tapered capsule, the
 * workhorse for limbs and tails. Bone weights blend from boneA to boneB along it.
 */
export function roundCone(region: Region, a: V3, b: V3, ra: number, rb: number, boneA: string, boneB: string = boneA, k = 0.01): Prim {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pad = Math.max(ra, rb) + k;
  return {
    region,
    k,
    min: [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.min(a[2], b[2]) - pad],
    max: [Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad, Math.max(a[2], b[2]) + pad],
    d(x, y, z) {
      // Inigo Quilez, sdRoundCone (arbitrary endpoints).
      const pax = x - a[0], pay = y - a[1], paz = z - a[2];
      const yv = pax * bax + pay * bay + paz * baz;
      const zv = yv - l2;
      const qx = pax * l2 - bax * yv, qy = pay * l2 - bay * yv, qz = paz * l2 - baz * yv;
      const x2 = qx * qx + qy * qy + qz * qz;
      const y2 = yv * yv * l2;
      const z2 = zv * zv * l2;
      const kk = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zv) * a2 * z2 > kk) return Math.sqrt(x2 + z2) * il2 - rb;
      if (Math.sign(yv) * a2 * y2 < kk) return Math.sqrt(x2 + y2) * il2 - ra;
      return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - ra;
    },
    bones(x, y, z) {
      if (boneA === boneB) return [{ bone: boneA, w: 1 }];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * bax + (y - a[1]) * bay + (z - a[2]) * baz) * il2));
      // Hold each bone near its end, blend through the middle.
      const s = Math.max(0, Math.min(1, (t - 0.3) / 0.4));
      const w = s * s * (3 - 2 * s);
      return [
        { bone: boneA, w: 1 - w },
        { bone: boneB, w },
      ];
    },
  };
}

/**
 * Torus ring around `axis` through centre c (major radius R, tube radius r);
 * `squash` stretches the ring along the frame's up direction (for oval eyes).
 */
export function ring(region: Region, c: V3, axis: V3, R: number, r: number, bone: string, k = 0.01, squash = 1): Prim {
  const al = Math.hypot(...axis);
  const ax = axis.map((v) => v / al) as V3;
  // Frame: u = up × axis, v = axis × u.
  let ux = ax[2], uy = 0, uz = -ax[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uz /= ul;
  const vx = ax[1] * uz - ax[2] * uy, vy = ax[2] * ux - ax[0] * uz, vz = ax[0] * uy - ax[1] * ux;
  const pad = R * squash + r + k;
  return {
    region,
    k,
    min: [c[0] - pad, c[1] - pad, c[2] - pad],
    max: [c[0] + pad, c[1] + pad, c[2] + pad],
    d(x, y, z) {
      const px = x - c[0], py = y - c[1], pz = z - c[2];
      const h = px * ax[0] + py * ax[1] + pz * ax[2];
      const a = px * ux + py * uy + pz * uz, b = (px * vx + py * vy + pz * vz) / squash;
      return Math.hypot(Math.hypot(a, b) - R, h) - r;
    },
    bones: () => [{ bone, w: 1 }],
  };
}

export function carve(p: Prim, k = 0.006): Prim {
  return { ...p, carve: true, k };
}

/** Polynomial smooth minimum. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** A sculpt: an ordered list of primitives combined left to right. */
export class Sculpt {
  readonly prims: Prim[] = [];
  add(...p: Prim[]): this {
    this.prims.push(...p);
    return this;
  }

  /** Combined distance. */
  d(x: number, y: number, z: number): number {
    let d = 1e9;
    for (const p of this.prims) {
      // Culling: bounds are padded by k, so the primitive is at least
      // (distance to the box + k) away. It can only change the blend when that
      // is within k of the running value, so skip it otherwise. A looser test
      // leaves ripples where the boxes end.
      const bx = Math.max(p.min[0] - x, 0, x - p.max[0]), by = Math.max(p.min[1] - y, 0, y - p.max[1]), bz = Math.max(p.min[2] - z, 0, z - p.max[2]);
      if (bx + by + bz > 0 && Math.sqrt(bx * bx + by * by + bz * bz) >= Math.abs(d)) continue;
      const v = p.d(x, y, z);
      d = p.carve ? smax(d, -v, p.k) : smin(d, v, p.k);
    }
    return d;
  }

  /**
   * Which primitives own the surface at p: soft-max over non-carving
   * primitives by distance. Returns blended bone weights and the dominant region.
   */
  attribution(x: number, y: number, z: number, sharpness = 0.005): { bones: BoneWeight[]; region: Region; regionWeights: Map<Region, number> } {
    const ds: { p: Prim; d: number }[] = [];
    let dmin = Infinity;
    for (const p of this.prims) {
      if (p.carve) continue;
      const pad = 0.03;
      if (x < p.min[0] - pad || y < p.min[1] - pad || z < p.min[2] - pad || x > p.max[0] + pad || y > p.max[1] + pad || z > p.max[2] + pad) continue;
      const d = p.d(x, y, z);
      ds.push({ p, d });
      if (d < dmin) dmin = d;
    }
    const bw = new Map<string, number>();
    const rw = new Map<Region, number>();
    let region: Region = 'body';
    let best = -1;
    for (const { p, d } of ds) {
      const w = Math.exp(-(d - dmin) / sharpness);
      if (w < 1e-3) continue;
      for (const b of p.bones(x, y, z)) bw.set(b.bone, (bw.get(b.bone) ?? 0) + b.w * w);
      rw.set(p.region, (rw.get(p.region) ?? 0) + w);
      if (w > best) {
        best = w;
        region = p.region;
      }
    }
    const bones = [...bw.entries()].map(([bone, w]) => ({ bone, w })).sort((a, b) => b.w - a.w).slice(0, 4);
    const tot = bones.reduce((s, b) => s + b.w, 0) || 1;
    for (const b of bones) b.w /= tot;
    let rt = 0;
    for (const v of rw.values()) rt += v;
    for (const [k, v] of rw) rw.set(k, v / (rt || 1));
    return { bones, region, regionWeights: rw };
  }
}

/** Rotation matrix (row-major 3x3) that maps world → local for an ellipsoid whose local +X points along dir. */
export function alignX(dir: V3, up: V3 = [0, 1, 0]): number[] {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const xx = dir[0] / l, xy = dir[1] / l, xz = dir[2] / l;
  // z = x × up, y = z × x
  let zx = xy * up[2] - xz * up[1], zy = xz * up[0] - xx * up[2], zz = xx * up[1] - xy * up[0];
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, xy, xz, yx, yy, yz, zx, zy, zz];
}

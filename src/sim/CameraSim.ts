import { Rng } from '../core/rng';
import type { Vec3 } from '../core/math';
import { rayBox, type Material, type SimBox, type SimRoom } from './SimRoom';
import { cameraBasis, type SimCamera } from './SimSensor';

/**
 * A phone camera for the simulated rooms: ray-traced grayscale frames with
 * the things that make depth-from-motion hard in real homes. Blank walls and
 * floors have almost no texture, dark fabric is noisy, glass is see-through
 * with faint reflections, and mirrors show the room. Frames also get
 * ceiling-light shading and shadows, auto-exposure that lags, photon and
 * read noise, vignetting, motion blur and 8-bit quantisation.
 *
 * The frames feed the same motion-stereo code a phone without a depth
 * sensor would run, so mapping can be evaluated on "camera output" instead of
 * an idealised depth model.
 */
export interface CameraFrame {
  w: number;
  h: number;
  /** Linear-ish 8-bit grayscale (0..255), row 0 = top. */
  gray: Uint8Array;
  /** Focal lengths and principal point, in pixels. */
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** Camera-to-world (column-major, camera looks down -Z), as tracked. */
  camToWorld: ArrayLike<number>;
  t: number;
  /** Ground-truth z-depth per pixel (for evaluation only; never used by stereo). */
  truthDepth?: Float32Array;
}

export interface CameraOptions {
  /** Image height (px); the width follows the camera's aspect ratio. */
  h: number;
  /** Motion blur: sub-frames rendered along the motion during the exposure. */
  blurSamples: number;
  /** Fraction of the frame interval the shutter is open (indoor ≈ 0.3–0.6). */
  shutter: number;
  /** Read noise and photon (shot) noise scale, in 0..1 intensity units. */
  readNoise: number;
  shotNoise: number;
  /** Strength of vignetting at the corners. */
  vignette: number;
}

/**
 * A mid-range phone indoors: ~25ms exposure at 10Hz frame sampling (shutter
 * 0.25 of the interval), noise as left after the ISP's denoising (~1–2 grey
 * levels at mid-grey, more in dim rooms).
 */
export const PHONE_CAMERA: CameraOptions = { h: 192, blurSamples: 3, shutter: 0.25, readNoise: 0.006, shotNoise: 0.012, vignette: 0.35 };

/** Smooth value noise in [0,1]. */
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => {
    const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

const lum = (hex: number) => (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;

export class CameraSim {
  private rng: Rng;
  private exposure = 1;
  private prev: SimCamera | null = null;
  readonly opts: CameraOptions;
  constructor(readonly room: SimRoom, opts: Partial<CameraOptions> = {}, seed = 5) {
    this.opts = { ...PHONE_CAMERA, ...opts };
    this.rng = new Rng(seed);
  }

  /** Where the room's ceiling lights are. */
  private lights(): Vec3[] {
    const r = this.room, y = r.wallHeight - 0.05;
    return [
      { x: -r.halfW * 0.4, y, z: -r.halfD * 0.3 },
      { x: r.halfW * 0.4, y, z: r.halfD * 0.3 },
    ];
  }

  /** Surface albedo with procedural texture by material, in 0..1. */
  private albedo(p: Vec3, n: Vec3, box: SimBox | null, mat: Material): number {
    if (!box) {
      // Floor: wooden planks when textured, smooth lino/concrete when not.
      if (mat === 'textureless') return 0.5 * (1 + 0.02 * (vnoise(p.x * 30, 0, p.z * 30) - 0.5));
      const plank = Math.floor(p.z / 0.18);
      const grain = vnoise(p.x * 3 + plank * 7.3, plank, p.z * 40) * 0.5 + vnoise(p.x * 25, plank * 3.1, p.z * 120) * 0.25;
      return 0.38 + 0.12 * Math.sin(plank * 2.3) * 0.5 + 0.22 * grain + (Math.abs(p.z / 0.18 - Math.round(p.z / 0.18)) < 0.02 ? -0.12 : 0);
    }
    const base = 0.25 + 0.6 * lum(box.color);
    // Texture coordinates on the face plane (triplanar by normal).
    const ax = Math.abs(n.x), ay = Math.abs(n.y);
    const [a, b] = ax > 0.5 ? [p.y, p.z] : ay > 0.5 ? [p.x, p.z] : [p.x, p.y];
    switch (mat) {
      case 'textureless':
        return base * (1 + 0.015 * (vnoise(a * 40, b * 40, 0.5) - 0.5));
      case 'dark':
        return 0.06 * (1 + 0.5 * (vnoise(a * 90, b * 90, 1.5) - 0.5));
      default: {
        // Fabric/wood/print: features at several scales, as on real furniture.
        const t = 0.55 + 0.35 * vnoise(a * 6, b * 6, 2.5) + 0.25 * (vnoise(a * 35, b * 35, 3.5) - 0.5) + 0.15 * (vnoise(a * 140, b * 140, 4.5) - 0.5);
        return base * t;
      }
    }
  }

  /** Radiance along a ray (0..~1.5 before exposure). */
  private trace(o: Vec3, d: Vec3, depth = 0): { L: number; t: number } {
    const room = this.room;
    let best = 30;
    let hitBox: SimBox | null = null;
    let normal: Vec3 = { x: 0, y: 1, z: 0 };
    let mat: Material = room.floorMaterial;
    let glassT = Infinity;
    if (d.y < -1e-6) {
      const t = -o.y / d.y;
      if (t > 1e-4 && t < best) best = t;
    }
    for (const b of room.boxes) {
      const r = rayBox(o, d, b.min, b.max);
      if (!r || r.t <= 1e-4) continue;
      if (b.material === 'glass') {
        glassT = Math.min(glassT, r.t);
        continue;
      }
      if (r.t < best) {
        best = r.t;
        hitBox = b;
        normal = r.normal;
        mat = b.material ?? 'matte';
      }
    }
    // People walking through wear textured clothes.
    for (const dyn of room.dynamic) {
      const f = dyn.at(room.time);
      if (!f) continue;
      const mn = { x: f.x - dyn.size.x / 2, y: f.y, z: f.z - dyn.size.z / 2 }, mx = { x: f.x + dyn.size.x / 2, y: f.y + dyn.size.y, z: f.z + dyn.size.z / 2 };
      const r = rayBox(o, d, mn, mx);
      if (r && r.t > 1e-4 && r.t < best) {
        best = r.t;
        hitBox = { min: mn, max: mx, color: 0x6a5acd, piece: -1, material: 'matte' };
        normal = r.normal;
        mat = 'matte';
      }
    }
    const p = { x: o.x + d.x * best, y: o.y + d.y * best, z: o.z + d.z * best };
    let L: number;
    if (mat === 'mirror' && depth < 2) {
      const dn = d.x * normal.x + d.y * normal.y + d.z * normal.z;
      const r = { x: d.x - 2 * dn * normal.x, y: d.y - 2 * dn * normal.y, z: d.z - 2 * dn * normal.z };
      L = 0.85 * this.trace(p, r, depth + 1).L + 0.03;
    } else {
      const alb = this.albedo(p, normal, hitBox, mat);
      // Ambient (sky-ish fill) + ceiling lights with shadows.
      let E = 0.25 + 0.1 * normal.y;
      for (const l of this.lights()) {
        const lx = l.x - p.x, ly = l.y - p.y, lz = l.z - p.z;
        const ld = Math.hypot(lx, ly, lz);
        const cos = (lx * normal.x + ly * normal.y + lz * normal.z) / ld;
        if (cos <= 0) continue;
        const dir = { x: lx / ld, y: ly / ld, z: lz / ld };
        const o2 = { x: p.x + normal.x * 1e-3, y: p.y + normal.y * 1e-3, z: p.z + normal.z * 1e-3 };
        let shadow = false;
        for (const b of room.boxes) {
          if (b.material === 'glass') continue;
          const r = rayBox(o2, dir, b.min, b.max);
          if (r && r.t > 1e-4 && r.t < ld) {
            shadow = true;
            break;
          }
        }
        if (!shadow) E += (1.6 * cos) / (1 + 0.25 * ld * ld);
      }
      L = alb * E;
    }
    // Glass in front: mostly transmits, adds a faint reflection of the bright room.
    if (glassT < best) L = 0.9 * L + 0.06;
    return { L, t: best };
  }

  /**
   * Render a frame at `cam` (the true pose). `camToWorld` is the pose the
   * tracker reports, which the frame carries for the stereo to use.
   */
  render(cam: SimCamera, camToWorld: ArrayLike<number>, opts: { truth?: boolean } = {}): CameraFrame {
    const { h, blurSamples, shutter, readNoise, shotNoise, vignette } = this.opts;
    // Square pixels: width follows the camera's aspect (a multiple of 3 for the stereo grid).
    const w = Math.max(3, Math.round((h * cam.aspect) / 3) * 3);
    const acc = new Float32Array(w * h);
    const truth = opts.truth ? new Float32Array(w * h) : undefined;
    const prev = this.prev ?? cam;
    const n = Math.max(1, blurSamples);
    for (let s = 0; s < n; s++) {
      // Sub-frame poses across the open shutter, centred on the frame pose (frame
      // timestamps and tracked poses refer to mid-exposure); extrapolated forward.
      const f = n === 1 ? 1 : 1 - shutter / 2 + (shutter * s) / (n - 1);
      const c: SimCamera = {
        ...cam,
        pos: { x: prev.pos.x + (cam.pos.x - prev.pos.x) * f, y: prev.pos.y + (cam.pos.y - prev.pos.y) * f, z: prev.pos.z + (cam.pos.z - prev.pos.z) * f },
        yaw: prev.yaw + angleDiff(cam.yaw, prev.yaw) * f,
        pitch: prev.pitch + (cam.pitch - prev.pitch) * f,
      };
      const { forward, right, up } = cameraBasis(c);
      const ty = Math.tan(c.fovY / 2), tx = (ty * w) / h;
      for (let py = 0; py < h; py++)
        for (let px = 0; px < w; px++) {
          const nx = ((px + 0.5) / w) * 2 - 1, ny = 1 - ((py + 0.5) / h) * 2;
          let dx = forward.x + right.x * nx * tx + up.x * ny * ty;
          let dy = forward.y + right.y * nx * tx + up.y * ny * ty;
          let dz = forward.z + right.z * nx * tx + up.z * ny * ty;
          const l = Math.hypot(dx, dy, dz);
          dx /= l;
          dy /= l;
          dz /= l;
          const r = this.trace(c.pos, { x: dx, y: dy, z: dz });
          acc[py * w + px] += r.L / n;
          if (truth && s === (n - 1) >> 1) truth[py * w + px] = r.t * (dx * forward.x + dy * forward.y + dz * forward.z);
        }
    }
    this.prev = cam;
    // Auto-exposure aims for a mid-grey mean but adapts slowly, like a phone's.
    let mean = 0;
    for (let i = 0; i < acc.length; i++) mean += acc[i];
    mean /= acc.length;
    const target = 0.42 / Math.max(1e-3, mean);
    this.exposure += (target - this.exposure) * 0.35;
    const gain = this.exposure;
    const gray = new Uint8Array(w * h);
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const i = py * w + px;
        const u = (px + 0.5) / w - 0.5, v = (py + 0.5) / h - 0.5;
        let I = acc[i] * gain * (1 - vignette * (u * u + v * v) * 2);
        // Shot noise grows with signal; read noise is amplified by gain (dim rooms are grainy).
        I += this.gauss() * Math.sqrt(shotNoise * shotNoise * Math.max(0, I) + readNoise * readNoise * Math.max(1, gain));
        // Display gamma and 8-bit quantisation.
        gray[i] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.max(0, Math.min(1, I)), 1 / 2.2))));
      }
    const ty = Math.tan(cam.fovY / 2), tx = (ty * w) / h;
    return { w, h, gray, fx: w / 2 / tx, fy: h / 2 / ty, cx: w / 2, cy: h / 2, camToWorld, t: this.room.time, truthDepth: truth };
  }

  private gauss(): number {
    const u = Math.max(1e-9, this.rng.next()), v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

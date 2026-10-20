import * as THREE from 'three';

/** Pool size: at most this many hearts are in the air at once. */
const MAX_HEARTS = 16;
const TEX = 64;

/**
 * A heart drawn into a small RGBA texture with plain math (no canvas, so it
 * also works in node tests): the implicit heart curve (x²+y²−1)³ − x²y³ ≤ 0,
 * supersampled for a soft edge, pink with a darker rose rim, a gentle
 * top-to-bottom shade and a glossy highlight.
 */
function heartTexture(): THREE.DataTexture {
  const data = new Uint8Array(TEX * TEX * 4);
  // Map the texture square onto the curve's bounding box (≈ x∈[-1.15,1.15],
  // y∈[-1.05,1.25]); `k` > 1 tests a slightly smaller heart (for the rim).
  const inside = (u: number, v: number, k = 1) => {
    const x = (u - 0.5) * 2.5 * k;
    const y = ((v - 0.47) * 2.5 - 0.1) * k + 0.1;
    const a = x * x + y * y - 1;
    return a * a * a - x * x * y * y * y;
  };
  const S = 3;
  for (let j = 0; j < TEX; j++)
    for (let i = 0; i < TEX; i++) {
      let cover = 0, rim = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const u = (i + (sx + 0.5) / S) / TEX, v = (j + (sy + 0.5) / S) / TEX;
          if (inside(u, v) <= 0) {
            cover++;
            // Outside a slightly smaller heart: the darker rim.
            if (inside(u, v, 1.13) > 0) rim++;
          }
        }
      const k = (j * TEX + i) * 4;
      const c = cover / (S * S);
      if (c <= 0) continue;
      const v = j / TEX; // 0 = bottom (DataTexture rows go bottom-up with flipY false)
      const r = rim / Math.max(1, cover);
      // Body: light pink at the top, deeper pink at the tip.
      let R = 255, G = 100 + 60 * v, B = 155 + 40 * v;
      // Rim.
      R = R * (1 - r) + 226 * r;
      G = G * (1 - r) + 58 * r;
      B = B * (1 - r) + 120 * r;
      // Glossy highlight on the upper-left lobe.
      const hx = (i / TEX - 0.33) / 0.11, hy = (v - 0.7) / 0.08;
      const h = Math.max(0, 1 - hx * hx - hy * hy);
      R += (255 - R) * h;
      G += (255 - G) * h;
      B += (255 - B) * h;
      data[k] = R;
      data[k + 1] = G;
      data[k + 2] = B;
      data[k + 3] = Math.round(255 * c);
    }
  const tex = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

interface Heart {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  /** Seconds lived, total life (s); life 0 = free. */
  t: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vy: number;
  /** Side-to-side wobble: amplitude (m), rate (rad/s), phase. */
  wob: number;
  wobRate: number;
  ph: number;
  size: number;
  delay: number;
}

/**
 * Little hearts that float up from Hopper when petted: a fixed pool of
 * billboarded sprites sharing one texture, each with a short (~1.1 s) life:
 * pop in, drift up with a wobble, fade out. Nothing is allocated per frame.
 * Add `group` to the same parent as the pet (the map frame) and spawn at
 * points in that frame.
 */
export class Hearts {
  readonly group = new THREE.Group();
  private readonly texture = heartTexture();
  private readonly pool: Heart[] = [];
  private rand: () => number;
  /** Hearts spawned in total (diagnostics, tests). */
  spawned = 0;
  private disposed = false;

  constructor(rand: () => number = Math.random) {
    this.rand = rand;
    this.group.name = 'hearts';
    for (let n = 0; n < MAX_HEARTS; n++) {
      const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, opacity: 0, fog: false });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 10;
      sprite.frustumCulled = false;
      this.group.add(sprite);
      this.pool.push({ sprite, mat, t: 0, life: 0, x: 0, y: 0, z: 0, vy: 0, wob: 0, wobRate: 0, ph: 0, size: 0, delay: 0 });
    }
  }

  /** Hearts currently in the air. */
  get active(): number {
    let n = 0;
    for (const h of this.pool) if (h.life > 0) n++;
    return n;
  }

  /**
   * Release `count` hearts around `at` (parent frame), staggered a little.
   * `scale` is the pet's size factor (1 = normal Hopper).
   */
  spawn(at: { x: number; y: number; z: number }, count: number, scale = 1): void {
    if (this.disposed) return;
    const r = this.rand;
    for (let n = 0; n < count; n++) {
      // A free slot, else recycle the oldest.
      let h: Heart | null = null;
      for (const c of this.pool) {
        if (c.life <= 0) {
          h = c;
          break;
        }
        if (!h || c.t / c.life > h.t / h.life) h = c;
      }
      if (!h) return;
      const a = r() * Math.PI * 2;
      const rad = (0.03 + 0.06 * r()) * scale * (count > 4 ? 1.4 : 1);
      h.x = at.x + Math.cos(a) * rad;
      h.y = at.y + (0.01 + 0.03 * r()) * scale;
      h.z = at.z + Math.sin(a) * rad;
      h.vy = (0.13 + 0.09 * r()) * scale;
      h.wob = (0.008 + 0.012 * r()) * scale;
      h.wobRate = 5 + 3 * r();
      h.ph = r() * Math.PI * 2;
      h.size = (0.04 + 0.022 * r()) * scale;
      h.t = 0;
      h.life = 0.95 + 0.35 * r();
      h.delay = n * (count > 4 ? 0.06 : 0.11);
      // Slight hue variety: pinks from rose to bubblegum.
      h.mat.color.setRGB(1, 0.86 + 0.14 * r(), 0.9 + 0.1 * r());
      h.mat.rotation = (r() - 0.5) * 0.5;
      h.sprite.visible = false;
      this.spawned++;
    }
  }

  update(dt: number): void {
    for (const h of this.pool) {
      if (h.life <= 0) continue;
      if (h.delay > 0) {
        h.delay -= dt;
        if (h.delay > 0) continue;
      }
      h.t += dt;
      const u = h.t / h.life;
      if (u >= 1) {
        h.life = 0;
        h.sprite.visible = false;
        h.mat.opacity = 0;
        continue;
      }
      // Pop in with a little overshoot, then shrink a touch while fading.
      const pop = u < 0.15 ? Math.sin((u / 0.15) * Math.PI * 0.5) * 1.18 : 1.18 - 0.18 * Math.min(1, (u - 0.15) / 0.15);
      const s = h.size * pop * (1 - 0.25 * Math.max(0, u - 0.6));
      h.sprite.scale.set(s, s, 1);
      // Rise fast, then slow (ease-out), with a sway.
      const rise = h.vy * h.life * (1 - (1 - u) * (1 - u)) * 0.6 + h.vy * h.t * 0.4;
      h.sprite.position.set(h.x + h.wob * Math.sin(h.ph + h.t * h.wobRate), h.y + rise, h.z);
      h.mat.opacity = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
      h.mat.rotation += Math.sin(h.ph + h.t * h.wobRate) * 0.6 * dt;
      h.sprite.visible = true;
    }
  }

  /** Hide every heart at once (a round starts, the page leaves). */
  clear(): void {
    for (const h of this.pool) {
      h.life = 0;
      h.sprite.visible = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const h of this.pool) h.mat.dispose();
    this.texture.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

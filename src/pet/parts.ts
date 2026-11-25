import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry, texture and material builders shared by the pets (Hopper and the
 * Vizsla): eyes with lids, nose leather, whiskers, skinned tubes, and the
 * procedural textures.
 */
// ---------------------------------------------------------------------------
// Geometry & texture builders

export const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/**
 * Spherical cap facing +Z covering polar angle [0, frac·π/2], with planar
 * UVs (so a radial texture maps onto it as an iris).
 */
export function capGeometry(r: number, frac: number, uv: boolean): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 32, 10, 0, Math.PI * 2, 0, (Math.PI / 2) * frac);
  g.rotateX(Math.PI / 2);
  if (uv) {
    const pos = g.attributes.position, uvs = g.attributes.uv;
    const rm = r * Math.sin((Math.PI / 2) * frac);
    for (let i = 0; i < pos.count; i++) uvs.setXY(i, pos.getX(i) / (2 * rm) + 0.5, pos.getY(i) / (2 * rm) + 0.5);
  }
  return g;
}

/**
 * Nose leather (unit size), facing +Z: a soft rounded triangle, broad on top,
 * with two comma-shaped nostrils curling out at the lower sides and a little
 * groove down the middle into the philtrum. Vertex colours darken the nostrils
 * and the groove.
 */
export function noseGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 56, 36);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const front = smooth(z / 0.6);
    // Nostrils: an indent at the lower sides, curving up and outwards like a comma.
    let nost = 0;
    for (const sx of [-1, 1]) {
      const dx = x - sx * 0.4, dy = y + 0.42 - 0.45 * Math.max(0, x * sx - 0.4);
      nost = Math.max(nost, Math.exp(-(dx * dx) / 0.035 - (dy * dy) / 0.014) * front);
    }
    const groove = Math.exp(-(x * x) / 0.006) * smooth((-0.3 - y) / 0.4) * front;
    // Narrower towards the bottom, a slightly flat top, a little bulge forward.
    x *= 0.72 + 0.38 * smooth((y + 1) / 2);
    y = y > 0 ? y * 0.8 : y;
    z *= (1 + 0.25 * Math.max(0, -y)) * (1 - 0.5 * nost - 0.15 * groove);
    pos.setXYZ(i, x, y, z);
    // Darker in the nostrils and groove, slightly lighter and pinker on the bridge.
    const k = (1 - 0.9 * smooth(nost / 0.45)) * (1 - 0.35 * groove) * (1 + 0.18 * smooth((y - 0.1) / 0.6) * front);
    col.set([k, k * (1 - 0.03 * smooth(y)), k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Fine pebbled bump texture for the nose leather. */
export function pebbleTexture(): THREE.DataTexture {
  return cachedTexture('pebble', () => {
    rng = 11;
    const pts = Array.from({ length: 40 }, () => [rand(), rand()]);
    const t = dataTexture(64, (u, v) => {
      // Cell noise: bright plateaus with dark grooves between neighbouring cells.
      let d1 = 9, d2 = 9;
      for (const [px, py] of pts)
        for (const ox of [-1, 0, 1])
          for (const oy of [-1, 0, 1]) {
            const d = Math.hypot(u - px - ox, (v - py - oy) * 1.3);
            if (d < d1) [d1, d2] = [d, d1];
            else if (d < d2) d2 = d;
          }
      const k = smooth((d2 - d1) / 0.07);
      return [k, k, k, 1];
    });
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** A soft-edged window-shaped catchlight (white, alpha = shape). */
export function catchlightTexture(): THREE.DataTexture {
  return cachedTexture('catch', () =>
    dataTexture(64, (u, v) => {
      // A rounded rectangle: the reflection of a bright window.
      const x = Math.abs(u * 2 - 1) / 0.82, y = Math.abs(v * 2 - 1) / 0.66;
      const d = Math.pow(Math.pow(x, 4) + Math.pow(y, 4), 0.25);
      return [1, 1, 1, 1 - smooth((d - 0.82) / 0.2)];
    }),
  );
}

/**
 * Whiskers: thin tapered hairs fanning out of the whisker pads, curving
 * gently down at the tips. Returns one merged geometry per side (pet space).
 */
export function whiskerGeometry(roots: THREE.Vector3[], s: number, color: THREE.Color): THREE.BufferGeometry {
  const parts = roots.map((p0, q) => {
    const fan = 0.22 - q * 0.2;
    const L = [0.046, 0.054, 0.044][q % 3];
    const dir = new THREE.Vector3(s, fan, 0.42 - q * 0.08).normalize();
    const pts = [p0, p0.clone().addScaledVector(dir, L * 0.5).add(new THREE.Vector3(0, 0.003, 0)), p0.clone().addScaledVector(dir, L).add(new THREE.Vector3(0, -0.004, -0.004 * q))];
    return tubeGeometry(pts, [0, 0, 0], (t) => THREE.MathUtils.lerp(0.0005, 0.00012, t), (t) => color.clone().multiplyScalar(0.85 + 0.15 * t), 5, 24);
  });
  return mergeGeometries(parts);
}

/** Per-eye iris material that paints a round pupil of adjustable size. */
export function pupilIrisMaterial(base: THREE.MeshStandardMaterial, depth: number): THREE.MeshStandardMaterial {
  const mat = base.clone();
  const uPupil = { value: 0.37 };
  mat.userData.pupil = uPupil;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPupil = uPupil;
    shader.uniforms.uIrisDepth = { value: depth };
    // Parallax: the iris is painted on the cap but looked up as if it sat
    // deeper in the eye, so it shifts under the cornea and its highlights as
    // the view changes, the way a real iris does.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vIrisView;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvIrisView = position - (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uPupil;\nuniform float uIrisDepth;\nvarying vec3 vIrisView;').replace(
      '#include <map_fragment>',
      `vec3 ivd = normalize(vIrisView);
      vec2 iuv = vMapUv + ivd.xy / max(0.35, -ivd.z) * uIrisDepth;
      diffuseColor *= texture2D(map, iuv);
      float pr = length(iuv * 2.0 - 1.0);
      // Pupil with a soft, slightly darker-than-iris rim.
      diffuseColor.rgb *= 1.0 - 0.35 * smoothstep(uPupil + 0.09, uPupil, pr);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.01, 0.012, 0.018), 1.0 - smoothstep(uPupil - 0.02, uPupil + 0.012, pr));
      // The brow and upper lid shade the top of the eye, so it sits in its socket.
      diffuseColor.rgb *= mix(1.0, 0.55, smoothstep(0.5, 0.98, vMapUv.y));`,
    );
  };
  mat.customProgramCacheKey = () => 'iris-pupil-parallax';
  return mat;
}

/** Procedural textures are shared by every pet that needs the same one (they're never disposed). */
const textureCache = new Map<string, THREE.DataTexture>();
const cachedTexture = (key: string, make: () => THREE.DataTexture) => {
  let t = textureCache.get(key);
  if (!t) textureCache.set(key, (t = make()));
  return t;
};

let rng = 1;
const rand = () => ((rng = (rng * 16807) % 2147483647) - 1) / 2147483646;

export function dataTexture(size: number, fn: (u: number, v: number) => [number, number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const c = fn((i + 0.5) / size, (j + 0.5) / size);
      const o = (j * size + i) * 4;
      for (let q = 0; q < 4; q++) data[o + q] = Math.max(0, Math.min(255, Math.round(c[q] * 255)));
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
export function irisTexture(hex: number, gain = 1): THREE.DataTexture {
  return cachedTexture(`iris${hex}${gain === 1 ? '' : `x${gain}`}`, () => makeIrisTexture(hex, gain));
}

/** `gain` lifts the iris's lightness (a small eye needs a lighter iris to show its colour). */
export function makeIrisTexture(hex: number, gain = 1): THREE.DataTexture {
  rng = 7;
  // Vivid, light irises read as friendly; the dark eye colour only tints them.
  const hsl = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 });
  const deep = new THREE.Color().setHSL(hsl.h + 0.03, Math.min(1, hsl.s * 0.9), 0.13 * gain);
  const base = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 0.8), 0.33 * gain);
  const light = new THREE.Color().setHSL(hsl.h - 0.03, Math.min(1, hsl.s * 0.75), Math.min(0.8, 0.52 * gain));
  // Warm amber pupillary zone (like a hazel eye) behind the collarette.
  const warm = base.clone().lerp(new THREE.Color(0xc98b3a), 0.75);
  const ring = light.clone().lerp(warm, 0.4);
  const limbal = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 0.8), 0.07);
  const A = Array.from({ length: 96 }, () => rand()), B = Array.from({ length: 240 }, () => rand());
  const wob = Array.from({ length: 12 }, () => rand());
  const crypts = Array.from({ length: 14 }, () => [rand(), 0.6 + rand() * 0.22, 0.02 + rand() * 0.03]);
  const ang = (arr: number[], a: number) => {
    const k = a * arr.length, k0 = Math.floor(k) % arr.length, k1 = (k0 + 1) % arr.length;
    return arr[k0] + (arr[k1] - arr[k0]) * smooth(k - Math.floor(k));
  };
  const c = new THREE.Color();
  return dataTexture(160, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const r = Math.hypot(x, y);
    const a = (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1;
    // Fibres wander a little as they run outwards.
    const aw = (a + 0.012 * Math.sin(r * 17 + a * 40) + 1) % 1;
    const fib = 0.6 * ang(A, aw) + 0.4 * ang(B, (aw + 0.13 * r) % 1);
    // Collarette: a bright zig-zag ring a little outside the pupil.
    const rc = 0.5 + 0.035 * Math.sin(a * Math.PI * 2 * 11 + ang(wob, a) * 6);
    c.copy(deep).lerp(base, 0.55 + 0.45 * fib);
    // Patchy, not a flat colour: a few soft sectors drift warmer or cooler.
    c.offsetHSL(0.035 * (ang(wob, (a + 0.31) % 1) - 0.5), 0, 0.03 * (ang(wob, (a + 0.67) % 1) - 0.5));
    // Lighter fibres catch the light, most of all low in the iris where light pools.
    c.lerp(light, Math.pow(fib, 2.2) * (0.35 + 0.5 * smooth((0.25 - y) / 1.2)) * smooth((r - 0.45) / 0.2));
    // Pupillary zone.
    c.lerp(warm, 0.85 * (1 - smooth((r - rc + 0.02) / 0.12)) * (0.7 + 0.3 * fib));
    c.lerp(ring, 0.45 * Math.exp(-Math.pow((r - rc) / 0.025, 2)));
    // Crypts: small dark pits in the ciliary zone.
    if (r > 0.45 && r < 0.95)
    for (const [ca, cr, cs] of crypts) {
      let da = Math.abs(a - ca);
      da = Math.min(da, 1 - da) * Math.PI * 2 * r;
      if (da > cs * 3 || Math.abs(r - cr) > cs * 5) continue;
      const k = Math.exp(-(da * da) / (cs * cs * 0.6) - Math.pow((r - cr) / (cs * 1.6), 2));
      c.multiplyScalar(1 - 0.45 * k);
    }
    // Furrows: faint concentric rings in the outer iris.
    c.multiplyScalar(1 - 0.12 * Math.pow(Math.max(0, Math.sin(r * 55)), 8) * smooth((r - 0.62) / 0.1));
    // The upper lid shades the top of the iris.
    c.multiplyScalar(0.62 + 0.38 * smooth((0.8 - y) / 0.75));
    // Dark limbal ring, soft on the inside, and dark beyond the rim (seen through the parallax).
    c.lerp(limbal, Math.min(1, smooth((r - 0.8) / 0.17)));
    return [c.r, c.g, c.b, 1];
  });
}

/**
 * Eyelid shell: the top half of a sphere, vertex-coloured darker towards the
 * lash line, with a `furLen` attribute so fur shells can grow on it.
 */
export function lidGeometry(r: number, colorAt: (p: THREE.Vector3) => THREE.Color, arch: number, faceDir: THREE.Vector3, lower = false, furLen = 0.0058): THREE.BufferGeometry {
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
    // Shade the lid more like the face around it than like a ball: its normals
    // lean towards the way the face points while the eye is shut, so a closed
    // lid doesn't light up as a separate dome.
    const nn = v.clone().lerp(faceDir, lower ? 0.6 * smooth((1 - rimT[i]) / 0.15) : 0.55 * smooth((1 - rimT[i]) / 0.5)).normalize();
    g.attributes.normal.setXYZ(i, nn.x, nn.y, nn.z);
    // A soft fold a little above the lash line and a plump lid margin below it,
    // so a closed lid reads as a lid and not as a smooth dome.
    const crease = Math.exp(-Math.pow((rimT[i] - 0.6) / 0.08, 2));
    v.multiplyScalar(r * (1 - 0.02 * crease + 0.025 * smooth((rimT[i] - 0.7) / 0.2) * (1 - smooth((rimT[i] - 0.94) / 0.06))));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const col = new Float32Array(pos.count * 3), fl = new Float32Array(pos.count);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // 1 on top of the lid, 0 at the lash line. A raised lower lid shows mostly
    // its margin, so it only darkens right at the lash line and has no fold.
    const k = smooth((1 - rimT[i]) / (lower ? 0.1 : 0.35));
    const crease = lower ? 0 : Math.exp(-Math.pow((rimT[i] - 0.6) / 0.06, 2));
    c.copy(colorAt(v.fromBufferAttribute(pos, i))).multiplyScalar((0.72 + 0.28 * k) * (1 - 0.3 * crease));
    col.set([c.r, c.g, c.b], i * 3);
    fl[i] = furLen * (0.3 + 0.7 * k) * (1 - 0.6 * crease);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('furLen', new THREE.BufferAttribute(fl, 1));
  return g;
}

/**
 * A tiny milk-tooth fang hanging from the lip line: flattened front to back,
 * rounded at the tip and curving slightly inwards, instead of a sharp cone.
 */
export function fangGeometry(): THREE.BufferGeometry {
  const L = 0.0033, W = 0.00135;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    // Wide at the gum, tapering, with a round (not pointed) end.
    pts.push(new THREE.Vector2(W * Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.4))) * (1 - 0.25 * t), -L * t));
  }
  pts.push(new THREE.Vector2(0, -L));
  pts.reverse();
  const g = new THREE.LatheGeometry(pts, 10);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = -pos.getY(i) / L;
    // Flatten front-to-back and hook the tip slightly towards the mouth's centre.
    pos.setZ(i, pos.getZ(i) * 0.6);
    pos.setX(i, pos.getX(i) - 0.0005 * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** A point on a lid's (arched) lash line at azimuth phi (0 = front, +X = π/2). */
export function lidRimPoint(r: number, arch: number, phi: number): THREE.Vector3 {
  const t2 = (Math.PI / 2) * (1 + (arch * Math.pow(Math.max(0, Math.cos(phi)), 2)) / (Math.PI / 2));
  return new THREE.Vector3(Math.sin(t2) * Math.sin(phi), Math.cos(t2), Math.sin(t2) * Math.cos(phi)).multiplyScalar(r);
}

/** `n` copies of a geometry tagged with shell heights 1/n..1, for single-draw fur shells. */
export function shellStack(geo: THREE.BufferGeometry, n: number): THREE.BufferGeometry {
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
export function scleraMaterial(skin: THREE.Color, apertureX = 0.88, apertureY = 1.3): THREE.MeshPhysicalMaterial {
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
      float ap = length(vec2(en.x / ${apertureX === 0.88 ? '0.88' : apertureX.toFixed(4)}, en.y / ${apertureY === 1.3 ? '1.3' : apertureY.toFixed(4)}));
      float inside = (1.0 - smoothstep(0.92, 0.99, ap)) * smoothstep(-0.1, 0.15, en.z);
      diffuseColor.rgb *= mix(vec3(0.6, 0.62, 0.72), vec3(1.0), smoothstep(1.0, 0.5, ap));
      // Shadow of the brow and upper lid across the top of the ball.
      diffuseColor.rgb *= mix(1.0, 0.6, smoothstep(0.3, 0.9, en.y));
      vec3 skinC = uSkin * mix(0.38, 0.85, smoothstep(0.98, 1.2, ap));
      diffuseColor.rgb = mix(skinC, diffuseColor.rgb, inside);`,
    );
  };
  mat.customProgramCacheKey = () => (apertureX === 0.88 && apertureY === 1.3 ? 'sclera-aperture' : `sclera-aperture-${apertureX}-${apertureY}`);
  return mat;
}

/** Lip-line patch size and bottom edge (m, mouth frame). */
export const MOUTH_W = 0.027, MOUTH_H = 0.0145, MOUTH_Y0 = -0.0085;

/**
 * The "ω" lip line: two arcs meeting under the nose plus the philtrum,
 * thicker in the middle and fading to fine points at the corners, which tuck
 * up a little; a faint wide shadow around the crease. White RGB (the material
 * colours it), alpha = ink.
 */
export function lipLineTexture(): THREE.DataTexture {
  return cachedTexture('lipline', () =>
    dataTexture(256, (u, v) => {
      const X = (u - 0.5) * MOUTH_W, Y = MOUTH_Y0 + v * MOUTH_H;
      let d = Infinity, w = 0.0007;
      for (const c of [-0.0055, 0.0055]) {
        // Lower half circle of each arc, plus a short upturned tail at the corner.
        const ang = Math.atan2(Y, X - c);
        if (ang <= 0) {
          const dd = Math.abs(Math.hypot(X - c, Y) - 0.0056);
          if (dd < d) {
            d = dd;
            // Thick at the centre, thin at the corners.
            const out = Math.abs(X) / 0.0111;
            w = 0.0008 * (1 - 0.5 * smooth((out - 0.6) / 0.4));
          }
        } else {
          const ex = c + Math.sign(c) * 0.0056;
          const dd = Math.hypot(X - ex - Math.sign(c) * 0.0004 * smooth(Y / 0.0012), Math.max(0, Y - 0.0012) * 3 + Math.min(0, Y) * 3);
          if (dd < d) {
            d = dd;
            w = 0.00032 * (1 - smooth(Y / 0.0012));
          }
        }
      }
      // Philtrum: fades towards the nose.
      if (Y > 0 && Y < 0.0055) {
        const dd = Math.abs(X);
        if (dd < d) {
          d = dd;
          w = 0.00045 * (1 - smooth((Y - 0.002) / 0.0035));
        }
      }
      const ink = 1 - smooth((d - w * 0.6) / Math.max(1e-5, w * 0.8));
      const shadow = 0.22 * (1 - smooth(d / 0.0016)) * (Y < 0.0005 ? 1 : 0.4);
      return [1, 1, 1, Math.min(1, ink + shadow)];
    }),
  );
}

/** Painted open-mouth cavity: dark palate, tongue with a groove, two tiny fangs, lip rim. */
export function mouthTexture(): THREE.DataTexture {
  return cachedTexture('mouth', () => makeMouthTexture());
}

export function makeMouthTexture(): THREE.DataTexture {
  const c = new THREE.Color(), deep = new THREE.Color(0.16, 0.03, 0.06), warm = new THREE.Color(0.5, 0.13, 0.19);
  const tmp = new THREE.Color();
  const tongue = new THREE.Color(1.0, 0.52, 0.58), lip = new THREE.Color(0.34, 0.11, 0.16), tooth = new THREE.Color(0.98, 0.96, 0.92);
  return dataTexture(128, (u, v) => {
    const x = u * 2 - 1, y = v * 2 - 1;
    const r = Math.hypot(x, y);
    c.copy(deep).lerp(warm, 0.85 * smooth((0.2 - y) / 1.2));
    // Tongue: a soft mound at the bottom, lit on top, with a centre groove.
    const tx = x / 0.72, ty = (y + 0.66) / 0.52;
    const tr = Math.hypot(tx, ty);
    if (tr < 1.05) {
      const t = tmp.copy(tongue).multiplyScalar(0.72 + 0.32 * smooth((ty + 0.2) / 1.1));
      t.multiplyScalar(1 - 0.22 * (1 - smooth(Math.abs(x) / 0.07)) * smooth((ty + 0.6) / 0.6));
      c.lerp(t, smooth((1.05 - tr) / 0.14));
    }
    // Two little fangs hanging from the upper lip.
    for (const sx of [-0.4, 0.4]) {
      const h = (0.86 - y) / 0.34; // 0 at the gum, 1 at the tip
      if (h > 0 && h < 1) {
        const w = 0.12 * (1 - h);
        c.lerp(tmp.copy(tooth).multiplyScalar(0.82 + 0.18 * (1 - h)), smooth((w - Math.abs(x - sx)) / 0.03));
      }
    }
    // Depth: the upper lip shades the top of the cavity, the sides fall away into the throat's shadow.
    c.multiplyScalar(1 - 0.4 * smooth((y - 0.2) / 0.6));
    c.multiplyScalar(0.72 + 0.28 * (1 - smooth((Math.abs(x) - 0.45) / 0.45)));
    // Lip rim, fading out into the fur.
    c.lerp(lip, smooth((r - 0.8) / 0.16));
    return [c.r, c.g, c.b, 1 - smooth((r - 0.9) / 0.1)];
  });
}

/** Little curved, ridged horn (local +Y up, curving back towards -Z), dark at the root, cream at the tip. */
export function hornGeometry(root: THREE.Color, tip: THREE.Color): THREE.BufferGeometry {
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
export function radialTexture(): THREE.DataTexture {
  return cachedTexture('radial', () => makeRadialTexture());
}

export function makeRadialTexture(): THREE.DataTexture {
  return dataTexture(64, (u, v) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    return [1, 1, 1, Math.pow(Math.max(0, 1 - r), 1.6)];
  });
}

/** Wing membrane: translucent, with veins radiating from the root, a crossing vein and a darker rim (alpha in A). */
export function wingTexture(vein: THREE.Color): THREE.DataTexture {
  return cachedTexture(`wing${vein.getHex()}`, () => makeWingTexture(vein));
}

export function makeWingTexture(vein: THREE.Color): THREE.DataTexture {
  rng = 5;
  const c = new THREE.Color();
  const veinC = vein.clone().lerp(new THREE.Color(1, 1, 1), 0.1);
  const white = new THREE.Color(1, 1, 1);
  const stigma = veinC.clone().multiplyScalar(0.7);
  // Jittered grid of cell centres for the fine venation between the main veins.
  const G = 10;
  const cells = Array.from({ length: G * G }, () => [rand(), rand()]);
  return dataTexture(160, (u, v) => {
    const a = Math.atan2(v - 0.5, u + 0.02);
    const d = Math.hypot(u, v - 0.5);
    // Main veins radiate from the root and fade towards the tip; one curved cross vein.
    const radial = Math.pow(Math.max(0, 1 - Math.abs(Math.sin(a * 7)) / 0.09), 1.5) * smooth((0.95 - d) / 0.4);
    const cross = Math.max(0, 1 - Math.abs(d - 0.45 - 0.05 * Math.sin(a * 5)) / 0.014);
    // Fine venation: the edges of a cell network, like a dragonfly's wing.
    let d1 = 9, d2 = 9;
    const gi = Math.floor(u * G), gj = Math.floor(v * G);
    for (let oi = -1; oi <= 1; oi++)
      for (let oj = -1; oj <= 1; oj++) {
        const ci = gi + oi, cj = gj + oj;
        const cell = cells[(((cj % G) + G) % G) * G + (((ci % G) + G) % G)];
        const dd = Math.hypot(u - (ci + 0.15 + 0.7 * cell[0]) / G, (v - (cj + 0.15 + 0.7 * cell[1]) / G) * 1.2);
        if (dd < d1) [d1, d2] = [dd, d1];
        else if (dd < d2) d2 = dd;
      }
    const fine = (1 - smooth((d2 - d1) / 0.018)) * smooth((d - 0.12) / 0.2);
    const k = Math.min(1, radial + cross);
    // Membrane: richer colour at the root, lighter and more see-through towards
    // the edge, with a darker rim so the outline reads against any background.
    c.setRGB(0.72, 0.72, 0.72).lerp(white, smooth(d / 0.9));
    // Each cell is a slightly different thickness, so the membrane shimmers unevenly.
    c.multiplyScalar(0.94 + 0.08 * ((d1 * 37.1) % 1));
    const rim = smooth((d - 0.78) / 0.2);
    c.lerp(veinC, Math.min(1, k * 0.9 + rim * 0.35 + fine * 0.45));
    // A small dark pterostigma near the tip of the fore-lobe.
    const ptero = 0.7 * (1 - smooth((Math.hypot((u - 0.84) / 2.2, v - 0.66) - 0.016) / 0.012));
    c.lerp(stigma, 0.85 * ptero);
    return [c.r, c.g, c.b, Math.min(1, 0.4 + 0.45 * k + 0.22 * fine + 0.25 * (1 - smooth(d / 0.35)) + 0.25 * rim + 0.5 * ptero)];
  });
}

/**
 * A tapered tube through `pts`, with rounded closed ends. Segment s (from
 * pts[s] to pts[s+1]) is driven by bones[s]; rings blend between adjacent
 * bones near the joints.
 */
export function tubeGeometry(
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
export function wingGeometry(s: number): THREE.BufferGeometry {
  // A long, slender fore-wing with a rounded tip, and a smaller hind-wing
  // swept back below it (two separate membranes, like a lacewing's).
  const fore = new THREE.Shape();
  fore.moveTo(0, 0.002);
  fore.bezierCurveTo(0.025, 0.021, 0.074, 0.03, 0.103, 0.016);
  fore.bezierCurveTo(0.113, 0.009, 0.104, -0.003, 0.084, -0.004);
  fore.bezierCurveTo(0.055, -0.006, 0.022, -0.004, 0, -0.002);
  const hind = new THREE.Shape();
  hind.moveTo(0.002, -0.004);
  hind.bezierCurveTo(0.022, -0.008, 0.05, -0.013, 0.069, -0.024);
  hind.bezierCurveTo(0.077, -0.03, 0.068, -0.041, 0.052, -0.039);
  hind.bezierCurveTo(0.032, -0.036, 0.012, -0.02, 0.002, -0.006);
  const geo = new THREE.ShapeGeometry([fore, hind], 16);
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

export type EyeMats = Record<'sclera' | 'irisMat' | 'pupilMat' | 'corneaMat' | 'shineMat' | 'lidMat' | 'lowerLidMat' | 'lashMat' | 'tearMat', THREE.Material>;

export interface LidOptions {
  upper: THREE.Color;
  lower: THREE.Color;
  /** Baked coat colour (with the socket liner removed) at a pet-space point, so lids continue the face's colouring. */
  skinColor?: (p: THREE.Vector3) => THREE.Color;
  fur: THREE.Material;
  shells: number;
}

export interface EyeConfig {
  head: THREE.Bone;
  /** The head bone's rest position (pet space). */
  headAbs: THREE.Vector3;
  /** Eye centre (pet space) and eyeball radius. */
  center: [number, number, number];
  radius: number;
  /** Tipped up (negative) and splayed outward (radians, mirrored for the right eye). */
  pitch: number;
  splay: number;
  /** Eyeball proportions: the ball is spherical inside a scaled group. */
  scale: [number, number, number];
  /** Signed distance to the sculpted skin (for the tear line). */
  skinDistance: (x: number, y: number, z: number) => number;
  mats: EyeMats;
  lid: LidOptions;
  /** Polar extent of the iris cap (fraction of a quarter turn; a bigger iris shows less white). */
  irisFrac?: number;
  /** Flicked lashes at the outer corner. */
  lashes?: boolean;
  /** Fur length on the lids (m). */
  lidFur?: number;
  /** Slant: how far the outer corner sits above the inner one (radians; default level). */
  slant?: number;
  /** Size of the painted catchlights relative to Hopper's (default 1). */
  shine?: number;
}

/**
 * One eye, attached to the head bone: eyeball with an almond aperture, a
 * rotating iris with a painted pupil, cornea, catchlights, a wet tear line,
 * and furry upper and lower lids hinged at the corners. Sizes follow the eye
 * radius (Hopper's 23.5 mm eye is the reference).
 */
export function buildEye(side: 'L' | 'R', cfg: EyeConfig): { eye: THREE.Group; iris: THREE.Group; up: THREE.Mesh; lo: THREE.Mesh } {
  const { head: headBone, mats: m, lid, skinDistance } = cfg;
  const R = cfg.radius;
  // Absolute detail sizes (lash thickness, tear film) scale with the eye.
  const K = R / 0.0235;
  const [sx, sy, sz] = cfg.scale;
  // Lid shell radius (eye radii): clear of the cornea and catchlights (which reach ~1.05).
  const LID_R = 1.07;
  const s = side === 'L' ? 1 : -1;
  const eye = new THREE.Group();
  eye.name = `eye${side}`;
  eye.position.copy(new THREE.Vector3(...cfg.center).sub(cfg.headAbs));
  // Splayed a little outward and tipped up: big eyes that look *at* you.
  eye.rotation.set(cfg.pitch, s * cfg.splay, s * (cfg.slant ?? 0));
  headBone.add(eye);
  // Everything inside the eye is spherical; the group's scale makes it a
  // tall oval, so the iris can rotate without poking through the white.
  // Shallow in depth, so in profile it doesn't bulge out of the face.
  eye.scale.set(sx, sy, sz);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 24), m.sclera);
  eye.add(ball);
  const iris = new THREE.Group();
  eye.add(iris);
  // Lifted just enough off the eyeball not to z-fight at its rim (a polygon
  // offset would push it through closed lids at grazing angles).
  const irisCap = new THREE.Mesh(capGeometry(R * 1.006, cfg.irisFrac ?? 0.6, true), pupilIrisMaterial(m.irisMat as THREE.MeshStandardMaterial, 0.085));
  iris.add(irisCap);
  // The pupil is painted by the iris shader; this node only carries its size
  // (the Animator scales it), read back just before the iris draws.
  const pupil = new THREE.Object3D();
  pupil.name = 'pupil';
  iris.add(pupil);
  irisCap.onBeforeRender = () => {
    (irisCap.material as THREE.MeshStandardMaterial).userData.pupil.value = 0.5 * pupil.scale.x;
  };
  // Cornea: a clear glossy dome that catches the environment.
  const cornea = new THREE.Mesh(capGeometry(R * 1.025, 0.75, false), m.corneaMat);
  cornea.renderOrder = 40;
  eye.add(cornea);
  // Painted catchlights don't rotate with the iris: that's what makes eyes read as wet.
  for (const [x, y, r] of [
    [-0.32, 0.36, 0.23],
    [0.3, -0.32, 0.09],
  ]) {
    const shine = new THREE.Mesh(new THREE.PlaneGeometry(R * r * 2 * (cfg.shine ?? 1), R * r * 2 * (cfg.shine ?? 1)), m.shineMat);
    const dir = new THREE.Vector3(x * s, y, Math.sqrt(Math.max(0, 1 - x * x - y * y)));
    shine.position.copy(dir).multiplyScalar(R * 1.035);
    shine.lookAt(shine.position.clone().multiplyScalar(2));
    shine.renderOrder = 41;
    eye.add(shine);
  }
  // Moist lower-lid line: a thin wet rim of tear film where the eyeball meets
  // the skin along the bottom of the eye (found by walking back over the
  // ball until it dips under the sculpted skin). It catches a sharp highlight
  // and sits the eye *in* the face.
  {
    const toPet = new THREE.Matrix4().compose(new THREE.Vector3(...cfg.center), new THREE.Quaternion().setFromEuler(eye.rotation), eye.scale);
    const pts: THREE.Vector3[] = [];
    const q = new THREE.Vector3();
    for (let k = 0; k <= 16; k++) {
      const phi = -Math.PI * (0.12 + 0.76 * (k / 16));
      let t = 0.2;
      for (; t < 1.9; t += 0.02) {
        q.set(Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), Math.cos(t)).multiplyScalar(R).applyMatrix4(toPet);
        if (skinDistance(q.x, q.y, q.z) < 0) break;
      }
      t -= 0.07;
      pts.push(new THREE.Vector3(Math.sin(t) * Math.cos(phi), Math.sin(t) * Math.sin(phi), Math.cos(t)).multiplyScalar(R * 1.012));
    }
    const tear = new THREE.Mesh(tubeGeometry(pts, [0], (u) => 0.0008 * K * (0.35 + 0.65 * Math.sin(Math.PI * u)), () => new THREE.Color(1, 1, 1), 6, 48), m.tearMat);
    tear.name = 'tearLine';
    tear.renderOrder = 42;
    eye.add(tear);
  }
  // Pose of each lid while shut (the eye sinks and the lids grow a little),
  // used to pick up the surrounding coat colour for every lid vertex.
  const eyeShut = (zs: number) => new THREE.Matrix4().compose(new THREE.Vector3(...cfg.center), new THREE.Quaternion().setFromEuler(eye.rotation), new THREE.Vector3(sx, sy, zs));
  const upShut = eyeShut(sz * 0.58).multiply(new THREE.Matrix4().makeRotationX(0.42)).multiply(new THREE.Matrix4().makeScale(1.08, 1.08, 1.08));
  const loShut = eyeShut(sz * 0.88).multiply(new THREE.Matrix4().makeRotationX(0.02)).multiply(new THREE.Matrix4().makeScale(1.15, -1.15, 1.15));
  const furryLid = (color: THREE.Color, arch: number, faceDir: THREE.Vector3, shutPose: THREE.Matrix4) => {
    const colorAt = lid.skinColor ? (p: THREE.Vector3) => lid.skinColor!(p.clone().applyMatrix4(shutPose)) : () => color;
    const geo = lidGeometry(R * LID_R, colorAt, arch, faceDir, shutPose === loShut, cfg.lidFur ?? 0.0058);
    const mesh = new THREE.Mesh(geo, m.lidMat);
    if (lid.shells > 0) {
      const fur = new THREE.Mesh(shellStack(geo, lid.shells), lid.fur);
      fur.renderOrder = 2;
      mesh.add(fur);
    }
    return mesh;
  };
  const UP_ARCH = 0.2;
  // faceDir: the face's outward direction in each lid's own frame when shut
  // (upper lid rotated down by 0.42; lower lid mirrored and barely rotated).
  const up = furryLid(lid.upper, UP_ARCH, new THREE.Vector3(0, 0.62, 0.79).normalize(), upShut);
  eye.add(up);
  // Lash line along the (curved) lid edge and three flicked lashes at the outer corner.
  const rimPts = Array.from({ length: 25 }, (_, q) => lidRimPoint(R * (LID_R + 0.005), UP_ARCH, -Math.PI * 0.47 + (q / 24) * Math.PI * 0.94));
  const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts), 40, 0.0011 * K, 6), m.lashMat);
  up.add(rim);
  if (cfg.lashes ?? true)
    for (let q = 0; q < 3; q++) {
      const phi = s * (Math.PI / 2 - 0.18 - q * 0.22);
      const lash = new THREE.Mesh(new THREE.ConeGeometry(0.0011 * K, (0.0075 - q * 0.0012) * K, 5), m.lashMat);
      const base = lidRimPoint(R * LID_R, UP_ARCH, phi);
      lash.position.copy(base);
      lash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(base.x, -0.55 * R, base.z).normalize());
      up.add(lash);
    }
  const LO_ARCH = 0.38;
  const lo = furryLid(lid.lower, LO_ARCH, new THREE.Vector3(0, 0.1, 1).normalize(), loShut);
  // A softer lash line defines the lower lid when it rises into a happy squint.
  const loPts = Array.from({ length: 25 }, (_, q) => lidRimPoint(R * (LID_R + 0.002), LO_ARCH, -Math.PI * 0.42 + (q / 24) * Math.PI * 0.84));
  lo.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loPts), 40, 0.0012 * K, 6), m.lashMat));
  lo.scale.set(0.99, -1, 0.99);
  eye.add(lo);
  return { eye, iris, up, lo };
}

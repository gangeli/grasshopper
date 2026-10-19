import * as THREE from 'three';

/**
 * Shell fur. The skinned body is drawn N extra times, each shell pushed out
 * along the rest normal by (furLen × h); a strand pattern discards fragments
 * so fur reads as thousands of tapering hairs. Roots are darker
 * (self-shadowing) and tips catch a little rim light, which is most of what
 * makes it look soft instead of plastic.
 */
export interface FurOptions {
  shells: number;
  /** Strand cells per metre (higher = finer fur). */
  density: number;
  /** Downward droop of tips (fraction of fur length). */
  gravity: number;
  /** Lock (clump) cells per metre: strands gather into locks this size that taper to points. */
  clump: number;
  /** Fur length multiplier (fewer shells → shorter fur, so the layers don't show). */
  lengthScale?: number;
}

/**
 * Thin-skin translucency (ears): light from behind the surface glows through
 * as a warm red-pink, plus a little constant scatter, scaled by the per-vertex
 * `thin` attribute (0 = opaque). Works in any MeshStandardMaterial shader.
 */
export function addTranslucency(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float thin;\nvarying float vThin;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvThin = thin;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vThin;')
    .replace(
      '#include <opaque_fragment>',
      `if (vThin > 0.001) {
        vec3 through = vec3(0.28);
        #if NUM_DIR_LIGHTS > 0
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) through += directionalLights[i].color * pow(max(0.0, dot(-normal, directionalLights[i].direction)), 1.5);
        #endif
        // Thin edges seen at a grazing angle glow a little too.
        float graze = 1.0 - abs(dot(normal, normalize(vViewPosition)));
        vec3 tint = mix(diffuseColor.rgb, vec3(1.0, 0.55, 0.58), 0.8) * vec3(1.0, 0.72, 0.74);
        outgoingLight += vThin * tint * (through * 0.6 + 0.5 * graze * graze);
      }
      #include <opaque_fragment>`,
    );
}

/**
 * Eye-socket fade: the body bakes a dark liner and short fur around the eye
 * sockets (per-vertex `socket` = [rim 0..1, brightness ratio without the
 * liner, brow fill]); a shut eye fills the hollow above it, a "^^" squint the one below.. While the eyes are closed (`uEyeClosed` → 1) the liner fades out
 * and, on fur shells, the short fur grows back over the seam, so a closed lid
 * reads as part of the furry face rather than a goggle in a dark ring.
 * Call after any other color_fragment edits; geometry without the attribute is unaffected.
 */
export function addSocketFade(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> },
  eyeClosed: { value: number },
  eyeFill: { value: number },
  eyeSquint: { value: number },
): void {
  shader.uniforms.uEyeClosed = eyeClosed;
  shader.uniforms.uEyeFill = eyeFill;
  shader.uniforms.uEyeSquint = eyeSquint;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 socket;\nuniform float uEyeClosed;\nuniform float uEyeFill;\nuniform float uEyeSquint;\nvarying float vSocketK;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSocketK = mix(1.0, socket.y > 0.0 ? socket.y : 1.0, uEyeClosed * step(0.001, socket.x));\n// Fill the socket hollow so the lid sits flush in the fur.\ntransformed += normal * (socket.z * uEyeFill * 0.006 + max(0.0, socket.x * socket.x - socket.z) * uEyeSquint * 0.004);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSocketK;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vSocketK;');
}

export const DEFAULT_FUR: FurOptions = { shells: 12, density: 1000, gravity: 0.3, clump: 200 };

/**
 * h is the shell height in (0, 1]. With h < 0 the height comes from a
 * per-vertex `shellH` attribute instead, so several shells can be merged into
 * one geometry and drawn in a single call (used for small rigid parts like eyelids).
 *
 * The coat is groomed rather than a uniform pile: strands gather into locks
 * (clumps a few mm across) that taper to points and vary in length, so the
 * tips break the silhouette into wisps; the shells lean along a per-vertex
 * `flow` direction (combed down the body, back over the head, out along the
 * limbs and tail), and a Kajiya-Kay style highlight runs across the strands.
 */
export function makeFurShellMaterial(h: number, opts: FurOptions, base: THREE.MeshStandardMaterial, eye?: { closed: { value: number }; fill: { value: number }; squint: { value: number } }): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.name = `fur${h.toFixed(2)}`;
  if (h < 0) m.defines = { ...m.defines, SHELL_ATTR: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShellH = { value: h };
    shader.uniforms.uDensity = { value: opts.density };
    shader.uniforms.uClump = { value: opts.clump };
    shader.uniforms.uGravity = { value: opts.gravity };
    shader.uniforms.uLenScale = { value: opts.lengthScale ?? 1 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float furLen;
        #ifdef SHELL_ATTR
        attribute float shellH;
        #else
        attribute vec3 flow;
        #endif
        uniform float uShellH;
        varying float vShellH;
        uniform float uGravity;
        uniform float uLenScale;
        varying vec3 vRest;
        varying float vFurLen;
        varying vec3 vStrand;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef SHELL_ATTR
        float sh = shellH;
        vec3 comb = vec3(0.0);
        #else
        float sh = uShellH;
        // Combed: only the tangential part of the groom direction bends the strands.
        vec3 comb = flow - normal * dot(flow, normal);
        #endif
        vShellH = sh;
        vRest = position;
        float fLen = furLen * uLenScale;
        #ifdef SOCKET_FADE
        // Closed eyes: the trimmed fur around the socket grows back over the lid seam.
        fLen *= mix(1.0, 1.0 / max(0.3, 1.0 - 0.85 * socket.x), uEyeClosed);
        #endif
        vFurLen = fLen;
        // Strands leave the skin, then lay over along the groom; tips droop a little.
        transformed += normal * fLen * sh * 0.8 + comb * fLen * (0.35 * sh + 0.8 * sh * sh);
        transformed.y -= fLen * uGravity * sh * sh;
        vec3 strandObj = normal + comb * (0.3 + 1.3 * sh) - vec3(0.0, 2.0 * uGravity * sh, 0.0);
        #ifdef USE_SKINNING
        strandObj = (skinMatrix * vec4(strandObj, 0.0)).xyz;
        #endif
        vStrand = normalMatrix * strandObj;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uDensity;
        uniform float uClump;
        varying float vShellH;
        #define uShellH vShellH
        varying vec3 vRest;
        varying float vFurLen;
        varying vec3 vStrand;
        vec3 furHash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.xxy + p.yxx) * p.zyx);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Where fur is very short (muzzle, paw pads) the shells just fade out.
        if (vFurLen < 0.0012 && uShellH > 0.25) discard;
        // Locks: nearest centre of three interleaved jittered lattices.
        vec3 qc = vRest * uClump;
        float dc = 9.0;
        vec3 cid = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          vec3 c = qc + vec3(0.271, 0.618, 0.333) * float(i);
          vec3 cell = floor(c) + float(i) * 23.0;
          float d = length(fract(c) - (0.28 + 0.44 * furHash(cell)));
          if (d < dc) { dc = d; cid = cell; }
        }
        vec3 lockRnd = furHash(cid * 1.37 + 5.3);
        // Locks vary in length, so the outline breaks into wisps.
        float hh = uShellH / mix(0.55, 1.0, lockRnd.x);
        if (hh > 1.0) discard;
        float lockR = 0.62 * pow(1.0 - hh, 0.6);
        // Fine strands: round, tapering columns kept inside their cells.
        vec3 q = vRest * uDensity;
        float best = 9.0;
        for (int i = 0; i < 3; i++) {
          vec3 c = q + vec3(0.333, 0.618, 0.271) * float(i);
          vec3 r = 0.36 + 0.28 * furHash(floor(c) + float(i) * 17.0);
          best = min(best, length(fract(c) - r));
        }
        bool strand = best < 0.38 * pow(1.0 - hh, 0.6);
        // Short fur (face, paws) is a fine even velvet; locks form where the coat is long.
        float lockAmt = smoothstep(0.003, 0.01, vFurLen);
        // Solid lock cores, strand-y lock edges, and a dense undercoat near the skin.
        if (!(dc < lockR * 0.58 * lockAmt || (dc < mix(9.0, lockR, lockAmt) && strand) || (hh < 0.28 && strand))) discard;
        // Deep in the coat between locks it is dark; each lock is a slightly different tone.
        float gap = smoothstep(0.25, 1.0, dc / max(lockR, 0.05)) * (0.5 + 0.5 * lockAmt);
        // Dither the root-to-tip ramp a little so few shells don't band.
        float hd = clamp(uShellH + (furHash(floor(vRest * uDensity * 2.0)).x - 0.5) * 0.15, 0.0, 1.0);
        diffuseColor.rgb *= mix(0.45, 1.06, pow(hd, 0.8)) * (1.0 - 0.28 * gap * (1.0 - hh)) * (1.0 + (0.2 * lockRnd.y - 0.1) * lockAmt);
        // Tips a little paler, as if lightly sun-bleached.
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb + (1.0 - diffuseColor.rgb) * 0.2, hh * hh);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `// Strand highlights run across the hairs (Kajiya-Kay): a sharp white one and a broad tinted one.
        {
          vec3 T = normalize(vStrand);
          vec3 Vd = normalize(vViewPosition);
          vec3 kk = vec3(0.0);
          #if NUM_DIR_LIGHTS > 0
          for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
            vec3 L = directionalLights[i].direction;
            float th = dot(T, normalize(L + Vd));
            float s = sqrt(max(0.0, 1.0 - th * th));
            float wrap = clamp(dot(normal, L) * 0.6 + 0.4, 0.0, 1.0);
            kk += directionalLights[i].color * wrap * (0.06 * pow(s, 80.0) + 0.12 * pow(s, 14.0) * diffuseColor.rgb);
          }
          #endif
          outgoingLight += kk * (0.25 + 0.75 * uShellH);
          // Backlit fuzz: strand tips glow a little along the silhouette.
          float furRim = 1.0 - abs(dot(normalize(vNormal), Vd));
          outgoingLight += diffuseColor.rgb * pow(furRim, 3.0) * 0.45 * uShellH;
        }
        #include <opaque_fragment>`,
      );
    if (h >= 0) addTranslucency(shader);
    if (eye) addSocketFade(shader, eye.closed, eye.fill, eye.squint);
  };
  if (eye) m.defines = { ...m.defines, SOCKET_FADE: '' };
  m.customProgramCacheKey = () => `fur2-${opts.lengthScale ?? 1}-${h < 0 ? 'attr' : h.toFixed(3)}-${opts.density}-${opts.clump}-${opts.gravity}${eye ? '-sock' : ''}`;
  return m;
}

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
 * liner, brow fill]). While the eyes are closed (`uEyeClosed` → 1) the liner fades out
 * and, on fur shells, the short fur grows back over the seam, so a closed lid
 * reads as part of the furry face rather than a goggle in a dark ring.
 * Call after any other color_fragment edits; geometry without the attribute is unaffected.
 */
export function addSocketFade(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> },
  eyeClosed: { value: number },
  eyeFill: { value: number },
): void {
  shader.uniforms.uEyeClosed = eyeClosed;
  shader.uniforms.uEyeFill = eyeFill;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 socket;\nuniform float uEyeClosed;\nuniform float uEyeFill;\nvarying float vSocketK;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSocketK = mix(1.0, socket.y > 0.0 ? socket.y : 1.0, uEyeClosed * step(0.001, socket.x));\n// Fill the socket hollow so the lid sits flush in the fur.\ntransformed += normal * (socket.z * uEyeFill * 0.006);');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSocketK;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vSocketK;');
}

export const DEFAULT_FUR: FurOptions = { shells: 12, density: 1000, gravity: 0.35 };

/**
 * h is the shell height in (0, 1]. With h < 0 the height comes from a
 * per-vertex `shellH` attribute instead, so several shells can be merged into
 * one geometry and drawn in a single call (used for small rigid parts like eyelids).
 */
export function makeFurShellMaterial(h: number, opts: FurOptions, base: THREE.MeshStandardMaterial, eye?: { closed: { value: number }; fill: { value: number } }): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.name = `fur${h.toFixed(2)}`;
  if (h < 0) m.defines = { ...m.defines, SHELL_ATTR: '' };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShellH = { value: h };
    shader.uniforms.uDensity = { value: opts.density };
    shader.uniforms.uGravity = { value: opts.gravity };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float furLen;
        #ifdef SHELL_ATTR
        attribute float shellH;
        #endif
        uniform float uShellH;
        varying float vShellH;
        uniform float uGravity;
        varying vec3 vRest;
        varying float vFurLen;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef SHELL_ATTR
        float sh = shellH;
        #else
        float sh = uShellH;
        #endif
        vShellH = sh;
        vRest = position;
        float fLen = furLen;
        #ifdef SOCKET_FADE
        // Closed eyes: the trimmed fur around the socket grows back over the lid seam.
        fLen *= mix(1.0, 1.0 / max(0.3, 1.0 - 0.85 * socket.x), uEyeClosed);
        #endif
        vFurLen = fLen;
        // Push out along the rest normal; tips droop a little (in pet space).
        transformed += normal * fLen * sh;
        transformed.y -= fLen * uGravity * sh * sh;
        #ifndef SHELL_ATTR
        // Combed: on the head fur flows back from the muzzle, on the body it
        // lies down and back. Only the tangential part bends the strands.
        vec3 flow = position.y > 0.19 ? normalize(position - vec3(0.0, 0.225, 0.11)) : normalize(vec3(0.0, -1.0, -0.45));
        flow -= normal * dot(flow, normal);
        transformed += flow * fLen * 0.55 * sh * sh;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uDensity;
        varying float vShellH;
        #define uShellH vShellH
        varying vec3 vRest;
        varying float vFurLen;
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
        // Strands: three interleaved jittered lattices in rest space, each strand
        // a round, tapering column kept inside its cell (so no square clipping).
        vec3 q = vRest * uDensity;
        float best = 9.0;
        for (int i = 0; i < 3; i++) {
          vec3 c = q + vec3(0.333, 0.618, 0.271) * float(i);
          vec3 r = 0.36 + 0.28 * furHash(floor(c) + float(i) * 17.0);
          best = min(best, length(fract(c) - r));
        }
        float radius = 0.36 * pow(1.0 - uShellH, 0.7);
        if (best > radius) discard;
        // Root shadowing and slightly lighter, warmer tips.
        diffuseColor.rgb *= mix(0.58, 1.12, uShellH);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `// Backlit fuzz: strand tips glow a little along the silhouette.
        float furRim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
        outgoingLight += diffuseColor.rgb * pow(furRim, 3.0) * 0.45 * uShellH;
        #include <opaque_fragment>`,
      );
    if (h >= 0) addTranslucency(shader);
    if (eye) addSocketFade(shader, eye.closed, eye.fill);
  };
  if (eye) m.defines = { ...m.defines, SOCKET_FADE: '' };
  m.customProgramCacheKey = () => `fur-${h < 0 ? 'attr' : h.toFixed(3)}-${opts.density}-${opts.gravity}${eye ? '-sock' : ''}`;
  return m;
}

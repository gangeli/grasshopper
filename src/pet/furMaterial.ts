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

export const DEFAULT_FUR: FurOptions = { shells: 12, density: 1000, gravity: 0.35 };

/**
 * h is the shell height in (0, 1]. With h < 0 the height comes from a
 * per-vertex `shellH` attribute instead, so several shells can be merged into
 * one geometry and drawn in a single call (used for small rigid parts like eyelids).
 */
export function makeFurShellMaterial(h: number, opts: FurOptions, base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
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
        vFurLen = furLen;
        // Push out along the rest normal; tips droop a little (in pet space).
        transformed += normal * furLen * sh;
        transformed.y -= furLen * uGravity * sh * sh;
        #ifndef SHELL_ATTR
        // Combed: on the head fur flows back from the muzzle, on the body it
        // lies down and back. Only the tangential part bends the strands.
        vec3 flow = position.y > 0.19 ? normalize(position - vec3(0.0, 0.225, 0.11)) : normalize(vec3(0.0, -1.0, -0.45));
        flow -= normal * dot(flow, normal);
        transformed += flow * furLen * 0.55 * sh * sh;
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
  };
  m.customProgramCacheKey = () => `fur-${h < 0 ? 'attr' : h.toFixed(3)}-${opts.density}-${opts.gravity}`;
  return m;
}

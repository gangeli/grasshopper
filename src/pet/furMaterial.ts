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

export function makeFurShellMaterial(h: number, opts: FurOptions, base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.name = `fur${h.toFixed(2)}`;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uShellH = { value: h };
    shader.uniforms.uDensity = { value: opts.density };
    shader.uniforms.uGravity = { value: opts.gravity };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float furLen;
        uniform float uShellH;
        uniform float uGravity;
        varying vec3 vRest;
        varying float vFurLen;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRest = position;
        vFurLen = furLen;
        // Push out along the rest normal; tips droop a little (in pet space).
        transformed += normal * furLen * uShellH;
        transformed.y -= furLen * uGravity * uShellH * uShellH;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uShellH;
        uniform float uDensity;
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
        // Strands: one jittered strand per cell of rest-space, tapering to a point.
        vec3 q = vRest * uDensity;
        vec3 cell = floor(q);
        float best = 9.0;
        for (int i = 0; i < 2; i++) {
          vec3 c = cell + vec3(float(i) * 0.5);
          vec3 r = furHash(floor(c)) ;
          best = min(best, length(fract(c) - r));
        }
        float radius = 0.62 * pow(1.0 - uShellH, 0.75);
        if (best > radius) discard;
        // Root shadowing and slightly lighter, warmer tips.
        diffuseColor.rgb *= mix(0.58, 1.12, uShellH);`,
      );
  };
  m.customProgramCacheKey = () => `fur-${h.toFixed(3)}-${opts.density}-${opts.gravity}`;
  return m;
}

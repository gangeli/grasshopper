/**
 * Minimal in-place radix-2 complex FFT (1D and 2D, square power-of-two
 * sizes), for the relocalizer's translation correlation. Separate real and
 * imaginary Float64Arrays.
 */
const tables = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function table(n: number) {
  let t = tables.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  tables.set(n, t);
  return t;
}

/** In-place FFT of n complex values at re[off + q·stride], im[...]. inverse: unscaled inverse transform. */
export function fft1(re: Float64Array, im: Float64Array, n: number, off: number, stride: number, inverse: boolean): void {
  const { cos, sin, rev } = table(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a];
      re[a] = re[b];
      re[b] = t;
      t = im[a];
      im[a] = im[b];
      im[b] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size)
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sgn * sin[k * step];
        const a = off + (i + k) * stride, b = off + (i + k + half) * stride;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
  }
}

/** 2D FFT of an n×n image (row-major), in place. */
export function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  for (let r = 0; r < n; r++) fft1(re, im, n, r * n, 1, inverse);
  for (let c = 0; c < n; c++) fft1(re, im, n, c, n, inverse);
  if (inverse) {
    const s = 1 / (n * n);
    for (let q = 0; q < n * n; q++) {
      re[q] *= s;
      im[q] *= s;
    }
  }
}

export function nextPow2(v: number): number {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

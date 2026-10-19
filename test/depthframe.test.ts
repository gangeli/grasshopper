import { describe, expect, it } from 'vitest';
import { filterDiscontinuities, depthImageToPoints, PoseGate, type DepthImage } from '../src/world/DepthFrame';

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Inverse projection for a 60° vertical FOV, aspect 1, near 0.1 / far 100.
const t = Math.tan(Math.PI / 6), n = 0.1, f = 100;
const INV_PROJ = [t, 0, 0, 0, 0, t, 0, 0, 0, 0, 0, (n - f) / (2 * f * n), 0, 0, -1, (f + n) / (2 * f * n)];

function image(w: number, h: number, fn: (x: number, y: number) => number): DepthImage {
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) depth[y * w + x] = fn(x, y);
  return { w, h, depth, invProj: INV_PROJ, camToWorld: ID };
}

describe('depth front end', () => {
  it('keeps a floor seen at a glancing angle (depth changes fast but smoothly)', () => {
    // Camera 1.4m above a floor, pitched down: depth along view z for each row.
    const w = 40, h = 30, pitch = 0.35, height = 1.4;
    const img = image(w, h, (_x, y) => {
      const v = 1 - ((y + 0.5) / h) * 2; // +1 top .. -1 bottom
      const ang = pitch - Math.atan(v * t); // angle below horizontal
      if (ang <= 0.02) return 0; // above the horizon: no reading
      const range = height / Math.sin(ang);
      return range * Math.cos(ang - pitch);
    });
    const out = filterDiscontinuities(img);
    let kept = 0, total = 0;
    for (let i = 0; i < out.length; i++) if (img.depth[i] > 0) (total++, out[i] > 0 && kept++);
    expect(kept / total).toBeGreaterThan(0.9);
  });

  it('removes flying pixels at an object silhouette', () => {
    // A box edge at 1m in front of a wall at 3m, with smeared in-between pixels.
    const img = image(20, 10, (x) => (x < 9 ? 1 : x === 9 ? 2 : x === 10 ? 2.6 : 3));
    const out = filterDiscontinuities(img);
    expect(out[5 * 20 + 9]).toBe(0);
    expect(out[5 * 20 + 10]).toBe(0);
    expect(out[5 * 20 + 3]).toBeGreaterThan(0);
    expect(out[5 * 20 + 16]).toBeGreaterThan(0);
  });

  it('unprojects to points at the right distance', () => {
    const img = image(4, 4, () => 2);
    for (const p of depthImageToPoints(img)) expect(p.z).toBeCloseTo(-2, 5);
  });

  it('pose gate rejects frames after a relocalisation jump, accepts smooth motion', () => {
    const g = new PoseGate();
    const f = { x: 0, y: 0, z: -1 };
    let ok = 0;
    for (let i = 0; i < 20; i++) ok += g.accept({ x: i * 0.05, y: 1.4, z: 0 }, f, i * 0.1) ? 1 : 0;
    expect(ok).toBe(20);
    expect(g.accept({ x: 1.0 + 0.15, y: 1.4, z: 0.1 }, f, 2.0)).toBe(false); // 15cm jump
    expect(g.accept({ x: 1.2, y: 1.4, z: 0.1 }, f, 2.1)).toBe(false); // still holding
    expect(g.accept({ x: 1.8, y: 1.4, z: 0.1 }, f, 3.5)).toBe(true);
    expect(g.accept({ x: 1.8, y: 1.4, z: 0.1 }, f, 3.6, true)).toBe(false); // tracking lost
  });
});

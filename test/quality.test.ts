import { describe, expect, it } from 'vitest';
import { QualityGovernor } from '../src/app/Quality';

/** Minimal stand-ins for what the governor touches. */
function targets() {
  const renderer = { shadowMap: { autoUpdate: true, needsUpdate: false }, xr: { isPresenting: true }, setPixelRatio() {} };
  const sun = { shadow: { mapSize: { set() {} }, map: null as { dispose(): void } | null } };
  return { renderer, sun, basePixelRatio: 2 } as unknown as ConstructorParameters<typeof QualityGovernor>[0];
}

/** Run the governor for `seconds`, with frame intervals from `interval(level, i)`. */
function run(g: QualityGovernor, seconds: number, interval: (level: number, i: number) => number) {
  let now = 0, i = 0;
  while (now < seconds * 1000) {
    const dt = interval(g.level, i++);
    now += dt;
    g.update(now, dt);
  }
}

describe('quality governor', () => {
  it('keeps full quality when the AR camera paces frames at 30fps (jittery, no faster at lower quality)', () => {
    const g = new QualityGovernor(targets(), { level: 'auto' });
    // ARCore camera: 33ms frames, with the odd late frame followed by an early one.
    run(g, 60, (_lvl, i) => (i % 9 === 4 ? 45 : i % 9 === 5 ? 22 : 33.3));
    expect(g.level).toBe(0);
  });

  it('steps down when the GPU really is the limit, and holds a level that keeps up', () => {
    const g = new QualityGovernor(targets(), { level: 'auto' });
    // 60Hz display; frame cost falls with quality: 28ms, 22ms, 16ms, 13ms, 11ms.
    const cost = [28, 22, 16, 13, 11];
    run(g, 60, (lvl) => Math.ceil(cost[lvl] / 16.7) * 16.7);
    expect(g.level).toBeGreaterThanOrEqual(2);
    expect(g.level).toBeLessThanOrEqual(3);
  });

  it('stays at full quality on a device that keeps up at 60fps', () => {
    const g = new QualityGovernor(targets(), { level: 'auto' });
    run(g, 60, (_lvl, i) => (i % 50 === 0 ? 33.4 : 16.7));
    expect(g.level).toBe(0);
  });
});

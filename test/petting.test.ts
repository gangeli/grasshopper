import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Petting, PETTING } from '../src/game/Petting';
import { Hearts } from '../src/pet/Hearts';
import { Rng } from '../src/core/rng';

describe('Petting', () => {
  it('the first pet is a "petted" lean with a heart and a purr', () => {
    const p = new Petting(new Rng(1));
    const r = p.pet(0)!;
    expect(r.action).toBe('petted');
    expect(r.sound).toBe('pet');
    expect(r.hearts).toBeGreaterThanOrEqual(1);
    expect(r.big).toBe(false);
  });

  it('happiness builds up: more hearts, then a big celebration, then settles back', () => {
    // An rng that never picks a playful alternative, so the build-up is exact.
    const p = new Petting({ next: () => 0.99 });
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(p.pet(i * 0.5)!);
    expect(rs.slice(0, 4).map((r) => r.action)).toEqual(['petted', 'petted', 'petted', 'petted']);
    for (let i = 1; i < 4; i++) expect(rs[i].hearts).toBeGreaterThanOrEqual(rs[i - 1].hearts);
    expect(rs[3].hearts).toBeGreaterThan(rs[0].hearts);
    // A happy "love" chirp as it gets close.
    expect(rs[3].sound).toBe('love');
    expect(rs[4].action).toBe('celebrate');
    expect(rs[4].big).toBe(true);
    expect(rs[4].hearts).toBeGreaterThanOrEqual(6);
    expect(rs[5].action).toBe('petted');
    expect(rs[5].happiness).toBeCloseTo(PETTING.afterBig + PETTING.tapGain);
  });

  it('double taps and strokes between beats do not count', () => {
    const p = new Petting(new Rng(2));
    expect(p.pet(1)).not.toBeNull();
    expect(p.pet(1.05)).toBeNull();
    expect(p.pet(1.3, true)).toBeNull();
    expect(p.pet(1 + PETTING.strokeInterval + 0.01, true)).not.toBeNull();
  });

  it('happiness fades when nobody pets Hopper', () => {
    const p = new Petting({ next: () => 0.99 });
    p.pet(0);
    p.pet(0.5);
    const h = p.happiness;
    let t = 0.5;
    for (let i = 0; i < 30; i++) p.update(0.1, (t += 0.1));
    expect(p.happiness).toBeLessThan(h);
    for (let i = 0; i < 200; i++) p.update(0.1, (t += 0.1));
    expect(p.happiness).toBe(0);
    expect(p.streak).toBe(0);
  });

  it('playful reactions happen sometimes, never twice in a row, never on the first pet or a stroke', () => {
    const p = new Petting(new Rng(5));
    const acts: string[] = [];
    for (let i = 0; i < 200; i++) {
      const r = p.pet(i * 0.6, i % 7 === 3)!;
      if (r.stroke) expect(['petted', 'celebrate']).toContain(r.action);
      acts.push(r.action);
    }
    expect(acts[0]).toBe('petted');
    const alt = acts.filter((a) => a === 'giggle' || a === 'wave' || a === 'surprised').length;
    expect(alt).toBeGreaterThan(5);
    expect(acts.filter((a) => a === 'petted').length).toBeGreaterThan(alt * 2);
    const isAlt = (a: string) => a === 'giggle' || a === 'wave' || a === 'surprised';
    for (let i = 1; i < acts.length; i++) expect(isAlt(acts[i]) && isAlt(acts[i - 1])).toBe(false);
  });
});

describe('Hearts', () => {
  it('spawns from a fixed pool, floats up, fades out and frees its slots', () => {
    const h = new Hearts(new Rng(3).next.bind(new Rng(3)));
    const parent = new THREE.Group();
    parent.add(h.group);
    const children = h.group.children.length;
    h.spawn({ x: 0, y: 0.3, z: 0 }, 3);
    expect(h.active).toBe(3);
    expect(h.spawned).toBe(3);
    for (let i = 0; i < 10; i++) h.update(1 / 30);
    const shown = h.group.children.filter((c) => c.visible);
    expect(shown.length).toBeGreaterThan(0);
    for (const c of shown) expect(c.position.y).toBeGreaterThan(0.3);
    // Lots of petting never grows the pool.
    for (let i = 0; i < 10; i++) h.spawn({ x: 0, y: 0.3, z: 0 }, 8);
    expect(h.group.children.length).toBe(children);
    expect(h.active).toBe(children);
    // ~1.3 s later they are all gone.
    for (let i = 0; i < 60; i++) h.update(1 / 30);
    expect(h.active).toBe(0);
    expect(h.group.children.every((c) => !c.visible)).toBe(true);
  });

  it('disposes its texture and materials and leaves its parent', () => {
    const h = new Hearts();
    const parent = new THREE.Group();
    parent.add(h.group);
    const sprite = h.group.children[0] as THREE.Sprite;
    const mat = sprite.material;
    const tex = mat.map!;
    let matDisposed = 0, texDisposed = 0;
    mat.addEventListener('dispose', () => matDisposed++);
    tex.addEventListener('dispose', () => texDisposed++);
    h.spawn({ x: 0, y: 0, z: 0 }, 2);
    h.dispose();
    expect(matDisposed).toBe(1);
    expect(texDisposed).toBe(1);
    expect(h.group.parent).toBeNull();
    expect(h.isDisposed).toBe(true);
    // Safe after dispose.
    h.spawn({ x: 0, y: 0, z: 0 }, 2);
    h.update(0.1);
    expect(h.active).toBe(0);
  });

  it('draws a heart: opaque in the middle of the lobes, clear in the corners and the notch', () => {
    const h = new Hearts();
    const tex = (h.group.children[0] as THREE.Sprite).material.map as THREE.DataTexture;
    const { data, width } = tex.image as { data: Uint8Array; width: number };
    const alpha = (u: number, v: number) => data[(Math.floor(v * width) * width + Math.floor(u * width)) * 4 + 3];
    expect(alpha(0.3, 0.65)).toBe(255); // left lobe
    expect(alpha(0.7, 0.65)).toBe(255); // right lobe
    expect(alpha(0.5, 0.3)).toBe(255); // body, toward the tip
    expect(alpha(0.02, 0.02)).toBe(0);
    expect(alpha(0.98, 0.98)).toBe(0);
    expect(alpha(0.5, 0.92)).toBe(0); // the notch between the lobes
    h.dispose();
  });
});

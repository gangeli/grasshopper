import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Frame-time breakdown of the real AR code path (IWER-emulated phone with
 * CPU depth), with the app's own profiler (?perf=1). Opt-in: PERF=1 npx
 * playwright test e2e/perf.spec.ts. Software GL is not a phone GPU, so the
 * numbers to read are the CPU sections (main-thread JS per subsystem),
 * renderer statistics and the fragment-load estimate; GPU time needs a real
 * device. Writes artifacts/perf-<label>.json.
 *
 * PERF_QS adds query parameters (e.g. "&fur=7&lod=" or "&quality=0").
 */
test.skip(!process.env.PERF, 'perf measurement is opt-in (PERF=1)');

type Emu = { setPose(x: number, y: number, z: number, yaw: number, pitch: number): void; select(): Promise<void> };
const ev = <T,>(page: Page, fn: () => T) => page.evaluate(fn);
const setPose = (page: Page, x: number, y: number, z: number, yaw: number, pitch: number) =>
  page.evaluate(([x, y, z, yaw, pitch]) => (window as unknown as { __emu: Emu }).__emu.setPose(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
const phase = (page: Page) => ev(page, () => (window.__hopper?.game as { phase: string }).phase);
type Perf = { reset(): void; summary(): unknown; format(s: unknown): string };
const perfReset = (page: Page) => ev(page, () => ((window.__hopper?.stage as { perf: Perf }).perf.reset()));
const perfSummary = (page: Page) => ev(page, () => (window.__hopper?.stage as { perf: Perf }).perf.summary()) as Promise<Record<string, unknown>>;
const perfText = (page: Page) => ev(page, () => { const p = (window.__hopper?.stage as { perf: Perf }).perf; return p.format(p.summary()); });

test.use({
  // A mid-range Android phone: mobile UA (phone mesh + shell count), phone viewport.
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
});

test('AR frame-time breakdown (emulated phone)', async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync('artifacts', { recursive: true });
  const label = process.env.PERF_LABEL ?? 'ar';
  const qs = process.env.PERF_QS ?? '';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 412, height: 860 });
  await page.goto(`/?emulate=phone&room=living&seed=3&perf=1${qs}`);
  await expect(page.locator('#btn-ar')).toBeVisible({ timeout: 20_000 });
  await page.locator('#btn-ar').click();
  await expect.poll(() => ev(page, () => !!(window.__hopper?.ar as { session: unknown } | undefined)?.session), { timeout: 20_000 }).toBe(true);
  await setPose(page, 0, 1.45, 0.6, 0, -0.9);
  await expect.poll(() => ev(page, () => !!(window.__hopper?.ar as { lastHit: unknown }).lastHit), { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => (window as unknown as { __emu: Emu }).__emu.select());
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('roam');

  const out: Record<string, unknown> = {};
  // Mapping / roaming: turn around slowly, looking down (depth ingestion, nav rebuilds).
  await page.waitForTimeout(1000);
  await perfReset(page);
  for (let a = 0; a < 60; a++) {
    await setPose(page, 0, 1.45, 0.6, (a / 60) * Math.PI * 2, -0.6 + 0.25 * Math.sin(a * 0.5));
    await page.waitForTimeout(200);
  }
  out.roam = await perfSummary(page);
  out.scene = await ev(page, () => {
    const st = window.__hopper?.stage as { scene: { traverseVisible(f: (o: unknown) => void): void } };
    const rows: Record<string, { n: number; tris: number; shadowTris: number }> = {};
    st.scene.traverseVisible((o) => {
      const m = o as { isMesh?: boolean; name: string; castShadow: boolean; geometry: { index: { count: number } | null; attributes: { position?: { count: number } }; drawRange: { count: number } } };
      if (!m.isMesh) return;
      const t = Math.min(m.geometry.drawRange.count, m.geometry.index ? m.geometry.index.count : (m.geometry.attributes.position?.count ?? 0)) / 3;
      const key = /^fur\d+$/.test(m.name) ? 'fur shells' : m.name || '(unnamed)';
      const r = (rows[key] ??= { n: 0, tris: 0, shadowTris: 0 });
      r.n++;
      r.tris += t;
      if (m.castShadow) r.shadowTris += t;
    });
    return rows;
  });
  out.xr = await ev(page, () => {
    const r = (window.__hopper?.stage as { renderer: { xr: { getCamera(): { cameras: unknown[] }; getFramebufferScaleFactor?: () => number }; getDrawingBufferSize(v: unknown): { x: number; y: number } } }).renderer;
    const T = window.__hopper?.THREE as { Vector2: new () => unknown };
    const s = r.getDrawingBufferSize(new T.Vector2());
    return { views: r.xr.getCamera().cameras.length, buffer: [s.x, s.y], dpr: devicePixelRatio };
  });
  console.log(JSON.stringify(out.scene), JSON.stringify(out.xr));
  console.log(`--- ${label}: roam/mapping ---\n${await perfText(page)}`);
  out.navWorkerRoam = await ev(page, () => (window.__hopper?.navWorker as { stats?: unknown } | undefined)?.stats ?? null);
  console.log('nav worker', JSON.stringify(out.navWorkerRoam));

  if (process.env.PERF_SEEK === '0') {
    writeFileSync(`artifacts/perf-${label}.json`, JSON.stringify(out, null, 2));
    return;
  }
  // Seeking: face the pet, start a round, then hold still while it hides.
  const pet = await ev(page, () => (window.__hopper?.stack as { pet: { pos: { x: number; y: number; z: number } } }).pet.pos);
  await setPose(page, 0, 1.45, 0.6, Math.atan2(-pet.x, -(pet.z - 0.6)), -0.7);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Play hide & seek' }).click();
  await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('seek');
  const spot = await ev(page, () => (window.__hopper?.game as { spot: { pos: { x: number; y: number; z: number } } }).spot);
  await perfReset(page);
  for (let a = 0; a < 40; a++) {
    const ang = (a / 40) * Math.PI;
    const x = spot.pos.x + Math.sin(ang) * 1.6, z = spot.pos.z + Math.cos(ang) * 1.6;
    await setPose(page, x, 1.3, z, Math.atan2(-(spot.pos.x - x), -(spot.pos.z - z)), -0.5);
    await page.waitForTimeout(200);
  }
  out.seek = await perfSummary(page);
  console.log(`--- ${label}: seek ---\n${await perfText(page)}`);
  writeFileSync(`artifacts/perf-${label}.json`, JSON.stringify(out, null, 2));
  expect(errors).toEqual([]);
});

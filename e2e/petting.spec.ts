import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Petting Hopper: a tap on Hopper while walking is answered with the happy
 * lean-into-your-hand reaction ('petted': "^^" eyes, blush, relaxed ears),
 * a purr and little hearts floating up; a held press strokes Hopper; repeated
 * pets build up to a celebration hop. Also on the landing page's showcase.
 * Screenshots go to artifacts/petting-*.png.
 */
type V3 = { x: number; y: number; z: number };
type H = {
  THREE: { Vector3: new (x: number, y: number, z: number) => V3 & { project(c: unknown): V3 } };
  stage: { camera: unknown };
  game: { phase: string; pet: { pos: V3 }; petting: { happiness: number; count: number }; anim: { current: string; currentTime: number } };
  sim: { sim: { cam: { yaw: number; pitch: number; pos: V3 } }; ui: { hearts: { active: number; spawned: number } } };
  showcase?: { anim: { current: string; currentTime: number }; hearts: { active: number; spawned: number }; petting: { count: number } };
};
const showcase = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__hopper as unknown as H).showcase;
    return s ? { current: s.anim.current, t: s.anim.currentTime, hearts: s.hearts.active, count: s.petting.count } : null;
  });

async function petOnScreen(page: Page) {
  return page.evaluate(() => {
    const h = window.__hopper as unknown as H;
    const p = h.game.pet.pos;
    const v = new h.THREE.Vector3(p.x, p.y + 0.15, p.z).project(h.stage.camera);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
  });
}

test('virtual room: tap and stroke Hopper — petted reaction with hearts', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?sim=1&room=living&seed=3&lod=low');
  await expect.poll(() => page.evaluate(() => (window.__hopper as unknown as H | undefined)?.game?.phase), { timeout: 30_000 }).toBe('roam');
  // Let the intro wave finish, then look at Hopper from close by.
  await page.waitForTimeout(4000);
  const look = () =>
    page.evaluate(() => {
      const h = window.__hopper as unknown as H;
      const c = h.sim.sim.cam, p = h.game.pet.pos;
      c.yaw = Math.atan2(-(p.x - c.pos.x), -(p.z - c.pos.z));
      c.pitch = Math.atan2(p.y + 0.2 - c.pos.y, Math.hypot(p.x - c.pos.x, p.z - c.pos.z));
    });
  await look();
  await page.waitForTimeout(300);
  await look();
  let s = await petOnScreen(page);
  await page.mouse.click(s.x, s.y);
  await expect.poll(() => page.evaluate(() => (window.__hopper as unknown as H).game.anim.current)).toBe('petted');
  await expect.poll(() => page.evaluate(() => (window.__hopper as unknown as H).sim.ui.hearts.active)).toBeGreaterThan(0);
  // (Software GL renders slowly: wait for the pose by animation time, not wall time.)
  await expect.poll(() => page.evaluate(() => (window.__hopper as unknown as H).game.anim.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.35);
  await page.screenshot({ path: 'artifacts/petting-1-tap.png' });

  // Stroke: press and hold on Hopper — more pets on a beat, more hearts.
  await look();
  s = await petOnScreen(page);
  const before = await page.evaluate(() => (window.__hopper as unknown as H).game.petting.count);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(s.x + 6 * Math.sin(i), s.y + 3 * Math.cos(i));
    await page.waitForTimeout(100);
  }
  await page.screenshot({ path: 'artifacts/petting-2-stroke.png' });
  await page.mouse.up();
  const after = await page.evaluate(() => (window.__hopper as unknown as H).game.petting.count);
  expect(after - before).toBeGreaterThanOrEqual(2);

  // Keep petting until the happy celebration hop.
  for (let i = 0; i < 8 && (await page.evaluate(() => (window.__hopper as unknown as H).game.anim.current)) !== 'celebrate'; i++) {
    await look();
    s = await petOnScreen(page);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(350);
  }
  expect(await page.evaluate(() => (window.__hopper as unknown as H).game.anim.current)).toBe('celebrate');
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/petting-3-celebrate.png' });
  expect(errors).toEqual([]);
});

test('landing page: tap the showcase Hopper — petted with hearts', async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#btn-sim')).toBeVisible();
  await page.waitForTimeout(800);
  await page.mouse.click(195, 200);
  await expect.poll(async () => (await showcase(page))?.current).toBe('petted');
  await expect.poll(async () => (await showcase(page))?.hearts).toBeGreaterThan(0);
  // (Software GL renders slowly: wait for the pose by animation time, not wall time.)
  await expect.poll(async () => (await showcase(page))?.t ?? 0, { timeout: 30_000 }).toBeGreaterThan(0.3);
  await page.screenshot({ path: 'artifacts/petting-4-landing.png' });
  expect(errors).toEqual([]);
});

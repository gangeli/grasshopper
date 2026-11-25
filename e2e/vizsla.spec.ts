import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * The other pet: a Vizsla. Its pose sheet renders, the start page's picker
 * swaps to it (and remembers), and the bot plays a full round with it.
 */
type Showcase = { species?: string; anim: { current: string } };
const showcase = (page: Page) => page.evaluate(() => (window.__hopper as unknown as { showcase?: Showcase } | undefined)?.showcase?.species);
const phase = (page: Page) => page.evaluate(() => (window.__hopper?.game as { phase: string } | undefined)?.phase);

test('Vizsla pose contact sheet renders', async ({ page }) => {
  test.setTimeout(Number(process.env.LAB_TIMEOUT ?? 120_000));
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : m.text().startsWith('lab: ') && console.log(m.text())));
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/lab.html?pet=vizsla');
  await page.waitForFunction(() => (window as unknown as { __labReady?: boolean }).__labReady === true, null, { timeout: 90_000 });
  await page.locator('canvas').screenshot({ path: 'artifacts/contact-sheet-vizsla.png' });
  expect(errors).toEqual([]);
});

test('start page: the pet picker swaps to the Vizsla and remembers it', async ({ page }) => {
  // (Three loads of the start page at full detail: slow in the software-rendered test browser.)
  test.setTimeout(240_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#pet-picker')).toBeVisible();
  expect(await showcase(page)).toBe('hopper');
  await expect(page.locator('[data-pet="hopper"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-pet="vizsla"]').click();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla');
  await expect(page.locator('[data-pet="vizsla"]')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'artifacts/landing-vizsla.png' });
  // Remembered across visits...
  await page.reload();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla');
  await expect(page.locator('[data-pet="vizsla"]')).toHaveAttribute('aria-checked', 'true');
  // ...unless the link pins a pet.
  await page.goto('/?pet=hopper');
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('hopper');
  expect(errors).toEqual([]);
});

test('bot plays a full round in the simulator with the Vizsla', async ({ page }) => {
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  await page.goto('/?sim=1&room=living&bot=1&speed=4&fixed=1&seed=3&lod=low&fur=0&env=0&pet=vizsla');
  const wait = (want: string[], timeout = 120_000) => expect.poll(() => phase(page), { timeout, intervals: [250] }).toMatch(new RegExp(`^(${want.join('|')})$`));
  await wait(['roam']);
  expect(await page.evaluate(() => (window.__hopper as unknown as { sim: { sim: { rig: { species: string } } } }).sim.sim.rig.species)).toBe('vizsla');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'artifacts/sim-vizsla-1-roam.png' });
  await wait(['countdown']);
  await wait(['seek']);
  await page.screenshot({ path: 'artifacts/sim-vizsla-3-seek.png' });
  await wait(['found'], 200_000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'artifacts/sim-vizsla-4-found.png' });
  expect(errors).toEqual([]);
});

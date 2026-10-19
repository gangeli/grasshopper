import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Plays a complete round in the browser simulator with the seeker bot and
 * captures screenshots of each phase for review.
 */
const phase = (page: Page) => page.evaluate(() => (window.__hopper?.game as { phase: string } | undefined)?.phase);

async function waitPhase(page: Page, want: string[], timeout = 120_000) {
  await expect.poll(() => phase(page), { timeout, intervals: [250] }).toMatch(new RegExp(`^(${want.join('|')})$`));
}

for (const room of ['living', 'bedroom']) {
  test(`bot plays a full round in the simulator (${room})`, async ({ page }) => {
    mkdirSync('artifacts', { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 430, height: 860 });
    await page.goto(`/?sim=1&room=${room}&bot=1&speed=4&fixed=1&seed=3&lod=low`);
    await waitPhase(page, ['roam']);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `artifacts/sim-${room}-1-roam.png` });
    await waitPhase(page, ['countdown']);
    await page.screenshot({ path: `artifacts/sim-${room}-2-countdown.png` });
    await waitPhase(page, ['seek']);
    await page.screenshot({ path: `artifacts/sim-${room}-3-seek.png` });
    await waitPhase(page, ['found'], 200_000);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `artifacts/sim-${room}-4-found.png` });
    expect(errors).toEqual([]);
  });
}

test('landing page renders and offers the virtual room', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  await page.goto('/');
  await expect(page.locator('#btn-sim')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/landing.png' });
  expect(errors).toEqual([]);
});

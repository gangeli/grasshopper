import { test, expect, type Page } from '@playwright/test';

/**
 * The speech bubble: the one-off walk tip ("tap the floor…") comes a few
 * seconds into the first walk, but it waits its turn: it never replaces
 * something that is being said (such as "I remember this room!", which it
 * used to cut off when the two came close together).
 */
type H = { hud: { say(msg: string, seconds?: number): void; speaking: boolean }; game: { phase: string } };
const phase = (page: Page) => page.evaluate(() => (window.__hopper as unknown as H | undefined)?.game?.phase);
const bubble = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector('.bubble')!;
    return { text: b.textContent ?? '', showing: b.classList.contains('show') };
  });

test('the walk tip waits until the bubble is free', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  await page.goto('/?sim=1&room=empty&seed=3&lod=low&fur=0&env=0');
  await expect.poll(() => phase(page), { timeout: 60_000, intervals: [100] }).toBe('roam');
  const t0 = Date.now();
  // Something is said shortly before the tip is due (9 s into the walk), and is still up when it is.
  await page.waitForTimeout(Math.max(0, 6500 - (Date.now() - t0)));
  await page.evaluate(() => (window.__hopper as unknown as H).hud.say('I remember this room! 🏠', 6));
  expect(await bubble(page)).toEqual({ text: 'I remember this room! 🏠', showing: true });
  await page.waitForTimeout(Math.max(0, 10_500 - (Date.now() - t0)));
  // The tip's moment has passed: the bubble still holds what was being said (or what the game said since), not the tip.
  const then = await bubble(page);
  expect(then.showing).toBe(true);
  expect(then.text).not.toContain('Tip:');
  // Once that has had its time, the tip follows.
  await expect.poll(async () => (await bubble(page)).text, { timeout: 20_000, intervals: [250] }).toContain('Tip:');
  expect((await bubble(page)).showing).toBe(true);
  expect(Date.now() - t0).toBeGreaterThan(12_000);
  expect(errors).toEqual([]);
});

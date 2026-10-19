import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/** Renders the pose lab and saves contact sheets to artifacts/ for review. */
test('pose contact sheet renders', async ({ page }) => {
  test.setTimeout(Number(process.env.LAB_TIMEOUT ?? 120_000));
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : m.text().startsWith('lab: ') && console.log(m.text())));
  const params = process.env.LAB_PARAMS ?? '';
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`/lab.html?${params}`);
  await page.waitForFunction(() => (window as unknown as { __labReady?: boolean }).__labReady === true, null, { timeout: 90_000 });
  const canvas = page.locator('canvas');
  await canvas.screenshot({ path: `artifacts/${process.env.LAB_OUT ?? 'contact-sheet'}.png` });
  expect(errors).toEqual([]);
});

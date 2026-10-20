import { test, expect, type Page } from '@playwright/test';

/**
 * Remembering a room across page loads (IndexedDB): map the virtual room,
 * save, reload the page, and Hopper recognises the room and restores the
 * map. Then the start page offers to forget it, and forgetting works.
 */
type Mem = {
  mode: string;
  status: { restores: number; saves: number; fragments: number; lastReason: string; state: string };
  flush(): Promise<void>;
  forget(): Promise<boolean>;
  list(): Promise<{ id: string; area: number }[]>;
};
type H = { memory?: Mem; sim?: { sim: { cam: { yaw: number; pitch: number; pos: { x: number; y: number; z: number } }; time: number } }; game?: { mappedArea(): number } };

const hopper = (page: Page) => page.evaluate(() => !!(window.__hopper as H | undefined)?.memory);

/** Walk the virtual camera slowly around the room, looking around (page side). */
async function wander(page: Page) {
  await page.evaluate(() => {
    const h = window.__hopper as H;
    let a = 0;
    setInterval(() => {
      const c = h.sim!.sim.cam;
      a += 0.01;
      c.pos.x = Math.cos(a * 0.35) * 1.2;
      c.pos.z = 0.4 + Math.sin(a * 0.35) * 0.8;
      c.yaw += 0.025;
      c.pitch = -0.55 + Math.sin(a * 1.3) * 0.2;
    }, 16);
  });
}

test('a mapped room is saved, and restored after a reload', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  const url = '/?sim=1&room=living&fixed=1&speed=2&seed=3&lod=low&fur=0&env=0&memBudget=40';
  await page.goto(url);
  await expect.poll(() => hopper(page), { timeout: 60_000 }).toBe(true);
  // Start from a clean store.
  await page.evaluate(async () => {
    await (window.__hopper as H).memory!.forget();
  });
  expect(await page.evaluate(() => (window.__hopper as H).memory!.mode)).toBe('worker');
  await wander(page);
  // Map for a while, then save.
  await expect.poll(() => page.evaluate(() => (window.__hopper as H).game!.mappedArea()), { timeout: 90_000, intervals: [500] }).toBeGreaterThan(4);
  await page.evaluate(async () => {
    await (window.__hopper as H).memory!.flush();
  });
  const stored = await page.evaluate(() => (window.__hopper as H).memory!.list());
  expect(stored.length).toBe(1);
  expect(stored[0].area).toBeGreaterThan(3);

  // A new session: the page is reloaded (new world, nothing mapped yet).
  await page.reload();
  await expect.poll(() => hopper(page), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (window.__hopper as H).memory!.status.fragments), { timeout: 30_000 }).toBe(1);
  await wander(page);
  await expect
    .poll(
      async () => {
        const st = await page.evaluate(() => {
          const m = (window.__hopper as H).memory!;
          return { ...m.status, t: (window.__hopper as H).sim!.sim.time, area: (window.__hopper as H).game!.mappedArea() };
        });
        if (process.env.MEMLOG) console.log(JSON.stringify(st));
        return st.restores;
      },
      { timeout: 150_000, intervals: [2000] },
    )
    .toBeGreaterThan(0);
  await expect(page.locator('.bubble')).toContainText('I remember this room');
  // Restored map: the play area is there right away.
  expect(await page.evaluate(() => (window.__hopper as H).game!.mappedArea())).toBeGreaterThan(3);
  await page.screenshot({ path: 'artifacts/memory-restored.png' });
  expect(errors).toEqual([]);
});

test('the start page offers to forget remembered rooms', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  // Store something through the app's own store (as a session would).
  await page.goto('/?memory=0');
  await page.evaluate(async () => {
    const paths = ['/src/world/persist/MapStore.ts', '/src/world/persist/ChunkedMap.ts'];
    const mod = (await import(/* @vite-ignore */ paths[0])) as typeof import('../src/world/persist/MapStore');
    const cm = (await import(/* @vite-ignore */ paths[1])) as typeof import('../src/world/persist/ChunkedMap');
    const store = await mod.MapStore.open();
    const m = cm.emptyMap(0.05, 52, { x: 0, y: 0, z: 0 });
    const c = cm.getOrCreateChunk(m, 0, 0);
    c.observed.fill(1);
    c.occ.fill(-20);
    await store.save('test', m, { area: 12 });
  });
  await page.reload();
  await expect(page.locator('#memory-row')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#memory-text')).toContainText('remembers');
  page.on('dialog', (d) => void d.accept());
  await page.locator('#btn-forget').click();
  await expect(page.locator('#memory-text')).toContainText('Forgotten');
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator('#memory-row')).toBeHidden();
  expect(errors).toEqual([]);
});

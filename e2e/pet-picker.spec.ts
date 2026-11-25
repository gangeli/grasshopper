import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * The model selector: which pet plays, and in which coat. On the start page
 * it swaps the showcase and is remembered; from the HUD (the 🐾 button) it
 * swaps the pet in the middle of a game, in the simulator and in AR.
 */
type Showcase = { species?: string; coat?: string };
type Rig = { species: string; palette: { body: number }; group: { parent: unknown; visible: boolean } };
type Emu = { setPose(x: number, y: number, z: number, yaw: number, pitch: number): void; select(): Promise<void> };
const showcase = (page: Page) => page.evaluate(() => (window.__hopper as unknown as { showcase?: Showcase } | undefined)?.showcase ?? null).then((s) => (s ? `${s.species}/${s.coat}` : ''));
const phase = (page: Page) => page.evaluate(() => (window.__hopper?.game as { phase: string } | undefined)?.phase);
const checked = (page: Page, group: string) => page.locator(`${group} [aria-checked="true"]`);
const coats = (page: Page, scope: string) => page.locator(`${scope} [data-coat]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.coat));

test('start page: the model selector swaps pet and coat, and remembers each pet’s coat', async ({ page }) => {
  test.setTimeout(150_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  // (Low detail: the software-rendered test browser draws full fur very slowly.)
  await page.goto('/?lod=low&fur=0&env=0');
  await expect(page.locator('#pet-picker')).toBeVisible();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('hopper/mint');
  // Two pets; Hopper's three coats, mint chosen.
  await expect(page.locator('#pet-picker [role="radiogroup"]')).toHaveCount(2);
  await expect(checked(page, '#pet-picker .pets')).toHaveAttribute('data-pet', 'hopper');
  expect(await coats(page, '#pet-picker')).toEqual(['mint', 'plum', 'ember']);
  await expect(checked(page, '#pet-picker .coats')).toHaveAttribute('data-coat', 'mint');
  await expect(page.locator('#pet-picker .coat-name')).toHaveText('Mint');

  // Another coat for Hopper.
  await page.locator('#pet-picker [data-coat="plum"]').click();
  await expect(checked(page, '#pet-picker .coats')).toHaveAttribute('data-coat', 'plum');
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('hopper/plum');
  await expect(page.locator('#pet-picker .coat-name')).toHaveText('Plum');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/picker-1-hopper-plum.png' });

  // The Vizsla, which comes in its own coats.
  await page.locator('#pet-picker [data-pet="vizsla"]').click();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/golden');
  expect(await coats(page, '#pet-picker')).toEqual(['golden', 'russet', 'sandy']);
  await page.locator('#pet-picker [data-coat="russet"]').click();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/russet');
  await expect(page.locator('#pet-picker .petpick')).not.toHaveClass(/busy/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/picker-2-vizsla-russet.png' });

  // By keyboard: arrows move through a group and choose as they go.
  await checked(page, '#pet-picker .coats').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/sandy');
  await expect(checked(page, '#pet-picker .coats')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/russet');

  // Remembered: the pet, and each pet's own coat.
  await page.reload();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/russet');
  await expect(checked(page, '#pet-picker .pets')).toHaveAttribute('data-pet', 'vizsla');
  await expect(checked(page, '#pet-picker .coats')).toHaveAttribute('data-coat', 'russet');
  await page.locator('#pet-picker [data-pet="hopper"]').click();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('hopper/plum');
  await expect(checked(page, '#pet-picker .coats')).toHaveAttribute('data-coat', 'plum');

  // A link can pin both for a visit.
  await page.goto('/?pet=vizsla&coat=sandy&lod=low&fur=0&env=0');
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/sandy');
  await expect(checked(page, '#pet-picker .coats')).toHaveAttribute('data-coat', 'sandy');
  // ...without changing what is remembered.
  expect(await page.evaluate(() => [localStorage.getItem('hopper-pet'), localStorage.getItem('hopper-coat-vizsla'), localStorage.getItem('hopper-coat-hopper')])).toEqual(['hopper', 'russet', 'plum']);
  expect(errors).toEqual([]);
});

test('the chosen pet and coat are the ones that play', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  // Chosen on the start page...
  await page.goto('/?lod=low&fur=0&env=0');
  await page.locator('#pet-picker [data-pet="vizsla"]').click();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/golden');
  await page.locator('#pet-picker [data-coat="sandy"]').click();
  await expect.poll(() => showcase(page), { timeout: 30_000 }).toBe('vizsla/sandy');
  // ...and that is who is in the room.
  await page.locator('#btn-sim').click();
  await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('roam');
  const rig = await page.evaluate(() => {
    const r = (window.__hopper as unknown as { sim: { sim: { rig: Rig } } }).sim.sim.rig;
    return { species: r.species, body: r.palette.body };
  });
  expect(rig).toEqual({ species: 'vizsla', body: 0xbc7f43 });
  expect(errors).toEqual([]);
});

test('in a game: the 🐾 button opens the selector and swaps the pet where it stands', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  await page.goto('/?sim=1&room=living&seed=3&lod=low&fur=0&env=0');
  await expect.poll(() => phase(page), { timeout: 60_000 }).toBe('roam');
  const rig = () =>
    page.evaluate(() => {
      const h = window.__hopper as unknown as { sim: { sim: { rig: Rig; anim: { current: string }; pet: { pos: { x: number; y: number; z: number } } } }; stage: { scene: unknown } };
      const s = h.sim.sim;
      return { species: s.rig.species, body: s.rig.palette.body, inScene: s.rig.group.parent === h.stage.scene };
    });
  const gpu = () =>
    page.evaluate(() => {
      const info = (window.__hopper as unknown as { stage: { renderer: { info: { memory: { geometries: number; textures: number }; programs: unknown[] } } } }).stage.renderer.info;
      return { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs.length };
    });
  expect(await rig()).toEqual({ species: 'hopper', body: 0x74b897, inScene: true });

  // Closed until asked for.
  const sheet = page.locator('.petsheet');
  const paw = page.locator('[data-hud="pet"]');
  await expect(sheet).toBeHidden();
  await expect(paw).toHaveAttribute('aria-expanded', 'false');
  await paw.click();
  await expect(sheet).toBeVisible();
  await expect(paw).toHaveAttribute('aria-expanded', 'true');
  await expect(checked(page, '.petsheet .pets')).toHaveAttribute('data-pet', 'hopper');
  await page.screenshot({ path: 'artifacts/picker-3-hud-sheet.png' });
  // Escape puts it away again (and the button has the focus back).
  await checked(page, '.petsheet .pets').focus();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(paw).toBeFocused();
  await paw.click();
  await expect(sheet).toBeVisible();
  // Arrow keys choose in the selector; they do not also walk the player (the simulator steers by them).
  const eye = () => page.evaluate(() => ({ ...(window.__hopper as unknown as { sim: { sim: { cam: { pos: { x: number; y: number; z: number } } } } }).sim.sim.cam.pos }));
  const stoodAt = await eye();
  await checked(page, '.petsheet .coats').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rig()).body, { timeout: 30_000 }).toBe(0x9a86c4);
  await expect(sheet.locator('.petpick')).not.toHaveClass(/busy/);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await rig()).body, { timeout: 30_000 }).toBe(0x74b897);
  await expect(sheet.locator('.petpick')).not.toHaveClass(/busy/);
  await page.waitForTimeout(300);
  expect(await eye()).toEqual(stoodAt);

  // A Vizsla takes Hopper's place; the game carries on.
  await sheet.locator('[data-pet="vizsla"]').click();
  await expect.poll(async () => (await rig()).species, { timeout: 30_000 }).toBe('vizsla');
  expect(await rig()).toEqual({ species: 'vizsla', body: 0xab5d28, inScene: true });
  expect(await phase(page)).toBe('roam');
  expect(await coats(page, '.petsheet')).toEqual(['golden', 'russet', 'sandy']);
  await sheet.locator('[data-coat="russet"]').click();
  await expect.poll(async () => (await rig()).body, { timeout: 30_000 }).toBe(0x994a24);
  await expect(sheet.locator('.petpick')).not.toHaveClass(/busy/);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'artifacts/picker-4-hud-vizsla.png' });
  // Taps on the sheet are not taps on the room: the pet was not sent anywhere or petted by them.
  expect(await page.evaluate(() => (window.__hopper as unknown as { sim: { ui: { marker: { visible: boolean } } } }).sim.ui.marker.visible)).toBe(false);

  // Swapping back and forth does not pile up GPU resources.
  await page.waitForTimeout(500);
  const before = await gpu();
  for (const [pet, coat, body] of [['hopper', 'ember', 0xe0975e], ['vizsla', 'sandy', 0xbc7f43], ['hopper', 'mint', 0x74b897], ['vizsla', 'russet', 0x994a24]] as const) {
    await sheet.locator(`[data-pet="${pet}"]`).click();
    await expect.poll(async () => (await rig()).species, { timeout: 30_000 }).toBe(pet);
    await expect(sheet.locator('.petpick')).not.toHaveClass(/busy/);
    await sheet.locator(`[data-coat="${coat}"]`).click();
    await expect.poll(async () => (await rig()).body, { timeout: 30_000 }).toBe(body);
    await expect(sheet.locator('.petpick')).not.toHaveClass(/busy/);
  }
  await page.waitForTimeout(800);
  const after = await gpu();
  expect(after.geometries, 'geometries after swapping').toBeLessThanOrEqual(before.geometries + 3);
  expect(after.programs, 'shader programs after swapping').toBeLessThanOrEqual(before.programs + 2);
  expect(after.textures, 'textures after swapping').toBeLessThanOrEqual(before.textures + 8);

  // Done closes it; the choice is the remembered one.
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
  await expect(paw).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => [localStorage.getItem('hopper-pet'), localStorage.getItem('hopper-coat-vizsla'), localStorage.getItem('hopper-coat-hopper')])).toEqual(['vizsla', 'russet', 'mint']);

  expect(await phase(page)).toBe('roam');
  expect(errors).toEqual([]);
});

test('in a game: a round starting puts the selector away, and the swapped pet plays it', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  // The bot maps the room and plays; meanwhile the pet is changed from the HUD.
  await page.goto('/?sim=1&room=living&bot=1&speed=4&fixed=1&seed=3&lod=low&fur=0&env=0');
  const wait = (want: string[], timeout = 120_000) => expect.poll(() => phase(page), { timeout, intervals: [250] }).toMatch(new RegExp(`^(${want.join('|')})$`));
  const species = () => page.evaluate(() => (window.__hopper as unknown as { sim: { sim: { rig: Rig } } }).sim.sim.rig.species);
  await wait(['roam']);
  await page.locator('[data-hud="pet"]').click();
  await page.locator('.petsheet [data-pet="vizsla"]').click();
  await expect.poll(species, { timeout: 30_000 }).toBe('vizsla');
  await expect(page.locator('.petsheet')).toBeVisible();
  // The countdown covers the screen: the selector is closed, not left hanging over it.
  await wait(['countdown', 'seek', 'found']);
  await expect(page.locator('.petsheet')).toBeHidden();
  await wait(['seek', 'found']);
  // Swapped again while it hides: it stays hidden where it is, as Hopper.
  const hiddenAt = await page.evaluate(() => ({ ...(window.__hopper as unknown as { sim: { sim: { pet: { pos: { x: number; y: number; z: number } } } } }).sim.sim.pet.pos }));
  if ((await phase(page)) === 'seek') {
    await page.locator('[data-hud="pet"]').click();
    await page.locator('.petsheet [data-pet="hopper"]').click();
    await expect.poll(species, { timeout: 30_000 }).toBe('hopper');
    await page.locator('.petsheet').getByRole('button', { name: 'Done' }).click();
  }
  await wait(['found'], 200_000);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'artifacts/picker-6-found-after-swaps.png' });
  const end = await page.evaluate(() => {
    const s = (window.__hopper as unknown as { sim: { sim: { pet: { pos: { x: number; y: number; z: number } }; game: { health: { log: unknown[] } } } } }).sim.sim;
    return { at: { ...s.pet.pos }, recoveries: s.game.health.log.length };
  });
  expect(Math.hypot(end.at.x - hiddenAt.x, end.at.z - hiddenAt.z), 'did not leave its hiding place').toBeLessThan(0.6);
  expect(end.recoveries, 'no recoveries needed').toBe(0);
  expect(errors).toEqual([]);
});

test('in AR (emulated phone): the selector swaps the pet during the session', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 430, height: 860 });
  await page.goto('/?emulate=phone&room=living&seed=3&lod=low&fur=0&env=0');
  await expect(page.locator('#btn-ar')).toBeVisible({ timeout: 20_000 });
  await page.locator('#btn-ar').click();
  const ar = () => page.evaluate(() => !!(window.__hopper?.ar as { session: unknown } | undefined)?.session);
  await expect.poll(ar, { timeout: 20_000 }).toBe(true);
  // Look at the floor ~1m ahead and tap to place Hopper.
  await page.evaluate(() => (window as unknown as { __emu: Emu }).__emu.setPose(0, 1.45, 0.6, 0, -0.9));
  await expect.poll(() => page.evaluate(() => !!(window.__hopper?.ar as { lastHit: unknown }).lastHit), { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => (window as unknown as { __emu: Emu }).__emu.select());
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('roam');
  const state = () =>
    page.evaluate(() => {
      const h = window.__hopper as unknown as { stack: { rig: Rig; pet: { pos: { x: number; y: number; z: number } } }; stage: { mapRoot: unknown } };
      const p = h.stack.pet.pos;
      return { species: h.stack.rig.species, body: h.stack.rig.palette.body, placed: h.stack.rig.group.parent === h.stage.mapRoot, at: [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100) };
    });
  const was = await state();
  expect(was).toMatchObject({ species: 'hopper', placed: true });

  await page.locator('[data-hud="pet"]').click();
  await expect(page.locator('.petsheet')).toBeVisible();
  await page.locator('.petsheet [data-pet="vizsla"]').click();
  await expect.poll(async () => (await state()).species, { timeout: 30_000 }).toBe('vizsla');
  await page.locator('.petsheet [data-coat="sandy"]').click();
  await expect.poll(async () => (await state()).body, { timeout: 30_000 }).toBe(0xbc7f43);
  await expect(page.locator('.petsheet .petpick')).not.toHaveClass(/busy/);
  await page.locator('.petsheet').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.petsheet')).toBeHidden();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'artifacts/picker-5-ar-vizsla.png' });

  // Still in AR, still where it was placed (it may have taken a step), and nothing the taps on the sheet did moved it.
  expect(await ar()).toBe(true);
  expect(await phase(page)).toBe('roam');
  const now = await state();
  expect(now).toMatchObject({ species: 'vizsla', placed: true });
  expect(Math.hypot(now.at[0] - was.at[0], now.at[2] - was.at[2])).toBeLessThan(1.5);
  expect(errors).toEqual([]);
});

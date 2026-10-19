import { test, expect, type Page } from '@playwright/test';

/**
 * Bad situations a real phone gets into, injected through the IWER emulator:
 * taps before any hit / on a wall / on a table, tracking loss, orientation-only
 * tracking, NaN poses, relocalisation jumps, the session being blurred, main
 * thread stalls, exceptions in the game, anchor drift, and the user's escape
 * hatches (rescan, move). The app must never stay stuck.
 */
type Stats = Record<string, number | string | boolean | number[] | null>;

const ev = <T,>(page: Page, fn: () => T) => page.evaluate(fn);
const stats = (page: Page) => ev(page, () => (window.__hopper?.ar as { stats: Stats }).stats) as Promise<Stats>;
const num = async (page: Page, k: string) => Number((await stats(page))[k]);
const phase = (page: Page) => ev(page, () => (window.__hopper?.game as { phase: string }).phase);
const alertText = (page: Page) => ev(page, () => (window.__hopper?.hud as { alertText: string }).alertText);
const bubble = (page: Page) => page.locator('.bubble').innerText();
const emu = <A extends unknown[]>(page: Page, fn: string, ...args: A) =>
  page.evaluate(([fn, args]) => (window as unknown as { __emu: Record<string, (...a: unknown[]) => unknown> }).__emu[fn as string](...(args as unknown[])), [fn, args] as const);
const setPose = (page: Page, x: number, y: number, z: number, yaw: number, pitch: number) => emu(page, 'setPose', x, y, z, yaw, pitch);
const select = (page: Page) => emu(page, 'select');
const hasHit = (page: Page) => ev(page, () => !!(window.__hopper?.ar as { lastHit: unknown }).lastHit);

async function enterAr(page: Page, extra = '') {
  await page.setViewportSize({ width: 430, height: 860 });
  await page.goto(`/?emulate=phone&room=living&seed=3&lod=low&fur=0&env=0${extra}`);
  await expect(page.locator('#btn-ar')).toBeVisible({ timeout: 20_000 });
  await page.locator('#btn-ar').click();
  await expect.poll(() => ev(page, () => !!(window.__hopper?.ar as { session: unknown } | undefined)?.session), { timeout: 20_000 }).toBe(true);
}

async function placeOnFloor(page: Page) {
  await setPose(page, 0, 1.45, 0.6, 0, -0.9);
  await expect.poll(() => hasHit(page), { timeout: 10_000 }).toBe(true);
  await select(page);
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('roam');
}

async function lookAround(page: Page, steps: number, wait = 150) {
  for (let a = 0; a < steps; a++) {
    await setPose(page, 0, 1.45, 0.6, (a / steps) * Math.PI * 2, -0.6 + 0.25 * Math.sin(a * 0.5));
    await page.waitForTimeout(wait);
  }
}

/** The game advances again (gameUpdates grows). */
async function expectRunning(page: Page) {
  const before = await num(page, 'gameUpdates');
  await expect.poll(() => num(page, 'gameUpdates'), { timeout: 10_000 }).toBeGreaterThan(before + 3);
}

/** The game is frozen: no updates over `ms`. */
async function expectFrozen(page: Page, ms = 1200) {
  await page.waitForTimeout(300); // let the fault take effect
  const before = await num(page, 'gameUpdates');
  const frames = await num(page, 'frames');
  await page.waitForTimeout(ms);
  expect(await num(page, 'gameUpdates')).toBe(before);
  expect(await num(page, 'frames')).toBeGreaterThan(frames); // the loop itself keeps running
}

test('AR recovers from bad situations: placement, tracking, visibility, errors, drift, rescan, move', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await enterAr(page);

  // --- Placement guidance ---------------------------------------------------
  // Pointing at the sky: no hit. A tap explains instead of doing nothing.
  await setPose(page, 0, 1.45, 0.6, 0, 1.45);
  await page.waitForTimeout(600);
  expect(await hasHit(page)).toBe(false);
  await select(page);
  await expect.poll(() => bubble(page)).toContain('can’t see the floor');
  expect(await phase(page)).toBe('waiting');
  // A wall is refused.
  await setPose(page, 0, 1.45, 0.6, 0, 0);
  await expect.poll(() => hasHit(page), { timeout: 10_000 }).toBe(true);
  await select(page);
  await expect.poll(() => bubble(page)).toContain('wall');
  expect(await phase(page)).toBe('waiting');
  // Tap while tracking is lost: told to wait, nothing placed.
  await setPose(page, 0, 1.45, 0.6, 0, -0.9);
  await emu(page, 'setTracking', 'lost');
  await page.waitForTimeout(400);
  await select(page);
  await expect.poll(() => bubble(page)).toContain('lost track');
  expect(await phase(page)).toBe('waiting');
  await emu(page, 'setTracking', 'ok');
  await placeOnFloor(page);
  await expect.poll(async () => (await stats(page)).anchor, { timeout: 10_000 }).toBe('tracking');
  await lookAround(page, 24);

  // --- Tracking loss: freeze, tell the user, resume ---------------------------
  await expectRunning(page);
  await emu(page, 'setTracking', 'lost');
  await page.waitForTimeout(400); // a frame already in flight may still carry depth
  const depthBefore = await num(page, 'depthFrames');
  await expectFrozen(page);
  expect(await alertText(page)).toContain('Tracking lost');
  expect(await num(page, 'depthFrames')).toBe(depthBefore); // no depth during loss
  await emu(page, 'setTracking', 'ok');
  await expectRunning(page);
  await expect.poll(() => alertText(page)).toBe('');
  // The world model was told about the loss and the regain (world.noteTrackingEvent).
  expect(await num(page, 'trackingEvents')).toBeGreaterThanOrEqual(2);
  expect((await num(page, 'trackingEvents')) % 2).toBe(0);

  // Orientation-only tracking (emulatedPosition) is also a freeze.
  await emu(page, 'setTracking', 'limited');
  await expectFrozen(page, 800);
  await emu(page, 'setTracking', 'ok');
  await expectRunning(page);

  // NaN poses never reach the game; the pet stays finite.
  await emu(page, 'setTracking', 'nan');
  await expectFrozen(page, 800);
  await emu(page, 'setTracking', 'ok');
  await expectRunning(page);
  const sane = await ev(page, () => {
    const h = window.__hopper as { stack: { pet: { pos: { x: number; y: number; z: number } }; anim: { lookTarget: { x: number; y: number; z: number } | null } } };
    const p = h.stack.pet.pos, l = h.stack.anim.lookTarget;
    return [p.x, p.y, p.z, l?.x ?? 0, l?.y ?? 0, l?.z ?? 0].every(Number.isFinite);
  });
  expect(sane).toBe(true);

  // Relocalisation jump: the viewer snaps 2.5m; the game pauses briefly to settle, then carries on.
  const jumps = await num(page, 'frames');
  await setPose(page, 2.5, 1.45, 0.6, 0, -0.6);
  await expect.poll(() => ev(page, () => (window.__hopper?.ar as { tracking: { jumps: number } }).tracking.jumps)).toBeGreaterThan(0);
  expect(await num(page, 'frames')).toBeGreaterThan(jumps);
  await expectRunning(page);
  await setPose(page, 0, 1.45, 0.6, 0, -0.6);

  // --- Session blurred (system UI on top) / hidden: pause and resume ----------
  await emu(page, 'setVisibility', 'visible-blurred');
  await expect.poll(() => alertText(page)).toBe('Paused');
  await expectFrozen(page, 800);
  await emu(page, 'setVisibility', 'visible');
  await expectRunning(page);
  await expect.poll(() => alertText(page)).toBe('');

  // --- A long main-thread stall must not become one huge game step -----------
  await page.evaluate(() => {
    const t = performance.now();
    while (performance.now() - t < 1500) {
      /* stall */
    }
  });
  await expectRunning(page);
  expect(await num(page, 'maxDt')).toBeLessThanOrEqual(0.05);

  // --- Exceptions in the game never kill the loop -----------------------------
  const errs0 = await num(page, 'errors');
  await page.evaluate(() => {
    const g = window.__hopper!.game as { update: (...a: unknown[]) => void; __orig?: unknown };
    g.__orig = g.update;
    g.update = () => {
      throw new Error('injected failure');
    };
  });
  const frames0 = await num(page, 'frames');
  await expect.poll(() => num(page, 'frames'), { timeout: 20_000 }).toBeGreaterThan(frames0 + 10);
  expect(await num(page, 'errors')).toBeGreaterThan(errs0 + 5);
  await expect.poll(() => alertText(page)).toContain('Something’s not right');
  await page.evaluate(() => {
    const g = window.__hopper!.game as { update: unknown; __orig?: unknown };
    g.update = g.__orig;
  });
  await expectRunning(page);
  await expect.poll(() => alertText(page), { timeout: 10_000 }).toBe('');

  // --- Anchor drift → map correction -----------------------------------------
  await emu(page, 'setAnchorDrift', 0.1, 0, 0);
  await expect.poll(async () => ((await stats(page)).anchorCorrection as number[] | null)?.[12] ?? 0, { timeout: 5000 }).toBeCloseTo(-0.1, 3);
  await emu(page, 'setAnchorDrift', 0, 0, 0);
  await expect.poll(async () => Math.abs(((await stats(page)).anchorCorrection as number[] | null)?.[12] ?? 1), { timeout: 5000 }).toBeLessThan(0.011);

  // --- Escape hatch: rescan clears the map and keeps playing ------------------
  const hard0 = await ev(page, () => (window.__hopper?.stack as { world: { recoveries: { hard: number } } }).world.recoveries.hard);
  await page.getByRole('button', { name: '↻ rescan' }).click();
  await expect.poll(() => ev(page, () => (window.__hopper?.stack as { world: { recoveries: { hard: number } } }).world.recoveries.hard)).toBe(hard0 + 1);
  expect(await phase(page)).toBe('roam');
  await lookAround(page, 24);
  // The game refreshes its nav every 2.5s of game time (slow under a loaded swiftshader).
  await expect.poll(() => ev(page, () => (window.__hopper?.game as { mappedArea(): number }).mappedArea()), { timeout: 60_000 }).toBeGreaterThan(0.3);
  await expectRunning(page);

  // --- Escape hatch: move Hopper; a table top needs a confirming second tap ----
  // and relevels the floor; moving back to the floor relevels again.
  await page.getByRole('button', { name: 'move', exact: true }).click();
  // Aim at the middle of the dining table top (the largest box topping out at 0.6–0.9m).
  const table = await ev(page, () => {
    const boxes = (window as unknown as { __emu: { room: { boxes: { min: { x: number; z: number }; max: { x: number; y: number; z: number } }[] } } }).__emu.room.boxes;
    const t = boxes.filter((b) => b.max.y > 0.6 && b.max.y < 0.9).sort((a, b) => (b.max.x - b.min.x) * (b.max.z - b.min.z) - (a.max.x - a.min.x) * (a.max.z - a.min.z))[0];
    return { x: (t.min.x + t.max.x) / 2, y: t.max.y, z: (t.min.z + t.max.z) / 2 };
  });
  await setPose(page, table.x, table.y + 0.8, table.z + 0.6, 0, -Math.atan2(0.8, 0.6));
  const hitY = () => ev(page, () => (window.__hopper?.ar as { lastHit: { pos: { y: number } } | null }).lastHit?.pos.y ?? -1);
  await expect.poll(hitY, { timeout: 10_000 }).toBeCloseTo(table.y, 2);
  await select(page);
  await expect.poll(() => bubble(page)).toContain('table');
  expect(await num(page, 'replacements')).toBe(0);
  await select(page);
  await expect.poll(() => num(page, 'replacements')).toBe(1);
  expect(await num(page, 'relevels')).toBe(1);
  expect(await ev(page, () => (window.__hopper?.stack as { world: { floorY: number } }).world.floorY)).toBeCloseTo(table.y, 2);
  await expectRunning(page);
  // Back to the real floor.
  await page.getByRole('button', { name: 'move', exact: true }).click();
  await setPose(page, 0, 1.45, 0.6, 0, -0.9);
  await expect.poll(hitY, { timeout: 10_000 }).toBeCloseTo(0, 2);
  await select(page);
  await expect.poll(() => num(page, 'replacements')).toBe(2);
  expect(await num(page, 'relevels')).toBe(2);
  expect(Math.abs(await ev(page, () => (window.__hopper?.stack as { world: { floorY: number } }).world.floorY))).toBeLessThan(0.03);
  const pet = await ev(page, () => (window.__hopper?.stack as { pet: { pos: { x: number; y: number; z: number } } }).pet.pos);
  expect(Math.abs(pet.y)).toBeLessThan(0.05);
  expect(await phase(page)).toBe('roam');
  await lookAround(page, 16);
  await expectRunning(page);

  expect(errors).toEqual([]);
});

for (const depth of ['0', 'zero']) {
  test(`AR without usable depth (${depth === '0' ? 'no depth API' : 'empty depth frames'}) maps from planes and hit-test`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await enterAr(page, `&depth=${depth}`);
    await placeOnFloor(page);
    await lookAround(page, 32);
    const s = await stats(page);
    if (depth === '0') expect(s.depthUsage).not.toBe('cpu-optimized');
    else expect(s.depthDead).toBe(true);
    expect(await ev(page, () => (window.__hopper?.stack as { world: { depthPoints: number } }).world.depthPoints)).toBe(0);
    await expect.poll(() => ev(page, () => (window.__hopper?.game as { mappedArea(): number }).mappedArea()), { timeout: 20_000 }).toBeGreaterThan(2);
    await expect(page.getByRole('button', { name: 'Play hide & seek' })).toBeEnabled({ timeout: 20_000 });
    expect(errors).toEqual([]);
  });
}

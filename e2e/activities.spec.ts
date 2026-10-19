import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * The activities picker and tapping, in the virtual room and in camera mode
 * (fake camera + synthetic device orientation): Hopper starts on a walk,
 * tapping Hopper gets a reaction, tapping the floor sends Hopper there, and
 * hide and seek unlocks once enough of the room is mapped.
 */
type V3 = { x: number; y: number; z: number };
type Tap = { kind: string; reaction?: string; target?: V3 };
type H = {
  THREE: { Vector3: new (x: number, y: number, z: number) => V3 & { project(c: unknown): V3 } };
  stage: { camera: unknown };
  game: {
    phase: string;
    pet: { pos: V3; moving: boolean };
    nav: { count: number; pos(n: number): V3; wallDist: Float32Array; nearest(p: V3, r: number): number; search(s: number, g: number, max: number): { cost: Float32Array } } | null;
    events: { onTap?: (r: Tap) => void };
    mappedArea(): number;
  };
  sim: { sim: { cam: { yaw: number; pitch: number; pos: V3 } }; ui: { marker: { visible: boolean } } };
};
declare global {
  interface Window {
    __taps?: Tap[];
  }
}

// Camera mode needs a (fake) camera; harmless for the virtual room.
test.use({
  launchOptions: {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const phase = (page: Page) => page.evaluate(() => (window.__hopper as unknown as H | undefined)?.game?.phase);

/** Record the game's tap results in window.__taps. */
async function spyTaps(page: Page) {
  await page.evaluate(() => {
    const g = (window.__hopper as unknown as H).game;
    const prev = g.events.onTap;
    window.__taps = [];
    g.events.onTap = (r) => {
      window.__taps!.push(JSON.parse(JSON.stringify(r)));
      prev?.(r);
    };
  });
}

const lastTap = (page: Page) => page.evaluate(() => window.__taps?.[window.__taps.length - 1] ?? null);

/** Screen position (CSS px) of a map-frame point. */
async function toScreen(page: Page, p: V3) {
  return page.evaluate((p) => {
    const h = window.__hopper as unknown as H;
    const v = new h.THREE.Vector3(p.x, p.y, p.z).project(h.stage.camera);
    return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, z: v.z };
  }, p);
}

async function tapPet(page: Page) {
  const pet = await page.evaluate(() => (window.__hopper as unknown as H).game.pet.pos);
  const s = await toScreen(page, { x: pet.x, y: pet.y + 0.15, z: pet.z });
  await page.mouse.click(s.x, s.y);
  await expect.poll(() => lastTap(page)).toMatchObject({ kind: 'pet' });
  const r = (await lastTap(page))!;
  expect(['giggle', 'celebrate', 'wave', 'surprised']).toContain(r.reaction);
}

/** A mapped, open floor spot on screen, away from the pet and clear of the HUD. */
async function floorSpotOnScreen(page: Page) {
  return page.evaluate(() => {
    const h = window.__hopper as unknown as H;
    const nav = h.game.nav!;
    const pet = h.game.pet.pos;
    let best: { p: V3; sx: number; sy: number } | null = null;
    // Sample nav nodes Hopper can reach and keep the ones that land on screen.
    const { cost } = nav.search(nav.nearest(pet, 0.3), -1, 30);
    // Not on top of (or right behind) Hopper on screen.
    const ps = new h.THREE.Vector3(pet.x, pet.y + 0.12, pet.z).project(h.stage.camera);
    const psx = ((ps.x + 1) / 2) * innerWidth, psy = ((1 - ps.y) / 2) * innerHeight;
    for (let n = 0; n < nav.count; n += 3) {
      if (!Number.isFinite(cost[n])) continue;
      const p = nav.pos(n);
      if (Math.abs(p.y) > 0.03 || nav.wallDist[n] < 0.3) continue;
      const d = Math.hypot(p.x - pet.x, p.z - pet.z);
      if (d < 0.6 || d > 1.6) continue;
      const v = new h.THREE.Vector3(p.x, p.y, p.z).project(h.stage.camera);
      const sx = ((v.x + 1) / 2) * innerWidth, sy = ((1 - v.y) / 2) * innerHeight;
      if (Math.hypot(sx - psx, sy - psy) < 80) continue;
      if (v.z > 1 || sx < 50 || sx > innerWidth - 50 || sy < innerHeight * 0.4 || sy > innerHeight - 170) continue;
      if (!best || Math.abs(sx - innerWidth / 2) < Math.abs(best.sx - innerWidth / 2)) best = { p, sx, sy };
    }
    return best;
  });
}

async function tapFloorAndWatch(page: Page, shot: string) {
  const spot = await floorSpotOnScreen(page);
  expect(spot, 'a mapped floor spot on screen').not.toBeNull();
  await page.mouse.click(spot!.sx, spot!.sy);
  await expect.poll(() => lastTap(page)).toMatchObject({ kind: 'goto' });
  const r = (await lastTap(page))!;
  expect(Math.hypot(r.target!.x - spot!.p.x, r.target!.z - spot!.p.z)).toBeLessThan(0.3);
  await expect.poll(() => page.evaluate(() => (window.__hopper as unknown as H).sim.ui.marker.visible)).toBe(true);
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot });
  // Hopper gets there.
  await expect
    .poll(
      () =>
        page.evaluate((t) => {
          const p = (window.__hopper as unknown as H).game.pet.pos;
          return Math.hypot(p.x - t.x, p.z - t.z);
        }, r.target!),
      { timeout: 20_000 },
    )
    .toBeLessThan(0.3);
}

/** Virtual room: turn the view towards Hopper. */
async function lookAtPet(page: Page) {
  await page.evaluate(() => {
    const h = window.__hopper as unknown as H;
    const c = h.sim.sim.cam, p = h.game.pet.pos;
    c.yaw = Math.atan2(-(p.x - c.pos.x), -(p.z - c.pos.z));
    c.pitch = -0.75;
  });
}

test('virtual room: walk by default, tap Hopper, tap the floor, unlock and play hide & seek', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync('artifacts', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?sim=1&room=living&seed=3&lod=low&fur=0&env=0&fixed=1&speed=2');
  await expect.poll(() => phase(page), { timeout: 30_000 }).toBe('roam');
  await spyTaps(page);
  // The picker: walking (active), hide & seek locked with progress.
  const walk = page.locator('.act[data-activity="walk"]');
  const hs = page.locator('.act[data-activity="hideSeek"]');
  await expect(walk).toBeVisible();
  await expect(walk).toHaveClass(/active/);
  await expect(hs).toHaveClass(/locked/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/activities-sim-1-walk.png' });
  // A locked activity explains itself.
  await hs.click();
  await expect(page.locator('.bubble')).toContainText(/room/);

  await tapPet(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/activities-sim-2-tap-pet.png' });

  // Look around (turning on the spot) so the map grows...
  const lookAround = async (area: number) => {
    for (let i = 0; i < 400 && (await page.evaluate(() => (window.__hopper as unknown as H).game.mappedArea())) < area; i++) {
      await page.evaluate((i) => {
        const c = (window.__hopper as unknown as H).sim.sim.cam;
        c.yaw += 0.08;
        c.pitch = -0.75 + 0.15 * Math.sin(i * 0.2);
      }, i);
      await page.waitForTimeout(60);
    }
  };
  await lookAround(1.2);
  // ...and Hopper can get around: look back at Hopper and send them somewhere.
  await lookAtPet(page);
  await page.waitForTimeout(3000);
  await tapFloorAndWatch(page, 'artifacts/activities-sim-3-tap-floor.png');

  // More looking around until hide & seek unlocks.
  await lookAround(2.2);
  const play = page.getByRole('button', { name: 'Play hide & seek' });
  await expect(play).toBeVisible({ timeout: 20_000 });
  await lookAtPet(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/activities-sim-4-unlocked.png' });
  await play.click();
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('countdown');
  await expect(page.locator('.acts')).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe('camera mode', () => {
  test('Hopper follows where the phone points; tap Hopper and the floor', async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync('artifacts', { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?camera=1&seed=3&lod=low&fur=0&env=0');
    await expect(page.locator('#btn-cam')).toBeVisible({ timeout: 20_000 });
    await page.locator('#btn-cam').click();
    // The phone, held up and tilted down a little; `alpha` turns it.
    await page.evaluate(() => {
      (window as unknown as { __alpha: number }).__alpha = 0;
      setInterval(() => {
        const alpha = (window as unknown as { __alpha: number }).__alpha;
        window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta: 70, gamma: 0, absolute: false }));
      }, 50);
    });
    await expect.poll(() => phase(page), { timeout: 30_000 }).toBe('roam');
    await spyTaps(page);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: 'artifacts/activities-camera-1-walk.png' });
    await tapPet(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'artifacts/activities-camera-2-tap-pet.png' });
    await page.waitForTimeout(2000);
    await tapFloorAndWatch(page, 'artifacts/activities-camera-3-tap-floor.png');

    // Turn the phone ~70° to the left, slowly: Hopper comes round into view.
    for (let a = 0; a <= 70; a += 2) {
      await page.evaluate((a) => ((window as unknown as { __alpha: number }).__alpha = a), a);
      await page.waitForTimeout(80);
    }
    const inView = () =>
      page.evaluate(() => {
        const h = window.__hopper as unknown as H;
        const p = h.game.pet.pos;
        const v = new h.THREE.Vector3(p.x, p.y + 0.1, p.z).project(h.stage.camera);
        return v.z < 1 && Math.abs(v.x) < 0.75 && Math.abs(v.y) < 0.9;
      });
    await expect.poll(inView, { timeout: 25_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window.__hopper as unknown as H).game.pet.moving), { timeout: 15_000 }).toBe(false);
    await page.screenshot({ path: 'artifacts/activities-camera-4-followed.png' });
    expect(await inView()).toBe(true);
    expect(errors).toEqual([]);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Runs the real WebXR AR code path against the IWER emulator, with a
 * simulated living room providing hit-tests, planes and CPU depth (phone) or
 * planes + scene mesh (quest). Places Hopper with a tap, maps the room by
 * turning around, plays a round, and walks the seeker to a vantage point.
 */
type Emu = { setPose(x: number, y: number, z: number, yaw: number, pitch: number): void; select(): Promise<void> };
const ev = <T,>(page: Page, fn: () => T) => page.evaluate(fn);

async function setPose(page: Page, x: number, y: number, z: number, yaw: number, pitch: number) {
  await page.evaluate(([x, y, z, yaw, pitch]) => (window as unknown as { __emu: Emu }).__emu.setPose(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
}

for (const profile of ['phone', 'quest']) {
  test(`AR session on an emulated ${profile}: place, map, hide, find`, async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync('artifacts', { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 430, height: 860 });
    await page.goto(`/?emulate=${profile}&room=living&seed=3&record=1`);
    await expect(page.locator('#btn-ar')).toBeVisible({ timeout: 20_000 });
    await page.locator('#btn-ar').click();
    await expect.poll(() => ev(page, () => !!(window.__hopper?.ar as { session: unknown } | undefined)?.session), { timeout: 20_000 }).toBe(true);

    // Look at the floor ~1m ahead and tap to place Hopper.
    await setPose(page, 0, 1.45, 0.6, 0, -0.9);
    await expect.poll(() => ev(page, () => !!(window.__hopper?.ar as { lastHit: unknown }).lastHit), { timeout: 10_000 }).toBe(true);
    await page.evaluate(() => (window as unknown as { __emu: Emu }).__emu.select());
    await expect.poll(() => ev(page, () => (window.__hopper?.game as { phase: string }).phase), { timeout: 10_000 }).toBe('roam');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `artifacts/ar-${profile}-1-placed.png` });

    // Map: turn around slowly, looking down.
    for (let a = 0; a < 48; a++) {
      await setPose(page, 0, 1.45, 0.6, (a / 48) * Math.PI * 2, -0.6 + 0.25 * Math.sin(a * 0.5));
      await page.waitForTimeout(150);
    }
    const stats = await ev(page, () => {
      const h = window.__hopper as { ar: { stats: Record<string, unknown> }; stack: { world: { depthPoints: number } }; game: { mappedArea(): number } };
      return { ...h.ar.stats, depthPoints: h.stack.world.depthPoints, area: h.game.mappedArea() } as Record<string, unknown> & { depthPoints: number; area: number };
    });
    console.log(profile, 'AR stats', JSON.stringify(stats));
    expect(stats.planes as number).toBeGreaterThan(3);
    if (profile === 'phone') {
      expect(stats.depthUsage).toBe('cpu-optimized');
      expect(stats.depthPoints).toBeGreaterThan(1000);
    } else expect(stats.meshes as number).toBeGreaterThan(3);
    expect(stats.area).toBeGreaterThan(2);

    // The session recorder captured the phone's depth + poses; save it for offline replay.
    if (profile === 'phone') {
      const b64 = await page.evaluate(async () => {
        const rec = (window.__hopper?.ar as { recorder: { count: number; toBlob(): Blob } }).recorder;
        const buf = new Uint8Array(await rec.toBlob().arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { n: rec.count, data: btoa(s) };
      });
      expect(b64.n).toBeGreaterThan(20);
      writeFileSync('artifacts/emulated-phone.hopperrec', Buffer.from(b64.data, 'base64'));
    }

    // Face the pet and start a round.
    const pet = await ev(page, () => (window.__hopper?.stack as { pet: { pos: { x: number; y: number; z: number } } }).pet.pos);
    await setPose(page, 0, 1.45, 0.6, Math.atan2(-(pet.x - 0), -(pet.z - 0.6)), -0.7);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Play hide & seek' }).click();
    await expect.poll(() => ev(page, () => (window.__hopper?.game as { phase: string }).phase), { timeout: 10_000 }).toBe('countdown');
    await page.screenshot({ path: `artifacts/ar-${profile}-2-countdown.png` });
    await expect.poll(() => ev(page, () => (window.__hopper?.game as { phase: string }).phase), { timeout: 60_000 }).toBe('seek');
    await page.screenshot({ path: `artifacts/ar-${profile}-3-seek.png` });
    const spot = await ev(page, () => (window.__hopper?.game as { spot: { pos: { x: number; y: number; z: number }; kind: string } }).spot);
    console.log(profile, 'hid', spot.kind, JSON.stringify(spot.pos));

    // Walk around the hiding spot at ~1.2m, crouching, looking at it, until found.
    let found = false;
    for (let a = 0; a < 36 && !found; a++) {
      const ang = (a / 36) * Math.PI * 2;
      const x = spot.pos.x + Math.sin(ang) * 1.2, z = spot.pos.z + Math.cos(ang) * 1.2;
      const eyeY = a % 2 ? 0.9 : 1.4;
      const yaw = Math.atan2(-(spot.pos.x - x), -(spot.pos.z - z));
      const pitch = Math.atan2(spot.pos.y + 0.1 - eyeY, 1.2);
      await setPose(page, x, eyeY, z, yaw, pitch);
      await page.waitForTimeout(900);
      found = (await ev(page, () => (window.__hopper?.game as { phase: string }).phase)) === 'found';
    }
    await page.screenshot({ path: `artifacts/ar-${profile}-4-found.png` });
    expect(found).toBe(true);
    expect(errors).toEqual([]);
  });
}

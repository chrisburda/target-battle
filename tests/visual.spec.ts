import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

/**
 * Browser QA for Target Battle.
 *
 * These are interaction tests, not screenshot baselines: the point is to prove
 * a player can actually complete a turn — aim, hold the interval, land a shot,
 * see damage — on both desktop keyboard and mobile touch, with a clean console.
 */

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

async function sampleCanvas(page: Page): Promise<CanvasSample> {
  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  const buffer = await canvas.screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  return {
    ok: alphaPixels > 256 && (max - min > 8 || buckets.size > 3),
    reason: 'sampled',
    variance: max - min,
    colorBuckets: buckets.size,
  };
}

function collectErrors(page: Page): { console: string[]; page: string[] } {
  const errors = { console: [] as string[], page: [] as string[] };
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}

const phase = (page: Page) =>
  page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.phase ?? 'none');

async function startMatch(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
  // Seed before the match so terrain, spawns and AI are reproducible.
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed(4242));
  await expect(page.locator('#setup-screen')).toBeVisible();
  await page.locator('#start-match').click();
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('aim');
}

test('plays a full turn: aim, hold the interval, land a shot', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await startMatch(page);

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  // --- target selection changes state ----------------------------------
  await expect(page.locator('.target-card')).toHaveCount(1);
  await expect(page.locator('.target-card--chosen')).toHaveCount(1);
  const isMobile = testInfo.project.name.includes('mobile');
  if (isMobile) {
    await expect(page.locator('#touch-controls')).toBeVisible();
    const next = page.locator('#touch-next');
    const box = await next.boundingBox();
    expect(box, 'touch target button must be laid out').not.toBeNull();
    if (box) {
      // Press and release, exactly as a thumb would.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(200);
      await page.mouse.up();
    }
  } else {
    await page.keyboard.press('ArrowRight');
  }
  // With one opponent the choice cannot change, but the line must still resolve.
  await expect(page.locator('#line-readout')).not.toBeEmpty();

  // --- ammo selection --------------------------------------------------
  await page.locator('.ammo-slot').nth(1).click();
  await expect(page.locator('.ammo-slot').nth(1)).toHaveClass(/ammo-slot--active/);

  await testInfo.attach(`${testInfo.project.name}-aim`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // --- lock the aim ----------------------------------------------------
  if (isMobile) await page.locator('#touch-action').click();
  else await page.keyboard.press('Enter');
  await expect.poll(() => phase(page), { timeout: 12_000 }).toBe('interval');

  // --- hold the power target -------------------------------------------
  // Tap through the real input path at a cadence near the one that holds
  // target, so the interval scores something meaningful rather than zero.
  let bestAccuracy = 0;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if ((await phase(page)) !== 'interval') break;
    if (isMobile) await page.locator('#touch-action').click({ timeout: 3000 });
    else await page.keyboard.press('Space');
    const live = Number((await page.locator('#live-accuracy').textContent()) ?? '0');
    if (Number.isFinite(live)) bestAccuracy = Math.max(bestAccuracy, live);
    await page.waitForTimeout(200);
  }

  await testInfo.attach(`${testInfo.project.name}-interval`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // --- the shot must actually be fired ---------------------------------
  await expect
    .poll(
      async () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.fighters[0]?.shots ?? 0),
      { timeout: 25_000 },
    )
    .toBeGreaterThan(0);

  const summary = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.lastShot ?? '');
  expect(summary, 'the shot summary records the interval that produced it').not.toBe('');
  expect(bestAccuracy, 'a scripted hold should score above zero').toBeGreaterThan(0);

  await testInfo.attach(`${testInfo.project.name}-flight`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  expect(errors.console, errors.console.join('\n')).toEqual([]);
  expect(errors.page, errors.page.join('\n')).toEqual([]);
});

test('the shot changes the world: a full turn resolves to impact', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);

  // 'stress' drives the real machine through a whole turn to impact.
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(99);
    window.__THREE_GAME_TEST_HOOKS__?.setState('stress');
  });
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(after?.fighters[0]?.shots ?? 0, 'the active fighter fired').toBeGreaterThan(0);
  expect(after?.phase, 'the turn resolved rather than hanging').not.toBe('interval');

  expect(errors.console, errors.console.join('\n')).toEqual([]);
  expect(errors.page, errors.page.join('\n')).toEqual([]);
});

test('pause, resume and results screens are reachable', async ({ page }, testInfo) => {
  const errors = collectErrors(page);

  await page.goto('/');
  await expect(page.locator('#setup-screen')).toBeVisible();
  await testInfo.attach(`${testInfo.project.name}-setup`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await startMatch(page);

  await page.locator('#pause-button').click();
  await expect(page.locator('#pause-screen')).toBeVisible();
  await testInfo.attach(`${testInfo.project.name}-pause`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.locator('#resume-button').click();
  await expect(page.locator('#pause-screen')).toBeHidden();

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('results'));
  await expect(page.locator('#results-screen')).toBeVisible();
  await expect(page.locator('.results__row')).toHaveCount(2);
  await testInfo.attach(`${testInfo.project.name}-results`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // Rematch must return to a live match rather than leaving a dead screen.
  await page.locator('#rematch-button').click();
  await expect(page.locator('#results-screen')).toBeHidden();
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('aim');

  expect(errors.console, errors.console.join('\n')).toEqual([]);
  expect(errors.page, errors.page.join('\n')).toEqual([]);
});

test('HUD text fits and the docks stay clear of the roster', async ({ page }) => {
  await startMatch(page);

  // Fixed-width numeric fields must not reflow or clip as values change.
  const clipped = await page.evaluate(() => {
    const offenders: string[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      '#hud .stat__value, #hud .chip__name, #hud .chip__hp, #hud .round-chip, #hud .zone-flag, #hud .target-card__name, #hud .target-card__meta',
    );
    for (const node of nodes) {
      if (node.scrollWidth > node.clientWidth + 1) {
        offenders.push(`${node.className}: ${node.scrollWidth} > ${node.clientWidth}`);
      }
    }
    return offenders;
  });
  expect(clipped, clipped.join('\n')).toEqual([]);

  const overlap = await page.evaluate(() => {
    const dock = document.querySelector('#aim-panel')?.getBoundingClientRect();
    const rail = document.querySelector('#roster-rail')?.getBoundingClientRect();
    if (!dock || !rail) return false;
    return !(
      dock.right < rail.left ||
      dock.left > rail.right ||
      dock.bottom < rail.top ||
      dock.top > rail.bottom
    );
  });
  expect(overlap, 'aim dock overlaps the roster rail').toBe(false);
});

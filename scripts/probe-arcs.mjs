#!/usr/bin/env node
/**
 * Checks that the aiming arc stays on screen, across many seeds.
 *
 * "The path leaves the frame while you are picking a round" is not a thing one
 * screenshot can confirm or deny — plenty of layouts produce a flat shot that
 * looks fine and proves nothing. This walks a spread of seeds, reads the
 * solved angle and apex out of the running game, and compares the apex against
 * the top of the visible frame.
 *
 * Exits non-zero if any arc is cut off.
 *
 * Usage: node scripts/probe-arcs.mjs [--seeds 12]
 */
import { chromium } from '@playwright/test';

const at = process.argv.indexOf('--seeds');
const seeds = at > 0 ? Number(process.argv[at + 1]) : 12;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://127.0.0.1:5188/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.useGeneratedCast?.());

const rows = [];
for (let i = 0; i < seeds; i += 1) {
  const seed = 1000 + i * 137;
  await page.evaluate((s) => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(s);
    window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
  }, seed);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('aim'));
  // The rig eases toward its target, so read after it has settled — measuring
  // mid-transition reports a frame nobody ever sees.
  await page.waitForTimeout(900);
  const shot = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.inspectShot?.() ?? null);
  if (shot) rows.push({ seed, ...shot });
}

let offscreen = 0;
let steep = 0;
for (const row of rows) {
  if (!row.arcOnScreen) offscreen += 1;
  if (row.angle >= 60) steep += 1;
  console.log(
    '  seed ' + row.seed +
      '  angle ' + String(row.angle).padStart(5) + '°' +
      '  apex ' + String(row.apex).padStart(7) +
      '  top ' + String(row.visibleTop).padStart(7) +
      '  ' + row.quality.padEnd(8) +
      (row.arcOnScreen ? '' : '  ARC CUT OFF'),
  );
}
console.log(
  rows.length + ' seeds: ' + offscreen + ' arcs cut off, ' + steep + ' steeper than 60 degrees',
);
console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'clean');
await browser.close();
process.exit(offscreen === 0 && rows.length > 0 && errors.length === 0 ? 0 : 1);

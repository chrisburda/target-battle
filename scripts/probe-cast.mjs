#!/usr/bin/env node
/**
 * Reports what the generated cast actually built, from inside the running game.
 *
 * The failure modes when adapting a skinned model are all silent: a bone name
 * that does not resolve, a scale applied twice, a fit node measured before its
 * matrices were current. None of them throw — they just produce a fighter that
 * is the wrong size holding a rock in the wrong place, which is a slow thing to
 * diagnose from a screenshot.
 *
 * Usage: node scripts/probe-cast.mjs
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://127.0.0.1:5188/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.useGeneratedCast?.());
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('aim'));
await page.waitForTimeout(900);

const report = await page.evaluate(
  () => window.__THREE_GAME_TEST_HOOKS__?.inspectCast?.() ?? 'hook unavailable',
);

console.log(JSON.stringify(report, null, 2));
console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'clean');
await browser.close();

#!/usr/bin/env node
/**
 * Drives the actual setup screen with the HD cast toggle on.
 *
 * Everything else here reaches the generated cast through a QA hook, which
 * skips the setup screen entirely — so the one path a player takes was the one
 * path never exercised. This clicks the switch, presses start, and waits for a
 * playable frame.
 *
 * Usage: node scripts/verify-hd-path.mjs
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
const requests = [];
page.on('response', (r) => { if (r.url().includes('/tripo/')) requests.push(r.url().split('/').pop() + ' ' + r.status()); });

await page.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);

// The checkbox itself is visually hidden behind a styled track, which is what
// a user actually clicks — so click that, not the input.
await page.locator('#models-toggle').locator('xpath=following-sibling::span[1]').click();
if (!(await page.locator('#models-toggle').isChecked())) throw new Error('HD toggle did not take');
await page.locator('#start-match').click();

// The button carries the download progress, so it going back to its label is
// the signal that the cast arrived and the match started.
await page.waitForFunction(() => document.querySelector('#start-match')?.textContent === 'Start match', { timeout: 30000 });
await page.waitForTimeout(1500);

const state = await page.evaluate(() => ({
  cast: window.__THREE_GAME_TEST_HOOKS__?.inspectCast?.() ?? null,
  frame: window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0,
}));
await page.screenshot({ path: 'artifacts/look/hd-path.png' });

console.log('fetched: ' + (requests.join(', ') || 'nothing'));
console.log('frames rendered after start: ' + state.frame);
console.log(JSON.stringify(state.cast, null, 2));
console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'clean');
await browser.close();
process.exit(errors.length ? 1 : 0);

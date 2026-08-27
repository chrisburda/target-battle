#!/usr/bin/env node
/**
 * Checks that the generated assets actually reach the screen.
 *
 * Three things have gone silently wrong here before, and none of them showed
 * up as an error: the roster avatars kept the data URLs they were first built
 * with, the round models were cached for the session before the generated ones
 * had loaded, and a fighter's head anchor pointed at a proxy that never leaves
 * the origin. All three looked fine to a glance and were obvious to a diff, so
 * this diffs.
 *
 * Exits non-zero if any of it regresses.
 *
 * Usage: node scripts/verify-assets.mjs
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const fetched = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => {
  if (r.url().includes('/tripo/')) fetched.push(r.url().split('/').pop() + ' ' + r.status());
});

const avatars = () =>
  page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll('img.creature-portrait')) {
      const card = img.closest('button, li, div');
      const text = (card && card.textContent) || '';
      const label = text.trim().split('\n')[0].slice(0, 28) || 'player row';
      const src = img.getAttribute('src') || '';
      out.push({ label, fingerprint: src.length + ':' + src.slice(-24) });
    }
    return out;
  });

await page.goto('http://127.0.0.1:5188/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);

// The first paint uses the built cast on purpose — the screen is not held for
// a download. Capture it before the swap lands.
const before = await avatars();

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.useGeneratedCast?.());
await page.waitForTimeout(1200);
const after = await avatars();

let swapped = 0;
for (let i = 0; i < after.length; i += 1) {
  const same = before[i] && before[i].fingerprint === after[i].fingerprint;
  if (!same) swapped += 1;
  console.log('  ' + (same ? 'STALE  ' : 'swapped') + '  ' + after[i].label);
}
console.log(swapped + ' of ' + after.length + ' avatars swapped to the generated cast');

await page.locator('#start-match').click();
await page.waitForFunction(
  () => document.querySelector('#start-match')?.textContent === 'Start match',
  { timeout: 30000 },
);
await page.waitForTimeout(1200);

const cast = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.inspectCast?.() ?? []);
const generated = cast.filter((f) => f.source === 'generated' && f.bones > 0);
console.log(generated.length + ' of ' + cast.length + ' fighters built from the generated cast');

// A round the generated set covers, and one it deliberately does not.
// Picking a round is only allowed on a human turn in the aim phase, so get
// there first — otherwise every reading comes back empty and looks like a
// pass.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('aim'));
await page.waitForTimeout(700);

const rounds = await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  const names = [];
  for (const id of ['melon', 'coconut', 'rock']) {
    hooks?.pickAmmo?.(id);
    names.push(id + '=' + (hooks?.heldRoundName?.() || 'none'));
  }
  return names;
});
console.log('held rounds: ' + rounds.join('  '));

console.log('fetched ' + fetched.length + ' generated files');
console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'clean');
await browser.close();

const generatedRounds = rounds.filter((r) => r.includes('generated')).length;
const ok =
  generatedRounds >= 2 &&
  swapped === after.length &&
  after.length > 0 &&
  generated.length === cast.length &&
  cast.length > 0 &&
  errors.length === 0;
process.exit(ok ? 0 : 1);

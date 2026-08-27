#!/usr/bin/env node
/**
 * Captures a throw as a strip of frames.
 *
 * A single screenshot cannot tell you whether an animation reads — the pose at
 * any one instant is not the thing being judged, the arc between poses is. This
 * drives a real turn and grabs frames across the swing so the wind-up, the
 * release and the follow-through can be looked at together.
 *
 * Usage:
 *   node scripts/throw-strip.mjs [--hd] [--out artifacts/look/throw] [--frames 8]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const flag = (name, fallback) => {
  const at = process.argv.indexOf('--' + name);
  return at > 0 ? process.argv[at + 1] : fallback;
};

const out = flag('out', 'artifacts/look/throw');
const frames = Number(flag('frames', 8));
const gapMs = Number(flag('gap', 110));
const hd = process.argv.includes('--hd');

await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 620, height: 700 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://127.0.0.1:5188/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.seed(2026);
  window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
});
if (hd) await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.useGeneratedCast?.());

// Frame the thrower tightly, then start the throw and sample through it.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('closeup'));
await page.waitForTimeout(700);
const started = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.throwNow?.());
if (!started) console.warn('   WARNING: no fighter to throw — the strip will show a static pose');

for (let i = 0; i < frames; i += 1) {
  await page.screenshot({ path: path.join(out, String(i).padStart(2, '0') + '.png') });
  await page.waitForTimeout(gapMs);
}

console.log('-> ' + out + '  ' + frames + ' frames, ' + gapMs + ' ms apart');
console.log(errors.length ? '   errors: ' + errors.join(' | ') : '   clean');
await browser.close();

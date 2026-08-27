#!/usr/bin/env node
/**
 * Samples the throwing hand through a throw.
 *
 * Whether an arm is swinging is not reliably answerable from a contact sheet:
 * a small arm tucked against a chest can move a long way in bone space and
 * barely a dozen pixels on screen. Tracking the hand position over the swing
 * answers it in numbers.
 *
 * Usage: node scripts/probe-throw.mjs [--hd]
 */
import { chromium } from '@playwright/test';

const hd = process.argv.includes('--hd');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://127.0.0.1:5188/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
if (hd) await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.useGeneratedCast?.());
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('aim'));
await page.waitForTimeout(700);

const samples = await page.evaluate(async () => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  const out = [];
  hooks?.throwNow?.();
  const started = performance.now();
  // A throw runs about a second; sampling on animation frames keeps the
  // readings in step with the poses the renderer actually drew.
  await new Promise((resolve) => {
    const tick = () => {
      const fighter = hooks?.inspectCast?.()?.[0];
      if (fighter) {
        out.push({
          t: Math.round(performance.now() - started),
          hand: fighter.handAboveFeet,
          reach: fighter.handReach,
        });
      }
      if (performance.now() - started < 1200) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  return out;
});

const hands = samples.map((s) => s.hand);
const reach = samples.map((s) => s.reach).filter((v) => typeof v === "number");
console.log((hd ? 'generated' : 'built') + ' cast, ' + samples.length + ' samples');
console.log('  hand height  min ' + Math.min(...hands).toFixed(3) + '  max ' + Math.max(...hands).toFixed(3) + '  travel ' + (Math.max(...hands) - Math.min(...hands)).toFixed(3));
if (reach.length) {
  console.log('  hand reach   min ' + Math.min(...reach).toFixed(3) + '  max ' + Math.max(...reach).toFixed(3) + '  travel ' + (Math.max(...reach) - Math.min(...reach)).toFixed(3));
}
console.log('  trace ' + samples.filter((_, i) => i % 4 === 0).map((s) => s.hand.toFixed(2)).join(' '));
console.log(errors.length ? '  errors: ' + errors.join(' | ') : '  clean');
await browser.close();

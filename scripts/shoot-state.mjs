#!/usr/bin/env node
/**
 * Screenshots one game state at one viewport, on demand.
 *
 * `capture-states.mjs` walks the whole player-facing set and takes a while;
 * when iterating on a single surface — the terrain, the sky, one fighter — what
 * is wanted is one frame of one state, now, at whatever size shows the thing
 * being worked on. Same test hooks, same seeding, so the frame is comparable
 * between runs.
 *
 * Usage:
 *   node scripts/shoot-state.mjs stress4 artifacts/look/arena.png [--width 1920] [--height 1080]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const [state = 'stress4', out = 'artifacts/look/shot.png'] = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = process.argv.indexOf('--' + name);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};

const width = flag('width', 1600);
const height = flag('height', 900);
const seed = flag('seed', 2026);
const url = 'http://127.0.0.1:5188/?qa=1';

await mkdir(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
await page.evaluate((s) => {
  window.__THREE_GAME_TEST_HOOKS__?.seed(s);
  window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
}, seed);
await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.setState(s), state);
await page.waitForTimeout(1100);

// Chrome only, so the HUD can be hidden for a clean look at the world.
if (process.argv.includes('--no-hud')) {
  await page.addStyleTag({ content: '#hud, #hud-root, .hud { display: none !important; }' });
  await page.waitForTimeout(120);
}

await page.screenshot({ path: out });
const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__ ?? null);
console.log('->', out);
if (diagnostics) {
  console.log(
    `   draw calls ${diagnostics.calls ?? '?'}  triangles ${(diagnostics.triangles ?? 0).toLocaleString()}` +
      `  fps ${Math.round(diagnostics.fps ?? 0)}`,
  );
}
console.log(errors.length ? '   errors: ' + errors.join(' | ') : '   clean');
await browser.close();

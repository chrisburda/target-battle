#!/usr/bin/env node
/**
 * Captures every player-facing state to artifacts/screens, at desktop and
 * mobile viewports.
 *
 * The canvas inspector covers in-world states and their pixel metrics; this
 * covers the DOM screens (setup, pause, results) and the full composited frame
 * with the HUD over the top, which is what a player actually looks at.
 *
 * Usage: node scripts/capture-states.mjs [--url URL] [--out DIR]
 */
import { chromium, devices } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:5188', out: 'artifacts/screens' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

/** Adds the ?qa=1 opt-in that a production build needs to expose test hooks. */
function withQa(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('qa', '1');
  return parsed.toString();
}

const VIEWPORTS = [
  { name: 'desktop', options: { viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 } },
  { name: 'mobile', options: { ...devices['iPhone 13'] } },
];

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
}

async function capture(page, dir, name) {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('  ->', file);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];

  for (const viewport of VIEWPORTS) {
    console.log(`[${viewport.name}]`);
    const context = await browser.newContext(viewport.options);
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${viewport.name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${viewport.name}: ${e.message}`));

    await page.goto(withQa(args.url), { waitUntil: 'load' });
    await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
    await page.evaluate(() => {
      window.__THREE_GAME_TEST_HOOKS__?.seed(2026);
      window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
    });

    await settle(page);
    await capture(page, args.out, `${viewport.name}-01-setup`);

    // Live match states, driven through the real machine.
    for (const [file, state] of [
      ['02-aim', 'aim'],
      ['03-interval', 'interval'],
      ['04-flight', 'flight'],
      ['05-impact', 'stress'],
    ]) {
      await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.setState(s), state);
      await settle(page, 700);
      await capture(page, args.out, `${viewport.name}-${file}`);
    }

    await page.locator('#pause-button').click();
    await settle(page, 400);
    await capture(page, args.out, `${viewport.name}-06-pause`);
    await page.locator('#resume-button').click();

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('results'));
    await settle(page, 500);
    await capture(page, args.out, `${viewport.name}-07-results`);

    await context.close();
  }

  await browser.close();
  if (errors.length > 0) {
    console.error('console/page errors:', errors);
    process.exit(1);
  }
  console.log('no console or page errors');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

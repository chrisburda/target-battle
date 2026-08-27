#!/usr/bin/env node
/**
 * Renders every fighter's setup-screen portrait to its own PNG.
 *
 * The in-game camera is locked side-on, which hides most of what is right or
 * wrong with a character model. This drives the real character-select portrait
 * at high DPR so the cast can be judged at a size that shows the work.
 *
 * Usage: node scripts/character-sheet.mjs [--url URL] [--out DIR]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = { url: 'http://127.0.0.1:5188', out: 'artifacts/characters' };
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--url') args.url = process.argv[i + 1];
  if (process.argv[i] === '--out') args.out = process.argv[i + 1];
}

const parsed = new URL(args.url);
parsed.searchParams.set('qa', '1');

await mkdir(args.out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 3,
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(parsed.toString(), { waitUntil: 'load' });
await page.waitForSelector('#animal-grid .animal-card');

const cards = await page.locator('#animal-grid .animal-card').count();
for (let i = 0; i < cards; i += 1) {
  const card = page.locator('#animal-grid .animal-card').nth(i);
  const name = (await card.locator('.animal-card__name').textContent())?.trim() ?? String(i);
  const species = (await card.locator('.animal-card__species').textContent())?.trim() ?? '';
  await card.hover();
  // Let the swap settle and the sway reach a readable angle.
  await page.waitForTimeout(900);
  const file = path.join(args.out, `${i + 1}-${name.toLowerCase()}.png`);
  await page.locator('.portrait').screenshot({ path: file });
  console.log(`  -> ${file}  (${name}, ${species})`);
}

await browser.close();
if (errors.length > 0) {
  console.error('console/page errors:', errors);
  process.exit(1);
}
console.log('no console or page errors');

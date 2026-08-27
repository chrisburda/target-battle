#!/usr/bin/env node
/**
 * Checks that no character's perk line wraps onto a second row.
 *
 * A wrapped line grows the panel, and because the line changes on hover the
 * panel jumps as the pointer moves across the roster. Whether a string wraps is
 * a question about the rendered box, not the character count, so this measures
 * the box: it hovers each fighter in turn and compares the line's height
 * against one row of its own line-height.
 *
 * Checked at several widths, since the narrow ones wrap first.
 *
 * Usage: node scripts/probe-perklines.mjs
 */
import { chromium } from '@playwright/test';

const WIDTHS = [860, 1024, 1280, 1600];

const browser = await chromium.launch();
let failures = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 860 } });
  await page.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);

  const buttons = page.locator('#animal-grid button');
  const total = await buttons.count();

  console.log('viewport ' + width + 'px  (' + total + ' selectable fighters)');
  for (let i = 0; i < total; i += 1) {
    await buttons.nth(i).hover();
    await page.waitForTimeout(120);
    const line = await page.evaluate(() => {
      const node = document.querySelector('#animal-detail');
      if (!node) return null;
      /*
       * Count rows from the text rects, not from height over line-height.
       * The element carries padding and an unresolved line-height, so the
       * height ratio reported two rows for a line that plainly fit on one.
       * A Range yields one rect per visual line, which is the actual answer.
       */
      const range = document.createRange();
      range.selectNodeContents(node);
      const tops = new Set(
        Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0.5)
          .map((rect) => Math.round(rect.top)),
      );
      return {
        text: (node.textContent || '').trim(),
        rows: Math.max(1, tops.size),
      };
    });
    if (!line) {
      console.log('  (no perk line found)');
      break;
    }
    const bad = line.rows > 1;
    if (bad) failures += 1;
    console.log(
      '  ' + (bad ? 'WRAPS ' : 'one row') + '  ' + String(line.text.length).padStart(3) + ' chars  ' + line.text,
    );
  }
  await page.close();
}

console.log(failures === 0 ? 'no perk line wraps' : failures + ' wrapped line(s)');
await browser.close();
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Writes the baked roster avatars out as files, at the size they are baked.
 *
 * They are rendered to a render target and read back as data URLs, so they
 * never touch the disk — which makes judging their framing a matter of
 * squinting at 44-pixel thumbnails in a page screenshot. Framing is exactly
 * the thing that has gone wrong here twice, so it is worth being able to look
 * at them properly.
 *
 * Usage: node scripts/dump-avatars.mjs [--out artifacts/avatars]
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const at = process.argv.indexOf('--out');
const out = at > 0 ? process.argv[at + 1] : 'artifacts/avatars';
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.useGeneratedCast?.());
await page.waitForTimeout(1400);

const shots = await page.evaluate(() => {
  const found = [];
  for (const img of document.querySelectorAll('img.creature-portrait')) {
    const card = img.closest('button, li, div');
    const text = (card && card.textContent) || '';
    const label = text.trim().split('\n')[0].slice(0, 20) || 'row';
    found.push({ label, src: img.getAttribute('src') || '' });
  }
  return found;
});

let written = 0;
for (const [index, shot] of shots.entries()) {
  if (!shot.src.startsWith('data:image')) continue;
  const base64 = shot.src.split(',')[1];
  const safe = shot.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const name = String(index).padStart(2, '0') + '-' + safe + '.png';
  await writeFile(path.join(out, name), Buffer.from(base64, 'base64'));
  console.log('  -> ' + name);
  written += 1;
}
// A contact sheet beside them, so the set can be judged together rather than
// one file at a time — the framing problems here have all been relative ones.
const files = shots
  .map((shot, index) => ({ shot, index }))
  .filter(({ shot }) => shot.src.startsWith('data:image'))
  .map(({ shot, index }) =>
    String(index).padStart(2, '0') + '-' + shot.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png',
  );
await writeFile(
  'avatars.html',
  '<!doctype html><meta charset="UTF-8"><title>Roster avatars</title><style>' +
    'body{margin:0;background:#14181d;color:#fafafa;font-family:Helvetica,Arial,sans-serif}' +
    'h1{margin:16px 20px 4px;font-size:20px}p{margin:0 20px 12px;color:#b6b6b6;font-size:13px}' +
    '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:0 20px 20px}' +
    'figure{margin:0}img{width:100%;display:block;background:#23282e;' +
    'border:1px solid rgba(224,224,224,.16);border-radius:6px}' +
    'figcaption{font-size:11px;color:#b6b6b6;margin-top:4px;font-family:Monaco,monospace}' +
    '</style><h1>Roster avatars</h1><p>Baked at source size. Regenerate with ' +
    '<code>node scripts/dump-avatars.mjs</code>.</p><div class="grid">' +
    files.map((f) => '<figure><img src="/' + out + '/' + f + '"><figcaption>' + f + '</figcaption></figure>').join('') +
    '</div>',
);

console.log(written + ' avatars written to ' + out + ', contact sheet at avatars.html');
await browser.close();

#!/usr/bin/env node
/**
 * Generates the remaining ammo props, one after another.
 *
 * Sequential rather than parallel on purpose: Tripo rate-limits concurrent
 * generations per account, and a batch that half-fails leaves no clear record
 * of which prompt produced which file. Anything already on disk is skipped, so
 * this is safe to re-run after an interruption — which is how it got written.
 *
 * Usage:  TRIPO_API_KEY=... node scripts/gen-ammo.mjs [id ...]
 */
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/*
 * Prompts carry the house style explicitly, because the fighters were
 * generated with the same phrasing and consistency across a set comes from the
 * prompt, not from the seed. The negative list is doing real work: without
 * "no base" every generation arrives welded to a display plinth, and without
 * the realism exclusions the props come back photoreal and stop matching the
 * cast they are thrown by.
 */
const STYLE =
  'stylised game asset, Pixar-like cartoon realism, soft rounded forms, warm muted ' +
  'natural colours, subtle painted surface detail, soft ambient occlusion in the ' +
  'crevices, clean readable silhouette, single object centred, neutral background';

const NEGATIVE =
  'photorealistic, hyperrealistic, gritty, dark, horror, base, plinth, pedestal, ' +
  'stand, ground plane, text, watermark, multiple objects, scene, background clutter';

const AMMO = [
  {
    id: 'melon',
    faceLimit: 6000,
    prompt:
      'A heavy round watermelon used as a cartoon cannonball, deep green rind with ' +
      'darker green stripes, a small dry brown stem on top, slightly squashed sphere, ' +
      'thick and weighty looking. ' + STYLE,
  },
  {
    id: 'cluster',
    faceLimit: 6000,
    prompt:
      'A large pine cone, warm brown overlapping woody scales tipped with paler edges, ' +
      'egg shaped, a short broken stalk at the narrow end, chunky stylised scales rather ' +
      'than fine detail. ' + STYLE,
  },
  {
    id: 'hive',
    faceLimit: 7000,
    prompt:
      'A small round paper wasp nest, warm ochre and honey coloured layered paper shell ' +
      'wrapping in soft ridges, a single dark round entrance hole near the bottom, teardrop ' +
      'shaped, hanging stub at the top. ' + STYLE,
  },
];

const OUT = 'assets/tripo';
const PUBLIC = 'public/tripo';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code))));
    child.on('error', reject);
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!process.env.TRIPO_API_KEY) throw new Error('TRIPO_API_KEY is not set');
  const only = process.argv.slice(2);
  await mkdir(PUBLIC, { recursive: true });

  for (const item of AMMO) {
    if (only.length && !only.includes(item.id)) continue;
    const name = 'ammo-' + item.id;
    const file = path.join(OUT, name + '.glb');
    if (await exists(file)) {
      console.log('skip ' + name + ' (already generated)');
    } else {
      await run([
        'scripts/tripo-character.mjs',
        '--name', name,
        '--prompt', item.prompt,
        '--negative', NEGATIVE,
        '--face-limit', String(item.faceLimit),
        '--out', OUT,
      ]);
    }
    // The comparison harness and the game both serve out of public/.
    await copyFile(file, path.join(PUBLIC, name + '.glb'));
    console.log('  published to ' + path.join(PUBLIC, name + '.glb'));
  }
  console.log('\nall ammo present');
}

main().catch((error) => {
  console.error('\n' + error.message);
  process.exit(1);
});

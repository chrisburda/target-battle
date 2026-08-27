#!/usr/bin/env node
/**
 * Generates the hero world props.
 *
 * Deliberately not everything. Props are drawn with InstancedMesh, so a family
 * costs instances x triangles every frame — grass alone is scattered six
 * hundred times, and a generated mesh at even a thousand triangles would spend
 * more of the budget on lawn than on the entire cast. The families here are the
 * ones with low counts and large screen presence, which is exactly where a
 * generated asset earns its weight.
 *
 * Grass, flowers, mushrooms and vines stay procedural: they are small, numerous,
 * and already read fine as flat-shaded shapes.
 *
 * Usage:  TRIPO_API_KEY=... node scripts/gen-props.mjs [id ...]
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

/*
 * The same phrasing the cast and the ammo were generated with. Consistency
 * across a set comes from the prompt, not the seed, and these props stand
 * directly beside both.
 */
const STYLE =
  'stylised game asset, Pixar-like cartoon realism, soft rounded forms, warm muted ' +
  'natural colours, subtle painted surface detail, soft ambient occlusion in the ' +
  'crevices, clean readable silhouette, single object centred, neutral background';

const NEGATIVE =
  'photorealistic, hyperrealistic, gritty, dark, horror, base, plinth, pedestal, ' +
  'stand, ground plane, text, watermark, multiple objects, scene, background clutter';

/**
 * Face limits are set by instance count, not by how much detail the model
 * deserves. A boulder scattered fifty times has to be cheap; a palm placed
 * twelve times can afford three times as much.
 */
const PROPS = [
  {
    id: 'palm',
    faceLimit: 3000,
    prompt:
      'A single stylised coconut palm tree, slender curved brown trunk with soft ' +
      'ring texture, a crown of six broad arching green fronds, two small coconuts ' +
      'at the crown, trunk rising straight from the cut base. ' + STYLE,
  },
  {
    id: 'boulder',
    faceLimit: 1200,
    prompt:
      'A chunky rounded granite boulder, warm grey stone with softly faceted planes ' +
      'and darker weathered hollows, a patch of green moss on one shoulder, ' +
      'asymmetric and settled looking. ' + STYLE,
  },
  {
    id: 'log',
    faceLimit: 1500,
    prompt:
      'A short fallen tree log lying on its side, warm brown bark with soft ridges, ' +
      'pale cut end rings at both ends, a little green moss along the top, one small ' +
      'broken branch stub. ' + STYLE,
  },
  {
    id: 'bush',
    faceLimit: 1500,
    prompt:
      'A rounded leafy jungle shrub, dense clustered green foliage in soft rounded ' +
      'lobes, slightly darker underneath, a few lighter leaves catching the light on ' +
      'top, no visible pot or soil. ' + STYLE,
  },
  {
    id: 'bamboo',
    faceLimit: 2500,
    prompt:
      'A small clump of four bamboo stalks of differing heights, pale yellow-green ' +
      'segmented culms with darker nodes, a few narrow leaves near the tops, rising ' +
      'straight from a common base. ' + STYLE,
  },
];

const OUT = 'assets/tripo';

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
  const failures = [];

  for (const prop of PROPS) {
    if (only.length && !only.includes(prop.id)) continue;
    const name = 'prop-' + prop.id;
    if (await exists(path.join(OUT, name + '.glb'))) {
      console.log('skip ' + name + ' (already generated)');
      continue;
    }
    console.log('\n=== ' + name + ' ===');
    try {
      await run([
        'scripts/tripo-character.mjs',
        '--name', name,
        '--prompt', prop.prompt,
        '--negative', NEGATIVE,
        '--face-limit', String(prop.faceLimit),
        '--out', OUT,
      ]);
    } catch (error) {
      console.error('  ' + name + ' failed: ' + error.message);
      failures.push(name);
    }
  }

  console.log('\ndone' + (failures.length ? '; failed: ' + failures.join(', ') : ''));
}

main().catch((error) => {
  console.error('\n' + error.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Grades the fighter palette into the measured envelope and rewrites roster.ts.
 *
 * Character colour is not the same problem as landscape colour, and it took
 * running the audit to see it. The hue bands measured off the generated assets
 * describe natural surfaces — foliage, earth, stone — and forcing a cast into
 * them would flatten exactly what makes a cast: the generated set itself
 * contains a turquoise frog, a grey raccoon and a black toucan, none of which
 * sit in those bands. So identity hues are left alone here.
 *
 * What does carry over is the chroma ceiling. Nothing in the generated set
 * exceeds 0.163, and a fighter that does is the one object on screen shouting
 * over everything else. Ten of forty-two fighter colours were above it.
 *
 * The two exceptions are the greens, which get an explicit hue correction as
 * well: they sit beside grass all match, and being fifteen degrees colder than
 * the grass is exactly the mismatch this whole pass exists to remove.
 *
 * Usage: node scripts/grade-roster.mjs [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { toOklch, oklch, chromaCeiling, TRIPO_HUE } from '../src/assets/palette.ts';

const FILE = 'src/game/roster.ts';

/**
 * Hues to steer, by animal and role.
 *
 * Only the greens. Pip's hide measured hue 134 against the generated gecko's
 * 122, and his limbs the same; Bunker's shell green was already at 116 and is
 * left as authored.
 */
const HUE_FIX = {
  gecko: { body: TRIPO_HUE.foliage + 3, limb: TRIPO_HUE.foliage + 1, belly: TRIPO_HUE.foliage + 6 },
};

function grade(animalId, role, hex) {
  const color = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const { L, C, h } = toOklch(color);
  const hue = HUE_FIX[animalId]?.[role] ?? h;
  const ceiling = chromaCeiling(L);
  const chroma = Math.min(C, ceiling);
  if (Math.abs(hue - h) < 0.01 && chroma === C) return null;
  const graded = oklch(L, chroma, hue);
  return {
    hex: graded.getHex(THREE.SRGBColorSpace),
    from: { L, C, h },
    to: toOklch(graded),
  };
}

const source = readFileSync(FILE, 'utf8');
let updated = source;
let changes = 0;

// Each palette line is one flat object literal, so the roles can be rewritten
// in place without parsing the module.
const blockPattern = /id: '(\w+)',[\s\S]*?palette: \{([^}]*)\}/g;
for (const match of source.matchAll(blockPattern)) {
  const [, animalId, body] = match;
  let rewritten = body;
  for (const roleMatch of body.matchAll(/(\w+): (0x[0-9a-fA-F]{6})/g)) {
    const [whole, role, value] = roleMatch;
    const result = grade(animalId, role, Number.parseInt(value, 16));
    if (!result) continue;
    const next = '0x' + result.hex.toString(16).padStart(6, '0');
    rewritten = rewritten.replace(whole, `${role}: ${next}`);
    changes += 1;
    console.log(
      `${animalId.padEnd(9)} ${role.padEnd(8)} ${value} -> ${next}` +
        `   hue ${result.from.h.toFixed(0)}->${result.to.h.toFixed(0)}` +
        `   C ${result.from.C.toFixed(3)}->${result.to.C.toFixed(3)}`,
    );
  }
  if (rewritten !== body) updated = updated.replace(body, rewritten);
}

console.log(`\n${changes} colour(s) graded`);
if (process.argv.includes('--write') && changes > 0) {
  writeFileSync(FILE, updated);
  console.log(`wrote ${FILE}`);
} else if (changes > 0) {
  console.log('(dry run — pass --write to apply)');
}

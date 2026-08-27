#!/usr/bin/env node
/**
 * Prints the landscape palette in OKLCH and checks it against the chroma
 * ceiling measured off the generated Tripo assets.
 *
 * Companion to `tripo-palette.mjs`: that one measures the generated art, this
 * one measures the hand-authored art, in the same units, so "does the
 * landscape belong with the characters" has an answer with numbers in it.
 *
 * Relies on Node's built-in TypeScript stripping to import the palette module
 * directly, so there is exactly one definition of the colour maths.
 *
 * Usage: node scripts/palette-audit.mjs
 */
import * as THREE from 'three';
import {
  GROUND,
  FLORA,
  SKY,
  WATER,
  toOklch,
  chromaCeiling,
  aerial,
} from '../src/assets/palette.ts';

const hex = (c) => '#' + c.getHexString(THREE.SRGBColorSpace);

function row(name, color, flagOverCeiling = false) {
  const { L, C, h } = toOklch(color);
  const ceiling = chromaCeiling(L);
  const flag =
    flagOverCeiling && C > ceiling ? `   OVER by ${((C / ceiling - 1) * 100).toFixed(0)}%` : '';
  console.log(
    `  ${name.padEnd(16)} ${hex(color)}  L ${L.toFixed(2)}  C ${C.toFixed(3)}` +
      `  hue ${String(Math.round(h)).padStart(3)}${flag}`,
  );
  return C > ceiling;
}

console.log('GROUND');
for (const [key, value] of Object.entries(GROUND)) {
  if (value.lit) {
    row(key, value.lit);
    row('  └ shade', value.shade);
  } else row(key, value);
}

console.log('\nFLORA');
for (const [key, value] of Object.entries(FLORA)) row(key, value);

console.log('\nSKY / WATER');
for (const [key, value] of Object.entries(SKY)) row(key, value);
for (const [key, value] of Object.entries(WATER)) row(key, value);

/* The palette this replaced, kept so the delta stays visible in the report. */
const PREVIOUS = {
  grassTop: 0x74c93f,
  grassShade: 0x4f9a2c,
  strataGrass: 0x5fae32,
  strataRoot: 0x4a7c2a,
  topsoil: 0x6b4a2c,
  dirt: 0x8a6238,
  clay: 0x9d7b4e,
  rock: 0x6f665c,
  bedrock: 0x494540,
  leaf: 0x3f9c3a,
  leafDark: 0x2a6f34,
  bark: 0x8a6440,
  propRock: 0x8d8577,
  ridgeNear: 0x2f6b39,
  ridgeMid: 0x4a8a63,
  ridgeFar: 0x7fa8a5,
  ridgeHaze: 0xa8c4d6,
  skyTop: 0x2f7fc4,
  water: 0x2e9fd0,
};

console.log('\nPREVIOUS landscape palette, same units');
let over = 0;
for (const [key, value] of Object.entries(PREVIOUS)) {
  if (row(key, new THREE.Color().setHex(value, THREE.SRGBColorSpace), true)) over += 1;
}
const total = Object.keys(PREVIOUS).length;
console.log(`\n  ${over} of ${total} exceeded the measured chroma ceiling`);

console.log('\nAerial recession applied to the near canopy green');
for (const d of [0, 0.32, 0.6, 0.82, 1]) row(`distance ${d}`, aerial(FLORA.canopy, d));

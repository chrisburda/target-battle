#!/usr/bin/env node
/**
 * Shrinks a GLB by downscaling its textures, in place of nothing else.
 *
 * The generated fighters are about 2.4 MB each and roughly three quarters of
 * that is texture — a 2048px albedo, a 2048px metallic-roughness and a 2048px
 * normal, on a character that is a hundred pixels tall in play. Six of them is
 * fourteen megabytes in front of anyone who opens the page, which is the one
 * thing standing between this cast and being shippable.
 *
 * Geometry is left alone deliberately. Decimating would mean re-rigging, and
 * the skeletons are the expensive part of the pipeline; the triangle counts are
 * already lower than the hand-built models they replace.
 *
 * Decoding and re-encoding happens in a headless browser because Node has no
 * image codec. The rest — relocating buffer views, patching offsets — is done
 * here, since accessors index views rather than raw bytes, so views can be
 * moved freely as long as each one stays contiguous and aligned.
 *
 * Usage:
 *   node scripts/glb-optimise.mjs assets/tripo/pip-rigged.glb public/tripo/pip-rigged.glb
 *   node scripts/glb-optimise.mjs --all
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Target edge length per texture role.
 *
 * The albedo carries everything the eye reads at this size, so it keeps the
 * most. Roughness and normal detail below a few hundred pixels is invisible on
 * a character this small and costs as much as the colour does.
 */
const SIZES = { baseColor: 512, metallicRoughness: 256, normal: 256 };
const QUALITY = 0.82;

const CAST = ['pip', 'bruno', 'tusk', 'sly', 'bunker', 'zip'];

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  // The BIN chunk header (length + type) follows the JSON chunk.
  const binLength = buffer.readUInt32LE(20 + jsonLength);
  const binStart = 20 + jsonLength + 8;
  return { json, bin: buffer.subarray(binStart, binStart + binLength) };
}

/** Which role each image plays, read from the material that references it. */
function classifyImages(json) {
  const roles = new Map();
  const assign = (textureIndex, role) => {
    if (textureIndex === undefined) return;
    const image = json.textures?.[textureIndex]?.source;
    if (image !== undefined) roles.set(image, role);
  };
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    assign(pbr.baseColorTexture?.index, 'baseColor');
    assign(pbr.metallicRoughnessTexture?.index, 'metallicRoughness');
    assign(material.normalTexture?.index, 'normal');
    assign(material.emissiveTexture?.index, 'baseColor');
    assign(material.occlusionTexture?.index, 'metallicRoughness');
  }
  return roles;
}

function align4(value) {
  return (value + 3) & ~3;
}

async function optimise(page, input, output) {
  const original = await readFile(input);
  const { json, bin } = parseGlb(original);
  const roles = classifyImages(json);

  // --- re-encode the images -------------------------------------------------
  const replacements = new Map();
  for (const [index, image] of (json.images ?? []).entries()) {
    if (image.bufferView === undefined) continue;
    const view = json.bufferViews[image.bufferView];
    const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const role = roles.get(index) ?? 'baseColor';
    const target = SIZES[role] ?? 512;

    const encoded = await page.evaluate(
      async ({ data, mime, size, quality }) => {
        const blob = new Blob([new Uint8Array(data)], { type: mime });
        const bitmap = await createImageBitmap(blob);
        // Never upscale: a map already smaller than the target is left alone
        // rather than re-encoded into something larger than it started.
        const edge = Math.min(size, Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((bitmap.width / Math.max(bitmap.width, bitmap.height)) * edge));
        canvas.height = Math.max(1, Math.round((bitmap.height / Math.max(bitmap.width, bitmap.height)) * edge));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const out = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        return {
          bytes: [...new Uint8Array(await out.arrayBuffer())],
          width: canvas.width,
          height: canvas.height,
        };
      },
      {
        data: [...bytes],
        mime: image.mimeType ?? 'image/png',
        size: target,
        quality: QUALITY,
      },
    );

    replacements.set(image.bufferView, Buffer.from(encoded.bytes));
    image.mimeType = 'image/jpeg';
    console.log(
      '    image ' + index + ' (' + role + ')  ' +
        Math.round(view.byteLength / 1024) + ' KB -> ' +
        Math.round(encoded.bytes.length / 1024) + ' KB  at ' + encoded.width + 'px',
    );
  }

  // --- rebuild the binary chunk --------------------------------------------
  /*
   * Views are repacked in their existing order. Accessors address data as
   * (bufferView, byteOffset-within-view), so a view can move anywhere as long
   * as it stays contiguous — only the view's own offset needs rewriting.
   */
  const chunks = [];
  let cursor = 0;
  for (const view of json.bufferViews ?? []) {
    const replacement = replacements.get(json.bufferViews.indexOf(view));
    const data = replacement ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const padded = align4(cursor);
    if (padded > cursor) {
      chunks.push(Buffer.alloc(padded - cursor));
      cursor = padded;
    }
    view.byteOffset = cursor;
    view.byteLength = data.length;
    chunks.push(Buffer.from(data));
    cursor += data.length;
  }
  const newBin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: newBin.length }];

  // --- write ----------------------------------------------------------------
  const jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([
    jsonChunk,
    Buffer.alloc(align4(jsonChunk.length) - jsonChunk.length, 0x20),
  ]);
  const binPadded = Buffer.concat([
    newBin,
    Buffer.alloc(align4(newBin.length) - newBin.length, 0),
  ]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'

  const result = Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, result);

  console.log(
    '  ' + path.basename(output) + '  ' +
      (original.length / 1024 / 1024).toFixed(2) + ' MB -> ' +
      (result.length / 1024 / 1024).toFixed(2) + ' MB  (' +
      Math.round((1 - result.length / original.length) * 100) + '% smaller)',
  );
  return { before: original.length, after: result.length };
}

async function main() {
  const args = process.argv.slice(2);
  const jobs = args.includes('--all')
    ? CAST.map((name) => ({
        input: 'assets/tripo/' + name + '-rigged.glb',
        output: 'public/tripo/' + name + '-rigged.glb',
      }))
    : [{ input: args[0], output: args[1] }];
  if (!jobs[0]?.input || !jobs[0]?.output) throw new Error('pass <input> <output>, or --all');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');

  let before = 0;
  let after = 0;
  for (const job of jobs) {
    console.log(job.input);
    const result = await optimise(page, job.input, job.output);
    before += result.before;
    after += result.after;
  }
  await browser.close();

  if (jobs.length > 1) {
    console.log(
      '\ntotal ' + (before / 1024 / 1024).toFixed(2) + ' MB -> ' +
        (after / 1024 / 1024).toFixed(2) + ' MB',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

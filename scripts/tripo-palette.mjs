#!/usr/bin/env node
/**
 * Extracts the real colour palette out of the generated Tripo assets.
 *
 * The point is to stop guessing at "matching the style". The characters carry
 * a baked albedo texture; the landscape is authored by hand. If the two are to
 * sit in one frame, the landscape's greens and browns have to come from the
 * same colour family as the ones Tripo actually painted — so measure them
 * rather than eyeball them.
 *
 * GLB images are embedded PNG/JPEG. Node has no decoder, so the bytes are
 * written out and a headless browser does the decode and the pixel read. The
 * clustering runs in OKLab, where euclidean distance tracks perceived
 * difference; clustering in sRGB collapses every dark shade into one bucket.
 *
 * Usage:
 *   node scripts/tripo-palette.mjs assets/tripo/pip.glb assets/tripo/tusk.glb
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = 'artifacts/palette';

/** Pulls every embedded image out of a GLB's binary chunk. */
function extractImages(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  // The BIN chunk header sits immediately after the JSON chunk.
  const binStart = 20 + jsonLength + 8;

  const out = [];
  for (const [i, image] of (json.images ?? []).entries()) {
    if (image.bufferView === undefined) continue;
    const view = json.bufferViews[image.bufferView];
    const start = binStart + (view.byteOffset ?? 0);
    const bytes = buffer.subarray(start, start + view.byteLength);
    const ext = (image.mimeType ?? 'image/png').includes('jpeg') ? 'jpg' : 'png';
    out.push({ index: i, ext, bytes });
  }
  return { images: out, materials: json.materials ?? [] };
}

const CLUSTER = function (src) {
  return (async () => {
    const img = new Image();
    img.src = src;
    await img.decode();

    // 128px of a 2048px map is plenty for a palette, and keeps k-means honest
    // about area rather than about detail.
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const srgbToOklab = (r8, g8, b8) => {
      const r = toLinear(r8 / 255);
      const g = toLinear(g8 / 255);
      const b = toLinear(b8 / 255);
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
      ];
    };

    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue; // ignore transparent padding
      const lab = srgbToOklab(data[i], data[i + 1], data[i + 2]);
      pixels.push([data[i], data[i + 1], data[i + 2], lab[0], lab[1], lab[2]]);
    }
    if (!pixels.length) return null;

    // k-means in OKLab, seeded by striding the pixel list so repeated runs
    // give the same palette.
    const K = 6;
    let centres = [];
    for (let k = 0; k < K; k += 1) {
      const p = pixels[Math.floor(((k + 0.5) * pixels.length) / K)];
      centres.push([p[3], p[4], p[5]]);
    }
    const assign = new Array(pixels.length).fill(0);
    let sums = [];
    for (let iter = 0; iter < 24; iter += 1) {
      for (let i = 0; i < pixels.length; i += 1) {
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k < K; k += 1) {
          const dl = pixels[i][3] - centres[k][0];
          const da = pixels[i][4] - centres[k][1];
          const db = pixels[i][5] - centres[k][2];
          const d = dl * dl + da * da + db * db;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        assign[i] = best;
      }
      sums = [];
      for (let k = 0; k < K; k += 1) sums.push([0, 0, 0, 0, 0, 0, 0]);
      for (let i = 0; i < pixels.length; i += 1) {
        const s = sums[assign[i]];
        for (let c = 0; c < 6; c += 1) s[c] += pixels[i][c];
        s[6] += 1;
      }
      centres = sums.map((s, k) => (s[6] ? [s[3] / s[6], s[4] / s[6], s[5] / s[6]] : centres[k]));
    }

    const hex = (r, g, b) =>
      '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

    const clusters = sums
      .filter((s) => s[6] > 0)
      .map((s) => {
        const L = s[3] / s[6];
        const A = s[4] / s[6];
        const B = s[5] / s[6];
        return {
          hex: hex(s[0] / s[6], s[1] / s[6], s[2] / s[6]),
          share: s[6] / pixels.length,
          L: Number(L.toFixed(3)),
          chroma: Number(Math.hypot(A, B).toFixed(3)),
          hue: Math.round((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
        };
      })
      .sort((a, b) => b.share - a.share);

    let sumL = 0;
    let sumC = 0;
    for (const p of pixels) {
      sumL += p[3];
      sumC += Math.hypot(p[4], p[5]);
    }
    return {
      clusters,
      meanL: Number((sumL / pixels.length).toFixed(3)),
      meanChroma: Number((sumC / pixels.length).toFixed(3)),
    };
  })();
};

async function run() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('pass one or more .glb paths');
  await mkdir(OUT, { recursive: true });

  const jobs = [];
  for (const file of files) {
    const label = path.basename(file, '.glb');
    const { images, materials } = extractImages(await readFile(file));
    for (const image of images) {
      const outFile = path.join(OUT, label + '-' + image.index + '.' + image.ext);
      await writeFile(outFile, image.bytes);
      jobs.push({ label, outFile, index: image.index, kb: Math.round(image.bytes.length / 1024) });
    }
    console.log(label + ': ' + images.length + ' image(s), ' + materials.length + ' material(s)');
    for (const m of materials) {
      const p = m.pbrMetallicRoughness ?? {};
      console.log(
        '  material "' + (m.name ?? '?') + '" roughness=' + (p.roughnessFactor ?? 1) +
          ' metallic=' + (p.metallicFactor ?? 1) +
          ' baseColorTex=' + (p.baseColorTexture ? 'yes' : 'no'),
      );
    }
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');

  const summary = [];
  for (const job of jobs) {
    const mime = job.outFile.endsWith('.jpg') ? 'jpeg' : 'png';
    const dataUrl =
      'data:image/' + mime + ';base64,' + (await readFile(job.outFile)).toString('base64');
    let result = null;
    try {
      result = await page.evaluate(CLUSTER, dataUrl);
    } catch (error) {
      // Tripo ships three maps per asset and only the first is a plain sRGB
      // albedo; the others are occasionally encodings the browser decoder
      // rejects. Losing a roughness map costs the palette nothing.
      console.log(job.label + '#' + job.index + ': undecodable');
      continue;
    }
    if (!result) {
      console.log(job.label + '#' + job.index + ': fully transparent');
      continue;
    }
    summary.push({ label: job.label, ...result });
    console.log('\n' + job.label + ' image ' + job.index + ' (' + job.kb + ' KB)');
    console.log('  mean L ' + result.meanL + '   mean chroma ' + result.meanChroma);
    for (const c of result.clusters) {
      console.log(
        '  ' + c.hex + '  ' + (c.share * 100).toFixed(1).padStart(5) + '%  L ' + c.L.toFixed(2) +
          '  C ' + c.chroma.toFixed(3) + '  hue ' + String(c.hue).padStart(3),
      );
    }
  }

  await writeFile(path.join(OUT, 'palette.json'), JSON.stringify(summary, null, 2));
  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

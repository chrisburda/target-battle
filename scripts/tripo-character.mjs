#!/usr/bin/env node
/**
 * One-command Tripo character pipeline.
 *
 * Generates a model, waits for it, downloads the GLB, and reports whether the
 * result is actually shippable. It talks to the REST API directly rather than
 * going through the packaged generator script, because that script has three
 * failure modes on this machine:
 *
 *   1. It is Python, and there is no system `python3` here (the Windows Store
 *      alias stub intercepts it). Running it needs `uv run --python 3.14`.
 *   2. Its `--download` sends the `Authorization` header to Tripo's presigned
 *      CloudFront URL, which rejects it with HTTP 403. The signed URLs need no
 *      auth at all, and last ~30 days rather than minutes.
 *   3. `type: conversion` answers `code 1003 request body is malformed` for
 *      every body shape. `highpoly_to_lowpoly` is the working decimator, and
 *      the right tool anyway.
 *
 * Raw Tripo output is far too heavy to ship — expect seven figures of triangles
 * and a 4096px texture — so `--face-limit` is applied at generation time and
 * the triangle count is printed at the end. Check it before calling an asset
 * done.
 *
 * Usage:
 *   TRIPO_API_KEY=... node scripts/tripo-character.mjs --name pip \
 *     --prompt "..." [--negative "..."] [--face-limit 20000] [--out assets/tripo]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.tripo3d.ai/v2/openapi';

function parseArgs(argv) {
  const args = {
    name: 'character',
    prompt: '',
    negative: '',
    faceLimit: 20000,
    out: 'assets/tripo',
    modelVersion: 'v3.1-20260211',
    timeout: 900,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--name') args.name = argv[++i];
    else if (flag === '--prompt') args.prompt = argv[++i];
    else if (flag === '--negative') args.negative = argv[++i];
    else if (flag === '--face-limit') args.faceLimit = Number(argv[++i]);
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--model-version') args.modelVersion = argv[++i];
    else if (flag === '--timeout') args.timeout = Number(argv[++i]);
  }
  return args;
}

async function api(key, method, endpoint, body) {
  const response = await fetch(API + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${endpoint} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    const hint =
      response.status === 401
        ? '\n  The key was rejected by Tripo itself. Check it is an API key with credit on the account.'
        : '';
    throw new Error(
      `${method} ${endpoint} -> HTTP ${response.status} code ${json.code}: ${json.message ?? text}${hint}`,
    );
  }
  return json.data;
}

async function waitForTask(key, taskId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastProgress = -1;
  while (Date.now() < deadline) {
    const task = await api(key, 'GET', `/task/${taskId}`);
    if (task.progress !== lastProgress) {
      lastProgress = task.progress;
      process.stdout.write(`\r  ${task.status} ${task.progress ?? 0}%   `);
    }
    if (task.status === 'success') {
      process.stdout.write('\n');
      return task;
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(task.status)) {
      process.stdout.write('\n');
      throw new Error(`task ${taskId} ended as ${task.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`task ${taskId} timed out`);
}

/** Pulls the first usable model URL out of a finished task's result block. */
function modelUrlFrom(task) {
  const result = task.result ?? {};
  for (const key of ['pbr_model', 'model', 'base_model', 'rigged_model']) {
    const entry = result[key];
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (url) return { key, url };
  }
  throw new Error('no model URL in task result: ' + JSON.stringify(result).slice(0, 300));
}

/**
 * Counts triangles by reading the GLB's JSON chunk.
 *
 * Cheaper than pulling in a loader, and the number is the whole point: an
 * asset that looks finished at 2M triangles is not finished.
 */
function inspectGlb(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) return null;
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));

  let triangles = 0;
  for (const meshDef of json.meshes ?? []) {
    for (const primitive of meshDef.primitives ?? []) {
      const accessor =
        primitive.indices !== undefined
          ? json.accessors?.[primitive.indices]
          : json.accessors?.[primitive.attributes?.POSITION];
      if (accessor?.count) triangles += accessor.count / 3;
    }
  }
  return {
    triangles: Math.round(triangles),
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    images: json.images?.length ?? 0,
    animations: json.animations?.length ?? 0,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.TRIPO_API_KEY;
  if (!key) throw new Error('TRIPO_API_KEY is not set');
  if (!args.prompt) throw new Error('--prompt is required');

  await mkdir(args.out, { recursive: true });

  console.log(`generating "${args.name}"`);
  const submit = await api(key, 'POST', '/task', {
    type: 'text_to_model',
    prompt: args.prompt,
    ...(args.negative ? { negative_prompt: args.negative } : {}),
    model_version: args.modelVersion,
    texture_quality: 'detailed',
    geometry_quality: 'detailed',
    face_limit: args.faceLimit,
  });

  const taskId = submit.task_id;
  console.log(`  task ${taskId}`);
  const task = await waitForTask(key, taskId, args.timeout);

  const { key: which, url } = modelUrlFrom(task);
  // No auth header here: the presigned URL rejects one with 403.
  const download = await fetch(url);
  if (!download.ok) throw new Error(`download failed: HTTP ${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());

  const file = path.join(args.out, `${args.name}.glb`);
  await writeFile(file, buffer);
  await writeFile(
    path.join(args.out, `${args.name}.task.json`),
    JSON.stringify({ taskId, prompt: args.prompt, source: which, result: task.result }, null, 2),
  );

  const stats = inspectGlb(buffer);
  console.log(`  -> ${file}`);
  console.log(`     ${(buffer.length / 1024 / 1024).toFixed(2)} MB from ${which}`);
  if (stats) {
    console.log(
      `     ${stats.triangles.toLocaleString()} tris · ${stats.meshes} mesh(es) · ` +
        `${stats.materials} material(s) · ${stats.images} texture(s) · ${stats.animations} clip(s)`,
    );
    if (stats.triangles > 60000) {
      console.log('     NOTE: too heavy to ship. Decimate with highpoly_to_lowpoly.');
    }
  }
  console.log(`     task id kept for decimation: ${taskId}`);
}

run().catch((error) => {
  console.error('\n' + error.message);
  process.exit(1);
});

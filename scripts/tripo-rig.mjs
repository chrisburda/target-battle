#!/usr/bin/env node
/**
 * Rigs an existing Tripo generation task and reports the skeleton it produced.
 *
 * The version choice is the quality lever, and it differs by body plan:
 * bipeds want `v1.0-20240301`, which yields a proper anatomical skeleton with
 * named limb chains. The v2.x "limb chain" rigger produces asymmetric junk on
 * humanoids. Creatures are the other way round.
 *
 * `riggable: true` does NOT guarantee a usable rig — auto-rigging can silently
 * emit a degenerate skeleton (a biped with one arm and no legs has been seen in
 * practice), and every retarget onto it inherits the damage. So this prints the
 * full bone list and flags missing limbs rather than trusting the flag.
 *
 * Usage:
 *   TRIPO_API_KEY=... node scripts/tripo-rig.mjs --task <generation-task-id> --name pip
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.tripo3d.ai/v2/openapi';

function parseArgs(argv) {
  const args = { task: '', name: 'character', out: 'assets/tripo', timeout: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--task') args.task = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
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
  const json = await response.json();
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`${method} ${endpoint} -> ${response.status} code ${json.code}: ${json.message}`);
  }
  return json.data;
}

async function waitFor(key, taskId, timeoutSeconds, label) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = -1;
  while (Date.now() < deadline) {
    const task = await api(key, 'GET', `/task/${taskId}`);
    if (task.progress !== last) {
      last = task.progress;
      process.stdout.write(`\r  ${label} ${task.status} ${task.progress ?? 0}%   `);
    }
    if (task.status === 'success') {
      process.stdout.write('\n');
      return task;
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(task.status)) {
      process.stdout.write('\n');
      throw new Error(`${label} ended as ${task.status}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`${label} timed out`);
}

function modelUrlFrom(task) {
  const result = task.result ?? {};
  for (const k of ['rigged_model', 'pbr_model', 'model', 'base_model']) {
    const entry = result[k];
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (url) return { key: k, url };
  }
  throw new Error('no model URL: ' + JSON.stringify(result).slice(0, 300));
}

/** Reads the GLB JSON chunk and returns skeleton facts, not just a pass/fail. */
function inspectRig(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const nodes = json.nodes ?? [];
  const skins = json.skins ?? [];
  const bones = new Set();
  for (const skin of skins) for (const j of skin.joints ?? []) bones.add(nodes[j]?.name ?? `node${j}`);

  const names = [...bones];
  const has = (re) => names.filter((n) => re.test(n)).length;
  return {
    boneCount: names.length,
    bones: names,
    animations: (json.animations ?? []).map((a) => a.name),
    limbs: {
      leftArm: has(/^L_.*(Upperarm|Forearm|Hand|Arm)/i),
      rightArm: has(/^R_.*(Upperarm|Forearm|Hand|Arm)/i),
      leftLeg: has(/^L_.*(Thigh|Calf|Foot|Leg)/i),
      rightLeg: has(/^R_.*(Thigh|Calf|Foot|Leg)/i),
      head: has(/head/i),
      spine: has(/spine/i),
    },
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.TRIPO_API_KEY;
  if (!key) throw new Error('TRIPO_API_KEY is not set');
  if (!args.task) throw new Error('--task <generation-task-id> is required');
  await mkdir(args.out, { recursive: true });

  console.log('prerig check');
  const pre = await api(key, 'POST', '/task', {
    type: 'animate_prerigcheck',
    original_model_task_id: args.task,
  });
  const preTask = await waitFor(key, pre.task_id, args.timeout, 'prerigcheck');
  const riggable = preTask.output?.riggable ?? preTask.result?.riggable;
  const rigType = preTask.output?.rig_type ?? preTask.result?.rig_type ?? 'biped';
  console.log(`  riggable=${riggable}  rig_type=${rigType}`);

  // Bipeds need the v1.0 rigger; the v2.x limb-chain rigger produces
  // asymmetric skeletons on humanoids. Creatures are the reverse.
  const rigVersion = rigType === 'biped' ? 'v1.0-20240301' : 'v2.5-20260210';
  console.log(`rigging with ${rigVersion} as ${rigType}`);
  const rig = await api(key, 'POST', '/task', {
    type: 'animate_rig',
    original_model_task_id: args.task,
    rig_type: rigType,
    model_version: rigVersion,
    spec: 'tripo',
    out_format: 'glb',
  });
  const rigTask = await waitFor(key, rig.task_id, args.timeout, 'rig');

  const { url } = modelUrlFrom(rigTask);
  const download = await fetch(url); // presigned: no auth header
  const buffer = Buffer.from(await download.arrayBuffer());
  const file = path.join(args.out, `${args.name}-rigged.glb`);
  await writeFile(file, buffer);

  const rigInfo = inspectRig(buffer);
  await writeFile(
    path.join(args.out, `${args.name}-rig.json`),
    JSON.stringify({ rigTaskId: rig.task_id, rigType, rigVersion, ...rigInfo }, null, 2),
  );

  console.log(`  -> ${file}  (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`     ${rigInfo.boneCount} bones`);
  console.log(`     limbs: ${JSON.stringify(rigInfo.limbs)}`);
  const l = rigInfo.limbs;
  const degenerate = !l.leftArm || !l.rightArm || !l.leftLeg || !l.rightLeg || !l.head;
  console.log(degenerate ? '     WARNING: skeleton is missing limbs — do not retarget onto it.' : '     skeleton looks complete.');
  console.log(`     rig task id: ${rig.task_id}`);
}

run().catch((error) => {
  console.error('\n' + error.message);
  process.exit(1);
});

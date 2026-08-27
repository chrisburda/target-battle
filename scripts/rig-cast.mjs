#!/usr/bin/env node
/**
 * Rigs every generated fighter that is not rigged yet.
 *
 * Sequential, and skips anything already on disk, so it is safe to re-run
 * after an interruption — rigging is the slowest step in the pipeline and
 * losing a finished skeleton to a crash halfway through the set is expensive
 * in both time and credits.
 *
 * The task ids come from the `.task.json` each generation writes beside its
 * GLB, so there is nothing to keep in sync by hand.
 *
 * Usage: TRIPO_API_KEY=... node scripts/rig-cast.mjs [name ...]
 */
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'assets/tripo';
const CAST = ['pip', 'bruno', 'tusk', 'sly', 'bunker', 'zip'];

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

  for (const name of CAST) {
    if (only.length && !only.includes(name)) continue;
    const rigged = path.join(OUT, name + '-rigged.glb');
    if (await exists(rigged)) {
      console.log('skip ' + name + ' (already rigged)');
      continue;
    }
    const meta = JSON.parse(await readFile(path.join(OUT, name + '.task.json'), 'utf8'));
    console.log('\n=== ' + name + ' (task ' + meta.taskId + ') ===');
    try {
      await run(['scripts/tripo-rig.mjs', '--task', meta.taskId, '--name', name, '--out', OUT]);
    } catch (error) {
      // One refusal should not cost the rest of the queue; rigging is the
      // step most likely to reject a given mesh, and which ones it rejects is
      // itself the useful result.
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

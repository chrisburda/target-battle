#!/usr/bin/env node
/**
 * Reports what is actually inside a GLB, without loading three.
 *
 * Written because integrating a generated asset means answering a handful of
 * questions the file will not volunteer — which way is forward, how tall is it
 * in its own units, how much of its weight is texture, does the skin cover the
 * whole mesh — and guessing any of them costs a full render cycle to disprove.
 *
 * Usage: node scripts/glb-inspect.mjs assets/tripo/pip-rigged.glb
 */
import { readFile } from 'node:fs/promises';

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  return { json, binStart: 20 + jsonLength + 8 };
}

/** Accessor min/max are mandatory for POSITION, so bounds need no bin read. */
function meshBounds(json) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      for (let i = 0; i < 3; i += 1) {
        box.min[i] = Math.min(box.min[i], accessor.min[i]);
        box.max[i] = Math.max(box.max[i], accessor.max[i]);
      }
    }
  }
  return box;
}

const file = process.argv[2];
if (!file) throw new Error('pass a .glb path');
const buffer = await readFile(file);
const { json } = parseGlb(buffer);

const box = meshBounds(json);
const size = box.max.map((v, i) => v - box.min[i]);
const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v));

console.log(file);
console.log('  size ' + (buffer.length / 1024 / 1024).toFixed(2) + ' MB');
console.log(
  '  bounds  x ' + fmt(box.min[0]) + '..' + fmt(box.max[0]) +
    '   y ' + fmt(box.min[1]) + '..' + fmt(box.max[1]) +
    '   z ' + fmt(box.min[2]) + '..' + fmt(box.max[2]),
);
console.log('  extent  ' + size.map(fmt).join(' x ') + '   (tallest axis: ' +
  ['x', 'y', 'z'][size.indexOf(Math.max(...size))] + ')');

let triangles = 0;
for (const mesh of json.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    const accessor =
      primitive.indices !== undefined
        ? json.accessors?.[primitive.indices]
        : json.accessors?.[primitive.attributes?.POSITION];
    if (accessor?.count) triangles += accessor.count / 3;
  }
}
console.log('  meshes ' + (json.meshes?.length ?? 0) + '  tris ' + Math.round(triangles).toLocaleString() +
  '  nodes ' + (json.nodes?.length ?? 0) + '  skins ' + (json.skins?.length ?? 0) +
  '  animations ' + (json.animations?.length ?? 0));

// Where the bytes are. Textures dominate these files by an order of magnitude,
// and that ratio decides whether the fix is decimation or downscaling.
let imageBytes = 0;
console.log('  images:');
for (const [i, image] of (json.images ?? []).entries()) {
  const view = json.bufferViews?.[image.bufferView];
  const bytes = view?.byteLength ?? 0;
  imageBytes += bytes;
  console.log(
    '    ' + i + '  ' + (image.mimeType ?? '?') + '  ' + Math.round(bytes / 1024) + ' KB',
  );
}
console.log(
  '  texture bytes ' + Math.round(imageBytes / 1024) + ' KB of ' +
    Math.round(buffer.length / 1024) + ' KB  (' +
    Math.round((imageBytes / buffer.length) * 100) + '%)',
);

for (const material of json.materials ?? []) {
  const pbr = material.pbrMetallicRoughness ?? {};
  console.log(
    '  material "' + (material.name ?? '?') + '"  base=' + (pbr.baseColorTexture ? 'tex' : 'factor') +
      '  mr=' + (pbr.metallicRoughnessTexture ? 'tex' : 'factor') +
      '  normal=' + (material.normalTexture ? 'tex' : 'none') +
      '  doubleSided=' + Boolean(material.doubleSided),
  );
}

// The root of the node forest, plus anything that is not a bone, so the
// loader knows what it is being handed before it is handed it.
const childOf = new Set();
for (const node of json.nodes ?? []) for (const child of node.children ?? []) childOf.add(child);
const roots = (json.nodes ?? []).map((_, i) => i).filter((i) => !childOf.has(i));
console.log('  root nodes: ' + roots.map((i) => json.nodes[i].name ?? '(unnamed)').join(', '));

for (const [i, node] of (json.nodes ?? []).entries()) {
  if (node.mesh === undefined) continue;
  console.log(
    '  mesh node "' + (node.name ?? i) + '"' +
      (node.skin !== undefined ? ' skinned' : '') +
      (node.scale ? '  scale ' + node.scale.map(fmt).join(',') : '') +
      (node.rotation ? '  quat ' + node.rotation.map(fmt).join(',') : '') +
      (node.translation ? '  pos ' + node.translation.map(fmt).join(',') : ''),
  );
}

// Bone tree. A flat skeleton and a nested one look identical in a bone-name
// list and behave completely differently: rotating a shoulder only carries the
// hand with it if the hand is actually parented beneath it.
if (process.argv.includes('--tree')) {
  const nodes = json.nodes ?? [];
  const joints = new Set((json.skins ?? []).flatMap((skin) => skin.joints ?? []));
  const draw = (index, depth) => {
    const node = nodes[index];
    const mark = joints.has(index) ? '' : '  (not a joint)';
    console.log('  ' + '  '.repeat(depth) + (node.name ?? index) + mark);
    for (const child of node.children ?? []) draw(child, depth + 1);
  };
  console.log('  node tree:');
  for (const index of roots) draw(index, 1);
}

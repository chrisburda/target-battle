import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * World props built from the generated meshes.
 *
 * Only the families worth it. Props are drawn with InstancedMesh, so a family
 * costs instances x triangles every frame — grass is scattered six hundred
 * times, and a generated tuft at even a thousand triangles would spend more of
 * the budget on lawn than on the entire cast. Grass, flowers, mushrooms and
 * vines stay procedural; the five here are the low-count, high-presence ones
 * where a generated asset earns its weight.
 *
 * Unlike the fighters, these are handed to the prop kit as loose geometry
 * rather than as a scene: the kit merges by material and instances the result
 * itself, and it needs the buffers, not a hierarchy.
 */

/** Prop kit family id to the generated file name. */
const GENERATED: Record<string, string> = {
  palm: 'prop-palm',
  boulder: 'prop-boulder',
  cliffRock: 'prop-boulder',
  log: 'prop-log',
  bush: 'prop-bush',
  bamboo: 'prop-bamboo',
};

/**
 * Per-family corrections applied on top of the measured height match.
 *
 * Matching the procedural template's height is the right default and it is
 * wrong wherever the two are not the same kind of thing. The boulder templates
 * are clusters of three stones; the generated model is one stone. Height-match
 * those and every single rock comes out as tall as the group it replaced, which
 * is exactly what happened — the arena filled with boulders the size of the
 * fighters.
 *
 * `tint` multiplies the albedo. These were generated to the same prompt as
 * everything else and still came back paler than the measured stone the
 * landscape was graded to; a multiply pulls them back into it without
 * regenerating.
 */
const ADJUST: Record<string, { scale?: number; tint?: number; sink?: number }> = {
  // One stone standing in for a cluster of three.
  boulder: { scale: 0.52, tint: 0xa8a297 },
  cliffRock: { scale: 0.46, tint: 0xa8a297 },
  // Also a cluster template, though a looser one.
  bamboo: { scale: 0.9 },
  // Generated with an explicit "no visible pot or soil" negative and it came
  // back on a planter anyway. Burying an eighth of its height hides the base
  // and costs nothing — foliage is normally sunk a little regardless.
  bush: { sink: 0.22 },
  log: { tint: 0xbdb3a4, sink: 0.06 },
};

export type GeneratedPart = {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
};

const loader = new GLTFLoader();
const cache = new Map<string, THREE.Group>();
const pending = new Map<string, Promise<THREE.Group>>();

export function generatedPropIds(): string[] {
  return Object.keys(GENERATED);
}

export function hasGeneratedProp(id: string): boolean {
  return cache.has(GENERATED[id] ?? '');
}

export function generatedPropUrl(id: string): string {
  return import.meta.env.BASE_URL + 'tripo/' + GENERATED[id] + '.glb';
}

export async function preloadGeneratedProps(
  ids: readonly string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  // Several ids share a file — the cliff outcrops are the same boulder as the
  // ones on the surface — so de-duplicate by file, not by family.
  const files = [...new Set(ids.map((id) => GENERATED[id]).filter(Boolean))];
  const wanted = files.filter((file) => !cache.has(file));
  let loaded = 0;
  onProgress?.(0, wanted.length);

  await Promise.all(
    wanted.map(async (file) => {
      let request = pending.get(file);
      if (!request) {
        request = loader
          .loadAsync(import.meta.env.BASE_URL + 'tripo/' + file + '.glb')
          .then((gltf) => gltf.scene as THREE.Group);
        pending.set(file, request);
      }
      try {
        cache.set(file, await request);
      } catch (error) {
        // Per-asset, for the reason spelled out in the fighter factory. This
        // one matters most: props are generated a family at a time, so a
        // half-finished set is the normal state mid-pipeline.
        console.warn('generated prop failed to load: ' + file, error);
      } finally {
        pending.delete(file);
        loaded += 1;
        onProgress?.(loaded, wanted.length);
      }
    }),
  );
}

/**
 * Geometry and materials for one family, sized to match what it replaces.
 *
 * `targetHeight` is measured from the procedural template rather than written
 * down, so the scatter's own scale ranges — a palm placed between 1.3x and
 * 2.05x — keep meaning exactly what they meant before. Hard-coding a height
 * here would mean re-tuning every family's placement the first time a model was
 * regenerated at a different size.
 */
export function generatedPropParts(id: string, targetHeight: number): GeneratedPart[] {
  const source = cache.get(GENERATED[id] ?? '');
  if (!source) return [];

  const adjust = ADJUST[id] ?? {};
  source.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(source);
  const height = Math.max(0.001, box.max.y - box.min.y);
  const scale = (targetHeight / height) * (adjust.scale ?? 1);

  /*
   * Bake the transform into the buffers and sit the result on the origin.
   *
   * The prop kit composes an instance matrix per placement and expects
   * geometry that already stands at its own feet, centred on x and z. A
   * generated mesh carries its own node transform and an arbitrary origin, so
   * left alone every instance would be offset by however that file happened to
   * be authored.
   */
  const centreX = (box.max.x + box.min.x) / 2;
  const centreZ = (box.max.z + box.min.z) / 2;
  const matrix = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -centreX,
        -box.min.y - height * (adjust.sink ?? 0),
        -centreZ,
      ),
    );

  const parts: GeneratedPart[] = [];
  source.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(matrix.clone().multiply(mesh.matrixWorld));
    // The kit merges by material and never reads these; carrying them through
    // would only force every merge in the family to agree about them.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
    }
    const material = (mesh.material as THREE.MeshStandardMaterial).clone();
    material.envMapIntensity = 0.6;
    if (adjust.tint !== undefined) material.color.setHex(adjust.tint, THREE.SRGBColorSpace);
    parts.push({ geometry, material });
  });
  return parts;
}

export function disposeGeneratedProps(): void {
  for (const scene of cache.values()) {
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (!Array.isArray(material)) {
        material.map?.dispose();
        material.normalMap?.dispose();
        material.roughnessMap?.dispose();
        material.dispose();
      }
    });
  }
  cache.clear();
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AmmoDef } from '../../game/types';
import type { AmmoModel } from './AmmoFactory';
import type { MaterialLibrary } from '../MaterialLibrary';

/**
 * Ammunition built from the Tripo-generated props.
 *
 * Four of the five rounds come from here. The river rock does not: it was
 * generated twice and failed twice — once as a featureless grey sphere, once as
 * a photoreal lichened granite boulder that belonged to a different game
 * entirely — and the hand-built faceted rock is simply better at being a
 * stylised rock. Whether an asset is generated is not the point; whether it
 * reads is. `GENERATED` is the list of the ones that do.
 */

/** Ammo ids with a generated model worth using, mapped to their file name. */
const GENERATED: Record<string, string> = {
  coconut: 'ammo-coconut',
  melon: 'ammo-melon',
  cluster: 'ammo-cluster',
  hive: 'ammo-hive',
};

/**
 * Bounding radius the built rounds are authored at.
 *
 * Everything downstream — the collision radius a projectile is given, the
 * counter-scale that keeps a held round the right size in a fighter's hand —
 * is tuned against this. Normalising the generated meshes to it means none of
 * that has to know which factory a round came from.
 */
const AUTHORED_RADIUS = 0.55;

const loader = new GLTFLoader();
const cache = new Map<string, THREE.Group>();
const pending = new Map<string, Promise<THREE.Group>>();

export function hasGeneratedAmmo(ammoId: string): boolean {
  return cache.has(ammoId);
}

export function generatedAmmoUrl(ammoId: string): string {
  return import.meta.env.BASE_URL + 'tripo/' + GENERATED[ammoId] + '.glb';
}

export async function preloadGeneratedAmmo(
  ammoIds: readonly string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const wanted = [...new Set(ammoIds)].filter((id) => GENERATED[id] && !cache.has(id));
  let loaded = 0;
  onProgress?.(0, wanted.length);

  await Promise.all(
    wanted.map(async (id) => {
      let request = pending.get(id);
      if (!request) {
        request = loader.loadAsync(generatedAmmoUrl(id)).then((gltf) => gltf.scene as THREE.Group);
        pending.set(id, request);
      }
      try {
        cache.set(id, await request);
      } catch (error) {
        // Per-asset, for the reason spelled out in the fighter factory: a
        // missing round should cost that round its model, nothing more.
        console.warn('generated ammo failed to load: ' + id, error);
      } finally {
        pending.delete(id);
        loaded += 1;
        onProgress?.(loaded, wanted.length);
      }
    }),
  );
}

/**
 * Builds one round.
 *
 * The returned root is what the projectile system caches and clones, so the
 * geometry and materials here are deliberately shared rather than copied —
 * unlike the fighters, a round never needs its own material, because nothing
 * flashes it.
 */
export function createGeneratedAmmoModel(
  materials: MaterialLibrary,
  def: AmmoDef,
): AmmoModel {
  const source = cache.get(def.id);
  if (!source) throw new Error('generated ammo for "' + def.id + '" was not preloaded');

  const root = new THREE.Group();
  root.name = 'ammo-generated-' + def.id;

  const model = source.clone(true);
  /*
   * Centre on the bounding box, then scale by the bounding sphere.
   *
   * A round spins about its own origin in flight. Generated meshes sit on a
   * ground plane at y = 0, so left alone they would orbit a point at their own
   * feet rather than tumble.
   */
  const box = new THREE.Box3().setFromObject(model);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.001, box.getSize(new THREE.Vector3()).length() / 2);
  const scale = AUTHORED_RADIUS / radius;

  model.position.copy(centre).multiplyScalar(-1);
  const holder = new THREE.Group();
  holder.scale.setScalar(scale);
  holder.add(model);
  root.add(holder);

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = materials.opaqueDepth;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (!Array.isArray(material)) material.envMapIntensity = 0.6;
  });

  // Geometry belongs to the cached source every other round is cloned from, so
  // nothing here is handed over as owned.
  return { root, radius: AUTHORED_RADIUS, geometries: [] };
}

export function disposeGeneratedAmmo(): void {
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

export function generatedAmmoIds(): string[] {
  return Object.keys(GENERATED);
}

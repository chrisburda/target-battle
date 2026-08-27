import * as THREE from 'three';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { AnimalDef } from '../../game/types';
import { createFighterModel, type FighterModel } from './AnimalFactory';
import {
  createGeneratedFighterModel,
  hasGeneratedFighter,
  preloadGeneratedFighters,
} from './GeneratedFighterFactory';
import { createAmmoModel, type AmmoModel } from './AmmoFactory';
import {
  createGeneratedAmmoModel,
  generatedAmmoIds,
  hasGeneratedAmmo,
  preloadGeneratedAmmo,
} from './GeneratedAmmoFactory';
import type { AmmoDef } from '../../game/types';
import { generatedPropIds, preloadGeneratedProps } from './GeneratedPropFactory';

/**
 * Which cast the game builds its fighters from.
 *
 * Two complete sets exist and neither is strictly better. The built ones are
 * code — no download, a face that blinks and emotes, and geometry that can be
 * tuned in a single edit. The generated ones look considerably better and move
 * on a real skeleton, at the cost of a few megabytes and any expression at all.
 *
 * Rather than pick one, this is a switch the setup screen exposes, so the two
 * can be compared in the same match on the same terrain — which is the only
 * comparison that settles anything.
 */
export type FighterModelSource = 'built' | 'generated';

let source: FighterModelSource = 'built';

export function setFighterModelSource(next: FighterModelSource): void {
  source = next;
}

export function getFighterModelSource(): FighterModelSource {
  return source;
}

/**
 * Fetches everything the generated source needs: cast, ammo and world props.
 *
 * All three, because all three have to be in hand before the moment they are
 * used and none of those moments can wait. The world is built the instant a
 * match starts; a round is picked mid-turn from a dock the player can change
 * their mind in. Only the fighters are selective — pulling all six to play a
 * two-hander would triple the wait for nothing.
 */
export async function prepareGeneratedAssets(
  animalIds: readonly string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  if (source !== 'generated') return;
  /*
   * Ammo comes along with the cast, always all of it.
   *
   * A round is picked mid-turn from a dock the player can change their mind in,
   * so there is no useful moment later to fetch one — and they are small next
   * to a fighter. Progress counts them together so the readout matches what is
   * actually in flight.
   */
  const ammo = generatedAmmoIds();
  const props = generatedPropIds();
  const fighters = [...new Set(animalIds)];
  const total = fighters.length + ammo.length + props.length;
  let loaded = 0;
  const step = () => onProgress?.((loaded += 1), total);

  onProgress?.(0, total);
  // Requested one at a time so the readout advances per asset rather than in
  // lumps. Every loader caches and de-duplicates, so this costs nothing — two
  // prop families share one boulder and it is fetched once.
  await Promise.all([
    ...fighters.map((id) => preloadGeneratedFighters([id]).then(step)),
    ...ammo.map((id) => preloadGeneratedAmmo([id]).then(step)),
    ...props.map((id) => preloadGeneratedProps([id]).then(step)),
  ]);
}

/**
 * Builds one round from the current source.
 *
 * Falls back per round rather than per cast: the river rock has no usable
 * generated model and never will, so it stays hand-built even with the switch
 * on. Mixing them is fine — they were graded to the same palette.
 */
export function createAmmo(materials: MaterialLibrary, ammo: AmmoDef): AmmoModel {
  if (source === 'generated' && hasGeneratedAmmo(ammo.id)) {
    return createGeneratedAmmoModel(ammo);
  }
  return createAmmoModel(materials, ammo);
}

/**
 * Frees a fighter model, by whichever rule that model follows.
 *
 * Every site that builds a fighter also tears one down — the match, the
 * character-select portrait, the roster avatar bake — and each was traversing
 * and disposing every buffer it found. That is correct for a built fighter and
 * destructive for a generated one, whose geometry is shared with the cache the
 * next clone will come from; the failure would not have shown until the second
 * HD match of a session, which is the worst kind.
 */
export function releaseFighterModel(model: FighterModel): void {
  model.root.removeFromParent();
  if (model.dispose) {
    model.dispose();
    return;
  }
  model.root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
  });
}

/**
 * Builds one fighter from the current source.
 *
 * Falls back to the built model when a generated one has not loaded. That is
 * not a nicety: the character-select portrait and the roster avatars build
 * models the moment the screen opens, well before any match has asked for a
 * download, and a throw there would take the whole setup screen down.
 */
export function createFighter(materials: MaterialLibrary, animal: AnimalDef): FighterModel {
  if (source === 'generated' && hasGeneratedFighter(animal.id)) {
    return createGeneratedFighterModel(materials, animal);
  }
  return createFighterModel(materials, animal);
}

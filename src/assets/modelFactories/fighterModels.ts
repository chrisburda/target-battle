import type { MaterialLibrary } from '../MaterialLibrary';
import type { AnimalDef } from '../../game/types';
import { createFighterModel, type FighterModel } from './AnimalFactory';
import {
  createGeneratedFighterModel,
  hasGeneratedFighter,
  preloadGeneratedFighters,
} from './GeneratedFighterFactory';

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

/** Fetches whatever the current source needs for these animals. */
export async function prepareFighterModels(
  animalIds: readonly string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  if (source !== 'generated') return;
  await preloadGeneratedFighters(animalIds, onProgress);
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

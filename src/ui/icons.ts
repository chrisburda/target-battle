import { getAnimal } from '../game/roster';

/**
 * Baked portraits of the actual 3D fighters, keyed by animal id.
 *
 * Populated once at startup by CharacterIcons. Until then — and if a render
 * ever fails — the drawn tokens below stand in, so the interface is never
 * missing an avatar.
 */
const portraits = new Map<string, string>();

export function setCreaturePortrait(animalId: string, dataUrl: string): void {
  portraits.set(animalId, dataUrl);
}

export function hasCreaturePortrait(animalId: string): boolean {
  return portraits.has(animalId);
}

/**
 * Inline SVG creature tokens and ammo glyphs.
 *
 * The roster needs a per-fighter icon that survives at 34px on a phone. Text
 * initials read as a spreadsheet and emoji render differently on every
 * platform, so each species gets a hand-built silhouette using its own palette:
 * the same colours the 3D model uses, which ties the HUD to the world.
 */

function svg(body: string, size = 34): string {
  return (
    '<svg viewBox="0 0 40 40" width="' +
    size +
    '" height="' +
    size +
    '" aria-hidden="true" focusable="false">' +
    body +
    '</svg>'
  );
}

function hex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

/**
 * Avatar for a fighter.
 *
 * Returns the baked render of the real model when one exists. A separately
 * drawn icon can drift away from the character it stands for; this cannot.
 */
export function animalIcon(animalId: string, size = 34): string {
  const portrait = portraits.get(animalId);
  if (portrait) {
    return (
      '<img class="creature-portrait" src="' +
      portrait +
      '" width="' +
      size +
      '" height="' +
      size +
      '" alt="" aria-hidden="true" />'
    );
  }
  return drawnAnimalIcon(animalId, size);
}

/** Hand-drawn fallback, used before the renders exist. */
function drawnAnimalIcon(animalId: string, size = 34): string {
  const animal = getAnimal(animalId);
  const body = hex(animal.palette.body);
  const belly = hex(animal.palette.belly);
  const accent = hex(animal.palette.accent);
  const eye = '#151515';

  switch (animalId) {
    case 'gecko':
      return svg(
        '<path d="M6 30 Q4 22 10 18 Q6 12 12 9 Q18 6 24 10 Q32 8 34 16 Q36 26 28 31 Z" fill="' + body + '"/>' +
          '<path d="M12 9 L14 4 M18 7 L20 2 M24 8 L27 3" stroke="' + accent + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<circle cx="16" cy="18" r="5" fill="' + belly + '"/><circle cx="27" cy="18" r="5" fill="' + belly + '"/>' +
          '<circle cx="17" cy="19" r="2.4" fill="' + eye + '"/><circle cx="28" cy="19" r="2.4" fill="' + eye + '"/>' +
          '<path d="M14 28 Q20 32 27 28" stroke="' + eye + '" stroke-width="2" fill="none" stroke-linecap="round"/>',
        size,
      );
    case 'frog':
      return svg(
        '<ellipse cx="20" cy="25" rx="16" ry="12" fill="' + body + '"/>' +
          '<circle cx="11" cy="13" r="7" fill="' + body + '"/><circle cx="29" cy="13" r="7" fill="' + body + '"/>' +
          '<circle cx="11" cy="13" r="4.4" fill="' + belly + '"/><circle cx="29" cy="13" r="4.4" fill="' + belly + '"/>' +
          '<circle cx="12" cy="14" r="2.3" fill="' + eye + '"/><circle cx="30" cy="14" r="2.3" fill="' + eye + '"/>' +
          '<path d="M8 26 Q20 36 32 26" stroke="' + eye + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
          '<circle cx="9" cy="31" r="2.2" fill="' + accent + '"/><circle cx="31" cy="31" r="2.2" fill="' + accent + '"/>',
        size,
      );
    case 'boar':
      return svg(
        '<path d="M4 10 L11 16 L6 17 Z M36 10 L29 16 L34 17 Z" fill="' + body + '"/>' +
          '<ellipse cx="20" cy="22" rx="15" ry="13" fill="' + body + '"/>' +
          '<path d="M14 6 L16 12 M20 4 L21 11 M26 6 L25 12" stroke="' + accent + '" stroke-width="2.4" stroke-linecap="round"/>' +
          '<ellipse cx="20" cy="30" rx="7" ry="5.4" fill="' + belly + '"/>' +
          '<circle cx="17.4" cy="30" r="1.5" fill="' + eye + '"/><circle cx="22.6" cy="30" r="1.5" fill="' + eye + '"/>' +
          '<circle cx="14" cy="20" r="2.1" fill="' + eye + '"/><circle cx="26" cy="20" r="2.1" fill="' + eye + '"/>' +
          '<path d="M12 32 Q9 27 12 24 M28 32 Q31 27 28 24" stroke="#f2e8d5" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
        size,
      );
    case 'raccoon':
      return svg(
        '<path d="M5 8 L13 14 L6 17 Z M35 8 L27 14 L34 17 Z" fill="' + body + '"/>' +
          '<circle cx="20" cy="21" r="14" fill="' + body + '"/>' +
          '<path d="M6 18 Q20 12 34 18 Q34 25 20 26 Q6 25 6 18 Z" fill="' + accent + '"/>' +
          '<circle cx="14" cy="20" r="3.4" fill="' + belly + '"/><circle cx="26" cy="20" r="3.4" fill="' + belly + '"/>' +
          '<circle cx="14" cy="20" r="1.9" fill="' + eye + '"/><circle cx="26" cy="20" r="1.9" fill="' + eye + '"/>' +
          '<ellipse cx="20" cy="30" rx="5.4" ry="4" fill="' + belly + '"/>' +
          '<circle cx="20" cy="28.6" r="1.9" fill="' + eye + '"/>',
        size,
      );
    case 'tortoise':
      return svg(
        '<path d="M3 30 Q3 12 20 12 Q37 12 37 30 Z" fill="' + accent + '"/>' +
          '<path d="M20 12 L20 30 M8 20 L32 20 M11 14 L11 30 M29 14 L29 30" stroke="' + body + '" stroke-width="2.2" fill="none"/>' +
          '<path d="M3 30 Q20 35 37 30 L37 32 Q20 37 3 32 Z" fill="' + body + '"/>' +
          '<circle cx="20" cy="8" r="6" fill="' + belly + '"/>' +
          '<circle cx="17.6" cy="7" r="1.7" fill="' + eye + '"/><circle cx="22.4" cy="7" r="1.7" fill="' + eye + '"/>' +
          '<path d="M17 11 Q20 13 23 11" stroke="' + eye + '" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
        size,
      );
    case 'toucan':
      return svg(
        '<circle cx="16" cy="21" r="13" fill="' + body + '"/>' +
          '<path d="M26 15 Q40 17 38 24 Q30 27 25 25 Z" fill="' + accent + '"/>' +
          '<path d="M36 22 Q39 22.6 38 24 Z" fill="' + eye + '"/>' +
          '<ellipse cx="19" cy="17" rx="6" ry="5" fill="' + belly + '"/>' +
          '<circle cx="20" cy="17" r="2.5" fill="' + eye + '"/>' +
          '<ellipse cx="13" cy="27" rx="6.6" ry="5.4" fill="' + belly + '"/>' +
          '<path d="M4 26 L1 30 L5 31 Z" fill="' + accent + '"/>',
        size,
      );
    default:
      return svg('<circle cx="20" cy="20" r="14" fill="' + body + '"/>', size);
  }
}

export function ammoIcon(ammoId: string, size = 26): string {
  switch (ammoId) {
    case 'rock':
      return svg(
        '<path d="M7 27 L5 16 L13 8 L26 6 L35 15 L32 29 L18 33 Z" fill="#8d8577"/>' +
          '<path d="M13 8 L18 18 L32 29 M18 18 L5 16" stroke="#5f594e" stroke-width="2" fill="none"/>',
        size,
      );
    case 'coconut':
      return svg(
        '<circle cx="20" cy="20" r="14" fill="#7a4a26"/>' +
          '<circle cx="15" cy="16" r="2.4" fill="#3a2210"/><circle cx="24" cy="15" r="2.4" fill="#3a2210"/>' +
          '<circle cx="20" cy="23" r="2.4" fill="#3a2210"/>' +
          '<path d="M8 26 Q20 32 32 26" stroke="#c79b73" stroke-width="2.4" fill="none"/>',
        size,
      );
    case 'melon':
      return svg(
        '<ellipse cx="20" cy="22" rx="15" ry="13" fill="#3f7d2a"/>' +
          '<path d="M20 9 L20 35 M11 12 Q7 22 11 32 M29 12 Q33 22 29 32" stroke="#1f4f18" stroke-width="2.4" fill="none"/>' +
          '<path d="M20 9 L22 4" stroke="#e8574a" stroke-width="2.6" stroke-linecap="round"/>',
        size,
      );
    case 'cluster':
      return svg(
        '<ellipse cx="20" cy="21" rx="9" ry="15" fill="#6a4a2b"/>' +
          '<path d="M11 12 L20 16 L29 12 M11 20 L20 24 L29 20 M13 28 L20 31 L27 28" stroke="#a87a45" stroke-width="2.4" fill="none"/>' +
          '<path d="M20 6 L20 2" stroke="#a87a45" stroke-width="2.4" stroke-linecap="round"/>',
        size,
      );
    case 'hive':
      return svg(
        '<path d="M20 4 Q33 12 33 24 Q33 34 20 36 Q7 34 7 24 Q7 12 20 4 Z" fill="#c98a2b"/>' +
          '<path d="M10 15 Q20 12 30 15 M8 22 Q20 18 32 22 M9 29 Q20 26 31 29" stroke="#ffd166" stroke-width="2.2" fill="none"/>' +
          '<ellipse cx="20" cy="30" rx="3.4" ry="2.6" fill="#3a2a10"/>',
        size,
      );
    default:
      return svg('<circle cx="20" cy="20" r="13" fill="#8d8577"/>', size);
  }
}

export const ICON_WIND =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 18h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';

export const ICON_SOUND_ON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export const ICON_SOUND_OFF =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 10l5 5M21 10l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

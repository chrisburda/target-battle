import * as THREE from 'three';

/**
 * The shared colour language for the whole scene.
 *
 * The characters are Tripo-generated and carry a baked albedo texture; the
 * landscape is authored here in code. For the two to sit in one frame they
 * have to come out of the same colour family, and "looks about right" is not a
 * way to get there — a hand-picked grass green and a painted one miss by more
 * than the eye can correct for once ACES has compressed both.
 *
 * So the anchors below are measured, not chosen. `scripts/tripo-palette.mjs`
 * decodes each generated GLB's albedo map and k-means clusters it in OKLab;
 * every constant here is a cluster centre from that run, with the asset and
 * population share recorded so the number can be re-derived. Re-run the script
 * after regenerating assets and the anchors can be refreshed against it.
 *
 * Everything downstream is stated in OKLCH — lightness, chroma, hue — because
 * that is the space the measurements live in and the space where "same family,
 * darker" is a single subtraction rather than three coupled ones.
 */

/* ------------------------------------------------------------------ OKLab */

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Linear-sRGB out of OKLCH. May land outside 0..1 — see `oklch`. */
function oklchToLinear(L: number, C: number, hueDegrees: number): [number, number, number] {
  const h = (hueDegrees * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  return r >= -0.0001 && r <= 1.0001 && g >= -0.0001 && g <= 1.0001 && b >= -0.0001 && b <= 1.0001;
}

/**
 * OKLCH to a THREE.Color, reducing chroma until the result fits sRGB.
 *
 * Clipping each channel independently is the obvious approach and it is wrong:
 * it shifts hue, so a too-saturated green clips toward yellow and stops
 * matching the family it was derived from. Binary-searching chroma instead
 * keeps hue and lightness exactly and gives up only the saturation that could
 * never have been displayed.
 */
export function oklch(L: number, C: number, hueDegrees: number): THREE.Color {
  let lo = 0;
  let hi = C;
  let rgb = oklchToLinear(L, C, hueDegrees);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 18; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, hueDegrees))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear(L, lo, hueDegrees);
  }
  const color = new THREE.Color();
  // Authored in display space, matching how the Tripo albedo textures are
  // sampled: three converts the map through SRGBColorSpace on upload, and
  // `setRGB` with SRGBColorSpace applies the identical transfer function.
  color.setRGB(
    Math.min(1, Math.max(0, toSrgb(rgb[0]))),
    Math.min(1, Math.max(0, toSrgb(rgb[1]))),
    Math.min(1, Math.max(0, toSrgb(rgb[2]))),
    THREE.SRGBColorSpace,
  );
  return color;
}

const RGB_SCRATCH = { r: 0, g: 0, b: 0 };

/**
 * Inverse of `oklch`, for auditing a colour that already exists.
 *
 * Reads through `getRGB(…, SRGBColorSpace)` rather than the `.r/.g/.b` fields
 * directly. Those fields hold linear values under three's colour management,
 * so linearising them again silently darkens everything — which turns an audit
 * into a generator of confident wrong numbers.
 */
export function toOklch(color: THREE.Color): { L: number; C: number; h: number } {
  color.getRGB(RGB_SCRATCH, THREE.SRGBColorSpace);
  const r = toLinear(RGB_SCRATCH.r);
  const g = toLinear(RGB_SCRATCH.g);
  const b = toLinear(RGB_SCRATCH.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    L,
    C: Math.hypot(A, B),
    h: (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360,
  };
}

/* -------------------------------------------------- measured Tripo anchors */

/**
 * Hue bands the generated assets actually occupy, in OKLab degrees.
 *
 * Every measured albedo cluster with meaningful chroma fell into one of three
 * bands, and the gaps between them are wide and empty. Authoring landscape
 * colour outside these bands is what makes a scene read as two art packs
 * stapled together, so the constants are here to be used rather than as
 * documentation.
 */
export const TRIPO_HUE = {
  /** Foliage. Pip's hide clustered 118–123; Bunker's shell moss at 107. */
  foliage: 119,
  /** Soil, bark, hide. Tusk 43–54, coconut husk 37–60, Bunker's shell 66–71. */
  earth: 52,
  /** Warm stone. Rock is near-neutral, so hue only tints it. */
  stone: 58,
  /** The one saturated accent in the cast: Bunker's headband, measured 31. */
  accent: 31,
} as const;

/**
 * Chroma ceiling as a function of lightness, fitted to the measured clusters.
 *
 * This is the single number that separates the two looks. Tripo's albedos
 * average 0.07–0.13 chroma and never exceed 0.163; the landscape as authored
 * ran far past that, which is why an acid-green ridge sat in front of a muted
 * gecko and refused to belong to it. Saturation also falls away in shadow —
 * Pip's lit hide measures C 0.163 at L 0.74 but only 0.082 at L 0.56 — so the
 * ceiling is a curve, not a constant, peaking in the midtones and collapsing
 * at both ends the way a painted map does.
 */
export function chromaCeiling(L: number): number {
  const peak = 0.68; // lightness of maximum saturation in the measured set
  const falloff = 1 - Math.min(1, Math.abs(L - peak) / 0.46) ** 1.6;
  return 0.028 + 0.138 * falloff;
}

/**
 * Pulls a colour into the measured envelope, keeping hue and lightness.
 *
 * Used to re-grade colours that are already right in intent — a specific
 * flower pink, a specific hazard red — without hand-editing every hex.
 */
export function intoEnvelope(color: THREE.Color, headroom = 1): THREE.Color {
  const { L, C, h } = toOklch(color);
  return oklch(L, Math.min(C, chromaCeiling(L) * headroom), h);
}

/* ------------------------------------------------------- landscape palette */

/**
 * A surface stated the way the terrain wants to read it: a lit value and the
 * value it falls to in full occlusion. Shading between the two happens per
 * vertex, so a single entry covers a whole strata band.
 */
export type Surface = { lit: THREE.Color; shade: THREE.Color };

function surface(L: number, C: number, hue: number, drop = 0.2): Surface {
  return {
    lit: oklch(L, Math.min(C, chromaCeiling(L)), hue),
    // Occluded earth loses saturation as well as lightness, and cools very
    // slightly — skylight is the only thing reaching into a crevice.
    shade: oklch(
      Math.max(0.06, L - drop),
      Math.min(C * 0.66, chromaCeiling(L - drop)),
      hue + 4,
    ),
  };
}

/**
 * The terrain's geological column, top to bottom.
 *
 * Lightness descends monotonically so the cliff reads as depth rather than as
 * stripes, and the hue walks from foliage green through earth into neutral
 * stone — the same journey Bunker's shell makes from moss to keratin, which is
 * where the ordering came from.
 */
export const GROUND = {
  /** Sunlit grass on the flat. Matched to Pip's lit hide, L 0.74 C 0.163. */
  grass: surface(0.72, 0.148, TRIPO_HUE.foliage, 0.24),
  /** Grass on a steep face; the same green with the light taken off it. */
  grassSteep: surface(0.58, 0.096, TRIPO_HUE.foliage - 2, 0.2),
  /*
   * Lightness zig-zags down the column rather than descending smoothly.
   *
   * A monotonic ramp is the intuitive way to state "deeper is darker" and it
   * produces no strata at all: the rows interpolate into one continuous
   * gradient and the cliff reads as a painted wall. Real sediment alternates,
   * and it is the alternation the eye picks up as distinct beds. Each band
   * still sits inside the measured Tripo envelope; only the ordering changed.
   */
  /** The band just under the turf, where roots darken the soil. */
  root: surface(0.38, 0.05, TRIPO_HUE.foliage - 34, 0.12),
  topsoil: surface(0.52, 0.086, TRIPO_HUE.earth - 4, 0.16),
  /** Tusk's hide, essentially: L 0.48 C 0.084 hue 46. */
  dirt: surface(0.4, 0.07, TRIPO_HUE.earth, 0.14),
  /** Bunker's shell mid-tone, L 0.55 C 0.089 hue 69. */
  clay: surface(0.58, 0.09, TRIPO_HUE.earth + 12, 0.18),
  /** Warm stone, most of the way to the generated rock's neutrality. */
  rock: surface(0.44, 0.022, TRIPO_HUE.stone, 0.14),
  /** Deep bedrock. The rock ammo measured C 0.002 — near-perfectly neutral. */
  bedrock: surface(0.36, 0.012, TRIPO_HUE.stone, 0.12),
  /** Blast scorch. Not black: burnt earth keeps a trace of its own hue. */
  scorch: oklch(0.24, 0.026, TRIPO_HUE.earth - 10),
  /** Subsoil freshly opened by a crater, before it weathers. */
  freshCut: oklch(0.6, 0.094, TRIPO_HUE.earth + 6),
} as const;

/**
 * Foliage and props.
 *
 * Three greens rather than one: canopy tops catch sky, undersides fall away,
 * and ground cover sits between them. Spreading a single hue across that range
 * by lightness alone is what made the old kit read as plastic.
 */
export const FLORA = {
  canopyLit: oklch(0.7, 0.132, TRIPO_HUE.foliage + 3),
  canopy: oklch(0.6, 0.108, TRIPO_HUE.foliage),
  canopyShade: oklch(0.45, 0.07, TRIPO_HUE.foliage - 6),
  frond: oklch(0.66, 0.126, TRIPO_HUE.foliage + 6),
  blade: oklch(0.68, 0.138, TRIPO_HUE.foliage + 8),
  bladeDry: oklch(0.7, 0.104, TRIPO_HUE.foliage - 22),
  bamboo: oklch(0.74, 0.116, TRIPO_HUE.foliage - 8),
  bambooNode: oklch(0.62, 0.094, TRIPO_HUE.foliage - 4),
  bark: oklch(0.46, 0.062, TRIPO_HUE.earth - 2),
  barkPale: oklch(0.6, 0.07, TRIPO_HUE.earth + 6),
  log: oklch(0.42, 0.058, TRIPO_HUE.earth - 6),
  /** Coconut husk, straight off the generated ammo: L 0.52 C 0.074 hue 50. */
  husk: oklch(0.52, 0.074, 50),
  /** Flowers and fungus caps are the only places chroma is allowed to run. */
  blossom: oklch(0.72, 0.128, 358),
  fungusCap: oklch(0.56, 0.15, TRIPO_HUE.accent),
  fungusStem: oklch(0.78, 0.03, 80),
  /** Shelf fungus on fallen logs. Matched to the generated hive's ochre. */
  bracket: oklch(0.7, 0.12, 78),
} as const;

/**
 * Sky and aerial perspective.
 *
 * Distant layers are not authored: `aerial()` walks any near colour toward the
 * horizon in OKLab, which is the whole of aerial perspective and produces a
 * consistent recession no hand-picked ridge palette managed. Hand-picking is
 * how the old kit ended up with a teal fourth ridge that belonged to no other
 * colour in the frame.
 */
export const SKY = {
  top: oklch(0.68, 0.098, 244),
  horizon: oklch(0.9, 0.028, 232),
  sun: oklch(0.96, 0.042, 90),
  cloud: oklch(0.97, 0.012, 250),
} as const;

export function aerial(near: THREE.Color, distance: number): THREE.Color {
  const { L, C, h } = toOklch(near);
  const horizon = toOklch(SKY.horizon);
  const t = Math.min(1, Math.max(0, distance));
  return oklch(
    L + (horizon.L - L) * t * 0.86,
    C * (1 - t * 0.82),
    // Hue drifts toward the sky's blue, but only part way: a fully blue ridge
    // stops reading as land.
    h + (((horizon.h - h + 540) % 360) - 180) * t * 0.42,
    );
}

/**
 * Water, shallow enough to keep the riverbed's hue in it.
 *
 * `deep` doubles as the tint for terrain below the waterline: the slab keeps
 * running down past the surface, and left at its dry colours it reads as a
 * muddy band rather than as ground that happens to be underwater.
 */
export const WATER = {
  surface: oklch(0.66, 0.086, 232),
  deep: oklch(0.46, 0.072, 240),
} as const;

/** Hex convenience for the places three still wants a number. */
export function hex(color: THREE.Color): number {
  return color.getHex(THREE.SRGBColorSpace);
}

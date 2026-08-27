import * as THREE from 'three';

/**
 * Canvas-generated textures. Nothing here is loaded from disk: the whole art
 * pack ships as code, which keeps the bundle small and lets the palette move
 * without re-exporting assets.
 *
 * All textures are cached by key and disposed together, so the material
 * library can hand the same instance to every material that wants it.
 */
const cache = new Map<string, THREE.Texture>();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for procedural texture.');
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement, key: string, srgb = true): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  cache.set(key, texture);
  return texture;
}

/** Deterministic value hash so textures are identical between reloads. */
function hash2(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Tileable value noise, smoothstep-interpolated and wrapped at the grid edge.
 *
 * The grain and speckle already here are per-pixel, which is invisible past a
 * few metres — it averages to flat grey at any distance the terrain is
 * actually seen from. What sells a painted surface is variation at the scale
 * of the object, and that needs an interpolated lattice rather than a hash per
 * texel. Wrapping the lattice keeps the result tileable, which the terrain
 * requires: its UVs are world-scaled and repeat across the whole arena.
 */
function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const fx = (x * cells) % cells;
  const fy = (y * cells) % cells;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  // Smoothstep, so the lattice does not show as diamond creases.
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const wrap = (v: number) => ((v % cells) + cells) % cells;
  const c00 = hash2(wrap(x0), wrap(y0), seed);
  const c10 = hash2(wrap(x0 + 1), wrap(y0), seed);
  const c01 = hash2(wrap(x0), wrap(y0 + 1), seed);
  const c11 = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
  return (c00 * (1 - sx) + c10 * sx) * (1 - sy) + (c01 * (1 - sx) + c11 * sx) * sy;
}

/** Sum of octaves, normalised to 0..1. */
function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let cells = 4;
  for (let i = 0; i < octaves; i += 1) {
    sum += valueNoise(x, y, cells, seed + i * 17) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    cells *= 2;
  }
  return sum / total;
}

/**
 * Ground grain for the terrain slab, multiplied over the strata vertex colours.
 *
 * This used to draw its own horizontal sediment bands. It no longer does: the
 * geometry carries wandering strata boundaries now, and a second set of
 * perfectly straight bands laid over them was what made the cliff read as
 * plywood rather than as rock — two banding systems at different frequencies,
 * one of them ruler-straight across a curved landform.
 *
 * What is left is what a painted albedo actually contributes at this distance:
 * broad mottling at the scale of the landform, a warm/cool wander so no two
 * patches are the same tone, fine grit, and a scatter of embedded stones with
 * contact shading under them. Low contrast throughout — the vertex colours own
 * the hue, this only owns the break-up.
 */
export function soilTexture(): THREE.Texture {
  const key = 'soil';
  const hit = cache.get(key);
  if (hit) return hit;

  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      // Broad patchiness, then fine grit on top of it.
      const broad = fbm(u, v, 3, 4);
      const grit = hash2(x, y, 5) * 0.5 + hash2(x * 0.5, y * 0.5, 9) * 0.5;
      // A separate slow field decides whether a patch leans warm or cool,
      // which is the difference between a painted surface and a tinted one.
      const warmth = fbm(u * 0.5 + 0.31, v * 0.5 + 0.77, 41, 2) - 0.5;

      // Contrast is doing real work here: this map is multiplied over the
      // strata colours across an arena-wide slab, and at the amplitude that
      // reads correctly on a swatch it averages to flat at play distance.
      const base = 210 + (broad - 0.5) * 84 + (grit - 0.5) * 34;
      const index = (y * size + x) * 4;
      data[index] = Math.max(0, Math.min(255, base + warmth * 26));
      data[index + 1] = Math.max(0, Math.min(255, base + warmth * 4));
      data[index + 2] = Math.max(0, Math.min(255, base - warmth * 22));
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Embedded stones. Each gets a soft dark seat beneath it before the stone
  // itself — a pebble drawn as a flat blob reads as a smudge, and the seat is
  // most of what makes it read as sitting in the ground instead of on it.
  for (let i = 0; i < 190; i += 1) {
    const x = hash2(i, 1, 41) * size;
    const y = hash2(i, 2, 43) * size;
    const r = 1.6 + hash2(i, 3, 47) * 4.2;
    const angle = hash2(i, 5, 59) * Math.PI;

    ctx.fillStyle = 'rgba(84,68,54,0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.34, r * 1.24, r * 0.86, angle, 0, Math.PI * 2);
    ctx.fill();

    const tone = hash2(i, 4, 53);
    const shade = Math.round(198 + tone * 46);
    ctx.fillStyle = 'rgba(' + shade + ',' + (shade - 6) + ',' + (shade - 14) + ',0.72)';
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.72, angle, 0, Math.PI * 2);
    ctx.fill();
  }

  return finish(canvas, key);
}

/** Soft radial falloff used for contact shadows, dust puffs and glows. */
export function radialTexture(): THREE.Texture {
  const key = 'radial';
  const hit = cache.get(key);
  if (hit) return hit;

  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(0.62, 'rgba(255,255,255,0.16)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = finish(canvas, key);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Puffy cloud sprite built from overlapping soft discs. */
export function cloudTexture(): THREE.Texture {
  const key = 'cloud';
  const hit = cache.get(key);
  if (hit) return hit;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const puffs = 13;
  for (let i = 0; i < puffs; i += 1) {
    const t = i / (puffs - 1);
    const x = size * (0.16 + t * 0.68) + (hash2(i, 1, 61) - 0.5) * 26;
    const y = size * 0.56 - Math.sin(t * Math.PI) * size * 0.16 + (hash2(i, 2, 67) - 0.5) * 18;
    const r = size * (0.1 + Math.sin(t * Math.PI) * 0.13 + hash2(i, 3, 71) * 0.05);
    const gradient = ctx.createRadialGradient(x, y - r * 0.15, r * 0.15, x, y, r);
    gradient.addColorStop(0, 'rgba(255,255,255,0.98)');
    gradient.addColorStop(0.6, 'rgba(248,251,255,0.8)');
    gradient.addColorStop(1, 'rgba(236,244,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = finish(canvas, key);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Bark: vertical fibres with a few growth rings. Used on palm and tree trunks. */
export function barkTexture(): THREE.Texture {
  const key = 'bark';
  const hit = cache.get(key);
  if (hit) return hit;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i += 1) {
    const x = hash2(i, 1, 13) * size;
    const w = 1 + hash2(i, 2, 17) * 5;
    const shade = 190 + Math.floor(hash2(i, 3, 19) * 55);
    ctx.fillStyle = 'rgba(' + shade + ',' + (shade - 12) + ',' + (shade - 26) + ',0.75)';
    ctx.fillRect(x, 0, w, size);
  }
  for (let y = 0; y < size; y += 22) {
    const jitter = hash2(y, 4, 23) * 5;
    ctx.fillStyle = 'rgba(120,92,60,0.32)';
    ctx.fillRect(0, y + jitter, size, 3);
  }
  return finish(canvas, key);
}

/**
 * Water surface: two crossing sine bands baked into a tiling texture. Scrolled
 * on both axes at runtime it reads as a moving river without a custom shader.
 */
export function waterTexture(): THREE.Texture {
  const key = 'water';
  const hit = cache.get(key);
  if (hit) return hit;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      const wave = Math.sin(u * 3) * 0.5 + Math.sin(v * 2 + u) * 0.3 + Math.sin((u + v) * 5) * 0.2;
      const value = 168 + wave * 34;
      const index = (y * size + x) * 4;
      data[index] = value * 0.55;
      data[index + 1] = value * 0.9;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return finish(canvas, key);
}

/** Scorch decal stamped into craters. */
export function scorchTexture(): THREE.Texture {
  const key = 'scorch';
  const hit = cache.get(key);
  if (hit) return hit;

  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.1,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, 'rgba(28,20,14,0.85)');
  gradient.addColorStop(0.55, 'rgba(48,34,22,0.45)');
  gradient.addColorStop(1, 'rgba(60,44,28,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 40; i += 1) {
    const angle = hash2(i, 1, 83) * Math.PI * 2;
    const dist = size * (0.18 + hash2(i, 2, 89) * 0.3);
    const r = 1.5 + hash2(i, 3, 97) * 4;
    ctx.fillStyle = 'rgba(20,14,10,0.5)';
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(angle) * dist, size / 2 + Math.sin(angle) * dist, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = finish(canvas, key);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

export function disposeProceduralTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}

export function proceduralTextureCount(): number {
  return cache.size;
}

import * as THREE from 'three';
import { barkTexture, radialTexture, soilTexture, waterTexture } from './ProceduralTextures';

/**
 * Named material roles shared across the whole game.
 *
 * The rule is one instance per role, reused by every mesh that plays that part.
 * Per-animal body materials are the single exception — they are cached by
 * colour in `bodyMaterial()` so six fighters cost six materials, not sixty.
 */
export class MaterialLibrary {
  private readonly hideCache = new Map<number, THREE.MeshStandardMaterial>();
  private readonly fabricCache = new Map<number, THREE.MeshStandardMaterial>();
  private readonly leatherCache = new Map<number, THREE.MeshStandardMaterial>();
  private readonly flatCache = new Map<number, THREE.MeshStandardMaterial>();
  private readonly owned: THREE.Material[] = [];

  /** Terrain slab. Vertex colours carry the strata; the map only adds grain. */
  readonly terrain: THREE.MeshStandardMaterial;
  /** Grass cap on the terrain ridge. */
  readonly grass: THREE.MeshStandardMaterial;
  readonly water: THREE.MeshStandardMaterial;
  readonly bark: THREE.MeshStandardMaterial;
  readonly leaf: THREE.MeshStandardMaterial;
  readonly leafDark: THREE.MeshStandardMaterial;
  readonly rock: THREE.MeshStandardMaterial;
  /** Dark matte used under fighters and props to ground them. */
  readonly groundContact: THREE.MeshBasicMaterial;
  /* ---- character roles ------------------------------------------------ */
  /** Eye white. Slightly warm, never pure white, so it sits in the lighting. */
  readonly sclera: THREE.MeshStandardMaterial;
  /** Iris. Shared across the cast: six unique eye colours would cost six
   *  materials for a detail that is a handful of pixels in play. */
  readonly iris: THREE.MeshStandardMaterial;
  /** Unlit specular dot in the eye. A real highlight swims as a head turns. */
  readonly catchlight: THREE.MeshBasicMaterial;
  /** Buckles, goggle rims, hardware. */
  readonly hardware: THREE.MeshStandardMaterial;
  /** Goggle lenses. Fake glass: one transparent draw, no transmission buffer. */
  readonly lens: THREE.MeshPhysicalMaterial;
  /** Tusks, beaks, claws. */
  readonly ivory: THREE.MeshStandardMaterial;
  readonly eyeDark: THREE.MeshStandardMaterial;
  /** Authored glow: aim guide, target ring, power aura. */
  readonly emissiveSignal: THREE.MeshBasicMaterial;
  readonly hazard: THREE.MeshStandardMaterial;
  readonly reward: THREE.MeshStandardMaterial;
  readonly decalDark: THREE.MeshStandardMaterial;
  /** Back-face ink line drawn behind fighters. */
  readonly outline: THREE.MeshBasicMaterial;
  readonly decalLight: THREE.MeshStandardMaterial;

  constructor() {
    const soil = soilTexture();
    // Terrain UVs are already world-scaled (x * 0.125), so the map repeats
    // once per 8 world units at repeat 1 — anything smaller smears the grain.
    soil.repeat.set(1, 1);

    this.terrain = this.own(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: soil,
        roughness: 0.94,
        metalness: 0,
        envMapIntensity: 0.35,
      }),
    );

    this.grass = this.own(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0,
        envMapIntensity: 0.4,
      }),
    );

    const water = waterTexture();
    water.repeat.set(6, 2);
    this.water = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x2e9fd0,
        map: water,
        transparent: true,
        opacity: 0.82,
        roughness: 0.12,
        metalness: 0.1,
        envMapIntensity: 1.4,
      }),
    );

    const bark = barkTexture();
    bark.repeat.set(1, 2);
    this.bark = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x8a6440,
        map: bark,
        roughness: 0.88,
        metalness: 0,
        envMapIntensity: 0.4,
      }),
    );

    this.leaf = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x3f9c3a,
        roughness: 0.7,
        metalness: 0,
        side: THREE.DoubleSide,
        envMapIntensity: 0.6,
      }),
    );

    this.leafDark = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x2a6f34,
        roughness: 0.78,
        metalness: 0,
        side: THREE.DoubleSide,
        envMapIntensity: 0.45,
      }),
    );

    this.rock = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x8d8577,
        roughness: 0.92,
        metalness: 0.02,
        flatShading: true,
        envMapIntensity: 0.5,
      }),
    );

    this.groundContact = this.own(
      new THREE.MeshBasicMaterial({
        color: 0x1b2a17,
        map: radialTexture(),
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      }),
    );

    this.sclera = this.own(
      new THREE.MeshStandardMaterial({
        color: 0xf2ece0,
        roughness: 0.5,
        metalness: 0,
        envMapIntensity: 0.25,
      }),
    );

    this.iris = this.own(
      new THREE.MeshStandardMaterial({
        color: 0x4a2c16,
        roughness: 0.18,
        metalness: 0,
        envMapIntensity: 0.9,
      }),
    );

    this.catchlight = this.own(
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );

    this.hardware = this.own(
      new THREE.MeshStandardMaterial({
        color: 0xb9bcc0,
        roughness: 0.3,
        metalness: 0.92,
        envMapIntensity: 1.1,
      }),
    );

    // Cheap fake glass: one transparent draw call, no transmission buffer.
    this.lens = this.own(
      new THREE.MeshPhysicalMaterial({
        color: 0x9fd8f0,
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.42,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMapIntensity: 1.3,
        depthWrite: false,
      }),
    );

    this.ivory = this.own(
      new THREE.MeshStandardMaterial({
        color: 0xf0e6cf,
        roughness: 0.34,
        metalness: 0,
        envMapIntensity: 0.7,
      }),
    );

    this.eyeDark = this.own(
      new THREE.MeshStandardMaterial({ color: 0x14110f, roughness: 0.25, metalness: 0 }),
    );

    this.emissiveSignal = this.own(
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9 }),
    );

    this.hazard = this.own(
      new THREE.MeshStandardMaterial({
        color: 0xda291c,
        emissive: 0x5c0f08,
        emissiveIntensity: 0.6,
        roughness: 0.5,
        metalness: 0.05,
      }),
    );

    this.reward = this.own(
      new THREE.MeshStandardMaterial({
        color: 0xfac800,
        emissive: 0xfbb000,
        emissiveIntensity: 0.9,
        roughness: 0.34,
        metalness: 0.25,
      }),
    );

    this.decalDark = this.own(
      new THREE.MeshStandardMaterial({ color: 0x2f2822, roughness: 0.8, metalness: 0 }),
    );

    this.outline = this.own(
      new THREE.MeshBasicMaterial({ color: 0x171f14, side: THREE.BackSide, toneMapped: false }),
    );

    this.decalLight = this.own(
      new THREE.MeshStandardMaterial({ color: 0xf6efe0, roughness: 0.6, metalness: 0 }),
    );
  }

  /**
   * Animal hide.
   *
   * Sheen is the whole trick: a plain MeshStandardMaterial gives a hard
   * terminator that reads as plastic, while a broad sheen lobe tinted toward
   * the base colour softens the edge into something skin-like. Cached by
   * colour, so six species cost six materials rather than sixty.
   */
  hide(color: number, roughness = 0.68): THREE.MeshStandardMaterial {
    const key = color * 100 + Math.round(roughness * 100);
    const hit = this.hideCache.get(key);
    if (hit) return hit;
    const base = new THREE.Color(color);
    const material = this.own(
      new THREE.MeshPhysicalMaterial({
        color,
        roughness,
        metalness: 0,
        sheen: 0.55,
        sheenRoughness: 0.75,
        sheenColor: base.clone().lerp(new THREE.Color(0xffffff), 0.45),
        envMapIntensity: 0.55,
        // A trace of self-illumination stops dark hides from going to mud in
        // shadow; the hit flash drives this same channel much harder.
        emissive: base.clone().multiplyScalar(0.05),
        emissiveIntensity: 1,
      }),
    );
    this.hideCache.set(key, material);
    return material;
  }

  /** Costume fabric: rough, with a strong sheen for a cloth edge highlight. */
  fabric(color: number): THREE.MeshStandardMaterial {
    const hit = this.fabricCache.get(color);
    if (hit) return hit;
    const material = this.own(
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.92,
        metalness: 0,
        sheen: 1,
        sheenRoughness: 0.5,
        sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55),
        envMapIntensity: 0.35,
      }),
    );
    this.fabricCache.set(color, material);
    return material;
  }

  /** Straps, gloves and boots: matte, faintly waxy. */
  leatherFor(color: number): THREE.MeshStandardMaterial {
    const hit = this.leatherCache.get(color);
    if (hit) return hit;
    const material = this.own(
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.66,
        metalness: 0.04,
        envMapIntensity: 0.6,
      }),
    );
    this.leatherCache.set(color, material);
    return material;
  }

  /** Flat-shaded prop material keyed by colour (rocks, ammo, debris). */
  flat(color: number, roughness = 0.85): THREE.MeshStandardMaterial {
    const key = color * 100 + Math.round(roughness * 100) + 1;
    const hit = this.flatCache.get(key);
    if (hit) return hit;
    const material = this.own(
      new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness: 0,
        flatShading: true,
        envMapIntensity: 0.5,
      }),
    );
    this.flatCache.set(key, material);
    return material;
  }

  get materialCount(): number {
    return this.owned.length;
  }

  dispose(): void {
    for (const material of this.owned) material.dispose();
    this.owned.length = 0;
    this.hideCache.clear();
    this.fabricCache.clear();
    this.leatherCache.clear();
    this.flatCache.clear();
  }

  private own<T extends THREE.Material>(material: T): T {
    this.owned.push(material);
    return material;
  }
}

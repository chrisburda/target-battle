import * as THREE from 'three';
import { WORLD } from '../game/config';
import type { MaterialLibrary } from '../assets/MaterialLibrary';

/**
 * Destructible heightfield terrain.
 *
 * The arena is one row of columns, each holding a surface height. That
 * constraint rules out caves and overhangs, which is the right trade for an
 * artillery game: every shot either clears the ridge or does not, and craters
 * reshape the sightlines without ever producing an unreachable pocket.
 *
 * Geometry is built once and then mutated in place. Positions, colours and
 * normals live in pre-allocated attributes, so carving a crater rewrites a few
 * thousand floats rather than rebuilding a BufferGeometry.
 */

/** Depth below the surface of each horizontal strata row on the cliff face. */
const STRATA_DEPTHS = [0, 0.55, 1.5, 3.4, 7, 13];
const ROWS = STRATA_DEPTHS.length + 1; // + the row pinned to baseY

type Strata = { depth: number; color: THREE.Color };

const STRATA_COLORS: Strata[] = [
  { depth: 0, color: new THREE.Color(0x5fae32) }, // grass lip
  { depth: 0.55, color: new THREE.Color(0x4a7c2a) }, // shaded grass root
  { depth: 1.5, color: new THREE.Color(0x6b4a2c) }, // topsoil
  { depth: 3.4, color: new THREE.Color(0x8a6238) }, // dirt
  { depth: 7, color: new THREE.Color(0x9d7b4e) }, // clay
  { depth: 13, color: new THREE.Color(0x6f665c) }, // rock
  { depth: 999, color: new THREE.Color(0x494540) }, // deep rock
];

const GRASS_TOP = new THREE.Color(0x74c93f);
const GRASS_SHADE = new THREE.Color(0x4f9a2c);
const SCORCH_COLOR = new THREE.Color(0x2a211a);

function hash(i: number, j: number, seed: number): number {
  const s = Math.sin(i * 12.9898 + j * 78.233 + seed * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

export type TerrainProfile = {
  seed: number;
  /** Extra hills layered on top of the base sine stack. */
  hills: number;
};

export class Terrain {
  readonly group = new THREE.Group();
  readonly heights: Float32Array;
  /** 0..1 burn accumulated per column; darkens the strata colours. */
  private readonly scorch: Float32Array;
  private readonly spacing: number;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly normals: Float32Array;
  private readonly uvs: Float32Array;
  private readonly mesh: THREE.Mesh;
  private readonly depthMaterial: THREE.MeshDepthMaterial;

  /** Vertex counts for the two blocks packed into one attribute array. */
  private readonly faceVertexCount: number;
  private readonly topVertexCount: number;
  private readonly capVertexCount = 8;

  private dirty = false;

  constructor(
    private readonly materials: MaterialLibrary,
    profile: TerrainProfile,
  ) {
    this.group.name = 'terrain';
    this.spacing = (WORLD.halfWidth * 2) / (WORLD.columns - 1);
    this.heights = new Float32Array(WORLD.columns);
    this.scorch = new Float32Array(WORLD.columns);

    this.faceVertexCount = WORLD.columns * ROWS;
    this.topVertexCount = WORLD.columns * 2;
    const total = this.faceVertexCount + this.topVertexCount + this.capVertexCount;

    this.positions = new Float32Array(total * 3);
    this.colors = new Float32Array(total * 3);
    this.normals = new Float32Array(total * 3);
    this.uvs = new Float32Array(total * 2);

    this.generate(profile);
    this.buildIndices();

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    this.writeGeometry();

    this.mesh = new THREE.Mesh(this.geometry, this.materials.terrain);
    /*
     * Dedicated depth material for the shadow pass.
     *
     * three copies the surface material's `map` onto its shared depth material
     * whether or not alpha testing needs it, and that map-carrying depth
     * variant failed to link on ANGLE/D3D11 — two MeshDepthMaterial programs
     * with LINK_STATUS false and empty info logs on every load. The terrain is
     * fully opaque, so the depth pass has no use for the soil texture anyway;
     * supplying a minimal material both silences the failure and saves a
     * texture fetch per shadow texel.
     */
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.name = 'terrainSlab';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  // ---------------------------------------------------------------- sampling

  xForColumn(index: number): number {
    return -WORLD.halfWidth + index * this.spacing;
  }

  columnForX(x: number): number {
    const raw = (x + WORLD.halfWidth) / this.spacing;
    return Math.min(WORLD.columns - 1, Math.max(0, Math.round(raw)));
  }

  /** Linearly interpolated surface height. */
  heightAt(x: number): number {
    const raw = (x + WORLD.halfWidth) / this.spacing;
    if (raw <= 0) return this.heights[0];
    if (raw >= WORLD.columns - 1) return this.heights[WORLD.columns - 1];
    const i = Math.floor(raw);
    const t = raw - i;
    return this.heights[i] * (1 - t) + this.heights[i + 1] * t;
  }

  /** dy/dx of the surface, used to stand fighters upright on slopes. */
  slopeAt(x: number): number {
    const step = this.spacing * 2;
    return (this.heightAt(x + step) - this.heightAt(x - step)) / (step * 2);
  }

  surfaceNormalAt(x: number, target: THREE.Vector3): THREE.Vector3 {
    const slope = this.slopeAt(x);
    return target.set(-slope, 1, 0).normalize();
  }

  isSubmerged(x: number): boolean {
    return this.heightAt(x) < WORLD.waterY;
  }

  // ------------------------------------------------------------- destruction

  /**
   * Carve a circular crater. A heightfield cannot hold the overhang a real
   * circular blast would leave, so the surface drops to the bottom of the
   * circle where the blast breaks through, and drops by the chord height where
   * the blast was fully buried. That reads correctly and never leaves a spike.
   */
  carve(centerX: number, centerY: number, radius: number): void {
    const first = Math.max(0, this.columnForX(centerX - radius) - 1);
    const last = Math.min(WORLD.columns - 1, this.columnForX(centerX + radius) + 1);

    for (let i = first; i <= last; i += 1) {
      const dx = this.xForColumn(i) - centerX;
      if (Math.abs(dx) > radius) continue;
      const chord = Math.sqrt(Math.max(0, radius * radius - dx * dx));
      const top = centerY + chord;
      const bottom = centerY - chord;
      const height = this.heights[i];

      if (top >= height && bottom < height) {
        // Blast broke the surface: drop to the underside of the sphere.
        this.heights[i] = bottom;
      } else if (top < height && bottom < height) {
        // Fully buried: collapse the roof by the chord height instead of
        // pretending we can model a cave.
        this.heights[i] = height - chord * 1.2;
      }
      this.heights[i] = Math.max(WORLD.baseY + 1.5, this.heights[i]);

      const burn = 1 - Math.abs(dx) / radius;
      this.scorch[i] = Math.min(1, this.scorch[i] + burn * 0.85);
    }
    this.dirty = true;
  }

  /** Push the geometry update out. Call once per frame after any carving. */
  flush(): void {
    if (!this.dirty) return;
    this.writeGeometry();
    this.dirty = false;
  }

  // ------------------------------------------------------------- generation

  private generate(profile: TerrainProfile): void {
    const { seed, hills } = profile;
    const p1 = hash(seed, 1, 3) * Math.PI * 2;
    const p2 = hash(seed, 2, 5) * Math.PI * 2;
    const p3 = hash(seed, 3, 7) * Math.PI * 2;

    // Gaussian hill centres, spread across the arena but never at the extremes.
    const peaks: Array<{ x: number; amp: number; width: number }> = [];
    for (let i = 0; i < hills; i += 1) {
      peaks.push({
        x: (hash(seed, 10 + i, 11) * 1.7 - 0.85) * WORLD.halfWidth,
        amp: 4 + hash(seed, 20 + i, 13) * 8,
        width: 6 + hash(seed, 30 + i, 17) * 9,
      });
    }

    // One central chasm keeps a real decision on the table: lob over it or
    // thread the gap.
    const chasmX = (hash(seed, 40, 19) - 0.5) * 18;
    const chasmWidth = 7 + hash(seed, 41, 23) * 5;
    const chasmDepth = 9 + hash(seed, 42, 29) * 5;

    for (let i = 0; i < WORLD.columns; i += 1) {
      const x = this.xForColumn(i);
      let h = 4;
      h += Math.sin(x * 0.055 + p1) * 6.5;
      h += Math.sin(x * 0.13 + p2) * 3.2;
      h += Math.sin(x * 0.31 + p3) * 1.3;
      h += (hash(i, 0, seed) - 0.5) * 0.55;

      for (const peak of peaks) {
        const d = (x - peak.x) / peak.width;
        h += peak.amp * Math.exp(-d * d);
      }

      const cd = (x - chasmX) / chasmWidth;
      h -= chasmDepth * Math.exp(-cd * cd);

      // Raise the shoulders so shots that leave the arena feel like a miss
      // rather than an escape hatch.
      const edge = Math.abs(x) / WORLD.halfWidth;
      if (edge > 0.78) {
        const t = (edge - 0.78) / 0.22;
        h += t * t * 16;
      }

      this.heights[i] = h;
    }

    // Two smoothing passes remove the high-frequency sine beat without
    // flattening the silhouette.
    for (let pass = 0; pass < 2; pass += 1) {
      const copy = Float32Array.from(this.heights);
      for (let i = 1; i < WORLD.columns - 1; i += 1) {
        this.heights[i] = copy[i - 1] * 0.25 + copy[i] * 0.5 + copy[i + 1] * 0.25;
      }
    }
  }

  /**
   * Finds well-separated, reasonably flat, above-water ledges to stand
   * fighters on. Spawn quality is level design: a fighter dropped on a 45°
   * slope or in the chasm has no shot and no fun.
   */
  findSpawnPoints(count: number, random: () => number): number[] {
    const usable = WORLD.halfWidth * 1.62;
    const bandWidth = usable / count;
    const points: number[] = [];

    for (let slot = 0; slot < count; slot += 1) {
      const bandStart = -usable / 2 + slot * bandWidth;
      let bestX = bandStart + bandWidth * 0.5;
      let bestScore = -Infinity;

      for (let attempt = 0; attempt < 42; attempt += 1) {
        const x = bandStart + bandWidth * (0.16 + random() * 0.68);
        const height = this.heightAt(x);
        if (height < WORLD.waterY + 1.4) continue;
        const flatness = 1 - Math.min(1, Math.abs(this.slopeAt(x)) * 1.6);
        // Prefer higher, flatter ground, and nudge away from band edges.
        const centreBias = 1 - Math.abs((x - (bandStart + bandWidth / 2)) / (bandWidth / 2));
        const score = flatness * 2.4 + height * 0.05 + centreBias * 0.5;
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
        }
      }
      points.push(bestX);
    }
    return points;
  }

  // ------------------------------------------------------------ geometry i/o

  private buildIndices(): void {
    const indices: number[] = [];

    // Cliff face grid: columns x ROWS.
    for (let i = 0; i < WORLD.columns - 1; i += 1) {
      for (let k = 0; k < ROWS - 1; k += 1) {
        const a = i * ROWS + k;
        const b = (i + 1) * ROWS + k;
        const c = (i + 1) * ROWS + k + 1;
        const d = i * ROWS + k + 1;
        indices.push(a, d, c, a, c, b);
      }
    }

    // Top ribbon: two vertices per column (back edge, front edge).
    const topBase = this.faceVertexCount;
    for (let i = 0; i < WORLD.columns - 1; i += 1) {
      const a = topBase + i * 2;
      const b = topBase + i * 2 + 1;
      const c = topBase + (i + 1) * 2 + 1;
      const d = topBase + (i + 1) * 2;
      indices.push(a, b, c, a, c, d);
    }

    // Side caps close the slab at both ends of the arena.
    const capBase = topBase + this.topVertexCount;
    indices.push(capBase + 0, capBase + 1, capBase + 2, capBase + 0, capBase + 2, capBase + 3);
    indices.push(capBase + 4, capBase + 6, capBase + 5, capBase + 4, capBase + 7, capBase + 6);

    this.geometry.setIndex(indices);
  }

  private writeGeometry(): void {
    const depth = WORLD.halfDepth;
    const position = this.positions;
    const color = this.colors;
    const normal = this.normals;
    const uv = this.uvs;
    const tmp = new THREE.Color();

    for (let i = 0; i < WORLD.columns; i += 1) {
      const x = this.xForColumn(i);
      const h = this.heights[i];
      const burn = this.scorch[i];

      // --- cliff face -------------------------------------------------
      for (let k = 0; k < ROWS; k += 1) {
        const vi = i * ROWS + k;
        const isBase = k === ROWS - 1;
        const targetDepth = isBase ? h - WORLD.baseY : STRATA_DEPTHS[k];
        const y = isBase ? WORLD.baseY : h - targetDepth;

        // Ripple the face forward/back so the cliff is not a flat billboard.
        const wobble = (hash(i, k, 91) - 0.5) * 0.7;
        position[vi * 3] = x;
        position[vi * 3 + 1] = y;
        position[vi * 3 + 2] = depth + wobble;

        const nx = (hash(i, k, 131) - 0.5) * 0.55;
        const ny = (hash(i, k, 137) - 0.5) * 0.4;
        const len = Math.hypot(nx, ny, 1);
        normal[vi * 3] = nx / len;
        normal[vi * 3 + 1] = ny / len;
        normal[vi * 3 + 2] = 1 / len;

        uv[vi * 2] = x * 0.125;
        uv[vi * 2 + 1] = y * 0.125;

        this.strataColor(targetDepth, i, k, tmp);
        if (burn > 0) tmp.lerp(SCORCH_COLOR, burn * (isBase ? 0.15 : 0.7 - k * 0.08));
        color[vi * 3] = tmp.r;
        color[vi * 3 + 1] = tmp.g;
        color[vi * 3 + 2] = tmp.b;
      }

      // --- top ribbon -------------------------------------------------
      const slope = i > 0 && i < WORLD.columns - 1
        ? (this.heights[i + 1] - this.heights[i - 1]) / (this.spacing * 2)
        : 0;
      const nLen = Math.hypot(-slope, 1);
      const backIndex = this.faceVertexCount + i * 2;
      const frontIndex = backIndex + 1;

      for (const [vi, z] of [
        [backIndex, -depth],
        [frontIndex, depth + (hash(i, 0, 91) - 0.5) * 0.7],
      ] as const) {
        position[vi * 3] = x;
        position[vi * 3 + 1] = h;
        position[vi * 3 + 2] = z;
        normal[vi * 3] = -slope / nLen;
        normal[vi * 3 + 1] = 1 / nLen;
        normal[vi * 3 + 2] = 0;
        uv[vi * 2] = x * 0.125;
        uv[vi * 2 + 1] = z * 0.125;
      }

      // Grass reads brighter on the flat, darker on steep faces.
      const flat = 1 - Math.min(1, Math.abs(slope) * 0.9);
      tmp.copy(GRASS_SHADE).lerp(GRASS_TOP, flat * (0.6 + hash(i, 5, 149) * 0.4));
      if (burn > 0) tmp.lerp(SCORCH_COLOR, burn * 0.85);
      for (const vi of [backIndex, frontIndex]) {
        color[vi * 3] = tmp.r;
        color[vi * 3 + 1] = tmp.g;
        color[vi * 3 + 2] = tmp.b;
      }
    }

    this.writeCaps();

    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  private writeCaps(): void {
    const base = this.faceVertexCount + this.topVertexCount;
    const depth = WORLD.halfDepth;
    const left = -WORLD.halfWidth;
    const right = WORLD.halfWidth;
    const leftH = this.heights[0];
    const rightH = this.heights[WORLD.columns - 1];
    const rock = STRATA_COLORS[STRATA_COLORS.length - 1].color;

    const corners: Array<[number, number, number, number, number, number]> = [
      // left cap, normal -X
      [left, leftH, -depth, -1, 0, 0],
      [left, leftH, depth, -1, 0, 0],
      [left, WORLD.baseY, depth, -1, 0, 0],
      [left, WORLD.baseY, -depth, -1, 0, 0],
      // right cap, normal +X
      [right, rightH, -depth, 1, 0, 0],
      [right, rightH, depth, 1, 0, 0],
      [right, WORLD.baseY, depth, 1, 0, 0],
      [right, WORLD.baseY, -depth, 1, 0, 0],
    ];

    corners.forEach((corner, offset) => {
      const vi = base + offset;
      this.positions[vi * 3] = corner[0];
      this.positions[vi * 3 + 1] = corner[1];
      this.positions[vi * 3 + 2] = corner[2];
      this.normals[vi * 3] = corner[3];
      this.normals[vi * 3 + 1] = corner[4];
      this.normals[vi * 3 + 2] = corner[5];
      this.uvs[vi * 2] = corner[2] * 0.125;
      this.uvs[vi * 2 + 1] = corner[1] * 0.125;
      this.colors[vi * 3] = rock.r;
      this.colors[vi * 3 + 1] = rock.g;
      this.colors[vi * 3 + 2] = rock.b;
    });
  }

  private strataColor(depth: number, column: number, row: number, target: THREE.Color): void {
    let lower = STRATA_COLORS[0];
    let upper = STRATA_COLORS[STRATA_COLORS.length - 1];
    for (let i = 0; i < STRATA_COLORS.length - 1; i += 1) {
      if (depth >= STRATA_COLORS[i].depth && depth <= STRATA_COLORS[i + 1].depth) {
        lower = STRATA_COLORS[i];
        upper = STRATA_COLORS[i + 1];
        break;
      }
    }
    const span = Math.max(0.001, upper.depth - lower.depth);
    const t = Math.min(1, Math.max(0, (depth - lower.depth) / span));
    target.copy(lower.color).lerp(upper.color, t);
    // Per-vertex grain so the bands do not read as printed stripes.
    const grain = 0.88 + hash(column, row, 173) * 0.24;
    target.multiplyScalar(grain);
  }

  get triangleCount(): number {
    const index = this.geometry.getIndex();
    return index ? index.count / 3 : 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.depthMaterial.dispose();
  }
}

import * as THREE from 'three';
import { WORLD } from '../game/config';
import { GROUND, WATER, type Surface } from '../assets/palette';
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
 *
 * Shading is the part that makes it sit with the generated characters. Those
 * arrive with occlusion baked into their albedo, which is most of why they
 * read as solid objects; a heightfield lit only by the scene's directional key
 * reads as a painted backdrop next to them. So occlusion is computed here from
 * the heights themselves — see `computeOcclusion` — and folded into the vertex
 * colours, and it recomputes on every carve so a fresh crater shades its own
 * bowl.
 */

/**
 * One horizontal layer of the cliff face.
 *
 * `inset` pulls a row back from the front plane. The top three rows use it to
 * roll the turf over the edge instead of meeting the ground plane at a hard
 * 90°, which is the geometric tell that separated the old terrain from the
 * rounded, bevelled forms in the generated assets.
 */
type StrataRow = {
  depth: number;
  inset: number;
  surface: Surface;
  /**
   * 0 keeps the layer parallel to the surface, 1 pins it flat in world space.
   *
   * Soil follows topography, so the turf and root layers stay parallel. Rock
   * does not: a hill is carved out of beds that were already there, and those
   * beds stay level while the ground above them rises and falls. Holding every
   * layer parallel is what made the cliff read as the terrain silhouette
   * extruded downward — the bands traced the skyline exactly, which is a shape
   * that occurs nowhere in nature and is instantly legible as a graphics
   * shortcut.
   */
  settle: number;
};

const STRATA: StrataRow[] = [
  { depth: 0, inset: 0.62, surface: GROUND.grass, settle: 0 },
  { depth: 0.22, inset: 0.26, surface: GROUND.grass, settle: 0 },
  { depth: 0.62, inset: 0.04, surface: GROUND.grassSteep, settle: 0 },
  { depth: 1.5, inset: 0, surface: GROUND.root, settle: 0.12 },
  { depth: 3.2, inset: 0, surface: GROUND.topsoil, settle: 0.3 },
  { depth: 6, inset: 0, surface: GROUND.dirt, settle: 0.5 },
  { depth: 10.5, inset: 0, surface: GROUND.clay, settle: 0.7 },
  { depth: 17, inset: 0, surface: GROUND.rock, settle: 0.85 },
];

/**
 * Smallest vertical gap each layer must keep from the one above it.
 *
 * Settling a layer toward level can otherwise drive it up through its
 * neighbour wherever the ground dips, which inverts the geometry. Enforcing a
 * floor while walking down the column is cheaper and more robust than trying
 * to pick settle values that can never collide.
 */
const MIN_GAP = STRATA.map((row, k) =>
  k === 0 ? 0 : Math.max(0.14, (row.depth - STRATA[k - 1].depth) * 0.22),
);
/** + one row pinned to baseY, so the slab always closes at the same depth. */
const ROWS = STRATA.length + 1;

/**
 * How far each strata boundary is allowed to wander, per row.
 *
 * Capped at a third of the gap to the row above so two adjacent boundaries can
 * never cross. Without the cap the deep layers, which have the widest gaps and
 * therefore the largest wander, punch through the ones above them and the
 * cliff turns inside out.
 */
const WANDER = STRATA.map((row, k) =>
  k === 0 ? 0 : Math.min(0.9, (row.depth - STRATA[k - 1].depth) * 0.3),
);

/**
 * Column offsets sampled when measuring how much sky a column can see.
 *
 * Logarithmic rather than linear: nearby ground governs tight crevice shading
 * and distant ground governs broad valley shading, and sampling linearly out
 * to the same range costs four times as much for no visible gain. At 0.25
 * units per column the far sample reaches about 18 units.
 */
const HORIZON_STEPS = [1, 2, 3, 4, 6, 9, 13, 19, 27, 38, 53, 74];

function hash(i: number, j: number, seed: number): number {
  const s = Math.sin(i * 12.9898 + j * 78.233 + seed * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth two-scale undulation, so strata read as sediment and not as stripes. */
function strataWave(column: number, row: number): number {
  return Math.sin(column * 0.021 + row * 1.7) * 0.62 + Math.sin(column * 0.058 + row * 4.3) * 0.3;
}

/**
 * How far the cliff's front surface stands proud of the slab plane.
 *
 * Two things are going on. Along the arena, long wavelengths only: columns are
 * 0.25 units apart, so on screen a column is under a pixel, and the per-column
 * hash this started as did not read as roughness — it beat against the pixel
 * grid and threw vertical moiré down the whole face. Roughly 17 and 50 unit
 * wavelengths sit at a scale the camera can resolve, and what is left of the
 * hash is grain rather than interference.
 *
 * Down the face, a profile. Every other surface in frame is a rounded volume;
 * a cliff held at one flat plane takes a single lighting value and reads as
 * painted backdrop no matter how good its colours are. So the face swells
 * through its middle and tucks back in at the foot, the way a weathered bank
 * slumps instead of standing plumb, and the swell itself drifts along the
 * arena so the same section is not stamped end to end.
 *
 * The profile is zero at row 0 by construction, which matters: that row is
 * shared with the top ribbon's front edge, and any offset there would tear the
 * seam open along the entire ridge.
 */
function frontBulge(column: number, row: number): number {
  const along =
    Math.sin(column * 0.091 + 1.7) * 0.34 +
    Math.sin(column * 0.031 + 4.3) * 0.52 +
    (hash(column, 0, 91) - 0.5) * 0.07;
  const t = row / (ROWS - 1);
  const swell = Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.92 - t * 0.55;
  return along + swell * (0.72 + Math.sin(column * 0.047 + row * 0.9) * 0.28);
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
  /** 0..1 freshly opened subsoil, brightened around crater rims. */
  private readonly freshCut: Float32Array;
  /** 0..1 sky exposure per column; 1 is a clear ridge top, 0 a deep crevice. */
  private readonly openness: Float32Array;
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
  /**
   * The height the settled layers are levelled against.
   *
   * Frozen at generation and never recomputed. Craters must not move the
   * bedrock: if this tracked the live mean, every explosion would shift the
   * strata across the whole arena at once.
   */
  private groundLevel = 0;
  /** Scratch: this column's row heights, filled once per column. */
  private readonly rowYs = new Float32Array(ROWS);

  constructor(
    private readonly materials: MaterialLibrary,
    profile: TerrainProfile,
  ) {
    this.group.name = 'terrain';
    this.spacing = (WORLD.halfWidth * 2) / (WORLD.columns - 1);
    this.heights = new Float32Array(WORLD.columns);
    this.scorch = new Float32Array(WORLD.columns);
    this.freshCut = new Float32Array(WORLD.columns);
    this.openness = new Float32Array(WORLD.columns);

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
    this.computeOcclusion();
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

  /**
   * Sky exposure at a world position, 0 (enclosed) to 1 (open).
   *
   * Shared with the prop kit so scattered foliage sits in the same light as
   * the ground under it. A bush in a gully lit like a ridge top is what gives
   * scattered instances away as decoration rather than as part of the place.
   */
  opennessAt(x: number): number {
    return this.openness[this.columnForX(x)];
  }

  /**
   * Z of the cliff's front surface at a world point.
   *
   * Exposed so props can be embedded in the face rather than floated in front
   * of it — the face is no longer a plane, so anything placed at a fixed z
   * either sinks out of sight where the wall swells or hangs off it where the
   * wall tucks back.
   *
   * Only valid below the turf, where the rolled lip's inset has run out. That
   * is the only place anything gets embedded, and handling the bevel here
   * would mean interpolating an inset that is zero for every caller.
   */
  faceZAt(x: number, y: number): number {
    const i = this.columnForX(x);
    const below = Math.max(0, this.heights[i] - y);
    // Fractional row, so the bulge profile is sampled where the prop actually
    // sits instead of snapping to the nearest strata band.
    let row = ROWS - 1;
    for (let k = 1; k < STRATA.length; k += 1) {
      if (below <= STRATA[k].depth) {
        row = k - 1 + (below - STRATA[k - 1].depth) / (STRATA[k].depth - STRATA[k - 1].depth);
        break;
      }
    }
    return WORLD.halfDepth + frontBulge(i, row);
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

      const reach = 1 - Math.abs(dx) / radius;
      this.scorch[i] = Math.min(1, this.scorch[i] + reach * 0.85);
      /*
       * Scorch peaks at the centre; torn subsoil peaks at the rim. A blast
       * that only blackens reads as a smudge — it is the bright ring of raw
       * earth around the black that makes it read as something removed. Hence
       * the band centred on `reach = 0.45` rather than on the peak.
       */
      this.freshCut[i] = Math.min(
        1,
        this.freshCut[i] + Math.max(0, 1 - Math.abs(reach - 0.45) * 2.2) * 0.9,
      );
    }
    this.dirty = true;
  }

  /** Push the geometry update out. Call once per frame after any carving. */
  flush(): void {
    if (!this.dirty) return;
    this.computeOcclusion();
    this.writeGeometry();
    this.dirty = false;
  }

  // -------------------------------------------------------------- occlusion

  /**
   * Horizon-angle ambient occlusion over the heightfield.
   *
   * For each column, march outward both ways and track the steepest elevation
   * angle anything reaches. A column with ridges standing over it on both
   * sides sees little sky and darkens; a summit sees everything and stays
   * bright. For a 1D heightfield that costs about twelve thousand comparisons
   * — cheap enough to redo on every carve, which is what lets a fresh crater
   * shade its own bowl instead of staying as flat as the ground it came out
   * of.
   *
   * The alternative, screen-space AO in the post chain, costs a depth prepass
   * and a blur every frame to approximate occluders that are all known
   * analytically right here.
   */
  private computeOcclusion(): void {
    const columns = WORLD.columns;
    for (let i = 0; i < columns; i += 1) {
      const h = this.heights[i];
      let left = 0;
      let right = 0;
      for (const step of HORIZON_STEPS) {
        const distance = step * this.spacing;
        const l = i - step;
        if (l >= 0) left = Math.max(left, Math.atan2(this.heights[l] - h, distance));
        const r = i + step;
        if (r < columns) right = Math.max(right, Math.atan2(this.heights[r] - h, distance));
      }
      // Each side can shroud at most a quarter turn, so the pair normalises by
      // pi. Biased toward the light end: a physically straight curve buries
      // the midtones, and these vertex colours are about to be multiplied by a
      // lit material that darkens them again.
      const occluded = (left + right) / Math.PI;
      this.openness[i] = Math.pow(Math.min(1, Math.max(0, 1 - occluded)), 0.7);
    }
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

    let total = 0;
    for (let i = 0; i < WORLD.columns; i += 1) total += this.heights[i];
    this.groundLevel = total / WORLD.columns;
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

  /**
   * Fills `rowYs` with this column's strata heights, top to bottom.
   *
   * Each boundary is placed between two readings — where it would sit if it
   * followed the surface, and where it would sit if it were dead level — and
   * then pushed down if it has crept too close to the layer above. Walking the
   * column in order is what makes the gap constraint hold: every row only has
   * to clear the one already placed.
   */
  private fillRowYs(column: number): void {
    const h = this.heights[column];
    let previous = h;
    for (let k = 0; k < ROWS - 1; k += 1) {
      const row = STRATA[k];
      const depth = row.depth + strataWave(column, k) * WANDER[k];
      const parallel = h - depth;
      const level = this.groundLevel - depth;
      const y = parallel + (level - parallel) * row.settle;
      previous = Math.min(y, previous - MIN_GAP[k]);
      this.rowYs[k] = previous;
    }
    this.rowYs[ROWS - 1] = WORLD.baseY;
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
      const fresh = this.freshCut[i];
      const sky = this.openness[i];
      const slope = this.faceSlope(i);
      // Row 0's offset is shared with the ribbon's front edge below, which is
      // what keeps that seam watertight.
      const lipBulge = frontBulge(i, 0);

      // --- cliff face -------------------------------------------------
      this.fillRowYs(i);
      for (let k = 0; k < ROWS; k += 1) {
        const vi = i * ROWS + k;
        const isBase = k === ROWS - 1;
        const y = this.rowYs[k];
        const rowDepth = h - y;
        const inset = isBase ? 0 : STRATA[k].inset;
        const z = depth - inset + frontBulge(i, k);

        position[vi * 3] = x;
        position[vi * 3 + 1] = y;
        position[vi * 3 + 2] = z;

        /*
         * Normals follow the bevel. The old face pointed flatly at +Z with a
         * little noise, so the entire cliff took one lighting value and read
         * as a painted backdrop; rotating the top rows up toward +Y is what
         * makes the rolled lip catch the key light and turn the corner.
         */
        const next = Math.min(ROWS - 1, k + 1);
        const dy = this.rowYs[next] - y;
        const dz =
          depth - (next === ROWS - 1 ? 0 : STRATA[next].inset) + frontBulge(i, next) - z;
        // Perpendicular to the downward tangent within the YZ plane, facing
        // out and up; x picks up the ridge slope so lighting varies along it.
        const nx = -slope * 0.35 + (hash(i, k, 131) - 0.5) * 0.16;
        const ny = dz + (hash(i, k, 137) - 0.5) * 0.06;
        const nz = dy === 0 ? 1 : -dy;
        const len = Math.hypot(nx, ny, nz) || 1;
        normal[vi * 3] = nx / len;
        normal[vi * 3 + 1] = ny / len;
        normal[vi * 3 + 2] = nz / len;

        uv[vi * 2] = x * 0.125;
        uv[vi * 2 + 1] = y * 0.125;

        const surface = isBase ? GROUND.bedrock : STRATA[k].surface;
        // Deeper rows sit further inside the slab, so they keep less of the
        // ambient term even where the column above them is wide open.
        const exposure = sky * (isBase ? 0.35 : 1 - Math.min(0.55, rowDepth * 0.04));
        tmp.copy(surface.shade).lerp(surface.lit, exposure);
        if (fresh > 0 && !isBase && rowDepth > 0.6 && rowDepth < 8) {
          tmp.lerp(GROUND.freshCut, fresh * 0.55);
        }
        if (burn > 0) tmp.lerp(GROUND.scorch, burn * Math.max(0, 0.75 - k * 0.09));
        // Everything under the waterline goes toward the deep water colour,
        // harder the further down it goes. Two units of falloff, so the shore
        // still reads as shore rather than as a hard tide line.
        if (y < WORLD.waterY) {
          tmp.lerp(WATER.deep, Math.min(0.72, (WORLD.waterY - y) * 0.24));
        }
        color[vi * 3] = tmp.r;
        color[vi * 3 + 1] = tmp.g;
        color[vi * 3 + 2] = tmp.b;
      }

      // --- top ribbon -------------------------------------------------
      const nLen = Math.hypot(-slope, 1);
      const backIndex = this.faceVertexCount + i * 2;
      const frontIndex = backIndex + 1;

      for (const [vi, z] of [
        [backIndex, -depth],
        // Meets face row 0 exactly: same inset, same offset, so no seam.
        [frontIndex, depth - STRATA[0].inset + lipBulge],
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

      // Grass reads brighter on the flat and falls to the steep-face green on
      // a slope — the same hue with the light taken off it, rather than a
      // second green that has to be kept in sync by hand.
      const flat = 1 - Math.min(1, Math.abs(slope) * 0.9);
      const lift = 0.55 + hash(i, 5, 149) * 0.45;
      tmp.copy(GROUND.grassSteep.lit).lerp(GROUND.grass.lit, flat * lift);
      tmp.lerp(GROUND.grass.shade, (1 - sky) * 0.8);
      if (burn > 0) tmp.lerp(GROUND.scorch, burn * 0.85);
      for (const vi of [backIndex, frontIndex]) {
        color[vi * 3] = tmp.r;
        color[vi * 3 + 1] = tmp.g;
        color[vi * 3 + 2] = tmp.b;
      }
      // The back edge tucks behind the ridge, so it takes a little less light
      // and the ribbon carries a gradient rather than one flat tone.
      for (let c = 0; c < 3; c += 1) color[backIndex * 3 + c] *= 0.82;
    }

    this.writeCaps();

    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** Central-difference surface slope in world units, clamped at the ends. */
  private faceSlope(i: number): number {
    if (i <= 0 || i >= WORLD.columns - 1) return 0;
    return (this.heights[i + 1] - this.heights[i - 1]) / (this.spacing * 2);
  }

  private writeCaps(): void {
    const base = this.faceVertexCount + this.topVertexCount;
    const depth = WORLD.halfDepth;
    const left = -WORLD.halfWidth;
    const right = WORLD.halfWidth;
    const leftH = this.heights[0];
    const rightH = this.heights[WORLD.columns - 1];
    const rock = GROUND.bedrock.lit;

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

  get triangleCount(): number {
    const index = this.geometry.getIndex();
    return index ? index.count / 3 : 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.depthMaterial.dispose();
  }
}

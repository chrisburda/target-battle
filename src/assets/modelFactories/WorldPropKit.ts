import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MaterialLibrary } from '../MaterialLibrary';
import { FLORA, hex } from '../palette';
import { generatedPropParts, hasGeneratedProp } from './GeneratedPropFactory';
import type { Terrain } from '../../systems/Terrain';
import { WORLD } from '../../game/config';

/**
 * Modular jungle prop kit.
 *
 * Ten reusable prop types, each authored once, merged per material and then
 * drawn with InstancedMesh. That is the whole reason the world can carry ~1100
 * props for about fifteen draw calls: without merging, nine palm trees alone
 * would cost ninety.
 *
 * Props know which terrain column they were planted on. When a crater changes
 * that column's height the prop is retired, so foliage never hangs in the air
 * over a hole.
 */

type Part = { geometry: THREE.BufferGeometry; material: THREE.Material };
type PropTemplate = { parts: Part[] };

type Placement = {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  /**
   * Per-instance brightness multiplier.
   *
   * Instanced props are one geometry and one material by construction, so
   * every copy comes out identically lit. Along a ridge that produces a row of
   * interchangeable beads — the eye reads the repetition before it reads the
   * foliage. A per-instance multiplier costs one float3 in the instance buffer
   * and breaks the pattern, and folding terrain openness into it also seats
   * each prop in the light of the ground it stands on.
   */
  tint?: number;
};

type PropBatch = {
  meshes: THREE.InstancedMesh[];
  placements: Placement[];
  alive: boolean[];
};

/** Curved, tapered blade used for fronds, ferns and grass. */
function bladeGeometry(length: number, width: number, curve: number, segments = 6): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const y = t * length;
    // Taper to a point, with a slightly fatter middle.
    const w = width * Math.sin(Math.PI * Math.pow(t, 0.55)) * (1 - t * 0.25);
    const bend = curve * t * t;
    positions.push(-w + bend, y, 0, w + bend, y, 0);
    normals.push(0, 0, 1, 0, 0, 1);
    uvs.push(0, t, 1, t);
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function jitteredRock(radius: number, seed: number, detail = 0): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const n = Math.sin(x * 9.1 + y * 5.3 + z * 6.7 + seed) * 0.5 + 0.5;
    const s = 0.74 + n * 0.5;
    position.setXYZ(i, x * s, y * s * 0.82, z * s);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function transformed(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const clone = geometry.clone();
  clone.applyMatrix4(matrix);
  return clone;
}

const M = new THREE.Matrix4();
const EULER = new THREE.Euler();
const QUAT = new THREE.Quaternion();
const VEC = new THREE.Vector3();
const SCALE = new THREE.Vector3();

function place(
  geometry: THREE.BufferGeometry,
  position: [number, number, number],
  rotation: [number, number, number],
  scale: [number, number, number] | number = 1,
): THREE.BufferGeometry {
  EULER.set(rotation[0], rotation[1], rotation[2]);
  QUAT.setFromEuler(EULER);
  VEC.set(position[0], position[1], position[2]);
  if (typeof scale === 'number') SCALE.set(scale, scale, scale);
  else SCALE.set(scale[0], scale[1], scale[2]);
  M.compose(VEC, QUAT, SCALE);
  return transformed(geometry, M);
}

/**
 * Adds the wind-sway vertex displacement from the shader cookbook. Phase comes
 * from the instance's own world offset, so a field of grass never ripples in
 * lockstep. Only foliage gets this: trunks and rocks stay planted.
 */
function makeSwayMaterial(source: THREE.MeshStandardMaterial, strength: number, key: string): THREE.MeshStandardMaterial {
  const material = source.clone();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uStrength = { value: strength };
    material.userData.shader = shader;
    shader.vertexShader =
      'uniform float uTime;\nuniform float uStrength;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          '#ifdef USE_INSTANCING',
          '  float phase = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 1.3;',
          '#else',
          '  float phase = 0.0;',
          '#endif',
          'float h = max(position.y, 0.0);',
          'transformed.x += sin(uTime * 1.6 + phase) * uStrength * h;',
          'transformed.z += cos(uTime * 1.15 + phase * 0.8) * uStrength * 0.6 * h;',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'sway-' + key;
  return material;
}

/**
 * Quality knobs applied at construction.
 *
 * Prop density drives triangle count and shadow casting drives draw calls —
 * the two numbers that put the mobile tier over its render budget. They are
 * settings rather than a hard-coded mobile branch so the tradeoff stays
 * visible and tunable.
 */
export type PropKitOptions = {
  /** Multiplier on every prop count. 1 is the desktop tier. */
  density: number;
  /** Instanced foliage casting shadows roughly doubles its draw calls. */
  castShadows: boolean;
  /**
   * Prop families to leave out entirely. Density trims triangles but not draw
   * calls — each family is its own InstancedMesh regardless of how few
   * instances it holds — so dropping a whole family is the only way to buy
   * calls back.
   */
  skip?: readonly string[];
};

export class WorldPropKit {
  readonly group = new THREE.Group();

  private readonly batches = new Map<string, PropBatch>();
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly swayMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly groundHeights = new Map<string, number[]>();

  private leafSway!: THREE.MeshStandardMaterial;
  private leafDarkSway!: THREE.MeshStandardMaterial;
  private grassSway!: THREE.MeshStandardMaterial;

  constructor(
    private readonly materials: MaterialLibrary,
    private readonly terrain: Terrain,
    private readonly random: () => number,
    private readonly options: PropKitOptions = { density: 1, castShadows: true },
  ) {
    this.group.name = 'propKit';
    this.buildSwayMaterials();
    this.populate();
  }

  /**
   * Brightness for one instance: some spread, plus the sky exposure of the
   * ground beneath it, so a bush down a gully is not lit like a ridge top.
   */
  private tintAt(x: number): number {
    const openness = this.terrain.opennessAt(x);
    return (0.86 + this.random() * 0.26) * (0.74 + 0.26 * openness);
  }

  /**
   * The parts a family is built from — generated if one is loaded for it.
   *
   * The procedural template is built either way, purely to be measured. That
   * looks wasteful and is the point: it means the generated mesh is scaled to
   * whatever the hand-built one happens to be, so the scatter's own ranges — a
   * palm placed between 1.3x and 2.05x — keep meaning what they meant, and
   * regenerating a prop at a different size needs no placement re-tuning. The
   * measurement costs microseconds and the discarded buffers are never
   * uploaded.
   */
  private partsFor(key: string, built: PropTemplate): Part[] {
    if (!hasGeneratedProp(key)) return built.parts;

    let minY = Infinity;
    let maxY = -Infinity;
    for (const part of built.parts) {
      part.geometry.computeBoundingBox();
      const box = part.geometry.boundingBox;
      if (!box) continue;
      minY = Math.min(minY, box.min.y);
      maxY = Math.max(maxY, box.max.y);
    }
    if (!Number.isFinite(minY)) return built.parts;

    const parts = generatedPropParts(key, Math.max(0.001, maxY - minY));
    if (parts.length === 0) return built.parts;

    return parts.map((part) => {
      this.ownedGeometries.push(part.geometry);
      const material = this.dressGenerated(key, part.material);
      return { geometry: part.geometry, material };
    });
  }

  /**
   * Gives a generated prop's material the same wind the hand-built foliage has.
   *
   * A generated palm arrives as one material covering trunk and fronds
   * together, which sounds like a problem for sway and is not: the shader
   * scales displacement by height above the prop's own base, so the trunk stays
   * planted and only the crown moves. Stone and timber are left alone.
   */
  private dressGenerated(key: string, material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const strength = key === 'bush' ? 0.02 : key === 'bamboo' ? 0.035 : key === 'palm' ? 0.016 : 0;
    if (strength === 0) {
      this.ownedMaterials.push(material);
      return material;
    }
    const swaying = makeSwayMaterial(material, strength, 'gen-' + key);
    this.swayMaterials.push(swaying);
    this.ownedMaterials.push(material, swaying);
    return swaying;
  }

  /**
   * Thins a family when it is drawn from a generated model.
   *
   * A generated prop carries an order of magnitude more triangles than the
   * lathe-and-sphere version it replaces, and the counts were tuned for the
   * cheap one. Left alone the substitution took the arena from 486k triangles
   * to 744k against a 750k budget — no headroom, on the one frame that already
   * holds four fighters. Fewer and better is also the right call for the look:
   * these read at a glance where the built props needed numbers to register.
   */
  private generatedDensity(key: string): number {
    return hasGeneratedProp(key) ? 0.62 : 1;
  }

  private skipped(key: string): boolean {
    return this.options.skip?.includes(key) ?? false;
  }

  private buildSwayMaterials(): void {
    this.leafSway = makeSwayMaterial(this.materials.leaf, 0.03, 'leaf');
    this.leafDarkSway = makeSwayMaterial(this.materials.leafDark, 0.024, 'leafDark');
    this.grassSway = makeSwayMaterial(this.materials.leaf, 0.075, 'grass');
    this.grassSway.color.setHex(hex(FLORA.blade));
    this.swayMaterials.push(this.leafSway, this.leafDarkSway, this.grassSway);
    this.ownedMaterials.push(...this.swayMaterials);
  }

  // ------------------------------------------------------------- templates

  private grassTuft(): PropTemplate {
    const parts: Part[] = [];
    const blade = bladeGeometry(1, 0.075, 0.22, 4);
    this.ownedGeometries.push(blade);
    for (let i = 0; i < 5; i += 1) {
      const angle = (i / 5) * Math.PI * 2 + this.random();
      parts.push({
        geometry: place(
          blade,
          [Math.cos(angle) * 0.09, 0, Math.sin(angle) * 0.09],
          [(this.random() - 0.5) * 0.5, angle, (this.random() - 0.5) * 0.6],
          [1, 0.5 + this.random() * 0.75, 1],
        ),
        material: this.grassSway,
      });
    }
    return { parts };
  }

  private fern(): PropTemplate {
    const parts: Part[] = [];
    const frond = bladeGeometry(1.5, 0.22, 0.55, 6);
    this.ownedGeometries.push(frond);
    for (let i = 0; i < 7; i += 1) {
      const angle = (i / 7) * Math.PI * 2;
      parts.push({
        geometry: place(
          frond,
          [0, 0.05, 0],
          [Math.cos(angle) * 0.62, angle, Math.sin(angle) * 0.62],
          [1, 0.72 + this.random() * 0.5, 1],
        ),
        material: i % 2 === 0 ? this.leafSway : this.leafDarkSway,
      });
    }
    return { parts };
  }

  private palm(): PropTemplate {
    const parts: Part[] = [];
    // Trunk swept along a leaning curve, thinner at the crown.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.25, 2.2, 0),
      new THREE.Vector3(0.75, 4.4, 0),
      new THREE.Vector3(1.5, 6.2, 0),
    ]);
    const trunk = new THREE.TubeGeometry(curve, 14, 0.24, 8, false);
    // Taper the tube by scaling radius per ring.
    const pos = trunk.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      const t = Math.min(1, Math.max(0, pos.getY(i) / 6.2));
      const point = curve.getPointAt(Math.min(0.999, t));
      const shrink = 1 - t * 0.42;
      pos.setX(i, point.x + (pos.getX(i) - point.x) * shrink);
      pos.setZ(i, pos.getZ(i) * shrink);
    }
    trunk.computeVertexNormals();
    this.ownedGeometries.push(trunk);
    parts.push({ geometry: trunk, material: this.materials.bark });

    const frond = bladeGeometry(3.4, 0.44, -1.5, 8);
    this.ownedGeometries.push(frond);
    const crown: [number, number, number] = [1.5, 6.1, 0];
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      parts.push({
        geometry: place(
          frond,
          crown,
          [Math.cos(angle) * 1.05 - 0.2, angle, Math.sin(angle) * 1.05],
          [1, 0.82 + this.random() * 0.35, 1],
        ),
        material: i % 3 === 0 ? this.leafDarkSway : this.leafSway,
      });
    }

    const nut = new THREE.IcosahedronGeometry(0.22, 0);
    this.ownedGeometries.push(nut);
    for (let i = 0; i < 3; i += 1) {
      const angle = (i / 3) * Math.PI * 2;
      parts.push({
        geometry: place(nut, [crown[0] + Math.cos(angle) * 0.3, crown[1] - 0.35, Math.sin(angle) * 0.3], [0, 0, 0]),
        material: this.materials.matte(hex(FLORA.husk), 0.8),
      });
    }
    return { parts };
  }

  private bamboo(): PropTemplate {
    const parts: Part[] = [];
    const stalkMaterial = this.materials.matte(hex(FLORA.bamboo), 0.66);
    const nodeMaterial = this.materials.matte(hex(FLORA.bambooNode), 0.7);
    for (let s = 0; s < 4; s += 1) {
      const height = 3.4 + this.random() * 2.4;
      const stalk = new THREE.CylinderGeometry(0.085, 0.1, height, 7, 1);
      this.ownedGeometries.push(stalk);
      const x = (s - 1.5) * 0.34;
      const lean = (this.random() - 0.5) * 0.18;
      parts.push({
        geometry: place(stalk, [x, height / 2, (this.random() - 0.5) * 0.4], [0, 0, lean]),
        material: stalkMaterial,
      });
      // Node rings up the stalk.
      const ring = new THREE.TorusGeometry(0.1, 0.022, 5, 9);
      this.ownedGeometries.push(ring);
      for (let n = 1; n < 4; n += 1) {
        const y = (height / 4) * n;
        parts.push({
          geometry: place(ring, [x + lean * y, y, 0], [Math.PI / 2, 0, 0]),
          material: nodeMaterial,
        });
      }
      const leaf = bladeGeometry(0.9, 0.11, 0.4, 4);
      this.ownedGeometries.push(leaf);
      for (let l = 0; l < 3; l += 1) {
        const angle = this.random() * Math.PI * 2;
        parts.push({
          geometry: place(
            leaf,
            [x + lean * height, height * (0.6 + l * 0.13), 0],
            [Math.cos(angle) * 1.2, angle, Math.sin(angle) * 1.2],
          ),
          material: this.leafSway,
        });
      }
    }
    return { parts };
  }

  private boulder(): PropTemplate {
    const main = jitteredRock(1, 4.2, 1);
    const chip = jitteredRock(0.44, 11.7, 0);
    this.ownedGeometries.push(main, chip);
    return {
      parts: [
        { geometry: place(main, [0, 0.62, 0], [0.2, 0.7, 0.1]), material: this.materials.rock },
        { geometry: place(chip, [0.82, 0.24, 0.2], [0.5, 1.2, 0.3]), material: this.materials.rock },
        // A moss cap ties the rock into the jungle palette.
        {
          geometry: place(main, [0, 0.86, 0], [0.2, 0.7, 0.1], [0.86, 0.32, 0.86]),
          material: this.materials.leafDark,
        },
      ],
    };
  }

  private log(): PropTemplate {
    const body = new THREE.CylinderGeometry(0.36, 0.42, 2.8, 9, 1);
    const cap = new THREE.CircleGeometry(0.36, 9);
    const shroom = new THREE.SphereGeometry(0.16, 7, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    this.ownedGeometries.push(body, cap, shroom);
    const parts: Part[] = [
      { geometry: place(body, [0, 0.4, 0], [0, 0, Math.PI / 2]), material: this.materials.bark },
      { geometry: place(cap, [1.4, 0.4, 0], [0, Math.PI / 2, 0]), material: this.materials.matte(hex(FLORA.barkPale), 0.82) },
      { geometry: place(cap, [-1.4, 0.4, 0], [0, -Math.PI / 2, 0]), material: this.materials.matte(hex(FLORA.barkPale), 0.82) },
      { geometry: place(body, [0, 0.72, 0], [0, 0, Math.PI / 2], [0.9, 0.55, 0.4]), material: this.materials.leafDark },
    ];
    for (let i = 0; i < 3; i += 1) {
      parts.push({
        geometry: place(shroom, [(i - 1) * 0.7, 0.74, 0.28], [0, 0, 0], 0.8 + this.random() * 0.5),
        material: this.materials.matte(hex(FLORA.bracket), 0.68),
      });
    }
    return { parts };
  }

  private mushrooms(): PropTemplate {
    const parts: Part[] = [];
    const stem = new THREE.CylinderGeometry(0.06, 0.09, 0.5, 6, 1);
    const cap = new THREE.SphereGeometry(0.26, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const spot = new THREE.CircleGeometry(0.05, 6);
    this.ownedGeometries.push(stem, cap, spot);
    const capMaterial = this.materials.matte(hex(FLORA.fungusCap), 0.62);
    for (let i = 0; i < 3; i += 1) {
      const x = (i - 1) * 0.34;
      const s = 0.7 + this.random() * 0.6;
      parts.push({ geometry: place(stem, [x, 0.25 * s, 0], [0, 0, 0], s), material: this.materials.decalLight });
      parts.push({ geometry: place(cap, [x, 0.48 * s, 0], [0, 0, 0], s), material: capMaterial });
      for (let d = 0; d < 3; d += 1) {
        const a = (d / 3) * Math.PI * 2;
        parts.push({
          geometry: place(
            spot,
            [x + Math.cos(a) * 0.12 * s, 0.48 * s + 0.2 * s, Math.sin(a) * 0.12 * s],
            [-Math.PI / 2, 0, 0],
            s,
          ),
          material: this.materials.decalLight,
        });
      }
    }
    return { parts };
  }

  private flower(): PropTemplate {
    const parts: Part[] = [];
    const stem = new THREE.CylinderGeometry(0.02, 0.03, 0.7, 5, 1);
    const petal = new THREE.SphereGeometry(0.11, 7, 5);
    const core = new THREE.SphereGeometry(0.07, 7, 5);
    this.ownedGeometries.push(stem, petal, core);
    const petalMaterial = this.materials.matte(hex(FLORA.blossom), 0.6);
    parts.push({ geometry: place(stem, [0, 0.35, 0], [0, 0, 0]), material: this.leafDarkSway });
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      parts.push({
        geometry: place(petal, [Math.cos(a) * 0.12, 0.72, Math.sin(a) * 0.12], [0, 0, 0], [1, 0.45, 1]),
        material: petalMaterial,
      });
    }
    parts.push({ geometry: place(core, [0, 0.76, 0], [0, 0, 0]), material: this.materials.reward });
    return { parts };
  }

  private vine(): PropTemplate {
    const parts: Part[] = [];
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.3, -1.2, 0.1),
      new THREE.Vector3(-0.2, -2.4, -0.1),
      new THREE.Vector3(0.15, -3.6, 0),
    ]);
    const rope = new THREE.TubeGeometry(curve, 12, 0.05, 5, false);
    this.ownedGeometries.push(rope);
    parts.push({ geometry: rope, material: this.materials.flat(hex(FLORA.canopyShade), 0.85) });

    const leaf = bladeGeometry(0.5, 0.13, 0.2, 3);
    this.ownedGeometries.push(leaf);
    for (let i = 0; i < 7; i += 1) {
      const t = 0.1 + (i / 7) * 0.85;
      const point = curve.getPointAt(t);
      const angle = this.random() * Math.PI * 2;
      parts.push({
        geometry: place(leaf, [point.x, point.y, point.z], [Math.PI * 0.5 + Math.cos(angle), angle, 0], 1),
        material: this.leafSway,
      });
    }
    return { parts };
  }

  private frontBush(): PropTemplate {
    // Near-layer silhouette planted on the front lip of the slab. Darker than
    // the play layer so it frames without competing for attention.
    const parts: Part[] = [];
    const blob = new THREE.SphereGeometry(1, 9, 7);
    this.ownedGeometries.push(blob);
    const dark = this.materials.foliage(hex(FLORA.canopyShade), 0.34);
    const offsets: Array<[number, number, number, number]> = [
      [0, 0.5, 0, 0.9],
      [0.75, 0.36, 0.1, 0.66],
      [-0.7, 0.4, -0.1, 0.72],
      [0.2, 0.8, 0.05, 0.6],
    ];
    for (const [x, y, z, s] of offsets) {
      parts.push({ geometry: place(blob, [x, y, z], [0, 0, 0], [s, s * 0.78, s * 0.7]), material: dark });
    }
    const blade = bladeGeometry(1.6, 0.2, 0.5, 5);
    this.ownedGeometries.push(blade);
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      parts.push({
        geometry: place(blade, [Math.cos(a) * 0.4, 0.5, Math.sin(a) * 0.3], [Math.cos(a) * 0.8, a, Math.sin(a) * 0.8]),
        material: dark,
      });
    }
    return { parts };
  }

  /**
   * A cluster of stone half-buried in the cliff face.
   *
   * Flattened on z on purpose: these sit in the wall, not on it, and a round
   * boulder pushed into a surface reads as a ball stuck to a wall. Squashing
   * the depth and letting the face swallow the back half is what makes it read
   * as something the ground was built around.
   */
  private cliffRock(): PropTemplate {
    const parts: Part[] = [];
    const main = jitteredRock(1, 21, 1);
    const chip = jitteredRock(0.44, 47, 0);
    this.ownedGeometries.push(main, chip);
    parts.push({
      geometry: place(main, [0, 0, 0], [0.3, 0.9, 0.2], [1.15, 0.86, 0.55]),
      material: this.materials.rock,
    });
    parts.push({
      geometry: place(chip, [0.86, -0.44, 0.18], [1.1, 0.4, 0.7], [1, 0.8, 0.5]),
      material: this.materials.rock,
    });
    parts.push({
      geometry: place(chip, [-0.74, 0.38, 0.1], [0.4, 1.9, 0.2], [0.82, 0.7, 0.45]),
      material: this.materials.rock,
    });
    return { parts };
  }

  // ------------------------------------------------------------- placement

  private populate(): void {
    this.spawn('grass', () => this.grassTuft(), 620, { minScale: 0.85, maxScale: 1.9, zRange: [-4, 4.2] });
    this.spawn('fern', () => this.fern(), 130, { minScale: 0.95, maxScale: 1.8, zRange: [-4, 3.6] });
    this.spawn('flower', () => this.flower(), 100, { minScale: 1.1, maxScale: 2, zRange: [-3.6, 4] });
    this.spawn('mushroom', () => this.mushrooms(), 40, { minScale: 0.7, maxScale: 1.25, zRange: [-3.4, 3.6] });
    this.spawn('boulder', () => this.boulder(), 28, { minScale: 0.7, maxScale: 1.95, zRange: [-4, 3.4] });
    this.spawn('palm', () => this.palm(), 12, { minScale: 1.3, maxScale: 2.05, zRange: [-3.8, 2.4], maxSlope: 0.55 });
    this.spawn('bamboo', () => this.bamboo(), 13, { minScale: 1.15, maxScale: 1.85, zRange: [-3.8, 2.8], maxSlope: 0.6 });
    this.spawn('log', () => this.log(), 10, { minScale: 1.1, maxScale: 1.8, zRange: [-3.4, 3.2], maxSlope: 0.34 });
    // Scaled down from a 2.3 ceiling: at that size a single blob stood taller
    // than a fighter, and the cluster read as a heap of boulders painted green
    // rather than as undergrowth.
    this.spawn('bush', () => this.frontBush(), 40, { minScale: 0.8, maxScale: 1.45, zRange: [3.6, 4.4] });
    this.spawnVines(14);
    this.spawnCliffRocks(24);
  }

  /**
   * Stone outcrops down the cliff face.
   *
   * The face is the largest single surface in frame and, textured alone, it
   * stays one unbroken sweep of brown — no amount of albedo detail survives
   * being minified across sixty world units. Outcrops give it the interruption
   * the eye is looking for, and they are the same near-neutral stone as the
   * river rock the fighters throw, so the arena and the ammo agree about what
   * rock looks like here.
   *
   * Placed by depth below the surface rather than by height, so they follow
   * the topography down instead of banding at one altitude.
   */
  private spawnCliffRocks(count: number): void {
    if (this.skipped('cliffRock')) return;
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const part of this.partsFor('cliffRock', this.cliffRock())) {
      const list = byMaterial.get(part.material) ?? [];
      list.push(part.geometry);
      byMaterial.set(part.material, list);
    }

    /*
     * Placed in clusters rather than independently.
     *
     * Uniform scatter at this count reads as gravel sprayed across the wall —
     * every rock equally spaced, none of them related to any other. Stone
     * comes out of the ground in seams, so a few sites with two or three
     * outcrops each is both truer and much stronger compositionally: it leaves
     * clean face between the groups instead of an even speckle over all of it.
     */
    const placements: Placement[] = [];
    const wanted = Math.max(1, Math.round(count * this.options.density * this.generatedDensity('cliffRock')));
    let guard = 0;
    while (placements.length < wanted && guard < wanted * 30) {
      guard += 1;
      const seedX = (this.random() * 2 - 1) * (WORLD.halfWidth - 4);
      const seedHeight = this.terrain.heightAt(seedX);
      // Needs enough face beneath it to sit in; a thin lip has nowhere to
      // embed a rock without it poking out of both sides.
      if (seedHeight - WORLD.waterY < 8) continue;
      const seedBelow = 3 + this.random() * Math.min(12, seedHeight - WORLD.waterY - 5);

      const members = 2 + Math.floor(this.random() * 2);
      for (let m = 0; m < members && placements.length < wanted; m += 1) {
        const x = seedX + (this.random() * 2 - 1) * 3.4;
        const height = this.terrain.heightAt(x);
        const scale = 1.1 + this.random() * 2.3;
        // Deep enough that the rock cannot breach the turf above it. Sizing
        // and depth were independent at first, and the big ones surfaced
        // through the grass and read as boulders balanced on the skyline.
        const below = Math.max(seedBelow + (this.random() * 2 - 1) * 2.2, scale * 1.45);
        const y = height - below;
        if (y < WORLD.waterY + 0.5) continue;
        // A crest falls away to both sides, so a rock embedded against the
        // centre column can still hang in mid-air a metre either way.
        if (y > this.terrain.heightAt(x - scale) - 1.1) continue;
        if (y > this.terrain.heightAt(x + scale) - 1.1) continue;
        placements.push({
          x,
          y,
          // Sunk back so roughly the front half stands proud of the wall.
          z: this.terrain.faceZAt(x, y) - 0.5,
          scale,
          rotation: this.random() * Math.PI * 2,
          // Stone in the wall reads by value, not by hue, so it takes a wider
          // spread than foliage does.
          tint: 0.78 + this.random() * 0.34,
        });
      }
    }
    this.commit('cliffRock', byMaterial, placements);
  }

  private spawn(
    key: string,
    template: () => PropTemplate,
    count: number,
    options: { minScale: number; maxScale: number; zRange: [number, number]; maxSlope?: number },
  ): void {
    if (this.skipped(key)) return;
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const part of this.partsFor(key, template())) {
      const list = byMaterial.get(part.material) ?? [];
      list.push(part.geometry);
      byMaterial.set(part.material, list);
    }

    const placements: Placement[] = [];
    const maxSlope = options.maxSlope ?? 1.2;
    const wanted = Math.max(1, Math.round(count * this.options.density * this.generatedDensity(key)));
    let guard = 0;
    while (placements.length < wanted && guard < wanted * 30) {
      guard += 1;
      const x = (this.random() * 2 - 1) * (WORLD.halfWidth - 3);
      const height = this.terrain.heightAt(x);
      if (height < WORLD.waterY + 0.6) continue;
      if (Math.abs(this.terrain.slopeAt(x)) > maxSlope) continue;
      placements.push({
        x,
        y: height,
        z: options.zRange[0] + this.random() * (options.zRange[1] - options.zRange[0]),
        scale: options.minScale + this.random() * (options.maxScale - options.minScale),
        rotation: this.random() * Math.PI * 2,
        tint: this.tintAt(x),
      });
    }

    this.commit(key, byMaterial, placements);
  }

  /** Vines hang from steep edges rather than standing on flat ground. */
  private spawnVines(count: number): void {
    if (this.skipped('vine')) return;
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const part of this.partsFor('vine', this.vine())) {
      const list = byMaterial.get(part.material) ?? [];
      list.push(part.geometry);
      byMaterial.set(part.material, list);
    }

    const placements: Placement[] = [];
    let guard = 0;
    while (placements.length < count && guard < count * 40) {
      guard += 1;
      const x = (this.random() * 2 - 1) * (WORLD.halfWidth - 4);
      const height = this.terrain.heightAt(x);
      if (height < WORLD.waterY + 3) continue;
      if (Math.abs(this.terrain.slopeAt(x)) < 0.55) continue;
      placements.push({
        x,
        y: height,
        z: 3.2 + this.random() * 1.2,
        scale: 1.1 + this.random() * 1.1,
        rotation: this.random() * 0.6 - 0.3,
        tint: this.tintAt(x),
      });
    }
    this.commit('vine', byMaterial, placements);
  }

  private commit(
    key: string,
    byMaterial: Map<THREE.Material, THREE.BufferGeometry[]>,
    placements: Placement[],
  ): void {
    if (placements.length === 0) return;
    const meshes: THREE.InstancedMesh[] = [];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();

    for (const [material, geometries] of byMaterial) {
      /*
       * A single geometry is used as it stands.
       *
       * Merging one thing with nothing still runs it through the non-indexed
       * conversion below, which triples the vertex count of an indexed mesh for
       * no benefit — and a generated prop is exactly that case: one indexed
       * mesh, one material.
       */
      const single = geometries.length === 1 ? geometries[0] : null;
      // Normalise indexing: CircleGeometry and ExtrudeGeometry differ from the
      // rest, and a mixed set makes mergeGeometries bail out entirely.
      const normalised = single ? [] : geometries.map((g) => (g.index ? g.toNonIndexed() : g));
      const merged = single ?? mergeGeometries(normalised, false);
      if (!merged) continue;
      this.ownedGeometries.push(merged);
      const mesh = new THREE.InstancedMesh(merged, material, placements.length);
      mesh.name = 'prop-' + key;
      mesh.castShadow = this.options.castShadows;
      mesh.receiveShadow = true;
      // Every prop is opaque, generated or not, so none of them need the
      // textured depth variant three would otherwise derive.
      mesh.customDepthMaterial = this.materials.opaqueDepth;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      placements.forEach((placement, index) => {
        euler.set(0, placement.rotation, 0);
        quaternion.setFromEuler(euler);
        position.set(placement.x, placement.y, placement.z);
        scale.setScalar(placement.scale);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (placements.some((placement) => placement.tint !== undefined)) {
        const tint = new THREE.Color();
        placements.forEach((placement, index) => {
          const value = placement.tint ?? 1;
          mesh.setColorAt(index, tint.setRGB(value, value, value));
        });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      meshes.push(mesh);
      for (let i = 0; i < normalised.length; i += 1) {
        if (normalised[i] !== geometries[i]) normalised[i].dispose();
      }
      if (single) continue;
    }

    /*
     * Free the sources that were copied into a merge.
     *
     * Not the single-geometry case: there the batch uses that buffer directly
     * rather than a copy of it, so disposing here would take the mesh with it.
     * Those are tracked in ownedGeometries and freed with everything else.
     */
    for (const geometries of byMaterial.values()) {
      if (geometries.length === 1) continue;
      for (const geometry of geometries) geometry.dispose();
    }

    this.batches.set(key, { meshes, placements, alive: placements.map(() => true) });
    // Terrain height at plant time, not the prop's own y: cliff rocks are
    // embedded well below the surface, and storing their own height would make
    // every one of them look displaced the first time anything was carved.
    this.groundHeights.set(key, placements.map((p) => this.terrain.heightAt(p.x)));
  }

  /**
   * Clears a standing area around a fighter.
   *
   * Props are scattered before spawn points are chosen, so without this a
   * fighter routinely ends up behind a palm trunk or inside a bamboo clump —
   * and a hero you cannot see is worse than no scenery at all. Tall props get a
   * wider berth than ground cover, which keeps the clearing from looking like a
   * mown circle.
   */
  clearAround(x: number, groundRadius: number, tallRadius: number): void {
    const tall = new Set(['palm', 'bamboo', 'log', 'boulder', 'bush', 'vine']);
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const [key, batch] of this.batches) {
      // Cliff rocks live in the wall below the standing surface, so they never
      // stand between the camera and a fighter and never need clearing.
      if (key === 'cliffRock') continue;
      const radius = tall.has(key) ? tallRadius : groundRadius;
      let changed = false;
      for (let i = 0; i < batch.placements.length; i += 1) {
        if (!batch.alive[i]) continue;
        if (Math.abs(batch.placements[i].x - x) > radius) continue;
        batch.alive[i] = false;
        for (const mesh of batch.meshes) mesh.setMatrixAt(i, zeroMatrix);
        changed = true;
      }
      if (changed) {
        for (const mesh of batch.meshes) mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /**
   * Retire props whose ground has moved. Called after every crater; comparing
   * planted height against current terrain height catches both props inside the
   * blast and props left hanging over its lip.
   */
  onTerrainChanged(): void {
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const [key, batch] of this.batches) {
      const planted = this.groundHeights.get(key);
      if (!planted) continue;
      let changed = false;
      for (let i = 0; i < batch.placements.length; i += 1) {
        if (!batch.alive[i]) continue;
        const current = this.terrain.heightAt(batch.placements[i].x);
        if (Math.abs(current - planted[i]) > 0.45) {
          batch.alive[i] = false;
          for (const mesh of batch.meshes) mesh.setMatrixAt(i, zeroMatrix);
          changed = true;
        }
      }
      if (changed) {
        for (const mesh of batch.meshes) mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  update(elapsed: number): void {
    for (const material of this.swayMaterials) {
      const shader = material.userData.shader as { uniforms: Record<string, { value: number }> } | undefined;
      if (shader) shader.uniforms.uTime.value = elapsed;
    }
  }

  get diagnostics(): {
    batches: number;
    instancedMeshes: number;
    props: number;
    density: number;
    castShadows: boolean;
  } {
    let instancedMeshes = 0;
    let props = 0;
    for (const batch of this.batches.values()) {
      instancedMeshes += batch.meshes.length;
      props += batch.placements.length;
    }
    return {
      batches: this.batches.size,
      instancedMeshes,
      props,
      density: this.options.density,
      castShadows: this.options.castShadows,
    };
  }

  dispose(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedGeometries.length = 0;
    this.batches.clear();
  }
}

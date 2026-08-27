import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MaterialLibrary } from '../MaterialLibrary';
import { oklch, toOklch } from '../palette';
import { bakeAmbientOcclusion, type OcclusionReport } from './occlusion';
import type { AnimalDef } from '../../game/types';

/**
 * Procedural fighter models.
 *
 * The target is the modern mascot-racer look: smooth high-poly forms, appealing
 * chunky proportions, an expressive face, and — the part that actually makes a
 * creature read as a *character* rather than an animal — a costume.
 *
 * Three rules drive everything here:
 *
 *  1. **No faceting.** Segment counts are high enough that silhouettes read as
 *     curves. Flat shading and hard edges are what made the first pass look
 *     like a prototype.
 *  2. **Faces do the work.** Every fighter gets a sclera/iris/pupil/highlight
 *     eye with a real upper lid that blinks, a brow that sets expression, and a
 *     mouth. At the play camera the face is a few dozen pixels, but it is the
 *     part a player looks at.
 *  3. **Costume over colour.** Goggles, straps, scarves, packs and buckles give
 *     each fighter a profile that survives being small and green on a green
 *     hillside — which colour alone never did.
 *
 * Every model is built facing +X. The owning entity rotates a pivot to face
 * left, so nothing here knows about aim direction.
 */

/**
 * Global size of every fighter in world units. The chassis is authored at
 * roughly 2.6 units tall; the arena is 124 wide, and at 1.0 the hero read as a
 * smudge at the play camera.
 */
export const FIGHTER_SCALE = 1.78;

/** Detail tier. Mobile roughly halves the round-off segment counts. */
export type ModelQuality = 'high' | 'low';

let quality: ModelQuality = 'high';

/** Set before building fighters; affects every subsequent model. */
export function setModelQuality(next: ModelQuality): void {
  quality = next;
}

const seg = {
  get sphereW(): number {
    return quality === 'high' ? 24 : 14;
  },
  get sphereH(): number {
    return quality === 'high' ? 16 : 10;
  },
  get smallW(): number {
    return quality === 'high' ? 14 : 8;
  },
  get smallH(): number {
    return quality === 'high' ? 10 : 6;
  },
  get radial(): number {
    return quality === 'high' ? 16 : 9;
  },
  get lathe(): number {
    return quality === 'high' ? 22 : 12;
  },
};

// Shared primitives, rebuilt when the quality tier changes.
let SPHERE = new THREE.SphereGeometry(1, 24, 16);
let SMALL_SPHERE = new THREE.SphereGeometry(1, 14, 10);
let CONE = new THREE.ConeGeometry(1, 1, 16);
let currentQuality: ModelQuality | null = null;

function ensurePrimitives(): void {
  if (currentQuality === quality) return;
  SPHERE.dispose();
  SMALL_SPHERE.dispose();
  CONE.dispose();
  SPHERE = new THREE.SphereGeometry(1, seg.sphereW, seg.sphereH);
  SMALL_SPHERE = new THREE.SphereGeometry(1, seg.smallW, seg.smallH);
  CONE = new THREE.ConeGeometry(1, 1, seg.radial);
  currentQuality = quality;
}

export type FighterModel = {
  root: THREE.Group;
  /** Facing pivot. Rotated 180 degrees to turn around; never mirrored. */
  facing: THREE.Group;
  /** Bob/squash anchor. Scaling this leaves the feet planted. */
  body: THREE.Group;
  head: THREE.Group;
  /**
   * The head as a volume, in the root's own space.
   *
   * A point is not enough, and two attempts proved it. Framing on a fraction
   * of standing height broke the moment one species changed proportions.
   * Framing on the head node put the camera at the right height and still
   * cropped a toucan's beak, buried a gecko's face against the left edge and
   * left a frog looking distant — because heads differ in size and in how far
   * they sit from the neck, and a point carries neither. A box carries both,
   * so a camera can aim at its centre and pull back to fit its radius.
   */
  headBounds: THREE.Box3;
  /** Throwing arm; rotated on the Z axis during the wind-up. */
  throwArm: THREE.Group;
  /** World anchor the projectile spawns from. */
  hand: THREE.Object3D;
  /** Upper eyelids, rotated closed to blink. */
  lids: THREE.Object3D[];
  /** Brows, nudged for expression on damage. */
  brows: THREE.Object3D[];
  /** Soft disc under the feet so the fighter reads as grounded. */
  contact: THREE.Mesh;
  /** Every material unique to this fighter, for hit flashes and disposal. */
  materials: THREE.MeshStandardMaterial[];
  /** Standing height in world units, for camera framing and hit tests. */
  height: number;
  /** Standing height in the root's LOCAL units, for anything parented to it. */
  localHeight: number;
  /**
   * Pushes the posed proxies onto whatever actually moves, once per frame.
   *
   * Built fighters have none: `Fighter` writes straight to the groups it is
   * handed and they are the real thing. A skinned model cannot offer that — a
   * bone lives in the skeleton hierarchy and cannot be reparented under a
   * pivot — so its groups are detached stand-ins and this copies them across.
   */
  applyPose?: () => void;
  /**
   * Releases whatever this model owns, when it owns less than all of it.
   *
   * A built fighter owns every buffer under its root, so callers can simply
   * traverse and dispose. A generated one does not: its geometry and textures
   * belong to a cached source that every other clone of that species shares,
   * and disposing them takes the species down for the rest of the session.
   * Models that need the distinction supply this; `releaseFighterModel`
   * decides which path to take.
   */
  dispose?: () => void;
  diagnostics: {
    meshes: number;
    triangles: number;
    occlusion: OcclusionReport;
    /** Driven bones, zero for a built fighter. */
    bones?: number;
    /** Axes the swing chain rotates about, in the model's own space. */
    swingAxis?: string;
    /** Head box extents in root units, so bad framing is visible as numbers. */
    headBox?: string;
  };
};

// --------------------------------------------------------------- geometry

/**
 * Lathe profile for a soft pear torso.
 *
 * A single sine lobe gives an egg; blending a second, lower lobe gives the
 * belly-forward silhouette these characters need to look soft rather than
 * inflated.
 */
function torsoGeometry(radius: number, height: number, belly: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const steps = quality === 'high' ? 20 : 12;
  let peak = 0.001;
  const raw: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const main = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.86)), 0.78);
    const lobe = Math.exp(-Math.pow((t - 0.36) * 2.6, 2));
    const profile = main * (1 - belly * 0.22) + lobe * belly * 0.42;
    raw.push(profile);
    peak = Math.max(peak, profile);
  }
  // Normalise so `radius` is the true half-width. Without this the belly lobe
  // stacked on top of the main lobe and the torso came out half again as wide
  // as asked for — which is how the first pass ended up an avocado.
  for (let i = 0; i <= steps; i += 1) {
    points.push(new THREE.Vector2(Math.max(0.015, (raw[i] / peak) * radius), (i / steps) * height));
  }
  return new THREE.LatheGeometry(points, seg.lathe);
}

/**
 * Cranium profile: a dome that tucks under at the jaw rather than closing to a
 * point, so the head reads as a skull and not a ball.
 */
function craniumGeometry(radius: number, height: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const steps = quality === 'high' ? 18 : 11;
  let peak = 0.001;
  const raw: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    // Raising the sine to a fractional power fattens both poles, turning a
    // lens into a dome. Without it the skull came to a visible cone at the
    // crown wherever no other geometry covered it.
    const profile = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.62);
    raw.push(profile);
    peak = Math.max(peak, profile);
  }
  for (let i = 0; i <= steps; i += 1) {
    points.push(
      new THREE.Vector2(Math.max(0.02, (raw[i] / peak) * radius), (i / steps - 0.5) * height),
    );
  }
  return new THREE.LatheGeometry(points, seg.lathe);
}

/** Smooth capsule limb with independent end radii and rounded caps. */
function limbGeometry(topRadius: number, bottomRadius: number, length: number): THREE.BufferGeometry {
  const points: THREE.Vector2[] = [];
  const steps = quality === 'high' ? 12 : 7;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const cap = Math.sin(Math.PI * Math.min(1, Math.max(0, t * 1.06 - 0.03)));
    const radius = topRadius + (bottomRadius - topRadius) * t;
    points.push(new THREE.Vector2(Math.max(0.008, radius * (0.62 + cap * 0.38)), -t * length));
  }
  return new THREE.LatheGeometry(points, seg.radial);
}

/** Flat hexagon plate with a bevel, used for tortoise scutes. */
function scuteGeometry(radius: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: quality === 'high' ? 3 : 1,
  });
}

/** Swept beak half. Tapers to a point and hooks down along its length. */
function beakGeometry(length: number, depth: number, curve: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const steps = quality === 'high' ? 16 : 9;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(new THREE.Vector2(Math.max(0.008, depth * Math.pow(1 - t, 0.62)), t * length));
  }
  const geometry = new THREE.LatheGeometry(points, seg.radial);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const t = position.getY(i) / length;
    position.setX(i, position.getX(i) - curve * t * t);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Tapered tube swept along a curve. Chains of separate spheres read as a
 * caterpillar of loose beads; a swept tube reads as one continuous tail.
 */
function tailGeometry(points: THREE.Vector3[], radius: number): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const tubular = quality === 'high' ? 22 : 12;
  const geometry = new THREE.TubeGeometry(curve, tubular, radius, seg.radial, false);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const ring = seg.radial + 1;
  // Taper by pulling each ring toward its own centre on the curve.
  for (let i = 0; i < position.count; i += 1) {
    const t = Math.floor(i / ring) / tubular;
    const centre = curve.getPointAt(Math.min(0.999, t));
    const shrink = 1 - t * 0.86;
    position.setXYZ(
      i,
      centre.x + (position.getX(i) - centre.x) * shrink,
      centre.y + (position.getY(i) - centre.y) * shrink,
      centre.z + (position.getZ(i) - centre.z) * shrink,
    );
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Cranium half-width at a normalised height, matching `craniumGeometry`.
 *
 * Accessories that should hug the skull — headbands, goggle straps — need the
 * actual radius at their own height, or they float off it.
 */
function craniumRadiusAt(radius: number, t: number): number {
  // Must stay in step with craniumGeometry, or accessories mount off-surface.
  const profile = (u: number) => Math.pow(Math.sin(Math.PI * Math.pow(u, 0.78)), 0.62);
  let peak = 0.001;
  for (let i = 0; i <= 24; i += 1) peak = Math.max(peak, profile(i / 24));
  return (profile(Math.min(0.999, Math.max(0.001, t))) / peak) * radius;
}

/**
 * Places an object on the surface of the skull.
 *
 * Eyes positioned by hand-guessed offsets sank inside the cranium — at a head
 * radius of 0.62 an eye at (0.35, 0.15, 0.33) is 0.50 from centre and simply
 * buried. Mounting by yaw and pitch on a sphere of known radius puts every
 * feature proud of the surface by construction, which is also the look these
 * characters want: eyes that bulge slightly rather than sit in sockets.
 *
 * Yaw is degrees away from straight ahead (+X); side picks which flank.
 */
function mountOnSkull(
  object: THREE.Object3D,
  headRadius: number,
  headHeight: number,
  yawDegrees: number,
  pitchDegrees: number,
  side: number,
  seat = 0.92,
): THREE.Object3D {
  const yaw = THREE.MathUtils.degToRad(yawDegrees) * side;
  const pitch = THREE.MathUtils.degToRad(pitchDegrees);
  // Height on the lathe, then the radius the lathe actually has there.
  const y = Math.sin(pitch) * headHeight * 0.5;
  const t = y / headHeight + 0.5;
  const radius = craniumRadiusAt(headRadius, t) * seat;

  object.position.set(Math.cos(yaw) * radius, y, Math.sin(yaw) * radius);
  /*
   * Face outward, then cheat toward the camera.
   *
   * The game is played from a locked side-on camera, so a feature that
   * honestly faces the direction the fighter is walking is seen edge-on for
   * the entire match. At 0.72 the irises still sat far enough round that the
   * near eye read as a blank white ball in play while looking perfectly fine
   * in the three-quarter character-select portrait — which is exactly the trap
   * of judging a model in the view it is not played in. 0.86 costs a little
   * accuracy in the portrait and buys a face in the frame that matters.
   */
  object.rotation.set(0, -yaw * 0.86, 0);
  return object;
}

/** Half-shell used for eyelids. */
function capGeometry(radius: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(radius, seg.smallW, seg.smallH, 0, Math.PI * 2, 0, Math.PI * 0.5);
}

// --------------------------------------------------------------- context

type EyeResult = { group: THREE.Group; lid: THREE.Object3D; brow: THREE.Object3D };

/**
 * A darker, less saturated version of a colour, for lines drawn on a surface.
 *
 * The mouths were being drawn in whatever contrasting material was to hand —
 * the accent orange on the gecko, near-black on the frog — and on a light hide
 * both read as a painted bar stuck across the face rather than as an opening.
 * A lip is the same material as the skin around it with the light kept off it,
 * so deriving it from the body colour is both truer and self-maintaining as
 * the palette moves.
 */
function shadeOf(color: number, drop = 0.32): number {
  const { L, C, h } = toOklch(new THREE.Color().setHex(color, THREE.SRGBColorSpace));
  return oklch(Math.max(0.08, L * (1 - drop)), C * 0.62, h).getHex(THREE.SRGBColorSpace);
}

type BuildContext = {
  materials: MaterialLibrary;
  def: AnimalDef;
  /** Main hide. */
  skin: THREE.MeshStandardMaterial;
  /** Belly, muzzle, inner ear — lighter than the hide. */
  belly: THREE.MeshStandardMaterial;
  /** Markings, crest, beak. */
  accent: THREE.MeshStandardMaterial;
  /** Costume fabric. */
  cloth: THREE.MeshStandardMaterial;
  /** Lips and mouth seams: the body colour with the light taken off it. */
  mouthLine: THREE.MeshStandardMaterial;
  /** Straps, gloves, boots. */
  leather: THREE.MeshStandardMaterial;
  geometries: THREE.BufferGeometry[];
  eyes: EyeResult[];
};

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  result.name = name;
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function place(
  object: THREE.Object3D,
  position: [number, number, number],
  rotation?: [number, number, number],
  scale?: [number, number, number] | number,
): THREE.Object3D {
  object.position.set(position[0], position[1], position[2]);
  if (rotation) object.rotation.set(rotation[0], rotation[1], rotation[2]);
  if (typeof scale === 'number') object.scale.setScalar(scale);
  else if (scale) object.scale.set(scale[0], scale[1], scale[2]);
  return object;
}

// -------------------------------------------------------------------- face

/**
 * Eye assembly.
 *
 * Sclera, a large dark iris, a pupil, a hard specular dot, and a skin-coloured
 * upper lid that sits about a fifth closed at rest. That resting lid is what
 * gives the face an attitude — a fully open eye reads as a startled doll.
 */
function buildEye(ctx: BuildContext, radius: number, browTilt: number): EyeResult {
  const group = new THREE.Group();
  group.name = 'eye';

  const sclera = mesh(SPHERE, ctx.materials.sclera, 'sclera');
  sclera.scale.set(radius, radius * 1.08, radius * 0.92);
  group.add(sclera);

  /*
   * A big iris on a small sclera.
   *
   * It was the other way round, and from the locked side camera the near eye
   * foreshortened into a white ball with a dark chip on its edge. The
   * character-select portrait looks straight at the face and hid the problem
   * completely — the iris has to be sized for the oblique view, which is the
   * only one the match is played in.
   */
  const iris = mesh(SPHERE, ctx.materials.iris, 'iris');
  iris.scale.set(radius * 0.52, radius * 0.8, radius * 0.76);
  iris.position.set(radius * 0.72, 0, 0);
  group.add(iris);

  const pupil = mesh(SMALL_SPHERE, ctx.materials.eyeDark, 'pupil');
  pupil.scale.set(radius * 0.3, radius * 0.44, radius * 0.42);
  pupil.position.set(radius * 0.94, 0, 0);
  group.add(pupil);

  // Unlit highlight: a real specular would swim as the fighter turns. Dropped
  // on the low tier — it is its own material, so it is a draw call per fighter
  // for something under a pixel on a phone.
  if (quality === 'high') {
    const highlight = mesh(SMALL_SPHERE, ctx.materials.catchlight, 'catchlight');
    // Small, and sitting on the iris rather than out on the white. At 0.15 of
    // the eye radius it blew out into a lens flare at any close framing.
    highlight.scale.setScalar(radius * 0.1);
    highlight.position.set(radius * 0.92, radius * 0.3, radius * 0.3);
    highlight.castShadow = false;
    group.add(highlight);
  }

  const lidGeometry = capGeometry(radius * 1.05);
  ctx.geometries.push(lidGeometry);
  const lid = mesh(lidGeometry, ctx.skin, 'eyelid');
  /*
   * Rest angle.
   *
   * The cap covers the hemisphere around its own +Y axis, so a NEGATIVE Z
   * rotation tilts it forward across the iris — which is how the first pass
   * ended up with a skin-coloured shell swallowing the whole eye. Positive
   * tilts it back onto the brow, leaving the iris clear and the eye hooded.
   */
  lid.rotation.z = 0.55;
  lid.castShadow = false;
  group.add(lid);

  // A brow sitting a full radius clear of the eyeball reads as an antenna.
  // It belongs on the lid, curved along it, and small.
  const browGeometry = new THREE.TorusGeometry(radius * 0.86, radius * 0.11, 6, seg.smallW, Math.PI * 0.5);
  ctx.geometries.push(browGeometry);
  const brow = mesh(browGeometry, ctx.accent, 'brow');
  brow.rotation.set(0, -Math.PI / 2, Math.PI * 0.25 + browTilt);
  brow.position.set(radius * 0.34, radius * 0.12, 0);
  group.add(brow);

  return { group, lid, brow };
}

/** Lip band plus a dark interior, so the mouth reads as an opening. */
function buildMouth(
  ctx: BuildContext,
  width: number,
  arc: number,
  material: THREE.MeshStandardMaterial,
  /**
   * Whether to include the dark interior.
   *
   * Only worth it on a muzzle that stands clear of the skull. On a wide mouth
   * drawn across the front of the head itself, the interior sphere has nowhere
   * to sit that is not already inside the cranium, and it pushes out through
   * the underside of the jaw as a dark smear.
   */
  interior = true,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'mouth';

  // Thin. At 0.115 of the ring radius the tube stood well proud of a wide
  // mouth and caught the key light along its whole length, which is what made
  // it read as a bar laid on the face instead of a seam in it.
  const lipGeometry = new THREE.TorusGeometry(width, width * 0.062, 7, seg.radial, arc);
  ctx.geometries.push(lipGeometry);
  const lip = mesh(lipGeometry, material, 'lip');
  /*
   * Aim the arc at +X, which is the way the fighter faces.
   *
   * It was aimed at the back of the head. A partial torus runs from angle 0 to
   * `arc` in the XY plane, so its midpoint sits at arc/2; the old rotation
   * added another `pi/2 + arc/2` on top of that, which for a typical arc put
   * the midpoint near 240 degrees — and the following quarter-turn about X
   * carried it round to face backwards. It went unnoticed because the muzzled
   * species place their mouth ring out on the snout, where the ring is small
   * enough that part of it shows anyway; on a wide mouth drawn across the skull
   * itself, the whole thing hid round the back of the head.
   *
   * Euler order is XYZ, which three applies innermost-first: Z, then Y, then X.
   * So -arc/2 about Z brings the midpoint back to +X, and the quarter-turn
   * about X then tips the ring from the XY plane into the XZ plane, leaving
   * that midpoint where it is.
   */
  lip.rotation.set(Math.PI / 2, 0, -arc / 2);
  group.add(lip);

  if (interior) {
    const inside = mesh(SMALL_SPHERE, ctx.materials.eyeDark, 'mouthInterior');
    inside.scale.set(width * 0.5, width * 0.3, width * 0.72);
    inside.position.set(-width * 0.12, -width * 0.16, 0);
    group.add(inside);
  }

  return group;
}

// -------------------------------------------------------------------- limbs

/** Palm plus a thumb and three soft finger nubs. */
function buildHand(size: number, material: THREE.MeshStandardMaterial): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hand';

  const palm = mesh(SPHERE, material, 'palm');
  palm.scale.set(size * 1.15, size, size * 0.78);
  group.add(palm);

  const thumb = mesh(SMALL_SPHERE, material, 'thumb');
  thumb.scale.set(size * 0.44, size * 0.38, size * 0.38);
  place(thumb, [size * 0.5, size * 0.34, size * 0.5], [0, 0, 0.5]);
  group.add(thumb);

  for (let i = 0; i < 3; i += 1) {
    const finger = mesh(SMALL_SPHERE, material, 'finger');
    finger.scale.set(size * 0.5, size * 0.34, size * 0.3);
    place(finger, [size * 0.85, size * 0.1 - i * size * 0.02, (i - 1) * size * 0.34]);
    group.add(finger);
  }
  return group;
}

/** Sole, heel and three toes. */
function buildFoot(size: number, material: THREE.MeshStandardMaterial): THREE.Group {
  const group = new THREE.Group();
  group.name = 'foot';

  const sole = mesh(SPHERE, material, 'sole');
  sole.scale.set(size * 1.35, size * 0.62, size * 0.92);
  sole.position.set(size * 0.28, size * 0.42, 0);
  group.add(sole);

  const heel = mesh(SMALL_SPHERE, material, 'heel');
  heel.scale.set(size * 0.6, size * 0.55, size * 0.72);
  heel.position.set(-size * 0.34, size * 0.5, 0);
  group.add(heel);

  for (let i = 0; i < 3; i += 1) {
    const toe = mesh(SMALL_SPHERE, material, 'toe');
    toe.scale.setScalar(size * 0.3);
    place(toe, [size * 1.12, size * 0.32, (i - 1) * size * 0.42]);
    group.add(toe);
  }
  return group;
}

type ArmResult = { group: THREE.Group; grip: THREE.Object3D };

/** Shoulder, upper arm, elbow, forearm, wrist wrap, hand, grip anchor. */
function buildArm(ctx: BuildContext, upper: number, lower: number, thickness: number): ArmResult {
  const group = new THREE.Group();
  group.name = 'arm';

  const shoulder = mesh(SPHERE, ctx.skin, 'shoulder');
  shoulder.scale.setScalar(thickness * 1.32);
  group.add(shoulder);

  const upperGeo = limbGeometry(thickness * 1.05, thickness * 0.86, upper);
  ctx.geometries.push(upperGeo);
  group.add(mesh(upperGeo, ctx.skin, 'upperArm'));

  const elbow = new THREE.Group();
  elbow.name = 'elbow';
  elbow.position.y = -upper;
  group.add(elbow);

  const elbowBall = mesh(SMALL_SPHERE, ctx.skin, 'elbowBall');
  elbowBall.scale.setScalar(thickness * 1.02);
  elbow.add(elbowBall);

  const lowerGeo = limbGeometry(thickness * 0.94, thickness * 0.8, lower);
  ctx.geometries.push(lowerGeo);
  elbow.add(mesh(lowerGeo, ctx.skin, 'forearm'));

  const cuffGeo = new THREE.TorusGeometry(thickness * 0.92, thickness * 0.26, 8, seg.radial);
  ctx.geometries.push(cuffGeo);
  const cuff = mesh(cuffGeo, ctx.leather, 'wristWrap');
  cuff.rotation.x = Math.PI / 2;
  cuff.position.y = -lower * 0.88;
  elbow.add(cuff);

  const handAnchor = new THREE.Group();
  handAnchor.name = 'handAnchor';
  handAnchor.position.y = -lower - thickness * 0.5;
  elbow.add(handAnchor);
  handAnchor.add(buildHand(thickness * 1.25, ctx.skin));

  const grip = new THREE.Object3D();
  grip.name = 'grip';
  grip.position.set(thickness * 1.6, 0, 0);
  handAnchor.add(grip);

  return { group, grip };
}

/** Hip, thigh, knee, shin, boot. */
function buildLeg(ctx: BuildContext, length: number, thickness: number, footSize: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'leg';

  const hip = mesh(SPHERE, ctx.skin, 'hip');
  hip.scale.setScalar(thickness * 1.4);
  group.add(hip);

  const thighGeo = limbGeometry(thickness * 1.2, thickness * 0.95, length * 0.56);
  ctx.geometries.push(thighGeo);
  group.add(mesh(thighGeo, ctx.skin, 'thigh'));

  const knee = new THREE.Group();
  knee.position.y = -length * 0.56;
  group.add(knee);

  const kneeBall = mesh(SMALL_SPHERE, ctx.skin, 'knee');
  kneeBall.scale.setScalar(thickness * 1.05);
  knee.add(kneeBall);

  const shinGeo = limbGeometry(thickness, thickness * 0.85, length * 0.44);
  ctx.geometries.push(shinGeo);
  knee.add(mesh(shinGeo, ctx.skin, 'shin'));

  const bootGeo = new THREE.TorusGeometry(thickness * 1.05, thickness * 0.3, 8, seg.radial);
  ctx.geometries.push(bootGeo);
  const bootCuff = mesh(bootGeo, ctx.leather, 'bootCuff');
  bootCuff.rotation.x = Math.PI / 2;
  bootCuff.position.y = -length * 0.44 + thickness * 0.2;
  knee.add(bootCuff);

  // Skin feet with a leather cuff. Fully leather feet read as mud clods at the
  // bottom of the silhouette.
  const foot = buildFoot(footSize, ctx.skin);
  foot.position.y = -length * 0.44 - footSize * 0.3;
  knee.add(foot);

  return group;
}

// ------------------------------------------------------------------ costume

/** Strap running diagonally across the chest, with a metal buckle. */
function addChestStrap(ctx: BuildContext, body: THREE.Group, radius: number, height: number): void {
  const strapGeo = new THREE.TorusGeometry(radius * 1.04, radius * 0.09, 8, seg.lathe);
  ctx.geometries.push(strapGeo);
  const strap = mesh(strapGeo, ctx.leather, 'bandolier');
  strap.position.set(0, height * 0.6, 0);
  strap.scale.set(1, 1, 0.92);
  // Euler order made this a belt no matter what angle was asked for: a torus
  // spun about its own axis looks identical. Aim the axis directly instead —
  // forward and up, so the ring drapes shoulder to opposite hip.
  strap.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0.78, 0.63, 0).normalize(),
  );
  body.add(strap);

  const buckleGeo = new THREE.BoxGeometry(radius * 0.26, radius * 0.26, radius * 0.09, 1, 1, 1);
  ctx.geometries.push(buckleGeo);
  const buckle = mesh(buckleGeo, ctx.materials.hardware, 'buckle');
  place(buckle, [radius * 0.62, height * 0.6 + radius * 0.6, radius * 0.2], [0, 0, 0.95]);
  body.add(buckle);
}

/** Neckerchief: a collar with a knot and two tails. */
function addScarf(ctx: BuildContext, body: THREE.Group, radius: number, y: number): void {
  const collarGeo = new THREE.CylinderGeometry(
    radius * 0.6,
    radius * 0.86,
    radius * 0.46,
    seg.lathe,
    1,
    true,
  );
  ctx.geometries.push(collarGeo);
  const collar = mesh(collarGeo, ctx.cloth, 'scarfCollar');
  collar.position.y = y;
  body.add(collar);

  const knot = mesh(SMALL_SPHERE, ctx.cloth, 'scarfKnot');
  knot.scale.setScalar(radius * 0.24);
  knot.position.set(radius * 0.6, y - radius * 0.12, 0);
  body.add(knot);

  for (let i = 0; i < 2; i += 1) {
    const tailGeo = new THREE.ConeGeometry(radius * 0.2, radius * 0.9, seg.smallW);
    ctx.geometries.push(tailGeo);
    const tail = mesh(tailGeo, ctx.cloth, 'scarfTail');
    place(
      tail,
      [radius * 0.62, y - radius * 0.55, (i === 0 ? 1 : -1) * radius * 0.16],
      [0, 0, Math.PI + (i === 0 ? 0.3 : -0.1)],
    );
    body.add(tail);
  }
}

function addGoggles(ctx: BuildContext, head: THREE.Group, radius: number, height: number): void {
  /*
   * One unit worn on the brow, not two rings stuck to the skull.
   *
   * The first version mounted each rim separately by yaw and pitch and pointed
   * it radially outward. On a head this wide that puts the far rim almost at
   * the side of the skull, edge-on, and from any three-quarter view it read as
   * a length of wire hooked over the head — the near rim looked like a monocle
   * and the far one like a handle. Goggles are a rigid object: both cups face
   * the same way, they sit side by side across the front of the face, and the
   * strap is the only part that follows the skull. Building them that way is
   * both simpler and the only version that reads.
   */
  const goggles = new THREE.Group();
  goggles.name = 'goggles';

  const browT = 0.66;
  const browY = (browT - 0.5) * height;
  // Pushed out to the skull's own radius at that height so the cups stand
  // clear of the forehead instead of sinking into it.
  goggles.position.set(craniumRadiusAt(radius, browT) * 1.0, browY, 0);
  // Tipped back, the way goggles pushed up off the eyes actually sit.
  goggles.rotation.z = -0.3;
  head.add(goggles);

  const cupRadius = radius * 0.23;
  const cupDepth = radius * 0.17;
  const gap = radius * 0.29;

  const cupGeo = new THREE.CylinderGeometry(cupRadius, cupRadius * 0.86, cupDepth, seg.radial, 1, true);
  const rimGeo = new THREE.TorusGeometry(cupRadius, radius * 0.045, 7, seg.radial);
  ctx.geometries.push(cupGeo, rimGeo);

  for (const side of [-1, 1]) {
    // Cylinder and torus both stand on their own axis; a quarter turn about Y
    // lays them along +X so the cups look where the fighter looks.
    const cup = mesh(cupGeo, ctx.materials.hardware, 'goggleCup');
    place(cup, [0, 0, side * gap], [0, 0, Math.PI / 2]);
    goggles.add(cup);

    const rim = mesh(rimGeo, ctx.materials.hardware, 'goggleRim');
    place(rim, [cupDepth * 0.5, 0, side * gap], [0, Math.PI / 2, 0]);
    goggles.add(rim);

    if (quality === 'high') {
      const lensGeo = new THREE.CircleGeometry(cupRadius * 0.94, seg.radial);
      ctx.geometries.push(lensGeo);
      const lens = mesh(lensGeo, ctx.materials.lens, 'goggleLens');
      place(lens, [cupDepth * 0.44, 0, side * gap], [0, Math.PI / 2, 0]);
      lens.castShadow = false;
      goggles.add(lens);
    }
  }

  // Bridge across the nose, joining the cups into one object.
  const bridge = mesh(SPHERE, ctx.leather, 'goggleBridge');
  bridge.scale.set(cupDepth * 0.34, cupRadius * 0.34, gap * 0.9);
  bridge.position.set(0, -cupRadius * 0.1, 0);
  goggles.add(bridge);

  // Strap around the skull, at the height the cups sit.
  const bandRadius = craniumRadiusAt(radius, browT) * 1.02;
  const bandGeo = new THREE.TorusGeometry(bandRadius, radius * 0.062, 8, seg.lathe);
  ctx.geometries.push(bandGeo);
  const band = mesh(bandGeo, ctx.leather, 'goggleStrap');
  place(band, [0, browY, 0], [Math.PI / 2, 0, 0]);
  head.add(band);
}

/** Small pack worn on the back. */
function addPack(ctx: BuildContext, body: THREE.Group, radius: number, y: number): void {
  // Rounded, and hugging the back. A hard-edged box in a saturated fabric
  // colour read as a prop dropped onto the model rather than a worn satchel.
  const pack = mesh(SPHERE, ctx.cloth, 'pack');
  pack.scale.set(radius * 0.34, radius * 0.42, radius * 0.5);
  place(pack, [-radius * 0.92, y, 0], [0, 0, 0.12]);
  body.add(pack);

  const flap = mesh(SPHERE, ctx.leather, 'packFlap');
  flap.scale.set(radius * 0.3, radius * 0.16, radius * 0.52);
  place(flap, [-radius * 0.94, y + radius * 0.3, 0], [0, 0, 0.12]);
  body.add(flap);
}

// ----------------------------------------------------------------- species

type Proportions = {
  torsoRadius: number;
  torsoHeight: number;
  belly: number;
  headRadius: number;
  headHeight: number;
  headY: number;
  legLength: number;
  armUpper: number;
  armLower: number;
  limbThickness: number;
  footSize: number;
  scale: number;
};

type SpeciesBuilder = (ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions) => void;

function buildGecko(ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions): void {
  const r = p.headRadius;

  const snout = mesh(SPHERE, ctx.skin, 'snout');
  snout.scale.set(r * 0.5, r * 0.38, r * 0.42);
  snout.position.set(r * 0.78, -r * 0.18, 0);
  head.add(snout);

  // Tucked under the skull rather than hung off the front of it. At 0.6r out
  // and 0.58r long it cleared the head's silhouette from the side and read as
  // a pale wedge stuck to the throat.
  const jaw = mesh(SPHERE, ctx.belly, 'jaw');
  jaw.scale.set(r * 0.46, r * 0.2, r * 0.44);
  jaw.position.set(r * 0.46, -r * 0.4, 0);
  head.add(jaw);

  head.add(place(buildMouth(ctx, r * 0.4, Math.PI * 0.78, ctx.mouthLine), [r * 0.7, -r * 0.3, 0]));

  for (const side of [-1, 1]) {
    const eye = buildEye(ctx, r * 0.34, side * 0.2 - 0.12);
    mountOnSkull(eye.group, r, p.headHeight, 48, 8, side, 1);
    head.add(eye.group);
    ctx.eyes.push(eye);

    const nostril = mesh(SMALL_SPHERE, ctx.materials.eyeDark, 'nostril');
    nostril.scale.setScalar(r * 0.06);
    nostril.position.set(r * 1.18, r * 0.02, side * r * 0.14);
    head.add(nostril);
  }

  /*
   * Dorsal crest.
   *
   * Roughly doubled from the first pass, which set each spine at about a tenth
   * of the torso radius — thinner than the seam it sat on, and invisible at any
   * distance the game is actually played from. The generated gecko carries a
   * bold orange run down its back and it is most of what identifies the
   * silhouette as a lizard rather than a generic mascot.
   */
  for (let i = 0; i < 9; i += 1) {
    const t = i / 8;
    const spine = mesh(CONE, ctx.accent, 'crest');
    spine.scale.set(p.torsoRadius * 0.2, p.torsoRadius * (0.62 - t * 0.36), p.torsoRadius * 0.15);
    place(
      spine,
      [-t * p.torsoRadius * 1.35, p.torsoHeight * (0.95 - t * 0.2), 0],
      [0, 0, 0.42 + t * 0.3],
    );
    body.add(spine);
  }

  const tailPath: THREE.Vector3[] = [];
  for (let i = 0; i <= 5; i += 1) {
    const t = i / 5;
    const angle = t * 2.6;
    tailPath.push(
      new THREE.Vector3(
        -t * 1.75 + Math.sin(angle) * 0.22,
        Math.sin(angle * 1.25) * 0.34 - t * 0.1,
        0,
      ),
    );
  }
  const tailGeo = tailGeometry(tailPath, p.torsoRadius * 0.42);
  ctx.geometries.push(tailGeo);
  const tail = mesh(tailGeo, ctx.skin, 'tail');
  tail.position.set(-p.torsoRadius * 0.82, p.torsoHeight * 0.34, 0);
  body.add(tail);

  // Banding along the tail, tucked slightly inside so it reads as marking.
  for (let i = 1; i < 5; i += 1) {
    const t = i / 5;
    const angle = t * 2.6;
    const band = mesh(SPHERE, ctx.accent, 'tailBand');
    const r = p.torsoRadius * 0.42 * (1 - t * 0.86) * 1.01;
    band.scale.set(r * 0.34, r, r);
    band.position.set(
      -p.torsoRadius * 0.82 - t * 1.75 + Math.sin(angle) * 0.22,
      p.torsoHeight * 0.34 + Math.sin(angle * 1.25) * 0.34 - t * 0.1,
      0,
    );
    body.add(band);
  }

  addGoggles(ctx, head, r, p.headHeight);
  addChestStrap(ctx, body, p.torsoRadius, p.torsoHeight);
}

function buildFrog(ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions): void {
  const r = p.headRadius;

  /*
   * A frog is a mouth with a body attached, and the mouth was the part that
   * did not work. It was built as a ring of radius 0.74r placed half a radius
   * forward, so it reached past the front of a 0.66r head and read as a flat
   * salmon plank sticking out of the face. A wide mouth belongs on the skull,
   * not in front of it: centring the ring and sizing it to the head turns the
   * same geometry into a line that follows the muzzle.
   */
  // A throat, not a bib. At half again this size it merged with the belly
  // patch below it into one pale mass running the whole front of the model.
  const throat = mesh(SPHERE, ctx.belly, 'throat');
  throat.scale.set(r * 0.44, r * 0.26, r * 0.5);
  throat.position.set(r * 0.42, -r * 0.34, 0);
  head.add(throat);

  /*
   * The mouth is the frog, and it kept failing for the same reason the boar's
   * snout did: its radius was a guessed multiple of the head radius rather
   * than the radius the skull actually has at that height. Guess too small and
   * the ring sits inside the head, invisible; too large and it juts out as a
   * plank. `craniumRadiusAt` is the same function the lathe is built from, so
   * asking it puts the line on the surface by construction.
   *
   * Drawn dark rather than in the accent salmon: a line this wide in a
   * saturated colour competes with the eyes for the face, and on a cyan head it
   * reads as paint. Dark reads as an opening.
   */
  /*
   * A muzzle, after several attempts without one.
   *
   * The frog was the only fighter built as a bare sphere with features painted
   * on it, and it was the only one that would not read. Wrapping the mouth
   * around the skull is the anatomically truer answer and it kept coming out as
   * a slot cut in a ball, at every width and every tone tried: a straight dark
   * line across a smooth dome has nothing to be the edge of.
   *
   * Every other species here works because a muzzle projects forward and the
   * mouth sits on the part that projects — the line then divides two forms
   * instead of interrupting one. A frog gets a wide, low, shallow muzzle rather
   * than a snout, which keeps the species read while joining the construction
   * the rest of the cast already uses.
   */
  /*
   * Sized against the skull rather than guessed at.
   *
   * The lathe's widest radius is `r`, and at the height the muzzle sits
   * `craniumRadiusAt` still returns about 0.99r — so anything centred inside
   * about 0.7r with a radius under 0.3r is entirely swallowed, which is what
   * happened to the first two attempts and to the mouth ring both times. The
   * muzzle centre therefore sits *past* the head radius at 1.09r, with its back
   * still inside the skull at 0.73r and its tip clear at 1.45r, and the mouth
   * ring shares that centre so the seam lands on the muzzle's own front face by
   * construction instead of by trial.
   */
  const muzzle = mesh(SPHERE, ctx.skin, 'muzzle');
  muzzle.scale.set(r * 0.36, r * 0.32, r * 0.62);
  muzzle.position.set(r * 1.09, -r * 0.14, 0);
  head.add(muzzle);

  const chin = mesh(SPHERE, ctx.belly, 'chin');
  chin.scale.set(r * 0.28, r * 0.15, r * 0.46);
  chin.position.set(r * 1.02, -r * 0.38, 0);
  head.add(chin);

  head.add(
    place(buildMouth(ctx, r * 0.35, Math.PI * 0.86, ctx.mouthLine, false), [
      r * 1.09,
      -r * 0.2,
      0,
    ]),
  );

  for (const side of [-1, 1]) {
    const nostril = mesh(SMALL_SPHERE, ctx.mouthLine, 'nostril');
    nostril.scale.setScalar(r * 0.05);
    nostril.position.set(r * 1.3, r * 0.02, side * r * 0.15);
    head.add(nostril);
  }

  /*
   * Eye domes are placed outright rather than mounted by yaw and pitch.
   *
   * `mountOnSkull` seats a feature on the lathe, and the lathe narrows sharply
   * toward the crown — so asking for a high pitch does not raise a feature up
   * the side of the head, it walks it in toward the centreline where the skull
   * has almost no radius left. At pitch 52 both domes collapsed into a pair of
   * bumps touching at the top of the head. Frog eyes are supposed to stand
   * proud of the skull anyway, which is exactly the case the mounting helper
   * is not for.
   */
  for (const side of [-1, 1]) {
    const domeY = p.headHeight * 0.4;
    const domeZ = side * r * 0.44;
    const dome = mesh(SPHERE, ctx.skin, 'eyeDome');
    dome.scale.set(r * 0.46, r * 0.44, r * 0.46);
    dome.position.set(r * 0.3, domeY, domeZ);
    head.add(dome);

    const eye = buildEye(ctx, r * 0.32, side * 0.24);
    eye.group.position.set(r * 0.42, domeY + r * 0.1, domeZ);
    eye.group.rotation.set(0, -side * 0.34, 0.32);
    head.add(eye.group);
    ctx.eyes.push(eye);
  }

  for (const side of [-1, 1]) {
    const haunch = mesh(SPHERE, ctx.skin, 'haunch');
    haunch.scale.set(p.torsoRadius * 0.66, p.torsoRadius * 0.6, p.torsoRadius * 0.42);
    place(haunch, [-p.torsoRadius * 0.6, p.torsoHeight * 0.42, side * p.torsoRadius * 0.6]);
    body.add(haunch);
  }

  for (let i = 0; i < 6; i += 1) {
    const t = i / 5;
    const spot = mesh(SPHERE, ctx.accent, 'spot');
    spot.scale.set(p.torsoRadius * 0.19, p.torsoRadius * 0.07, p.torsoRadius * 0.16);
    // Follow the barrel rather than a straight line across it: the torso is a
    // lathe, so a constant offset that sits on the surface at the shoulder is
    // hanging clear of it by the hips.
    const alongBack = Math.cos((t - 0.4) * 1.9);
    place(spot, [
      p.torsoRadius * (0.24 - t * 1.0) * alongBack,
      p.torsoHeight * (0.9 - Math.abs(t - 0.45) * 0.3),
      ((i % 2) - 0.5) * p.torsoRadius * 0.52,
    ]);
    body.add(spot);
  }

  addScarf(ctx, body, p.torsoRadius, p.torsoHeight * 0.94);
}

function buildBoar(ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions): void {
  const r = p.headRadius;

  /*
   * The snout has to clear the skull, and it did not.
   *
   * It was a cylinder half a radius long centred at 0.5r, so it spanned 0.06r
   * to 0.53r on a head of radius r — every part of it buried. All that showed
   * was the pale nose pad floating at 1.22r and the tusks beside it, which is
   * why the muzzle read as a separate object stuck to the side of the face.
   * Lengthening it and pushing it out to 0.86r puts the tip at 1.36r with the
   * root inside the cranium, so it emerges the way a snout should.
   */
  const snoutGeo = limbGeometry(r * 0.46, r * 0.42, r * 1.0);
  ctx.geometries.push(snoutGeo);
  const snout = mesh(snoutGeo, ctx.skin, 'snout');
  place(snout, [r * 0.86, -r * 0.2, 0], [0, 0, -Math.PI / 2]);
  head.add(snout);

  const nosePad = mesh(SPHERE, ctx.belly, 'nosePad');
  nosePad.scale.set(r * 0.11, r * 0.28, r * 0.3);
  nosePad.position.set(r * 1.34, -r * 0.2, 0);
  head.add(nosePad);

  for (const side of [-1, 1]) {
    const nostril = mesh(SMALL_SPHERE, ctx.materials.eyeDark, 'nostril');
    nostril.scale.set(r * 0.035, r * 0.075, r * 0.06);
    nostril.position.set(r * 1.42, -r * 0.18, side * r * 0.12);
    head.add(nostril);

    const eye = buildEye(ctx, r * 0.24, side * 0.2 - 0.3);
    mountOnSkull(eye.group, r, p.headHeight, 50, 10, side, 1);
    head.add(eye.group);
    ctx.eyes.push(eye);

    const tusk = mesh(CONE, ctx.materials.ivory, 'tusk');
    tusk.scale.set(r * 0.12, r * 0.7, r * 0.12);
    place(tusk, [r * 1.18, -r * 0.36, side * r * 0.26], [side * 0.28, 0, -0.7]);
    head.add(tusk);

    const ear = mesh(SPHERE, ctx.skin, 'ear');
    ear.scale.set(r * 0.12, r * 0.4, r * 0.28);
    mountOnSkull(ear, r, p.headHeight, 104, 44, side, 0.9);
    ear.rotateZ(-0.3);
    head.add(ear);

    const innerEar = mesh(SPHERE, ctx.belly, 'innerEar');
    innerEar.scale.set(r * 0.06, r * 0.28, r * 0.18);
    mountOnSkull(innerEar, r, p.headHeight, 104, 44, side, 0.98);
    innerEar.rotateZ(-0.3);
    head.add(innerEar);
  }

  for (let i = 0; i < 11; i += 1) {
    const t = i / 10;
    const bristle = mesh(CONE, ctx.accent, 'bristle');
    bristle.scale.set(
      p.torsoRadius * 0.07,
      p.torsoRadius * (0.5 - Math.abs(t - 0.3) * 0.42),
      p.torsoRadius * 0.07,
    );
    place(
      bristle,
      [p.torsoRadius * 0.2 - t * p.torsoRadius * 1.7, p.torsoHeight * (1.02 - t * 0.16), 0],
      [0, 0, 0.3 + t * 0.4],
    );
    body.add(bristle);
  }

  const hump = mesh(SPHERE, ctx.skin, 'hump');
  hump.scale.set(p.torsoRadius * 0.6, p.torsoRadius * 0.44, p.torsoRadius * 0.6);
  hump.position.set(p.torsoRadius * 0.1, p.torsoHeight * 0.9, 0);
  body.add(hump);

  addChestStrap(ctx, body, p.torsoRadius, p.torsoHeight);
  addPack(ctx, body, p.torsoRadius, p.torsoHeight * 0.6);
}

function buildRaccoon(ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions): void {
  const r = p.headRadius;

  const muzzle = mesh(SPHERE, ctx.belly, 'muzzle');
  muzzle.scale.set(r * 0.56, r * 0.4, r * 0.44);
  muzzle.position.set(r * 0.74, -r * 0.16, 0);
  head.add(muzzle);

  const nose = mesh(SPHERE, ctx.materials.eyeDark, 'nose');
  nose.scale.set(r * 0.14, r * 0.12, r * 0.16);
  nose.position.set(r * 1.16, -r * 0.06, 0);
  head.add(nose);

  head.add(place(buildMouth(ctx, r * 0.3, Math.PI * 0.62, ctx.mouthLine), [r * 0.94, -r * 0.34, 0]));

  // The bandit mask is a band worn round the head at eye height, so it is
  // built exactly that way: a thin horizontal ring sized to the skull. The
  // earlier partial arc, tilted by Euler angles, came out as a bar sticking
  // sideways off the face.
  const maskT = 0.56;
  const maskGeo = new THREE.TorusGeometry(craniumRadiusAt(r, maskT) * 1.02, r * 0.19, 8, seg.lathe);
  ctx.geometries.push(maskGeo);
  const mask = mesh(maskGeo, ctx.accent, 'mask');
  place(mask, [r * 0.12, (maskT - 0.5) * p.headHeight, 0], [Math.PI / 2, 0, 0], [0.94, 1, 0.82]);
  head.add(mask);

  for (const side of [-1, 1]) {
    const eye = buildEye(ctx, r * 0.28, side * 0.22 - 0.1);
    mountOnSkull(eye.group, r, p.headHeight, 48, 9, side, 1);
    head.add(eye.group);
    ctx.eyes.push(eye);

    const ear = mesh(SPHERE, ctx.skin, 'ear');
    ear.scale.set(r * 0.14, r * 0.36, r * 0.36);
    mountOnSkull(ear, r, p.headHeight, 78, 58, side, 0.92);
    head.add(ear);

    const innerEar = mesh(SPHERE, ctx.belly, 'innerEar');
    innerEar.scale.set(r * 0.08, r * 0.24, r * 0.24);
    mountOnSkull(innerEar, r, p.headHeight, 78, 58, side, 1.02);
    head.add(innerEar);
  }

  const bib = mesh(SPHERE, ctx.belly, 'bib');
  bib.scale.set(p.torsoRadius * 0.5, p.torsoRadius * 0.6, p.torsoRadius * 0.44);
  bib.position.set(p.torsoRadius * 0.42, p.torsoHeight * 0.6, 0);
  body.add(bib);

  // Bushy ringed tail, sweeping back and up behind the body. The first version
  // arced right over the head and dwarfed the character.
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.position.set(-p.torsoRadius * 0.86, p.torsoHeight * 0.42, 0);
  for (let i = 0; i < 13; i += 1) {
    const t = i / 12;
    const ring = mesh(SPHERE, i % 4 < 2 ? ctx.skin : ctx.accent, 'tailRing');
    const radius = p.torsoRadius * 0.42 * (1 - t * 0.42);
    ring.scale.set(radius * 0.72, radius, radius);
    ring.position.set(-0.1 - t * 0.9, t * t * 0.95 + t * 0.12, 0);
    tail.add(ring);
  }
  body.add(tail);

  addPack(ctx, body, p.torsoRadius, p.torsoHeight * 0.62);
  addScarf(ctx, body, p.torsoRadius, p.torsoHeight * 0.98);
}

function buildTortoise(ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions): void {
  const r = p.headRadius;

  const muzzle = mesh(SPHERE, ctx.belly, 'muzzle');
  muzzle.scale.set(r * 0.5, r * 0.34, r * 0.42);
  muzzle.position.set(r * 0.66, -r * 0.16, 0);
  head.add(muzzle);

  const beakLineGeo = new THREE.TorusGeometry(r * 0.3, r * 0.07, 8, seg.radial, Math.PI * 0.8);
  ctx.geometries.push(beakLineGeo);
  const beakLine = mesh(beakLineGeo, ctx.materials.ivory, 'beak');
  place(beakLine, [r * 0.86, -r * 0.2, 0], [Math.PI / 2, 0, -Math.PI * 0.6]);
  head.add(beakLine);

  for (const side of [-1, 1]) {
    const eye = buildEye(ctx, r * 0.24, side * 0.2 - 0.22);
    mountOnSkull(eye.group, r, p.headHeight, 50, 8, side, 1);
    head.add(eye.group);
    ctx.eyes.push(eye);
  }

  for (let i = 0; i < 5; i += 1) {
    const foldGeo = new THREE.TorusGeometry(r * (0.34 - i * 0.015), r * 0.07, 8, seg.radial);
    ctx.geometries.push(foldGeo);
    const fold = mesh(foldGeo, ctx.skin, 'neckFold');
    place(fold, [-r * 0.2 - i * 0.02, -r * (0.5 + i * 0.26), 0], [Math.PI / 2, 0, 0], [1, 1, 0.86]);
    head.add(fold);
  }

  // A bipedal tortoise wears its shell on its back like a shield. Centred on
  // the torso it just became a barrel hoop around the waist, which is what the
  // first pass produced.
  const shellCentreX = -p.torsoRadius * 0.62;
  const shellCentreY = p.torsoHeight * 0.56;

  const shell = mesh(SPHERE, ctx.accent, 'shell');
  shell.scale.set(p.torsoRadius * 0.62, p.torsoRadius * 1.15, p.torsoRadius * 1.02);
  shell.position.set(shellCentreX, shellCentreY, 0);
  body.add(shell);

  const scute = scuteGeometry(p.torsoRadius * 0.3);
  ctx.geometries.push(scute);
  const plates: Array<[number, number]> = [
    [0, 0],
    [0.62, 0],
    [-0.62, 0],
    [0, 0.62],
    [0, -0.62],
    [0.5, 0.55],
    [0.5, -0.55],
    [-0.5, 0.55],
    [-0.5, -0.55],
  ];
  // Scutes tile the outward (-X) face of the shell plate.
  for (const [ay, az] of plates) {
    const plate = mesh(scute, ctx.skin, 'scute');
    const out = Math.sqrt(Math.max(0.05, 1 - ay * ay - az * az));
    const x = shellCentreX - out * p.torsoRadius * 0.6;
    const y = shellCentreY + ay * p.torsoRadius * 1.05;
    const z = az * p.torsoRadius * 0.92;
    plate.position.set(x, y, z);
    plate.lookAt(x - out * 2, y + ay * 2, z + az * 2);
    body.add(plate);
  }

  // Rim band around the edge of the shell plate.
  const rimGeo = new THREE.TorusGeometry(p.torsoRadius * 1.06, p.torsoRadius * 0.11, 8, seg.lathe);
  ctx.geometries.push(rimGeo);
  const rim = mesh(rimGeo, ctx.skin, 'shellRim');
  place(rim, [shellCentreX + p.torsoRadius * 0.1, shellCentreY, 0], [0, Math.PI / 2, 0], [1, 1, 0.92]);
  body.add(rim);

  const plastron = mesh(SPHERE, ctx.belly, 'plastron');
  plastron.scale.set(p.torsoRadius * 0.9, p.torsoRadius * 0.3, p.torsoRadius * 0.8);
  plastron.position.set(-p.torsoRadius * 0.1, p.torsoHeight * 0.34, 0);
  body.add(plastron);

  // A headband is the one bit of costume a shell leaves room for.
  const bandT = 0.64;
  const bandGeo = new THREE.TorusGeometry(craniumRadiusAt(r, bandT) * 1.04, r * 0.11, 8, seg.lathe);
  ctx.geometries.push(bandGeo);
  const band = mesh(bandGeo, ctx.cloth, 'headband');
  place(band, [0, (bandT - 0.5) * p.headHeight, 0], [Math.PI / 2, 0, 0]);
  head.add(band);
}

function buildToucan(ctx: BuildContext, body: THREE.Group, head: THREE.Group, p: Proportions): void {
  const r = p.headRadius;

  // A real toucan beak is longer than its head; at 2.5x head radius it left
  // the frame entirely and unbalanced the silhouette. 1.7 still reads as
  // absurdly large, which is the point.
  const upperGeo = beakGeometry(r * 1.7, r * 0.54, r * 0.34);
  ctx.geometries.push(upperGeo);
  const upper = mesh(upperGeo, ctx.accent, 'upperBeak');
  place(upper, [r * 0.5, r * 0.08, 0], [0, 0, -Math.PI / 2], [1, 1, 0.82]);
  head.add(upper);

  const lowerGeo = beakGeometry(r * 1.45, r * 0.32, r * 0.24);
  ctx.geometries.push(lowerGeo);
  const lower = mesh(lowerGeo, ctx.accent, 'lowerBeak');
  place(lower, [r * 0.5, -r * 0.26, 0], [0, 0, -Math.PI / 2 - 0.1], [1, 1, 0.74]);
  head.add(lower);

  const tip = mesh(CONE, ctx.materials.eyeDark, 'beakTip');
  tip.scale.set(r * 0.16, r * 0.4, r * 0.14);
  place(tip, [r * 1.94, -r * 0.04, 0], [0, 0, -Math.PI / 2]);
  head.add(tip);

  for (const side of [-1, 1]) {
    const patch = mesh(SPHERE, ctx.belly, 'eyePatch');
    patch.scale.set(r * 0.34, r * 0.4, r * 0.16);
    mountOnSkull(patch, r, p.headHeight, 48, 10, side, 0.94);
    head.add(patch);

    const eye = buildEye(ctx, r * 0.27, side * 0.24 - 0.14);
    mountOnSkull(eye.group, r, p.headHeight, 48, 10, side, 1.02);
    head.add(eye.group);
    ctx.eyes.push(eye);
  }

  const bib = mesh(SPHERE, ctx.belly, 'bib');
  bib.scale.set(p.torsoRadius * 0.56, p.torsoRadius * 0.66, p.torsoRadius * 0.5);
  bib.position.set(p.torsoRadius * 0.42, p.torsoHeight * 0.66, 0);
  body.add(bib);

  for (const side of [-1, 1]) {
    const wing = mesh(SPHERE, ctx.skin, 'wing');
    wing.scale.set(p.torsoRadius * 0.72, p.torsoRadius * 0.66, p.torsoRadius * 0.14);
    place(wing, [-p.torsoRadius * 0.2, p.torsoHeight * 0.62, side * p.torsoRadius * 0.72], [0, 0, -0.22]);
    body.add(wing);

    const covert = mesh(SPHERE, ctx.accent, 'covert');
    covert.scale.set(p.torsoRadius * 0.4, p.torsoRadius * 0.2, p.torsoRadius * 0.08);
    place(
      covert,
      [-p.torsoRadius * 0.4, p.torsoHeight * 0.76, side * p.torsoRadius * 0.8],
      [0, 0, -0.22],
    );
    body.add(covert);
  }

  for (let i = 0; i < 5; i += 1) {
    const spread = (i - 2) / 2;
    const featherGeo = new THREE.CapsuleGeometry(
      p.torsoRadius * 0.1,
      p.torsoRadius * (0.9 - Math.abs(spread) * 0.22),
      2,
      seg.smallW,
    );
    ctx.geometries.push(featherGeo);
    const feather = mesh(featherGeo, i === 2 ? ctx.belly : ctx.skin, 'tailFeather');
    place(
      feather,
      [-p.torsoRadius * 0.95, p.torsoHeight * 0.4, spread * p.torsoRadius * 0.3],
      [spread * 0.34, 0, Math.PI / 2 + 0.44 + Math.abs(spread) * 0.12],
    );
    body.add(feather);
  }

  addGoggles(ctx, head, r, p.headHeight);
  addScarf(ctx, body, p.torsoRadius, p.torsoHeight * 0.98);
}

const BUILDERS: Record<string, SpeciesBuilder> = {
  gecko: buildGecko,
  frog: buildFrog,
  boar: buildBoar,
  raccoon: buildRaccoon,
  tortoise: buildTortoise,
  toucan: buildToucan,
};

/**
 * Mascot-racer proportions: a large head (roughly a third of standing height),
 * short limbs, oversized hands and feet. Anatomically wrong, and the reason the
 * silhouettes read at a glance.
 */
const PROPORTIONS: Record<string, Proportions> = {
  gecko: { torsoRadius: 0.42, torsoHeight: 0.9, belly: 0.4, headRadius: 0.62, headHeight: 0.94, headY: 1.24, legLength: 0.44, armUpper: 0.3, armLower: 0.28, limbThickness: 0.115, footSize: 0.19, scale: 1 },
  frog: { torsoRadius: 0.5, torsoHeight: 0.78, belly: 0.6, headRadius: 0.68, headHeight: 0.8, headY: 1.06, legLength: 0.36, armUpper: 0.28, armLower: 0.26, limbThickness: 0.11, footSize: 0.2, scale: 0.99 },
  boar: { torsoRadius: 0.52, torsoHeight: 0.9, belly: 0.5, headRadius: 0.6, headHeight: 0.9, headY: 1.16, legLength: 0.46, armUpper: 0.3, armLower: 0.26, limbThickness: 0.13, footSize: 0.19, scale: 1.06 },
  raccoon: { torsoRadius: 0.43, torsoHeight: 0.88, belly: 0.44, headRadius: 0.6, headHeight: 0.9, headY: 1.2, legLength: 0.44, armUpper: 0.3, armLower: 0.3, limbThickness: 0.115, footSize: 0.19, scale: 0.99 },
  tortoise: { torsoRadius: 0.46, torsoHeight: 0.74, belly: 0.4, headRadius: 0.5, headHeight: 0.76, headY: 1.06, legLength: 0.32, armUpper: 0.26, armLower: 0.24, limbThickness: 0.13, footSize: 0.2, scale: 1.04 },
  toucan: { torsoRadius: 0.4, torsoHeight: 0.94, belly: 0.46, headRadius: 0.54, headHeight: 0.82, headY: 1.34, legLength: 0.46, armUpper: 0.26, armLower: 0.26, limbThickness: 0.095, footSize: 0.18, scale: 0.99 },
};

/**
 * Standing height of a built fighter, in world units.
 *
 * Exported so the generated models can be normalised to the same height as
 * the ones they replace: camera framing, hit distances and the HUD anchors are
 * all tuned against these numbers, and a cast that swaps in half a unit taller
 * would quietly change how the game plays as well as how it looks.
 */
export function proceduralFighterHeight(animalId: string): number {
  const prop = PROPORTIONS[animalId] ?? PROPORTIONS.gecko;
  return (prop.legLength + prop.torsoHeight + prop.headHeight * 0.9) * prop.scale * FIGHTER_SCALE;
}

// ------------------------------------------------------------------- bake

/**
 * Bakes every static mesh in a subtree down to one merged mesh per material.
 *
 * An authored fighter is well over a hundred small meshes. Left alone that is a
 * draw call each, doubled again by the shadow pass, and four fighters would
 * spend the entire frame budget on decoration. Only the parts that animate stay
 * separate.
 */
function bakeStatic(
  container: THREE.Group,
  exclude: Set<THREE.Object3D>,
  materials: MaterialLibrary,
): void {
  container.updateMatrixWorld(true);
  const inverse = container.matrixWorld.clone().invert();
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const removals: THREE.Mesh[] = [];
  const scratch = new THREE.Matrix4();

  const walk = (node: THREE.Object3D) => {
    for (const child of node.children) {
      if (exclude.has(child)) continue;
      const asMesh = child as THREE.Mesh;
      if (asMesh.isMesh && !Array.isArray(asMesh.material)) {
        const geometry = asMesh.geometry.clone();
        geometry.applyMatrix4(scratch.copy(inverse).multiply(asMesh.matrixWorld));
        for (const name of Object.keys(geometry.attributes)) {
          if (name !== 'position' && name !== 'normal' && name !== 'uv') {
            geometry.deleteAttribute(name);
          }
        }
        if (!geometry.getAttribute('uv')) {
          const count = geometry.getAttribute('position').count;
          geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        }
        // Some sources are indexed (lathe, sphere) and some are not
        // (ExtrudeGeometry); mergeGeometries rejects a mixed set outright.
        const list = byMaterial.get(asMesh.material) ?? [];
        list.push(geometry.index ? geometry.toNonIndexed() : geometry);
        byMaterial.set(asMesh.material, list);
        removals.push(asMesh);
      }
      walk(child);
    }
  };
  walk(container);

  for (const target of removals) target.removeFromParent();

  for (const [material, geometries] of byMaterial) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!merged) {
      console.warn('bakeStatic: merge failed for', container.name);
      continue;
    }
    if (geometries.length > 1) {
      for (const geometry of geometries) geometry.dispose();
    }
    // Baked occlusion arrives as a vertex colour after this, so the merged
    // mesh needs the material variant that reads one.
    const baked = new THREE.Mesh(merged, materials.shaded(material));
    baked.name = 'baked';
    baked.castShadow = true;
    baked.receiveShadow = true;
    container.add(baked);
  }
}

// ------------------------------------------------------------------ build

export function createFighterModel(materials: MaterialLibrary, def: AnimalDef): FighterModel {
  ensurePrimitives();

  const geometries: THREE.BufferGeometry[] = [];
  const eyes: EyeResult[] = [];

  const ctx: BuildContext = {
    materials,
    def,
    skin: materials.hide(def.palette.body),
    mouthLine: materials.hide(shadeOf(def.palette.body), 0.8),
    belly: materials.hide(def.palette.belly, 0.72),
    accent: materials.hide(def.palette.accent, 0.58),
    cloth: materials.fabric(def.palette.cloth),
    leather: materials.leatherFor(def.palette.leather),
    geometries,
    eyes,
  };
  const owned = [ctx.skin, ctx.belly, ctx.accent, ctx.cloth, ctx.leather, ctx.mouthLine];

  const prop = PROPORTIONS[def.id] ?? PROPORTIONS.gecko;
  const root = new THREE.Group();
  root.name = 'fighter-' + def.id;

  const facing = new THREE.Group();
  facing.name = 'facingPivot';
  root.add(facing);

  const contact = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.2), materials.groundContact);
  contact.name = 'contactShadow';
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.03;
  contact.renderOrder = 1;
  facing.add(contact);
  geometries.push(contact.geometry);

  const body = new THREE.Group();
  body.name = 'bodyAnchor';
  body.position.y = prop.legLength;
  facing.add(body);

  const torsoGeo = torsoGeometry(prop.torsoRadius, prop.torsoHeight, prop.belly);
  geometries.push(torsoGeo);
  body.add(mesh(torsoGeo, ctx.skin, 'torso'));

  // Wider than it is deep and sitting square on the front of the torso. The
  // first version was narrow in z and offset forward, which from any angle but
  // dead-on read as a pale stripe down one flank rather than a pale underside.
  const bellyPatch = mesh(SPHERE, ctx.belly, 'bellyPatch');
  bellyPatch.scale.set(prop.torsoRadius * 0.52, prop.torsoHeight * 0.46, prop.torsoRadius * 0.66);
  bellyPatch.position.set(prop.torsoRadius * 0.52, prop.torsoHeight * 0.36, 0);
  body.add(bellyPatch);

  for (const side of [-1, 1]) {
    const leg = buildLeg(ctx, prop.legLength, prop.limbThickness, prop.footSize);
    leg.position.set(-0.04, prop.torsoHeight * 0.1, side * prop.torsoRadius * 0.5);
    body.add(leg);
  }

  // Back arm first so the throwing arm draws over the torso.
  const backArm = buildArm(ctx, prop.armUpper, prop.armLower, prop.limbThickness);
  backArm.group.position.set(0.06, prop.torsoHeight * 0.7, -prop.torsoRadius * 0.62);
  backArm.group.rotation.z = 0.44;
  body.add(backArm.group);

  const throwArmParts = buildArm(ctx, prop.armUpper, prop.armLower, prop.limbThickness);
  const throwArm = throwArmParts.group;
  throwArm.name = 'throwArm';
  throwArm.position.set(0.12, prop.torsoHeight * 0.72, prop.torsoRadius * 0.64);
  throwArm.rotation.z = 0.22;
  body.add(throwArm);

  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(prop.torsoRadius * 0.24, prop.headY, 0);
  body.add(head);

  const craniumGeo = craniumGeometry(prop.headRadius, prop.headHeight);
  geometries.push(craniumGeo);
  head.add(mesh(craniumGeo, ctx.skin, 'cranium'));

  const neckGeo = limbGeometry(prop.torsoRadius * 0.44, prop.torsoRadius * 0.5, 0.3);
  geometries.push(neckGeo);
  const neck = mesh(neckGeo, ctx.skin, 'neck');
  neck.position.set(prop.torsoRadius * 0.18, prop.headY - 0.08, 0);
  body.add(neck);

  (BUILDERS[def.id] ?? buildGecko)(ctx, body, head, prop);

  // Lids and brows animate, so they are held out of the merge.
  const animated = new Set<THREE.Object3D>();
  for (const eye of eyes) {
    animated.add(eye.lid);
    animated.add(eye.brow);
  }
  bakeStatic(head, animated, materials);
  bakeStatic(throwArm, new Set(), materials);
  bakeStatic(body, new Set<THREE.Object3D>([head, throwArm]), materials);

  // Lids and brows sat out the merge, so they need the vertex-colour variant
  // handed to them directly or the bake below would leave them unshaded and
  // floating in front of a face that had been shaded.
  for (const eye of eyes) {
    for (const part of [eye.lid, eye.brow]) {
      const asMesh = part as THREE.Mesh;
      if (asMesh.isMesh && !Array.isArray(asMesh.material)) {
        asMesh.material = materials.shaded(asMesh.material);
      }
    }
  }

  /*
   * Occlusion is baked before the root is scaled, so the radius in
   * OcclusionOptions is stated in the same units the proportions table uses
   * and does not silently change meaning when FIGHTER_SCALE moves.
   */
  const occlusion = bakeAmbientOcclusion(root);

  /*
   * Measured before the root is scaled, so the box is in the root's own
   * units — the same space `localHeight` is quoted in. Whatever frames it
   * applies the root's world matrix to reach world coordinates.
   */
  root.updateMatrixWorld(true);
  const headBounds = new THREE.Box3().setFromObject(head);

  root.scale.setScalar(prop.scale * FIGHTER_SCALE);

  let meshes = 0;
  let triangles = 0;
  root.traverse((object) => {
    const asMesh = object as THREE.Mesh;
    if (!asMesh.isMesh) return;
    meshes += 1;
    const index = asMesh.geometry.getIndex();
    const position = asMesh.geometry.getAttribute('position');
    triangles += index ? index.count / 3 : position ? position.count / 3 : 0;
  });

  return {
    root,
    facing,
    body,
    head,
    headBounds,
    throwArm,
    hand: throwArmParts.grip,
    lids: eyes.map((eye) => eye.lid),
    brows: eyes.map((eye) => eye.brow),
    contact,
    materials: owned,
    height: (prop.legLength + prop.torsoHeight + prop.headHeight * 0.9) * prop.scale * FIGHTER_SCALE,
    localHeight: prop.legLength + prop.torsoHeight + prop.headHeight * 0.9,
    diagnostics: { meshes, triangles: Math.round(triangles), occlusion },
  };
}

/** Shared primitives are module-level, so only per-model geometry is freed. */
export function disposeSharedAnimalGeometry(): void {
  SPHERE.dispose();
  SMALL_SPHERE.dispose();
  CONE.dispose();
  currentQuality = null;
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { MaterialLibrary } from '../MaterialLibrary';
import type { AnimalDef } from '../../game/types';
import { FIGHTER_SCALE, proceduralFighterHeight, type FighterModel } from './AnimalFactory';

/**
 * Fighters built from the Tripo-generated, Tripo-rigged GLBs.
 *
 * The alternative to `AnimalFactory`, and a straight trade. These models are
 * far better looking than anything assembled from lathes and spheres — they
 * carry painted albedo with occlusion already in it, which is the whole reason
 * the landscape was graded to them — and they arrive with a proper 41-bone
 * biped skeleton, so the throw can be driven from a shoulder instead of from a
 * group standing in for one.
 *
 * What they do not carry is a face rig. There are no morph targets and no
 * eyelid geometry to rotate, so blinking and brow moods are simply absent
 * here; `lids` and `brows` come back empty and `Fighter` already treats that
 * as "this model has no face to animate". That is the cost, and it is worth
 * naming rather than hiding.
 *
 * Everything else is adaptation. `Fighter` poses a model by setting rotations
 * on plain groups, which a skinned mesh cannot offer — a bone belongs to the
 * skeleton hierarchy and cannot be reparented under a pivot. So the groups it
 * writes to are detached proxies, and `applyPose` copies their state onto the
 * bones once per frame with the axes worked out at load time.
 */

/** Roster id to the base name the generation pipeline wrote. */
const FILE: Record<string, string> = {
  gecko: 'pip',
  frog: 'bruno',
  boar: 'tusk',
  raccoon: 'sly',
  tortoise: 'bunker',
  toucan: 'zip',
};

/**
 * Bones the pose adapter drives, by the names Tripo's v1.0 biped rigger emits.
 *
 * All six models came back with the identical 41-bone skeleton, so these are
 * safe to look up by name — but `createGeneratedFighterModel` still checks and
 * degrades rather than throwing, because a future regeneration could rig as a
 * creature instead and quietly produce different names.
 */
const BONES = {
  head: 'Head',
  clavicle: 'R_Clavicle',
  shoulder: 'R_Upperarm',
  elbow: 'R_Forearm',
  hand: 'R_Hand',
  spine: 'Spine02',
} as const;

/**
 * How much of the authored swing each bone takes.
 *
 * `Fighter` swings its throwing arm through about four radians, which is
 * correct for a group standing in for a shoulder and absurd on a real humerus —
 * the arm would rotate past its own body twice. The swing is therefore split
 * down a chain, with each joint taking a share.
 *
 * The split has to be wider here than it first appeared. These are chibi
 * proportions: measured in the running game, the hand sits about 0.4 units from
 * the shoulder on a fighter nearly four units tall, so rotating the humerus
 * alone moves the hand through an arc of roughly 0.6 units where the built
 * fighter's longer arm moves it 2.2. Raising the shoulder gain barely helped —
 * past a radian the vertical component of that arc has already saturated.
 * Recruiting the clavicle and the torso is what actually lengthens the arc,
 * because both move the shoulder itself rather than pivoting around it.
 */
const CLAVICLE_GAIN = 0.08;
const SHOULDER_GAIN = 1.1;
const ELBOW_GAIN = 0.3;
/*
 * The spine still takes a modest share. At 0.5 it rotated the torso through
 * seventy degrees at full wind-up: the fighter folded almost horizontally and
 * the arm swing, which is the motion being read, disappeared underneath it.
 */
const SPINE_GAIN = 0.0;

type Driver = {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  /** The model's Z axis, expressed in this bone's parent space. */
  axis: THREE.Vector3;
  gain: number;
};

const loader = new GLTFLoader();
const cache = new Map<string, THREE.Group>();
const pending = new Map<string, Promise<THREE.Group>>();

export function generatedFighterUrl(animalId: string): string {
  const base = FILE[animalId];
  if (!base) throw new Error('no generated model for animal "' + animalId + '"');
  // BASE_URL carries the GitHub Pages subpath in the CI build and '/' locally.
  return import.meta.env.BASE_URL + 'tripo/' + base + '-rigged.glb';
}

export function hasGeneratedFighter(animalId: string): boolean {
  return cache.has(animalId);
}

/**
 * Loads the models for a set of animals, if they are not already loaded.
 *
 * Only the fighters in the match are fetched. The set is a few megabytes and
 * pulling all six to play a two-player round would triple the wait for no
 * reason.
 */
export async function preloadGeneratedFighters(
  animalIds: readonly string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const wanted = [...new Set(animalIds)].filter((id) => FILE[id] && !cache.has(id));
  let loaded = 0;
  onProgress?.(0, wanted.length);

  await Promise.all(
    wanted.map(async (id) => {
      let request = pending.get(id);
      if (!request) {
        request = loader
          .loadAsync(generatedFighterUrl(id))
          .then((gltf) => gltf.scene as THREE.Group);
        pending.set(id, request);
      }
      try {
        cache.set(id, await request);
      } finally {
        pending.delete(id);
        loaded += 1;
        onProgress?.(loaded, wanted.length);
      }
    }),
  );
}

/** Root-space Z axis, expressed in the space `bone.quaternion` operates in. */
function axisInParentSpace(root: THREE.Object3D, bone: THREE.Object3D): THREE.Vector3 {
  const rootQuaternion = new THREE.Quaternion();
  root.getWorldQuaternion(rootQuaternion);
  const parentQuaternion = new THREE.Quaternion();
  (bone.parent ?? root).getWorldQuaternion(parentQuaternion);
  // Parent orientation relative to the root, then inverted: that maps a
  // root-space direction into the parent's space.
  const relative = rootQuaternion.invert().multiply(parentQuaternion).invert();
  return new THREE.Vector3(0, 0, 1).applyQuaternion(relative).normalize();
}

export function createGeneratedFighterModel(
  materials: MaterialLibrary,
  def: AnimalDef,
): FighterModel {
  const source = cache.get(def.id);
  if (!source) {
    throw new Error('generated model for "' + def.id + '" was not preloaded');
  }

  const armature = cloneSkinned(source) as THREE.Group;

  /*
   * Materials are cloned per fighter.
   *
   * SkeletonUtils.clone shares materials by reference, and the hit flash works
   * by driving `emissiveIntensity` — so without this, hitting one gecko would
   * flash every gecko on the field, including the one that threw the rock.
   */
  const owned: THREE.MeshStandardMaterial[] = [];
  const seen = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  armature.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let clone = seen.get(mesh.material);
    if (!clone) {
      clone = (mesh.material as THREE.MeshStandardMaterial).clone();
      // Matched to the rest of the scene: the generated materials ship with
      // full ambient, which reads hotter than every hand-authored surface
      // around them.
      clone.envMapIntensity = 0.6;
      seen.set(mesh.material, clone);
      owned.push(clone);
    }
    mesh.material = clone;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  });

  // --- normalise ------------------------------------------------------------
  /*
   * Scale is split across two nodes rather than baked into one.
   *
   * `Fighter` positions the health bar, the turn chevron and the held round in
   * the root's local units, and counters the root's scale when it parents ammo
   * to the hand. Folding the whole normalising factor into the root would put
   * every one of those offsets out by the ratio between this model's own
   * height and the built one's. So the root keeps the same scale the built
   * fighters use, and an inner node does the fitting.
   */
  const bounds = new THREE.Box3().setFromObject(armature);
  const sourceHeight = Math.max(0.001, bounds.max.y - bounds.min.y);
  const worldHeight = proceduralFighterHeight(def.id);
  const localHeight = worldHeight / FIGHTER_SCALE;
  const fitScale = localHeight / sourceHeight;

  const root = new THREE.Group();
  root.name = 'fighter-generated-' + def.id;

  const facing = new THREE.Group();
  facing.name = 'facingPivot';
  root.add(facing);

  const contact = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.2), materials.groundContact);
  contact.name = 'contactShadow';
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.03;
  contact.renderOrder = 1;
  facing.add(contact);

  const body = new THREE.Group();
  body.name = 'bodyAnchor';
  // Matches where the built fighters put theirs; Fighter rewrites this every
  // frame as `0.34 + bob`, so the fit node has to cancel it to keep the feet
  // on the ground.
  body.position.y = 0.34;
  facing.add(body);

  const fit = new THREE.Group();
  fit.name = 'fit';
  fit.scale.setScalar(fitScale);
  fit.position.y = -0.34;
  body.add(fit);

  armature.position.y = -bounds.min.y;
  fit.add(armature);

  root.scale.setScalar(FIGHTER_SCALE);
  root.updateMatrixWorld(true);

  // --- bones ----------------------------------------------------------------
  const bones = new Map<string, THREE.Bone>();
  armature.traverse((node) => {
    const bone = node as THREE.Bone;
    if (bone.isBone) bones.set(bone.name, bone);
  });

  const drivers: Driver[] = [];
  const driverFor = (name: string, gain: number): Driver | null => {
    const bone = bones.get(name);
    if (!bone) return null;
    const driver: Driver = {
      bone,
      rest: bone.quaternion.clone(),
      axis: axisInParentSpace(root, bone),
      gain,
    };
    drivers.push(driver);
    return driver;
  };

  const swingChain = [
    driverFor(BONES.spine, SPINE_GAIN),
    driverFor(BONES.clavicle, CLAVICLE_GAIN),
    driverFor(BONES.shoulder, SHOULDER_GAIN),
    driverFor(BONES.elbow, ELBOW_GAIN),
  ].filter((driver): driver is Driver => driver !== null);
  const headDriver = driverFor(BONES.head, 1);

  /*
   * The grip carries an inverse of the fit scale.
   *
   * Held ammo is parented to whatever `hand` points at, and `Fighter` already
   * cancels the root's scale so a rock keeps its authored size. It knows
   * nothing about the fit node between them, so a rock parented straight to
   * the hand bone would come out at whatever ratio this particular model
   * happened to need — a different wrong size per species.
   */
  const handBone = bones.get(BONES.hand);
  const grip = new THREE.Object3D();
  grip.name = 'grip';
  /*
   * Slightly under size, and pushed clear of the chest.
   *
   * These are chibi proportions with the hands tucked in against the body, so
   * a round of ammo parented straight to the fist sits half inside the torso
   * and reads as swallowed rather than held. Nudging the grip forward puts it
   * in front of the model, and taking a little off the scale suits it to a
   * hand markedly smaller than the built cast's.
   *
   * The offset is authored in world units and converted through the bone, so
   * it stays forward-relative-to-the-fighter when the facing pivot turns the
   * whole hierarchy around.
   */
  grip.scale.setScalar(0.74 / fitScale);
  (handBone ?? fit).add(grip);
  if (handBone) {
    root.updateMatrixWorld(true);
    const held = new THREE.Vector3();
    handBone.getWorldPosition(held);
    held.add(new THREE.Vector3(0.34, -0.06, 0.16));
    grip.position.copy(handBone.worldToLocal(held));
  }

  // --- pose adapter ---------------------------------------------------------
  const armProxy = new THREE.Group();
  armProxy.rotation.z = 0.2;
  const headProxy = new THREE.Group();

  const delta = new THREE.Quaternion();
  const applyPose = (): void => {
    // Fighter's rest angle is 0.2, so the swing is measured from there.
    const swing = armProxy.rotation.z - 0.2;
    for (const driver of swingChain) {
      delta.setFromAxisAngle(driver.axis, swing * driver.gain);
      driver.bone.quaternion.copy(driver.rest).premultiply(delta);
    }
    if (headDriver) {
      delta.setFromAxisAngle(headDriver.axis, headProxy.rotation.z);
      headDriver.bone.quaternion.copy(headDriver.rest).premultiply(delta);
    }
  };

  let meshes = 0;
  let triangles = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    triangles += index ? index.count / 3 : position ? position.count / 3 : 0;
  });

  return {
    root,
    facing,
    body,
    head: headProxy,
    throwArm: armProxy,
    hand: grip,
    // No morph targets and no eyelid geometry: this cast does not blink.
    lids: [],
    brows: [],
    contact,
    materials: owned,
    height: worldHeight,
    localHeight,
    applyPose,
    diagnostics: {
      meshes,
      triangles: Math.round(triangles),
      occlusion: { samples: 0, discs: 0, min: 1, mean: 1, ms: 0 },
      bones: drivers.length,
      swingAxis: swingChain
        .map((driver) => driver.bone.name + ':' + driver.axis.toArray().map((v) => v.toFixed(2)).join('/'))
        .join('  '),
    },
  };
}

/**
 * Frees the loaded source scenes.
 *
 * Clones share geometry and textures with the cached original, so this is only
 * safe once every fighter built from them is gone.
 */
export function disposeGeneratedFighters(): void {
  for (const scene of cache.values()) {
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (!Array.isArray(material)) {
        material.map?.dispose();
        material.normalMap?.dispose();
        material.roughnessMap?.dispose();
        material.dispose();
      }
    });
  }
  cache.clear();
}

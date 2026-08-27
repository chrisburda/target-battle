import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MATCH, PHYSICS, WORLD } from '../game/config';
import type { FighterModel } from '../assets/modelFactories/AnimalFactory';
import { createFighter } from '../assets/modelFactories/fighterModels';
import type { MaterialLibrary } from '../assets/MaterialLibrary';
import type { Terrain } from '../systems/Terrain';
import type { AnimalDef, ControllerKind, PlayerStats } from '../game/types';

/**
 * One animal in the fight.
 *
 * The fighter owns its own small physics: it sits on the terrain surface, falls
 * when the ground under it is blown away, and takes an impulse from nearby
 * blasts. That is deliberately simpler than a rigid body — an artillery game
 * wants a fighter to land somewhere predictable, not to ragdoll off a cliff.
 */

const THROW_WINDUP = 0.42;
const THROW_SWING = 0.13;
const THROW_FOLLOW = 0.45;

type ThrowPhase = 'idle' | 'windup' | 'swing' | 'follow';

export class Fighter {
  readonly model: FighterModel;
  readonly group: THREE.Group;
  readonly stats: PlayerStats = {
    damageDealt: 0,
    damageTaken: 0,
    shotsFired: 0,
    hits: 0,
    perfects: 0,
    accuracySum: 0,
    bestAccuracy: 0,
    secondsInZone: 0,
  };

  health: number = MATCH.maxHealth;
  alive = true;
  /** +1 faces right, -1 faces left. */
  facing: 1 | -1 = 1;
  aimAngle = 45;
  /** Remaining rounds per ammo id; -1 is unlimited. */
  readonly ammo = new Map<string, number>();

  readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private grounded = true;
  private fallStartY = 0;
  private falling = false;

  private throwPhase: ThrowPhase = 'idle';
  private throwTime = 0;
  private releasePending = false;

  private heldAmmo: THREE.Object3D | null = null;
  private bobPhase = 0;
  /** Seconds until the next blink. */
  private blinkTimer = 1.5;
  /** 0 = open, 1 = shut. */
  private blinkAmount = 0;
  /** Lid angle at rest; a slightly hooded eye reads as alert, not startled. */
  private readonly lidRest = 0.55;
  /** Lid angle fully shut: tilted forward far enough to cover the iris. */
  private readonly lidShut = -1.75;
  /** Brow lift, driven by damage. Negative furrows, positive raises. */
  private browMood = 0;
  private flash = 0;
  private squash = 1;
  private squashVelocity = 0;
  private active = false;

  /** Floating marker shown over the fighter whose turn it is. */
  private readonly marker: THREE.Group;
  /** Reticle shown over the fighter currently being aimed at. */
  private readonly reticle: THREE.Group;
  private targeted = false;
  private readonly healthBar: THREE.Mesh;
  private readonly healthBackdrop: THREE.Mesh;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly baseEmissive = new Map<THREE.MeshStandardMaterial, number>();

  constructor(
    readonly slot: number,
    readonly animal: AnimalDef,
    readonly controller: ControllerKind,
    materials: MaterialLibrary,
    private readonly terrain: Terrain,
  ) {
    this.model = createFighter(materials, animal);
    this.group = this.model.root;
    this.group.name = 'fighter-slot' + slot;

    for (const material of this.model.materials) {
      this.baseEmissive.set(material, material.emissiveIntensity);
    }

    this.marker = this.createMarker(animal);
    this.group.add(this.marker);

    this.reticle = this.createReticle();
    this.group.add(this.reticle);

    const barGeometry = new THREE.PlaneGeometry(1.6, 0.2);
    this.ownedGeometries.push(barGeometry);
    const backdropMaterial = new THREE.MeshBasicMaterial({
      color: 0x1d1d1d,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      toneMapped: false,
    });
    const barMaterial = new THREE.MeshBasicMaterial({
      color: 0x439f1f,
      depthTest: false,
      toneMapped: false,
    });
    this.ownedMaterials.push(backdropMaterial, barMaterial);

    this.healthBackdrop = new THREE.Mesh(barGeometry, backdropMaterial);
    this.healthBackdrop.position.y = this.model.localHeight + 0.55;
    this.healthBackdrop.renderOrder = 8;
    this.group.add(this.healthBackdrop);

    this.healthBar = new THREE.Mesh(barGeometry, barMaterial);
    this.healthBar.scale.set(0.94, 0.62, 1);
    this.healthBar.position.set(0, this.model.localHeight + 0.55, 0.02);
    this.healthBar.renderOrder = 9;
    this.group.add(this.healthBar);
  }

  /** Bobbing chevron plus a ground ring: reads the active fighter instantly. */
  private createMarker(animal: AnimalDef): THREE.Group {
    const group = new THREE.Group();
    group.name = 'turnMarker';
    group.visible = false;

    const coneGeometry = new THREE.ConeGeometry(0.34, 0.62, 5);
    const ringGeometry = new THREE.RingGeometry(0.9, 1.12, 28);
    this.ownedGeometries.push(coneGeometry, ringGeometry);

    const markerMaterial = new THREE.MeshBasicMaterial({
      color: animal.palette.accent,
      toneMapped: false,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: animal.palette.accent,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthWrite: false,
    });
    this.ownedMaterials.push(markerMaterial, ringMaterial);

    const cone = new THREE.Mesh(coneGeometry, markerMaterial);
    cone.name = 'markerChevron';
    cone.rotation.z = Math.PI;
    cone.position.y = this.model.localHeight + 1.15;
    group.add(cone);

    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.name = 'markerRing';
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    group.add(ring);

    return group;
  }

  setActive(active: boolean): void {
    this.active = active;
    this.marker.visible = active && this.alive;
    if (!active) this.setHeldAmmo(null);
  }

  /**
   * Marks this fighter as the one being shot at.
   *
   * With no manual angle control, "who am I pointed at" is the only spatial
   * decision left, so it needs to be unmistakable in the world and not only in
   * the HUD list.
   */
  setTargeted(targeted: boolean): void {
    this.targeted = targeted && this.alive;
    this.reticle.visible = this.targeted;
  }

  get isTargeted(): boolean {
    return this.targeted;
  }

  /** Concentric rings plus tick marks, drawn in the danger colour. */
  private createReticle(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'targetReticle';
    group.visible = false;

    const material = new THREE.MeshBasicMaterial({
      color: 0xda291c,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthTest: false,
      toneMapped: false,
    });
    this.ownedMaterials.push(material);

    // Two rings and four ticks, welded into one mesh. Six separate meshes cost
    // six draw calls on whichever fighter is targeted, which is real money at
    // the mobile budget for pure decoration.
    const centre = this.model.localHeight * 0.55;
    const parts: THREE.BufferGeometry[] = [];
    const matrix = new THREE.Matrix4();

    for (const [innerR, outerR, segments] of [
      [1.15, 1.32, 32],
      [0.5, 0.6, 24],
    ] as const) {
      const ring = new THREE.RingGeometry(innerR, outerR, segments);
      ring.applyMatrix4(matrix.makeTranslation(0, centre, 0));
      parts.push(ring.toNonIndexed());
      ring.dispose();
    }
    for (let i = 0; i < 4; i += 1) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const tick = new THREE.PlaneGeometry(0.5, 0.11);
      tick.applyMatrix4(matrix.makeRotationZ(angle));
      tick.applyMatrix4(
        matrix.makeTranslation(Math.cos(angle) * 1.55, centre + Math.sin(angle) * 1.55, 0),
      );
      parts.push(tick.toNonIndexed());
      tick.dispose();
    }

    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (merged) {
      this.ownedGeometries.push(merged);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = 'reticleRings';
      mesh.renderOrder = 10;
      group.add(mesh);
    }
    return group;
  }

  /**
   * Shows the chosen ammo in the throwing hand while aiming.
   *
   * Without it the fighter mimes a throw and a rock appears from nowhere; with
   * it, switching ammo is visible in the world rather than only in the HUD,
   * which is where the player is already looking.
   */
  setHeldAmmo(model: THREE.Object3D | null): void {
    if (this.heldAmmo) {
      this.heldAmmo.removeFromParent();
      this.heldAmmo = null;
    }
    if (!model) return;
    // Counter the root scale so ammo keeps its authored size in world units.
    const inverse = 1 / Math.max(0.001, this.group.scale.y);
    model.scale.setScalar(inverse * 0.8);
    model.position.set(0, 0, 0);
    this.model.hand.add(model);
    this.heldAmmo = model;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** World position the projectile leaves from. */
  getHandPosition(target: THREE.Vector3): THREE.Vector3 {
    this.model.hand.getWorldPosition(target);
    return target;
  }

  /** Centre of mass, used for blast distance and camera framing. */
  getCenter(target: THREE.Vector3): THREE.Vector3 {
    return target.set(this.position.x, this.position.y + this.model.height * 0.55, this.position.z);
  }

  placeAt(x: number, z: number): void {
    this.position.set(x, this.terrain.heightAt(x), z);
    this.group.position.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.falling = false;
  }

  faceTowards(x: number): void {
    this.setFacing(x < this.position.x ? -1 : 1);
  }

  /** Turning is a Y rotation so triangle winding — and the outline — survives. */
  setFacing(facing: 1 | -1): void {
    this.facing = facing;
    this.model.facing.rotation.y = facing === 1 ? 0 : Math.PI;
  }

  // ------------------------------------------------------------- throwing

  startThrow(): void {
    this.throwPhase = 'windup';
    this.throwTime = 0;
    this.releasePending = true;
  }

  get isThrowing(): boolean {
    return this.throwPhase !== 'idle';
  }

  /** True exactly once, on the frame the hand reaches the release point. */
  consumeRelease(): boolean {
    if (this.throwPhase === 'swing' && this.releasePending && this.throwTime >= THROW_SWING * 0.62) {
      this.releasePending = false;
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------- damage

  takeDamage(amount: number): number {
    if (!this.alive) return 0;
    const applied = Math.min(this.health, amount * this.animal.perk.armor);
    this.health -= applied;
    this.stats.damageTaken += applied;
    this.flash = 1;
    this.squashVelocity -= 6;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.marker.visible = false;
      this.setTargeted(false);
    }
    return applied;
  }

  /** Blast knockback. Explosions push, they do not teleport. */
  applyImpulse(x: number, y: number): void {
    this.velocity.x += x;
    this.velocity.y += y;
    if (Math.abs(this.velocity.y) > 0.4) {
      this.grounded = false;
      if (!this.falling) {
        this.falling = true;
        this.fallStartY = this.position.y;
      }
    }
  }

  // --------------------------------------------------------------- update

  /**
   * Returns the fall damage to apply this frame, if the fighter just landed
   * from height. Returning it rather than applying it keeps damage attribution
   * (and the resulting floating number) in one place in Game.
   */
  update(delta: number, elapsed: number): { landed: boolean; fallDamage: number; drowned: boolean } {
    let landed = false;
    let fallDamage = 0;
    let drowned = false;

    const groundY = this.terrain.heightAt(this.position.x);

    if (!this.grounded || this.position.y > groundY + 0.02) {
      this.velocity.y -= PHYSICS.gravity * delta;
      this.position.x += this.velocity.x * delta;
      this.position.y += this.velocity.y * delta;
      this.velocity.x *= Math.exp(-delta * 1.1);
      this.position.x = Math.max(-WORLD.halfWidth + 1, Math.min(WORLD.halfWidth - 1, this.position.x));

      const newGround = this.terrain.heightAt(this.position.x);
      if (this.position.y <= newGround) {
        this.position.y = newGround;
        landed = this.falling && this.velocity.y < -4;
        if (landed) {
          const drop = this.fallStartY - this.position.y;
          if (drop > MATCH.fallDamageFreeDrop) {
            fallDamage = (drop - MATCH.fallDamageFreeDrop) * MATCH.fallDamagePerUnit;
          }
          this.squashVelocity -= Math.min(9, Math.abs(this.velocity.y) * 0.6);
        }
        this.velocity.set(0, 0, 0);
        this.grounded = true;
        this.falling = false;
      }
    } else {
      // Terrain moved under a standing fighter: start falling.
      if (this.position.y > groundY + 0.04) {
        this.grounded = false;
        this.falling = true;
        this.fallStartY = this.position.y;
      } else {
        this.position.y = groundY;
      }
    }

    if (this.position.y < WORLD.killPlaneY) drowned = true;

    this.group.position.copy(this.position);

    // Stand perpendicular to the slope so nobody floats over a ridge.
    const slope = this.terrain.slopeAt(this.position.x);
    const targetTilt = Math.atan(slope) * 0.55;
    this.group.rotation.z += (targetTilt - this.group.rotation.z) * Math.min(1, delta * 8);

    this.updateAnimation(delta, elapsed);
    this.updateHealthBar();

    return { landed, fallDamage, drowned };
  }

  private updateAnimation(delta: number, elapsed: number): void {
    // Idle bob, faster and higher while it is this fighter's turn.
    this.bobPhase += delta * (this.active ? 3.4 : 2.1);
    const bobAmount = this.alive ? (this.active ? 0.075 : 0.04) : 0;
    const bob = Math.sin(this.bobPhase) * bobAmount;

    // Spring the squash back to 1 with a little overshoot.
    this.squashVelocity += (1 - this.squash) * 90 * delta;
    this.squashVelocity *= Math.exp(-delta * 7);
    this.squash += this.squashVelocity * delta;
    this.squash = Math.max(0.55, Math.min(1.45, this.squash));
    const counter = 1 / Math.sqrt(this.squash);
    this.model.body.scale.set(counter, this.squash, counter);
    this.model.body.position.y = 0.34 + bob;

    // Throwing arm.
    let armAngle = 0.2;
    let lean = 0;
    if (this.throwPhase !== 'idle') {
      this.throwTime += delta;
      if (this.throwPhase === 'windup') {
        const t = Math.min(1, this.throwTime / THROW_WINDUP);
        const eased = t * t * (3 - 2 * t);
        armAngle = 0.2 + eased * 2.5;
        lean = -eased * 0.18;
        if (this.throwTime >= THROW_WINDUP) {
          this.throwPhase = 'swing';
          this.throwTime = 0;
        }
      } else if (this.throwPhase === 'swing') {
        const t = Math.min(1, this.throwTime / THROW_SWING);
        armAngle = 2.7 - t * 4.1;
        lean = -0.18 + t * 0.3;
        if (this.throwTime >= THROW_SWING) {
          this.throwPhase = 'follow';
          this.throwTime = 0;
          this.squashVelocity -= 3.4;
        }
      } else {
        const t = Math.min(1, this.throwTime / THROW_FOLLOW);
        armAngle = -1.4 + t * 1.6;
        lean = 0.12 * (1 - t);
        if (this.throwTime >= THROW_FOLLOW) {
          this.throwPhase = 'idle';
          this.throwTime = 0;
        }
      }
    }
    this.model.throwArm.rotation.z = armAngle;
    this.model.body.rotation.z = lean;

    // Head tracks the aim angle a little, which makes aiming feel authored.
    if (this.active) {
      const look = THREE.MathUtils.degToRad(this.aimAngle) * 0.32;
      this.model.head.rotation.z += (look - this.model.head.rotation.z) * Math.min(1, delta * 6);
    } else {
      this.model.head.rotation.z += (0 - this.model.head.rotation.z) * Math.min(1, delta * 3);
    }

    // Skinned models pose through proxies; this is where those land on the
    // skeleton. Built fighters do not define it and pay nothing.
    this.model.applyPose?.();

    this.updateFace(delta, elapsed);

    // Hit flash: pulse emissive back to each material's stored base value.
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - delta * 3.4);
      for (const material of this.model.materials) {
        const base = this.baseEmissive.get(material) ?? 1;
        material.emissiveIntensity = base + this.flash * 5;
        material.emissive.setRGB(
          1 * this.flash + material.color.r * 0.06 * (1 - this.flash),
          0.35 * this.flash + material.color.g * 0.06 * (1 - this.flash),
          0.2 * this.flash + material.color.b * 0.06 * (1 - this.flash),
        );
      }
    }

    if (this.reticle.visible) {
      const pulse = 1 + Math.sin(elapsed * 5.2) * 0.07;
      this.reticle.scale.setScalar(pulse);
      this.reticle.rotation.z = -elapsed * 0.55;
    }

    if (this.marker.visible) {
      const chevron = this.marker.children[0];
      chevron.position.y = this.model.localHeight + 1.15 + Math.sin(elapsed * 4) * 0.16;
      chevron.rotation.y = elapsed * 1.6;
      const ring = this.marker.children[1] as THREE.Mesh;
      const pulse = 1 + Math.sin(elapsed * 3.2) * 0.08;
      ring.scale.setScalar(pulse);
    }

    // Fade the whole fighter out once eliminated.
    if (!this.alive) {
      this.group.rotation.z += delta * 1.6 * this.facing;
      this.group.position.y -= delta * 1.2;
    }
  }

  /**
   * Blinks and brow expression.
   *
   * A face that never blinks reads as a mannequin, and at this camera distance
   * the blink is one of the few animation cues that survives being small. The
   * interval is randomised per fighter so a line-up never blinks in unison.
   */
  private updateFace(delta: number, elapsed: number): void {
    if (this.model.lids.length === 0) return;

    if (this.alive) {
      this.blinkTimer -= delta;
      if (this.blinkTimer <= 0) {
        this.blinkTimer = 2.4 + Math.abs(Math.sin(elapsed * 7.3 + this.slot)) * 3.6;
        this.blinkAmount = 1;
      }
      // Snap shut, ease open — the shape of a real blink.
      this.blinkAmount = Math.max(0, this.blinkAmount - delta * 6.5);
    } else {
      // Eliminated fighters keep their eyes shut.
      this.blinkAmount = Math.min(1, this.blinkAmount + delta * 5);
    }

    // Being hit narrows the eyes for a moment on top of any blink.
    const squint = this.flash * 0.5;
    const closed = Math.min(1, this.blinkAmount + squint);
    for (const lid of this.model.lids) {
      lid.rotation.z = this.lidRest + closed * (this.lidShut - this.lidRest);
    }

    // Brows drop while hurt and drift back to neutral.
    const targetMood = this.flash > 0.05 ? -1 : this.active ? 0.35 : 0;
    this.browMood += (targetMood - this.browMood) * Math.min(1, delta * 5);
    for (const brow of this.model.brows) {
      brow.position.y = brow.userData.baseY ?? (brow.userData.baseY = brow.position.y);
      brow.position.y += this.browMood * 0.05;
    }
  }

  private updateHealthBar(): void {
    const ratio = Math.max(0, this.health / MATCH.maxHealth);
    this.healthBar.scale.x = Math.max(0.001, 0.94 * ratio);
    // Bar shrinks from the left edge rather than the centre.
    this.healthBar.position.x = -(1.6 * 0.94 * (1 - ratio)) / 2;
    const material = this.healthBar.material as THREE.MeshBasicMaterial;
    material.color.setHex(ratio > 0.55 ? 0x5bb836 : ratio > 0.25 ? 0xfac800 : 0xda291c);
    const visible = this.alive;
    this.healthBar.visible = visible;
    this.healthBackdrop.visible = visible;
  }

  /**
   * Health bars billboard toward the camera. They hang off the root, outside
   * the facing pivot, so turning around never mirrors them.
   */
  faceCamera(cameraQuaternion: THREE.Quaternion): void {
    this.healthBackdrop.quaternion.copy(cameraQuaternion);
    this.healthBar.quaternion.copy(cameraQuaternion);
  }

  /** True while this fighter is alive; used to filter selectable targets. */
  get selectable(): boolean {
    return this.alive;
  }

  resetForMatch(): void {
    this.health = MATCH.maxHealth;
    this.alive = true;
    this.flash = 0;
    this.squash = 1;
    this.squashVelocity = 0;
    this.throwPhase = 'idle';
    this.aimAngle = 45;
    this.group.rotation.set(0, 0, 0);
    this.setFacing(this.facing);
    this.setTargeted(false);
    this.blinkAmount = 0;
    this.blinkTimer = 1.2 + this.slot * 0.7;
    this.browMood = 0;
    this.stats.damageDealt = 0;
    this.stats.damageTaken = 0;
    this.stats.shotsFired = 0;
    this.stats.hits = 0;
    this.stats.perfects = 0;
    this.stats.accuracySum = 0;
    this.stats.bestAccuracy = 0;
    this.stats.secondsInZone = 0;
    for (const material of this.model.materials) {
      material.emissiveIntensity = this.baseEmissive.get(material) ?? 1;
      material.emissive.copy(material.color).multiplyScalar(0.06);
    }
  }

  dispose(): void {
    // Detach before traversing: the held round shares geometry with the
    // projectile cache and must not be disposed along with this fighter.
    this.setHeldAmmo(null);
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
  }
}

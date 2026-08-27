import * as THREE from 'three';
import { PHYSICS, WORLD } from '../game/config';
import { createFragmentModel } from '../assets/modelFactories/AmmoFactory';
import { createAmmo } from '../assets/modelFactories/fighterModels';
import type { MaterialLibrary } from '../assets/MaterialLibrary';
import type { Terrain } from '../systems/Terrain';
import type { VfxSystem } from './VfxSystem';
import type { AmmoDef } from '../game/types';
import type { Fighter } from '../entities/Fighter';

/**
 * Projectile flight, collision and the two special behaviours that need it.
 *
 * Integration runs on a fixed substep because a melon leaving the hand at
 * 34 u/s covers half a metre in a single 60 Hz frame — enough to step straight
 * through a thin ridge. Substepping at 240 Hz keeps collision honest without a
 * physics engine.
 */

export type Detonation = {
  position: THREE.Vector3;
  radius: number;
  damage: number;
  ownerSlot: number;
  ammo: AmmoDef;
  inWater: boolean;
  directHitSlot: number | null;
};

type Projectile = {
  active: boolean;
  root: THREE.Group;
  ammo: AmmoDef;
  ownerSlot: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  windAcceleration: number;
  damage: number;
  radius: number;
  bouncesLeft: number;
  isFragment: boolean;
  splitPending: boolean;
  life: number;
  trailTimer: number;
  /** Slot that fired it, ignored for the first moments so it cannot self-hit. */
  armTimer: number;
};

type Bee = {
  offset: THREE.Vector3;
  phase: number;
  speed: number;
};

/** Lingering swarm left by the Angry Hive. */
class BeeSwarm {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly bees: Bee[] = [];
  private readonly center = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly euler = new THREE.Euler();
  private readonly probe = new THREE.Vector3();
  private readonly beePosition = new THREE.Vector3();
  private life = 0;
  private stingTimer = 0;
  active = false;
  ownerSlot = -1;

  constructor(materials: MaterialLibrary, private readonly random: () => number) {
    const body = new THREE.SphereGeometry(0.14, 7, 5);
    const material = materials.flat(0xffd166, 0.5);
    this.mesh = new THREE.InstancedMesh(body, material, 10);
    this.mesh.name = 'beeSwarm';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.group.visible = false;

    for (let i = 0; i < 10; i += 1) {
      this.bees.push({
        offset: new THREE.Vector3(
          (this.random() - 0.5) * 2,
          (this.random() - 0.5) * 1.4,
          (this.random() - 0.5) * 1.2,
        ),
        phase: this.random() * Math.PI * 2,
        speed: 2.4 + this.random() * 2.6,
      });
    }
  }

  spawn(position: THREE.Vector3, ownerSlot: number): void {
    this.center.copy(position);
    this.ownerSlot = ownerSlot;
    this.life = 4.6;
    this.stingTimer = 0;
    this.active = true;
    this.group.visible = true;
  }

  /** Chases the nearest living fighter and stings on a cadence. */
  update(delta: number, elapsed: number, fighters: Fighter[]): { slot: number; damage: number } | null {
    if (!this.active) return null;
    this.life -= delta;
    if (this.life <= 0) {
      this.active = false;
      this.group.visible = false;
      return null;
    }

    let nearest: Fighter | null = null;
    let bestDistance = Infinity;
    for (const fighter of fighters) {
      if (!fighter.alive) continue;
      fighter.getCenter(this.probe);
      const distance = this.probe.distanceTo(this.center);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = fighter;
      }
    }

    if (nearest) {
      nearest.getCenter(this.probe);
      this.center.lerp(this.probe, Math.min(1, delta * 1.35));
    }

    for (let i = 0; i < this.bees.length; i += 1) {
      const bee = this.bees[i];
      const t = elapsed * bee.speed + bee.phase;
      this.beePosition.set(
        this.center.x + bee.offset.x + Math.sin(t) * 0.7,
        this.center.y + bee.offset.y + Math.cos(t * 1.3) * 0.6,
        this.center.z + bee.offset.z + Math.sin(t * 0.8) * 0.5,
      );
      this.matrix.compose(
        this.beePosition,
        this.quaternion.setFromEuler(this.euler.set(0, t, 0)),
        this.scale,
      );
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    this.stingTimer -= delta;
    if (nearest && bestDistance < 4.4 && this.stingTimer <= 0) {
      this.stingTimer = 0.55;
      return { slot: nearest.slot, damage: 3 };
    }
    return null;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

export class ProjectileSystem {
  readonly group = new THREE.Group();

  private readonly pool: Projectile[] = [];
  private readonly modelCache = new Map<string, THREE.Group>();
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly swarm: BeeSwarm;
  private readonly detonations: Detonation[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmpNormal = new THREE.Vector3();

  /** Wind acceleration for the current shot, in world units / s^2. */
  wind = 0;

  constructor(
    private readonly materials: MaterialLibrary,
    private terrain: Terrain,
    private readonly vfx: VfxSystem,
    private readonly random: () => number,
  ) {
    this.group.name = 'projectiles';
    this.swarm = new BeeSwarm(materials, random);
    this.group.add(this.swarm.group);
  }

  private modelFor(ammo: AmmoDef, fragment: boolean): THREE.Group {
    const key = (fragment ? 'frag-' : 'ammo-') + ammo.id;
    const cached = this.modelCache.get(key);
    if (cached) return cached.clone(true);
    const built = fragment
      ? createFragmentModel(this.materials, ammo)
      : createAmmo(this.materials, ammo);
    this.ownedGeometries.push(...built.geometries);
    this.modelCache.set(key, built.root);
    return built.root.clone(true);
  }

  /**
   * Drops the cached round models so a change of model source is picked up.
   *
   * The cache lives as long as the system does, and the system is built once at
   * startup rather than per match — so without this, the first round built in a
   * session decides what every later one looks like. Switching to the generated
   * assets left every round still showing the hand-built model, which is the
   * one thing the switch was supposed to change.
   *
   * Only safe between matches: clones share geometry with the cached root, so
   * anything still in flight would lose its buffers.
   */
  resetModels(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries.length = 0;
    this.modelCache.clear();
  }

  /**
   * A non-simulated copy of an ammo model, for showing the round in a
   * fighter's hand. Shares the cached geometry, so it costs one draw call.
   */
  createDisplayModel(ammo: AmmoDef): THREE.Group {
    return this.modelFor(ammo, false);
  }

  private take(ammo: AmmoDef, fragment: boolean): Projectile {
    for (const projectile of this.pool) {
      if (!projectile.active && projectile.ammo.id === ammo.id && projectile.isFragment === fragment) {
        projectile.active = true;
        projectile.root.visible = true;
        return projectile;
      }
    }
    const root = this.modelFor(ammo, fragment);
    this.group.add(root);
    const projectile: Projectile = {
      active: true,
      root,
      ammo,
      ownerSlot: -1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      windAcceleration: 0,
      damage: ammo.damage,
      radius: ammo.radius,
      bouncesLeft: 0,
      isFragment: fragment,
      splitPending: false,
      life: 0,
      trailTimer: 0,
      armTimer: 0,
    };
    this.pool.push(projectile);
    return projectile;
  }

  /**
   * Launch a shot. `windScale` folds in the animal's wind perk so a Toucan's
   * coconut genuinely drifts less than everyone else's.
   */
  launch(options: {
    ammo: AmmoDef;
    ownerSlot: number;
    origin: THREE.Vector3;
    speed: number;
    angleDegrees: number;
    facing: 1 | -1;
    damage: number;
    radius: number;
    windScale: number;
  }): void {
    const projectile = this.take(options.ammo, false);
    projectile.ownerSlot = options.ownerSlot;
    projectile.position.copy(options.origin);
    const radians = THREE.MathUtils.degToRad(options.angleDegrees);
    projectile.velocity.set(
      Math.cos(radians) * options.speed * options.facing,
      Math.sin(radians) * options.speed,
      0,
    );
    projectile.spin.set(
      (this.random() - 0.5) * 9,
      (this.random() - 0.5) * 5,
      -options.facing * (5 + this.random() * 6),
    );
    projectile.windAcceleration = this.wind * options.windScale;
    projectile.damage = options.damage;
    projectile.radius = options.radius;
    projectile.bouncesLeft = options.ammo.bounces;
    projectile.splitPending = options.ammo.behaviour === 'cluster';
    projectile.life = PHYSICS.maxFlightSeconds;
    projectile.armTimer = 0.08;
    projectile.trailTimer = 0;
    projectile.root.position.copy(projectile.position);
    projectile.root.visible = true;
  }

  private splitCluster(parent: Projectile): void {
    const count = parent.ammo.fragments;
    for (let i = 0; i < count; i += 1) {
      const fragment = this.take(parent.ammo, true);
      fragment.ownerSlot = parent.ownerSlot;
      fragment.position.copy(parent.position);
      const spread = (i - (count - 1) / 2) * 0.34;
      fragment.velocity.copy(parent.velocity).multiplyScalar(0.72);
      fragment.velocity.x += spread * 7;
      fragment.velocity.y += 2.2 + this.random() * 1.8;
      fragment.spin.set(
        (this.random() - 0.5) * 12,
        (this.random() - 0.5) * 12,
        (this.random() - 0.5) * 12,
      );
      fragment.windAcceleration = parent.windAcceleration;
      fragment.damage = parent.ammo.damage;
      fragment.radius = parent.ammo.radius;
      fragment.bouncesLeft = 0;
      fragment.splitPending = false;
      fragment.life = PHYSICS.maxFlightSeconds;
      fragment.armTimer = 0;
      fragment.root.position.copy(fragment.position);
      fragment.root.visible = true;
    }
    this.vfx.shockwave(parent.position, 0.4, 2.6, 0.32, 0xffe9b0);
  }

  private retire(projectile: Projectile): void {
    projectile.active = false;
    projectile.root.visible = false;
  }

  private detonate(projectile: Projectile, directHitSlot: number | null): void {
    const inWater = projectile.position.y <= WORLD.waterY + 0.35;
    this.detonations.push({
      position: projectile.position.clone(),
      radius: projectile.radius,
      damage: projectile.damage,
      ownerSlot: projectile.ownerSlot,
      ammo: projectile.ammo,
      inWater,
      directHitSlot,
    });

    if (projectile.ammo.behaviour === 'swarm' && !projectile.isFragment && !inWater) {
      this.swarm.spawn(projectile.position, projectile.ownerSlot);
    }
    this.retire(projectile);
  }

  /**
   * Steps every live projectile. Returns the detonations produced this frame so
   * the caller can apply damage, carve terrain and fire feedback in one place.
   */
  update(delta: number, elapsed: number, fighters: Fighter[]): {
    detonations: Detonation[];
    swarmSting: { slot: number; damage: number } | null;
    anyActive: boolean;
  } {
    this.detonations.length = 0;
    let anyActive = false;

    const steps = Math.max(1, Math.min(24, Math.ceil(delta / PHYSICS.fixedStep)));
    const step = delta / steps;

    for (const projectile of this.pool) {
      if (!projectile.active) continue;
      anyActive = true;
      let detonated = false;

      for (let s = 0; s < steps && !detonated; s += 1) {
        projectile.life -= step;
        projectile.armTimer -= step;
        if (projectile.life <= 0) {
          this.detonate(projectile, null);
          detonated = true;
          break;
        }

        const previousVy = projectile.velocity.y;
        projectile.velocity.y -= PHYSICS.gravity * step;
        projectile.velocity.x += projectile.windAcceleration * step;
        projectile.position.addScaledVector(projectile.velocity, step);

        // Cluster splits at the top of its arc, which is both readable and
        // tactically meaningful: you aim the split, not the impact.
        if (projectile.splitPending && previousVy > 0 && projectile.velocity.y <= 0) {
          projectile.splitPending = false;
          this.splitCluster(projectile);
          this.retire(projectile);
          detonated = true;
          break;
        }

        // Out of bounds sideways: quietly gone, no crater.
        if (Math.abs(projectile.position.x) > WORLD.halfWidth + 6) {
          this.retire(projectile);
          detonated = true;
          break;
        }
        // Way above the arena is still legal — a high lob must be allowed.
        if (projectile.position.y < WORLD.baseY) {
          this.detonate(projectile, null);
          detonated = true;
          break;
        }

        // Direct hit on a fighter.
        if (projectile.armTimer <= 0) {
          for (const fighter of fighters) {
            if (!fighter.alive) continue;
            fighter.getCenter(this.tmp);
            const dx = this.tmp.x - projectile.position.x;
            const dy = this.tmp.y - projectile.position.y;
            // Body radius scaled to the fighter chassis; a graze still counts.
            if (dx * dx + dy * dy < 3.4) {
              this.detonate(projectile, fighter.slot);
              detonated = true;
              break;
            }
          }
          if (detonated) break;
        }

        // Water.
        if (projectile.position.y <= WORLD.waterY && this.terrain.heightAt(projectile.position.x) < WORLD.waterY) {
          this.detonate(projectile, null);
          detonated = true;
          break;
        }

        // Terrain.
        const ground = this.terrain.heightAt(projectile.position.x);
        if (projectile.position.y <= ground) {
          if (projectile.bouncesLeft > 0) {
            projectile.bouncesLeft -= 1;
            projectile.position.y = ground + 0.05;
            this.terrain.surfaceNormalAt(projectile.position.x, this.tmpNormal);
            const dot = projectile.velocity.dot(this.tmpNormal);
            projectile.velocity.addScaledVector(this.tmpNormal, -2 * dot).multiplyScalar(0.62);
            this.vfx.dust(projectile.position, 0.7);
            this.vfx.shockwave(projectile.position, 0.3, 1.8, 0.25, 0xe8d9b0);
          } else {
            this.detonate(projectile, null);
            detonated = true;
            break;
          }
        }
      }

      if (detonated) continue;

      projectile.root.position.copy(projectile.position);
      projectile.root.rotation.x += projectile.spin.x * delta;
      projectile.root.rotation.y += projectile.spin.y * delta;
      projectile.root.rotation.z += projectile.spin.z * delta;

      projectile.trailTimer -= delta;
      if (projectile.trailTimer <= 0) {
        projectile.trailTimer = 0.022;
        this.vfx.trail(projectile.position, projectile.ammo.accent, projectile.isFragment ? 0.6 : 1);
      }
    }

    const swarmSting = this.swarm.update(delta, elapsed, fighters);
    if (this.swarm.active) anyActive = true;

    return { detonations: this.detonations, swarmSting, anyActive };
  }

  /** Repoint at a freshly generated arena, keeping the pooled models alive. */
  setTerrain(terrain: Terrain): void {
    this.terrain = terrain;
    this.clear();
  }

  clear(): void {
    for (const projectile of this.pool) this.retire(projectile);
    this.swarm.active = false;
    this.swarm.group.visible = false;
  }

  get liveCount(): number {
    let count = 0;
    for (const projectile of this.pool) if (projectile.active) count += 1;
    return count;
  }

  dispose(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.swarm.dispose();
    this.modelCache.clear();
    this.pool.length = 0;
  }
}

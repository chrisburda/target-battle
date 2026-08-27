import * as THREE from 'three';
import { AIM, PHYSICS, WORLD } from '../game/config';
import type { Terrain } from './Terrain';

/**
 * The predicted arc, drawn for a *perfect* interval.
 *
 * This is the central readability promise of the game. Angle is chosen with
 * full information — the dots show exactly where a shot lands if the power
 * interval is held on target — so a miss is never the aim's fault. All the
 * uncertainty lives in the legs, which is the point of the mechanic.
 *
 * The landing marker is drawn separately and pulses, because the dots
 * themselves compress near the apex and the impact point is the number a
 * player actually reads.
 */

const DOT_GEOMETRY = new THREE.SphereGeometry(0.16, 7, 5);

export class AimGuide {
  readonly group = new THREE.Group();

  private readonly dots: THREE.InstancedMesh;
  private readonly marker: THREE.Group;
  private readonly markerRing: THREE.Mesh;
  private readonly markerCross: THREE.Mesh;
  private readonly arrow: THREE.Mesh;
  private readonly dotMaterial: THREE.MeshBasicMaterial;
  private readonly markerMaterial: THREE.MeshBasicMaterial;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly white = new THREE.Color(0xffffff);

  /** Where the perfect shot is predicted to land, or null if it leaves the arena. */
  readonly landing = new THREE.Vector3();
  private hasLanding = false;

  constructor(private terrain: Terrain) {
    this.group.name = 'aimGuide';
    this.group.visible = false;

    this.dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff2b0,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
      depthWrite: false,
    });
    this.dots = new THREE.InstancedMesh(DOT_GEOMETRY, this.dotMaterial, AIM.guideSamples);
    this.dots.name = 'aimDots';
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 6;
    const instanceColors = new Float32Array(AIM.guideSamples * 3);
    this.dots.instanceColor = new THREE.InstancedBufferAttribute(instanceColors, 3);
    this.group.add(this.dots);

    this.markerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe066,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthWrite: false,
    });

    this.marker = new THREE.Group();
    this.marker.name = 'landingMarker';
    const ringGeometry = new THREE.RingGeometry(1.05, 1.35, 26);
    const crossGeometry = new THREE.RingGeometry(0.14, 0.3, 12);
    this.ownedGeometries.push(ringGeometry, crossGeometry);
    this.markerRing = new THREE.Mesh(ringGeometry, this.markerMaterial);
    this.markerRing.renderOrder = 6;
    this.markerCross = new THREE.Mesh(crossGeometry, this.markerMaterial);
    this.markerCross.renderOrder = 6;
    this.marker.add(this.markerRing, this.markerCross);
    this.group.add(this.marker);

    // Launch direction arrow anchored at the throwing hand.
    const arrowGeometry = new THREE.ConeGeometry(0.28, 0.9, 8);
    this.ownedGeometries.push(arrowGeometry);
    this.arrow = new THREE.Mesh(arrowGeometry, this.markerMaterial);
    this.arrow.name = 'aimArrow';
    this.arrow.renderOrder = 6;
    this.group.add(this.arrow);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /**
   * Repoint at a freshly generated arena.
   *
   * Rebuilding the guide between matches meant disposing and recreating it, and
   * its dot geometry is a module-level constant shared by every instance — the
   * second match rendered from buffers that had already been deleted.
   */
  setTerrain(terrain: Terrain): void {
    this.terrain = terrain;
    this.hasLanding = false;
    this.marker.visible = false;
  }

  /**
   * Recompute the arc. `speed` is the launch speed a perfect interval produces,
   * including the animal and ammo multipliers.
   */
  update(options: {
    origin: THREE.Vector3;
    angleDegrees: number;
    facing: 1 | -1;
    speed: number;
    wind: number;
    tint: number;
  }): void {
    const radians = THREE.MathUtils.degToRad(options.angleDegrees);
    this.velocity.set(
      Math.cos(radians) * options.speed * options.facing,
      Math.sin(radians) * options.speed,
      0,
    );
    this.position.copy(options.origin);

    const step = AIM.guideSeconds / AIM.guideSamples;
    // Sub-stepping the preview matches the projectile's own integration closely
    // enough that the dots do not drift away from where the shot actually goes.
    const substeps = 6;
    const dt = step / substeps;
    this.hasLanding = false;

    const colors = this.dots.instanceColor;
    let placed = 0;

    for (let i = 0; i < AIM.guideSamples; i += 1) {
      if (!this.hasLanding) {
        for (let s = 0; s < substeps; s += 1) {
          this.velocity.y -= PHYSICS.gravity * dt;
          this.velocity.x += options.wind * dt;
          this.position.addScaledVector(this.velocity, dt);

          const ground = this.terrain.heightAt(this.position.x);
          const outOfBounds = Math.abs(this.position.x) > WORLD.halfWidth;
          if (this.position.y <= ground || outOfBounds || this.position.y < WORLD.baseY) {
            this.landing.copy(this.position);
            if (!outOfBounds) this.landing.y = ground;
            this.hasLanding = true;
            break;
          }
        }
      }

      if (this.hasLanding && placed > 0) {
        // Stop drawing dots past the impact rather than burying them in rock.
        this.matrix.makeScale(0, 0, 0);
        this.dots.setMatrixAt(i, this.matrix);
        continue;
      }

      const t = i / AIM.guideSamples;
      this.point.copy(this.position);
      this.scale.setScalar(1.15 - t * 0.55);
      this.quaternion.identity();
      this.matrix.compose(this.point, this.quaternion, this.scale);
      this.dots.setMatrixAt(i, this.matrix);

      // Fade from bright at the hand to translucent at the target.
      this.color.setHex(options.tint).lerp(this.white, t * 0.35);
      const fade = 1 - t * 0.65;
      if (colors) {
        colors.setXYZ(i, this.color.r * fade, this.color.g * fade, this.color.b * fade);
      }
      placed += 1;
      if (this.hasLanding) placed = 1;
    }

    this.dots.instanceMatrix.needsUpdate = true;
    if (colors) colors.needsUpdate = true;

    this.marker.visible = this.hasLanding;
    if (this.hasLanding) {
      this.marker.position.set(this.landing.x, this.landing.y + 0.12, WORLD.halfDepth + 0.4);
      this.markerRing.rotation.set(0, 0, 0);
      this.markerCross.rotation.set(0, 0, 0);
    }

    // Cone points +Y by default, so rotate it onto the launch direction.
    const dirX = Math.cos(radians) * options.facing;
    const dirY = Math.sin(radians);
    this.arrow.position.set(
      options.origin.x + dirX * 1.6,
      options.origin.y + dirY * 1.6,
      options.origin.z,
    );
    this.arrow.rotation.set(0, 0, Math.atan2(dirY, dirX) - Math.PI / 2);
    this.dotMaterial.color.setHex(options.tint);
    this.markerMaterial.color.setHex(options.tint);
  }

  /** Idle pulse so the landing marker keeps drawing the eye. */
  animate(elapsed: number): void {
    if (!this.marker.visible) return;
    const pulse = 1 + Math.sin(elapsed * 4.4) * 0.09;
    this.markerRing.scale.setScalar(pulse);
    this.markerCross.rotation.z = elapsed * 1.2;
    this.markerMaterial.opacity = 0.72 + Math.sin(elapsed * 4.4) * 0.16;
  }

  /** Only called when the whole game shuts down. */
  dispose(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.dotMaterial.dispose();
    this.markerMaterial.dispose();
    DOT_GEOMETRY.dispose();
  }
}

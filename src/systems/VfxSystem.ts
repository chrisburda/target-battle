import * as THREE from 'three';
import { radialTexture, scorchTexture } from '../assets/ProceduralTextures';
import { WORLD } from '../game/config';

/**
 * Event-driven VFX.
 *
 * Two pools carry almost everything: a GPU-billboarded Points cloud for soft
 * matter (dust, smoke, splashes, sparkles) and one InstancedMesh of tumbling
 * chunks for hard matter (dirt clods, rock shards). Both are fixed-size and
 * allocation-free at runtime — a nine-round match never grows the heap.
 *
 * Nothing here fires on a timer. Every effect is triggered by a gameplay event
 * and dies within a second or two, so the arena never accumulates permanent
 * particle clutter that competes with the fighters for attention.
 */

const MAX_POINTS = 1400;
const MAX_CHUNKS = 160;
const MAX_RINGS = 6;
const MAX_DECALS = 26;

type PointParticle = {
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
  drag: number;
  gravity: number;
  size: number;
  growth: number;
  color: THREE.Color;
  fadeIn: number;
};

type Chunk = {
  life: number;
  maxLife: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  rotation: THREE.Euler;
  scale: number;
};

type Ring = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  from: number;
  to: number;
};

export class VfxSystem {
  readonly group = new THREE.Group();

  private readonly points: THREE.Points;
  private readonly pointGeometry = new THREE.BufferGeometry();
  private readonly pointMaterial: THREE.ShaderMaterial;
  private readonly pointPositions = new Float32Array(MAX_POINTS * 3);
  private readonly pointColors = new Float32Array(MAX_POINTS * 3);
  private readonly pointSizes = new Float32Array(MAX_POINTS);
  private readonly pointAlphas = new Float32Array(MAX_POINTS);
  private readonly particles: PointParticle[] = [];
  private pointCursor = 0;

  private readonly chunks: THREE.InstancedMesh;
  private readonly chunkData: Chunk[] = [];
  private chunkCursor = 0;

  private readonly rings: Ring[] = [];
  private readonly decals: THREE.Mesh[] = [];
  private decalCursor = 0;

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();

  constructor(private readonly random: () => number) {
    this.group.name = 'vfx';

    // --- soft particles ------------------------------------------------
    this.pointGeometry.setAttribute('position', new THREE.BufferAttribute(this.pointPositions, 3));
    this.pointGeometry.setAttribute('aColor', new THREE.BufferAttribute(this.pointColors, 3));
    this.pointGeometry.setAttribute('aSize', new THREE.BufferAttribute(this.pointSizes, 1));
    this.pointGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.pointAlphas, 1));
    this.pointGeometry.setDrawRange(0, MAX_POINTS);
    this.pointGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400);

    this.pointMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTexture: { value: radialTexture() },
        uScale: { value: 700 },
      },
      vertexShader: [
        'attribute vec3 aColor;',
        'attribute float aSize;',
        'attribute float aAlpha;',
        'uniform float uScale;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  vColor = aColor;',
        '  vAlpha = aAlpha;',
        '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = aSize * uScale / max(1.0, -mvPosition.z);',
        '  gl_Position = projectionMatrix * mvPosition;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uTexture;',
        'varying vec3 vColor;',
        'varying float vAlpha;',
        'void main() {',
        '  if (vAlpha <= 0.001) discard;',
        '  vec4 tex = texture2D(uTexture, gl_PointCoord);',
        '  gl_FragColor = vec4(vColor, tex.a * vAlpha);',
        '}',
      ].join('\n'),
    });

    this.points = new THREE.Points(this.pointGeometry, this.pointMaterial);
    this.points.name = 'vfxParticles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.group.add(this.points);

    for (let i = 0; i < MAX_POINTS; i += 1) {
      this.particles.push({
        life: 0,
        maxLife: 1,
        velocity: new THREE.Vector3(),
        drag: 1,
        gravity: 0,
        size: 1,
        growth: 0,
        color: new THREE.Color(),
        fadeIn: 0,
      });
      this.pointAlphas[i] = 0;
      this.pointPositions[i * 3 + 1] = -9999;
    }

    // --- hard chunks ----------------------------------------------------
    const chunkGeometry = new THREE.IcosahedronGeometry(0.16, 0);
    const chunkMaterial = new THREE.MeshStandardMaterial({
      vertexColors: false,
      color: 0x8a6238,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });
    this.chunks = new THREE.InstancedMesh(chunkGeometry, chunkMaterial, MAX_CHUNKS);
    this.chunks.name = 'vfxChunks';
    this.chunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunks.castShadow = true;
    this.chunks.frustumCulled = false;
    this.chunks.count = MAX_CHUNKS;
    this.group.add(this.chunks);

    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      this.chunkData.push({
        life: 0,
        maxLife: 1,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rotation: new THREE.Euler(),
        scale: 1,
      });
      this.chunks.setMatrixAt(i, hidden);
    }
    this.chunks.instanceMatrix.needsUpdate = true;

    // --- shockwave rings -------------------------------------------------
    const ringGeometry = new THREE.RingGeometry(0.82, 1, 32);
    for (let i = 0; i < MAX_RINGS; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xfff0c0,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(ringGeometry, material);
      mesh.name = 'shockRing';
      mesh.visible = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.rings.push({ mesh, material, life: 0, maxLife: 1, from: 1, to: 4 });
    }

    // --- scorch decals ---------------------------------------------------
    const decalGeometry = new THREE.PlaneGeometry(1, 1);
    const decalMaterial = new THREE.MeshBasicMaterial({
      map: scorchTexture(),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      toneMapped: false,
    });
    for (let i = 0; i < MAX_DECALS; i += 1) {
      const mesh = new THREE.Mesh(decalGeometry, decalMaterial);
      mesh.name = 'scorchDecal';
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.decals.push(mesh);
    }
  }

  // ------------------------------------------------------------ emitters

  private emitPoint(
    x: number,
    y: number,
    z: number,
    velocity: THREE.Vector3,
    color: THREE.ColorRepresentation,
    size: number,
    life: number,
    options?: { drag?: number; gravity?: number; growth?: number; fadeIn?: number },
  ): void {
    const index = this.pointCursor;
    this.pointCursor = (this.pointCursor + 1) % MAX_POINTS;
    const particle = this.particles[index];
    particle.life = life;
    particle.maxLife = life;
    particle.velocity.copy(velocity);
    particle.drag = options?.drag ?? 2.4;
    particle.gravity = options?.gravity ?? 0;
    particle.size = size;
    particle.growth = options?.growth ?? 0;
    particle.fadeIn = options?.fadeIn ?? 0;
    particle.color.set(color);

    this.pointPositions[index * 3] = x;
    this.pointPositions[index * 3 + 1] = y;
    this.pointPositions[index * 3 + 2] = z;
    this.pointColors[index * 3] = particle.color.r;
    this.pointColors[index * 3 + 1] = particle.color.g;
    this.pointColors[index * 3 + 2] = particle.color.b;
    this.pointSizes[index] = size;
    this.pointAlphas[index] = particle.fadeIn > 0 ? 0 : 1;
  }

  private emitChunk(position: THREE.Vector3, velocity: THREE.Vector3, scale: number, life: number): void {
    const index = this.chunkCursor;
    this.chunkCursor = (this.chunkCursor + 1) % MAX_CHUNKS;
    const chunk = this.chunkData[index];
    chunk.life = life;
    chunk.maxLife = life;
    chunk.position.copy(position);
    chunk.velocity.copy(velocity);
    chunk.spin.set(
      (this.random() - 0.5) * 14,
      (this.random() - 0.5) * 14,
      (this.random() - 0.5) * 14,
    );
    chunk.rotation.set(this.random() * 6.28, this.random() * 6.28, this.random() * 6.28);
    chunk.scale = scale;
  }

  private takeRing(): Ring {
    let best = this.rings[0];
    for (const ring of this.rings) {
      if (ring.life <= 0) return ring;
      if (ring.life < best.life) best = ring;
    }
    return best;
  }

  // -------------------------------------------------------------- effects

  /** Dirt, smoke and shards thrown out of a crater. */
  explosion(position: THREE.Vector3, radius: number, tint: THREE.ColorRepresentation = 0xffc46b): void {
    const scale = Math.max(0.6, radius / 5);

    // Fireball core, brief and bright.
    for (let i = 0; i < 14; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = 2 + this.random() * 7 * scale;
      this.tmpVec.set(Math.cos(angle) * speed, Math.abs(Math.sin(angle)) * speed * 0.8 + 1.5, (this.random() - 0.5) * 3);
      this.emitPoint(
        position.x,
        position.y,
        position.z,
        this.tmpVec,
        i % 3 === 0 ? 0xfff2c0 : tint,
        (1.6 + this.random() * 1.4) * scale,
        0.24 + this.random() * 0.2,
        { drag: 3.6, growth: 5 * scale },
      );
    }

    // Smoke: slower, darker, lingers just long enough to read the hit.
    for (let i = 0; i < 26; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = 1.2 + this.random() * 4.2 * scale;
      this.tmpVec.set(Math.cos(angle) * speed, Math.abs(Math.sin(angle)) * speed + 1.4, (this.random() - 0.5) * 2.6);
      this.emitPoint(
        position.x,
        position.y + 0.4,
        position.z,
        this.tmpVec,
        this.tmpColor.setHSL(0.08, 0.22, 0.34 + this.random() * 0.26).getHex(),
        (1.1 + this.random() * 1.5) * scale,
        0.55 + this.random() * 0.45,
        { drag: 1.5, gravity: -1.1, growth: 2.1 * scale, fadeIn: 0.06 },
      );
    }

    // Dirt clods with real gravity.
    for (let i = 0; i < 16; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = 5 + this.random() * 13 * scale;
      this.tmpVec.set(Math.cos(angle) * speed, Math.abs(Math.sin(angle)) * speed + 4, (this.random() - 0.5) * 4);
      this.emitChunk(position, this.tmpVec, (0.6 + this.random() * 1.1) * scale, 1.1 + this.random() * 0.8);
    }

    this.shockwave(position, radius * 0.5, radius * 2.3, 0.42, 0xfff0c0);
    this.scorch(position, radius * 1.7);
  }

  /** Expanding ring that reads the blast radius at a glance. */
  shockwave(
    position: THREE.Vector3,
    from: number,
    to: number,
    life: number,
    color: THREE.ColorRepresentation,
  ): void {
    const ring = this.takeRing();
    ring.life = life;
    ring.maxLife = life;
    ring.from = from;
    ring.to = to;
    ring.material.color.set(color);
    ring.material.opacity = 0.9;
    ring.mesh.visible = true;
    ring.mesh.position.copy(position);
    ring.mesh.rotation.set(0, 0, 0);
    ring.mesh.scale.setScalar(from);
  }

  private scorch(position: THREE.Vector3, size: number): void {
    const decal = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    decal.visible = true;
    decal.position.set(position.x, position.y + 0.05, WORLD.halfDepth + 0.35);
    decal.scale.setScalar(size);
  }

  /** Trail behind a projectile. Cheap: two particles per frame at most. */
  trail(position: THREE.Vector3, color: THREE.ColorRepresentation, intensity = 1): void {
    this.tmpVec.set((this.random() - 0.5) * 0.6, (this.random() - 0.5) * 0.6 + 0.4, (this.random() - 0.5) * 0.4);
    this.emitPoint(
      position.x,
      position.y,
      position.z,
      this.tmpVec,
      color,
      (0.55 + this.random() * 0.4) * intensity,
      0.35 + this.random() * 0.2,
      { drag: 2.2, growth: 1.1 },
    );
  }

  /** Gold sparkle stream for a perfect interval. */
  sparkle(position: THREE.Vector3, count = 6): void {
    for (let i = 0; i < count; i += 1) {
      const angle = this.random() * Math.PI * 2;
      this.tmpVec.set(Math.cos(angle) * 2.4, 2 + this.random() * 3, Math.sin(angle) * 1.4);
      this.emitPoint(
        position.x,
        position.y,
        position.z,
        this.tmpVec,
        i % 2 === 0 ? 0xffe066 : 0xfff6d0,
        0.4 + this.random() * 0.4,
        0.5 + this.random() * 0.4,
        { drag: 1.6, gravity: -3 },
      );
    }
  }

  /** Water column when something lands in the river. */
  splash(position: THREE.Vector3, power = 1): void {
    for (let i = 0; i < 22; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = (2 + this.random() * 7) * power;
      this.tmpVec.set(Math.cos(angle) * speed * 0.6, speed + 3, Math.sin(angle) * speed * 0.4);
      this.emitPoint(
        position.x,
        WORLD.waterY,
        position.z,
        this.tmpVec,
        i % 3 === 0 ? 0xffffff : 0x9fdcf2,
        (0.8 + this.random() * 1.1) * power,
        0.5 + this.random() * 0.5,
        { drag: 1.1, gravity: -16, growth: 0.7 },
      );
    }
    this.shockwave(new THREE.Vector3(position.x, WORLD.waterY + 0.05, position.z), 0.6, 4.5 * power, 0.5, 0xbfeaff);
  }

  /** Puff under the feet when a fighter lands or is knocked back. */
  dust(position: THREE.Vector3, power = 1): void {
    for (let i = 0; i < 8; i += 1) {
      const angle = this.random() * Math.PI * 2;
      this.tmpVec.set(Math.cos(angle) * 2.4 * power, 0.6 + this.random(), Math.sin(angle) * 1.4 * power);
      this.emitPoint(
        position.x,
        position.y + 0.1,
        position.z,
        this.tmpVec,
        0xd9c7a4,
        (1.1 + this.random() * 0.9) * power,
        0.4 + this.random() * 0.3,
        { drag: 3, growth: 1.8, fadeIn: 0.04 },
      );
    }
  }

  /** Charge aura sample: emitted while a fighter holds power near target. */
  charge(position: THREE.Vector3, strength: number, onTarget: boolean): void {
    const angle = this.random() * Math.PI * 2;
    const radius = 0.9 + this.random() * 0.5;
    this.tmpVec.set(0, 1.6 + strength * 2.6, 0);
    this.emitPoint(
      position.x + Math.cos(angle) * radius,
      position.y + this.random() * 0.4,
      position.z + Math.sin(angle) * radius * 0.5,
      this.tmpVec,
      onTarget ? 0x9dff6a : 0xffe066,
      0.35 + strength * 0.5,
      0.42,
      { drag: 1.4, growth: -0.3 },
    );
  }

  /** Confetti burst on elimination. */
  confetti(position: THREE.Vector3): void {
    const palette = [0xda291c, 0xfac800, 0x439f1f, 0x1482c8, 0xffffff];
    for (let i = 0; i < 40; i += 1) {
      const angle = this.random() * Math.PI * 2;
      const speed = 4 + this.random() * 12;
      this.tmpVec.set(Math.cos(angle) * speed, speed * 0.9 + 5, Math.sin(angle) * speed * 0.5);
      this.emitPoint(
        position.x,
        position.y + 1,
        position.z,
        this.tmpVec,
        palette[Math.floor(this.random() * palette.length)],
        0.5 + this.random() * 0.5,
        1.1 + this.random() * 0.7,
        { drag: 0.9, gravity: -13 },
      );
    }
  }

  // ---------------------------------------------------------------- update

  update(delta: number, camera: THREE.Camera): void {
    // Soft particles.
    for (let i = 0; i < MAX_POINTS; i += 1) {
      const particle = this.particles[i];
      if (particle.life <= 0) continue;
      particle.life -= delta;
      if (particle.life <= 0) {
        this.pointAlphas[i] = 0;
        this.pointPositions[i * 3 + 1] = -9999;
        continue;
      }
      const damping = Math.exp(-delta * particle.drag);
      particle.velocity.multiplyScalar(damping);
      particle.velocity.y += particle.gravity * delta;
      this.pointPositions[i * 3] += particle.velocity.x * delta;
      this.pointPositions[i * 3 + 1] += particle.velocity.y * delta;
      this.pointPositions[i * 3 + 2] += particle.velocity.z * delta;

      const age = 1 - particle.life / particle.maxLife;
      this.pointSizes[i] = Math.max(0.02, particle.size + particle.growth * age);
      const fadeIn = particle.fadeIn > 0 ? Math.min(1, (age * particle.maxLife) / particle.fadeIn) : 1;
      this.pointAlphas[i] = Math.max(0, (1 - age * age) * fadeIn);
    }
    (this.pointGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;

    // Hard chunks.
    let chunksDirty = false;
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      const chunk = this.chunkData[i];
      if (chunk.life <= 0) continue;
      chunk.life -= delta;
      chunksDirty = true;
      if (chunk.life <= 0) {
        this.tmpMatrix.makeScale(0, 0, 0);
        this.chunks.setMatrixAt(i, this.tmpMatrix);
        continue;
      }
      chunk.velocity.y -= 30 * delta;
      chunk.velocity.multiplyScalar(Math.exp(-delta * 0.4));
      chunk.position.addScaledVector(chunk.velocity, delta);
      chunk.rotation.x += chunk.spin.x * delta;
      chunk.rotation.y += chunk.spin.y * delta;
      chunk.rotation.z += chunk.spin.z * delta;

      const age = 1 - chunk.life / chunk.maxLife;
      const scale = chunk.scale * (1 - age * age * 0.8);
      this.tmpQuat.setFromEuler(chunk.rotation);
      this.tmpScale.setScalar(scale);
      this.tmpMatrix.compose(chunk.position, this.tmpQuat, this.tmpScale);
      this.chunks.setMatrixAt(i, this.tmpMatrix);
    }
    if (chunksDirty) this.chunks.instanceMatrix.needsUpdate = true;

    // Rings expand and fade, and always face the camera.
    for (const ring of this.rings) {
      if (ring.life <= 0) {
        if (ring.mesh.visible) ring.mesh.visible = false;
        continue;
      }
      ring.life -= delta;
      const t = 1 - Math.max(0, ring.life) / ring.maxLife;
      const eased = 1 - Math.pow(1 - t, 3);
      ring.mesh.scale.setScalar(ring.from + (ring.to - ring.from) * eased);
      ring.material.opacity = Math.max(0, 0.9 * (1 - t));
      ring.mesh.quaternion.copy(camera.quaternion);
      if (ring.life <= 0) ring.mesh.visible = false;
    }
  }

  clear(): void {
    for (let i = 0; i < MAX_POINTS; i += 1) {
      this.particles[i].life = 0;
      this.pointAlphas[i] = 0;
      this.pointPositions[i * 3 + 1] = -9999;
    }
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_CHUNKS; i += 1) {
      this.chunkData[i].life = 0;
      this.chunks.setMatrixAt(i, hidden);
    }
    this.chunks.instanceMatrix.needsUpdate = true;
    for (const ring of this.rings) {
      ring.life = 0;
      ring.mesh.visible = false;
    }
    for (const decal of this.decals) decal.visible = false;
  }

  get activeParticles(): number {
    let count = 0;
    for (const particle of this.particles) if (particle.life > 0) count += 1;
    return count;
  }

  dispose(): void {
    this.pointGeometry.dispose();
    this.pointMaterial.dispose();
    this.chunks.geometry.dispose();
    (this.chunks.material as THREE.Material).dispose();
    // One geometry instance backs every ring and every decal, so dispose it
    // once rather than once per pooled mesh.
    if (this.rings.length > 0) this.rings[0].mesh.geometry.dispose();
    for (const ring of this.rings) ring.material.dispose();
    if (this.decals.length > 0) {
      this.decals[0].geometry.dispose();
      (this.decals[0].material as THREE.Material).dispose();
    }
  }
}

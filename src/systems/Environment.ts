import * as THREE from 'three';
import { WORLD } from '../game/config';
import { cloudTexture } from '../assets/ProceduralTextures';
import { FLORA, SKY, aerial, hex } from '../assets/palette';
import type { MaterialLibrary } from '../assets/MaterialLibrary';

/**
 * Sky, parallax ridges, clouds and river.
 *
 * There is deliberately no `scene.fog`. The camera sits ~140 units back to
 * frame a 130-unit-wide arena, so any distance-based fog dense enough to push
 * the far ridges back would also wash out the play area. Instead each depth
 * layer is authored with its own progressively paler, bluer colour — hand-
 * placed aerial perspective, which is what a 2.5D side view actually wants.
 */

type RidgeLayer = {
  z: number;
  color: number;
  amplitude: number;
  base: number;
  frequency: number;
  /** Parallax factor applied to camera-follow offset. */
  drift: number;
  mesh: THREE.Mesh;
};

const SKY_TOP = SKY.top;
const SKY_HORIZON = SKY.horizon;

/**
 * How far back each ridge layer sits, as a 0..1 recession amount.
 *
 * The colours are not authored. Every layer is the near canopy green walked
 * toward the horizon by `aerial()`, which is the whole of aerial perspective
 * and is the only way four layers stay in one family as the palette moves.
 * Hand-picking them is how the previous kit ended up with a teal third ridge
 * that matched nothing else in the frame — it had drifted 40° of hue away from
 * the layer in front of it because each was chosen on its own.
 */
const RIDGE_RECESSION = [0.3, 0.52, 0.72, 0.9];

export class Environment {
  readonly group = new THREE.Group();

  private readonly ridges: RidgeLayer[] = [];
  private readonly clouds: THREE.Mesh[] = [];
  private readonly cloudMaterial: THREE.MeshBasicMaterial;
  private readonly water: THREE.Mesh;
  private readonly waterMaterial: THREE.MeshStandardMaterial;
  private readonly sky: THREE.Mesh;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly sunDirection = new THREE.Vector3(-0.42, 0.5, 0.75).normalize();

  constructor(
    private readonly materials: MaterialLibrary,
    private readonly random: () => number,
  ) {
    this.group.name = 'environment';

    this.sky = this.createSky();
    this.group.add(this.sky);

    // Four ridge layers, each paler and less contrasty than the one in front.
    const layerSpecs: Array<Omit<RidgeLayer, 'mesh'>> = [
      { z: -46, amplitude: 12, base: 4, frequency: 0.031, drift: 0.06 },
      { z: -104, amplitude: 17, base: 2, frequency: 0.021, drift: 0.13 },
      { z: -186, amplitude: 24, base: -2, frequency: 0.014, drift: 0.22 },
      { z: -290, amplitude: 32, base: -8, frequency: 0.0096, drift: 0.32 },
    ].map((spec, i) => ({ ...spec, color: hex(aerial(FLORA.canopy, RIDGE_RECESSION[i])) }));
    for (const spec of layerSpecs) this.createRidge(spec);

    this.cloudMaterial = new THREE.MeshBasicMaterial({
      map: cloudTexture(),
      color: SKY.cloud.clone(),
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      toneMapped: false,
    });
    this.createClouds();

    this.waterMaterial = this.materials.water;
    this.water = this.createWater();
    this.group.add(this.water);
  }

  private createSky(): THREE.Mesh {
    // Raw ShaderMaterial bypasses tone mapping, so the colours are authored in
    // display space and nudged bright to survive ACES on the rest of the scene.
    const geometry = new THREE.SphereGeometry(620, 32, 16);
    this.geometries.push(geometry);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: SKY_TOP.clone() },
        uHorizon: { value: SKY_HORIZON.clone() },
        uSunColor: { value: SKY.sun.clone() },
        uSunDir: { value: this.sunDirection.clone() },
      },
      vertexShader: [
        'varying vec3 vDir;',
        'void main() {',
        '  vDir = normalize(position);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vDir;',
        'uniform vec3 uTop;',
        'uniform vec3 uHorizon;',
        'uniform vec3 uSunColor;',
        'uniform vec3 uSunDir;',
        'void main() {',
        '  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);',
        '  vec3 col = mix(uHorizon, uTop, pow(h, 0.55));',
        '  float d = clamp(dot(normalize(vDir), normalize(uSunDir)), 0.0, 1.0);',
        '  col += uSunColor * (pow(d, 900.0) + pow(d, 10.0) * 0.22);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'skyDome';
    mesh.frustumCulled = false;
    mesh.renderOrder = -10;
    return mesh;
  }

  /**
   * A ridge is a single filled silhouette: a sine-stack skyline extruded down
   * past the bottom of the frame. Unlit MeshBasicMaterial keeps the layer flat,
   * which is exactly the read a distant hazy ridge should have.
   */
  private createRidge(spec: Omit<RidgeLayer, 'mesh'>): void {
    const segments = 160;
    const width = 900;
    const bottom = -220;
    const positions = new Float32Array((segments + 1) * 2 * 3);
    const indices: number[] = [];

    const phase = this.random() * Math.PI * 2;
    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const x = -width / 2 + t * width;
      const y =
        spec.base +
        Math.sin(x * spec.frequency + phase) * spec.amplitude +
        Math.sin(x * spec.frequency * 2.7 + phase * 1.7) * spec.amplitude * 0.34 +
        Math.sin(x * spec.frequency * 6.1 + phase * 0.4) * spec.amplitude * 0.12;
      positions[i * 6] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = 0;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = bottom;
      positions[i * 6 + 5] = 0;
      if (i < segments) {
        const a = i * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.geometries.push(geometry);

    const material = new THREE.MeshBasicMaterial({ color: spec.color, toneMapped: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'ridge';
    mesh.position.z = spec.z;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.ridges.push({ ...spec, mesh });
  }

  private createClouds(): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(geometry);
    for (let i = 0; i < 11; i += 1) {
      const cloud = new THREE.Mesh(geometry, this.cloudMaterial);
      cloud.name = 'cloud';
      const scale = 34 + this.random() * 62;
      cloud.scale.set(scale, scale * 0.44, 1);
      cloud.position.set(
        (this.random() - 0.5) * 620,
        34 + this.random() * 62,
        -120 - this.random() * 190,
      );
      cloud.renderOrder = -5;
      cloud.frustumCulled = false;
      this.group.add(cloud);
      this.clouds.push(cloud);
    }
  }

  private createWater(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(WORLD.halfWidth * 2 + 40, 60, 1, 1);
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, this.waterMaterial);
    mesh.name = 'river';
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, WORLD.waterY, -18);
    mesh.receiveShadow = true;
    return mesh;
  }

  get sunDir(): THREE.Vector3 {
    return this.sunDirection;
  }

  /**
   * Parallax. The layers slide against the camera by a fraction of its own
   * travel, which reads as depth without moving the camera off the action.
   */
  update(deltaSeconds: number, elapsed: number, cameraX: number): void {
    for (const ridge of this.ridges) {
      ridge.mesh.position.x = cameraX * ridge.drift;
    }
    for (let i = 0; i < this.clouds.length; i += 1) {
      const cloud = this.clouds[i];
      cloud.position.x += deltaSeconds * (1.1 + (i % 4) * 0.45);
      if (cloud.position.x > 330) cloud.position.x = -330;
    }
    const map = this.waterMaterial.map;
    if (map) {
      map.offset.x = elapsed * 0.045;
      map.offset.y = Math.sin(elapsed * 0.22) * 0.03;
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.cloudMaterial.dispose();
    for (const ridge of this.ridges) (ridge.mesh.material as THREE.Material).dispose();
  }
}

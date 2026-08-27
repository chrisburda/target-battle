import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
/** Half-width of the shadow frustum, in world units, centred on the camera. */
const SHADOW_HALF_WIDTH = 34;

/**
 * Key / fill / rim plus a neutral IBL.
 *
 * One shadow-casting light, sized to the arena. The rim light is the important
 * one for this game: a locked side view puts every fighter against either the
 * pale sky or a green ridge, and without a back light the darker animals
 * (boar, toucan) sink into both.
 */
export class LightingRig {
  readonly group = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.HemisphereLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly bounce: THREE.DirectionalLight;
  private environment: THREE.Texture | null = null;

  constructor(sunDirection: THREE.Vector3) {
    this.group.name = 'lighting';

    this.key = new THREE.DirectionalLight(0xfff0cf, 2.15);
    this.key.name = 'keyLight';
    this.key.position.copy(sunDirection).multiplyScalar(90);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 10;
    this.key.shadow.camera.far = 260;
    // The frustum tracks the camera rather than spanning the whole arena: at
    // 136 units wide a 2048 map gave 15 texels per unit and shadows dissolved
    // into mush. Half that width doubles the density where it is looked at.
    this.key.shadow.camera.left = -SHADOW_HALF_WIDTH;
    this.key.shadow.camera.right = SHADOW_HALF_WIDTH;
    this.key.shadow.camera.top = 44;
    this.key.shadow.camera.bottom = -30;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.035;
    this.group.add(this.key);
    this.group.add(this.key.target);

    // Warm sky over cool jungle bounce keeps shadows readable, not black.
    this.fill = new THREE.HemisphereLight(0xd8ecf6, 0x3d5a2c, 0.95);
    this.fill.name = 'skyFill';
    this.group.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xbfe4ff, 0.85);
    this.rim.name = 'rimLight';
    this.rim.position.set(28, 26, -70);
    this.group.add(this.rim);

    // Low warm bounce from the ground plane, no shadow cost.
    this.bounce = new THREE.DirectionalLight(0xffd9a0, 0.3);
    this.bounce.name = 'groundBounce';
    this.bounce.position.set(-20, -30, 40);
    this.group.add(this.bounce);
  }

  /** Neutral studio IBL so metals and the eye highlights have something to reflect. */
  attachEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = this.environment;
    scene.environmentIntensity = 0.4;
    pmrem.dispose();
  }

  /** Keep the shadow frustum tight around whatever the camera is looking at. */
  followCamera(centerX: number): void {
    this.key.target.position.set(centerX, 6, 0);
    this.key.target.updateMatrixWorld();
    // Steep and slightly to the left: shadows fall right and down-screen, where
    // a side-on camera can actually see them land on the grass.
    this.key.position.set(centerX - 44, 74, 52);
  }

  setShadowQuality(size: number): void {
    if (this.key.shadow.mapSize.width === size) return;
    this.key.shadow.mapSize.set(size, size);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  dispose(): void {
    this.environment?.dispose();
    this.key.shadow.map?.dispose();
  }
}

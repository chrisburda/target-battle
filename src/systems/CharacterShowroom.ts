import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createFighterModel, type FighterModel } from '../assets/modelFactories/AnimalFactory';
import type { MaterialLibrary } from '../assets/MaterialLibrary';
import { getAnimal } from '../game/roster';

/**
 * Rotating character portrait for the setup screen.
 *
 * This has its own small canvas and renderer rather than a scissored viewport
 * inside the main one. A scissor region would sit *behind* the setup screen's
 * DOM panels, so the panel background would tint it; a real canvas with an
 * alpha buffer sits *inside* the panel and composites correctly with no
 * hole-punching gymnastics. The cost is a second GL context on a screen where
 * the game itself is idle.
 *
 * It also happens to be the only view in the project that shows a fighter at
 * three-quarters and full size, which makes it the honest place to judge the
 * models — a side-on silhouette hides most of what is wrong with them.
 */
export class CharacterShowroom {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 0.82, 0.1, 60);
  private readonly pivot = new THREE.Group();
  private environment: THREE.Texture | null = null;

  private model: FighterModel | null = null;
  private animalId: string | null = null;
  private spin = 0;
  private running = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly materials: MaterialLibrary,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.86;
    this.renderer.shadowMap.enabled = false;
    this.renderer.setClearAlpha(0);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    // Portrait lighting, not gameplay lighting: a strong key from the front
    // left, a cool fill, and a rim that separates the silhouette from the
    // panel behind it.
    const key = new THREE.DirectionalLight(0xfff2da, 1.85);
    key.position.set(-2.4, 3.4, 4.2);
    this.scene.add(key);

    const fill = new THREE.HemisphereLight(0xdfeeff, 0x2b3340, 0.62);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xbcd9ff, 1.05);
    rim.position.set(2.6, 2.2, -3.4);
    this.scene.add(rim);

    this.scene.add(this.pivot);
    // A fighter stands about 3.9 world units; at 32 degrees this distance
    // frames 4.6, which leaves headroom instead of cropping the skull.
    this.camera.position.set(0.55, 2.3, 8.2);
    this.camera.lookAt(0, 1.95, 0);
  }

  /**
   * The portrait renderer, shared with the icon baker so the interface does
   * not open a third GL context just to take six pictures.
   */
  get rendererForIcons(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /** Swap the displayed fighter. Cheap enough to call on every hover. */
  setAnimal(animalId: string): void {
    if (animalId === this.animalId) return;
    this.animalId = animalId;
    this.disposeModel();

    const model = createFighterModel(this.materials, getAnimal(animalId));
    // Portraits face the camera's left-of-centre, the classic character-select
    // three-quarter angle, rather than the profile the game uses.
    model.root.rotation.y = -0.62;
    this.pivot.add(model.root);
    this.model = model;
    this.spin = 0;
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.canvas.style.visibility = running ? 'visible' : 'hidden';
  }

  update(delta: number, elapsed: number): void {
    if (!this.running || !this.model) return;
    this.resize();

    // A slow sway rather than a full spin: a turntable hides the face half the
    // time, and the face is the thing being shown off.
    this.spin += delta;
    this.pivot.rotation.y = Math.sin(this.spin * 0.55) * 0.55;
    this.model.body.position.y = 0.34 + Math.sin(elapsed * 2.1) * 0.035;
    this.model.throwArm.rotation.z = 0.22 + Math.sin(elapsed * 1.7) * 0.12;

    // Blink on the portrait too, on its own rhythm.
    const phase = (elapsed * 0.42) % 1;
    const closed = phase > 0.94 ? Math.sin((phase - 0.94) / 0.06 * Math.PI) : 0;
    for (const lid of this.model.lids) {
      lid.rotation.z = 0.55 + closed * (-1.75 - 0.55);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width === Math.floor(width * dpr) && this.canvas.height === Math.floor(height * dpr)) {
      return;
    }
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private disposeModel(): void {
    if (!this.model) return;
    this.pivot.remove(this.model.root);
    this.model.root.traverse((object) => {
      const asMesh = object as THREE.Mesh;
      if (asMesh.isMesh && asMesh.geometry) asMesh.geometry.dispose();
    });
    this.model = null;
  }

  dispose(): void {
    this.disposeModel();
    this.environment?.dispose();
    this.renderer.dispose();
  }
}

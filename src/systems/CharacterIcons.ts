import * as THREE from 'three';
import { createFighter, releaseFighterModel } from '../assets/modelFactories/fighterModels';
import type { MaterialLibrary } from '../assets/MaterialLibrary';
import { ANIMALS, getAnimal } from '../game/roster';
import { setCreaturePortrait } from '../ui/icons';

/**
 * Bakes a head-and-shoulders portrait of every fighter to a PNG data URL.
 *
 * The interface used to show hand-drawn SVG creature tokens. They read well,
 * but they were a second, independent drawing of each character — so any change
 * to a model silently drifted away from its icon, and the picker showed
 * something the game never renders. These are the real models, lit and framed
 * once at startup, so an avatar cannot disagree with the fighter it selects.
 *
 * Rendering goes through a RenderTarget rather than the visible canvas:
 * `toDataURL` on a live canvas needs `preserveDrawingBuffer`, which taxes every
 * frame of the game for the sake of six images taken once.
 */
export class CharacterIcons {
  private static readonly SIZE = 192;

  private readonly scene = new THREE.Scene();
  private static readonly SCRATCH = new THREE.Vector3();

  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
  private readonly target: THREE.WebGLRenderTarget;
  private readonly pixels: Uint8Array;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly materials: MaterialLibrary,
  ) {
    const size = CharacterIcons.SIZE;
    this.target = new THREE.WebGLRenderTarget(size, size, {
      colorSpace: THREE.SRGBColorSpace,
      samples: 4,
    });
    this.pixels = new Uint8Array(size * size * 4);

    // Portrait lighting, brighter and flatter than gameplay: an icon is read
    // at 34 pixels, so form matters far less than a clean, legible face.
    const key = new THREE.DirectionalLight(0xfff4e2, 2.4);
    key.position.set(-1.6, 2.4, 3.2);
    this.scene.add(key);
    const fill = new THREE.HemisphereLight(0xe6f2ff, 0x39424f, 1.15);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xbcd9ff, 1.2);
    rim.position.set(2.2, 1.4, -2.6);
    this.scene.add(rim);
  }

  /** Renders every fighter and publishes the results to the icon registry. */
  renderAll(): void {
    for (const animal of ANIMALS) {
      const url = this.render(animal.id);
      if (url) setCreaturePortrait(animal.id, url);
    }
  }

  private render(animalId: string): string | null {
    const model = createFighter(this.materials, getAnimal(animalId));
    // Three-quarter view, turned toward the viewer's left, which is the angle
    // the setup portrait uses too.
    model.root.rotation.y = -0.75;
    this.scene.add(model.root);

    /*
     * Framed off the head's own position, not a fraction of total height.
     *
     * 0.78 of the standing height is a fair guess for most of this cast and it
     * is only ever a guess — it encodes one particular head-to-body ratio. The
     * frog has a squat body under a large skull, and the moment its
     * proportions moved, its avatar framed the chest with the face out of
     * shot. The head is a named node on the model; asking it where it is costs
     * one matrix update and cannot drift.
     */
    model.root.updateMatrixWorld(true);
    const headY = model.head.getWorldPosition(CharacterIcons.SCRATCH).y;
    this.camera.position.set(0.62, headY + 0.22, 4.6);
    this.camera.lookAt(0, headY - 0.16, 0);
    this.camera.updateProjectionMatrix();

    const previousTarget = this.renderer.getRenderTarget();
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearAlpha(0);
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    let url: string | null = null;
    try {
      const size = CharacterIcons.SIZE;
      this.renderer.readRenderTargetPixels(this.target, 0, 0, size, size, this.pixels);
      url = this.toDataUrl(this.pixels, size);
    } catch {
      // A failed read just means the roster keeps its drawn fallback icons.
      url = null;
    }

    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearAlpha(previousAlpha);

    releaseFighterModel(model);

    return url;
  }

  private toDataUrl(pixels: Uint8Array, size: number): string | null {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const image = ctx.createImageData(size, size);
    // GL reads bottom-up; canvas ImageData is top-down.
    for (let y = 0; y < size; y += 1) {
      const source = (size - 1 - y) * size * 4;
      const destination = y * size * 4;
      image.data.set(pixels.subarray(source, source + size * 4), destination);
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  dispose(): void {
    this.target.dispose();
  }
}

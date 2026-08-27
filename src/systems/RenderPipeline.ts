import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Renderer, resize and the post chain.
 *
 * Two passes beyond render+output on desktop (bloom, vignette), one on mobile.
 * The composer allocates full-resolution HDR targets, so its cost scales with
 * DPR squared — the DPR cap is set before any pass is added, not after.
 *
 * Bloom threshold is high on purpose: it should pick up the authored emissive
 * signals (aim guide, power aura, explosion cores) and nothing else. If a shape
 * only reads because it glows, that is a modelling bug, not a bloom setting.
 */

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uStrength: { value: 0.62 },
    uSize: { value: 0.78 },
  },
  vertexShader: [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}',
  ].join('\n'),
  fragmentShader: [
    'uniform sampler2D tDiffuse;',
    'uniform float uStrength;',
    'uniform float uSize;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec4 c = texture2D(tDiffuse, vUv);',
    '  float d = distance(vUv, vec2(0.5));',
    '  c.rgb *= mix(1.0, smoothstep(uSize, uSize - 0.5, d), uStrength);',
    '  gl_FragColor = c;',
    '}',
  ].join('\n'),
};

export type QualityTier = 'desktop' | 'mobile';

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private vignette: ShaderPass | null = null;
  private renderPass: RenderPass | null = null;
  private outputPass: OutputPass | null = null;
  private tier: QualityTier;
  private maxDpr: number;
  private postEnabled = true;

  constructor(
    canvas: HTMLCanvasElement,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The composer issues several render calls per frame and three resets
    // info.render at the start of each one, so an auto-reset counter would only
    // ever report the final full-screen quad. Reset once per frame instead and
    // the diagnostics describe the whole frame, post passes included.
    this.renderer.info.autoReset = false;

    this.tier = this.detectTier();
    this.maxDpr = this.tier === 'mobile' ? 1.5 : 2;
    this.buildComposer();
    this.resize();
  }

  private detectTier(): QualityTier {
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 620;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    return narrow || coarse ? 'mobile' : 'desktop';
  }

  private buildComposer(): void {
    this.composer?.dispose();
    const composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      this.tier === 'mobile' ? 0.32 : 0.44,
      0.32,
      0.86,
    );
    composer.addPass(this.bloom);

    if (this.tier === 'desktop') {
      this.vignette = new ShaderPass(VignetteShader);
      composer.addPass(this.vignette);
    } else {
      this.vignette = null;
    }

    this.outputPass = new OutputPass();
    composer.addPass(this.outputPass);
    this.composer = composer;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    if (this.renderPass) this.renderPass.camera = camera;
  }

  /** Turned off by the QA harness to measure the raw scene cost. */
  setPostEnabled(enabled: boolean): void {
    this.postEnabled = enabled;
  }

  get postPassCount(): number {
    if (!this.postEnabled) return 0;
    return this.vignette ? 2 : 1;
  }

  get qualityTier(): QualityTier {
    return this.tier;
  }

  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.maxDpr);
  }

  setMaxDpr(value: number): void {
    this.maxDpr = value;
    this.resize(true);
  }

  resize(force = false): boolean {
    const canvas = this.renderer.domElement;
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const dpr = this.pixelRatio;
    const bufferWidth = Math.floor(width * dpr);
    const bufferHeight = Math.floor(height * dpr);
    if (!force && canvas.width === bufferWidth && canvas.height === bufferHeight) return false;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.composer?.setPixelRatio(dpr);
    this.composer?.setSize(width, height);
    this.bloom?.setSize(width, height);

    const nextTier = this.detectTier();
    if (nextTier !== this.tier) {
      this.tier = nextTier;
      this.maxDpr = this.tier === 'mobile' ? 1.5 : 2;
      this.buildComposer();
      this.composer?.setPixelRatio(this.pixelRatio);
      this.composer?.setSize(width, height);
    }
    return true;
  }

  render(): void {
    this.renderer.info.reset();
    if (this.postEnabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get diagnostics(): {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
    dpr: number;
    postPasses: number;
    shadowMapSize: number;
    tier: QualityTier;
  } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      dpr: this.pixelRatio,
      postPasses: this.postPassCount,
      shadowMapSize: this.tier === 'mobile' ? 1024 : 2048,
      tier: this.tier,
    };
  }

  dispose(): void {
    this.composer?.dispose();
    this.renderer.dispose();
  }
}

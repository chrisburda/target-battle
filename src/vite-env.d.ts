/// <reference types="vite/client" />

interface ThreeGameFighterDiagnostics {
  slot: number;
  animal: string;
  health: number;
  alive: boolean;
  x: number;
  y: number;
  damageDealt: number;
  shots: number;
  /** Mean interval accuracy across this fighter's shots, 0..1. */
  accuracy: number;
  secondsInZone: number;
}

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  phase: string;
  round: number;
  /** Total damage dealt across the match, used as the generic progress signal. */
  score: number;
  targetScore: number;
  complete: boolean;
  wind: number;
  activeSlot: number;
  lastShot: string;
  fighters: ThreeGameFighterDiagnostics[];
  /** Kept for parity with the shared canvas inspector, which expects it. */
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
  };
  world: {
    terrainTriangles: number;
    propBatches: number;
    instancedMeshes: number;
    props: number;
    propDensity: number;
    propShadows: boolean;
    proceduralTextures: number;
    materials: number;
    particles: number;
    projectiles: number;
    occlusionBake: Array<{ animal: string; ms: number; samples: number; min: number; mean: number }>;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
    dpr: number;
    postPasses: number;
    shadowMapSize: number;
    tier: string;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
}

interface ThreeGameTestHooks {
  /** Swaps to the generated cast and resolves once it has downloaded. */
  useGeneratedCast?: () => Promise<void>;
  /** Starts a throw on the active fighter, for animation capture. */
  throwNow?: () => boolean;
  /** Name of the model in the active hand, to prove which factory built it. */
  heldRoundName?: () => string | null;
  /** Picks a round by id, so a capture can show one that is not the default. */
  pickAmmo?: (ammoId: string) => void;
  /** Per-fighter build facts, for diagnosing a silent adaptation failure. */
  inspectCast?: () => Array<Record<string, string | number>>;
  /** Re-seed the game RNG; all gameplay randomness flows through it. */
  seed(value: number): void;
  /**
   * Jump to a named state for baselines and metrics:
   * 'setup' | 'active-play' | 'aim' | 'interval' | 'flight' | 'stress' | 'results'.
   */
  setState(name: string): void;
  /** Freeze the simulation while continuing to render the current frame. */
  setPausedForScreenshot(paused: boolean): void;
  /** Freeze ambient/idle animation time so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  /** Hide debug UI before capturing. */
  hideDebugUi(hidden: boolean): void;
  /** Inject one power tap, as if the spacebar were pressed. */
  tap(): void;
  /** Choose which fighter the active turn is aimed at. */
  selectTarget(slot: number): void;
  /** Step the chosen target one place along the line-up. */
  cycleTarget(direction: number): void;
  /** Confirm the aim and start the ready countdown. */
  lockAim(): void;
  /** Current phase name. */
  getState(): string;
  /** Replace the line-up and start a fresh match. Used by the bot playtest. */
  configure(
    players: Array<{ controller: 'human' | 'ai'; animalId: string; aiSkill: number }>,
    wind: boolean,
  ): void;
  /** Run N complete turns through the real update path. */
  advanceTurns(count: number): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}

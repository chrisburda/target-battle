import * as THREE from 'three';
import { Loop } from '../core/Loop';
import { AIM, AI, CAMERA, INTERVAL, MATCH, PHYSICS, POWER, VFX } from './config';
import { AMMO, ANIMALS, getAmmo, getAnimal } from './roster';
import { IntervalScorer, planInterval, resolveShot, type IntervalPlan } from './IntervalScorer';
import { findBestAngle, simulateShot } from './ballistics';
import { createSeededRandom } from '../utils/random';
import { MaterialLibrary } from '../assets/MaterialLibrary';
import { disposeProceduralTextures, proceduralTextureCount } from '../assets/ProceduralTextures';
import { WorldPropKit, type PropKitOptions } from '../assets/modelFactories/WorldPropKit';
import { disposeSharedAnimalGeometry, setModelQuality } from '../assets/modelFactories/AnimalFactory';
import { disposeSharedAmmoGeometry } from '../assets/modelFactories/AmmoFactory';
import { Terrain } from '../systems/Terrain';
import { Environment } from '../systems/Environment';
import { LightingRig } from '../systems/LightingRig';
import { RenderPipeline } from '../systems/RenderPipeline';
import { CameraRig, type CameraMode } from '../systems/CameraRig';
import { VfxSystem } from '../systems/VfxSystem';
import { ProjectileSystem, type Detonation } from '../systems/Projectiles';
import { AimGuide } from '../systems/AimGuide';
import { CharacterShowroom } from '../systems/CharacterShowroom';
import { CharacterIcons } from '../systems/CharacterIcons';
import { AudioSystem } from '../systems/AudioSystem';
import { ShakeRig, TweenManager } from '../systems/Feel';
import { Fighter } from '../entities/Fighter';
import { Hud, type RosterEntry, type TargetCard } from '../ui/Hud';
import { PauseScreen, ResultsScreen, SetupScreen, type ResultRow } from '../ui/Screens';
import { SpacebarPowerSource } from '../power/SpacebarPowerSource';
import { AiPowerSource } from '../power/AiPowerSource';
import type { PowerSource } from '../power/PowerSource';
import type { PhaseName, PlayerConfig } from './types';

/**
 * Match orchestration.
 *
 * Owns the phase machine, the turn order, and the one place where a shot turns
 * into damage. Systems below it (terrain, projectiles, VFX, HUD) know nothing
 * about whose turn it is; they are told what to do.
 *
 * Update order is fixed and explicit:
 *   input -> phase -> fighters -> projectiles -> terrain flush -> vfx ->
 *   camera -> shake -> HUD -> render
 */

/** Quality of the solved line to the chosen target. */
export type LineQuality = 'clear' | 'splash' | 'blocked';

export type TargetSolution = {
  slot: number;
  /** Solved launch angle for a perfect interval. */
  angle: number;
  /** Where a perfect shot lands. */
  landingX: number;
  landingY: number;
  /** Horizontal gap between that landing point and the target. */
  missDistance: number;
  quality: LineQuality;
  distance: number;
};

type TurnState = {
  slot: number;
  plan: IntervalPlan;
  source: PowerSource;
  ammoId: string;
  /** Slot of the fighter being shot at. */
  targetSlot: number;
  /** Cached solution for the current target/ammo pair. */
  solution: TargetSolution | null;
  displayWatts: number;
  wasInZone: boolean;
  /** AI only: how long it has been pretending to think. */
  aiThinkTime: number;
};

const DEFAULT_PLAYERS: PlayerConfig[] = [
  { slot: 0, controller: 'human', animalId: 'gecko', aiSkill: AI.defaultSkill },
  { slot: 1, controller: 'ai', animalId: 'boar', aiSkill: AI.defaultSkill },
];

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly pipeline: RenderPipeline;
  private readonly cameraRig = new CameraRig();
  private readonly materials = new MaterialLibrary();
  private readonly tweens = new TweenManager();
  private readonly shake = new ShakeRig();

  private rng = createSeededRandom(20260826);
  /**
   * Scenery's own random stream, forked from the same seed.
   *
   * Decoration must not draw from `rng`. Every scatter call advances it, so
   * adding one family of props silently re-rolls spawn points, wind and every
   * AI decision for the rest of the match — a seed stops meaning what it meant,
   * and no two builds can be compared frame to frame. Splitting the stream
   * keeps the arena reproducible while the dressing on it is free to change.
   */
  private decorRng = createSeededRandom(20260826 ^ 0x9e3779b9);
  private readonly audio: AudioSystem;
  private readonly vfx: VfxSystem;
  private terrain!: Terrain;
  private props!: WorldPropKit;
  private environment!: Environment;
  private lighting!: LightingRig;
  private projectiles!: ProjectileSystem;
  private aimGuide!: AimGuide;

  private readonly hud = new Hud();
  private readonly showroom: CharacterShowroom;
  private readonly characterIcons: CharacterIcons;
  private readonly setupScreen = new SetupScreen();
  private readonly pauseScreen = new PauseScreen();
  private readonly resultsScreen = new ResultsScreen();

  private readonly worldRoot = new THREE.Group();
  private readonly fighters: Fighter[] = [];
  private readonly scorer = new IntervalScorer();
  private readonly spacebarSource = new SpacebarPowerSource();
  private readonly aiSources = new Map<number, AiPowerSource>();

  private readonly loop: Loop;
  private readonly keys = new Set<string>();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();

  private phase: PhaseName = 'setup';
  private phaseTime = 0;
  private turn: TurnState | null = null;
  private turnOrder: number[] = [];
  private turnIndex = 0;
  private round = 1;
  private wind = 0;
  private windEnabled = true;
  private players: PlayerConfig[] = DEFAULT_PLAYERS.map((player) => ({ ...player }));
  private targetCycle: -1 | 0 | 1 = 0;
  private targetRepeatTimer = 0;
  private cameraMode: CameraMode = 'overview';
  private frame = 0;
  private elapsed = 0;
  private gameElapsed = 0;
  private paused = false;
  private pausedForScreenshot = false;
  private reducedMotion = false;
  private timeScale = 1;
  private hitstopRemaining = 0;
  private seed = 20260826;
  private lastShotSummary = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.audio = new AudioSystem(() => this.rng());
    this.vfx = new VfxSystem(() => this.rng());

    this.pipeline = new RenderPipeline(canvas, this.scene, this.cameraRig.camera);
    this.scene.background = new THREE.Color(0x9fc8e4);
    this.scene.add(this.worldRoot);

    const portraitCanvas = document.querySelector<HTMLCanvasElement>('#portrait-canvas');
    if (!portraitCanvas) throw new Error('Missing #portrait-canvas element.');
    this.showroom = new CharacterShowroom(portraitCanvas, this.materials);
    // Bake the roster avatars before any screen renders, so the picker never
    // shows a placeholder that disagrees with the model.
    this.characterIcons = new CharacterIcons(this.showroom.rendererForIcons, this.materials);
    this.characterIcons.renderAll();

    this.buildWorld();
    this.wireUi();
    this.installInput();
    this.installTestHooks();

    this.loop = new Loop(
      (delta, elapsed) => this.update(delta, elapsed),
      () => this.render(),
    );

    this.setupScreen.initialise(this.players);
    this.setupScreen.setVisible(true);
    this.showroom.setRunning(true);
    this.hud.setVisible(false);
    this.resize();
    this.publishDiagnostics();
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    for (const fighter of this.fighters) fighter.dispose();
    this.projectiles.dispose();
    this.aimGuide.dispose();
    this.vfx.dispose();
    this.props.dispose();
    this.environment.dispose();
    this.terrain.dispose();
    this.lighting.dispose();
    this.materials.dispose();
    disposeProceduralTextures();
    disposeSharedAnimalGeometry();
    disposeSharedAmmoGeometry();
    this.characterIcons.dispose();
    this.showroom.dispose();
    this.audio.dispose();
    this.pipeline.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  /**
   * Prop budget for the current tier. Mobile drops density and stops instanced
   * foliage casting shadows: together they were the difference between 172
   * draw calls and the 150-call mobile budget.
   */
  private get propOptions(): PropKitOptions {
    return this.pipeline.qualityTier === 'mobile'
      ? { density: 0.5, castShadows: false, skip: ['vine', 'mushroom', 'log'] }
      : { density: 1, castShadows: true };
  }

  private buildWorld(): void {
    this.terrain = new Terrain(this.materials, { seed: this.seed, hills: 4 });
    this.worldRoot.add(this.terrain.group);

    this.environment = new Environment(this.materials, () => this.decorRng());
    this.worldRoot.add(this.environment.group);

    this.lighting = new LightingRig(this.environment.sunDir);
    this.worldRoot.add(this.lighting.group);
    this.lighting.attachEnvironment(this.pipeline.renderer, this.scene);
    this.lighting.setShadowQuality(this.pipeline.qualityTier === 'mobile' ? 1024 : 2048);

    this.props = new WorldPropKit(this.materials, this.terrain, () => this.decorRng(), this.propOptions);
    this.worldRoot.add(this.props.group);

    this.vfx.clear();
    this.worldRoot.add(this.vfx.group);

    this.projectiles = new ProjectileSystem(this.materials, this.terrain, this.vfx, () => this.rng());
    this.worldRoot.add(this.projectiles.group);

    this.aimGuide = new AimGuide(this.terrain);
    this.worldRoot.add(this.aimGuide.group);

    this.cameraRig.frame(0, 12, CAMERA.overviewWidth);
    this.cameraRig.snap();
  }

  /** Fresh terrain and scenery for a new match. */
  private rebuildWorld(): void {
    this.worldRoot.remove(this.terrain.group, this.props.group, this.environment.group);
    this.terrain.dispose();
    this.props.dispose();
    this.environment.dispose();

    this.terrain = new Terrain(this.materials, { seed: this.seed, hills: 3 + Math.floor(this.rng() * 3) });
    this.worldRoot.add(this.terrain.group);
    this.environment = new Environment(this.materials, () => this.decorRng());
    this.worldRoot.add(this.environment.group);
    this.props = new WorldPropKit(this.materials, this.terrain, () => this.decorRng(), this.propOptions);
    this.worldRoot.add(this.props.group);

    // The aim guide and projectile pool only needed the new heightfield. They
    // hold shared geometry, and disposing them every match is what corrupted
    // the shadow pass on the second rebuild.
    this.aimGuide.setTerrain(this.terrain);
    this.projectiles.setTerrain(this.terrain);
    this.projectiles.wind = this.wind;
  }

  // ------------------------------------------------------------------ ui

  private wireUi(): void {
    this.setupScreen.onPreview = (animalId) => this.showroom.setAnimal(animalId);
    this.setupScreen.onInteract = () => {
      this.audio.unlock();
      this.audio.uiClick();
    };
    this.setupScreen.onStart = (players, wind) => {
      this.audio.unlock();
      this.audio.uiConfirm();
      this.players = players;
      this.windEnabled = wind;
      this.startMatch(true);
    };

    this.hud.onAmmoPicked = (ammoId) => this.selectAmmo(ammoId);
    this.hud.onPause = () => this.setPaused(true);
    this.hud.onToggleSound = () => {
      this.audio.setMuted(!this.audio.isMuted);
      this.hud.setSoundMuted(this.audio.isMuted);
    };
    this.hud.onTargetPicked = (slot) => this.selectTarget(slot);
    this.hud.onTouchAim = (direction) => {
      this.targetCycle = direction;
      this.targetRepeatTimer = 0;
      if (direction !== 0) this.cycleTarget(direction);
    };
    this.hud.onTouchAction = () => {
      this.audio.unlock();
      if (this.phase === 'aim') this.lockAim();
      else if (this.phase === 'interval') this.registerTap();
    };

    this.pauseScreen.onResume = () => this.setPaused(false);
    this.pauseScreen.onRestart = () => {
      this.setPaused(false);
      this.startMatch(true);
    };
    this.pauseScreen.onQuit = () => {
      this.setPaused(false);
      this.toSetup();
    };

    this.resultsScreen.onRematch = () => this.startMatch(true);
    this.resultsScreen.onSetup = () => this.toSetup();

    this.hud.setSoundMuted(this.audio.isMuted);
  }

  private toSetup(): void {
    this.showroom.setRunning(true);
    this.phase = 'setup';
    this.turn = null;
    this.projectiles.clear();
    this.vfx.clear();
    this.hud.setVisible(false);
    this.hud.clearFloaters();
    this.resultsScreen.setVisible(false);
    this.aimGuide.setVisible(false);
    this.setupScreen.initialise(this.players);
    this.setupScreen.setVisible(true);
    this.setCamera('overview');
  }

  // --------------------------------------------------------------- match

  private startMatch(newTerrain: boolean): void {
    this.showroom.setRunning(false);
    this.setupScreen.setVisible(false);
    this.resultsScreen.setVisible(false);
    this.pauseScreen.setVisible(false);
    this.hud.setVisible(true);
    this.hud.clearFloaters();
    this.hud.hideBanner();

    // Drop every held round before the projectile system is torn down, so no
    // fighter is left pointing at geometry that is about to be disposed.
    for (const fighter of this.fighters) fighter.setHeldAmmo(null);

    if (newTerrain) {
      this.seed = Math.floor(this.rng() * 1_000_000) + 1;
      this.rng = createSeededRandom(this.seed);
      this.decorRng = createSeededRandom(this.seed ^ 0x9e3779b9);
      this.rebuildWorld();
    }

    // Character detail follows the render tier, and must be set before any
    // model is built.
    setModelQuality(this.pipeline.qualityTier === 'mobile' ? 'low' : 'high');

    // Rebuild the cast: animal choices can change between matches.
    for (const fighter of this.fighters) {
      this.worldRoot.remove(fighter.group);
      fighter.dispose();
    }
    this.fighters.length = 0;
    this.aiSources.clear();

    this.players.forEach((player, index) => {
      const animal = getAnimal(player.animalId) ?? ANIMALS[index % ANIMALS.length];
      const fighter = new Fighter(index, animal, player.controller, this.materials, this.terrain);
      for (const ammo of AMMO) fighter.ammo.set(ammo.id, ammo.rounds);
      this.fighters.push(fighter);
      this.worldRoot.add(fighter.group);
      if (player.controller === 'ai') {
        this.aiSources.set(index, new AiPowerSource(player.aiSkill));
      }
    });

    const spawns = this.terrain.findSpawnPoints(this.fighters.length, () => this.rng());
    this.fighters.forEach((fighter, index) => {
      fighter.resetForMatch();
      fighter.placeAt(spawns[index], 0.6);
      const opponent = spawns[(index + 1) % spawns.length];
      fighter.faceTowards(opponent);
      // Scenery is scattered before spawns are picked, so clear a stance.
      this.props.clearAround(spawns[index], 3.4, 7.5);
    });

    this.round = 1;
    this.turnIndex = 0;
    this.turnOrder = this.fighters.map((fighter) => fighter.slot);
    this.rollWind();
    this.hud.buildRoster(this.buildRosterEntries());
    this.hud.setRound(this.round, MATCH.maxRounds);
    this.hud.setTouchVisible(this.isTouchDevice());

    this.projectiles.clear();
    this.vfx.clear();
    this.shake.reset();

    this.setPhase('intro');
    // Publish now: a caller that starts a match and immediately reads the phase
    // would otherwise see the previous match's last frame.
    this.publishDiagnostics();
    this.setCamera('overview');
    this.cameraRig.frame(0, 12, CAMERA.overviewWidth);
    this.cameraRig.snap();
    this.hud.showBanner('Round 1 — Fight!', 'big', 1800);
  }

  private rollWind(): void {
    this.wind = this.windEnabled ? (this.rng() * 2 - 1) * PHYSICS.maxWind : 0;
    this.projectiles.wind = this.wind;
    this.hud.setWind(this.wind, PHYSICS.maxWind);
  }

  private buildRosterEntries(): RosterEntry[] {
    return this.fighters.map((fighter) => ({
      slot: fighter.slot,
      animal: fighter.animal,
      name: fighter.animal.name,
      controller: fighter.controller,
      health: fighter.health,
      maxHealth: MATCH.maxHealth,
      damageDealt: fighter.stats.damageDealt,
      accuracy:
        fighter.stats.shotsFired > 0 ? fighter.stats.accuracySum / fighter.stats.shotsFired : 0,
      alive: fighter.alive,
      active: this.turn?.slot === fighter.slot,
    }));
  }

  private get activeFighter(): Fighter | null {
    if (!this.turn) return null;
    return this.fighters[this.turn.slot] ?? null;
  }

  private setPhase(phase: PhaseName): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  private setCamera(mode: CameraMode): void {
    this.cameraMode = mode;
  }

  // ---------------------------------------------------------------- turns

  private beginTurn(): void {
    const living = this.fighters.filter((fighter) => fighter.alive);
    if (living.length <= 1 || this.round > MATCH.maxRounds) {
      this.endMatch();
      return;
    }

    // Advance to the next living fighter, wrapping the round when we pass the end.
    let guard = 0;
    while (guard < this.fighters.length * 2 + 2) {
      guard += 1;
      if (this.turnIndex >= this.turnOrder.length) {
        this.turnIndex = 0;
        this.round += 1;
        this.rollWind();
        this.hud.setRound(this.round, MATCH.maxRounds);
        if (this.round > MATCH.maxRounds) {
          this.endMatch();
          return;
        }
        this.hud.showBanner('Round ' + this.round, 'big', 1400);
      }
      const slot = this.turnOrder[this.turnIndex];
      this.turnIndex += 1;
      const candidate = this.fighters[slot];
      if (candidate?.alive) {
        this.openTurnFor(candidate);
        return;
      }
    }
    this.endMatch();
  }

  private openTurnFor(fighter: Fighter): void {
    // Comeback assist: the fighter furthest behind gets a slightly wider zone.
    const healths = this.fighters.filter((f) => f.alive).map((f) => f.health);
    const best = Math.max(...healths);
    const trailing = best - fighter.health > MATCH.maxHealth * 0.35;
    const comeback = trailing ? MATCH.comebackZoneBonus : 0;

    const plan = planInterval(this.round, fighter.animal.perk, comeback);
    const source: PowerSource =
      fighter.controller === 'ai'
        ? this.aiSources.get(fighter.slot) ?? new AiPowerSource(AI.defaultSkill)
        : this.spacebarSource;

    // Pick the last usable ammo choice, defaulting to rocks.
    const preferred = this.turn?.slot === fighter.slot ? this.turn.ammoId : 'rock';
    const ammoId = this.hasAmmo(fighter, preferred) ? preferred : 'rock';

    this.turn = {
      slot: fighter.slot,
      plan,
      source,
      ammoId,
      targetSlot: -1,
      solution: null,
      displayWatts: 0,
      wasInZone: false,
      aiThinkTime: 0,
    };

    for (const other of this.fighters) other.setActive(other.slot === fighter.slot);

    if (fighter.controller === 'ai') {
      this.planAiTurn(fighter);
    } else {
      // Open on the nearest opponent: a sane default and the most likely pick,
      // so a player who just wants to shoot can go straight to the interval.
      const nearest = this.nearestOpponent(fighter);
      this.selectTarget(nearest ? nearest.slot : -1, true);
      this.hud.setAmmo(fighter.ammo, ammoId);
      this.hud.setAmmoBlurb(getAmmo(ammoId));
    }

    fighter.setHeldAmmo(this.projectiles.createDisplayModel(getAmmo(this.turn.ammoId)));

    this.hud.updateRoster(this.buildRosterEntries());
    this.hud.showAimDock(fighter.controller === 'human');
    this.hud.showIntervalDock(false);
    this.hud.setTouchActionLabel('FIRE');
    this.aimGuide.setVisible(true);
    this.setCamera('focus');
    this.setPhase('aim');
    this.targetCycle = 0;

    const who = fighter.controller === 'ai' ? fighter.animal.name + ' (AI)' : fighter.animal.name;
    this.hud.showBanner(who + "'s turn", 'neutral', 1200);
  }

  private hasAmmo(fighter: Fighter, ammoId: string): boolean {
    const remaining = fighter.ammo.get(ammoId) ?? 0;
    return remaining < 0 || remaining > 0;
  }

  private nearestOpponent(fighter: Fighter): Fighter | null {
    let best: Fighter | null = null;
    let bestDistance = Infinity;
    for (const other of this.fighters) {
      if (other === fighter || !other.alive) continue;
      const distance = Math.abs(other.position.x - fighter.position.x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    return best;
  }

  private selectAmmo(ammoId: string): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter || this.phase !== 'aim' || fighter.controller !== 'human') return;
    if (!this.hasAmmo(fighter, ammoId)) return;
    this.turn.ammoId = ammoId;
    this.hud.setAmmo(fighter.ammo, ammoId);
    this.hud.setAmmoBlurb(getAmmo(ammoId));
    fighter.setHeldAmmo(this.projectiles.createDisplayModel(getAmmo(ammoId)));
    // Heavier ammo flies shorter, so the line has to be re-solved.
    this.selectTarget(this.turn.targetSlot, true);
    this.audio.uiClick();
  }

  /** Living opponents of the active fighter, in left-to-right screen order. */
  private selectableTargets(fighter: Fighter): Fighter[] {
    return this.fighters
      .filter((other) => other !== fighter && other.alive)
      .sort((a, b) => a.position.x - b.position.x);
  }

  /**
   * Solve the throw at a chosen target.
   *
   * This is the whole of aiming. The angle that puts a perfect shot on the
   * target is found by sweeping the same integrator the projectile uses, so
   * terrain and wind are already accounted for. What the player controls is
   * WHO to shoot and WHAT to throw — and then whether their interval actually
   * delivers the launch speed the solution assumed.
   */
  private solveTarget(fighter: Fighter, target: Fighter, ammoId: string): TargetSolution {
    fighter.faceTowards(target.position.x);
    fighter.getHandPosition(this.tmpVec);
    target.getCenter(this.tmpVec2);

    const speed = this.perfectSpeed(fighter, ammoId);
    const wind = this.wind * fighter.animal.perk.wind;
    const solved = findBestAngle(
      this.terrain,
      this.tmpVec,
      fighter.facing,
      speed,
      wind,
      this.tmpVec2.x,
      this.tmpVec2.y,
    );
    const angle = THREE.MathUtils.clamp(solved.angle, AIM.minAngle, AIM.maxAngle);

    // Re-run the winning angle to find where the shot actually ends up: the
    // sweep minimises error, which is not the same as reaching the target. A
    // ridge in the way or a target out of range shows up right here.
    const shot = simulateShot(this.terrain, this.tmpVec, angle, fighter.facing, speed, wind);
    const missDistance = Math.abs(shot.x - this.tmpVec2.x);
    const radius = getAmmo(ammoId).radius * fighter.animal.perk.blast;

    let quality: LineQuality = 'blocked';
    if (missDistance <= AIM.cleanLineUnits) quality = 'clear';
    else if (missDistance <= radius * AIM.blockedBeyondRadiusFactor) quality = 'splash';

    return {
      slot: target.slot,
      angle,
      landingX: shot.x,
      landingY: shot.y,
      missDistance,
      quality,
      distance: Math.abs(target.position.x - fighter.position.x),
    };
  }

  /** Point the active fighter at a slot and refresh everything downstream. */
  private selectTarget(slot: number, silent = false): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter) return;
    const target = this.fighters[slot];
    if (!target || !target.alive || target === fighter) return;

    this.turn.targetSlot = slot;
    this.turn.solution = this.solveTarget(fighter, target, this.turn.ammoId);
    fighter.aimAngle = this.turn.solution.angle;

    for (const other of this.fighters) other.setTargeted(other.slot === slot);
    this.refreshAimGuide(fighter);
    if (fighter.controller === 'human') {
      this.hud.setTargets(this.buildTargetCards(fighter), slot);
    }
    if (!silent) this.audio.uiClick();
  }

  /** Step to the next living opponent in screen order. */
  private cycleTarget(direction: 1 | -1): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter || this.phase !== 'aim' || fighter.controller !== 'human') return;
    const options = this.selectableTargets(fighter);
    if (options.length < 2) return;
    const current = options.findIndex((other) => other.slot === this.turn?.targetSlot);
    const next = (current + direction + options.length) % options.length;
    this.selectTarget(options[next].slot);
  }

  private buildTargetCards(fighter: Fighter): TargetCard[] {
    const chosen = this.turn?.targetSlot ?? -1;
    return this.selectableTargets(fighter).map((target) => {
      const solution =
        this.turn && chosen === target.slot && this.turn.solution
          ? this.turn.solution
          : this.solveTarget(fighter, target, this.turn?.ammoId ?? 'rock');
      return {
        slot: target.slot,
        animal: target.animal,
        health: target.health,
        maxHealth: MATCH.maxHealth,
        distance: solution.distance,
        angle: solution.angle,
        quality: solution.quality,
      };
    });
  }

  /** Launch speed a perfect interval would produce for this fighter and ammo. */
  private perfectSpeed(fighter: Fighter, ammoId: string): number {
    return PHYSICS.baseLaunchSpeed * getAmmo(ammoId).launch * fighter.animal.perk.launch;
  }

  private planAiTurn(fighter: Fighter): void {
    const target = this.pickAiTarget(fighter);
    if (!target) return;

    // Occasionally spend a special, and prefer the melon at short range where
    // its poor range is not a handicap.
    const distance = Math.abs(target.position.x - fighter.position.x);
    let ammoId = 'rock';
    if (this.rng() < 0.42) {
      const options = AMMO.filter((ammo) => ammo.id !== 'rock' && this.hasAmmo(fighter, ammo.id));
      const viable = options.filter((ammo) => (ammo.id === 'melon' ? distance < 34 : true));
      if (viable.length > 0) ammoId = viable[Math.floor(this.rng() * viable.length)].id;
    }
    if (this.turn) this.turn.ammoId = ammoId;
    fighter.setHeldAmmo(this.projectiles.createDisplayModel(getAmmo(ammoId)));

    // Bots run the same solver the player's target picker uses, then add a
    // skill-scaled error so a weak bot lines up slightly wrong.
    const solution = this.solveTarget(fighter, target, ammoId);
    const skill = this.players[fighter.slot]?.aiSkill ?? AI.defaultSkill;
    const error = (this.rng() * 2 - 1) * AI.maxAimErrorDegrees * (1 - skill);

    if (this.turn) {
      this.turn.targetSlot = target.slot;
      this.turn.solution = solution;
    }
    fighter.aimAngle = THREE.MathUtils.clamp(solution.angle + error, AIM.minAngle, AIM.maxAngle);
    for (const other of this.fighters) other.setTargeted(other.slot === target.slot);
    this.refreshAimGuide(fighter);
  }

  /**
   * Bots go for the fighter they can most plausibly reach, weighted by
   * weakness. Anything past the ballistic range is skipped outright: a bot that
   * spends its turn lobbing rocks at someone it physically cannot hit is not
   * playing badly, it is not playing at all.
   */
  private pickAiTarget(fighter: Fighter): Fighter | null {
    const speed = this.perfectSpeed(fighter, 'rock');
    const maxRange = (speed * speed) / PHYSICS.gravity;
    let best: Fighter | null = null;
    let bestScore = -Infinity;
    let nearest: Fighter | null = null;
    let nearestDistance = Infinity;

    for (const other of this.fighters) {
      if (other === fighter || !other.alive) continue;
      const distance = Math.abs(other.position.x - fighter.position.x);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = other;
      }
      if (distance > maxRange * 0.95) continue;
      const score = (MATCH.maxHealth - other.health) * 0.5 - distance * 1.4 + this.rng() * 10;
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
    // Everyone out of range: take a shot at the closest anyway rather than
    // stalling the turn.
    return best ?? nearest;
  }

  private lockAim(): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter || this.phase !== 'aim') return;
    // Nothing to shoot at means nothing to lock in.
    if (this.turn.targetSlot < 0) return;
    this.hud.showAimDock(false);
    this.aimGuide.setVisible(true);
    this.setPhase('ready');
    this.audio.uiConfirm();
  }

  private beginInterval(): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter) return;

    this.scorer.reset(this.turn.plan);
    this.turn.source.begin({
      targetWatts: this.turn.plan.targetWatts,
      durationSeconds: this.turn.plan.durationSeconds,
      random: () => this.rng(),
    });
    this.turn.displayWatts = 0;
    this.turn.wasInZone = false;

    this.hud.setCountdown(null);
    this.hud.primeMeter(this.turn.plan);
    this.hud.showIntervalDock(true);
    this.hud.setTouchActionLabel('TAP!');
    this.aimGuide.setVisible(true);
    this.setPhase('interval');
  }

  private registerTap(): void {
    if (this.phase !== 'interval' || !this.turn) return;
    const fighter = this.activeFighter;
    if (!fighter || fighter.controller !== 'human') return;
    if (this.spacebarSource.tap(performance.now())) {
      this.audio.tap(Math.min(1, this.spacebarSource.watts / Math.max(1, this.turn.plan.targetWatts)));
    }
  }

  private finishInterval(): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter) return;

    this.turn.source.end();
    const result = this.scorer.finish();
    const outcome = resolveShot(result, fighter.animal.perk, () => this.rng());
    const ammo = getAmmo(this.turn.ammoId);

    fighter.stats.shotsFired += 1;
    fighter.stats.accuracySum += result.accuracy;
    fighter.stats.bestAccuracy = Math.max(fighter.stats.bestAccuracy, result.accuracy);
    fighter.stats.secondsInZone += result.secondsInZone;
    if (result.perfect) fighter.stats.perfects += 1;

    const remaining = fighter.ammo.get(ammo.id) ?? 0;
    if (remaining > 0) fighter.ammo.set(ammo.id, remaining - 1);

    // Stash the numbers the shot resolves with; the throw animation reads them
    // when the hand reaches the release point.
    this.pendingShot = {
      origin: fighter.getHandPosition(new THREE.Vector3()).clone(),
      speed: this.perfectSpeed(fighter, ammo.id) * outcome.speedMultiplier,
      angle: THREE.MathUtils.clamp(fighter.aimAngle + outcome.wobbleDegrees, 1, 89),
      damage: ammo.damage * outcome.damageMultiplier,
      radius: ammo.radius * fighter.animal.perk.blast,
      ammoId: ammo.id,
      ownerSlot: fighter.slot,
    };

    this.hud.showIntervalDock(false);
    this.aimGuide.setVisible(false);

    const percent = Math.round(result.accuracy * 100);
    if (result.perfect) {
      this.hud.showBanner('PERFECT — ' + percent + '%', 'big', 1600);
      this.audio.perfect();
      fighter.getCenter(this.tmpVec);
      this.vfx.sparkle(this.tmpVec, 18);
    } else if (result.accuracy > 0.75) {
      this.hud.showBanner('Strong hold — ' + percent + '%', 'good', 1300);
    } else {
      const over = result.averageRatio > 1;
      this.hud.showBanner(
        (over ? 'Over target' : 'Under target') + ' — ' + percent + '%',
        'neutral',
        1300,
      );
    }
    this.lastShotSummary =
      fighter.animal.name +
      ': ' +
      percent +
      '% acc, ' +
      Math.round(result.averageWatts) +
      'W avg vs ' +
      this.turn.plan.targetWatts +
      'W';

    fighter.startThrow();
    this.audio.throwWhoosh();
    this.setPhase('flight');
    this.setCamera('focus');
  }

  private pendingShot: {
    /** Hand position at lock-in, so the shot matches the arc the player saw. */
    origin: THREE.Vector3;
    speed: number;
    angle: number;
    damage: number;
    radius: number;
    ammoId: string;
    ownerSlot: number;
  } | null = null;

  private releaseShot(): void {
    const fighter = this.activeFighter;
    if (!this.pendingShot || !fighter) return;
    const shot = this.pendingShot;
    this.pendingShot = null;
    fighter.setHeldAmmo(null);

    this.projectiles.launch({
      ammo: getAmmo(shot.ammoId),
      ownerSlot: shot.ownerSlot,
      origin: shot.origin,
      speed: shot.speed,
      angleDegrees: shot.angle,
      facing: fighter.facing,
      damage: shot.damage,
      radius: shot.radius,
      windScale: fighter.animal.perk.wind,
    });
    this.shake.add(VFX.trauma.launch);
    this.vfx.dust(fighter.position, 0.6);
    this.setCamera('flight');
  }

  // -------------------------------------------------------------- damage

  private applyDetonation(detonation: Detonation): void {
    const attacker = this.fighters[detonation.ownerSlot];

    if (detonation.inWater) {
      this.vfx.splash(detonation.position, Math.max(0.8, detonation.radius / 5));
      this.audio.splash();
      this.shake.add(VFX.trauma.impact * 0.5);
      return;
    }

    this.lastImpact = detonation.position;
    this.terrain.carve(detonation.position.x, detonation.position.y, detonation.radius * 0.82);
    this.props.onTerrainChanged();
    this.vfx.explosion(detonation.position, detonation.radius, detonation.ammo.accent);
    this.audio.explosion(detonation.radius / 5);
    this.shake.add(detonation.radius > 6 ? VFX.trauma.bigImpact : VFX.trauma.impact);
    this.hitstop(VFX.hitstopMs.hit);
    this.setCamera('impact');

    let anyHit = false;
    for (const fighter of this.fighters) {
      if (!fighter.alive) continue;
      fighter.getCenter(this.tmpVec);
      const dx = this.tmpVec.x - detonation.position.x;
      const dy = this.tmpVec.y - detonation.position.y;
      const distance = Math.hypot(dx, dy);
      if (distance > detonation.radius) continue;

      // Linear falloff, with a floor so a graze still stings.
      const falloff = Math.max(0.28, 1 - distance / detonation.radius);
      const direct = detonation.directHitSlot === fighter.slot;
      const damage = detonation.damage * falloff * (direct ? 1.18 : 1);
      const applied = fighter.takeDamage(damage);
      if (applied <= 0) continue;
      anyHit = true;

      // Knockback away from the blast, always with some lift so it reads.
      const push = (1 - distance / detonation.radius) * 13;
      const nx = distance > 0.01 ? dx / distance : 0;
      fighter.applyImpulse(nx * push, Math.abs(push) * 0.65 + 3);

      if (attacker && attacker !== fighter) attacker.stats.damageDealt += applied;
      if (attacker && attacker !== fighter) attacker.stats.hits += 1;

      fighter.getCenter(this.tmpVec);
      this.hud.floater(
        this.tmpVec,
        this.cameraRig.camera,
        '-' + Math.round(applied),
        direct ? 'crit' : 'normal',
      );
      this.audio.hit();

      if (!fighter.alive) this.eliminate(fighter);
    }

    if (!anyHit) {
      this.hud.floater(detonation.position, this.cameraRig.camera, 'miss', 'miss');
    }
  }

  private eliminate(fighter: Fighter): void {
    fighter.getCenter(this.tmpVec);
    this.vfx.confetti(this.tmpVec);
    this.shake.add(VFX.trauma.elimination);
    this.hitstop(VFX.hitstopMs.elimination);
    this.audio.eliminate();
    this.hud.showBanner(fighter.animal.name + ' is out!', 'big', 1800);
  }

  private hitstop(durationMs: number): void {
    this.hitstopRemaining = Math.max(this.hitstopRemaining, durationMs / 1000);
    this.timeScale = 0.06;
    this.audio.setDuck(0.55);
  }

  private endMatch(): void {
    this.turn = null;
    for (const fighter of this.fighters) fighter.setActive(false);
    this.setPhase('results');
    this.hud.showAimDock(false);
    this.hud.showIntervalDock(false);
    this.hud.setCountdown(null);
    this.aimGuide.setVisible(false);
    this.setCamera('overview');

    const living = this.fighters.filter((fighter) => fighter.alive);
    let winner: Fighter | null = null;
    let reason = 'Last one standing';
    if (living.length === 1) {
      winner = living[0];
    } else if (living.length === 0) {
      reason = 'Everybody went down';
    } else {
      reason = 'Time limit — most damage dealt wins';
      winner = living.reduce((best, fighter) =>
        fighter.stats.damageDealt > best.stats.damageDealt ? fighter : best,
      );
    }

    const rows: ResultRow[] = this.fighters.map((fighter) => ({
      slot: fighter.slot,
      animalId: fighter.animal.id,
      name: fighter.animal.name,
      controller: fighter.controller,
      health: fighter.health,
      stats: fighter.stats,
      winner: winner?.slot === fighter.slot,
    }));

    this.resultsScreen.show(rows, reason);
    this.resultsScreen.setVisible(true);
    this.audio.victory();
  }

  // --------------------------------------------------------------- input

  private isTouchDevice(): boolean {
    return window.matchMedia?.('(pointer: coarse)').matches ?? false;
  }

  private installInput(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
  }

  private readonly onBlur = () => {
    this.keys.clear();
    this.targetCycle = 0;
  };

  private readonly onResize = () => {
    this.resize();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    // Space and the arrows scroll the page by default; the game owns them.
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.code)) {
      event.preventDefault();
    }
    this.audio.unlock();

    if (event.repeat) {
      // Auto-repeat must never count as tapping: holding space would be a cheat.
      if (event.code !== 'Space') this.keys.add(event.code);
      return;
    }
    this.keys.add(event.code);

    switch (event.code) {
      case 'Space':
        if (this.phase === 'interval') this.registerTap();
        else if (this.phase === 'aim') this.lockAim();
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (this.phase === 'aim') this.lockAim();
        else if (this.phase === 'results') this.startMatch(true);
        break;
      case 'Escape':
        if (this.phase !== 'setup' && this.phase !== 'results') this.setPaused(!this.paused);
        break;
      case 'Tab':
        this.cycleTarget(event.shiftKey ? -1 : 1);
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this.cycleTarget(-1);
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.cycleTarget(1);
        break;
      case 'KeyR':
        if (this.phase === 'results') this.startMatch(true);
        break;
      case 'KeyM':
        this.audio.setMuted(!this.audio.isMuted);
        this.hud.setSoundMuted(this.audio.isMuted);
        break;
      default:
        if (/^Digit[1-5]$/.test(event.code)) {
          const index = Number(event.code.slice(5)) - 1;
          const ammo = AMMO[index];
          if (ammo) this.selectAmmo(ammo.id);
        }
        break;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private setPaused(paused: boolean): void {
    if (this.phase === 'setup' || this.phase === 'results') return;
    this.paused = paused;
    this.pauseScreen.setVisible(paused);
    this.keys.clear();
  }

  private resize(): void {
    if (this.pipeline.resize()) {
      const canvas = this.pipeline.renderer.domElement;
      this.cameraRig.setAspect(Math.max(0.4, canvas.clientWidth / Math.max(1, canvas.clientHeight)));
    }
  }

  // --------------------------------------------------------------- update

  private update(delta: number, elapsed: number): void {
    this.frame += 1;
    this.elapsed = elapsed;
    this.resize();

    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }

    // Hitstop scales gameplay time only. Camera, shake, tweens and the HUD keep
    // the real delta so the frozen moment still animates.
    if (this.hitstopRemaining > 0) {
      this.hitstopRemaining -= delta;
      if (this.hitstopRemaining <= 0) {
        this.timeScale = 1;
        this.audio.setDuck(1);
      }
    }

    const paused = this.paused || this.phase === 'setup' || this.phase === 'results';
    const gameplayDelta = paused ? 0 : delta * this.timeScale;
    if (!paused) {
      this.gameElapsed += this.reducedMotion ? 0 : gameplayDelta;
      this.phaseTime += gameplayDelta;
    }

    if (!paused) {
      this.updatePhase(gameplayDelta);
    }

    for (const fighter of this.fighters) {
      const result = fighter.update(gameplayDelta, this.gameElapsed);
      if (result.landed) {
        this.vfx.dust(fighter.position, 1);
        if (result.fallDamage > 0) {
          const applied = fighter.takeDamage(result.fallDamage);
          if (applied > 0) {
            fighter.getCenter(this.tmpVec);
            this.hud.floater(this.tmpVec, this.cameraRig.camera, '-' + Math.round(applied));
            this.audio.hit();
            if (!fighter.alive) this.eliminate(fighter);
          }
        }
      }
      if (result.drowned && fighter.alive) {
        fighter.takeDamage(MATCH.maxHealth);
        this.vfx.splash(fighter.position, 1.2);
        this.audio.splash();
        this.eliminate(fighter);
      }
      fighter.faceCamera(this.cameraRig.camera.quaternion);
    }

    if (!paused) {
      const projectileResult = this.projectiles.update(gameplayDelta, this.gameElapsed, this.fighters);
      for (const detonation of projectileResult.detonations) {
        this.applyDetonation(detonation);
      }
      if (projectileResult.swarmSting) {
        const victim = this.fighters[projectileResult.swarmSting.slot];
        if (victim?.alive) {
          const applied = victim.takeDamage(projectileResult.swarmSting.damage);
          victim.getCenter(this.tmpVec);
          this.hud.floater(this.tmpVec, this.cameraRig.camera, '-' + Math.round(applied));
          if (!victim.alive) this.eliminate(victim);
        }
      }
      this.terrain.flush();
    }

    this.props.update(this.reducedMotion ? 0 : this.gameElapsed);
    this.environment.update(
      this.reducedMotion ? 0 : delta,
      this.reducedMotion ? 0 : this.gameElapsed,
      this.cameraRig.centerX,
    );
    this.vfx.update(delta, this.cameraRig.camera);
    this.showroom.update(delta, elapsed);
    this.tweens.update(delta);

    this.updateCamera(delta);
    this.shake.update(delta, this.cameraRig.camera);
    this.lighting.followCamera(this.cameraRig.centerX);
    this.aimGuide.animate(this.elapsed);

    this.hud.updateRoster(this.buildRosterEntries());
    this.publishDiagnostics();
  }

  private updatePhase(delta: number): void {
    const fighter = this.activeFighter;

    switch (this.phase) {
      case 'intro':
        if (this.phaseTime > 1.7) this.beginTurn();
        break;

      case 'aim': {
        if (!fighter) break;
        if (fighter.controller === 'human') {
          this.updateTargetRepeat(delta);
        } else if (this.turn) {
          // A short pause before a bot commits, so the player can read which
          // fighter it has lined up before the shot leaves.
          this.turn.aiThinkTime += delta;
          if (this.turn.aiThinkTime > AI.aimSeconds) this.lockAim();
        }
        // The solved arc only moves when a fighter is still falling into place
        // after a crater, so re-solving every frame is not needed — but it is
        // cheap and it keeps the guide honest while the world settles.
        if (this.turn?.targetSlot !== undefined && this.phase === 'aim') {
          this.refreshAimGuide(fighter);
        }
        break;
      }

      case 'ready': {
        const remaining = INTERVAL.readySeconds - this.phaseTime;
        if (remaining > 0) {
          const value = Math.ceil(remaining);
          const label = value <= 0 ? 'GO' : String(value);
          const previous = this.countdownShown;
          this.hud.setCountdown(label);
          if (label !== previous) {
            this.countdownShown = label;
            this.audio.countdownTick(value <= 1);
          }
        } else {
          this.countdownShown = '';
          this.hud.setCountdown('GO');
          this.beginInterval();
        }
        if (fighter) this.refreshAimGuide(fighter);
        break;
      }

      case 'interval':
        this.updateInterval(delta);
        break;

      case 'flight': {
        if (fighter?.consumeRelease()) this.releaseShot();
        // The turn ends once nothing is moving and everyone has settled.
        const settled =
          this.projectiles.liveCount === 0 &&
          !this.pendingShot &&
          this.phaseTime > 1.1 &&
          !this.fighters.some((f) => f.isThrowing);
        if (settled) {
          this.setPhase('resolve');
        }
        break;
      }

      case 'resolve':
        if (this.phaseTime > 1.15) {
          this.hud.setCountdown(null);
          this.beginTurn();
        }
        break;

      default:
        break;
    }
  }

  private countdownShown = '';

  /**
   * Held touch buttons repeat the target step.
   *
   * Keyboard target changes are discrete keydowns; the touch buttons are
   * press-and-hold, so they need their own repeat so a thumb can walk along a
   * four-fighter line-up without lifting.
   */
  private updateTargetRepeat(delta: number): void {
    if (this.targetCycle === 0) {
      this.targetRepeatTimer = 0;
      return;
    }
    this.targetRepeatTimer += delta;
    if (this.targetRepeatTimer >= 0.45) {
      this.targetRepeatTimer = 0.3;
      this.cycleTarget(this.targetCycle);
    }
  }

  private refreshAimGuide(fighter: Fighter | null): void {
    if (!fighter || !this.turn) return;
    fighter.getHandPosition(this.tmpVec);
    this.aimGuide.update({
      origin: this.tmpVec,
      angleDegrees: fighter.aimAngle,
      facing: fighter.facing,
      speed: this.perfectSpeed(fighter, this.turn.ammoId),
      wind: this.wind * fighter.animal.perk.wind,
      tint: fighter.animal.palette.accent,
    });
  }

  private updateInterval(delta: number): void {
    const fighter = this.activeFighter;
    if (!this.turn || !fighter) return;

    this.turn.source.update(delta);
    const watts = this.turn.source.watts;
    this.scorer.sample(watts, delta);

    // Display smoothing keeps the needle readable without softening the score.
    const blend = 1 - Math.exp(-delta / POWER.displayTau);
    this.turn.displayWatts += (watts - this.turn.displayWatts) * blend;

    const target = this.scorer.currentTarget;
    const plan = this.scorer.currentPlan;
    const ratio = target > 0 ? watts / target : 0;
    const inZone = Math.abs(ratio - 1) <= plan.zone;
    const zoneState: 'low' | 'in' | 'high' = inZone ? 'in' : ratio < 1 ? 'low' : 'high';

    if (inZone !== this.turn.wasInZone && !this.scorer.inGrace) {
      this.turn.wasInZone = inZone;
      if (inZone) this.audio.enterZone();
      else this.audio.leaveZone();
    }

    // Aura particles read the hold from across the arena, so a spectating
    // player can see how the active fighter is doing without the HUD.
    if (this.frame % 2 === 0) {
      const strength = Math.min(1.4, ratio);
      this.vfx.charge(fighter.position, strength, inZone);
    }

    this.hud.updateMeter({
      watts,
      displayWatts: this.turn.displayWatts,
      target,
      zone: plan.zone,
      meterMax: plan.targetWatts * POWER.meterHeadroom,
      remaining: this.scorer.remainingSeconds,
      progress: this.scorer.elapsedSeconds / plan.durationSeconds,
      accuracy: this.scorer.liveAccuracy,
      cadence: fighter.controller === 'human' ? this.spacebarSource.tapsPerSecond : 0,
      zoneState,
      grace: this.scorer.inGrace,
    });

    if (plan.surgeWatts !== null && this.scorer.elapsedSeconds >= plan.surgeAtSeconds) {
      this.hud.setCountdown(null);
    }

    if (this.scorer.finished) this.finishInterval();
  }

  /** Set by the inspection state; suppresses the normal framing rules. */
  private cameraOverride: { x: number; y: number; width: number } | null = null;

  private updateCamera(delta: number): void {
    if (this.cameraOverride) {
      this.cameraRig.frame(this.cameraOverride.x, this.cameraOverride.y, this.cameraOverride.width);
      this.cameraRig.update(delta);
      return;
    }
    const fighter = this.activeFighter;
    let width = this.cameraRig.widthFor(this.cameraMode);
    let x = 0;
    let y = 12;

    switch (this.cameraMode) {
      case 'focus':
        if (fighter) {
          const target =
            this.turn && this.turn.targetSlot >= 0 ? this.fighters[this.turn.targetSlot] : null;

          const framingChoice = target && target.alive && (this.phase === 'aim' || this.phase === 'ready');

          if (framingChoice && target) {
            /*
             * Frame the whole engagement: shooter on one side, target on the
             * other. Choosing WHO to shoot is the only spatial decision left,
             * so both ends of that decision have to be on screen — a camera
             * pinned to the shooter would hide the thing being chosen.
             */
            const span = Math.abs(target.position.x - fighter.position.x);
            const wanted = THREE.MathUtils.clamp(
              span + CAMERA.engagementMargin,
              CAMERA.focusWidth,
              CAMERA.overviewWidth,
            );

            if (this.cameraRig.visibleWidthAt(wanted) >= span + CAMERA.engagementMargin * 0.4) {
              width = wanted;
              x = (fighter.position.x + target.position.x) / 2;
              y = Math.max(fighter.position.y, target.position.y) + width * 0.1;
            } else {
              /*
               * Portrait cannot hold the pair. Rather than centre on a midpoint
               * where neither fighter is visible, sit on the shooter and lean
               * hard toward the target so the direction of fire still reads;
               * the target card carries the range and the line state.
               */
              width = CAMERA.focusWidth;
              const lead = Math.sign(target.position.x - fighter.position.x);
              x = fighter.position.x + lead * this.cameraRig.visibleWidthAt(width) * 0.28;
              y = fighter.position.y + 2.4;
            }
          } else {
            // No target yet, or the interval is running: sit on the shooter.
            x = fighter.position.x + fighter.facing * width * 0.18;
            // Only a small lift: the bottom third of the frame belongs to the
            // dock, and the fighter must stay clear of it.
            y = fighter.position.y + 2.4;
          }
        }
        break;
      case 'flight': {
        const tracked = this.trackedProjectile();
        if (tracked) {
          x = tracked.x;
          y = tracked.y;
        } else if (fighter) {
          x = fighter.position.x;
          y = fighter.position.y + 2.4;
        }
        break;
      }
      case 'impact':
        if (this.lastImpact) {
          x = this.lastImpact.x;
          y = this.lastImpact.y + 2;
        }
        break;
      case 'overview':
      default:
        x = 0;
        y = 12;
        width = CAMERA.overviewWidth;
        break;
    }

    this.cameraRig.frame(x, y, width);
    this.cameraRig.update(delta);
  }

  private lastImpact: THREE.Vector3 | null = null;

  private trackedProjectile(): THREE.Vector3 | null {
    // The projectiles group holds one child per pooled model; follow the first
    // visible one, which is the shot in flight.
    for (const child of this.projectiles.group.children) {
      if (child.visible && child.name.startsWith('ammo-')) return child.position;
    }
    for (const child of this.projectiles.group.children) {
      if (child.visible && child.name === 'fragment') return child.position;
    }
    return null;
  }

  private render(): void {
    this.pipeline.setCamera(this.cameraRig.camera);
    this.pipeline.render();
  }

  // ---------------------------------------------------------- diagnostics

  private publishDiagnostics(): void {
    const diagnostics = this.pipeline.diagnostics;
    const propDiagnostics = this.props.diagnostics;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.gameElapsed,
      phase: this.phase,
      round: this.round,
      score: Math.round(this.fighters.reduce((sum, f) => sum + f.stats.damageDealt, 0)),
      targetScore: MATCH.maxHealth * Math.max(1, this.fighters.length - 1),
      complete: this.phase === 'results',
      wind: Number(this.wind.toFixed(2)),
      activeSlot: this.turn?.slot ?? -1,
      lastShot: this.lastShotSummary,
      fighters: this.fighters.map((fighter) => ({
        slot: fighter.slot,
        animal: fighter.animal.id,
        health: Math.round(fighter.health),
        alive: fighter.alive,
        x: Number(fighter.position.x.toFixed(2)),
        y: Number(fighter.position.y.toFixed(2)),
        damageDealt: Math.round(fighter.stats.damageDealt),
        shots: fighter.stats.shotsFired,
        accuracy:
          fighter.stats.shotsFired > 0
            ? Number((fighter.stats.accuracySum / fighter.stats.shotsFired).toFixed(3))
            : 0,
        secondsInZone: Number(fighter.stats.secondsInZone.toFixed(1)),
      })),
      player: {
        position: {
          x: this.fighters[0]?.position.x ?? 0,
          y: this.fighters[0]?.position.y ?? 0,
          z: this.fighters[0]?.position.z ?? 0,
        },
        speed: 0,
      },
      world: {
        terrainTriangles: this.terrain.triangleCount,
        propBatches: propDiagnostics.batches,
        instancedMeshes: propDiagnostics.instancedMeshes,
        props: propDiagnostics.props,
        propDensity: propDiagnostics.density,
        propShadows: propDiagnostics.castShadows,
        proceduralTextures: proceduralTextureCount(),
        materials: this.materials.materialCount,
        particles: this.vfx.activeParticles,
        projectiles: this.projectiles.liveCount,
        // Occlusion is baked per fighter at match start. It is the one piece
        // of build work heavy enough to be felt, so it reports its own cost
        // rather than leaving a slow start to be guessed at.
        occlusionBake: this.fighters.map((fighter) => ({
          animal: fighter.animal.id,
          ms: fighter.model.diagnostics.occlusion.ms,
          samples: fighter.model.diagnostics.occlusion.samples,
          min: fighter.model.diagnostics.occlusion.min,
          mean: fighter.model.diagnostics.occlusion.mean,
        })),
      },
      renderer: diagnostics,
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: diagnostics.dpr,
      },
    };
  }

  /**
   * Deterministic hooks for the canvas inspector, screenshot baselines and the
   * bot playtest. These are real: `setState` genuinely drives the machine, so a
   * captured state is a state the player can reach.
   */
  private installTestHooks(): void {
    // Player-facing production builds ship without them. The QA scripts opt in
    // with ?qa=1 so the harness can still drive the real built bundle.
    const qaRequested = new URLSearchParams(window.location.search).has('qa');
    if (!import.meta.env.DEV && !qaRequested) return;

    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.seed = value;
        this.rng = createSeededRandom(value);
        this.decorRng = createSeededRandom(value ^ 0x9e3779b9);
      },
      setState: (name: string) => {
        this.cameraOverride = null;
        switch (name) {
          case 'setup':
            this.toSetup();
            break;
          case 'active-play':
          case 'aim':
            this.startMatch(true);
            this.fastForwardTo('aim');
            break;
          case 'interval':
            this.startMatch(true);
            this.fastForwardTo('interval');
            break;
          case 'flight':
            this.startMatch(true);
            this.fastForwardTo('flight');
            break;
          case 'stress':
            this.startMatch(true);
            this.fastForwardTo('stress');
            break;
          // Character inspection: frames the active fighter tight so model work
          // can be judged at a size a screenshot actually shows.
          case 'closeup': {
            this.startMatch(true);
            this.fastForwardTo('aim');
            const hero = this.activeFighter;
            if (hero) {
              this.cameraOverride = {
                x: hero.position.x + 0.5,
                y: hero.position.y + hero.model.height * 0.55,
                width: 9,
              };
              this.cameraRig.frame(this.cameraOverride.x, this.cameraOverride.y, this.cameraOverride.width);
              this.cameraRig.snap();
              this.hud.showAimDock(false);
              this.aimGuide.setVisible(false);
            }
            break;
          }
          // Worst case for the render budget: four fighters on screen, mid
          // impact, with debris and smoke live.
          case 'stress4':
            this.players = [
              { slot: 0, controller: 'human', animalId: 'gecko', aiSkill: AI.defaultSkill },
              { slot: 1, controller: 'ai', animalId: 'boar', aiSkill: AI.defaultSkill },
              { slot: 2, controller: 'ai', animalId: 'tortoise', aiSkill: AI.defaultSkill },
              { slot: 3, controller: 'ai', animalId: 'toucan', aiSkill: AI.defaultSkill },
            ];
            this.startMatch(true);
            this.fastForwardTo('stress');
            this.setCamera('overview');
            this.cameraRig.snap();
            break;
          case 'results':
          case 'complete':
            this.startMatch(true);
            // Play a few real turns so the table shows real damage and
            // accuracy rather than a screen full of zeroes.
            this.fastForwardTurns(4);
            this.endMatch();
            break;
          default:
            console.warn('Unknown test state: ' + name);
        }
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
        this.shake.setScale(enabled ? 0 : 1);
      },
      hideDebugUi: () => {
        // No debug overlay ships in this build; the hook stays for parity.
      },
      tap: () => this.registerTap(),
      selectTarget: (slot: number) => this.selectTarget(slot),
      cycleTarget: (direction: number) => this.cycleTarget(direction >= 0 ? 1 : -1),
      lockAim: () => this.lockAim(),
      getState: () => this.phase,
      /** Replace the line-up, for bot playtests at chosen skill levels. */
      configure: (players, wind) => {
        this.players = players.map((player, index) => ({
          slot: index,
          controller: player.controller,
          animalId: player.animalId,
          aiSkill: player.aiSkill,
        }));
        this.windEnabled = wind;
        this.startMatch(true);
      },
      /** Run N complete turns through the real update path. */
      advanceTurns: (count: number) => this.fastForwardTurns(count),
    };
  }

  /**
   * Runs `count` complete turns through the real update path.
   *
   * AI turns are left entirely alone — the bot picks its own target, solves its
   * own angle and rides its own interval. Human turns are driven by a scripted
   * player that uses the same solver the aim guide draws and taps at the
   * cadence that holds target.
   *
   * An earlier version forced EVERY turn to a fixed 52 degrees, which silently
   * overrode the AI's aiming and made the whole playtest measure nothing but
   * the terrain.
   */
  private fastForwardTurns(count: number): void {
    const step = 1 / 60;
    let completed = 0;
    let guard = 0;
    let lastPhase: PhaseName = this.phase;
    let tapAccumulator = 0;

    while (completed < count && guard < 12000 && this.phase !== 'results') {
      guard += 1;
      const fighter = this.activeFighter;
      const scriptedHuman = fighter?.controller === 'human';

      if (this.phase === 'aim' && scriptedHuman && fighter) {
        // The turn already opened on the nearest opponent and solved the line,
        // so a scripted player only has to commit.
        this.lockAim();
      }

      if (this.phase === 'interval' && scriptedHuman && this.turn) {
        // Synthetic timestamps: the anti-turbo guard reads the wall clock, and
        // a synchronous loop barely advances it.
        const cadence = this.turn.plan.targetWatts / (POWER.tapWatts * POWER.decayTau);
        tapAccumulator += step * cadence;
        while (tapAccumulator >= 1) {
          tapAccumulator -= 1;
          this.spacebarSource.tap(guard * 16.7);
        }
      }

      this.update(step, this.elapsed + step);

      if (lastPhase !== 'resolve' && this.phase === 'resolve') completed += 1;
      lastPhase = this.phase;
    }
  }

  /**
   * Drives the real machine forward to a named state so screenshots and metrics
   * can be captured without live play. Nothing here bypasses gameplay: it steps
   * the same update path a player would.
   */
  private fastForwardTo(state: 'aim' | 'interval' | 'flight' | 'stress'): void {
    const step = 1 / 60;
    let guard = 0;
    const advance = (until: () => boolean) => {
      while (!until() && guard < 3000) {
        guard += 1;
        this.update(step, this.elapsed + step);
      }
    };

    advance(() => this.phase === 'aim');
    if (state === 'aim') {
      this.setCamera('focus');
      this.cameraRig.snap();
      return;
    }

    this.lockAim();
    advance(() => this.phase === 'interval');
    if (state === 'interval') {
      // Tap at roughly the cadence that holds the target, so the captured meter
      // shows a real hold rather than a decayed needle at zero.
      const cadence = this.turn
        ? this.turn.plan.targetWatts / (POWER.tapWatts * POWER.decayTau)
        : 4;
      const framesPerTap = Math.max(1, Math.round(60 / cadence));
      for (let i = 0; i < 190 && this.phase === 'interval'; i += 1) {
        if (i % framesPerTap === 0) this.spacebarSource.tap(i * 16.7);
        this.update(step, this.elapsed + step);
      }
      this.cameraRig.snap();
      return;
    }

    // Ride the interval out, then let the shot fly.
    // Synthetic timestamps: registerTap() rejects taps closer than
    // POWER.minTapIntervalMs by wall clock, and a synchronous fast-forward
    // barely advances performance.now(), so every tap would be dropped.
    let ticks = 0;
    const cadenceFrames = this.turn
      ? Math.max(1, Math.round(60 / (this.turn.plan.targetWatts / (POWER.tapWatts * POWER.decayTau))))
      : 14;
    while (this.phase === 'interval' && ticks < 900) {
      if (ticks % cadenceFrames === 0) this.spacebarSource.tap(ticks * 16.7);
      ticks += 1;
      this.update(step, this.elapsed + step);
    }
    if (state === 'flight') {
      for (let i = 0; i < 30 && this.phase === 'flight'; i += 1) {
        this.update(step, this.elapsed + step);
      }
      this.cameraRig.snap();
      return;
    }

    // Stress: run the shot to impact so craters, debris and smoke are on screen.
    for (let i = 0; i < 260 && this.projectiles.liveCount > 0; i += 1) {
      this.update(step, this.elapsed + step);
    }
    for (let i = 0; i < 8; i += 1) this.update(step, this.elapsed + step);
    this.cameraRig.snap();
  }
}

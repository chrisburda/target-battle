/**
 * Central tuning table for Wild Watts.
 *
 * Every number a designer would want to touch lives here. The interval model
 * (POWER) is the piece that an indoor trainer replaces later: the spacebar
 * source synthesises watts, but the scoring, shot mapping and HUD all consume
 * plain watts, so swapping the source changes nothing downstream.
 */

export const WORLD = {
  /** Playfield spans x in [-halfWidth, halfWidth]. */
  halfWidth: 62,
  /** Terrain heightfield resolution. 0.25 world units per column. */
  columns: 497,
  /** Terrain slab depth (z from -halfDepth to +halfDepth). */
  halfDepth: 4.5,
  /** Bottom of the terrain slab. */
  baseY: -24,
  /** Water surface height. Terrain below this is submerged. */
  waterY: -1.2,
  /** Below this a fighter has drowned / fallen out. */
  killPlaneY: -14,
} as const;

export const PHYSICS = {
  gravity: 26,
  /** Fixed substep for projectile integration (prevents tunnelling). */
  fixedStep: 1 / 240,
  /** Max wind acceleration magnitude, world units / s^2. */
  maxWind: 6.5,
  /**
   * Speed a perfectly-on-target shot leaves the hand with.
   *
   * Flat-ground range is v^2/g, so 40 reaches about 61 units. At 34 the range
   * was 44 units and a four-fighter line-up regularly contained targets no
   * shot could physically reach — bots fired into the dirt all match.
   */
  baseLaunchSpeed: 40,
  /** Projectile self-destructs after this long in the air. */
  maxFlightSeconds: 12,
} as const;

/**
 * The power interval model.
 *
 * Spacebar taps inject `tapWatts` of impulse into a leaky integrator with time
 * constant `decayTau`. Steady state for a tap rate r is roughly
 * `tapWatts * decayTau * r`, so 105 * 0.6 * r = 63r: about 4 taps/second holds
 * 250 W. That is a deliberately cycling-like cadence.
 */
export const POWER = {
  tapWatts: 105,
  decayTau: 0.6,
  /** Visual smoothing only; scoring reads the raw value. */
  displayTau: 0.08,
  /** Taps closer together than this are ignored (anti-turbo). */
  minTapIntervalMs: 45,
  /** Bar scale: the meter tops out at target * this. */
  meterHeadroom: 1.9,
} as const;

export const INTERVAL = {
  /** Interval length in round 1; grows with `secondsPerRound`. */
  baseSeconds: 5,
  secondsPerRound: 0.35,
  maxSeconds: 7.5,
  /** Ramp-in grace: the first N seconds are not scored. */
  graceSeconds: 0.7,
  /** Countdown before the interval opens. */
  readySeconds: 2.2,
  /** Target watts in round 1, and the per-round multiplier. */
  baseTargetWatts: 220,
  wattsPerRound: 1.07,
  maxTargetWatts: 420,
  /** Deadband: |error| inside this ratio scores a flat 1.0. */
  baseZone: 0.07,
  zoneShrinkPerRound: 0.006,
  minZone: 0.035,
  /** Error ratio at which the score reaches 0. */
  baseTolerance: 0.42,
  toleranceShrinkPerRound: 0.012,
  minTolerance: 0.26,
  /** From this round on, targets can step up mid-interval. */
  surgeFromRound: 3,
  surgeMultiplier: 1.22,
  /** Fraction of the interval that has elapsed when a surge fires. */
  surgeAtFraction: 0.55,
} as const;

export const SHOT = {
  /** accuracy and consistency weights inside the final shot score. */
  accuracyWeight: 0.75,
  consistencyWeight: 0.25,
  /** Consistency reaches 0 at this standard deviation of power ratio. */
  consistencySpread: 0.26,
  /**
   * Launch speed multiplier = 1 + (avgRatio - 1) * this.
   *
   * Range goes with v squared, so this number is the whole difficulty curve. At
   * 0.85 a 15% power error moved the landing point ~25% of the range, which put
   * every shot outside the blast radius and made matches decide on the round
   * timer instead of knockouts. 0.68 still punishes a sloppy hold clearly while
   * leaving a near-miss close enough to hurt.
   */
  speedResponse: 0.68,
  minSpeedMultiplier: 0.55,
  maxSpeedMultiplier: 1.42,
  /** Aim wobble in degrees at a shot score of 0. */
  maxWobbleDegrees: 9,
  /** Damage multiplier ramps from min at score 0 to max at score 1. */
  minDamageMultiplier: 0.55,
  maxDamageMultiplier: 1.5,
  /** Score at or above this counts as a perfect interval. */
  perfectThreshold: 0.93,
  perfectDamageBonus: 1.15,
} as const;

export const MATCH = {
  maxHealth: 100,
  minPlayers: 1,
  maxPlayers: 4,
  /** Hard stop so a match cannot run forever. */
  maxRounds: 9,
  /** Fall damage per world unit dropped beyond the free allowance. */
  fallDamagePerUnit: 1.6,
  fallDamageFreeDrop: 4,
  /** Comeback assist: the trailing player gets a slightly wider zone. */
  comebackZoneBonus: 0.02,
} as const;

/**
 * Targeting.
 *
 * There is no manual angle control. The player chooses *who* to shoot; the
 * throw solves its own arc at the launch speed a perfect interval would
 * produce, and the interval alone decides whether the shot actually lands
 * there. Angle is an output, never an input.
 */
export const AIM = {
  /** Clamp for the solved angle. */
  minAngle: 4,
  maxAngle: 88,
  /** Number of dots drawn in the predicted-arc guide. */
  guideSamples: 46,
  guideSeconds: 2.4,
  /** A perfect shot landing within this of the target counts as a clean line. */
  cleanLineUnits: 1.8,
  /** Beyond the ammo's blast radius, the line is reported as blocked. */
  blockedBeyondRadiusFactor: 1,
} as const;

export const CAMERA = {
  fov: 30,
  near: 1,
  far: 900,
  /** Framed world width per camera mode. */
  overviewWidth: 128,
  focusWidth: 40,
  flightWidth: 54,
  impactWidth: 34,
  /**
   * Padding added around a shooter-to-target span when framing the choice, so
   * neither fighter sits on the very edge of the frame.
   */
  engagementMargin: 26,
  /** Smoothing time constants (seconds to close ~63% of the gap). */
  positionTau: 0.28,
  widthTau: 0.34,
  /** Keep the framed box inside these bounds. */
  minCenterY: -2,
  maxCenterY: 30,
} as const;

export const VFX = {
  trauma: {
    launch: 0.16,
    impact: 0.42,
    bigImpact: 0.62,
    elimination: 0.8,
  },
  hitstopMs: {
    hit: 70,
    elimination: 110,
  },
} as const;

export const AI = {
  /** Skill 0..1 drives both aim error and how tightly it holds the target. */
  defaultSkill: 0.62,
  /** Degrees of aim error at skill 0. */
  maxAimErrorDegrees: 9,
  /** How long the AI takes to look like it is "thinking" before locking aim. */
  aimSeconds: 1.4,
} as const;

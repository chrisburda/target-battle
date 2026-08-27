import type * as THREE from 'three';

export type PhaseName =
  | 'setup'
  | 'intro'
  | 'aim'
  | 'ready'
  | 'interval'
  | 'flight'
  | 'resolve'
  | 'results';

export type ControllerKind = 'human' | 'ai';

/** Result of one scored power interval. */
export type IntervalResult = {
  /** Time-weighted 0..1 closeness to the target. */
  accuracy: number;
  /** 0..1, penalises a spiky/unsteady hold. */
  consistency: number;
  /** accuracy and consistency blended by SHOT weights. */
  score: number;
  /** Mean watts across the scored window. */
  averageWatts: number;
  /** averageWatts / target, before clamping. */
  averageRatio: number;
  /** Peak watts reached. */
  peakWatts: number;
  /** Seconds spent inside the target zone. */
  secondsInZone: number;
  /** Seconds actually scored (interval length minus grace). */
  scoredSeconds: number;
  perfect: boolean;
};

export type ShotOutcome = {
  speedMultiplier: number;
  wobbleDegrees: number;
  damageMultiplier: number;
};

export type AnimalPerk = {
  /** Multiplies aim wobble. Lower is steadier. */
  wobble: number;
  /** Multiplies outgoing damage. */
  damage: number;
  /** Multiplies incoming damage. Lower is tankier. */
  armor: number;
  /** Multiplies launch speed. */
  launch: number;
  /** Multiplies blast radius. */
  blast: number;
  /** Multiplies wind acceleration felt by this animal's shots. */
  wind: number;
  /** Added to the target-zone half-width (ratio). */
  zoneBonus: number;
};

export type AnimalDef = {
  id: string;
  name: string;
  species: string;
  /** One-line perk description for the setup screen. */
  perkLabel: string;
  perk: AnimalPerk;
  palette: {
    body: number;
    belly: number;
    accent: number;
    limb: number;
    eye: number;
    /** Costume fabric: scarf, headband, pack. */
    cloth: number;
    /** Straps, gloves, boots. */
    leather: number;
  };
};

export type AmmoBehaviour = 'impact' | 'bounce' | 'cluster' | 'swarm';

export type AmmoDef = {
  id: string;
  name: string;
  /** -1 means unlimited. */
  rounds: number;
  damage: number;
  radius: number;
  behaviour: AmmoBehaviour;
  /** Multiplies launch speed (heavy ammo flies shorter). */
  launch: number;
  /** Bounces before detonating, for 'bounce'. */
  bounces: number;
  /** Child count for 'cluster'. */
  fragments: number;
  blurb: string;
  color: number;
  accent: number;
};

export type PlayerConfig = {
  slot: number;
  controller: ControllerKind;
  animalId: string;
  aiSkill: number;
};

export type PlayerStats = {
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  hits: number;
  perfects: number;
  accuracySum: number;
  bestAccuracy: number;
  secondsInZone: number;
};

export type DamageEvent = {
  targetSlot: number;
  amount: number;
  position: THREE.Vector3;
  lethal: boolean;
};

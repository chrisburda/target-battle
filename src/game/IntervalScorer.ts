import { INTERVAL, SHOT } from './config';
import type { AnimalPerk, IntervalResult, ShotOutcome } from './types';

export type IntervalPlan = {
  targetWatts: number;
  durationSeconds: number;
  /** Half-width of the flat-scoring deadband, as a ratio of target. */
  zone: number;
  /** Error ratio at which the instantaneous score reaches zero. */
  tolerance: number;
  /** If set, the target steps to this value partway through. */
  surgeWatts: number | null;
  surgeAtSeconds: number;
};

/**
 * Builds the interval for a given round. Later rounds ask for more watts, for
 * longer, with a tighter zone — the difficulty curve lives entirely here so it
 * can be retuned without touching gameplay code.
 */
export function planInterval(round: number, perk: AnimalPerk, comebackBonus: number): IntervalPlan {
  const roundIndex = Math.max(0, round - 1);
  const targetWatts = Math.min(
    INTERVAL.maxTargetWatts,
    Math.round(INTERVAL.baseTargetWatts * Math.pow(INTERVAL.wattsPerRound, roundIndex)),
  );
  const durationSeconds = Math.min(
    INTERVAL.maxSeconds,
    INTERVAL.baseSeconds + INTERVAL.secondsPerRound * roundIndex,
  );
  const zone = Math.max(
    INTERVAL.minZone,
    INTERVAL.baseZone - INTERVAL.zoneShrinkPerRound * roundIndex + perk.zoneBonus + comebackBonus,
  );
  const tolerance = Math.max(
    INTERVAL.minTolerance,
    INTERVAL.baseTolerance - INTERVAL.toleranceShrinkPerRound * roundIndex,
  );
  const surges = round >= INTERVAL.surgeFromRound;
  return {
    targetWatts,
    durationSeconds,
    zone,
    tolerance,
    surgeWatts: surges ? Math.round(targetWatts * INTERVAL.surgeMultiplier) : null,
    surgeAtSeconds: durationSeconds * INTERVAL.surgeAtFraction,
  };
}

/**
 * Time-weighted accuracy scorer.
 *
 * Samples are accumulated with their own delta as the weight, so the result is
 * frame-rate independent. The first `graceSeconds` are ignored: nobody can be
 * at target from a standing start, and scoring the ramp would just punish
 * everyone equally.
 */
export class IntervalScorer {
  private plan: IntervalPlan = {
    targetWatts: 200,
    durationSeconds: 5,
    zone: 0.07,
    tolerance: 0.4,
    surgeWatts: null,
    surgeAtSeconds: 3,
  };

  private elapsed = 0;
  private scoredTime = 0;
  private weightedScore = 0;
  private weightedWatts = 0;
  private weightedRatio = 0;
  private weightedRatioSq = 0;
  private inZoneTime = 0;
  private peak = 0;
  private samples = 0;

  reset(plan: IntervalPlan): void {
    this.plan = plan;
    this.elapsed = 0;
    this.scoredTime = 0;
    this.weightedScore = 0;
    this.weightedWatts = 0;
    this.weightedRatio = 0;
    this.weightedRatioSq = 0;
    this.inZoneTime = 0;
    this.peak = 0;
    this.samples = 0;
  }

  /** Target for right now, accounting for a mid-interval surge. */
  get currentTarget(): number {
    if (this.plan.surgeWatts !== null && this.elapsed >= this.plan.surgeAtSeconds) {
      return this.plan.surgeWatts;
    }
    return this.plan.targetWatts;
  }

  get currentPlan(): IntervalPlan {
    return this.plan;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  get remainingSeconds(): number {
    return Math.max(0, this.plan.durationSeconds - this.elapsed);
  }

  get finished(): boolean {
    return this.elapsed >= this.plan.durationSeconds;
  }

  get inGrace(): boolean {
    return this.elapsed < INTERVAL.graceSeconds;
  }

  /** Live 0..1 accuracy so far, for the HUD. */
  get liveAccuracy(): number {
    return this.scoredTime > 0 ? this.weightedScore / this.scoredTime : 0;
  }

  /** Instantaneous 0..1 score for the given watts, used for bar colouring. */
  scoreFor(watts: number): number {
    const target = this.currentTarget;
    if (target <= 0) return 0;
    const error = Math.abs(watts - target) / target;
    if (error <= this.plan.zone) return 1;
    const span = Math.max(1e-4, this.plan.tolerance - this.plan.zone);
    return Math.max(0, 1 - (error - this.plan.zone) / span);
  }

  sample(watts: number, deltaSeconds: number): void {
    this.elapsed += deltaSeconds;
    this.peak = Math.max(this.peak, watts);
    if (this.elapsed <= INTERVAL.graceSeconds) return;

    const target = this.currentTarget;
    const score = this.scoreFor(watts);
    const ratio = target > 0 ? watts / target : 0;

    this.scoredTime += deltaSeconds;
    this.weightedScore += score * deltaSeconds;
    this.weightedWatts += watts * deltaSeconds;
    this.weightedRatio += ratio * deltaSeconds;
    this.weightedRatioSq += ratio * ratio * deltaSeconds;
    if (score >= 1) this.inZoneTime += deltaSeconds;
    this.samples += 1;
  }

  finish(): IntervalResult {
    const scored = Math.max(1e-4, this.scoredTime);
    const accuracy = this.samples > 0 ? this.weightedScore / scored : 0;
    const averageWatts = this.samples > 0 ? this.weightedWatts / scored : 0;
    const averageRatio = this.samples > 0 ? this.weightedRatio / scored : 0;
    const variance = Math.max(0, this.weightedRatioSq / scored - averageRatio * averageRatio);
    const spread = Math.sqrt(variance);
    const consistency = Math.max(0, Math.min(1, 1 - spread / SHOT.consistencySpread));
    const score = accuracy * SHOT.accuracyWeight + consistency * SHOT.consistencyWeight;

    return {
      accuracy,
      consistency,
      score,
      averageWatts,
      averageRatio,
      peakWatts: this.peak,
      secondsInZone: this.inZoneTime,
      scoredSeconds: this.scoredTime,
      perfect: score >= SHOT.perfectThreshold,
    };
  }
}

/**
 * Turns a scored interval into the three numbers the shot actually cares about.
 *
 * Note that overshooting is punished on both axes at once: it drags accuracy
 * down (raising wobble, lowering damage) *and* it raises launch speed, so the
 * shot sails past the aim guide. Undershooting does the mirror image. That
 * symmetry is what makes "hit the number" the right instinct rather than
 * "mash as hard as possible".
 */
export function resolveShot(result: IntervalResult, perk: AnimalPerk, random: () => number): ShotOutcome {
  const rawSpeed = 1 + (result.averageRatio - 1) * SHOT.speedResponse;
  const speedMultiplier =
    Math.min(SHOT.maxSpeedMultiplier, Math.max(SHOT.minSpeedMultiplier, rawSpeed)) * perk.launch;

  const wobbleMagnitude = (1 - result.score) * SHOT.maxWobbleDegrees * perk.wobble;
  // Triangular distribution: small errors are common, large ones rare.
  const bias = (random() + random() - 1);
  const wobbleDegrees = bias * wobbleMagnitude;

  let damageMultiplier =
    (SHOT.minDamageMultiplier +
      result.score * (SHOT.maxDamageMultiplier - SHOT.minDamageMultiplier)) *
    perk.damage;
  if (result.perfect) damageMultiplier *= SHOT.perfectDamageBonus;

  return { speedMultiplier, wobbleDegrees, damageMultiplier };
}

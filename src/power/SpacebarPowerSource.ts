import { POWER } from '../game/config';
import type { PowerContext, PowerSource } from './PowerSource';

/**
 * Spacebar stand-in for a power meter.
 *
 * Each accepted tap injects `tapWatts` into a leaky integrator that bleeds off
 * with time constant `decayTau`. Holding a steady wattage therefore requires a
 * steady cadence rather than a single burst, which is the property that makes
 * the mechanic transfer to a trainer at all.
 */
export class SpacebarPowerSource implements PowerSource {
  readonly kind = 'spacebar' as const;
  readonly label = 'SPACEBAR';
  readonly ready = true;

  private value = 0;
  private pendingTaps = 0;
  private active = false;
  private lastTapTime = -1;
  /** Rolling cadence estimate in taps per second, for the HUD. */
  private cadence = 0;

  get watts(): number {
    return this.value;
  }

  get tapsPerSecond(): number {
    return this.cadence;
  }

  /**
   * Feed a tap in. Called by the input layer rather than by a listener owned
   * here, so the same source can be driven by a touch button or a test hook.
   */
  tap(timeMs: number): boolean {
    if (!this.active) return false;
    if (this.lastTapTime >= 0 && timeMs - this.lastTapTime < POWER.minTapIntervalMs) {
      return false;
    }
    if (this.lastTapTime >= 0) {
      const gap = (timeMs - this.lastTapTime) / 1000;
      const instant = gap > 0 ? 1 / gap : 0;
      this.cadence += (instant - this.cadence) * 0.35;
    }
    this.lastTapTime = timeMs;
    this.pendingTaps += 1;
    return true;
  }

  begin(_context: PowerContext): void {
    this.value = 0;
    this.pendingTaps = 0;
    this.cadence = 0;
    this.lastTapTime = -1;
    this.active = true;
  }

  update(deltaSeconds: number): void {
    if (!this.active) return;
    // Exponential bleed, then add this frame's impulses.
    this.value *= Math.exp(-deltaSeconds / POWER.decayTau);
    if (this.pendingTaps > 0) {
      this.value += this.pendingTaps * POWER.tapWatts;
      this.pendingTaps = 0;
    }
    // Cadence decays too, so the readout falls to zero when tapping stops.
    this.cadence *= Math.exp(-deltaSeconds / 0.9);
    if (this.value < 0.01) this.value = 0;
  }

  end(): void {
    this.active = false;
    this.pendingTaps = 0;
  }

  dispose(): void {
    this.end();
  }
}

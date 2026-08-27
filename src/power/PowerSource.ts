/**
 * A PowerSource produces a live wattage reading for the active fighter.
 *
 * This is the seam the indoor trainer plugs into. Everything downstream —
 * IntervalScorer, the HUD power bar, the shot mapping — reads plain watts and
 * has no idea whether they came from a keyboard, a bot, or a real crank.
 *
 * Contract:
 *  - `begin()` is called once when an interval opens.
 *  - `update(delta)` is called every frame while the interval runs.
 *  - `watts` must be readable at any time after `begin()`.
 *  - `end()` is called when the interval closes. The source may keep running
 *    (a trainer keeps streaming) but must stop influencing the game.
 */
export interface PowerSource {
  readonly kind: 'spacebar' | 'ai' | 'trainer';
  /** Human-readable label for the HUD ("SPACEBAR", "AI", "KICKR CORE"). */
  readonly label: string;
  /** True once the source is producing meaningful data. */
  readonly ready: boolean;
  /** Current instantaneous power in watts. */
  readonly watts: number;
  begin(context: PowerContext): void;
  update(deltaSeconds: number): void;
  end(): void;
  dispose(): void;
}

export type PowerContext = {
  /** Target watts for this interval, so bots know what to chase. */
  targetWatts: number;
  /** Total interval length in seconds. */
  durationSeconds: number;
  /** Seeded RNG so bot behaviour stays deterministic under test. */
  random: () => number;
};

import type { PowerContext, PowerSource } from './PowerSource';

/**
 * Simulated rider.
 *
 * Skill drives three things: how fast it settles onto the target, how much
 * noise sits on top, and how far its slow drift wanders. A low-skill bot
 * surges past the target and sags, exactly like a rider who cannot hold an
 * interval, and its shots suffer for it through the same scorer humans use.
 */
export class AiPowerSource implements PowerSource {
  readonly kind = 'ai' as const;
  readonly label = 'AI';
  readonly ready = true;

  private value = 0;
  private target = 200;
  private duration = 5;
  private elapsed = 0;
  private drift = 0;
  private noise = 0;
  /** Constant offset for this interval: some turns a rider just sits high. */
  private bias = 0;
  private random: () => number = Math.random;
  private active = false;

  constructor(private skill: number) {}

  setSkill(skill: number): void {
    this.skill = Math.min(1, Math.max(0, skill));
  }

  get watts(): number {
    return this.value;
  }

  begin(context: PowerContext): void {
    this.target = context.targetWatts;
    this.duration = context.durationSeconds;
    this.random = context.random;
    this.elapsed = 0;
    this.value = 0;
    this.drift = (this.random() - 0.5) * 2;
    this.noise = 0;
    this.bias = (this.random() - 0.5) * 2 * (1 - this.skill) * 0.14;
    this.active = true;
  }

  update(deltaSeconds: number): void {
    if (!this.active) return;
    this.elapsed += deltaSeconds;

    // Ramp: better riders find the target sooner and overshoot less.
    const settle = 0.55 - this.skill * 0.32;
    const ramp = 1 - Math.exp(-this.elapsed / settle);
    const overshoot = (1 - this.skill) * 0.34 * Math.exp(-this.elapsed / (settle * 2.2));

    // Slow wander plus fast jitter, both in ratio units and both shrinking
    // with skill. Two timescales matter: the wander is what drags average
    // power off target, the jitter is what wrecks consistency.
    this.drift += (this.random() - 0.5) * deltaSeconds * 7;
    this.drift *= Math.exp(-deltaSeconds / 1.4);
    this.noise += (this.random() - 0.5) * deltaSeconds * 22;
    this.noise *= Math.exp(-deltaSeconds / 0.26);

    const driftAmplitude = (1 - this.skill) * 0.34;
    const jitterAmplitude = (1 - this.skill) * 0.16 + 0.02;

    // Late-interval fade: tired legs sag in the last quarter.
    const fatigue = Math.max(0, this.elapsed / this.duration - 0.7) * (1 - this.skill) * 0.5;

    const ratio =
      ramp * (1 + overshoot + this.bias - fatigue) +
      this.drift * driftAmplitude +
      this.noise * jitterAmplitude;

    this.value = Math.max(0, this.target * ratio);
  }

  end(): void {
    this.active = false;
  }

  dispose(): void {
    this.end();
  }
}

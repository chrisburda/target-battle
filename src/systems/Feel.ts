import * as THREE from 'three';

/** Easing curves. `easeOutBack` overshoots past 1 near the end — that is the bounce. */
export type Easing = (t: number) => number;

export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic: Easing = (t) => t * t * t;
export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInOutQuad: Easing = (t) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

interface ActiveTween {
  elapsed: number;
  duration: number;
  delay: number;
  easing: Easing;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

/**
 * Minimal tween manager. Always driven by the real render delta, never the
 * gameplay delta, so feedback stays live through hitstop.
 */
export class TweenManager {
  private readonly tweens: ActiveTween[] = [];

  tween(
    durationSeconds: number,
    onUpdate: (value: number) => void,
    easing: Easing = easeOutCubic,
    onComplete?: () => void,
    delay = 0,
  ): void {
    this.tweens.push({ elapsed: 0, duration: durationSeconds, delay, easing, onUpdate, onComplete });
  }

  update(delta: number): void {
    for (let i = this.tweens.length - 1; i >= 0; i -= 1) {
      const tween = this.tweens[i];
      if (tween.delay > 0) {
        tween.delay -= delta;
        continue;
      }
      tween.elapsed += delta;
      const k = Math.min(tween.elapsed / tween.duration, 1);
      tween.onUpdate(tween.easing(k));
      if (tween.elapsed >= tween.duration) {
        tween.onComplete?.();
        this.tweens.splice(i, 1);
      }
    }
  }

  get active(): number {
    return this.tweens.length;
  }

  clear(): void {
    this.tweens.length = 0;
  }
}

const TRAUMA_MAX = 1;
const TRAUMA_DECAY = 1.5;
const MAX_OFFSET = 0.85;
const MAX_ROLL = 0.045;

/** Deterministic value noise in [-1, 1]; per-axis seed keeps the axes independent. */
function pseudoNoise(t: number, seed: number): number {
  const x = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Trauma-based screenshake. Offset scales with trauma squared, so a landed
 * pebble barely nudges the frame and a melon detonation snaps it — while the
 * hard cap means three simultaneous hits still cannot fling the camera off the
 * arena.
 */
export class ShakeRig {
  private trauma = 0;
  private time = 0;
  private scale = 1;

  /** 0 disables shake entirely for the reduced-motion setting. */
  setScale(scale: number): void {
    this.scale = scale;
  }

  add(amount: number): void {
    this.trauma = Math.min(TRAUMA_MAX, this.trauma + amount);
  }

  get level(): number {
    return this.trauma;
  }

  /** Call after the camera rig has written its base transform. */
  update(delta: number, camera: THREE.Camera): void {
    this.time += delta;
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * delta);
    if (this.trauma <= 0 || this.scale <= 0) return;
    const shake = this.trauma * this.trauma * this.scale;
    const freq = this.time * 26;
    camera.position.x += MAX_OFFSET * shake * pseudoNoise(freq, 1);
    camera.position.y += MAX_OFFSET * shake * pseudoNoise(freq, 2);
    camera.rotation.z += MAX_ROLL * shake * pseudoNoise(freq, 3);
  }

  reset(): void {
    this.trauma = 0;
  }
}

import * as THREE from 'three';
import { PHYSICS, WORLD } from './config';
import type { Terrain } from '../systems/Terrain';

/**
 * Shared trajectory prediction.
 *
 * Used by the aim guide (to draw the perfect-shot arc) and by the AI (to pick
 * an angle). Both run the same integrator the projectile itself uses, so what
 * the dots promise and what the bot expects are the same physics — no separate
 * closed-form solution to drift out of sync with the simulation.
 */

export type ShotPrediction = {
  hit: boolean;
  x: number;
  y: number;
  /** Seconds of flight before impact. */
  time: number;
  /** Highest point reached, useful for judging whether a lob clears a ridge. */
  apex: number;
};

const velocity = new THREE.Vector3();
const position = new THREE.Vector3();

export function simulateShot(
  terrain: Terrain,
  origin: THREE.Vector3,
  angleDegrees: number,
  facing: 1 | -1,
  speed: number,
  wind: number,
  maxSeconds = 12,
): ShotPrediction {
  const radians = THREE.MathUtils.degToRad(angleDegrees);
  velocity.set(Math.cos(radians) * speed * facing, Math.sin(radians) * speed, 0);
  position.copy(origin);

  const dt = 1 / 120;
  let time = 0;
  let apex = position.y;

  while (time < maxSeconds) {
    velocity.y -= PHYSICS.gravity * dt;
    velocity.x += wind * dt;
    position.x += velocity.x * dt;
    position.y += velocity.y * dt;
    time += dt;
    if (position.y > apex) apex = position.y;

    if (Math.abs(position.x) > WORLD.halfWidth) {
      return { hit: false, x: position.x, y: position.y, time, apex };
    }
    if (position.y < WORLD.baseY) {
      return { hit: false, x: position.x, y: position.y, time, apex };
    }
    const ground = terrain.heightAt(position.x);
    if (position.y <= ground) {
      return { hit: true, x: position.x, y: ground, time, apex };
    }
  }
  return { hit: false, x: position.x, y: position.y, time, apex };
}

/**
 * Sweeps launch angles and returns the one that lands closest to `targetX`.
 *
 * A sweep rather than the analytic solution because the ground is not flat,
 * wind is a constant lateral acceleration, and the shot must actually clear
 * whatever ridge sits between the two fighters. Roughly 80 short simulations —
 * a fraction of a millisecond, run once per AI turn.
 */
export function findBestAngle(
  terrain: Terrain,
  origin: THREE.Vector3,
  facing: 1 | -1,
  speed: number,
  wind: number,
  targetX: number,
  targetY: number,
): { angle: number; error: number } {
  let bestAngle = 45;
  let bestError = Infinity;

  for (let angle = 8; angle <= 86; angle += 1) {
    const shot = simulateShot(terrain, origin, angle, facing, speed, wind);
    if (!shot.hit) continue;
    // Weight vertical error lower: landing near the feet is still a good hit.
    const error = Math.abs(shot.x - targetX) + Math.abs(shot.y - targetY) * 0.35;
    if (error < bestError) {
      bestError = error;
      bestAngle = angle;
    }
  }

  // Refine around the winner at a tenth of a degree.
  const coarse = bestAngle;
  for (let angle = coarse - 1; angle <= coarse + 1; angle += 0.1) {
    if (angle < 4 || angle > 88) continue;
    const shot = simulateShot(terrain, origin, angle, facing, speed, wind);
    if (!shot.hit) continue;
    const error = Math.abs(shot.x - targetX) + Math.abs(shot.y - targetY) * 0.35;
    if (error < bestError) {
      bestError = error;
      bestAngle = angle;
    }
  }

  return { angle: bestAngle, error: bestError };
}

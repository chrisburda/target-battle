import * as THREE from 'three';
import { AIM, PHYSICS, WORLD } from './config';
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
 * Speed that lands a shot on the target at a fixed angle.
 *
 * Range grows with speed at any angle, so the answer can be bisected rather
 * than swept — twenty halvings pin it far tighter than a linear scan of the
 * same cost. A shot that leaves the arena counts as too fast, which keeps the
 * search inside the playfield instead of chasing a landing beyond it.
 */
function speedForAngle(
  terrain: Terrain,
  origin: THREE.Vector3,
  angle: number,
  facing: 1 | -1,
  wind: number,
  targetX: number,
  minSpeed: number,
  maxSpeed: number,
): { speed: number; shot: ShotPrediction } {
  let low = minSpeed;
  let high = maxSpeed;
  let shot = simulateShot(terrain, origin, angle, facing, high, wind);

  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    shot = simulateShot(terrain, origin, angle, facing, mid, wind);
    const past = !shot.hit || (shot.x - targetX) * facing > 0;
    if (past) high = mid;
    else low = mid;
  }

  const speed = (low + high) / 2;
  return { speed, shot: simulateShot(terrain, origin, angle, facing, speed, wind) };
}

/**
 * Picks the flattest launch that puts the round on the target.
 *
 * Angle and speed together, rather than an angle at a fixed speed. The old
 * form had one degree of freedom and spent it on accuracy, so a target beyond
 * flat range left only the near-vertical solution — measured across twenty
 * seeds, eight came back past sixty degrees and several threw their apex out
 * of frame. Choosing the shape of the arc first and solving for the effort it
 * needs gives the same accuracy with a trajectory a player can follow.
 *
 * Falls back to sweeping angles at the base speed when nothing in the band
 * reaches — a target behind a ridge or past the throw ceiling still gets the
 * best answer available, however steep, and the HUD still calls it blocked.
 */
export function findBestLaunch(
  terrain: Terrain,
  origin: THREE.Vector3,
  facing: 1 | -1,
  baseSpeed: number,
  wind: number,
  targetX: number,
  targetY: number,
): { angle: number; speed: number; error: number } {
  const minSpeed = baseSpeed * AIM.speedRange.min;
  const maxSpeed = baseSpeed * AIM.speedRange.max;
  const { from, to, step } = AIM.preferredAngles;

  let fallback: { angle: number; speed: number; error: number } | null = null;

  // Flattest first, and the first clean hit wins — there is nothing to gain
  // from a steeper arc that lands in the same crater.
  for (let angle = from; angle <= to; angle += step) {
    const { speed, shot } = speedForAngle(
      terrain, origin, angle, facing, wind, targetX, minSpeed, maxSpeed,
    );
    if (!shot.hit) continue;
    const miss = Math.abs(shot.x - targetX);
    const error = miss + Math.abs(shot.y - targetY) * 0.35;
    if (miss <= AIM.cleanLineUnits) return { angle, speed, error };
    if (!fallback || error < fallback.error) fallback = { angle, speed, error };
  }

  /*
   * Nothing in the band reached it. Sweep the full range at the base speed
   * instead: out of range or behind a ridge, the honest answer is whatever
   * gets closest, and the target card reports the miss either way.
   */
  const swept = findBestAngle(terrain, origin, facing, baseSpeed, wind, targetX, targetY);
  if (!fallback || swept.error < fallback.error) {
    return { angle: swept.angle, speed: baseSpeed, error: swept.error };
  }
  return fallback;
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
  // Vertical error counts for less: landing near the feet is still a good hit.
  const errorOf = (shot: ShotPrediction) =>
    Math.abs(shot.x - targetX) + Math.abs(shot.y - targetY) * 0.35;

  /*
   * Accuracy first, flatness second — in that order, never traded.
   *
   * Both solutions to a reachable target are equally correct, and the sweep
   * used to return whichever landed a hair closer, which was as often the lob
   * as the direct line. A lob throws its apex out of frame, so the player
   * picks a round without seeing where it goes.
   *
   * The obvious fix is to weight steepness into the score, and it is wrong:
   * any weight large enough to reject a lob will eventually reject one that
   * was the only accurate answer. So the two are kept separate. The first
   * pass finds the best accuracy available; the second takes the flattest
   * angle that comes within `flatnessTolerance` of it. Nothing outside that
   * band is eligible, so a clean line can never be traded for a readable one.
   */
  const candidates: Array<{ angle: number; error: number; miss: number }> = [];
  let bestError = Infinity;

  for (let angle = 8; angle <= 86; angle += 1) {
    const shot = simulateShot(terrain, origin, angle, facing, speed, wind);
    if (!shot.hit) continue;
    const error = errorOf(shot);
    candidates.push({ angle, error, miss: Math.abs(shot.x - targetX) });
    if (error < bestError) bestError = error;
  }
  if (candidates.length === 0) return { angle: 45, error: Infinity };

  /*
   * A clean hit is a clean hit, so take the flattest one.
   *
   * Ranking clean angles against each other by fractions of a unit was the
   * mistake: they all land inside the blast, the player cannot tell them
   * apart by outcome, and the only thing separating them is whether the arc
   * can be seen. Raising launch speed was tried first and made it worse — a
   * faster flat shot overshoots, which hands accuracy back to the lob and
   * took nine of twelve seeds past sixty degrees.
   */
  const clean = candidates.filter((candidate) => candidate.miss <= AIM.cleanLineUnits);
  const pool = clean.length > 0 ? clean : candidates.filter(
    (candidate) => candidate.error <= bestError + AIM.flatnessTolerance,
  );

  let bestAngle = 45;
  let flattest = Infinity;
  for (const candidate of pool) {
    if (candidate.angle < flattest) {
      flattest = candidate.angle;
      bestAngle = candidate.angle;
      bestError = candidate.error;
    }
  }

  // Refine around the winner at a tenth of a degree, on accuracy alone —
  // a degree either side cannot change how readable the arc is.
  const coarse = bestAngle;
  for (let angle = coarse - 1; angle <= coarse + 1; angle += 0.1) {
    if (angle < 4 || angle > 88) continue;
    const shot = simulateShot(terrain, origin, angle, facing, speed, wind);
    if (!shot.hit) continue;
    const error = errorOf(shot);
    if (error < bestError) {
      bestError = error;
      bestAngle = angle;
    }
  }

  return { angle: bestAngle, error: bestError };
}

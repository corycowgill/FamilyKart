import type { KartStats, KartTuning } from '../types';

/** Convert 1-5 star stats into arcade physics tuning. Differences are intentionally modest. */
export function tuningFromStats(s: KartStats): KartTuning {
  return {
    maxSpeed: 28.1 + s.speed * 0.4, // 28.5..30.1 m/s (was 26 + 1.0/star: speed stat dominated AI results)
    acceleration: 12.6 + s.acceleration * 0.9, // 13.5..17.1 (was 9 + 1.8/star; same value at 4 stars)
    reverseSpeed: 9,
    brake: 30,
    steer: 1.55 + s.handling * 0.12,
    driftSteer: 1.5 + s.handling * 0.1,
    traction: 0.86 + s.handling * 0.02,
    lateralGrip: 9 + s.handling * 0.8,
    driftGrip: 4.2,
    suspension: 18,
    mass: 0.8 + s.weight * 0.2,
    collisionImpulse: 6,
    boostMultiplier: 0.32,
    boostDuration: 1,
    offroadPenalty: 0.5 - s.weight * 0.02,
    radius: 1.15,
  };
}

export const DRIFT_TIERS = [
  { charge: 0.9, duration: 0.55, power: 0.22 },
  { charge: 1.9, duration: 1.0, power: 0.28 },
  { charge: 3.0, duration: 1.6, power: 0.34 },
];

export const PHYSICS = {
  dt: 1 / 60,
  gravity: 28,
  hopVelocity: 5,
  minDriftSpeed: 9,
  wallBounce: 0.35,
  padBoost: { duration: 1.1, power: 0.4 },
  stuckTime: 4,
  respawnDelay: 1.2,
  killY: -12,
};

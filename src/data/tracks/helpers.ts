import { sampleSpline } from '../../sim/track/spline';
import type { TrackPoint } from '../../sim/types';

/**
 * Fraction (0..1) along a closed control-point loop nearest to a world (x, z).
 * Lets track authors place ramps, gaps and item rows by position instead of guessing fractions.
 */
export function fractionNear(points: TrackPoint[], x: number, z: number): number {
  const raw = sampleSpline(points, 10, 1, true);
  let best = 0;
  let bestD = Infinity;
  raw.forEach((p, i) => {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best / raw.length;
}

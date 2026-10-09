import type { TrackPoint } from '../types';

export interface RawSample {
  x: number;
  y: number;
  z: number;
  w: number; // full road width
}

const cr = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

/**
 * Sample a Catmull-Rom spline through control points at a uniform arc-length spacing.
 * Closed splines loop back to the first point; open splines end on the last control point.
 */
export function sampleSpline(points: TrackPoint[], defaultWidth: number, spacing: number, closed: boolean): RawSample[] {
  const n = points.length;
  const P = points.map((p) => ({ x: p[0], z: p[1], y: p[2] ?? 0, w: p[3] ?? defaultWidth }));
  const get = (i: number) => {
    if (closed) return P[((i % n) + n) % n];
    return P[Math.max(0, Math.min(n - 1, i))];
  };
  const segs = closed ? n : n - 1;
  const dense: RawSample[] = [];
  const SUB = 48;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let j = 0; j < SUB; j++) {
      const t = j / SUB;
      // smoothstep the width/height so they don't overshoot
      const st = t * t * (3 - 2 * t);
      dense.push({
        x: cr(p0.x, p1.x, p2.x, p3.x, t),
        z: cr(p0.z, p1.z, p2.z, p3.z, t),
        y: p1.y + (p2.y - p1.y) * st,
        w: p1.w + (p2.w - p1.w) * st,
      });
    }
  }
  if (closed) dense.push({ ...dense[0] });
  else {
    const last = P[n - 1];
    dense.push({ x: last.x, z: last.z, y: last.y, w: last.w });
  }
  // cumulative length
  const cum: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
  }
  const total = cum[cum.length - 1];
  const count = Math.max(4, Math.round(total / spacing));
  const step = total / count;
  const out: RawSample[] = [];
  let k = 0;
  const limit = closed ? count : count + 1;
  for (let i = 0; i < limit; i++) {
    const target = i * step;
    while (k < cum.length - 2 && cum[k + 1] < target) k++;
    const segLen = cum[k + 1] - cum[k] || 1;
    const f = (target - cum[k]) / segLen;
    const a = dense[k], b = dense[k + 1];
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, w: a.w + (b.w - a.w) * f });
  }
  return out;
}

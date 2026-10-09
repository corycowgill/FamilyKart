import type { TrackPoint } from '../../sim/types';
import { sampleSpline } from '../../sim/track/spline';

/**
 * Corner = [x, z, radius?, y?, width?]. Builds dense control points for a closed loop made of
 * straight runs joined by circular arcs (radius per corner), so Catmull-Rom sampling follows a
 * clean, predictable street layout. Heights/widths are interpolated along the loop.
 */
export type Corner = [number, number, number?, number?, number?];

export function roundedLoop(corners: Corner[], defaultRadius = 30, step = 12): TrackPoint[] {
  const n = corners.length;
  const pts: Array<{ x: number; z: number; c: number; t: number }> = []; // c = corner index, t = 0..1 progress to next corner
  for (let i = 0; i < n; i++) {
    const p = corners[(i - 1 + n) % n], c = corners[i], q = corners[(i + 1) % n];
    const r = c[2] ?? defaultRadius;
    let d1x = c[0] - p[0], d1z = c[1] - p[1];
    const l1 = Math.hypot(d1x, d1z);
    d1x /= l1;
    d1z /= l1;
    let d2x = q[0] - c[0], d2z = q[1] - c[1];
    const l2 = Math.hypot(d2x, d2z);
    d2x /= l2;
    d2z /= l2;
    const cross = d1x * d2z - d1z * d2x;
    const dot = Math.max(-1, Math.min(1, d1x * d2x + d1z * d2z));
    const theta = Math.acos(dot); // turning angle
    if (theta < 0.02 || r <= 0) {
      pts.push({ x: c[0], z: c[1], c: i, t: 0 });
      continue;
    }
    const tl = Math.min(r * Math.tan(theta / 2), l1 * 0.49, l2 * 0.49);
    const rr = tl / Math.tan(theta / 2);
    const ax = c[0] - d1x * tl, az = c[1] - d1z * tl;
    // center: perpendicular to d1 toward the inside of the turn
    const side = Math.sign(cross);
    const px = -d1z * side, pz = d1x * side;
    const cx = ax + px * rr, cz = az + pz * rr;
    const a0 = Math.atan2(ax - cx, az - cz);
    const arcLen = rr * theta;
    const segs = Math.max(2, Math.ceil(arcLen / step));
    for (let k = 0; k <= segs; k++) {
      // rotate start vector around the center by -side*theta*k/segs
      const a = a0 - side * theta * (k / segs);
      pts.push({ x: cx + Math.sin(a) * rr, z: cz + Math.cos(a) * rr, c: i, t: 0 });
    }
  }
  // fill straights with intermediate points
  const out: Array<{ x: number; z: number; c: number }> = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.floor(d / (step * 2.5));
    for (let j = 1; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, z: a.z + ((b.z - a.z) * j) / k, c: a.c });
  }
  // interpolate y / width by distance between corners
  const cum: number[] = [0];
  for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z));
  const total = cum[cum.length - 1] + Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z);
  // anchor distance of each corner = position of the point closest to the corner apex
  const anchor: number[] = corners.map((c) => {
    let best = 0, bd = Infinity;
    out.forEach((p, i) => {
      const d = (p.x - c[0]) ** 2 + (p.z - c[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return cum[best];
  });
  const valueAt = (s: number, idx: 3 | 4): number | undefined => {
    if (corners.every((c) => c[idx] === undefined)) return undefined;
    // find surrounding anchors
    const order = anchor.map((a, i) => ({ a, i })).sort((x, y) => x.a - y.a);
    for (let k = 0; k < order.length; k++) {
      const A = order[k], B = order[(k + 1) % order.length];
      const aS = A.a, bS = k + 1 < order.length ? B.a : B.a + total;
      let ss = s;
      if (ss < order[0].a) ss += total;
      if (ss >= aS && ss <= bS) {
        const va = corners[A.i][idx] ?? (idx === 3 ? 0 : NaN), vb = corners[B.i][idx] ?? (idx === 3 ? 0 : NaN);
        const t = (ss - aS) / Math.max(1e-6, bS - aS);
        const st = t * t * (3 - 2 * t);
        return va + (vb - va) * st;
      }
    }
    return undefined;
  };
  return out.map((p, i) => {
    const y = valueAt(cum[i], 3);
    const w = valueAt(cum[i], 4);
    const tp: TrackPoint = [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10];
    if (y !== undefined || (w !== undefined && !Number.isNaN(w))) tp.push(y !== undefined ? Math.round(y * 100) / 100 : 0);
    if (w !== undefined && !Number.isNaN(w)) tp.push(w);
    return tp;
  });
}

/** Dense control points for an open shortcut polyline with rounded corners. */
export function roundedOpen(corners: Array<[number, number, number?]>, defaultRadius = 20, step = 10): TrackPoint[] {
  const out: TrackPoint[] = [[corners[0][0], corners[0][1]]];
  for (let i = 1; i < corners.length - 1; i++) {
    const p = corners[i - 1], c = corners[i], q = corners[i + 1];
    const r = c[2] ?? defaultRadius;
    let d1x = c[0] - p[0], d1z = c[1] - p[1];
    const l1 = Math.hypot(d1x, d1z);
    d1x /= l1;
    d1z /= l1;
    let d2x = q[0] - c[0], d2z = q[1] - c[1];
    const l2 = Math.hypot(d2x, d2z);
    d2x /= l2;
    d2z /= l2;
    const cross = d1x * d2z - d1z * d2x;
    const theta = Math.acos(Math.max(-1, Math.min(1, d1x * d2x + d1z * d2z)));
    if (theta < 0.02) {
      out.push([c[0], c[1]]);
      continue;
    }
    const tl = Math.min(r * Math.tan(theta / 2), l1 * 0.45, l2 * 0.45);
    const rr = tl / Math.tan(theta / 2);
    const ax = c[0] - d1x * tl, az = c[1] - d1z * tl;
    const side = Math.sign(cross);
    const cx = ax - d1z * side * rr, cz = az + d1x * side * rr;
    const a0 = Math.atan2(ax - cx, az - cz);
    const segs = Math.max(2, Math.ceil((rr * theta) / step));
    for (let k = 0; k <= segs; k++) {
      const a = a0 - side * theta * (k / segs);
      out.push([Math.round((cx + Math.sin(a) * rr) * 10) / 10, Math.round((cz + Math.cos(a) * rr) * 10) / 10]);
    }
  }
  out.push([corners[corners.length - 1][0], corners[corners.length - 1][1]]);
  // fill long straights
  const dense: TrackPoint[] = [];
  for (let i = 0; i < out.length; i++) {
    dense.push(out[i]);
    if (i === out.length - 1) break;
    const a = out[i], b = out[i + 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(d / (step * 2.5));
    for (let j = 1; j < k; j++) dense.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return dense;
}

/**
 * Main-loop fraction where a shortcut has left the main road's walled corridor. The AI only commits
 * to a shortcut if it is off the main corridor shortly after `from`, so shortcuts should use this
 * instead of the fraction of their first point.
 */
export function shortcutExitFraction(main: TrackPoint[], shortcut: TrackPoint[], mainWallDist: number, mainWidth = 18): number {
  const m = sampleSpline(main, mainWidth, 1, true);
  const sc = sampleSpline(shortcut, 8, 1, false);
  for (const p of sc) {
    let best = Infinity, bi = 0;
    m.forEach((q, i) => {
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    });
    if (Math.sqrt(best) > mainWallDist + 1.5) return Math.max(0, bi - 1) / m.length;
  }
  return 0;
}

/**
 * Drop the part of a shortcut that runs inside the main road: the shortcut then starts just inside
 * the main corridor's wall (deviation = wallDist - inset), which is where the AI expects it to begin.
 */
export function trimShortcutStart(main: TrackPoint[], shortcut: TrackPoint[], mainWallDist: number, inset = 3, mainWidth = 18): TrackPoint[] {
  const m = sampleSpline(main, mainWidth, 1, true);
  const dist = (x: number, z: number) => {
    let best = Infinity;
    for (const q of m) best = Math.min(best, (q.x - x) ** 2 + (q.z - z) ** 2);
    return Math.sqrt(best);
  };
  // walk the dense polyline of control points
  for (let i = 0; i < shortcut.length - 1; i++) {
    const a = shortcut[i], b = shortcut[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d < len; d += 0.5) {
      const x = a[0] + ((b[0] - a[0]) * d) / len, z = a[1] + ((b[1] - a[1]) * d) / len;
      if (dist(x, z) >= mainWallDist - inset) {
        const out: TrackPoint[] = [[Math.round(x * 10) / 10, Math.round(z * 10) / 10]];
        const rest = shortcut.slice(i + 1);
        // avoid a tiny first segment
        if (rest.length > 1 && Math.hypot(rest[0][0] - x, rest[0][1] - z) < 3) rest.shift();
        return out.concat(rest);
      }
    }
  }
  return shortcut;
}

import { clamp, mod, type Vec3 } from '../../core/math';
import type { ShortcutDef, SurfaceType, TrackDef } from '../types';
import { sampleSpline } from './spline';

export interface TrackSample {
  x: number;
  y: number;
  z: number;
  tx: number; // unit tangent
  tz: number;
  nx: number; // unit right normal
  nz: number;
  halfWidth: number;
  s: number; // distance along this path
  mainS: number; // equivalent distance along the main path (for progress)
  curvature: number; // signed, + = turning right
  gap: boolean;
  slope: number; // dy/ds
}

export interface TrackPath {
  id: number;
  closed: boolean;
  length: number;
  samples: TrackSample[];
  shortcut?: ShortcutDef;
  surface: SurfaceType;
}

export interface TrackQuery {
  pathId: number;
  index: number;
  s: number;
  mainS: number;
  lateral: number;
  halfWidth: number;
  wallDist: number;
  groundY: number;
  inGap: boolean;
  surface: SurfaceType;
  onRoad: boolean;
  contained: boolean;
  nx: number;
  nz: number;
  tx: number;
  tz: number;
}

export interface RampRuntime {
  pathId: number;
  s0: number;
  s1: number;
  impulse: number;
}

const SPACING = 2;
export const RAMP_HEIGHT = 1.4;
const CELL = 18;

/** Runtime track built from a TrackDef: sampled paths, spatial grid, surface & feature lookup. */
export class Track {
  readonly def: TrackDef;
  readonly paths: TrackPath[] = [];
  readonly length: number;
  readonly checkpoints: number[];
  readonly ramps: RampRuntime[] = [];
  readonly boostPads: Array<{ pos: Vec3; yaw: number; s: number }> = [];
  readonly itemBoxPositions: Vec3[] = [];
  private grid = new Map<number, Array<number>>(); // packed pathId<<20 | index
  readonly racingLine: Float32Array;

  constructor(def: TrackDef) {
    this.def = def;
    const main = this.buildPath(0, def.points, def.width, true, undefined);
    this.paths.push(main);
    this.length = main.length;
    // gaps
    for (const g of def.gaps) {
      const a = g.from * this.length, b = g.to * this.length;
      for (const smp of main.samples) if (smp.s >= a && smp.s <= b) smp.gap = true;
    }
    def.shortcuts.forEach((sc, i) => {
      const p = this.buildPath(i + 1, sc.points, sc.width, false, sc);
      const a = sc.from * this.length;
      let b = sc.to * this.length;
      if (b < a) b += this.length;
      for (const smp of p.samples) smp.mainS = mod(a + (b - a) * (smp.s / p.length), this.length);
      this.paths.push(p);
    });
    for (const p of this.paths) {
      p.samples.forEach((smp, idx) => {
        const key = this.cellKey(smp.x, smp.z);
        let arr = this.grid.get(key);
        if (!arr) this.grid.set(key, (arr = []));
        arr.push((p.id << 20) | idx);
      });
    }
    const N = 12;
    this.checkpoints = Array.from({ length: N }, (_, i) => (i * this.length) / N);
    for (const r of def.ramps) {
      const pathId = r.shortcut ? 1 + def.shortcuts.findIndex((s) => s.id === r.shortcut) : 0;
      const L = this.paths[pathId].length;
      const s1 = r.t * L;
      this.ramps.push({ pathId, s0: s1 - (r.length ?? 8), s1, impulse: r.impulse });
    }
    for (const b of def.boostPads) {
      const smp = this.sampleAt(0, b.t * this.length);
      const hw = smp.halfWidth;
      this.boostPads.push({
        pos: { x: smp.x + smp.nx * b.lateral * hw, y: smp.y, z: smp.z + smp.nz * b.lateral * hw },
        yaw: Math.atan2(smp.tx, smp.tz),
        s: b.t * this.length,
      });
    }
    for (const t of def.itemRows) {
      const smp = this.sampleAt(0, t * this.length);
      const hw = smp.halfWidth;
      const count = hw > 8 ? 5 : 4;
      for (let i = 0; i < count; i++) {
        const l = ((i + 0.5) / count - 0.5) * 2 * hw * 0.8;
        this.itemBoxPositions.push({ x: smp.x + smp.nx * l, y: smp.y + 1.3, z: smp.z + smp.nz * l });
      }
    }
    this.racingLine = this.computeRacingLine();
  }

  private cellKey(x: number, z: number): number {
    const cx = Math.floor(x / CELL) + 2048;
    const cz = Math.floor(z / CELL) + 2048;
    return cx * 4096 + cz;
  }

  private buildPath(id: number, points: TrackDef['points'], width: number, closed: boolean, sc?: ShortcutDef): TrackPath {
    const raw = sampleSpline(points, width, SPACING, closed);
    const n = raw.length;
    const samples: TrackSample[] = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const prev = raw[closed ? mod(i - 1, n) : Math.max(0, i - 1)];
      const next = raw[closed ? mod(i + 1, n) : Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      if (i > 0) s += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
      samples.push({
        x: raw[i].x, y: raw[i].y, z: raw[i].z, tx, tz, nx: -tz, nz: tx,
        halfWidth: raw[i].w / 2, s, mainS: s, curvature: 0, gap: false, slope: 0,
      });
    }
    const length = closed ? s + Math.hypot(raw[0].x - raw[n - 1].x, raw[0].z - raw[n - 1].z) : s;
    // curvature and slope
    for (let i = 0; i < n; i++) {
      const a = samples[closed ? mod(i - 2, n) : Math.max(0, i - 2)];
      const b = samples[closed ? mod(i + 2, n) : Math.min(n - 1, i + 2)];
      const ya = Math.atan2(a.tx, a.tz), yb = Math.atan2(b.tx, b.tz);
      let d = yb - ya;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const ds = closed ? 4 * SPACING : Math.max(1, Math.abs(b.s - a.s));
      // yaw decreasing = turning right (see rightOf)
      samples[i].curvature = -d / ds;
      samples[i].slope = (b.y - a.y) / ds;
    }
    return { id, closed, length, samples, shortcut: sc, surface: sc?.surface ?? 'road' };
  }

  /** Interpolated sample at distance s along a path. */
  sampleAt(pathId: number, s: number): TrackSample {
    const p = this.paths[pathId];
    const n = p.samples.length;
    if (p.closed) s = mod(s, p.length);
    else s = clamp(s, 0, p.length);
    const step = p.length / (p.closed ? n : n - 1);
    const f = s / step;
    const i0 = Math.min(Math.floor(f), p.closed ? n - 1 : n - 2);
    const i1 = p.closed ? (i0 + 1) % n : i0 + 1;
    const t = f - i0;
    const a = p.samples[i0], b = p.samples[i1];
    let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    return {
      x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, tx, tz, nx: -tz, nz: tx,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t, s, mainS: a.mainS, curvature: a.curvature + (b.curvature - a.curvature) * t,
      gap: a.gap || b.gap, slope: a.slope,
    };
  }

  /** World point on a path at distance s with lateral offset (meters, + = right). */
  pointAt(pathId: number, s: number, lateral = 0): Vec3 {
    const smp = this.sampleAt(pathId, s);
    return { x: smp.x + smp.nx * lateral, y: smp.y, z: smp.z + smp.nz * lateral };
  }

  surfaceAt(pathId: number, s: number, lateral: number, halfWidth: number): SurfaceType {
    if (pathId !== 0) {
      const sc = this.paths[pathId];
      if (Math.abs(lateral) > halfWidth) return 'offroad';
      return sc.surface;
    }
    const t = s / this.length;
    for (const r of this.def.surfaces) {
      const inRange = r.from <= r.to ? t >= r.from && t <= r.to : t >= r.from || t <= r.to;
      if (!inRange) continue;
      if (r.side === 'left' && lateral > 0) continue;
      if (r.side === 'right' && lateral < 0) continue;
      if (r.type === 'offroad' || Math.abs(lateral) <= halfWidth) return r.type;
    }
    return Math.abs(lateral) > halfWidth ? 'offroad' : 'road';
  }

  /**
   * Project a world position onto the track. Picks the path whose corridor contains the point,
   * preferring the hinted path, so shortcuts and the main road can overlap at their junctions.
   */
  query(pos: Vec3, hintPath = 0): TrackQuery | null {
    const best: Array<{ d: number; idx: number } | undefined> = [];
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const arr = this.grid.get((cx + ox + 2048) * 4096 + (cz + oz + 2048));
        if (!arr) continue;
        for (const packed of arr) {
          const pid = packed >> 20, idx = packed & 0xfffff;
          const smp = this.paths[pid].samples[idx];
          const dx = pos.x - smp.x, dz = pos.z - smp.z;
          let dy = pos.y - smp.y;
          if (smp.gap) dy = 0;
          let d = dx * dx + dz * dz;
          if (Math.abs(dy) > 4) d += (Math.abs(dy) - 4) * (Math.abs(dy) - 4) * 9;
          const b = best[pid];
          if (!b || d < b.d) best[pid] = { d, idx };
        }
      }
    }
    let chosen: TrackQuery | null = null;
    let fallback: TrackQuery | null = null;
    for (let pid = 0; pid < best.length; pid++) {
      const b = best[pid];
      if (!b) continue;
      const q = this.project(pid, b.idx, pos);
      if (q.contained) {
        if (!chosen || pid === hintPath || (chosen.pathId !== hintPath && pid === 0)) chosen = q;
      }
      if (!fallback || pid === hintPath) fallback = q;
    }
    return chosen ?? fallback;
  }

  private project(pathId: number, idx: number, pos: Vec3): TrackQuery {
    const p = this.paths[pathId];
    const n = p.samples.length;
    let smp = p.samples[idx];
    let along = (pos.x - smp.x) * smp.tx + (pos.z - smp.z) * smp.tz;
    // use the neighbour segment for interpolation
    let j = along >= 0 ? idx + 1 : idx - 1;
    if (p.closed) j = mod(j, n);
    if (j < 0 || j >= n) j = idx;
    const nb = p.samples[j];
    const segLen = Math.hypot(nb.x - smp.x, nb.z - smp.z) || 1;
    const f = clamp(Math.abs(along) / segLen, 0, 1);
    const hw = smp.halfWidth + (nb.halfWidth - smp.halfWidth) * f;
    const y = smp.y + (nb.y - smp.y) * f;
    const lateral = (pos.x - smp.x) * smp.nx + (pos.z - smp.z) * smp.nz;
    let s = smp.s + along;
    if (p.closed) s = mod(s, p.length);
    else s = clamp(s, 0, p.length);
    const mainS = pathId === 0 ? s : mod(smp.mainS + (nb.mainS - smp.mainS) * f, this.length);
    if (Math.abs(along) > segLen * 2 && !p.closed && (idx === 0 || idx === n - 1)) {
      // beyond the open ends of a shortcut => not contained
      smp = p.samples[idx];
    }
    const wallDist = hw + this.def.shoulder;
    const beyondEnd = !p.closed && ((idx === 0 && along < -1) || (idx === n - 1 && along > 1));
    const contained = Math.abs(lateral) <= wallDist && !beyondEnd;
    const inGap = smp.gap && nb.gap && Math.abs(lateral) <= wallDist + 4;
    let rampY = 0;
    for (const r of this.ramps) {
      if (r.pathId === pathId && s >= r.s0 && s <= r.s1 && Math.abs(lateral) <= hw) rampY = RAMP_HEIGHT * ((s - r.s0) / (r.s1 - r.s0));
    }
    return {
      pathId, index: idx, s, mainS, lateral, halfWidth: hw, wallDist, groundY: inGap ? -40 : y + rampY, inGap,
      surface: this.surfaceAt(pathId, s, lateral, hw), onRoad: Math.abs(lateral) <= hw, contained,
      nx: smp.nx, nz: smp.nz, tx: smp.tx, tz: smp.tz,
    };
  }

  /** Lateral racing-line offset (m) per main-path sample: hug the inside of corners. */
  private computeRacingLine(): Float32Array {
    const main = this.paths[0];
    const n = main.samples.length;
    const out = new Float32Array(n);
    const win = 14;
    for (let i = 0; i < n; i++) {
      let c = 0, wsum = 0;
      for (let k = -win; k <= win; k++) {
        const w = 1 - Math.abs(k) / (win + 1);
        c += main.samples[mod(i + k + 4, n)].curvature * w; // slightly ahead => late apex
        wsum += w;
      }
      c /= wsum;
      const hw = main.samples[i].halfWidth;
      // + curvature = turning right => inside is right (+ lateral)
      out[i] = clamp(c * 40, -0.6, 0.6) * hw;
    }
    // smooth result
    const sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let k = -6; k <= 6; k++) a += out[mod(i + k, n)];
      sm[i] = a / 13;
    }
    return sm;
  }

  racingLineAt(s: number): number {
    const n = this.racingLine.length;
    const f = (mod(s, this.length) / this.length) * n;
    const i = Math.floor(f) % n;
    const t = f - Math.floor(f);
    return this.racingLine[i] * (1 - t) + this.racingLine[(i + 1) % n] * t;
  }

  /** Grid slots behind the start line: two columns, staggered. */
  startGrid(count: number): Array<{ pos: Vec3; yaw: number; s: number }> {
    const out = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const s = this.length - 6 - row * 7 - col * 3;
      const smp = this.sampleAt(0, s);
      const lat = (col === 0 ? -1 : 1) * smp.halfWidth * 0.35;
      out.push({
        pos: { x: smp.x + smp.nx * lat, y: smp.y + 0.05, z: smp.z + smp.nz * lat },
        yaw: Math.atan2(smp.tx, smp.tz),
        s,
      });
    }
    return out;
  }
}

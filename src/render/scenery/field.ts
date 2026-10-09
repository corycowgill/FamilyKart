import type { Track, TrackSample } from '../../sim/track/Track';

/** A water/drop channel cut into the terrain (river under a gap jump, kitchen aisle...). */
export interface Channel {
  cx: number;
  cz: number;
  /** unit axis along the channel's length */
  ax: number;
  az: number;
  halfLen: number;
  halfWidth: number;
  depth: number;
}

export interface Nearest {
  pathId: number;
  sample: TrackSample;
  dist: number;
  /** planar distance minus wall distance (negative = inside corridor) */
  clearance: number;
}

const CELL = 16;

function hash(x: number, z: number): number {
  let h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in 0..1. */
export function fbm(x: number, z: number, oct = 3): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x * f, z * f) * a;
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/**
 * Spatial helper around a runtime Track for rendering: nearest corridor lookup (for scattering props
 * outside the walls), terrain height (blends from road elevation to theme hills, cuts channels).
 */
export class TrackField {
  readonly track: Track;
  readonly shoulder: number;
  readonly channels: Channel[] = [];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** x beyond which terrain drops into a lake (Infinity = none) */
  readonly shoreX: number;
  private grid = new Map<number, number[]>();
  private hills: number;

  constructor(track: Track) {
    this.track = track;
    this.shoulder = track.def.shoulder;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of track.paths) {
      p.samples.forEach((s, i) => {
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minZ = Math.min(minZ, s.z);
        maxZ = Math.max(maxZ, s.z);
        const k = this.key(Math.floor(s.x / CELL), Math.floor(s.z / CELL));
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push((p.id << 20) | i);
      });
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    const def = track.def;
    this.hills = def.theme === 'dogpark' ? 7 : def.theme === 'snow' ? 1.2 : def.theme === 'neighborhood' ? 0.4 : 0;
    const shore = def.landmarks.find((l) => l.kind === 'shore');
    this.shoreX = shore ? shore.x : Infinity;
    // channels: explicit landmarks, otherwise one per gap
    const main = track.paths[0];
    const gapCenters: Array<{ smp: TrackSample; len: number }> = [];
    for (const g of def.gaps) {
      const a = g.from * track.length, b = g.to * track.length;
      gapCenters.push({ smp: track.sampleAt(0, (a + b) / 2), len: b - a });
    }
    const depthFor = def.theme === 'kitchen' ? -60 : -7;
    for (const l of def.landmarks) {
      if (l.kind !== 'river' && l.kind !== 'channel') continue;
      const rot = l.rot ?? 0;
      let hw = 9;
      let best = Infinity;
      for (const gc of gapCenters) {
        const d = Math.hypot(gc.smp.x - l.x, gc.smp.z - l.z);
        if (d < best && d < 40) {
          best = d;
          hw = gc.len / 2 + 0.5;
        }
      }
      this.channels.push({ cx: l.x, cz: l.z, ax: Math.cos(rot), az: Math.sin(rot), halfLen: l.scale ?? 60, halfWidth: hw, depth: l.y ?? depthFor });
    }
    for (const gc of gapCenters) {
      const covered = this.channels.some((c) => Math.abs((gc.smp.x - c.cx) * -c.az + (gc.smp.z - c.cz) * c.ax) < c.halfWidth + 2 && Math.abs((gc.smp.x - c.cx) * c.ax + (gc.smp.z - c.cz) * c.az) < c.halfLen);
      if (!covered) {
        this.channels.push({ cx: gc.smp.x, cz: gc.smp.z, ax: gc.smp.nx, az: gc.smp.nz, halfLen: 50, halfWidth: gc.len / 2 + 0.5, depth: depthFor });
      }
    }
    void main;
  }

  private key(cx: number, cz: number): number {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  /** Nearest track sample over all paths (planar), searching up to `maxR` meters. */
  nearest(x: number, z: number, maxR = 64): Nearest | null {
    const r = Math.ceil(maxR / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best: Nearest | null = null;
    let bestC = Infinity;
    for (let ox = -r; ox <= r; ox++) {
      for (let oz = -r; oz <= r; oz++) {
        const arr = this.grid.get(this.key(cx + ox, cz + oz));
        if (!arr) continue;
        for (const packed of arr) {
          const pid = packed >> 20, idx = packed & 0xfffff;
          const s = this.track.paths[pid].samples[idx];
          const d = Math.hypot(x - s.x, z - s.z);
          const c = d - (s.halfWidth + this.shoulder);
          if (c < bestC) {
            bestC = c;
            best = { pathId: pid, sample: s, dist: d, clearance: c };
          }
        }
      }
    }
    return best;
  }

  /**
   * True when (x,z) lies inside the walled corridor of a path other than `exclude`
   * (projected laterally onto that path, not beyond the open ends of shortcuts).
   */
  insideOther(x: number, z: number, exclude: number, margin = 0): boolean {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const best = new Map<number, { d: number; idx: number }>();
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const arr = this.grid.get(this.key(cx + ox, cz + oz));
        if (!arr) continue;
        for (const packed of arr) {
          const pid = packed >> 20;
          if (pid === exclude) continue;
          const idx = packed & 0xfffff;
          const s = this.track.paths[pid].samples[idx];
          const d = (x - s.x) ** 2 + (z - s.z) ** 2;
          const b = best.get(pid);
          if (!b || d < b.d) best.set(pid, { d, idx });
        }
      }
    }
    for (const [pid, b] of best) {
      const p = this.track.paths[pid];
      const s = p.samples[b.idx];
      const along = (x - s.x) * s.tx + (z - s.z) * s.tz;
      const lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
      if (!p.closed && ((b.idx === 0 && along < -0.5) || (b.idx === p.samples.length - 1 && along > 0.5))) continue;
      if (Math.abs(along) > 3) continue;
      if (Math.abs(lat) < s.halfWidth + this.shoulder - margin) return true;
    }
    return false;
  }

  /** Distance outside the nearest wall (large positive when far away). */
  clearance(x: number, z: number, maxR = 64): number {
    const n = this.nearest(x, z, maxR);
    return n ? n.clearance : maxR;
  }

  /** Is (x,z) inside any channel? returns depth factor 0..1 */
  channelAt(x: number, z: number): { c: Channel; f: number } | null {
    for (const c of this.channels) {
      const dx = x - c.cx, dz = z - c.cz;
      const along = dx * c.ax + dz * c.az;
      const across = -dx * c.az + dz * c.ax;
      const ea = c.halfLen - Math.abs(along);
      const ew = c.halfWidth - Math.abs(across);
      if (ea > -3 && ew > -3) {
        const f = Math.min(1, Math.max(0, (Math.min(ea, ew) + 3) / 3));
        return { c, f };
      }
    }
    return null;
  }

  /** Natural terrain height (theme hills) without the track's influence. */
  natural(x: number, z: number): number {
    let h = 0;
    if (this.hills > 0) {
      h = (fbm(x * 0.012 + 3.1, z * 0.012 - 1.7, 3) - 0.45) * this.hills * 2;
      h += Math.sin(x * 0.021) * Math.cos(z * 0.017) * this.hills * 0.5;
    }
    // fade hills out towards the edge of the rendered terrain
    const b = this.bounds;
    const edge = Math.min(x - (b.minX - 170), b.maxX + 170 - x, z - (b.minZ - 170), b.maxZ + 170 - z);
    h *= Math.max(0, Math.min(1, edge / 80));
    if (x > this.shoreX) h = Math.min(h, -4);
    else if (x > this.shoreX - 6) h = Math.min(h, h + (-0.6 - h) * ((x - this.shoreX + 6) / 6));
    return h;
  }

  /** Terrain height including the road bed (road y - 0.3 under the corridor) and channels. */
  height(x: number, z: number): number {
    let h = this.natural(x, z);
    const n = this.nearest(x, z, 48);
    if (n) {
      const roadY = n.sample.y - 0.3;
      const c = n.clearance;
      if (c < 1.5) h = roadY;
      else if (c < 30) {
        const t = (c - 1.5) / 28.5;
        const st = t * t * (3 - 2 * t);
        h = roadY + (h - roadY) * st;
      }
    }
    const ch = this.channelAt(x, z);
    if (ch) h = Math.min(h, h + (ch.c.depth - h) * ch.f);
    return h;
  }
}

const cache = new WeakMap<Track, TrackField>();
/** Shared TrackField per runtime Track (TrackView and scenery use the same instance). */
export function getField(track: Track): TrackField {
  let f = cache.get(track);
  if (!f) cache.set(track, (f = new TrackField(track)));
  return f;
}

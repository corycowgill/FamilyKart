import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { Rng } from '../../core/rng';
import { M, mergeColored } from './common';
import type { Sway } from './materials';

/*
 * Detailed, stylised prop geometry (vertex coloured, merged per prop, meant for instancing):
 * bevelled boxes, lush multi-lobe trees with baked "dark core -> sunlit tips" colour gradients,
 * bushes, flower beds, grass tufts, marram grass, Chicago acorn lamps, benches, trash cans,
 * hydrants, newspaper boxes, CTA bus shelters with ads, Divvy-style bikes, parked cars with real
 * shape, crowd figures with waving arms, tire stacks and scalloped awnings.
 *
 * Pure-white (#ffffff) vertices are the tintable parts (tintMaskMat / crowdMaterial conventions).
 * Geometries that should sway in the wind carry userData.sway (see Batch.build).
 */

export type Q = 'low' | 'medium' | 'high';
type Parts = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;

/* ------------------------------------------------------------------ primitives */

const chamferCache = new Map<string, THREE.BufferGeometry>();

/**
 * Box with chamfered (45 degree) edges and flat-shaded facets so highlights catch every edge.
 * Centred on the origin, 44 triangles.
 */
export function bevelBox(w: number, h: number, d: number, r = Math.min(w, h, d) * 0.18): THREE.BufferGeometry {
  r = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r.toFixed(3)}`;
  let g = chamferCache.get(key);
  if (!g) {
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const pts: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * hx, sy * (hy - r), sz * (hz - r)));
      pts.push(new THREE.Vector3(sx * (hx - r), sy * hy, sz * (hz - r)));
      pts.push(new THREE.Vector3(sx * (hx - r), sy * (hy - r), sz * hz));
    }
    g = new ConvexGeometry(pts);
    // box-projected uvs in metres (facade-friendly)
    const pos = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i));
      const x = pos.getX(i) + hx, y = pos.getY(i) + hy, z = pos.getZ(i) + hz;
      if (ay > 0.7) uv.set([x, z], i * 2);
      else if (ax > 0.7) uv.set([z, y], i * 2);
      else uv.set([x, y], i * 2);
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    chamferCache.set(key, g);
  }
  return g.clone();
}

/** Lathe from a (radius, y) profile, `seg` sides. */
export function lathe(profile: Array<[number, number]>, seg = 10): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y)), seg);
}

/** Cylinder between two points. */
export function tube(a: readonly number[], b: readonly number[], r: number, seg = 6): [THREE.BufferGeometry, THREE.Matrix4] {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  return [new THREE.CylinderGeometry(r, r, Math.max(1e-3, len), seg, 1), m];
}

/** Merge geometries that already carry a colour attribute with mergeColored parts. */
export function mergeVC(pre: THREE.BufferGeometry[], parts: Parts = []): THREE.BufferGeometry {
  const all: THREE.BufferGeometry[] = [];
  for (const g0 of pre) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    all.push(g);
  }
  if (parts.length) all.push(mergeColored(parts));
  const out = mergeGeometries(all, false)!;
  all.forEach((g) => g.dispose());
  pre.forEach((g) => g.dispose());
  out.computeBoundingSphere();
  return out;
}

const _c = new THREE.Color(), _c2 = new THREE.Color();

/** Deterministic smooth-ish 3D value noise for organic displacement. */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}

/* ------------------------------------------------------------------ foliage */

export interface Lobe { x: number; y: number; z: number; r: number; sy?: number }

/**
 * Soft volumetric foliage clumps: displaced icosphere lobes with smooth normals and a baked colour
 * gradient from a dark, cool core to warm sunlit tips (plus per-lobe hue variation).
 */
export function canopy(lobes: Lobe[], dark: THREE.ColorRepresentation, light: THREE.ColorRepresentation, detail: number, seed = 1, o: { center?: THREE.Vector3; bumpy?: number; tips?: THREE.ColorRepresentation; soft?: number } = {}): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const center = o.center ?? new THREE.Vector3(
    lobes.reduce((a, l) => a + l.x, 0) / lobes.length,
    lobes.reduce((a, l) => a + l.y, 0) / lobes.length,
    lobes.reduce((a, l) => a + l.z, 0) / lobes.length,
  );
  const minY = Math.min(...lobes.map((l) => l.y - l.r)), maxY = Math.max(...lobes.map((l) => l.y + l.r * (l.sy ?? 1)));
  const cDark = new THREE.Color(dark), cLight = new THREE.Color(light), cTip = new THREE.Color(o.tips ?? light).lerp(new THREE.Color('#fff6c8'), 0.18);
  const sun = new THREE.Vector3(0.35, 1, 0.25).normalize();
  const geos: THREE.BufferGeometry[] = [];
  const n = new THREE.Vector3(), p = new THREE.Vector3(), out = new THREE.Vector3();
  for (const l of lobes) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const hueJ = rng.range(-0.025, 0.025), litJ = rng.range(-0.05, 0.05);
    const ox = rng.next() * 10, oz = rng.next() * 10;
    for (let i = 0; i < pos.count; i++) {
      n.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      const bump = (vnoise3(n.x * 2.2 + ox, n.y * 2.2, n.z * 2.2 + oz) - 0.5) * (o.bumpy ?? 0.32);
      const flat = n.y < -0.25 ? 0.72 : 1; // flatter underside
      p.set(n.x * l.r * (1 + bump), n.y * l.r * (l.sy ?? 1) * (1 + bump) * flat, n.z * l.r * (1 + bump)).add(_v.set(l.x, l.y, l.z));
      pos.setXYZ(i, p.x, p.y, p.z);
      out.copy(p).sub(center).normalize();
      // soft volumetric shading: lobe normal bent toward the whole clump's outward direction
      _n2.copy(n).lerp(out, o.soft ?? 0.55).normalize();
      nrm.setXYZ(i, _n2.x, _n2.y, _n2.z);
      const s = Math.max(0, n.dot(sun));
      const outward = Math.max(0, n.dot(out));
      const hf = (p.y - minY) / Math.max(0.01, maxY - minY);
      let t = 0.08 + 0.42 * s + 0.3 * hf + 0.25 * outward;
      t = Math.min(1, Math.max(0, t));
      _c.copy(cDark).lerp(cLight, Math.min(1, t * 1.25));
      if (t > 0.78) _c.lerp(cTip, (t - 0.78) / 0.22 * 0.6);
      _c.offsetHSL(hueJ, 0, litJ);
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }
  const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false)!;
  geos.forEach((g) => g.dispose());
  return merged;
}
const _v = new THREE.Vector3(), _n2 = new THREE.Vector3();

const detailFor = (q: Q, near = true) => (q === 'high' ? (near ? 2 : 0) : q === 'medium' ? (near ? 1 : 0) : 0);

/** Deciduous park tree (~8.5 m): flared trunk, three branches into a 3-7 lobe canopy. */
export function lushTree(leaf: string, leaf2: string, trunk: string, q: Q, o: { seed?: number; far?: boolean; shape?: 'round' | 'tall' | 'wide'; detail?: number } = {}): THREE.BufferGeometry {
  const seed = o.seed ?? 7;
  const rng = new Rng(seed);
  const far = !!o.far || q === 'low';
  const shape = o.shape ?? 'round';
  const sx = shape === 'wide' ? 1.25 : shape === 'tall' ? 0.82 : 1;
  const sy = shape === 'tall' ? 1.2 : 1;
  const parts: Parts = [];
  const trunkC = new THREE.Color(trunk);
  const bark2 = trunkC.clone().multiplyScalar(0.72);
  if (far) {
    parts.push([new THREE.CylinderGeometry(0.26, 0.42, 4.2, 5), trunk, M.t(0, 2.1, 0)]);
  } else {
    parts.push([lathe([[0.6, 0], [0.45, 0.25], [0.36, 0.7], [0.3, 2.2], [0.26, 3.6], [0.2, 4.6]], q === 'high' ? 8 : 6), trunk]);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const y0 = 2.8 + i * 0.35;
      const [g, m] = tube([0, y0, 0], [Math.cos(a) * 1.5 * sx, y0 + 1.7 * sy, Math.sin(a) * 1.5 * sx], 0.11, 5);
      parts.push([g, i % 2 ? trunk : bark2, m]);
    }
  }
  const lobes: Lobe[] = [{ x: 0, y: 5.5 * sy, z: 0, r: 2.35 * sx, sy: 0.92 }];
  const ring = far ? 3 : q === 'high' ? 6 : 4;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rr = rng.range(1.3, 1.75) * sx;
    lobes.push({ x: Math.cos(a) * 1.55 * sx, y: (rng.range(4.7, 6.1)) * sy, z: Math.sin(a) * 1.55 * sx, r: rr, sy: 0.9 });
  }
  if (!far) lobes.push({ x: rng.range(-0.4, 0.4), y: 7.05 * sy, z: rng.range(-0.4, 0.4), r: 1.45 * sx });
  const dark = new THREE.Color(leaf).multiplyScalar(0.5).offsetHSL(0.03, 0.05, 0);
  const geo = mergeVC([canopy(lobes, dark, leaf2, far ? 0 : o.detail ?? detailFor(q), seed, { tips: leaf2 })], parts);
  geo.userData.sway = { from: 2.5, to: 8.5, amp: 0.22, flutter: 0.25 } satisfies Sway;
  return geo;
}

/** Conifer with drooping, jagged tiers (optional snow on each tier). */
export function lushPine(leaf: string, trunk: string, q: Q, snow?: string, o: { far?: boolean; seed?: number } = {}): THREE.BufferGeometry {
  const far = !!o.far || q === 'low';
  const rng = new Rng(o.seed ?? 3);
  const seg = far ? 7 : q === 'high' ? 14 : 10;
  const parts: Parts = [[new THREE.CylinderGeometry(0.2, 0.34, 2.4, far ? 5 : 7), trunk, M.t(0, 1.2, 0)]];
  const pre: THREE.BufferGeometry[] = [];
  const tiers = far ? 3 : 5;
  const base = new THREE.Color(leaf);
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const r = 2.8 - f * 1.9, h = 3.2 - f * 0.9, y = 2.0 + f * 5.6;
    const g = new THREE.ConeGeometry(r, h, seg, 2, true).toNonIndexed();
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const a = Math.atan2(pz, px);
      const k = Math.round(((a / (Math.PI * 2)) * seg) + seg) % seg;
      let ny = py;
      if (py < -h / 2 + 0.01) ny -= (k % 2 ? 0.45 : 0) + rng.range(0, 0.1); // jagged drooping skirt
      pos.setY(i, ny + y);
      const lt = (py + h / 2) / h; // 0 bottom .. 1 tip
      _c.copy(base).multiplyScalar(0.55 + 0.35 * (1 - lt) * 0.2 + 0.45 * Math.min(1, (Math.hypot(px, pz) / r) * 0.6 + f * 0.4));
      if (k % 2 === 0 && lt < 0.05) _c.multiplyScalar(1.15);
      col.set([_c.r, _c.g, _c.b], i * 3);
    }
    g.computeVertexNormals();
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    pre.push(g);
    if (snow) {
      const sg = new THREE.ConeGeometry(r * 0.62, h * 0.42, seg, 1, true).translate(0, y + h * 0.27, 0);
      parts.push([sg, snow]);
    }
  }
  // underside discs so the tiers read as solid from below
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    parts.push([new THREE.CircleGeometry(2.8 - f * 1.9, seg).rotateX(Math.PI / 2), base.clone().multiplyScalar(0.35), M.t(0, 2.0 + f * 5.6 - (3.2 - f * 0.9) / 2 - 0.2, 0)]);
  }
  const geo = mergeVC(pre, parts);
  geo.userData.sway = { from: 2, to: 9, amp: 0.12, flutter: 0.1 } satisfies Sway;
  return geo;
}

/** Low leafy bush, 3-5 lobes. */
export function lushBush(c1: string, c2: string, q: Q, seed = 5): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const n = q === 'high' ? 5 : q === 'medium' ? 4 : 3;
  const lobes: Lobe[] = [{ x: 0, y: 0.75, z: 0, r: 1.15, sy: 0.8 }];
  for (let i = 1; i < n; i++) {
    const a = (i / (n - 1)) * Math.PI * 2 + rng.range(-0.4, 0.4);
    lobes.push({ x: Math.cos(a) * 0.95, y: rng.range(0.55, 0.85), z: Math.sin(a) * 0.75, r: rng.range(0.7, 0.95), sy: 0.85 });
  }
  const geo = canopy(lobes, new THREE.Color(c1).multiplyScalar(0.55), c2, q === 'low' ? 0 : 1, seed, { center: new THREE.Vector3(0, 0.3, 0) });
  const out = mergeVC([geo]);
  out.userData.sway = { from: 0.4, to: 1.8, amp: 0.06, flutter: 0.4 } satisfies Sway;
  return out;
}

/** Raised flower bed: stone curb ring, soil, a leafy mound and flower heads (white = tinted). */
export function flowerBed(q: Q, r = 2.2, seed = 9): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const parts: Parts = [
    [lathe([[r + 0.25, 0], [r + 0.3, 0.32], [r + 0.18, 0.45], [r - 0.02, 0.45], [r - 0.08, 0.3]], q === 'high' ? 20 : 12), '#cfc6b4'],
    [new THREE.CircleGeometry(r - 0.05, 16).rotateX(-Math.PI / 2), '#5a3a22', M.t(0, 0.36, 0)],
  ];
  const mound = canopy([{ x: 0, y: 0.25, z: 0, r: r * 0.92, sy: 0.32 }], '#2f6f2a', '#6fbf4f', q === 'low' ? 0 : 1, seed, { center: new THREE.Vector3(0, -0.5, 0), bumpy: 0.5 });
  const n = q === 'high' ? 34 : q === 'medium' ? 18 : 8;
  for (let i = 0; i < n; i++) {
    const a = rng.next() * Math.PI * 2, d = Math.sqrt(rng.next()) * r * 0.85;
    const y = 0.42 + 0.3 * Math.sqrt(Math.max(0, 1 - (d / r) ** 2));
    parts.push([new THREE.IcosahedronGeometry(rng.range(0.13, 0.2), 0), i % 5 === 0 ? '#ffe14d' : '#ffffff', M.t(Math.cos(a) * d, y, Math.sin(a) * d)]);
  }
  return mergeVC([mound], parts);
}

/** Grass tuft: 5-7 tapered, bent blades (dark base -> light tips). ~0.6 m. */
export function grassTuft(base: string, tip: string, q: Q, o: { h?: number; blades?: number; seed?: number; spread?: number } = {}): THREE.BufferGeometry {
  const rng = new Rng(o.seed ?? 11);
  const n = o.blades ?? (q === 'high' ? 7 : 5);
  const H = o.h ?? 0.6, sp = o.spread ?? 0.18;
  const pos: number[] = [], col: number[] = [], nrm: number[] = [];
  const cb = new THREE.Color(base), ct = new THREE.Color(tip);
  for (let i = 0; i < n; i++) {
    const a = rng.next() * Math.PI * 2, d = rng.range(0, sp);
    const x0 = Math.cos(a) * d, z0 = Math.sin(a) * d;
    const lean = rng.range(0.15, 0.45), la = a + rng.range(-0.6, 0.6);
    const h = H * rng.range(0.65, 1.1), w = rng.range(0.035, 0.06) * (H / 0.6);
    const px = -Math.sin(la), pz = Math.cos(la); // blade width direction
    const seg = q === 'high' ? 3 : 2;
    const pts: Array<[number, number, number, number]> = [];
    for (let s = 0; s <= seg; s++) {
      const t = s / seg;
      const bend = lean * t * t * h;
      pts.push([x0 + Math.cos(la) * bend, t * h, z0 + Math.sin(la) * bend, w * (1 - t * 0.92)]);
    }
    const nx = Math.cos(la), nz = Math.sin(la);
    for (let s = 0; s < seg; s++) {
      const [ax, ay, az, aw] = pts[s], [bx, by, bz, bw] = pts[s + 1];
      const quad = [[ax - px * aw, ay, az - pz * aw], [ax + px * aw, ay, az + pz * aw], [bx - px * bw, by, bz - pz * bw], [bx + px * bw, by, bz + pz * bw]];
      for (const k of [0, 1, 2, 2, 1, 3]) {
        pos.push(...quad[k]);
        nrm.push(nx * 0.4, 0.9, nz * 0.4);
        const t = quad[k][1] / h;
        _c2.copy(cb).lerp(ct, Math.min(1, t * 1.2));
        col.push(_c2.r, _c2.g, _c2.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.computeBoundingSphere();
  g.userData.sway = { from: 0, to: H, amp: H * 0.12, flutter: 0.6 } satisfies Sway;
  return g;
}

/* ------------------------------------------------------------------ street furniture */

/** Chicago "acorn" street lamp (~5 m): fluted base, slim pole, collar, glowing acorn globe. */
export function acornLamp(pole = '#20262e', glow = '#fff3c4', q: Q = 'high'): THREE.BufferGeometry {
  const s = q === 'high' ? 10 : 8;
  const parts: Parts = [
    [lathe([[0.36, 0], [0.36, 0.12], [0.3, 0.2], [0.28, 0.9], [0.22, 1.05], [0.17, 1.15]], s), pole],
    [new THREE.CylinderGeometry(0.09, 0.12, 3.4, s), pole, M.t(0, 2.8, 0)],
    [lathe([[0.1, 0], [0.2, 0.05], [0.24, 0.15], [0.16, 0.25], [0.2, 0.35], [0.12, 0.4]], s), pole, M.t(0, 4.45, 0)],
    [lathe([[0.12, 0], [0.28, 0.12], [0.34, 0.38], [0.3, 0.62], [0.18, 0.8], [0.06, 0.88]], s), glow, M.t(0, 4.85, 0)],
    [lathe([[0.2, 0], [0.24, 0.04], [0.12, 0.16], [0.03, 0.34]], s), pole, M.t(0, 5.68, 0)],
  ];
  if (q === 'high') for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    parts.push([new THREE.BoxGeometry(0.04, 0.85, 0.04), pole, M.trs(Math.cos(a) * 0.3, 5.25, Math.sin(a) * 0.3, Math.sin(a) * 0.15, 0, -Math.cos(a) * 0.15)]);
  }
  return mergeColored(parts);
}

/** Park bench: cast-iron ends + wooden slats. Faces +Z (sit facing +Z). */
export function parkBench(wood = '#a8713f', iron = '#23292f'): THREE.BufferGeometry {
  const parts: Parts = [];
  for (const x of [-0.95, 0.95]) {
    parts.push([bevelBox(0.09, 0.48, 0.55, 0.03), iron, M.t(x, 0.24, 0.02)]);
    parts.push([bevelBox(0.08, 0.6, 0.1, 0.02), iron, M.trs(x, 0.75, -0.25, -0.22, 0, 0)]);
    parts.push([bevelBox(0.08, 0.08, 0.55, 0.02), iron, M.t(x, 0.62, 0.05)]);
  }
  for (let i = 0; i < 4; i++) parts.push([bevelBox(2.15, 0.05, 0.13, 0.02), wood, M.t(0, 0.5, 0.24 - i * 0.15)]);
  for (let i = 0; i < 3; i++) parts.push([bevelBox(2.15, 0.12, 0.04, 0.015), wood, M.trs(0, 0.66 + i * 0.16, -0.24 - i * 0.035, -0.22, 0, 0)]);
  return mergeColored(parts);
}

/** Chicago-style ribbed trash can with lid. */
export function trashCan(body = '#2a3a2f'): THREE.BufferGeometry {
  const parts: Parts = [
    [new THREE.CylinderGeometry(0.33, 0.3, 0.95, 12), body, M.t(0, 0.5, 0)],
    [lathe([[0.36, 0], [0.37, 0.06], [0.3, 0.14], [0.1, 0.2], [0.02, 0.22]], 12), '#1d2622', M.t(0, 0.97, 0)],
    [new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12), '#1d2622', M.t(0, 0.05, 0)],
  ];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    parts.push([new THREE.BoxGeometry(0.04, 0.85, 0.04), '#3f5446', M.trs(Math.cos(a) * 0.325, 0.5, Math.sin(a) * 0.325, 0, -a, 0)]);
  }
  return mergeColored(parts);
}

/** Fire hydrant (red body, silver bonnet & nozzle caps). */
export function hydrant(body = '#d8342c', cap = '#d6d9de'): THREE.BufferGeometry {
  return mergeColored([
    [lathe([[0.3, 0], [0.3, 0.08], [0.22, 0.12], [0.2, 0.7], [0.24, 0.74], [0.24, 0.8]], 12), body],
    [lathe([[0.24, 0], [0.23, 0.1], [0.16, 0.22], [0.06, 0.3], [0.06, 0.38], [0.0, 0.4]], 12), cap, M.t(0, 0.8, 0)],
    [new THREE.CylinderGeometry(0.09, 0.09, 0.62, 10).rotateZ(Math.PI / 2), body, M.t(0, 0.55, 0)],
    [new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8).rotateZ(Math.PI / 2), cap, M.t(0.32, 0.55, 0)],
    [new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8).rotateZ(Math.PI / 2), cap, M.t(-0.32, 0.55, 0)],
    [new THREE.CylinderGeometry(0.12, 0.12, 0.16, 10).rotateX(Math.PI / 2), body, M.t(0, 0.5, 0.24)],
    [new THREE.CylinderGeometry(0.13, 0.13, 0.05, 8).rotateX(Math.PI / 2), cap, M.t(0, 0.5, 0.33)],
  ]);
}

/** Row of three newspaper boxes. Faces +Z. */
export function newsBoxes(): THREE.BufferGeometry {
  const parts: Parts = [];
  ['#d23a2f', '#1f5fbf', '#f2c230'].forEach((c, i) => {
    const x = (i - 1) * 0.62;
    parts.push([bevelBox(0.55, 0.75, 0.5, 0.04), c, M.t(x, 0.72, 0)]);
    parts.push([bevelBox(0.4, 0.3, 0.04, 0.01), '#2a3a52', M.t(x, 0.8, 0.26)]);
    parts.push([new THREE.BoxGeometry(0.42, 0.06, 0.02), '#f4f4f4', M.t(x, 1.0, 0.255)]);
    parts.push([new THREE.BoxGeometry(0.12, 0.05, 0.03), '#c9c9c9', M.t(x + 0.12, 0.55, 0.26)]);
    for (const lx of [-0.22, 0.22]) parts.push([new THREE.BoxGeometry(0.05, 0.36, 0.05), '#555b63', M.t(x + lx, 0.18, 0)]);
  });
  return mergeColored(parts);
}

/** CTA bus shelter (faces +Z): bevelled frame, glass walls, roof, bench and a lit ad panel. */
export function ctaShelter(adBg = '#ff5f6d', adFg = '#ffd23f'): THREE.BufferGeometry {
  const f = '#2a3542';
  const glass = '#a9d6ea';
  const parts: Parts = [
    [bevelBox(4.8, 0.18, 2.0, 0.06), f, M.t(0, 2.62, -0.05)],
    [bevelBox(4.9, 0.06, 2.1, 0.02), '#5f6e7e', M.t(0, 2.74, -0.05)],
    [new THREE.BoxGeometry(4.5, 2.1, 0.05), glass, M.t(0, 1.35, -0.9)],
    [new THREE.BoxGeometry(0.05, 2.1, 1.6), glass, M.t(-2.3, 1.35, -0.1)],
    [bevelBox(4.6, 0.08, 0.08, 0.02), f, M.t(0, 0.3, -0.9)],
    [bevelBox(4.6, 0.08, 0.08, 0.02), f, M.t(0, 2.42, -0.9)],
    // bench
    [bevelBox(2.4, 0.07, 0.42, 0.02), '#9aa3ad', M.t(-0.7, 0.5, -0.62)],
    [new THREE.BoxGeometry(0.06, 0.45, 0.3), f, M.t(-1.8, 0.25, -0.62)],
    [new THREE.BoxGeometry(0.06, 0.45, 0.3), f, M.t(0.4, 0.25, -0.62)],
    // ad panel (light box) on the right end
    [bevelBox(0.25, 2.3, 1.5, 0.05), f, M.t(2.3, 1.3, -0.15)],
    [new THREE.BoxGeometry(0.02, 1.8, 1.2), adBg, M.t(2.43, 1.35, -0.15)],
    [new THREE.BoxGeometry(0.02, 1.8, 1.2), adBg, M.t(2.17, 1.35, -0.15)],
    [new THREE.CircleGeometry(0.34, 12).rotateY(Math.PI / 2), adFg, M.t(2.445, 1.62, -0.15)],
    [new THREE.BoxGeometry(0.02, 0.18, 0.95), '#ffffff', M.t(2.445, 1.0, -0.15)],
    [new THREE.BoxGeometry(0.02, 0.1, 0.7), '#ffffff', M.t(2.445, 0.78, -0.15)],
    // route sign pole
    [new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), '#8d949c', M.t(2.9, 1.6, 0.8)],
    [bevelBox(0.06, 0.55, 0.55, 0.02), '#1d5fae', M.t(2.9, 2.95, 0.8)],
    [new THREE.BoxGeometry(0.07, 0.12, 0.4), '#ffffff', M.t(2.9, 3.05, 0.8)],
  ];
  for (const [x, z] of [[-2.32, 0.9], [2.32, 0.9], [-2.32, -0.92], [2.32, -0.92]]) parts.push([bevelBox(0.12, 2.6, 0.12, 0.03), f, M.t(x, 1.3, z)]);
  return mergeColored(parts);
}

/** Divvy-style bikes in a dock (faces +Z): torus wheels, frame tubes, front baskets, kiosk. */
export function divvyDock(n = 5, q: Q = 'high'): THREE.BufferGeometry {
  const blue = '#3db7e4';
  const parts: Parts = [[bevelBox(n * 1.25 + 0.6, 0.12, 0.35, 0.04), '#7d848e', M.t(0, 0.06, -0.55)]];
  const ws = q === 'high' ? 14 : 10;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 1.25;
    parts.push([bevelBox(0.18, 0.85, 0.25, 0.05), '#4b525c', M.t(x, 0.45, -0.62)]);
    for (const wz of [-0.5, 0.52]) {
      parts.push([new THREE.TorusGeometry(0.33, 0.045, 5, ws).rotateY(Math.PI / 2), '#1e1e22', M.t(x, 0.36, wz)]);
      parts.push([new THREE.CylinderGeometry(0.05, 0.05, 0.12, 6).rotateZ(Math.PI / 2), '#b9bec5', M.t(x, 0.36, wz)]);
    }
    const tubes: Array<[number[], number[]]> = [
      [[0, 0.36, -0.5], [0, 0.72, -0.05]], [[0, 0.72, -0.05], [0, 0.85, 0.42]], [[0, 0.36, -0.5], [0, 0.45, 0.1]],
      [[0, 0.45, 0.1], [0, 0.72, -0.05]], [[0, 0.45, 0.1], [0, 0.85, 0.42]], [[0, 0.85, 0.42], [0, 0.36, 0.52]], [[0, 0.72, -0.05], [0, 0.92, -0.18]],
    ];
    for (const [a, b] of tubes) {
      const [g, m] = tube(a, b, 0.035, 5);
      parts.push([g, blue, M.t(x, 0, 0).multiply(m)]);
    }
    parts.push([bevelBox(0.14, 0.05, 0.26, 0.02), '#222', M.t(x, 0.95, -0.2)]);
    parts.push([new THREE.CylinderGeometry(0.02, 0.02, 0.62, 5).rotateZ(Math.PI / 2), '#2a2a2a', M.t(x, 1.02, 0.42)]);
    parts.push([bevelBox(0.38, 0.22, 0.3, 0.03), blue, M.t(x, 0.92, 0.66)]);
  }
  parts.push([bevelBox(0.5, 1.7, 0.35, 0.06), blue, M.t((n / 2) * 1.25 + 0.7, 0.85, -0.55)]);
  parts.push([new THREE.BoxGeometry(0.36, 0.45, 0.02), '#1d2b3f', M.t((n / 2) * 1.25 + 0.7, 1.2, -0.37)]);
  return mergeColored(parts);
}

/**
 * Parked car (~4.3 m, front +Z): extruded rounded body (white = tinted), glass cabin, roof,
 * pillars, bumpers, lights, mirrors and wheels with silver rims.
 */
export function parkedCar(q: Q = 'high', kind: 'sedan' | 'hatch' | 'suv' = 'sedan'): THREE.BufferGeometry {
  const L = kind === 'hatch' ? 3.9 : kind === 'suv' ? 4.6 : 4.4, W = kind === 'suv' ? 1.95 : 1.82;
  const beltY = kind === 'suv' ? 1.15 : 0.95, roofY = kind === 'suv' ? 1.85 : 1.48;
  const z0 = -L / 2, z1 = L / 2;
  const seg = q === 'high' ? 4 : 2;
  // lower body side profile in (z, y)
  const body = new THREE.Shape();
  body.moveTo(z0 + 0.25, 0.32);
  body.lineTo(z1 - 0.25, 0.32);
  body.quadraticCurveTo(z1, 0.32, z1, 0.55);
  body.lineTo(z1 - 0.05, beltY - 0.2);
  body.quadraticCurveTo(z1 - 0.1, beltY, z1 - 0.5, beltY);
  body.lineTo(z0 + 0.35, beltY + 0.02);
  body.quadraticCurveTo(z0, beltY, z0, beltY - 0.25);
  body.lineTo(z0, 0.55);
  body.quadraticCurveTo(z0, 0.32, z0 + 0.25, 0.32);
  const ext = (sh: THREE.Shape, depth: number, bevel: number) => {
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: seg > 2 ? 2 : 1, curveSegments: seg });
    g.translate(0, 0, -depth / 2);
    // shape x = z(world), shape y = y; extrusion along +Z -> rotate so extrusion runs along X
    g.rotateY(Math.PI / 2);
    return g;
  };
  const parts: Parts = [[ext(body, W - 0.2, 0.1), '#ffffff']];
  // cabin (glass) profile
  const hood = kind === 'hatch' ? 0.95 : kind === 'suv' ? 1.05 : 1.15;
  const trunk = kind === 'hatch' ? 0.25 : kind === 'suv' ? 0.3 : 0.75;
  const cab = new THREE.Shape();
  cab.moveTo(z1 - hood, beltY - 0.02);
  cab.lineTo(z1 - hood - 0.75, roofY);
  cab.lineTo(z0 + trunk + (kind === 'sedan' ? 0.6 : 0.2), roofY);
  cab.lineTo(z0 + trunk, beltY - 0.02);
  cab.lineTo(z1 - hood, beltY - 0.02);
  parts.push([ext(cab, W - 0.42, 0.06), '#26313f']);
  // roof skin + pillars (tinted)
  const roofLen = (z1 - hood - 0.75) - (z0 + trunk + (kind === 'sedan' ? 0.6 : 0.2));
  parts.push([bevelBox(W - 0.3, 0.07, roofLen + 0.1, 0.03), '#ffffff', M.t(0, roofY + 0.06, ((z1 - hood - 0.75) + (z0 + trunk + (kind === 'sedan' ? 0.6 : 0.2))) / 2)]);
  for (const sx of [-1, 1]) {
    const px = sx * (W / 2 - 0.2);
    const [ga, ma] = tube([px, beltY, z1 - hood + 0.05], [px, roofY + 0.04, z1 - hood - 0.72], 0.05, 4);
    parts.push([ga, '#ffffff', ma]);
    const [gc, mc] = tube([px, beltY, z0 + trunk - 0.05], [px, roofY + 0.04, z0 + trunk + (kind === 'sedan' ? 0.58 : 0.18)], 0.06, 4);
    parts.push([gc, '#ffffff', mc]);
    parts.push([new THREE.BoxGeometry(0.06, roofY - beltY, 0.08), '#ffffff', M.t(px, (beltY + roofY) / 2, (z1 - hood - 0.75 + z0 + trunk) / 2 + 0.2)]);
    // mirrors
    parts.push([bevelBox(0.18, 0.12, 0.1, 0.03), '#ffffff', M.t(sx * (W / 2 + 0.02), beltY + 0.05, z1 - hood - 0.05)]);
    // door seams
    parts.push([new THREE.BoxGeometry(0.01, beltY - 0.45, 0.02), '#9aa3ad', M.t(sx * (W / 2 + 0.005), (beltY + 0.4) / 2 + 0.05, (z1 - hood - 0.75 + z0 + trunk) / 2 + 0.2)]);
  }
  // bumpers + lights + grille
  parts.push([bevelBox(W, 0.2, 0.22, 0.07), '#3a3f47', M.t(0, 0.42, z1 + 0.02)]);
  parts.push([bevelBox(W, 0.2, 0.22, 0.07), '#3a3f47', M.t(0, 0.42, z0 - 0.02)]);
  parts.push([bevelBox(W * 0.42, 0.16, 0.05, 0.02), '#1b1f25', M.t(0, 0.72, z1 + 0.02)]);
  for (const sx of [-1, 1]) {
    parts.push([bevelBox(0.34, 0.13, 0.06, 0.03), '#fff6d8', M.t(sx * (W / 2 - 0.3), 0.74, z1 + 0.01)]);
    parts.push([bevelBox(0.34, 0.13, 0.06, 0.03), '#e0262b', M.t(sx * (W / 2 - 0.3), 0.8, z0 - 0.01)]);
  }
  // wheels
  const tireSeg = q === 'high' ? 16 : 10;
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const wx = x * (W / 2 - 0.12), wz = z * (L / 2 - 0.78);
    parts.push([new THREE.CylinderGeometry(0.36, 0.36, 0.26, tireSeg).rotateZ(Math.PI / 2), '#1a1a1c', M.t(wx, 0.36, wz)]);
    parts.push([new THREE.CylinderGeometry(0.22, 0.24, 0.27, tireSeg).rotateZ(Math.PI / 2), '#c4c9d0', M.t(wx + x * 0.01, 0.36, wz)]);
    parts.push([new THREE.CylinderGeometry(0.07, 0.07, 0.28, 6).rotateZ(Math.PI / 2), '#777d85', M.t(wx + x * 0.02, 0.36, wz)]);
  }
  const g = mergeColored(parts);
  g.userData.tintMask = true;
  return g;
}

/** Cheap parked car for far LOD (same footprint as parkedCar). */
export function simpleCar(): THREE.BufferGeometry {
  const parts: Parts = [
    [new THREE.BoxGeometry(1.82, 0.62, 4.3), '#ffffff', M.t(0, 0.68, 0)],
    [new THREE.BoxGeometry(1.5, 0.5, 2.1), '#26313f', M.t(0, 1.22, -0.15)],
    [new THREE.BoxGeometry(1.4, 0.06, 1.9), '#ffffff', M.t(0, 1.5, -0.15)],
  ];
  for (const [x, z] of [[-0.8, 1.4], [0.8, 1.4], [-0.8, -1.4], [0.8, -1.4]]) parts.push([new THREE.CylinderGeometry(0.36, 0.36, 0.26, 8).rotateZ(Math.PI / 2), '#1a1a1c', M.t(x, 0.36, z)]);
  const g = mergeColored(parts);
  g.userData.tintMask = true;
  return g;
}

/* ------------------------------------------------------------------ people */

const SKIN = ['#f1c7a3', '#d9a27a', '#a8714c', '#7a4a2e', '#f6d6bd', '#c68a5e'];
const HAIR = ['#2b1d14', '#5a3a22', '#c99a4a', '#1a1a1a', '#8a3b1e', '#d9d0c0'];
const PANTS = ['#2c3f66', '#3a3a40', '#6b5a43', '#1f2f4f', '#7a7f88', '#45603f'];

/**
 * Crowd figure (~1.75 m, faces +Z). White = shirt (instance tint); arms carry uv.x = 2 / 3 so
 * crowdMaterial can wave them. `variant` picks skin / hair / trousers.
 */
export function personDetailed(variant: number, q: Q = 'high'): THREE.BufferGeometry {
  const skin = SKIN[variant % SKIN.length], hair = HAIR[(variant * 2 + 1) % HAIR.length], pants = PANTS[(variant * 3 + 2) % PANTS.length];
  const s = q === 'high' ? 8 : 6;
  const parts: Parts = [
    [bevelBox(0.14, 0.09, 0.3, 0.03), '#2a2a2e', M.t(-0.1, 0.045, 0.05)],
    [bevelBox(0.14, 0.09, 0.3, 0.03), '#2a2a2e', M.t(0.1, 0.045, 0.05)],
    [new THREE.CylinderGeometry(0.085, 0.07, 0.82, s - 2), pants, M.t(-0.1, 0.5, 0)],
    [new THREE.CylinderGeometry(0.085, 0.07, 0.82, s - 2), pants, M.t(0.1, 0.5, 0)],
    [new THREE.CylinderGeometry(0.2, 0.19, 0.16, s), pants, M.t(0, 0.92, 0)],
    [lathe([[0.19, 0], [0.21, 0.25], [0.23, 0.45], [0.2, 0.55], [0.1, 0.6]], s), '#ffffff', M.t(0, 0.98, 0)],
    [new THREE.CylinderGeometry(0.06, 0.07, 0.1, 6), skin, M.t(0, 1.6, 0)],
    [new THREE.SphereGeometry(0.15, s + 2, s - 1), skin, M.trs(0, 1.77, 0, 0, 0, 0, 1, 1.1, 1)],
    [new THREE.SphereGeometry(0.16, s + 2, 4, 0, Math.PI * 2, 0, Math.PI * 0.55), hair, M.trs(0, 1.8, -0.015, -0.25, 0, 0, 1, 1.05, 1)],
    [new THREE.SphereGeometry(0.03, 4, 3), '#3a2a20', M.t(-0.055, 1.79, 0.14)],
    [new THREE.SphereGeometry(0.03, 4, 3), '#3a2a20', M.t(0.055, 1.79, 0.14)],
  ];
  const g = mergeColored(parts);
  // arms: raised, marked by uv.x (2 = left, 3 = right) for the waving shader
  const arms: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const sh = [side * 0.25, 1.42, 0];
    const el = [side * 0.42, 1.68, 0.06];
    const hd = [side * 0.47, 1.98, 0.08];
    const [ga, ma] = tube(sh, el, 0.055, s - 3);
    const [gb, mb] = tube(el, hd, 0.048, s - 3);
    const arm = mergeColored([
      [ga, '#ffffff', ma],
      [gb, skin, mb],
      [new THREE.IcosahedronGeometry(0.06, 0), skin, M.t(hd[0], hd[1] + 0.03, hd[2])],
      [new THREE.SphereGeometry(0.075, 6, 4), '#ffffff', M.t(sh[0], sh[1], sh[2])],
    ]);
    const uv = arm.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, side < 0 ? 2 : 3, 0.5);
    arms.push(arm);
  }
  const out = mergeGeometries([g, ...arms], false)!;
  g.dispose();
  arms.forEach((a) => a.dispose());
  out.computeBoundingSphere();
  return out;
}

/** Cheap far-LOD figure (uv-marked arms too). */
export function personSimple(variant: number): THREE.BufferGeometry {
  const skin = SKIN[variant % SKIN.length], pants = PANTS[(variant * 3 + 2) % PANTS.length];
  const g = mergeColored([
    [new THREE.CylinderGeometry(0.17, 0.15, 0.85, 5), pants, M.t(0, 0.43, 0)],
    [new THREE.CylinderGeometry(0.22, 0.19, 0.62, 6), '#ffffff', M.t(0, 1.15, 0)],
    [new THREE.IcosahedronGeometry(0.17, 0), skin, M.t(0, 1.7, 0)],
  ]);
  const arms = mergeColored([
    [new THREE.BoxGeometry(0.1, 0.6, 0.1), '#ffffff', M.trs(-0.36, 1.66, 0, 0, 0, 0.45)],
    [new THREE.BoxGeometry(0.1, 0.6, 0.1), '#ffffff', M.trs(0.36, 1.66, 0, 0, 0, -0.45)],
  ]);
  const uv = arms.attributes.uv as THREE.BufferAttribute;
  const pos = arms.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) < 0 ? 2 : 3, 0.5);
  const out = mergeGeometries([g, arms], false)!;
  g.dispose();
  arms.dispose();
  return out;
}

/* ------------------------------------------------------------------ racing furniture */

/** Stack of 4 tyres with a painted top ring (white = tinted). */
export function tireStack(q: Q = 'high'): THREE.BufferGeometry {
  const seg = q === 'high' ? 14 : 10;
  const parts: Parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push([new THREE.TorusGeometry(0.42, 0.17, 6, seg).rotateX(Math.PI / 2), '#1d1d20', M.t(0, 0.17 + i * 0.3, 0)]);
  }
  parts.push([new THREE.TorusGeometry(0.42, 0.172, 6, seg, Math.PI * 2).rotateX(Math.PI / 2), '#ffffff', M.trs(0, 0.17 + 3 * 0.3 + 0.004, 0, 0, 0, 0, 1, 0.45, 1)]);
  parts.push([new THREE.CircleGeometry(0.3, seg).rotateX(-Math.PI / 2), '#121214', M.t(0, 0.95, 0)]);
  const g = mergeColored(parts);
  g.userData.tintMask = true;
  return g;
}

/* ------------------------------------------------------------------ awnings */

/**
 * Storefront awning (width w, projecting d, faces +Z, top edge at y=0 against the wall): sloped
 * striped canvas with a scalloped valance. `a`/`b` are the stripe colours.
 */
export function awningParts(parts: Parts, w: number, d: number, a: string, b: string, xf: THREE.Matrix4, q: Q = 'high'): void {
  const stripes = Math.max(3, Math.round(w / 0.55));
  const sw = w / stripes;
  const slope = Math.atan2(0.9, d);
  const len = Math.hypot(0.9, d);
  for (let i = 0; i < stripes; i++) {
    const x = -w / 2 + sw * (i + 0.5);
    const c = i % 2 ? b : a;
    parts.push([new THREE.BoxGeometry(sw + 0.002, 0.05, len), c, xf.clone().multiply(M.trs(x, -0.45, d / 2, slope, 0, 0))]);
    // scallop: half-disc under each stripe
    if (q !== 'low') parts.push([new THREE.CircleGeometry(sw / 2, 8, Math.PI, Math.PI), c, xf.clone().multiply(M.t(x, -0.9 - 0.3, d + 0.01))]);
    parts.push([new THREE.BoxGeometry(sw + 0.002, 0.3, 0.03), c, xf.clone().multiply(M.t(x, -1.05, d))]);
  }
  // side cheeks
  for (const sx of [-1, 1]) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, -0.9, d, 0, -0.9, 0, 0, 0, 0, 0, -0.9, 0, 0, -0.9, d], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
    tri.computeVertexNormals();
    parts.push([tri, a, xf.clone().multiply(M.t(sx * w / 2, 0, 0))]);
  }
}

/** Clump of wildflowers: leafy blades + 3-5 stems with five-petal heads (white petals = tinted). ~0.55 m. */
export function wildflowerClump(q: Q, seed = 21): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const leaves = grassTuft('#2f7a2a', '#69b54a', q, { h: 0.35, blades: q === 'high' ? 6 : 4, seed, spread: 0.12 });
  const parts: Parts = [];
  const n = q === 'high' ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3), d = rng.range(0.05, 0.22);
    const x = Math.cos(a) * d, z = Math.sin(a) * d, h = rng.range(0.38, 0.6);
    parts.push([new THREE.CylinderGeometry(0.012, 0.016, h, 4), '#3f8f3a', M.t(x, h / 2, z)]);
    const tilt = rng.range(-0.5, 0.5);
    for (let p = 0; p < 5; p++) {
      const pa = (p / 5) * Math.PI * 2;
      parts.push([new THREE.SphereGeometry(0.045, 5, 3), '#ffffff', M.trs(x + Math.cos(pa) * 0.05, h + 0.01, z + Math.sin(pa) * 0.05, tilt, pa, 0, 1, 0.35, 0.7)]);
    }
    parts.push([new THREE.SphereGeometry(0.03, 5, 3), '#ffd23f', M.t(x, h + 0.025, z)]);
  }
  const g = mergeVC([leaves], parts);
  g.userData.sway = { from: 0.05, to: 0.6, amp: 0.05, flutter: 0.5 } satisfies Sway;
  g.userData.tintMask = true;
  return g;
}

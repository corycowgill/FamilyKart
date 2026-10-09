import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import type { Track } from '../../sim/track/Track';
import { getField, type TrackField } from './field';
import type { SceneryContext } from './types';

/* ------------------------------------------------------------------ disposal */

export class Bag {
  private items: Array<{ dispose(): void }> = [];
  add<T extends { dispose(): void }>(x: T): T {
    this.items.push(x);
    return x;
  }
  dispose(): void {
    for (const i of this.items) i.dispose();
    this.items.length = 0;
  }
}

/* ------------------------------------------------------------------ colored geometry */

const tmpC = new THREE.Color();

/** Paint a geometry with a flat vertex color (non-destructive: returns the same geometry). */
export function paint<T extends THREE.BufferGeometry>(geo: T, color: THREE.ColorRepresentation): T {
  tmpC.set(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = tmpC.r;
    arr[i * 3 + 1] = tmpC.g;
    arr[i * 3 + 2] = tmpC.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export type Part = [THREE.BufferGeometry, THREE.ColorRepresentation, ...Array<THREE.Matrix4 | null>];

/** Merge [geometry, color, matrix?] parts into a single vertex-colored geometry. */
export function mergeColored(parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>): THREE.BufferGeometry {
  const geos = parts.map(([g, c, m]) => {
    let geo = g.index ? g.toNonIndexed() : g.clone();
    if (m) geo.applyMatrix4(m);
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo = paint(geo, c);
    return geo;
  });
  const out = mergeGeometries(geos, false)!;
  geos.forEach((g) => g.dispose());
  out.computeBoundingSphere();
  return out;
}

export const M = {
  t: (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z),
  trs: (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)),
};

/* ------------------------------------------------------------------ instancing */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/** Collects instance transforms for one geometry/material pair, then builds one InstancedMesh. */
export class Batch {
  readonly mats: THREE.Matrix4[] = [];
  readonly colors: THREE.Color[] = [];
  constructor(readonly geo: THREE.BufferGeometry, readonly mat: THREE.Material, readonly opts: { cast?: boolean; receive?: boolean; name?: string } = {}) {}
  add(x: number, y: number, z: number, ry = 0, sx = 1, sy = sx, sz = sx, color?: THREE.ColorRepresentation, rx = 0, rz = 0): this {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    this.mats.push(new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)));
    this.colors.push(new THREE.Color(color ?? 0xffffff));
    return this;
  }
  addMatrix(m: THREE.Matrix4, color?: THREE.ColorRepresentation): this {
    this.mats.push(m.clone());
    this.colors.push(new THREE.Color(color ?? 0xffffff));
    return this;
  }
  get count(): number {
    return this.mats.length;
  }
  build(parent: THREE.Object3D): THREE.InstancedMesh | null {
    if (!this.mats.length) return null;
    const im = new THREE.InstancedMesh(this.geo, this.mat, this.mats.length);
    this.mats.forEach((m, i) => im.setMatrixAt(i, m));
    if (this.colors.some((c) => c.r !== 1 || c.g !== 1 || c.b !== 1)) this.colors.forEach((c, i) => im.setColorAt(i, c));
    im.castShadow = this.opts.cast ?? true;
    im.receiveShadow = this.opts.receive ?? true;
    if (this.opts.name) im.name = this.opts.name;
    im.computeBoundingSphere();
    parent.add(im);
    return im;
  }
}

export function setInstance(im: THREE.InstancedMesh, i: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy = sx, sz = sx): void {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  im.setMatrixAt(i, _m);
}

/* ------------------------------------------------------------------ materials */

export function vcMat(bag: Bag, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, ...opts }));
}

/**
 * Facade material for boxes whose UVs are scaled by instance scale (unit boxes) or authored in meters
 * (use boxUV). One texture tile spans cellW x cellH meters. Roofs sample the wall color.
 */
export function windowedMaterial(bag: Bag, map: THREE.Texture, cellW: number, cellH: number, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const m = bag.add(new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.15, ...opts }));
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      {
        vec3 sc = vec3(1.0);
        #ifdef USE_INSTANCING
        sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #endif
        vec2 wuv = vec2(uv.x * (abs(normal.x) > 0.5 ? sc.z : sc.x) / ${cellW.toFixed(2)}, uv.y * sc.y / ${cellH.toFixed(2)});
        if (abs(normal.y) > 0.5) wuv = vec2(0.01, 0.01);
        #ifdef USE_MAP
        vMapUv = wuv;
        #endif
        #ifdef USE_EMISSIVEMAP
        vEmissiveMapUv = wuv;
        #endif
      }`,
    );
  };
  m.customProgramCacheKey = () => `windowed-${cellW}-${cellH}`;
  return m;
}

/** Unit box with its base at y=0 (for instanced buildings). */
export function unitBox(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

/** Box (base at y=0) with UVs in meters, for windowedMaterial on non-instanced meshes. */
export function boxUV(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    uv.setXY(i, uv.getX(i) * (nx > 0.5 ? d : w), uv.getY(i) * h);
  }
  g.translate(x, y + h / 2, z);
  return g;
}

/** Waving flag material (vertex shader sway along uv.x). */
export function flagMaterial(bag: Bag, map: THREE.Texture, time: { value: number }): THREE.MeshStandardMaterial {
  const m = bag.add(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.8 }));
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float ph = 0.0;
        #ifdef USE_INSTANCING
        ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
        #endif
        transformed.z += sin(uv.x * 7.0 - uTime * 6.0 + ph) * 0.18 * uv.x;
        transformed.y += sin(uv.x * 5.0 - uTime * 4.0 + ph) * 0.05 * uv.x;`,
      );
  };
  m.customProgramCacheKey = () => 'flag';
  return m;
}

/* ------------------------------------------------------------------ props */

export const PROPS = {
  /** Lollipop tree, ~1 unit = 1 m at scale 1 (height ~8). */
  roundTree(leaf = '#4caf50', leaf2 = '#66c25a', trunk = '#7a5230'): THREE.BufferGeometry {
    return mergeColored([
      [new THREE.CylinderGeometry(0.28, 0.4, 3.2, 6), trunk, M.t(0, 1.6, 0)],
      [new THREE.IcosahedronGeometry(2.6, 1), leaf, M.trs(0, 5, 0, 0, 0, 0, 1, 0.9, 1)],
      [new THREE.IcosahedronGeometry(1.7, 1), leaf2, M.t(1.2, 6.2, 0.6)],
      [new THREE.IcosahedronGeometry(1.6, 1), leaf2, M.t(-1.1, 5.8, -0.8)],
    ]);
  },
  coneTree(leaf = '#2e7d4f', trunk = '#6b4a2b', snow?: string): THREE.BufferGeometry {
    const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.CylinderGeometry(0.25, 0.35, 2, 6), trunk, M.t(0, 1, 0)],
      [new THREE.ConeGeometry(2.6, 4, 8), leaf, M.t(0, 3.6, 0)],
      [new THREE.ConeGeometry(2.0, 3.4, 8), leaf, M.t(0, 5.6, 0)],
      [new THREE.ConeGeometry(1.4, 2.8, 8), leaf, M.t(0, 7.4, 0)],
    ];
    if (snow) {
      parts.push([new THREE.ConeGeometry(1.5, 1.6, 8), snow, M.t(0, 4.6, 0)]);
      parts.push([new THREE.ConeGeometry(1.1, 1.4, 8), snow, M.t(0, 6.5, 0)]);
      parts.push([new THREE.ConeGeometry(0.75, 1.3, 8), snow, M.t(0, 8.25, 0)]);
    }
    return mergeColored(parts);
  },
  bush(c1 = '#3f8f3a', c2 = '#58a84a'): THREE.BufferGeometry {
    return mergeColored([
      [new THREE.IcosahedronGeometry(1.2, 1), c1, M.trs(0, 0.7, 0, 0, 0, 0, 1.2, 0.8, 1)],
      [new THREE.IcosahedronGeometry(0.9, 1), c2, M.t(0.9, 0.7, 0.3)],
      [new THREE.IcosahedronGeometry(0.8, 1), c2, M.t(-0.8, 0.6, -0.2)],
    ]);
  },
  lamp(pole = '#2d3a4a', glow = '#fff3c4'): THREE.BufferGeometry {
    return mergeColored([
      [new THREE.CylinderGeometry(0.12, 0.18, 7, 6), pole, M.t(0, 3.5, 0)],
      [new THREE.BoxGeometry(0.15, 0.15, 1.6), pole, M.t(0, 6.9, 0.7)],
      [new THREE.CylinderGeometry(0.35, 0.45, 0.3, 8), pole, M.t(0, 6.75, 1.4)],
      [new THREE.SphereGeometry(0.3, 8, 6), glow, M.t(0, 6.55, 1.4)],
    ]);
  },
  car(): THREE.BufferGeometry {
    // body is white (tinted by instance color); glass and tires stay dark
    const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.BoxGeometry(1.9, 0.75, 4.3), '#ffffff', M.t(0, 0.75, 0)],
      [new THREE.BoxGeometry(1.7, 0.65, 2.2), '#ffffff', M.t(0, 1.45, -0.2)],
      [new THREE.BoxGeometry(1.72, 0.5, 2.0), '#2a3446', M.t(0, 1.45, -0.2)],
      [new THREE.BoxGeometry(1.95, 0.2, 0.3), '#d9d9d9', M.t(0, 0.6, 2.15)],
      [new THREE.BoxGeometry(1.95, 0.2, 0.3), '#d9d9d9', M.t(0, 0.6, -2.15)],
    ];
    for (const [x, z] of [[-0.9, 1.35], [0.9, 1.35], [-0.9, -1.35], [0.9, -1.35]]) {
      parts.push([new THREE.CylinderGeometry(0.38, 0.38, 0.3, 10).rotateZ(Math.PI / 2), '#1c1c1c', M.t(x, 0.38, z)]);
    }
    return mergeColored(parts);
  },
  cloud(): THREE.BufferGeometry {
    return mergeColored([
      [new THREE.IcosahedronGeometry(10, 1), '#ffffff', M.trs(0, 0, 0, 0, 0, 0, 1.6, 0.8, 1)],
      [new THREE.IcosahedronGeometry(8, 1), '#ffffff', M.t(12, 2, 2)],
      [new THREE.IcosahedronGeometry(7.5, 1), '#f4f8ff', M.t(-12, 1, -1)],
      [new THREE.IcosahedronGeometry(7, 1), '#ffffff', M.t(4, 7, 0)],
      [new THREE.IcosahedronGeometry(6, 1), '#eef4ff', M.t(-5, 5, 3)],
    ]);
  },
  flagpole(): THREE.BufferGeometry {
    return mergeColored([
      [new THREE.CylinderGeometry(0.07, 0.1, 9, 6), '#e6e6e6', M.t(0, 4.5, 0)],
      [new THREE.SphereGeometry(0.16, 8, 6), '#ffd23f', M.t(0, 9.05, 0)],
    ]);
  },
  bench(): THREE.BufferGeometry {
    return mergeColored([
      [new THREE.BoxGeometry(2.2, 0.12, 0.6), '#a0703f', M.t(0, 0.55, 0)],
      [new THREE.BoxGeometry(2.2, 0.5, 0.1), '#a0703f', M.t(0, 0.95, -0.28)],
      [new THREE.BoxGeometry(0.1, 0.55, 0.5), '#333', M.t(-0.95, 0.27, 0)],
      [new THREE.BoxGeometry(0.1, 0.55, 0.5), '#333', M.t(0.95, 0.27, 0)],
    ]);
  },
};

/** Flag cloth plane (pivot at the pole edge), uv.x 0 at pole. */
export function flagGeometry(w = 2.4, h = 1.6): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h, 10, 2).translate(w / 2, 0, 0);
}

/* ------------------------------------------------------------------ placement */

export interface Spot {
  x: number;
  y: number;
  z: number;
  /** yaw facing the road */
  yaw: number;
}

export class Placer {
  readonly field: TrackField;
  readonly rng: Rng;
  private taken: Array<{ x: number; z: number; r: number }> = [];
  constructor(readonly track: Track, seed = 99) {
    this.field = getField(track);
    this.rng = new Rng(seed);
  }
  /** Reserve a circle so later placements avoid it. */
  reserve(x: number, z: number, r: number): void {
    this.taken.push({ x, z, r });
  }
  free(x: number, z: number, r: number): boolean {
    for (const t of this.taken) if ((t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + r) ** 2) return false;
    return true;
  }
  /** Outside every wall by at least `margin` (+ radius), and not reserved. */
  ok(x: number, z: number, r: number, margin = 2, maxClear = Infinity): boolean {
    const c = this.field.clearance(x, z, 64 + r);
    if (c < margin + r || c > maxClear) return false;
    return this.free(x, z, r);
  }
  /** Random spots in a rectangle with clearance range. */
  scatter(count: number, rect: { minX: number; maxX: number; minZ: number; maxZ: number }, r: number, margin = 2, maxClear = Infinity, tries = 20, reserve = true): Spot[] {
    const out: Spot[] = [];
    for (let i = 0; i < count; i++) {
      for (let t = 0; t < tries; t++) {
        const x = this.rng.range(rect.minX, rect.maxX), z = this.rng.range(rect.minZ, rect.maxZ);
        if (!this.ok(x, z, r, margin, maxClear)) continue;
        if (reserve) this.reserve(x, z, r);
        out.push({ x, y: this.field.height(x, z), z, yaw: this.rng.next() * Math.PI * 2 });
        break;
      }
    }
    return out;
  }
  /**
   * Spots alongside a path at lateral distance wallDist + offset (both sides or one side),
   * facing the road. Skips spots that crowd any other part of the track.
   */
  along(pathId: number, spacing: number, offset: number, r: number, opts: { side?: -1 | 1 | 0; jitter?: number; margin?: number; from?: number; to?: number; reserve?: boolean } = {}): Spot[] {
    const p = this.track.paths[pathId];
    const out: Spot[] = [];
    const sides = opts.side ? [opts.side] : [-1, 1];
    const from = opts.from ?? 0, to = opts.to ?? p.length;
    for (const side of sides) {
      for (let s = from + this.rng.range(0, spacing * 0.5); s < to; s += spacing * this.rng.range(0.85, 1.15)) {
        const smp = this.track.sampleAt(pathId, s);
        if (smp.gap) continue;
        const lat = side * (smp.halfWidth + this.track.def.shoulder + offset + this.rng.range(0, opts.jitter ?? 0));
        const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
        // the spot sits `offset` outside this path's wall; reject if another part of the track is closer
        if (this.field.clearance(x, z, 64) < offset * 0.8 - 0.5 || !this.free(x, z, r)) continue;
        if (this.field.insideOther(x, z, -1, -1)) continue;
        if (opts.reserve !== false) this.reserve(x, z, r);
        const yaw = Math.atan2(-smp.nx * side, -smp.nz * side); // +Z of the prop faces the road
        out.push({ x, y: this.field.height(x, z), z, yaw });
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ misc */

export function ctxBits(ctx: SceneryContext) {
  const bag = new Bag();
  const q = ctx.quality;
  const density = q === 'high' ? 1 : q === 'medium' ? 0.7 : 0.45;
  return { bag, density, placer: new Placer(ctx.track, ctx.track.def.id.length * 7919 + 13) };
}

/** Puffy cartoon clouds drifting slowly. */
export function addClouds(ctx: SceneryContext, bag: Bag, count: number, height: [number, number], spread: number, tint = '#ffffff', seed = 5): (dt: number) => void {
  const rng = new Rng(seed);
  const geo = bag.add(PROPS.cloud());
  const mat = bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, color: tint, roughness: 1, emissive: new THREE.Color(tint), emissiveIntensity: 0.35, fog: false }));
  const field = getField(ctx.track);
  const b = field.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const im = new THREE.InstancedMesh(geo, mat, count);
  im.castShadow = false;
  im.receiveShadow = false;
  const data: Array<{ x: number; y: number; z: number; s: number; r: number }> = [];
  for (let i = 0; i < count; i++) {
    const a = rng.next() * Math.PI * 2, d = rng.range(spread * 0.35, spread);
    data.push({ x: cx + Math.cos(a) * d, y: rng.range(height[0], height[1]), z: cz + Math.sin(a) * d, s: rng.range(1.2, 2.6), r: rng.next() * 6 });
  }
  const place = () => {
    data.forEach((c, i) => setInstance(im, i, c.x, c.y, c.z, 0, c.r, 0, c.s, c.s * 0.8, c.s));
    im.instanceMatrix.needsUpdate = true;
  };
  place();
  im.frustumCulled = false;
  ctx.group.add(im);
  return (dt: number) => {
    for (const c of data) {
      c.x += dt * 1.5;
      if (c.x > cx + spread) c.x -= spread * 2;
    }
    place();
  };
}

/**
 * Elevated "L" line running east-west at z, from x0 to x1, with columns placed only outside the
 * track corridors, stations at both ends and a 4-car train shuttling back and forth.
 */
export function elevatedTrain(
  group: THREE.Group,
  bag: Bag,
  placer: Placer,
  o: { x0: number; x1: number; z: number; deckY?: number; steel?: string; snow?: boolean; lit?: boolean },
): (dt: number, t: number) => void {
  const field = placer.field;
  const { x0, x1 } = o;
  const zc = o.z;
  const deckY = o.deckY ?? 9.5;
  const steel = o.steel ?? '#4e5a3c';
  const vc = vcMat(bag);
  const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
    [new THREE.BoxGeometry(x1 - x0, 1.6, 0.6), steel, M.t((x0 + x1) / 2, deckY - 0.4, zc - 3.2)],
    [new THREE.BoxGeometry(x1 - x0, 1.6, 0.6), steel, M.t((x0 + x1) / 2, deckY - 0.4, zc + 3.2)],
    [new THREE.BoxGeometry(x1 - x0, 0.4, 7), '#3b4330', M.t((x0 + x1) / 2, deckY + 0.3, zc)],
    [new THREE.BoxGeometry(x1 - x0, 0.25, 0.25), '#a7a7a7', M.t((x0 + x1) / 2, deckY + 0.6, zc - 0.8)],
    [new THREE.BoxGeometry(x1 - x0, 0.25, 0.25), '#a7a7a7', M.t((x0 + x1) / 2, deckY + 0.6, zc + 0.8)],
  ];
  if (o.snow) {
    parts.push([new THREE.BoxGeometry(x1 - x0, 0.35, 1.6), '#f4f8ff', M.t((x0 + x1) / 2, deckY + 0.55, zc - 2.6)]);
    parts.push([new THREE.BoxGeometry(x1 - x0, 0.35, 1.6), '#f4f8ff', M.t((x0 + x1) / 2, deckY + 0.55, zc + 2.6)]);
  }
  for (let x = x0 + 4; x < x1; x += 4) {
    parts.push([new THREE.BoxGeometry(0.3, 1.6, 0.25), steel, M.trs(x, deckY - 0.4, zc - 3.2, 0, 0, 0.6)]);
    parts.push([new THREE.BoxGeometry(0.3, 1.6, 0.25), steel, M.trs(x, deckY - 0.4, zc + 3.2, 0, 0, -0.6)]);
  }
  for (let x = x0 + 6; x < x1; x += 18) {
    const ok = (z: number) => field.clearance(x, z) > 1.2;
    if (ok(zc - 3) && ok(zc + 3)) {
      const gy = Math.min(field.height(x, zc - 3), field.height(x, zc + 3));
      const h = deckY - gy;
      parts.push([new THREE.BoxGeometry(0.8, h, 0.8), steel, M.t(x, gy + h / 2 - 0.5, zc - 3.2)]);
      parts.push([new THREE.BoxGeometry(0.8, h, 0.8), steel, M.t(x, gy + h / 2 - 0.5, zc + 3.2)]);
      parts.push([new THREE.BoxGeometry(0.4, 0.4, 7), steel, M.t(x, deckY - 2.6, zc)]);
    }
  }
  for (const sx of [x0 + 16, x1 - 16]) {
    parts.push([new THREE.BoxGeometry(32, 6, 11), '#8a5b3c', M.t(sx, deckY + 3.4, zc)]);
    parts.push([new THREE.BoxGeometry(34, 0.8, 13), o.snow ? '#f4f8ff' : '#2e3a2a', M.t(sx, deckY + 6.8, zc)]);
    parts.push([new THREE.BoxGeometry(4, deckY, 4), '#6b4a33', M.t(sx, deckY / 2, zc + 7)]);
  }
  const sm = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
  sm.castShadow = sm.receiveShadow = true;
  group.add(sm);
  for (let x = x0; x < x1; x += 10) placer.reserve(x, zc, 6);
  const carGeo = bag.add(
    mergeColored([
      [new THREE.BoxGeometry(14, 3.0, 3.0), '#d9dde2', M.t(0, 1.9, 0)],
      [new THREE.BoxGeometry(14.05, 0.35, 3.05), '#d7262e', M.t(0, 1.2, 0)],
      [new THREE.BoxGeometry(14.05, 0.25, 3.05), '#1f5fbf', M.t(0, 1.55, 0)],
      [new THREE.BoxGeometry(12.5, 0.9, 3.08), o.lit ? '#ffe7a3' : '#24324a', M.t(0, 2.5, 0)],
      [new THREE.BoxGeometry(13.6, 0.4, 2.6), o.snow ? '#ffffff' : '#9aa0a8', M.t(0, 3.5, 0)],
      [new THREE.BoxGeometry(10, 0.7, 2.2), '#333', M.t(0, 0.4, 0)],
    ]),
  );
  const train = new THREE.InstancedMesh(carGeo, vcMat(bag, { roughness: 0.35, metalness: 0.3, emissive: o.lit ? '#3a2a10' : '#000000' }), 4);
  train.castShadow = true;
  train.frustumCulled = false;
  group.add(train);
  const span = x1 - x0 - 30;
  return (_dt: number, t: number) => {
    const cycle = 26;
    const ph = (t % cycle) / cycle;
    const dir = Math.floor(t / cycle) % 2 === 0 ? 1 : -1;
    const head = x0 + 15 + ph * (span + 60) - 30;
    for (let i = 0; i < 4; i++) {
      let x = dir > 0 ? head - i * 14.5 : x1 - 15 - (head - x0 - 15) + i * 14.5;
      x = Math.min(x1 - 8, Math.max(x0 + 8, x));
      setInstance(train, i, x, deckY + 0.5, zc, 0, 0, 0, 1);
    }
    train.instanceMatrix.needsUpdate = true;
  };
}

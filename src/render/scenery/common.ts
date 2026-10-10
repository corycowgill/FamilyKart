import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import type { Track } from '../../sim/track/Track';
import { getField, type TrackField } from './field';
import type { SceneryContext } from './types';
import { facadeDetailMaps, sharedEnv, swayVariant, windDriver, type Sway } from './materials';
import { acornLamp, lushBush, lushPine, lushTree, parkBench, parkedCar, simpleCar } from './props';

/* ------------------------------------------------------------------ build-wide settings */

export type SceneryQuality = 'low' | 'medium' | 'high';
/** Quality / time of day of the scenery currently being built (set by ctxBits). */
export const BUILD: { quality: SceneryQuality; tod: 'day' | 'sunset' | 'night' } = { quality: 'high', tod: 'day' };

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

export interface BatchLod {
  /** optional middle level used from mid.dist to `dist` */
  mid?: { geo: THREE.BufferGeometry; dist: number };
  /** cheaper geometry beyond `dist` (null = nothing) */
  far?: THREE.BufferGeometry | null;
  dist?: number;
  /** draw nothing beyond this distance */
  cull?: number;
  /** spatial cell size used to group instances into LOD clusters */
  cell?: number;
}

/** Tint-mask variant of a vertex-coloured material (only white vertices take the instance colour). */
const tintCache = new WeakMap<THREE.Material, THREE.Material>();
export function tintVariant(base: THREE.Material): THREE.Material {
  if (!(base instanceof THREE.MeshStandardMaterial)) return base;
  const k = base.customProgramCacheKey?.() ?? '';
  if (k.startsWith('tintmask') || k.includes('|tint')) return base;
  let m = tintCache.get(base);
  if (m) return m;
  const mat = base.clone();
  const prev = base.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(base, sh, r);
    sh.vertexShader = sh.vertexShader.replace(
      '#include <color_vertex>',
      `vColor = vec3(1.0);
      #ifdef USE_COLOR
      vColor *= color;
      #endif
      #ifdef USE_INSTANCING_COLOR
      { float tm = step(2.97, color.r + color.g + color.b); vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, tm); }
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => `${k}|tint`;
  tintCache.set(base, (m = mat));
  return m;
}

/** Material actually used for a geometry: honours userData.tintMask / userData.sway. */
export function materialFor(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Material {
  let m = mat;
  if (geo.userData.tintMask) m = tintVariant(m);
  if (geo.userData.sway) m = swayVariant(m, geo.userData.sway as Sway);
  return m;
}

/** Collects instance transforms for one geometry/material pair, then builds one InstancedMesh (or LOD clusters). */
export class Batch {
  readonly mats: THREE.Matrix4[] = [];
  readonly colors: THREE.Color[] = [];
  constructor(readonly geo: THREE.BufferGeometry, readonly mat: THREE.Material, readonly opts: { cast?: boolean; receive?: boolean; name?: string; lod?: BatchLod } = {}) {}
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
  private instanced(geo: THREE.BufferGeometry, idx: number[], offset: THREE.Vector3 | null, parent: THREE.Object3D, tinted: boolean): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(geo, materialFor(geo, this.mat), idx.length);
    const off = offset ? new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z) : null;
    idx.forEach((k, i) => {
      im.setMatrixAt(i, off ? _m.multiplyMatrices(off, this.mats[k]) : this.mats[k]);
      if (tinted) im.setColorAt(i, this.colors[k]);
    });
    im.castShadow = this.opts.cast ?? true;
    im.receiveShadow = this.opts.receive ?? true;
    if (this.opts.name) im.name = this.opts.name;
    if (geo.userData.sway) windDriver(im);
    im.computeBoundingSphere();
    parent.add(im);
    return im;
  }
  build(parent: THREE.Object3D): THREE.InstancedMesh | null {
    if (!this.mats.length) return null;
    const tinted = this.colors.some((c) => c.r !== 1 || c.g !== 1 || c.b !== 1);
    const lod = this.opts.lod ?? (this.geo.userData.lod as BatchLod | undefined);
    const all = this.mats.map((_, i) => i);
    if (!lod || (lod.far === undefined && !lod.cull) || this.mats.length < 6) {
      // LOD helpers are not used: release them
      if (lod?.far) lod.far.dispose();
      if (lod?.mid) lod.mid.geo.dispose();
      return this.instanced(this.geo, all, null, parent, tinted);
    }
    // group instances into spatial cells, each a THREE.LOD (near detail -> far / nothing)
    const cell = lod.cell ?? 120;
    const cells = new Map<string, number[]>();
    for (const i of all) {
      const e = this.mats[i].elements;
      const key = `${Math.floor(e[12] / cell)},${Math.floor(e[14] / cell)}`;
      let arr = cells.get(key);
      if (!arr) cells.set(key, (arr = []));
      arr.push(i);
    }
    let first: THREE.InstancedMesh | null = null;
    for (const idx of cells.values()) {
      const c = new THREE.Vector3();
      for (const i of idx) c.add(_p.setFromMatrixPosition(this.mats[i]));
      c.divideScalar(idx.length);
      const node = new THREE.LOD();
      node.position.copy(c);
      if (this.opts.name) node.name = `${this.opts.name}-lod`;
      const near = new THREE.Group();
      first ??= this.instanced(this.geo, idx, c, near, tinted);
      if (!near.children.length) this.instanced(this.geo, idx, c, near, tinted);
      node.addLevel(near, 0);
      if (lod.mid) {
        const midG = new THREE.Group();
        this.instanced(lod.mid.geo, idx, c, midG, tinted);
        node.addLevel(midG, lod.mid.dist);
      }
      if (lod.far) {
        const farG = new THREE.Group();
        this.instanced(lod.far, idx, c, farG, tinted);
        node.addLevel(farG, lod.dist ?? 120);
      } else if (lod.far === null) node.addLevel(new THREE.Object3D(), lod.dist ?? 120);
      if (lod.cull) node.addLevel(new THREE.Object3D(), lod.cull);
      parent.add(node);
    }
    return first;
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
  const detail = BUILD.quality !== 'low' ? facadeDetailMaps(map, { wallRough: Math.max(0.55, m.roughness), glassRough: 0.08 + m.roughness * 0.15, glassMetal: 0.35 + m.metalness * 0.5, depth: BUILD.quality === 'high' ? 2.6 : 1.8 }) : null;
  if (detail) {
    m.normalMap = detail.normal;
    m.normalScale.set(1, 1);
    m.roughnessMap = detail.orm;
    m.metalnessMap = detail.orm;
    m.roughness = 1;
    m.metalness = 1;
    m.envMap = sharedEnv(bag, BUILD.tod !== 'day' || !!opts.emissiveMap);
    m.envMapIntensity = BUILD.tod === 'night' ? 0.55 : 0.9;
  }
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
        #ifdef USE_NORMALMAP
        vNormalMapUv = wuv;
        #endif
        #ifdef USE_ROUGHNESSMAP
        vRoughnessMapUv = wuv;
        #endif
        #ifdef USE_METALNESSMAP
        vMetalnessMapUv = wuv;
        #endif
      }`,
    );
  };
  m.customProgramCacheKey = () => `windowed-${cellW}-${cellH}${detail ? '-d' : ''}`;
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
  const m = bag.add(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.78 }));
  // smooth cloth: two travelling waves + a cross ripple, a little droop away from the pole, and
  // analytic normals so the folds shade softly
  const wave = `
        float ph = 0.0;
        #ifdef USE_INSTANCING
        ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
        #endif
        float fx = uv.x;
        float w1 = fx * 7.0 - uTime * 6.0 + ph;
        float w2 = fx * 12.0 + uv.y * 3.5 - uTime * 8.7 + ph * 1.7;
        float amp = 0.17 * fx + 0.02;
        float dzv = (sin(w1) * amp + sin(w2) * 0.055 * fx) * smoothstep(0.0, 0.08, fx);
        float dzdx = (cos(w1) * 7.0 * amp + sin(w1) * 0.17 + cos(w2) * 12.0 * 0.055 * fx) / 2.4;
        float dzdy = cos(w2) * 3.5 * 0.055 * fx / 1.6;`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        {${wave}
          objectNormal = normalize(vec3(-dzdx, -dzdy, 1.0) * vec3(1.0, 1.0, sign(objectNormal.z + 1e-4)));
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {${wave}
          transformed.z += dzv;
          transformed.y += sin(fx * 5.0 - uTime * 4.0 + ph) * 0.05 * fx - 0.06 * fx * fx;
        }`,
      );
  };
  m.customProgramCacheKey = () => 'flag2';
  return m;
}

/* ------------------------------------------------------------------ props */

/** Attach LOD hints (used by Batch.build) to a near-detail geometry. */
function withLod<T extends THREE.BufferGeometry>(near: T, far: THREE.BufferGeometry | null, dist: number, cull?: number): T {
  near.userData.lod = { far, dist, cull, cell: 110 } satisfies BatchLod;
  return near;
}
let carVariant = 0;
const farOf = (q: SceneryQuality, hi: number, med: number) => (q === 'high' ? hi : med);

/**
 * Shared props. Geometry detail follows the quality being built (BUILD.quality): 'high' / 'medium'
 * get lush multi-lobe foliage, bevelled street furniture and shaped cars with LOD hints (near
 * detail -> simpler far mesh / culled), 'low' keeps the cheap classic shapes.
 */
export const PROPS = {
  /** Park tree, ~1 unit = 1 m at scale 1 (height ~8.5). Sways in the wind. */
  roundTree(leaf = '#4caf50', leaf2 = '#66c25a', trunk = '#7a5230'): THREE.BufferGeometry {
    const q = BUILD.quality;
    const seed = (leaf.charCodeAt(2) * 31 + leaf2.charCodeAt(3)) % 97;
    if (q === 'low') return lushTree(leaf, leaf2, trunk, 'low', { seed });
    const g = withLod(lushTree(leaf, leaf2, trunk, q, { seed }), lushTree(leaf, leaf2, trunk, q, { seed, far: true }), farOf(q, 160, 95));
    if (q === 'high') (g.userData.lod as BatchLod).mid = { geo: lushTree(leaf, leaf2, trunk, q, { seed, detail: 1 }), dist: 65 };
    return g;
  },
  coneTree(leaf = '#2e7d4f', trunk = '#6b4a2b', snow?: string): THREE.BufferGeometry {
    const q = BUILD.quality;
    if (q === 'low') return lushPine(leaf, trunk, 'low', snow);
    return withLod(lushPine(leaf, trunk, q, snow), lushPine(leaf, trunk, q, snow, { far: true }), farOf(q, 150, 95));
  },
  bush(c1 = '#3f8f3a', c2 = '#58a84a'): THREE.BufferGeometry {
    const q = BUILD.quality;
    if (q === 'low') return lushBush(c1, c2, 'low');
    return withLod(lushBush(c1, c2, q), lushBush(c1, c2, 'low'), farOf(q, 110, 70), farOf(q, 260, 180));
  },
  lamp(pole = '#2d3a4a', glow = '#fff3c4'): THREE.BufferGeometry {
    const q = BUILD.quality;
    const classic = () => mergeColored([
      [new THREE.CylinderGeometry(0.12, 0.18, 7, 6), pole, M.t(0, 3.5, 0)],
      [new THREE.BoxGeometry(0.15, 0.15, 1.6), pole, M.t(0, 6.9, 0.7)],
      [new THREE.CylinderGeometry(0.35, 0.45, 0.3, 8), pole, M.t(0, 6.75, 1.4)],
      [new THREE.SphereGeometry(0.3, 8, 6), glow, M.t(0, 6.55, 1.4)],
    ]);
    if (q === 'low') return classic();
    return withLod(acornLamp(pole, glow, q), mergeColored([
      [new THREE.CylinderGeometry(0.1, 0.2, 4.6, 5), pole, M.t(0, 2.3, 0)],
      [new THREE.SphereGeometry(0.32, 6, 4), glow, M.trs(0, 5.2, 0, 0, 0, 0, 1, 1.4, 1)],
    ]), farOf(q, 120, 80), farOf(q, 320, 220));
  },
  car(): THREE.BufferGeometry {
    const q = BUILD.quality;
    if (q === 'low') return simpleCar();
    const kinds = ['sedan', 'hatch', 'suv'] as const;
    return withLod(parkedCar(q, kinds[carVariant++ % 3]), simpleCar(), farOf(q, 110, 70), farOf(q, 400, 260));
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
    const q = BUILD.quality;
    if (q === 'low') {
      return mergeColored([
        [new THREE.BoxGeometry(2.2, 0.12, 0.6), '#a0703f', M.t(0, 0.55, 0)],
        [new THREE.BoxGeometry(2.2, 0.5, 0.1), '#a0703f', M.t(0, 0.95, -0.28)],
        [new THREE.BoxGeometry(0.1, 0.55, 0.5), '#333', M.t(-0.95, 0.27, 0)],
        [new THREE.BoxGeometry(0.1, 0.55, 0.5), '#333', M.t(0.95, 0.27, 0)],
      ]);
    }
    return withLod(parkBench(), null, farOf(q, 140, 90));
  },
};

/** Flag cloth plane (pivot at the pole edge), uv.x 0 at pole. */
export function flagGeometry(w = 2.4, h = 1.6): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h, BUILD.quality === 'low' ? 8 : 20, BUILD.quality === 'high' ? 8 : 4).translate(w / 2, 0, 0);
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
  BUILD.quality = q;
  BUILD.tod = timeOfDay(ctx.group);
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

/** Dispose every geometry / material / instanced buffer under a group (each once). */
export function disposeGroup(root: THREE.Object3D): void {
  const seen = new Set<{ dispose(): void }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) seen.add(m.geometry);
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => seen.add(x));
    else if (mat) seen.add(mat);
    if ((o as THREE.InstancedMesh).isInstancedMesh) seen.add(o as THREE.InstancedMesh);
  });
  for (const d of seen) d.dispose();
  root.clear();
}

/**
 * Vertex-colored material where only pure-white vertices take the per-instance color (shirts, train
 * stripes, awnings...) and every other baked color is kept. Optional `bob` makes instances hop
 * (cheering crowds) using a phase derived from their position.
 */
export function tintMaskMat(bag: Bag, opts: THREE.MeshStandardMaterialParameters = {}, bob?: { time: { value: number }; amp: number; speed: number }): THREE.MeshStandardMaterial {
  const m = bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, ...opts }));
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <color_vertex>',
      `vColor = vec3(1.0);
      #ifdef USE_COLOR
      vColor *= color;
      #endif
      #ifdef USE_INSTANCING_COLOR
      { float tm = step(2.97, color.r + color.g + color.b); vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, tm); }
      #endif`,
    );
    if (bob) {
      sh.uniforms.uTime = bob.time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
          { float ph = instanceMatrix[3].x * 1.37 + instanceMatrix[3].z * 0.71;
            float hop = abs(sin(uTime * ${bob.speed.toFixed(2)} + ph));
            transformed.y += hop * ${bob.amp.toFixed(3)} * step(0.5, fract(ph * 0.31) + 0.35);
            transformed.x += sin(uTime * 2.0 + ph) * 0.06 * position.y; }
          #endif`,
        );
    }
  };
  m.customProgramCacheKey = () => `tintmask-${bob ? `${bob.amp}-${bob.speed}` : 'static'}`;
  return m;
}

/**
 * Below 'high', only big casters keep shadows (fewer shadow-pass draw calls); at 'low' small
 * instanced props stop receiving too. Call after the scenery group is complete.
 */
export function trimShadows(root: THREE.Object3D, quality: 'low' | 'medium' | 'high'): void {
  if (quality === 'high') return;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    let r = m.geometry.boundingSphere?.radius ?? 0;
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      if (!im.boundingSphere) im.computeBoundingSphere();
      r = Math.min(r * 4, im.boundingSphere?.radius ?? r);
    }
    if (r < (quality === 'medium' ? 25 : 1e9)) m.castShadow = false;
  });
}

/**
 * Time of day the scene is being built for ('day' | 'sunset' | 'night'), read from the nearest
 * ancestor's userData.timeOfDay (the environment sets it on the scene). Defaults to 'day'.
 */
export function timeOfDay(obj: THREE.Object3D | null | undefined): 'day' | 'sunset' | 'night' {
  for (let o = obj; o; o = o.parent) {
    const t = o.userData?.timeOfDay;
    if (t === 'day' || t === 'sunset' || t === 'night') return t;
  }
  return 'day';
}

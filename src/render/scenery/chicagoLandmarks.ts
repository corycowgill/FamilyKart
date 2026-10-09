import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import { Batch, type Bag, boxUV, flagGeometry, flagMaterial, M, mergeColored, type Placer, PROPS, setInstance, tintMaskMat, vcMat, windowedMaterial } from './common';
import { canvasTexture, chicagoBannerTexture, cityEnvTexture, dotTexture, drawChicagoFlag, flagTexture, windowLitTexture, windowTexture } from './textures';

/**
 * Reusable, stylised Chicago landmarks shared by the Chicago Grand Prix, Snowpocalypse and the
 * neighborhood track. Everything static is collected into a Kit and merged per material on flush()
 * (a handful of draw calls for the whole skyline); signs share one canvas atlas.
 */

export type P = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;
export type Quality = 'low' | 'medium' | 'high';

export const CHI_BLUE = '#41B6E6';
export const CHI_RED = '#E4002B';
export const CTA = { red: '#c60c30', blue: '#00a1de', brown: '#62361b', green: '#009b3a', orange: '#f9461c', purple: '#522398', pink: '#e27ea6' };

const L = (b: THREE.Matrix4, local: THREE.Matrix4) => b.clone().multiply(local);
const _up = new THREE.Vector3(0, 1, 0);

/** Box beam from a to b (local coords), optionally under a base transform. */
export function beam(parts: P, a: readonly number[], b: readonly number[], t: number, col: THREE.ColorRepresentation, base?: THREE.Matrix4, t2 = t): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  if (len < 1e-4) return;
  d.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d);
  const m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
  parts.push([new THREE.BoxGeometry(t, len, t2), col, base ? base.clone().multiply(m) : m]);
}

function scaleUV(g: THREE.BufferGeometry, su: number, sv: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/* ================================================================== sign atlas */

export interface Rect { x: number; y: number; w: number; h: number }
export interface TextOpts { bg?: string; fg?: string; border?: string; stroke?: string; font?: string; bulbs?: string; weight?: number }

export function drawText(g: CanvasRenderingContext2D, text: string, w: number, h: number, o: TextOpts = {}): void {
  if (o.bg) {
    g.fillStyle = o.bg;
    g.fillRect(0, 0, w, h);
  }
  const lines = text.split('\n');
  const pad = o.bulbs ? Math.min(w, h) * 0.16 : o.border ? Math.min(w, h) * 0.1 : Math.min(w, h) * 0.04;
  if (o.border) {
    g.strokeStyle = o.border;
    g.lineWidth = Math.min(w, h) * 0.07;
    const i = Math.min(w, h) * 0.06;
    g.strokeRect(i, i, w - i * 2, h - i * 2);
  }
  if (o.bulbs) {
    const r = Math.min(w, h) * 0.045, step = r * 3.2, inset = r * 1.6;
    g.fillStyle = o.bulbs;
    for (let x = inset; x <= w - inset; x += step) for (const y of [inset, h - inset]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    for (let y = inset + step; y <= h - inset - step * 0.5; y += step) for (const x of [inset, w - inset]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const lh = (h - pad * 2) / lines.length;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((line, li) => {
    let size = Math.floor(lh * 0.78);
    const font = (sz: number) => o.font ? o.font.replace('$', String(sz)) : `${o.weight ?? 900} ${sz}px "Arial Black", Impact, sans-serif`;
    g.font = font(size);
    while (size > 6 && g.measureText(line).width > w - pad * 2) {
      size -= 1;
      g.font = font(size);
    }
    const y = pad + lh * (li + 0.54);
    if (o.stroke) {
      g.strokeStyle = o.stroke;
      g.lineWidth = size * 0.14;
      g.lineJoin = 'round';
      g.strokeText(line, w / 2, y);
    }
    g.fillStyle = o.fg ?? '#ffffff';
    g.fillText(line, w / 2, y);
  });
}

/** Many small signs drawn into one canvas -> one material, one merged mesh. */
export class SignAtlas {
  readonly size: number;
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  private cx = 0;
  private cy = 0;
  private row = 0;
  private geos: THREE.BufferGeometry[] = [];
  private cache = new Map<string, Rect>();
  constructor(size = 1024) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.g = this.canvas.getContext('2d')!;
    this.g.fillStyle = '#808080';
    this.g.fillRect(0, 0, size, size);
  }
  alloc(w: number, h: number): Rect {
    w = Math.min(w, this.size);
    if (this.cx + w > this.size) {
      this.cx = 0;
      this.cy += this.row + 4;
      this.row = 0;
    }
    if (this.cy + h > this.size) {
      console.warn('sign atlas full');
      return { x: 0, y: 0, w, h };
    }
    const r = { x: this.cx, y: this.cy, w, h };
    this.cx += w + 4;
    this.row = Math.max(this.row, h);
    return r;
  }
  draw(w: number, h: number, fn: (g: CanvasRenderingContext2D, w: number, h: number) => void, key?: string): Rect {
    if (key && this.cache.has(key)) return this.cache.get(key)!;
    const r = this.alloc(w, h);
    const g = this.g;
    g.save();
    g.translate(r.x, r.y);
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    fn(g, w, h);
    g.restore();
    if (key) this.cache.set(key, r);
    return r;
  }
  text(text: string, w: number, h: number, o: TextOpts = {}): Rect {
    return this.draw(w, h, (g) => drawText(g, text, w, h, o), `${text}|${w}|${h}|${JSON.stringify(o)}`);
  }
  /** A w x h plane facing +Z showing `r`, placed by m (both = also a back face). */
  quad(r: Rect, w: number, h: number, m: THREE.Matrix4, both = false): void {
    const S = this.size;
    for (const back of both ? [false, true] : [false]) {
      const p = new THREE.PlaneGeometry(w, h);
      const uv = p.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        uv.setXY(i, (r.x + 1 + u * (r.w - 2)) / S, 1 - (r.y + 1 + (1 - v) * (r.h - 2)) / S);
      }
      if (back) p.rotateY(Math.PI);
      p.applyMatrix4(m);
      this.geos.push(p.toNonIndexed());
      p.dispose();
    }
  }
  get count(): number {
    return this.geos.length;
  }
  build(bag: Bag, group: THREE.Object3D, neon: boolean, emissive = 0.25): THREE.Mesh | null {
    if (!this.geos.length) return null;
    const tex = bag.add(new THREE.CanvasTexture(this.canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = bag.add(
      neon
        ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(1.25, 1.25, 1.25) })
        : new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: emissive, roughness: 0.6 }),
    );
    const geo = bag.add(mergeGeometries(this.geos, false)!);
    this.geos.forEach((g) => g.dispose());
    this.geos = [];
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = !neon;
    m.name = neon ? 'neonSigns' : 'signs';
    group.add(m);
    return m;
  }
}

/* ================================================================== kit */

export type FacadeKind = 'dark' | 'white' | 'glass' | 'stone' | 'brick' | 'tan' | 'rust' | 'blue' | 'cream';

const FACADE: Record<FacadeKind, { wall: string; glass: string; glass2: string; frame?: number; bands?: boolean; cell: [number, number]; rough: number; metal: number; seed: number }> = {
  dark: { wall: '#26292f', glass: '#3c4c66', glass2: '#5b7499', frame: 0.16, cell: [9, 12], rough: 0.35, metal: 0.45, seed: 101 },
  white: { wall: '#f4f2ec', glass: '#8ea8c4', glass2: '#b9cde0', frame: 0.38, cell: [7, 12], rough: 0.5, metal: 0.1, seed: 102 },
  glass: { wall: '#b2d0ee', glass: '#4f8acb', glass2: '#8cc4f5', bands: true, cell: [12, 11], rough: 0.14, metal: 0.55, seed: 103 },
  stone: { wall: '#e6d8bb', glass: '#34445a', glass2: '#4a6382', frame: 0.32, cell: [8, 11], rough: 0.8, metal: 0, seed: 104 },
  brick: { wall: '#b25a3c', glass: '#2b3546', glass2: '#43536b', frame: 0.3, cell: [9, 10], rough: 0.85, metal: 0, seed: 105 },
  tan: { wall: '#d6b588', glass: '#3a4558', glass2: '#56647c', frame: 0.26, cell: [9, 10], rough: 0.8, metal: 0, seed: 106 },
  rust: { wall: '#7d4428', glass: '#2b2a2c', glass2: '#3d3a3c', bands: true, frame: 0.2, cell: [14, 12], rough: 0.7, metal: 0.2, seed: 107 },
  blue: { wall: '#7fb8d8', glass: '#2f6fa8', glass2: '#5aa6dc', bands: true, cell: [11, 10], rough: 0.12, metal: 0.6, seed: 108 },
  cream: { wall: '#f1e6cf', glass: '#3d5470', glass2: '#5b7aa0', frame: 0.3, cell: [8, 11], rough: 0.7, metal: 0.05, seed: 109 },
};

export interface KitOpts {
  /** window glow at dusk (0 = daytime, ~1 = night) */
  lit: number;
  snow: boolean;
  quality: Quality;
}

export class Kit {
  readonly solid: P = [];
  readonly gloss: P = [];
  /** bright stainless steel, double sided */
  readonly steel: P = [];
  /** unlit glowing bulbs / neon (blooms) */
  readonly glow: P = [];
  readonly paint = new SignAtlas(1024);
  readonly neon = new SignAtlas(512);
  readonly updaters: Array<(dt: number, t: number) => void> = [];
  readonly time = { value: 0 };
  readonly solidMat: THREE.MeshStandardMaterial;
  readonly glossMat: THREE.MeshStandardMaterial;
  readonly steelMat: THREE.MeshStandardMaterial;
  readonly glowMat: THREE.MeshBasicMaterial;
  readonly tintMat: THREE.MeshStandardMaterial;
  private fac = new Map<FacadeKind, THREE.BufferGeometry[]>();
  private facMats = new Map<FacadeKind, THREE.MeshStandardMaterial>();
  private batches: Batch[] = [];
  private people: Array<{ m: THREE.Matrix4; c: string }> = [];
  constructor(readonly bag: Bag, readonly group: THREE.Group, readonly o: KitOpts) {
    this.solidMat = vcMat(bag, { roughness: 0.78 });
    this.glossMat = vcMat(bag, { roughness: 0.3, metalness: 0.35 });
    this.steelMat = vcMat(bag, { roughness: 0.2, metalness: 0.7, side: THREE.DoubleSide });
    this.glowMat = bag.add(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(1.3, 1.3, 1.3) }));
    this.tintMat = tintMaskMat(bag, { roughness: 0.6 });
  }
  get q(): Quality {
    return this.o.quality;
  }
  /** Facade geometry with UVs in meters (boxUV etc.), merged per facade kind. */
  facade(kind: FacadeKind, geo: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (m) g = g.applyMatrix4(m);
    let arr = this.fac.get(kind);
    if (!arr) this.fac.set(kind, (arr = []));
    arr.push(g);
  }
  facadeMat(kind: FacadeKind): THREE.MeshStandardMaterial {
    let m = this.facMats.get(kind);
    if (m) return m;
    const f = FACADE[kind];
    const tex = this.bag.add(windowTexture({ wall: f.wall, glass: f.glass, glass2: f.glass2, frame: f.frame, bands: f.bands, seed: f.seed }));
    const extra: THREE.MeshStandardMaterialParameters = { roughness: f.rough, metalness: f.metal };
    if (this.o.lit > 0) {
      const lit = this.bag.add(windowLitTexture(kind === 'dark' || kind === 'glass' || kind === 'blue' ? '#ffe9b8' : '#ffd27a', 0.42, f.seed + 50, f.bands));
      Object.assign(extra, { emissive: '#ffffff', emissiveMap: lit, emissiveIntensity: this.o.lit });
    }
    m = windowedMaterial(this.bag, tex, f.cell[0], f.cell[1], extra);
    this.facMats.set(kind, m);
    return m;
  }
  batch(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean; name?: string } = {}): Batch {
    const b = new Batch(this.bag.add(geo), mat, opts);
    this.batches.push(b);
    return b;
  }
  person(x: number, y: number, z: number, yaw: number, shirt: string, s = 1): void {
    this.people.push({ m: M.trs(x, y, z, 0, yaw, 0, s), c: shirt });
  }
  update(dt: number, t: number): void {
    this.time.value = t;
    for (const u of this.updaters) u(dt, t);
  }
  /** Merge and add everything collected so far. Can be called more than once. */
  flush(): void {
    const add = (parts: P, mat: THREE.Material, name: string, cast = true) => {
      if (!parts.length) return;
      const m = new THREE.Mesh(this.bag.add(mergeColored(parts)), mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      m.name = name;
      this.group.add(m);
      parts.forEach(([g]) => g.dispose());
      parts.length = 0;
    };
    add(this.solid, this.solidMat, 'chiSolid');
    add(this.gloss, this.glossMat, 'chiGloss');
    add(this.steel, this.steelMat, 'chiSteel');
    add(this.glow, this.glowMat, 'chiGlow', false);
    for (const [kind, geos] of this.fac) {
      if (!geos.length) continue;
      const m = new THREE.Mesh(this.bag.add(mergeGeometries(geos, false)!), this.facadeMat(kind));
      geos.forEach((g) => g.dispose());
      geos.length = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `facade-${kind}`;
      this.group.add(m);
    }
    this.paint.build(this.bag, this.group, false, this.o.lit > 0.5 ? 0.7 : 0.22);
    this.neon.build(this.bag, this.group, true);
    for (const b of this.batches) b.build(this.group);
    this.batches = [];
    if (this.people.length) {
      const mat = tintMaskMat(this.bag, { roughness: 0.75 }, { time: this.time, amp: 0.35, speed: 7 });
      const im = new THREE.InstancedMesh(this.bag.add(personGeo()), mat, this.people.length);
      this.people.forEach((p, i) => {
        im.setMatrixAt(i, p.m);
        im.setColorAt(i, new THREE.Color(p.c));
      });
      im.castShadow = false;
      im.receiveShadow = false;
      im.computeBoundingSphere();
      im.name = 'people';
      this.group.add(im);
      this.people = [];
    }
  }
}

/** Cheering fan with raised arms (white shirt = tinted per instance). ~1.75 m tall, faces +Z. */
export function personGeo(): THREE.BufferGeometry {
  return mergeColored([
    [new THREE.CylinderGeometry(0.17, 0.15, 0.8, 5), '#2c3f66', M.t(0, 0.4, 0)],
    [new THREE.CylinderGeometry(0.24, 0.2, 0.62, 6), '#ffffff', M.t(0, 1.08, 0)],
    [new THREE.IcosahedronGeometry(0.2, 0), '#f0c4a0', M.t(0, 1.58, 0)],
    [new THREE.BoxGeometry(0.1, 0.62, 0.1), '#ffffff', M.trs(-0.33, 1.55, 0, 0, 0, 0.45)],
    [new THREE.BoxGeometry(0.1, 0.62, 0.1), '#ffffff', M.trs(0.33, 1.55, 0, 0, 0, -0.45)],
  ]);
}

/* ================================================================== skyline icons */

/** Willis (Sears) Tower: nine black bundled tubes stepping back, twin white antennas. */
export function willisTower(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const u = 13;
  const tubes: Array<[number, number, number]> = [[-1, -1, 150], [0, -1, 205], [1, -1, 150], [-1, 0, 235], [0, 0, 270], [1, 0, 205], [-1, 1, 175], [0, 1, 270], [1, 1, 235]];
  for (const [i, j, h] of tubes) {
    k.facade('dark', boxUV(u, h, u, i * u, 0, j * u), b);
    k.solid.push([new THREE.BoxGeometry(u + 0.4, 3.4, u + 0.4), '#111317', L(b, M.t(i * u, h - 1.7, j * u))]);
    for (const by of [88, 176]) if (h > by + 10) k.solid.push([new THREE.BoxGeometry(u + 0.3, 2.6, u + 0.3), '#111317', L(b, M.t(i * u, by, j * u))]);
    if (k.o.snow) k.solid.push([new THREE.BoxGeometry(u - 0.2, 0.7, u - 0.2), '#f4f8ff', L(b, M.t(i * u, h + 0.35, j * u))]);
  }
  for (const [ax, az, ah] of [[-3, -3, 74], [3, u + 3, 64]]) {
    k.gloss.push([new THREE.CylinderGeometry(0.7, 1.4, ah, 6), '#f4f4f4', L(b, M.t(ax, 270 + ah / 2, az))]);
    k.glow.push([new THREE.SphereGeometry(1.2, 6, 4), '#ff2a2a', L(b, M.t(ax, 270 + ah, az))]);
  }
}

/** John Hancock Center: tapered black obelisk with X-bracing and two antennas. */
export function hancockCenter(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const H = 235, r0 = 25, r1 = 16;
  const g = new THREE.CylinderGeometry(r1, r0, H, 4, 1, true).rotateY(Math.PI / 4).translate(0, H / 2, 0);
  scaleUV(g, r0 * 1.414 * 4 * 0.85, H);
  k.facade('dark', g, b);
  const half = (yy: number) => (r0 + (r1 - r0) * (yy / H)) * Math.SQRT1_2 + 0.35;
  const sec = 5, sh = H / sec, c = '#0b0c0f';
  for (let f = 0; f < 4; f++) {
    const fm = L(b, M.trs(0, 0, 0, 0, (f * Math.PI) / 2, 0));
    for (let i = 0; i < sec; i++) {
      const y0 = i * sh, y1 = y0 + sh, h0 = half(y0), h1 = half(y1);
      beam(k.solid, [-h0, y0, h0], [h1, y1, h1], 1.0, c, fm, 0.7);
      beam(k.solid, [h0, y0, h0], [-h1, y1, h1], 1.0, c, fm, 0.7);
      k.solid.push([new THREE.BoxGeometry(2 * h1 + 1, 1.1, 0.8), c, L(fm, M.t(0, y1, h1))]);
    }
    beam(k.solid, [half(0), 0, half(0)], [half(H), H, half(H)], 1.3, c, fm);
  }
  const top = half(H) * 2;
  k.solid.push([new THREE.BoxGeometry(top, 7, top), '#15171b', L(b, M.t(0, H + 3.5, 0))]);
  if (k.o.snow) k.solid.push([new THREE.BoxGeometry(top - 0.5, 0.7, top - 0.5), '#f4f8ff', L(b, M.t(0, H + 7.3, 0))]);
  for (const ax of [-5, 5]) {
    k.gloss.push([new THREE.CylinderGeometry(0.7, 1.2, 78, 6), '#ededed', L(b, M.t(ax, H + 7 + 39, 0))]);
    k.glow.push([new THREE.SphereGeometry(1.1, 6, 4), '#ff2a2a', L(b, M.t(ax, H + 85, 0))]);
  }
}

/** Trump-style stepped glass tower with a spire. */
export function glassSpireTower(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const steps: Array<[number, number, number, number, number]> = [[34, 118, 24, 0, 0], [28, 62, 20, 2, 118], [21, 46, 16, 3, 180], [14, 22, 12, 3, 226]];
  for (const [w, h, d, ox, oy] of steps) {
    k.facade('glass', boxUV(w, h, d, ox, oy, 0), b);
    k.steel.push([new THREE.BoxGeometry(w + 0.6, 1.2, d + 0.6), '#e9eef4', L(b, M.t(ox, oy + h - 0.2, 0))]);
    if (k.o.snow) k.solid.push([new THREE.BoxGeometry(w, 0.6, d), '#f4f8ff', L(b, M.t(ox, oy + h + 0.6, 0))]);
  }
  k.gloss.push([new THREE.CylinderGeometry(0.3, 1.8, 58, 6), '#e8eef5', L(b, M.t(3, 248 + 29, 0))]);
  k.glow.push([new THREE.SphereGeometry(0.9, 6, 4), '#ff2a2a', L(b, M.t(3, 248 + 58, 0))]);
}

/** Aon Center: tall white marble slab. */
export function aonCenter(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.facade('white', boxUV(28, 222, 28), b);
  k.solid.push([new THREE.BoxGeometry(28.6, 4, 28.6), '#dcdad2', L(b, M.t(0, 220, 0))]);
  k.solid.push([new THREE.BoxGeometry(34, 6, 34), '#c9c4b8', L(b, M.t(0, 3, 0))]);
}

/** St. Regis (Vista) style: three stacked frustum glass stems that bulge and taper. */
export function wavyTower(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  for (const [dx, H, dz] of [[-13, 112, 2], [0, 150, -2], [13, 128, 3]] as const) {
    const h0 = H * 0.55, h1 = H * 0.45;
    const lo = new THREE.CylinderGeometry(12.5, 9.5, h0, 4, 1, true).rotateY(Math.PI / 4).translate(dx, h0 / 2, dz);
    const hi = new THREE.CylinderGeometry(8.5, 12.5, h1, 4, 1, true).rotateY(Math.PI / 4).translate(dx, h0 + h1 / 2, dz);
    k.facade('blue', scaleUV(lo, 60, h0), b);
    k.facade('blue', scaleUV(hi, 56, h1), b);
    k.solid.push([new THREE.BoxGeometry(12, 1, 12), k.o.snow ? '#f4f8ff' : '#9fb7c8', L(b, M.t(dx, H, dz))]);
  }
}

/** Tribune Tower: limestone shaft with a gothic octagonal crown and flying buttresses. */
export function tribuneTower(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const st = '#e8dcc2';
  k.facade('stone', boxUV(24, 92, 20), b);
  k.facade('stone', boxUV(18, 12, 15, 0, 92, 0), b);
  k.solid.push([new THREE.CylinderGeometry(7.5, 8.2, 16, 8), st, L(b, M.t(0, 112, 0))]);
  k.solid.push([new THREE.CylinderGeometry(5, 7, 7, 8), '#d8cbb0', L(b, M.t(0, 123.5, 0))]);
  k.solid.push([new THREE.ConeGeometry(4.5, 6, 8), '#cfc2a6', L(b, M.t(0, 130, 0))]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const cx = Math.cos(a), cz = Math.sin(a);
    beam(k.solid, [cx * 12.5, 102, cz * 10.5], [cx * 8.2, 117, cz * 8.2], 0.9, st, b);
    k.solid.push([new THREE.ConeGeometry(0.9, 5, 4), st, L(b, M.t(cx * 8.4, 122, cz * 8.4))]);
    k.solid.push([new THREE.BoxGeometry(0.5, 7, 0.5), '#3a4458', L(b, M.t(cx * 7.6, 112, cz * 7.6))]);
  }
  if (k.o.snow) k.solid.push([new THREE.BoxGeometry(17.5, 0.6, 14.5), '#f4f8ff', L(b, M.t(0, 104.3, 0))]);
}

/** Wrigley Building: white terracotta block + annex with a clock tower. */
export function wrigleyBuilding(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const w = '#fbf8f0';
  k.facade('white', boxUV(34, 54, 22), b);
  k.facade('white', boxUV(24, 34, 18, 34, 0, 2), b);
  k.solid.push([new THREE.BoxGeometry(6, 3, 3), w, L(b, M.t(19, 24, 2))]);
  k.solid.push([new THREE.BoxGeometry(14, 16, 14), w, L(b, M.t(0, 62, 0))]);
  k.solid.push([new THREE.BoxGeometry(12, 10, 12), w, L(b, M.t(0, 75, 0))]);
  k.solid.push([new THREE.CylinderGeometry(5, 6, 9, 8), w, L(b, M.t(0, 84.5, 0))]);
  k.solid.push([new THREE.CylinderGeometry(3, 4, 6, 8), w, L(b, M.t(0, 92, 0))]);
  k.solid.push([new THREE.ConeGeometry(3, 9, 8), '#efe6d2', L(b, M.t(0, 99.5, 0))]);
  const clock = k.paint.draw(128, 128, (g, cw, ch) => {
    g.fillStyle = '#f7f1e3';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#1f3358';
    g.beginPath();
    g.arc(cw / 2, ch / 2, 62, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fffaf0';
    g.beginPath();
    g.arc(cw / 2, ch / 2, 52, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1a1a1a';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.save();
      g.translate(cw / 2 + Math.sin(a) * 44, ch / 2 - Math.cos(a) * 44);
      g.rotate(a);
      g.fillRect(-2, -6, 4, i % 3 ? 8 : 12);
      g.restore();
    }
    g.strokeStyle = '#1a1a1a';
    g.lineCap = 'round';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(cw / 2, ch / 2);
    g.lineTo(cw / 2 + 20, ch / 2 - 16);
    g.stroke();
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cw / 2, ch / 2);
    g.lineTo(cw / 2 - 4, ch / 2 - 40);
    g.stroke();
    g.fillStyle = '#c9a24a';
    g.beginPath();
    g.arc(cw / 2, ch / 2, 5, 0, Math.PI * 2);
    g.fill();
  }, 'wrigleyClock');
  for (let f = 0; f < 4; f++) k.paint.quad(clock, 8.6, 8.6, L(b, M.trs(Math.sin((f * Math.PI) / 2) * 7.06, 63, Math.cos((f * Math.PI) / 2) * 7.06, 0, (f * Math.PI) / 2, 0)));
}

/** The old Chicago Water Tower: little castle-like limestone tower with turrets. */
export function waterTowerCastle(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const st = '#ead9a6', dk = '#3a3226', roof = '#6f8a85';
  k.solid.push([new THREE.BoxGeometry(16, 11, 16), st, L(b, M.t(0, 5.5, 0))]);
  for (const [cx, cz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) {
    k.solid.push([new THREE.CylinderGeometry(1.6, 1.8, 15, 8), st, L(b, M.t(cx, 7.5, cz))]);
    k.solid.push([new THREE.ConeGeometry(1.9, 4, 8), roof, L(b, M.t(cx, 17, cz))]);
  }
  for (let i = -6; i <= 6; i += 3) for (const [sx, sz, rr] of [[i, 8.1, 0], [i, -8.1, 0], [8.1, i, 1], [-8.1, i, 1]]) {
    k.solid.push([new THREE.BoxGeometry(rr ? 0.3 : 1.2, 1.2, rr ? 1.2 : 0.3), st, L(b, M.t(sx, 11.6, sz))]);
  }
  for (const [sx, sz, ry] of [[0, 8.05, 0], [0, -8.05, 0], [8.05, 0, Math.PI / 2], [-8.05, 0, Math.PI / 2]]) {
    k.solid.push([new THREE.BoxGeometry(3, 5.5, 0.3), dk, L(b, M.trs(sx, 4, sz, 0, ry, 0))]);
  }
  const tiers: Array<[number, number, number]> = [[5.2, 13, 11], [4.2, 10, 24], [3.3, 8, 34]];
  for (const [r, h, y0] of tiers) {
    k.solid.push([new THREE.CylinderGeometry(r * 0.92, r, h, 8), st, L(b, M.t(0, y0 + h / 2, 0))]);
    k.solid.push([new THREE.CylinderGeometry(r * 1.12, r * 1.12, 1, 8), '#d9c690', L(b, M.t(0, y0 + h, 0))]);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      k.solid.push([new THREE.BoxGeometry(0.8, h * 0.45, 0.25), dk, L(b, M.trs(Math.cos(a) * r * 0.97, y0 + h * 0.55, Math.sin(a) * r * 0.97, 0, -a + Math.PI / 2, 0))]);
    }
  }
  k.solid.push([new THREE.CylinderGeometry(1.4, 2.6, 6, 8), roof, L(b, M.t(0, 45, 0))]);
  k.solid.push([new THREE.ConeGeometry(1.4, 5, 8), roof, L(b, M.t(0, 50.5, 0))]);
}

/** Merchandise Mart: huge tan block with a central tower. */
export function merchMart(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.facade('tan', boxUV(110, 58, 48), b);
  k.facade('tan', boxUV(30, 22, 26, 0, 58, 0), b);
  for (const cx of [-50, 50]) k.facade('tan', boxUV(10, 66, 10, cx, 0, 19), b);
  k.solid.push([new THREE.BoxGeometry(111, 1.6, 49), k.o.snow ? '#f4f8ff' : '#b89464', L(b, M.t(0, 58.6, 0))]);
}

/** Marina City "corn cob" twin towers (own striped balcony texture). */
export function marinaCity(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const lit = k.o.lit;
  const tex = k.bag.add(canvasTexture(256, 256, (g, w, h) => {
    const fh = h / 4, lw = w / 4;
    for (let f = 0; f < 4; f++) {
      const y0 = f * fh;
      g.fillStyle = '#f6f3ec';
      g.fillRect(0, y0, w, fh * 0.36);
      g.fillStyle = '#c4c0b6';
      g.fillRect(0, y0 + fh * 0.36, w, fh * 0.06);
      g.fillStyle = '#2b3546';
      g.fillRect(0, y0 + fh * 0.42, w, fh * 0.58);
      g.fillStyle = '#4c5d78';
      for (let l = 0; l < 4; l++) for (let m = 0; m < 3; m++) g.fillRect(l * lw + 4 + m * 20, y0 + fh * 0.48, 14, fh * 0.44);
      g.fillStyle = '#d9d5cc';
      for (let l = 0; l < 4; l++) g.fillRect(l * lw, y0 + fh * 0.42, 2, fh * 0.58);
    }
  }, { seed: 7 }));
  const emis = lit > 0 ? k.bag.add(canvasTexture(256, 256, (g, w, h, rng) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const fh = h / 4, lw = w / 4;
    for (let f = 0; f < 4; f++) for (let l = 0; l < 4; l++) for (let m = 0; m < 3; m++) {
      if (!rng.chance(0.45)) continue;
      g.fillStyle = rng.chance(0.5) ? '#ffd27a' : '#ffe9b8';
      g.fillRect(l * lw + 4 + m * 20, f * fh + fh * 0.48, 14, fh * 0.44);
    }
  }, { seed: 8 })) : null;
  const mat = k.bag.add(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, ...(emis ? { emissive: '#ffffff', emissiveMap: emis, emissiveIntensity: lit } : {}) }));
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const H = 128, R = 11, floors = 44, lobes = 16;
  const geos: THREE.BufferGeometry[] = [];
  for (const dx of [-16, 16]) {
    const g = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i), py = pos.getY(i);
      const a = Math.atan2(pz, px);
      const f = 0.82 + 0.18 * Math.pow(Math.abs(Math.cos((lobes / 2) * a)), 0.55);
      pos.setXYZ(i, px * R * f + dx, (py + 0.5) * H, pz * R * f);
    }
    scaleUV(g, lobes / 4, floors / 4);
    g.computeVertexNormals();
    g.applyMatrix4(b);
    geos.push(g);
    k.solid.push([new THREE.CylinderGeometry(R * 0.95, R * 0.95, 1, 24), k.o.snow ? '#f4f8ff' : '#e9e6de', L(b, M.t(dx, H + 0.4, 0))]);
    k.solid.push([new THREE.BoxGeometry(5, 4, 5), '#bdb8ad', L(b, M.t(dx, H + 2.5, 0))]);
  }
  k.solid.push([new THREE.BoxGeometry(56, 6, 26), '#cfcac0', L(b, M.t(0, 3, 0))]);
  const mesh = new THREE.Mesh(k.bag.add(mergeGeometries(geos)!), mat);
  geos.forEach((g) => g.dispose());
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = 'marinaCity';
  k.group.add(mesh);
}

/* ================================================================== Millennium Park & plazas */

/** Cloud Gate ("the Bean"): mirror-chrome blob with the omphalos arch, on a granite plaza. */
export function cloudGate(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): THREE.Mesh {
  const g = new THREE.SphereGeometry(1, 72, 36);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), pz = pos.getZ(i);
    let py = pos.getY(i);
    if (py < 0) {
      py *= 0.58;
      py += 0.62 * Math.exp(-(px * px) / 0.09) * Math.min(1, -pos.getY(i) * 1.4) * (1 - pz * pz * 0.6);
    } else py *= 0.95;
    pos.setY(i, py);
  }
  g.computeVertexNormals();
  const env = k.bag.add(cityEnvTexture(k.o.snow));
  const mat = k.bag.add(new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.05, envMap: env, envMapIntensity: 1.15 }));
  const bean = new THREE.Mesh(k.bag.add(g), mat);
  const sx = 11 * s, sy = 5 * s, sz = 7 * s;
  bean.scale.set(sx, sy, sz);
  bean.position.set(x, y + 0.58 * sy + 0.3 * s, z);
  bean.rotation.y = rot;
  bean.castShadow = true;
  bean.name = 'cloudGate';
  bean.userData.reflective = true;
  k.group.add(bean);
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.solid.push([new THREE.CylinderGeometry(26, 26.5, 0.4, 40), k.o.snow ? '#e9eef6' : '#d8d4cb', L(b, M.t(0, 0.2, 0))]);
  if (k.o.snow) {
    const cap = new THREE.SphereGeometry(1, 40, 8, 0, Math.PI * 2, 0, 0.75);
    k.solid.push([cap, '#ffffff', L(b, M.trs(0, 0.58 * 5 + 0.3 + 0.95 * 5 * 0.02, 0, 0, 0, 0, 11 * 1.02, 5 * 0.97, 7 * 1.02))]);
  }
  return bean;
}

/** Crown Fountain: two glass-block LED towers with giant faces that pucker and spit water. */
export function crownFountain(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const face = (pucker: boolean, seed: number) => canvasTexture(512, 512, (g, w, h, rng) => {
    // face half (u 0..0.5)
    const fw = w / 2;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#9fd6ff');
    bg.addColorStop(1, '#d9f1ff');
    g.fillStyle = bg;
    g.fillRect(0, 0, fw, h);
    const cx = fw / 2, cy = h * 0.47;
    g.fillStyle = '#4a2d1c';
    g.beginPath();
    g.ellipse(cx, cy - 70, 112, 120, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = '#f2c09a';
    g.beginPath();
    g.ellipse(cx, cy, 100, 150, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#4a2d1c';
    g.fillRect(cx - 100, cy - 150, 200, 40);
    g.fillStyle = '#fff';
    for (const ex of [-40, 40]) {
      g.beginPath();
      g.ellipse(cx + ex, cy - 30, 22, 16, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#3b6fb0';
    for (const ex of [-40, 40]) {
      g.beginPath();
      g.arc(cx + ex + 3, cy - 29, 10, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#4a2d1c';
    g.lineWidth = 7;
    for (const ex of [-40, 40]) {
      g.beginPath();
      g.moveTo(cx + ex - 24, cy - 62);
      g.lineTo(cx + ex + 22, cy - 58 - (pucker ? 6 : 0));
      g.stroke();
    }
    g.fillStyle = '#e3a582';
    g.beginPath();
    g.ellipse(cx, cy + 15, 14, 24, 0, 0, Math.PI * 2);
    g.fill();
    if (pucker) {
      g.fillStyle = '#ffb3a8';
      for (const ex of [-62, 62]) {
        g.beginPath();
        g.arc(cx + ex, cy + 45, 26, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#c4505a';
      g.beginPath();
      g.ellipse(cx, cy + 82, 22, 18, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#5a1c22';
      g.beginPath();
      g.ellipse(cx, cy + 82, 9, 7, 0, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillStyle = '#b8424c';
      g.beginPath();
      g.ellipse(cx, cy + 72, 52, 34, 0, 0, Math.PI);
      g.fill();
      g.fillStyle = '#ffffff';
      g.fillRect(cx - 40, cy + 72, 80, 10);
    }
    // water / nature half
    const wg = g.createLinearGradient(fw, 0, w, h);
    wg.addColorStop(0, '#3fb7e8');
    wg.addColorStop(1, '#1b6fb5');
    g.fillStyle = wg;
    g.fillRect(fw, 0, fw, h);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 3;
    for (let i = 0; i < 40; i++) {
      const xx = fw + rng.next() * fw, yy = rng.next() * h;
      g.beginPath();
      g.moveTo(xx, yy);
      g.quadraticCurveTo(xx + 12, yy - 5, xx + 26, yy);
      g.stroke();
    }
    // glass block grid
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 2;
    for (let xx = 0; xx <= w; xx += 16) {
      g.beginPath();
      g.moveTo(xx, 0);
      g.lineTo(xx, h);
      g.stroke();
    }
    for (let yy = 0; yy <= h; yy += 16) {
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(w, yy);
      g.stroke();
    }
  }, { seed, repeat: false });
  const texA = k.bag.add(face(false, 3)), texB = k.bag.add(face(true, 3));
  const mat = k.bag.add(new THREE.MeshStandardMaterial({ map: texA, emissive: '#ffffff', emissiveMap: texA, emissiveIntensity: 0.85, roughness: 0.25 }));
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const geos: THREE.BufferGeometry[] = [];
  const TW = 4.5, TH = 15, TD = 7, SEP = 20;
  for (const side of [-1, 1]) {
    const g = new THREE.BoxGeometry(TW, TH, TD).toNonIndexed();
    const uv = g.attributes.uv as THREE.BufferAttribute;
    // non-indexed box: 6 faces x 6 verts in order px, nx, py, ny, pz, nz
    for (let i = 0; i < uv.count; i++) {
      const f = Math.floor(i / 6);
      const u = uv.getX(i), v = uv.getY(i);
      if (f <= 1) uv.setXY(i, u * 0.5, v);
      else if (f >= 4) uv.setXY(i, 0.5 + u * 0.5, v);
      else uv.setXY(i, 0.75, 0.5);
    }
    g.translate(side * SEP, TH / 2 + 0.3, 0);
    g.applyMatrix4(b);
    geos.push(g);
  }
  const towers = new THREE.Mesh(k.bag.add(mergeGeometries(geos)!), mat);
  geos.forEach((g) => g.dispose());
  towers.castShadow = true;
  towers.name = 'crownFountain';
  k.group.add(towers);
  k.gloss.push([new THREE.BoxGeometry(SEP * 2 + 10, 0.3, TD + 8), '#39424f', L(b, M.t(0, 0.15, 0))]);
  k.gloss.push([new THREE.BoxGeometry(SEP * 2 - 6, 0.06, TD + 6), '#8fd2f0', L(b, M.t(0, 0.33, 0))]);
  // water spouts from the puckered mouths
  const spoutMat = k.bag.add(new THREE.MeshStandardMaterial({ color: '#e8f8ff', transparent: true, opacity: 0.75, emissive: '#9fdcff', emissiveIntensity: 0.4, roughness: 0.1, depthWrite: false }));
  const spouts = new THREE.Group();
  for (const side of [-1, 1]) {
    const x0 = side * (SEP - TW / 2), y0 = TH * 0.25 + 0.3;
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x0 - side * 5, y0 + 1.5, 0), new THREE.Vector3(x0 - side * 9, 0.3, 0));
    const tm = new THREE.Mesh(k.bag.add(new THREE.TubeGeometry(curve, 12, 0.28, 6)), spoutMat);
    spouts.add(tm);
  }
  spouts.applyMatrix4(b);
  spouts.visible = false;
  k.group.add(spouts);
  k.updaters.push((_dt, t) => {
    const pk = t % 7 > 4.5;
    const tex = pk ? texB : texA;
    if (mat.map !== tex) {
      mat.map = tex;
      mat.emissiveMap = tex;
    }
    spouts.visible = pk && t % 7 > 4.9;
  });
}

/** Jay Pritzker Pavilion: stage under curling stainless steel ribbons + trellis over the lawn (+Z). */
export function pritzkerPavilion(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, rng = new Rng(55)): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.solid.push([new THREE.BoxGeometry(32, 2, 18), '#8b8f98', L(b, M.t(0, 1, 0))]);
  k.solid.push([new THREE.BoxGeometry(32, 17, 2), '#cfd3d9', L(b, M.t(0, 8.5, -9))]);
  k.solid.push([new THREE.BoxGeometry(30, 1, 16), '#6b4a33', L(b, M.t(0, 2.1, 0))]);
  for (const sx of [-16, 16]) k.steel.push([new THREE.BoxGeometry(2.4, 18, 3), '#e6eaef', L(b, M.t(sx, 9, 7))]);
  k.steel.push([new THREE.BoxGeometry(34, 2.6, 3), '#e6eaef', L(b, M.t(0, 18.5, 7))]);
  // billowing ribbons framing the stage
  for (const side of [-1, 1]) for (let j = 0; j < 6; j++) {
    const r = 6 + j * 1.6 + rng.range(-0.5, 0.5);
    const g = new THREE.CylinderGeometry(r, r, 3.6 + rng.range(0, 1.4), 14, 1, true, rng.range(0, 1), rng.range(1.6, 2.6));
    k.steel.push([g, '#eef2f6', L(b, M.trs(side * (9 + j * 2.4), 19 + j * 2.6 + rng.range(-1, 1), 4 - j * 1.6, Math.PI / 2 + rng.range(-0.4, 0.4), side * rng.range(0.2, 0.7), side * (0.5 + j * 0.18)))]);
  }
  for (let j = 0; j < 4; j++) {
    const r = 7 + j * 2;
    const g = new THREE.CylinderGeometry(r, r, 3.4, 14, 1, true, Math.PI * 0.75, Math.PI * 0.5 + j * 0.15);
    k.steel.push([g, '#f4f7fa', L(b, M.trs(rng.range(-4, 4), 24 + j * 3, -2 - j * 2, Math.PI / 2, 0, rng.range(-0.3, 0.3)))]);
  }
  // trellis over the lawn
  const arch = (a: THREE.Vector3, c: THREE.Vector3, hgt: number) => {
    const n = 8;
    let prev = a.clone();
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const p = a.clone().lerp(c, t);
      p.y = a.y + Math.sin(t * Math.PI) * hgt;
      beam(k.steel, [prev.x, prev.y, prev.z], [p.x, p.y, p.z], 0.5, '#dfe5ec', b);
      prev = p;
    }
  };
  for (let i = -3; i <= 3; i++) arch(new THREE.Vector3(i * 10, 12, 12), new THREE.Vector3(i * 10, 12, 78), 6);
  for (const zz of [22, 36, 50, 64]) arch(new THREE.Vector3(-34, 12, zz), new THREE.Vector3(34, 12, zz), 4);
  for (const [px, pz] of [[-34, 22], [34, 22], [-34, 64], [34, 64], [0, 78]]) k.solid.push([new THREE.CylinderGeometry(1.0, 1.3, 12, 8), '#d8d8d2', L(b, M.t(px, 6, pz))]);
  k.solid.push([new THREE.CylinderGeometry(1, 1, 0.25, 32), '#5dbb4c', L(b, M.trs(0, 0.12, 46, 0, 0, 0, 38, 1, 32))]);
}

/** Picasso sculpture (Daley Plaza): abstract rust-steel head on a granite plinth. Faces +Z. */
export function picasso(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const c = '#94502c', cd = '#6e3a20';
  k.solid.push([new THREE.CylinderGeometry(14, 14.5, 0.3, 28), '#c9c2b6', L(b, M.t(0, 0.15, 0))]);
  k.solid.push([new THREE.BoxGeometry(8, 1.2, 6), '#8f8a80', L(b, M.t(0, 0.6, 0))]);
  // splayed legs
  beam(k.solid, [-2.4, 1.2, 2.2], [-0.8, 7.5, 0.6], 0.6, c, b, 2.6);
  beam(k.solid, [2.4, 1.2, 2.2], [0.8, 7.5, 0.6], 0.6, c, b, 2.6);
  beam(k.solid, [0, 1.2, -2.6], [0, 8, -1.0], 0.6, c, b, 3.4);
  // the face: a tall slab, leaning forward, with a long nose plate and two eyes
  k.solid.push([new THREE.BoxGeometry(5.2, 9, 0.7), c, L(b, M.trs(0, 11.5, 0.9, -0.12, 0, 0))]);
  k.solid.push([new THREE.BoxGeometry(0.6, 6.5, 2.6), c, L(b, M.trs(0, 11.2, 2.2, -0.12, 0, 0))]);
  for (const ex of [-1.3, 1.3]) k.solid.push([new THREE.CylinderGeometry(0.55, 0.55, 0.5, 10).rotateX(Math.PI / 2), cd, L(b, M.trs(ex, 13.6, 1.6, -0.12, 0, 0))]);
  k.solid.push([new THREE.BoxGeometry(5.8, 0.6, 2.8), c, L(b, M.trs(0, 16.2, 0.6, -0.12, 0, 0))]);
  // the two big wings (hair / ears) sweeping back
  for (const side of [-1, 1]) {
    k.solid.push([new THREE.SphereGeometry(1, 14, 10), c, L(b, M.trs(side * 3.3, 11.5, -2.4, 0.2, side * 0.5, side * 0.1, 0.25, 6.4, 3.8))]);
  }
  // harp rods between the wings
  for (let i = 0; i < 9; i++) beam(k.solid, [-3.0, 7.8 + i * 1.0, -2.2], [3.0, 7.8 + i * 1.0, -2.2], 0.18, cd, b);
  for (let i = 0; i < 5; i++) beam(k.solid, [-2.4, 8.5 + i * 1.6, 0.6], [2.4, 8.5 + i * 1.6, -2.6], 0.16, cd, b);
}

/** Bronze lion statue on a plinth (Art Institute style), faces +Z. */
export function lionParts(parts: P, b: THREE.Matrix4): void {
  const br = '#5f7f66', st = '#d7d0c0';
  parts.push([new THREE.BoxGeometry(2.4, 2.4, 5.2), st, L(b, M.t(0, 1.2, 0))]);
  parts.push([new THREE.BoxGeometry(2.7, 0.3, 5.5), '#c9c2b2', L(b, M.t(0, 2.5, 0))]);
  parts.push([new THREE.CapsuleGeometry(0.75, 2.4, 3, 8).rotateX(Math.PI / 2), br, L(b, M.t(0, 3.85, -0.3))]);
  for (const [lx, lz] of [[-0.5, 1.0], [0.5, 1.0], [-0.5, -1.6], [0.5, -1.6]]) parts.push([new THREE.CylinderGeometry(0.22, 0.26, 1.3, 6), br, L(b, M.t(lx, 3.2, lz))]);
  parts.push([new THREE.IcosahedronGeometry(1.05, 1), '#4f6d57', L(b, M.t(0, 4.75, 1.3))]);
  parts.push([new THREE.SphereGeometry(0.62, 10, 8), br, L(b, M.t(0, 4.75, 1.95))]);
  parts.push([new THREE.BoxGeometry(0.5, 0.35, 0.4), '#4a6551', L(b, M.t(0, 4.55, 2.5))]);
  parts.push([new THREE.CylinderGeometry(0.08, 0.1, 1.6, 5), br, L(b, M.trs(0, 4.1, -2.3, -0.8, 0, 0))]);
}

/** Classical museum with columns, pediment, steps, lions and banners. Front faces +Z. */
export function artMuseum(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, title = 'ART MUSEUM'): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const st = '#efe8d8';
  k.facade('cream', boxUV(64, 15, 30, 0, 0, -6), b);
  k.solid.push([new THREE.BoxGeometry(66, 1.6, 32), '#e3dbc8', L(b, M.t(0, 15.6, -6))]);
  // portico
  for (let i = 0; i < 6; i++) k.solid.push([new THREE.CylinderGeometry(0.75, 0.85, 11, 10), st, L(b, M.t(-10 + i * 4, 3.5 + 5.5, 11.5))]);
  k.solid.push([new THREE.BoxGeometry(26, 1.6, 6), st, L(b, M.t(0, 15.2, 11))]);
  const ped = new THREE.CylinderGeometry(1, 1, 6, 3).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
  k.solid.push([ped, st, L(b, M.trs(0, 17.1, 11, 0, 0, 0, 1, 2.4, 13))]);
  for (let i = 0; i < 4; i++) k.solid.push([new THREE.BoxGeometry(30 + i * 2, 0.9, 3), '#dcd4c2', L(b, M.t(0, 0.45 + i * 0.9 - 0.9 * 0, 18.5 - i * 1.6))]);
  k.solid.push([new THREE.BoxGeometry(28, 3.5, 6), '#e2dac7', L(b, M.t(0, 1.75, 12))]);
  k.solid.push([new THREE.BoxGeometry(5, 7, 0.4), '#3b2b20', L(b, M.t(0, 7, 9.1))]);
  for (const side of [-1, 1]) lionParts(k.solid, L(b, M.t(side * 17, 0, 18)));
  const ban = k.paint.draw(64, 192, (g, w, h) => {
    g.fillStyle = '#c8102e';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = '900 22px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    'ART'.split('').forEach((c, i) => g.fillText(c, w / 2, 40 + i * 30));
    g.fillStyle = '#ffd23f';
    g.fillRect(8, h - 50, w - 16, 6);
  }, 'artBanner');
  for (let i = 0; i < 5; i++) k.paint.quad(ban, 2.2, 6.5, L(b, M.t(-10 + i * 5, 9, 14.3)));
  const name = k.paint.text(title, 512, 64, { bg: '#efe8d8', fg: '#5a4a3a' });
  k.paint.quad(name, 18, 1.4, L(b, M.t(0, 15.2, 14.05)));
}

/** Field-Museum-ish classical hall + Shedd-ish octagon + Adler dome along the lake. */
export function museumHall(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const st = '#f2ede2';
  k.facade('cream', boxUV(96, 18, 36), b);
  k.solid.push([new THREE.BoxGeometry(98, 2, 38), '#e6dfd0', L(b, M.t(0, 19, 0))]);
  for (let i = 0; i < 10; i++) k.solid.push([new THREE.CylinderGeometry(0.9, 1, 14, 10), st, L(b, M.t(-18 + i * 4, 9, 20))]);
  k.solid.push([new THREE.BoxGeometry(42, 2, 5), st, L(b, M.t(0, 17, 20))]);
  const ped = new THREE.CylinderGeometry(1, 1, 5, 3).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
  k.solid.push([ped, st, L(b, M.trs(0, 19.3, 20, 0, 0, 0, 1, 2.6, 21))]);
  for (let i = 0; i < 3; i++) k.solid.push([new THREE.BoxGeometry(46, 0.7, 2.4), '#ddd5c4', L(b, M.t(0, 0.35 + i * 0.7, 26 - i * 1.4))]);
}

export function sheddAquarium(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.facade('cream', boxUV(70, 12, 26), b);
  k.solid.push([new THREE.CylinderGeometry(15, 16, 18, 8), '#f2ede2', L(b, M.t(0, 9, 0))]);
  k.solid.push([new THREE.ConeGeometry(15.5, 9, 8), '#d9cdb2', L(b, M.t(0, 22.5, 0))]);
  k.solid.push([new THREE.CylinderGeometry(2, 2, 3, 8), '#d9cdb2', L(b, M.t(0, 28, 0))]);
  for (let i = 0; i < 4; i++) k.solid.push([new THREE.CylinderGeometry(0.8, 0.9, 10, 8), '#f8f4ea', L(b, M.t(-6 + i * 4, 5, 17))]);
}

export function adlerPlanetarium(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.solid.push([new THREE.CylinderGeometry(15, 15.5, 11, 12), '#c9a27a', L(b, M.t(0, 5.5, 0))]);
  k.solid.push([new THREE.SphereGeometry(10.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), k.o.snow ? '#f4f8ff' : '#7a8c99', L(b, M.t(0, 11, 0))]);
  k.solid.push([new THREE.CylinderGeometry(15.6, 15.6, 1, 12), '#b38c63', L(b, M.t(0, 11, 0))]);
}

/* ================================================================== the Chicago Theatre marquee */

/** Chicago Theatre: vertical CHICAGO sign + marquee with chasing bulbs. Faces +Z. */
export function chicagoTheatre(k: Kit, x: number, y: number, z: number, rot: number, lines: [string, string]): void {
  const frame = (on: number) => canvasTexture(512, 512, (g, w, h) => {
    // vertical sign: x 0..96, y 0..512
    g.fillStyle = '#b3121f';
    g.fillRect(0, 0, 96, h);
    g.fillStyle = '#fff3cf';
    g.font = '900 58px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    'CHICAGO'.split('').forEach((ch, i) => g.fillText(ch, 48, 44 + i * 68));
    const bulb = (bx: number, by: number, lit: boolean, col = '#ffe680') => {
      g.fillStyle = lit ? col : '#6b4a2a';
      g.beginPath();
      g.arc(bx, by, 4.5, 0, Math.PI * 2);
      g.fill();
    };
    let n = 0;
    for (let yy = 8; yy < h - 4; yy += 14) {
      bulb(8, yy, (n + on) % 2 === 0);
      bulb(88, yy, (n + on + 1) % 2 === 0);
      n++;
    }
    // marquee: x 104..512, y 0..200
    const mx = 104, mw = w - mx, mh = 200;
    g.fillStyle = '#1c1416';
    g.fillRect(mx, 0, mw, mh);
    g.fillStyle = '#fff8e6';
    g.fillRect(mx + 22, 22, mw - 44, mh - 44);
    g.fillStyle = '#16120f';
    g.font = '900 52px "Arial Black", Impact, sans-serif';
    g.fillText(lines[0], mx + mw / 2, 68, mw - 60);
    g.fillStyle = '#b3121f';
    g.font = '900 40px "Arial Black", Impact, sans-serif';
    g.fillText(lines[1], mx + mw / 2, 136, mw - 60);
    n = 0;
    for (let xx = mx + 8; xx < w - 4; xx += 13) {
      bulb(xx, 8, (n + on) % 2 === 0);
      bulb(xx, mh - 8, (n + on + 1) % 2 === 0);
      n++;
    }
    // marquee side faces: y 210..300 (gold + bulbs)
    g.fillStyle = '#b3121f';
    g.fillRect(mx, 210, mw, 90);
    n = 0;
    for (let xx = mx + 8; xx < w - 4; xx += 13) {
      bulb(xx, 228, (n + on) % 2 === 0);
      bulb(xx, 282, (n + on + 1) % 2 === 0);
      n++;
    }
    g.fillStyle = '#ffd36b';
    g.font = '900 30px "Arial Black", Impact, sans-serif';
    g.fillText('★ CHICAGO ★', mx + mw / 2, 255);
  }, { repeat: false });
  const texA = k.bag.add(frame(0)), texB = k.bag.add(frame(1));
  const mat = k.bag.add(new THREE.MeshBasicMaterial({ map: texA, toneMapped: false, color: new THREE.Color(1.15, 1.15, 1.15) }));
  const b = M.trs(x, y, z, 0, rot, 0);
  // building
  k.facade('cream', boxUV(36, 24, 18, 0, 0, -9), b);
  k.solid.push([new THREE.BoxGeometry(37, 1.4, 19), '#d8c9a8', L(b, M.t(0, 24.4, -9))]);
  k.solid.push([new THREE.BoxGeometry(15, 13, 0.6), '#4a2e1c', L(b, M.t(0, 10.5, 0.05))]);
  k.solid.push([new THREE.CylinderGeometry(7.5, 7.5, 0.6, 16, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2), '#4a2e1c', L(b, M.t(0, 17, 0.05))]);
  k.solid.push([new THREE.TorusGeometry(7.9, 0.5, 4, 16, Math.PI), '#e8c87a', L(b, M.t(0, 17, 0.3))]);
  const geos: THREE.BufferGeometry[] = [];
  const quad = (u0: number, v0: number, u1: number, v1: number, w: number, h: number, m: THREE.Matrix4) => {
    const p = new THREE.PlaneGeometry(w, h);
    const uv = p.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (u0 + uv.getX(i) * (u1 - u0)) / 512, 1 - (v0 + (1 - uv.getY(i)) * (v1 - v0)) / 512);
    p.applyMatrix4(L(b, m));
    geos.push(p.toNonIndexed());
    p.dispose();
  };
  // vertical sign sticking out from the facade (perpendicular, readable along the street)
  k.solid.push([new THREE.BoxGeometry(1.4, 22, 5.6), '#8f0e18', L(b, M.t(0, 21, 3.6))]);
  quad(0, 0, 96, 512, 5.4, 21.6, M.trs(0.75, 21, 3.6, 0, Math.PI / 2, 0));
  quad(0, 0, 96, 512, 5.4, 21.6, M.trs(-0.75, 21, 3.6, 0, -Math.PI / 2, 0));
  // marquee box
  k.solid.push([new THREE.BoxGeometry(24, 4.6, 6.4), '#2a1a12', L(b, M.t(0, 8, 3.2))]);
  quad(104, 0, 512, 200, 24, 4.6, M.t(0, 8, 6.45));
  quad(104, 210, 330, 300, 6.4, 4.6, M.trs(12.05, 8, 3.2, 0, Math.PI / 2, 0));
  quad(104, 210, 330, 300, 6.4, 4.6, M.trs(-12.05, 8, 3.2, 0, -Math.PI / 2, 0));
  const mesh = new THREE.Mesh(k.bag.add(mergeGeometries(geos)!), mat);
  geos.forEach((g) => g.dispose());
  mesh.name = 'theatreMarquee';
  k.group.add(mesh);
  k.updaters.push((_dt, t) => {
    const tex = Math.floor(t * 4) % 2 ? texB : texA;
    if (mat.map !== tex) mat.map = tex;
  });
}

/* ================================================================== food stands & street props */

/** Chicago-style hot dog stand with a giant dog on the roof and the NO KETCHUP sign. Faces +Z. */
export function hotDogStand(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.solid.push([new THREE.BoxGeometry(7, 3.4, 4.6), '#ffd23f', L(b, M.t(0, 1.7, 0))]);
  k.solid.push([new THREE.BoxGeometry(5.6, 1.5, 0.2), '#2b1d12', L(b, M.t(0, 2.1, 2.32))]);
  k.solid.push([new THREE.BoxGeometry(6.2, 0.2, 0.9), '#c0c0c0', L(b, M.t(0, 1.35, 2.6))]);
  k.solid.push([new THREE.BoxGeometry(7.4, 0.4, 5), '#c8102e', L(b, M.t(0, 3.6, 0))]);
  for (let i = 0; i < 7; i++) k.solid.push([new THREE.BoxGeometry(1.0, 0.12, 1.6), i % 2 ? '#ffffff' : '#c8102e', L(b, M.trs(-3 + i, 3.15, 3.0, 0.4, 0, 0))]);
  // the giant dog: poppy-seed bun, red-hot frank, mustard zigzag, relish, tomatoes, pickle, peppers
  const d = L(b, M.trs(0, 4.9, 0, 0, 0, 0.08));
  for (const bz of [-0.55, 0.55]) k.solid.push([new THREE.CapsuleGeometry(0.75, 4.6, 4, 10).rotateZ(Math.PI / 2), '#e9b66b', L(d, M.trs(0, 0, bz, 0, 0, 0, 1, 0.85, 0.9))]);
  k.solid.push([new THREE.CapsuleGeometry(0.55, 5.8, 4, 10).rotateZ(Math.PI / 2), '#b8432b', L(d, M.t(0, 0.5, 0))]);
  for (let i = 0; i < 9; i++) beam(k.solid, [-2.6 + i * 0.6, 1.08, -0.3 + (i % 2) * 0.6], [-2.0 + i * 0.6, 1.08, 0.3 - (i % 2) * 0.6], 0.16, '#ffd400', d, 0.16);
  for (let i = 0; i < 10; i++) k.solid.push([new THREE.BoxGeometry(0.28, 0.2, 0.28), '#3ee03e', L(d, M.trs(-2.3 + i * 0.5, 1.05, (i % 3 - 1) * 0.3, 0, i, 0))]);
  for (const tx of [-1.2, 0.4, 1.8]) k.solid.push([new THREE.CylinderGeometry(0.42, 0.42, 0.14, 10), '#e8392b', L(d, M.trs(tx, 0.98, -0.62, 0.5, 0, 0))]);
  k.solid.push([new THREE.CapsuleGeometry(0.2, 3.6, 3, 6).rotateZ(Math.PI / 2), '#4f9a2a', L(d, M.t(0, 0.85, 0.7))]);
  for (const px of [-2.0, 2.2]) k.solid.push([new THREE.ConeGeometry(0.18, 0.8, 6).rotateZ(Math.PI / 2), '#7cc24a', L(d, M.t(px, 1.0, 0.15))]);
  const sign = k.paint.text('CHICAGO\nHOT DOGS', 256, 128, { bg: '#c8102e', fg: '#ffffff', border: '#ffd23f', stroke: '#7a0a18' });
  k.paint.quad(sign, 5.4, 2.7, L(b, M.t(0, 2.2 + 3.1 + 2.1, -0.9)), true);
  k.solid.push([new THREE.BoxGeometry(0.2, 2.2, 0.2), '#444', L(b, M.t(-2.5, 4.6, -0.9))]);
  k.solid.push([new THREE.BoxGeometry(0.2, 2.2, 0.2), '#444', L(b, M.t(2.5, 4.6, -0.9))]);
  const nk = k.paint.draw(128, 128, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    // ketchup bottle
    g.fillStyle = '#d0121f';
    g.fillRect(w / 2 - 14, 36, 28, 52);
    g.fillRect(w / 2 - 7, 22, 14, 16);
    g.fillStyle = '#ffffff';
    g.fillRect(w / 2 - 10, 54, 20, 10);
    g.strokeStyle = '#d0121f';
    g.lineWidth = 9;
    g.beginPath();
    g.arc(w / 2, 58, 40, 0, Math.PI * 2);
    g.moveTo(w / 2 - 28, 30);
    g.lineTo(w / 2 + 28, 86);
    g.stroke();
    g.fillStyle = '#111';
    g.font = '900 17px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText('NO KETCHUP!', w / 2, 116);
  }, 'noKetchup');
  k.paint.quad(nk, 1.6, 1.6, L(b, M.t(2.6, 2.2, 2.35)));
  const menu = k.paint.text('VIENNA BEEF\n$5 DOG', 256, 128, { bg: '#1f6b3a', fg: '#ffe066' });
  void menu;
  const menu2 = k.paint.text('DRAGGED THRU\nTHE GARDEN', 256, 128, { bg: '#2f8f3a', fg: '#ffffff' });
  k.paint.quad(menu2, 2.2, 1.1, L(b, M.t(-2.3, 2.95, 2.35)));
}

/** Deep-dish pizzeria storefront with a giant pie on the roof. Faces +Z. */
export function pizzeria(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.facade('brick', boxUV(11, 6.5, 8, 0, 0, -4), b);
  k.solid.push([new THREE.BoxGeometry(11.4, 0.6, 8.4), '#e9dcc4', L(b, M.t(0, 6.8, -4))]);
  k.solid.push([new THREE.BoxGeometry(8, 2.4, 0.2), '#ffe7a8', L(b, M.t(0, 1.9, 0.02))]);
  for (let i = 0; i < 9; i++) k.solid.push([new THREE.BoxGeometry(1.25, 0.12, 1.6), ['#1f8f3a', '#ffffff', '#c8102e'][i % 3], L(b, M.trs(-5 + i * 1.25, 3.6, 0.7, 0.45, 0, 0))]);
  const p = L(b, M.trs(0, 7.2, -3, -0.35, 0, 0));
  k.solid.push([new THREE.CylinderGeometry(2.8, 2.6, 1.3, 20), '#d99a4e', L(p, M.t(0, 0.65, 0))]);
  k.solid.push([new THREE.CylinderGeometry(2.45, 2.45, 0.2, 20), '#c7321f', L(p, M.t(0, 1.32, 0))]);
  for (let i = 0; i < 7; i++) k.solid.push([new THREE.SphereGeometry(0.34, 6, 4), '#ffe08a', L(p, M.trs(Math.cos(i * 2.4) * (0.6 + (i % 3) * 0.55), 1.4, Math.sin(i * 2.4) * (0.6 + (i % 3) * 0.55), 0, 0, 0, 1, 0.35, 1))]);
  const sign = k.paint.text('DEEP DISH\nPIZZA', 256, 128, { bg: '#1f8f3a', fg: '#ffffff', border: '#ffffff', stroke: '#0c4a1c' });
  k.paint.quad(sign, 6, 3, L(b, M.t(0, 5.0, 0.12)));
}

/** Italian beef stand. Faces +Z. */
export function beefStand(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.solid.push([new THREE.BoxGeometry(8, 4, 6), '#f4efe6', L(b, M.t(0, 2, -3))]);
  k.solid.push([new THREE.BoxGeometry(8.4, 0.5, 6.4), '#c8102e', L(b, M.t(0, 4.25, -3))]);
  k.solid.push([new THREE.BoxGeometry(6, 1.6, 0.2), '#2b1d12', L(b, M.t(0, 2.2, 0.02))]);
  const sb = L(b, M.trs(0, 5.6, -3, 0, 0, 0.05));
  k.solid.push([new THREE.CapsuleGeometry(0.7, 3.6, 4, 10).rotateZ(Math.PI / 2), '#e9c27e', L(sb, M.trs(0, 0, 0, 0, 0, 0, 1, 0.8, 1))]);
  k.solid.push([new THREE.BoxGeometry(4.2, 0.45, 1.2), '#7a3b22', L(sb, M.t(0, 0.55, 0))]);
  for (let i = 0; i < 8; i++) k.solid.push([new THREE.BoxGeometry(0.3, 0.2, 0.3), ['#f28c1c', '#3ec04a', '#e8392b', '#f4e04a'][i % 4], L(sb, M.t(-1.6 + i * 0.45, 0.85, (i % 2) * 0.3 - 0.15))]);
  const sign = k.paint.text('ITALIAN\nBEEF', 256, 128, { bg: '#ffffff', fg: '#c8102e', border: '#1f8f3a' });
  k.paint.quad(sign, 5, 2.5, L(b, M.t(0, 3.0, 0.15)));
}

/** Popcorn shop (cheese + caramel mix) with a striped tub on the roof. Faces +Z. */
export function popcornShop(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  k.facade('cream', boxUV(9, 6, 7, 0, 0, -3.5), b);
  k.solid.push([new THREE.BoxGeometry(7, 2.6, 0.2), '#ffe9a8', L(b, M.t(0, 1.8, 0.02))]);
  const t = L(b, M.t(0, 6, -3.5));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.solid.push([new THREE.BoxGeometry(1.25, 3.2, 0.2), i % 2 ? '#ffffff' : '#d0121f', L(t, M.trs(Math.cos(a) * 2.0, 1.6, Math.sin(a) * 2.0, 0, -a + Math.PI / 2, 0))]);
  }
  for (let i = 0; i < 14; i++) k.solid.push([new THREE.IcosahedronGeometry(0.62, 0), i % 2 ? '#ffb02e' : '#ffe066', L(t, M.t(Math.cos(i * 2.1) * (i % 3) * 0.7, 3.4 + (i % 4) * 0.25, Math.sin(i * 2.1) * (i % 3) * 0.7))]);
  const sign = k.paint.text('CHEESE +\nCARAMEL CORN', 256, 128, { bg: '#d0121f', fg: '#ffe066', border: '#ffffff' });
  k.paint.quad(sign, 5.4, 2.7, L(b, M.t(0, 4.4, 0.12)));
}

/** Blue CTA-style bus shelter. Faces +Z. */
export function busShelterGeo(): THREE.BufferGeometry {
  const f = '#1d5fae';
  return mergeColored([
    [new THREE.BoxGeometry(4.6, 0.15, 1.8), f, M.t(0, 2.6, 0)],
    [new THREE.BoxGeometry(4.6, 2.3, 0.08), '#bfe6f7', M.t(0, 1.35, -0.85)],
    [new THREE.BoxGeometry(0.08, 2.3, 1.6), '#bfe6f7', M.t(-2.25, 1.35, 0)],
    [new THREE.BoxGeometry(1.4, 2.0, 0.12), '#ffd23f', M.t(1.4, 1.3, -0.8)],
    [new THREE.BoxGeometry(0.12, 2.6, 0.12), f, M.t(-2.3, 1.3, 0.85)],
    [new THREE.BoxGeometry(0.12, 2.6, 0.12), f, M.t(2.3, 1.3, 0.85)],
    [new THREE.BoxGeometry(0.12, 2.6, 0.12), f, M.t(-2.3, 1.3, -0.85)],
    [new THREE.BoxGeometry(0.12, 2.6, 0.12), f, M.t(2.3, 1.3, -0.85)],
    [new THREE.BoxGeometry(2.4, 0.12, 0.5), '#8a8f99', M.t(-0.6, 0.55, -0.55)],
    [new THREE.BoxGeometry(0.5, 0.5, 0.06), '#ffffff', M.t(1.9, 2.25, 0.9)],
    [new THREE.CylinderGeometry(0.05, 0.05, 3, 5), '#777', M.t(2.8, 1.5, 0.7)],
    [new THREE.BoxGeometry(0.06, 0.5, 0.5), '#1d5fae', M.t(2.8, 2.8, 0.7)],
  ]);
}

/** Light-blue shared bikes in a dock. Faces +Z. */
export function bikeDockGeo(): THREE.BufferGeometry {
  const parts: P = [[new THREE.BoxGeometry(6.5, 0.15, 0.3), '#8a8f99', M.t(0, 0.08, 0)]];
  for (let i = 0; i < 5; i++) {
    const bx = -2.6 + i * 1.3;
    parts.push([new THREE.BoxGeometry(0.2, 0.9, 0.3), '#555b66', M.t(bx, 0.5, -0.6)]);
    for (const wz of [-0.55, 0.55]) parts.push([new THREE.TorusGeometry(0.33, 0.05, 4, 10).rotateY(Math.PI / 2), '#222', M.t(bx, 0.35, wz)]);
    parts.push([new THREE.BoxGeometry(0.1, 0.1, 1.1), '#3db7e4', M.trs(bx, 0.62, 0, 0.15, 0, 0)]);
    parts.push([new THREE.BoxGeometry(0.08, 0.6, 0.08), '#3db7e4', M.t(bx, 0.7, 0.45)]);
    parts.push([new THREE.BoxGeometry(0.6, 0.06, 0.06), '#333', M.t(bx, 1.0, 0.45)]);
    parts.push([new THREE.BoxGeometry(0.4, 0.25, 0.3), '#3db7e4', M.t(bx, 0.8, 0.7)]);
  }
  return mergeColored(parts);
}

/** Folding lawn chair "saving" a parking spot (dibs!), with a traffic cone. */
export function dibsGeo(): THREE.BufferGeometry {
  return mergeColored([
    [new THREE.BoxGeometry(0.7, 0.08, 0.6), '#ffffff', M.t(0, 0.45, 0)],
    [new THREE.BoxGeometry(0.7, 0.75, 0.08), '#ffffff', M.trs(0, 0.85, -0.32, -0.25, 0, 0)],
    [new THREE.BoxGeometry(0.05, 0.9, 0.05), '#cfcfcf', M.trs(-0.33, 0.45, 0, 0.5, 0, 0)],
    [new THREE.BoxGeometry(0.05, 0.9, 0.05), '#cfcfcf', M.trs(0.33, 0.45, 0, 0.5, 0, 0)],
    [new THREE.BoxGeometry(0.05, 0.9, 0.05), '#cfcfcf', M.trs(-0.33, 0.45, 0, -0.5, 0, 0)],
    [new THREE.BoxGeometry(0.05, 0.9, 0.05), '#cfcfcf', M.trs(0.33, 0.45, 0, -0.5, 0, 0)],
    [new THREE.ConeGeometry(0.22, 0.7, 8), '#ff7a1a', M.t(1.0, 0.38, 0.3)],
    [new THREE.BoxGeometry(0.5, 0.05, 0.5), '#ff7a1a', M.t(1.0, 0.03, 0.3)],
    [new THREE.CylinderGeometry(0.23, 0.2, 0.12, 8), '#ffffff', M.t(1.0, 0.45, 0.3)],
  ]);
}

/** Wooden rooftop water tank on stilts. */
export function rooftopTankGeo(snow = false): THREE.BufferGeometry {
  const parts: P = [];
  for (const [lx, lz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) parts.push([new THREE.BoxGeometry(0.25, 3, 0.25), '#3b3b3b', M.t(lx, 1.5, lz)]);
  parts.push([new THREE.CylinderGeometry(2, 2, 0.3, 10), '#3b3b3b', M.t(0, 3, 0)]);
  parts.push([new THREE.CylinderGeometry(1.9, 2.0, 3.6, 12), '#8a5a36', M.t(0, 4.95, 0)]);
  for (const hy of [3.8, 5.0, 6.2]) parts.push([new THREE.CylinderGeometry(2.04, 2.04, 0.12, 12), '#2f2f2f', M.t(0, hy, 0)]);
  parts.push([new THREE.ConeGeometry(2.1, 1.4, 12), snow ? '#f4f8ff' : '#5a3a26', M.t(0, 7.45, 0)]);
  return mergeColored(parts);
}

/** White lifeguard chair. */
export function lifeguardGeo(): THREE.BufferGeometry {
  const w = '#f4f4f4';
  return mergeColored([
    [new THREE.BoxGeometry(0.15, 3.2, 0.15), w, M.trs(-0.7, 1.6, 0.5, 0.15, 0, 0)],
    [new THREE.BoxGeometry(0.15, 3.2, 0.15), w, M.trs(0.7, 1.6, 0.5, 0.15, 0, 0)],
    [new THREE.BoxGeometry(0.15, 3.2, 0.15), w, M.trs(-0.7, 1.6, -0.5, -0.15, 0, 0)],
    [new THREE.BoxGeometry(0.15, 3.2, 0.15), w, M.trs(0.7, 1.6, -0.5, -0.15, 0, 0)],
    [new THREE.BoxGeometry(1.6, 0.15, 1.0), w, M.t(0, 3.1, 0)],
    [new THREE.BoxGeometry(1.6, 0.9, 0.12), w, M.t(0, 3.6, -0.45)],
    [new THREE.ConeGeometry(1.5, 0.6, 8), '#e8392b', M.t(0, 5.0, 0)],
    [new THREE.CylinderGeometry(0.05, 0.05, 1.8, 5), '#cfcfcf', M.t(0, 4.0, 0)],
    [new THREE.BoxGeometry(0.9, 0.9, 0.06), '#e8392b', M.t(0, 2.2, 0.62)],
  ]);
}

/** Lamp-post banner cloth (pivot at the pole, uv.x 0 at the pole). */
export function bannerBatch(k: Kit, name = 'banners'): Batch {
  const tex = k.bag.add(chicagoBannerTexture());
  return k.batch(new THREE.PlaneGeometry(0.95, 1.9, 6, 2).translate(0.5, 0, 0), flagMaterial(k.bag, tex, k.time), { cast: false, name });
}

/** Chicago-flag bunting texture for railings / barriers (repeat along u). */
export function flagStripTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    drawChicagoFlag(g, 4, 4, w / 2 - 8, h - 8);
    drawChicagoFlag(g, w / 2 + 4, 4, w / 2 - 8, h - 8);
  });
}

/* ================================================================== elevated L */

export interface LOpts {
  a: [number, number];
  b: [number, number];
  deckY?: number;
  /** line colors for the cars' stripe (one per train) */
  lines?: string[];
  cars?: number;
  stations?: Array<{ at: number; name: string; color: string }>;
  lit?: boolean;
  snow?: boolean;
  /** seconds for one pass */
  period?: number;
  phase?: number;
}

/**
 * Green-painted elevated L structure with lattice girders between two points, columns only where
 * the ground is clear of the track, optional stations, and CTA-style trains shuttling along it.
 */
export function elevatedL(k: Kit, placer: Placer, o: LOpts): void {
  const field = placer.field;
  const [ax, az] = o.a, [bx, bz] = o.b;
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len, uz = (bz - az) / len;
  const yaw = Math.atan2(-uz, ux); // local +x -> world (ux, uz)
  const deckY = o.deckY ?? 9.5;
  const steel = '#3f6a4c', steelD = '#2f5239';
  const base = M.trs(ax, 0, az, 0, yaw, 0);
  // rotation by yaw maps local +z to (sin yaw, 0, cos yaw) = (-uz, 0, ux)
  const toWorld = (lx: number, lz: number) => ({ x: ax + ux * lx - uz * lz, z: az + uz * lx + ux * lz });
  const P2 = (lx: number, ly: number, lz: number) => L(base, M.t(lx, ly, lz));
  const s = k.solid;
  const ties = o.snow ? '#f4f8ff' : '#3a332c';
  s.push([new THREE.BoxGeometry(len, 0.35, 7.2), steelD, P2(len / 2, deckY, 0)]);
  s.push([new THREE.BoxGeometry(len, 0.25, 6.2), ties, P2(len / 2, deckY + 0.3, 0)]);
  for (const rz of [-2.4, -1.0, 1.0, 2.4]) s.push([new THREE.BoxGeometry(len, 0.22, 0.18), '#9a9a9a', P2(len / 2, deckY + 0.55, rz)]);
  // lattice girders
  const step = k.q === 'low' ? 6 : 3;
  for (const side of [-3.5, 3.5]) {
    s.push([new THREE.BoxGeometry(len, 0.4, 0.4), steel, P2(len / 2, deckY + 0.5, side)]);
    s.push([new THREE.BoxGeometry(len, 0.4, 0.4), steel, P2(len / 2, deckY - 1.5, side)]);
    for (let x = 0; x < len; x += step) {
      s.push([new THREE.BoxGeometry(0.25, 2.0, 0.25), steel, P2(x, deckY - 0.5, side)]);
      if (x + step <= len) beam(s, [x, deckY - 1.4, side], [x + step, deckY + 0.4, side], 0.18, steel, base);
    }
  }
  // columns where the ground is clear
  for (let x = 6; x < len - 3; x += 16) {
    const p0 = toWorld(x, -3.3), p1 = toWorld(x, 3.3), pm = toWorld(x, 0);
    if (field.clearance(p0.x, p0.z) < 1.2 || field.clearance(p1.x, p1.z) < 1.2 || field.clearance(pm.x, pm.z) < 0.5) continue;
    const gy = Math.min(field.height(p0.x, p0.z), field.height(p1.x, p1.z));
    const h = deckY - 1.5 - gy;
    for (const cz of [-3.3, 3.3]) {
      s.push([new THREE.BoxGeometry(0.8, h, 0.8), steel, L(base, M.t(x, gy + h / 2, cz))]);
      s.push([new THREE.BoxGeometry(1.3, 0.4, 1.3), steelD, L(base, M.t(x, gy + 0.2, cz))]);
      beam(s, [x, deckY - 3.6, cz], [x + 1.8, deckY - 1.6, cz], 0.3, steel, base);
      beam(s, [x, deckY - 3.6, cz], [x - 1.8, deckY - 1.6, cz], 0.3, steel, base);
    }
    s.push([new THREE.BoxGeometry(0.6, 0.6, 7.4), steel, L(base, M.t(x, deckY - 1.8, 0))]);
  }
  for (let x = 0; x < len; x += 10) {
    const p = toWorld(x, 0);
    placer.reserve(p.x, p.z, 5);
  }
  // stations
  for (const st of o.stations ?? []) {
    const sx = st.at * len;
    for (const side of [-1, 1]) {
      const pz = side * 5.6;
      s.push([new THREE.BoxGeometry(44, 0.5, 3.6), '#8b8f97', L(base, M.t(sx, deckY + 0.6, pz))]);
      s.push([new THREE.BoxGeometry(44, 0.15, 0.5), '#ffd23f', L(base, M.t(sx, deckY + 0.9, pz - side * 1.6))]);
      // riders waiting on the platform
      if (k.q !== 'low') {
        const rr = new Rng(Math.round(sx * 7 + side * 13 + 999));
        for (let px = -19; px <= 19; px += k.q === 'high' ? 2.6 : 4.5) {
          if (rr.chance(0.35)) continue;
          const w = toWorld(sx + px + rr.range(-0.6, 0.6), pz + side * rr.range(-0.2, 0.9));
          k.person(w.x, deckY + 0.85, w.z, yaw + (side > 0 ? Math.PI : 0) + rr.range(-0.4, 0.4), rr.pick(['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#41B6E6', '#14315e']), rr.range(0.85, 1));
        }
      }
      for (let px = -20; px <= 20; px += 8) s.push([new THREE.BoxGeometry(0.25, 3.6, 0.25), steelD, L(base, M.t(sx + px, deckY + 2.6, pz + side * 1.2))]);
      s.push([new THREE.BoxGeometry(44, 0.3, 4.6), o.snow ? '#f4f8ff' : '#6b4a33', L(base, M.trs(sx, deckY + 4.5, pz, side * 0.12, 0, 0))]);
      s.push([new THREE.BoxGeometry(44, 1.1, 0.1), '#5a3a26', L(base, M.t(sx, deckY + 1.5, pz + side * 1.8))]);
      const sign = k.paint.draw(320, 64, (g, w, h) => {
        g.fillStyle = '#111';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff';
        g.font = '700 34px Arial, Helvetica, sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(st.name, 16, h / 2);
        g.fillStyle = st.color;
        g.beginPath();
        g.arc(w - 30, h / 2, 16, 0, Math.PI * 2);
        g.fill();
      }, `stn-${st.name}-${st.color}`);
      for (const px of [-12, 12]) k.paint.quad(sign, 6, 1.2, L(base, M.trs(sx + px, deckY + 3.6, pz + side * 1.0, 0, side > 0 ? Math.PI : 0, 0)), true);
      // stairs down when the ground below is clear
      const sw = toWorld(sx + 14, pz + side * 4);
      if (field.clearance(sw.x, sw.z) > 2) {
        const gy = field.height(sw.x, sw.z);
        beam(s, [sx + 4, deckY + 0.6, pz + side * 3.5], [sx + 4 + (deckY - gy) * 1.2, gy, pz + side * 3.5], 1.6, '#6e737c', base, 2.2);
      }
    }
  }
  // trains
  const nCars = o.cars ?? 4;
  const lines = o.lines ?? [CTA.green, CTA.pink];
  const trains = lines.length;
  const carL = 14.5;
  const carGeo = k.bag.add(mergeColored([
    [new THREE.BoxGeometry(14, 3.0, 3.0), '#c9ced6', M.t(0, 1.9, 0)],
    [new THREE.BoxGeometry(14.06, 0.32, 3.06), '#ffffff', M.t(0, 1.05, 0)],
    [new THREE.BoxGeometry(14.06, 0.18, 3.06), '#ffffff', M.t(0, 3.05, 0)],
    [new THREE.BoxGeometry(12.6, 0.95, 3.08), o.lit ? '#ffe2a0' : '#26354c', M.t(0, 2.4, 0)],
    [new THREE.BoxGeometry(0.9, 2.0, 3.09), '#9aa1aa', M.t(-3.2, 1.9, 0)],
    [new THREE.BoxGeometry(0.9, 2.0, 3.09), '#9aa1aa', M.t(3.2, 1.9, 0)],
    [new THREE.BoxGeometry(13.6, 0.35, 2.6), o.snow ? '#ffffff' : '#a8adb5', M.t(0, 3.55, 0)],
    [new THREE.BoxGeometry(10, 0.7, 2.2), '#2a2a2a', M.t(0, 0.4, 0)],
    [new THREE.BoxGeometry(0.1, 0.5, 1.6), '#ff9b2f', M.t(7.03, 3.0, 0)],
    [new THREE.BoxGeometry(0.1, 0.5, 1.6), '#ff9b2f', M.t(-7.03, 3.0, 0)],
  ]));
  const mat = o.lit
    ? tintMaskMat(k.bag, { roughness: 0.35, metalness: 0.35, emissive: '#2a1d08' })
    : tintMaskMat(k.bag, { roughness: 0.35, metalness: 0.35 });
  const im = new THREE.InstancedMesh(carGeo, mat, nCars * trains);
  for (let tI = 0; tI < trains; tI++) for (let c = 0; c < nCars; c++) im.setColorAt(tI * nCars + c, new THREE.Color(lines[tI]));
  im.castShadow = true;
  im.frustumCulled = false;
  im.name = 'Ltrains';
  k.group.add(im);
  let lights: THREE.InstancedMesh | null = null;
  if (o.lit) {
    // holiday light strings along the car roofs
    const lp: P = [];
    const cols = ['#ff3b3b', '#3ccf6e', '#ffd23f', '#3aa8ff'];
    for (let i = 0; i < 12; i++) for (const zz of [-1.5, 1.5]) lp.push([new THREE.OctahedronGeometry(0.16, 0), cols[(i + (zz > 0 ? 1 : 0)) % 4], M.t(-6.6 + i * 1.2, 3.35, zz)]);
    lights = new THREE.InstancedMesh(k.bag.add(mergeColored(lp)), k.glowMat, nCars * trains);
    lights.frustumCulled = false;
    k.group.add(lights);
  }
  const period = o.period ?? 30;
  const span = len + nCars * carL * 2;
  k.updaters.push((_dt, t) => {
    for (let tI = 0; tI < trains; tI++) {
      const ph = ((t + (o.phase ?? 0)) / period + tI / trains) % 2;
      const dir = ph < 1 ? 1 : -1;
      const f = ph < 1 ? ph : ph - 1;
      const head = -nCars * carL + f * span;
      const lz = (tI % 2 ? 1 : -1) * 1.7;
      for (let c = 0; c < nCars; c++) {
        let lx = dir > 0 ? head - c * carL : len - head + c * carL;
        const vis = lx > 6 && lx < len - 6;
        lx = Math.min(len - 6, Math.max(6, lx));
        const p = toWorld(lx, lz);
        const sc = vis ? 1 : 0.0001;
        setInstance(im, tI * nCars + c, p.x, deckY + 0.55, p.z, 0, yaw, 0, sc);
        if (lights) setInstance(lights, tI * nCars + c, p.x, deckY + 0.55, p.z, 0, yaw, 0, sc);
      }
    }
    im.instanceMatrix.needsUpdate = true;
    if (lights) lights.instanceMatrix.needsUpdate = true;
  });
}

/* ================================================================== helpers */

/** Find a free spot near (x, z) with clearance >= margin (spiral search). */
export function findSpot(placer: Placer, x: number, z: number, r: number, margin: number, maxShift = 60): { x: number; z: number } | null {
  if (placer.ok(x, z, r, margin)) return { x, z };
  for (let d = 4; d <= maxShift; d += 4) {
    for (let a = 0; a < 16; a++) {
      const xx = x + Math.cos((a / 16) * Math.PI * 2) * d, zz = z + Math.sin((a / 16) * Math.PI * 2) * d;
      if (placer.ok(xx, zz, r, margin)) return { x: xx, z: zz };
    }
  }
  return null;
}

/** Yaw that turns a prop's +Z toward the nearest road point. */
export function faceRoad(placer: Placer, x: number, z: number): number {
  const n = placer.field.nearest(x, z, 200);
  if (!n) return 0;
  return Math.atan2(n.sample.x - x, n.sample.z - z);
}

/* ================================================================== ballpark */

/**
 * Old-time North Side ballpark: brick bowl, ivy-covered outfield wall, hand-turned scoreboard,
 * light towers and the famous red marquee at the entrance (+Z faces the entrance / home plate side).
 */
export function ballpark(k: Kit, x: number, y: number, z: number, rot = 0, lines: [string, string] = ['FRIENDLY CONFINES', 'HOME OF THE CUBBIES']): void {
  const b = M.trs(x, y, z, 0, rot, 0);
  const R = 56, H = 13;
  const wall = new THREE.CylinderGeometry(R, R, H, 28, 1, true).translate(0, H / 2, 0);
  scaleUV(wall, Math.PI * 2 * R, H);
  k.facade('brick', wall, b);
  k.solid.push([new THREE.CylinderGeometry(R + 0.6, R + 0.6, 1.2, 28, 1, true), '#e9e1cf', L(b, M.t(0, H, 0))]);
  // seating bowl + roof ring
  k.solid.push([new THREE.CylinderGeometry(R - 1, 38, H - 2, 28, 1, true), '#2f5f3a', L(b, M.t(0, (H - 2) / 2 + 1, 0))]);
  k.solid.push([new THREE.CylinderGeometry(R - 0.5, R - 9, 0.6, 28, 1, true), '#8d939c', L(b, M.t(0, H + 3, 0))]);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    k.solid.push([new THREE.BoxGeometry(0.4, 4, 0.4), '#5b616a', L(b, M.t(Math.cos(a) * (R - 8), H + 1, Math.sin(a) * (R - 8)))]);
  }
  // field: grass, infield dirt, bases, ivy outfield wall
  k.solid.push([new THREE.CylinderGeometry(38, 38, 0.3, 32), '#4fae3f', L(b, M.t(0, 0.6, 0))]);
  for (let i = 0; i < 6; i++) k.solid.push([new THREE.BoxGeometry(76, 0.02, 5), i % 2 ? '#4fae3f' : '#5cbd4a', L(b, M.t(0, 0.77, -30 + i * 12))]);
  const home = L(b, M.t(0, 0, 26));
  k.solid.push([new THREE.BoxGeometry(20, 0.1, 20), '#c79a62', L(home, M.trs(0, 0.8, -14, 0, Math.PI / 4, 0))]);
  k.solid.push([new THREE.BoxGeometry(13, 0.12, 13), '#5cbd4a', L(home, M.trs(0, 0.82, -14, 0, Math.PI / 4, 0))]);
  for (const [bx, bz] of [[0, 0], [9.9, -9.9], [0, -19.8], [-9.9, -9.9]]) k.solid.push([new THREE.BoxGeometry(0.8, 0.2, 0.8), '#ffffff', L(home, M.trs(bx, 0.9, bz - 4, 0, Math.PI / 4, 0))]);
  const ivy = new THREE.CylinderGeometry(38.2, 38.2, 4.2, 20, 1, true, Math.PI * 0.75, Math.PI * 1.5);
  k.solid.push([ivy, '#2e8a2e', L(b, M.t(0, 2.6, 0))]);
  // bleachers + scoreboard in deep center
  k.solid.push([new THREE.BoxGeometry(30, 10, 10), '#2f5f3a', L(b, M.trs(0, 5, -R + 4, 0.35, 0, 0))]);
  const sb = L(b, M.t(0, H + 2, -R + 2));
  k.solid.push([new THREE.BoxGeometry(28, 9, 3), '#1f5a32', L(sb, M.t(0, 4.5, 0))]);
  k.solid.push([new THREE.BoxGeometry(5, 3, 3), '#1f5a32', L(sb, M.t(0, 10.5, 0))]);
  const grid = k.paint.draw(256, 96, (g, w, h) => {
    g.fillStyle = '#1f5a32';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.font = '700 14px Arial, sans-serif';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) {
      g.fillStyle = (r + c) % 3 ? '#ffffff' : '#ffd23f';
      g.fillRect(14 + c * 23, 10 + r * 20, 16, 14);
    }
  }, 'scoreboard');
  k.paint.quad(grid, 26, 8, L(sb, M.trs(0, 4.5, 1.55, 0, 0, 0)));
  k.paint.quad(grid, 26, 8, L(sb, M.trs(0, 4.5, -1.55, 0, Math.PI, 0)));
  // light towers
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const lx = Math.cos(a) * (R - 3), lz = Math.sin(a) * (R - 3);
    k.solid.push([new THREE.BoxGeometry(1, 16, 1), '#6b7079', L(b, M.t(lx, H + 8, lz))]);
    k.solid.push([new THREE.BoxGeometry(6, 3, 0.6), '#4a4f58', L(b, M.trs(lx, H + 17, lz, 0, -a + Math.PI / 2, 0))]);
    k.glow.push([new THREE.BoxGeometry(5.4, 2.4, 0.2), '#fff6d8', L(b, M.trs(lx - Math.cos(a) * 0.4, H + 17, lz - Math.sin(a) * 0.4, 0, -a + Math.PI / 2, 0))]);
  }
  // pennants along the roof
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const px = Math.cos(a) * (R + 0.3), pz = Math.sin(a) * (R + 0.3);
    k.solid.push([new THREE.CylinderGeometry(0.06, 0.06, 4, 4), '#dddddd', L(b, M.t(px, H + 2.6, pz))]);
    k.solid.push([new THREE.BoxGeometry(1.4, 0.8, 0.06), [CHI_BLUE, '#c8102e', '#ffffff', '#1d3f8f'][i % 4], L(b, M.trs(px + Math.cos(a + 1.57) * 0.7, H + 4.0, pz + Math.sin(a + 1.57) * 0.7, 0, -a, 0))]);
  }
  // the red marquee at the main entrance
  const mq = k.neon.draw(512, 200, (g, w, h) => {
    g.fillStyle = '#c8102e';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 56px "Arial Black", Impact, sans-serif';
    g.fillText(lines[0], w / 2, 52, w - 30);
    g.fillStyle = '#1c1c1c';
    g.fillRect(24, 96, w - 48, 84);
    g.fillStyle = '#ffffff';
    g.font = '700 40px Arial, sans-serif';
    g.fillText(lines[1], w / 2, 138, w - 70);
  }, 'ballparkMarquee');
  const m = L(b, M.t(0, 0, R + 9));
  k.solid.push([new THREE.BoxGeometry(0.7, 9, 0.7), '#2b2b2b', L(m, M.t(-6, 4.5, 0))]);
  k.solid.push([new THREE.BoxGeometry(0.7, 9, 0.7), '#2b2b2b', L(m, M.t(6, 4.5, 0))]);
  k.solid.push([new THREE.BoxGeometry(16, 6.6, 1.0), '#8f0e18', L(m, M.t(0, 10.5, 0))]);
  k.neon.quad(mq, 15.4, 6, L(m, M.t(0, 10.5, 0.52)));
  k.neon.quad(mq, 15.4, 6, L(m, M.trs(0, 10.5, -0.52, 0, Math.PI, 0)));
}

/** Corner tavern with neon window signs. Faces +Z. */
export function cornerTavern(k: Kit, x: number, y: number, z: number, rot = 0): void {
  const b = M.trs(x, y, z, 0, rot, 0);
  k.facade('brick', boxUV(12, 8.5, 12, 0, 0, -6), b);
  k.solid.push([new THREE.BoxGeometry(12.6, 0.8, 12.6), '#e9dcc4', L(b, M.t(0, 8.7, -6))]);
  k.solid.push([new THREE.BoxGeometry(9, 2.2, 0.2), '#1c2a3a', L(b, M.t(0, 1.9, 0.02))]);
  k.solid.push([new THREE.BoxGeometry(1.3, 2.6, 0.25), '#5a2f1c', L(b, M.t(5, 1.3, 0.05))]);
  const neon1 = k.neon.text('TAVERN', 256, 72, { bg: '#16100c', fg: '#ff5a7a', stroke: '#ff9ab0' });
  const neon2 = k.neon.text('COLD BEER', 256, 72, { bg: '#16100c', fg: '#6fe3ff' });
  k.neon.quad(neon1, 3.2, 0.9, L(b, M.t(-2.3, 2.3, 0.15)));
  k.neon.quad(neon2, 3.2, 0.9, L(b, M.t(2.0, 2.3, 0.15)));
  const sign = k.paint.text('CORNER TAP', 256, 64, { bg: '#1f6b3a', fg: '#ffffff', border: '#ffd23f' });
  k.solid.push([new THREE.BoxGeometry(0.15, 0.15, 1.6), '#333', L(b, M.t(-5.6, 5.6, 0.8))]);
  k.paint.quad(sign, 3, 0.8, L(b, M.trs(-5.6, 5.0, 1.4, 0, Math.PI / 2, 0)), true);
}

/* ================================================================== Navy Pier & Buckingham Fountain */

/**
 * Navy Pier: long pier from the shore (x = shoreX) at z = pierZ with exhibition halls, the domed
 * ballroom, a harbor lighthouse, Chicago flags and the spinning Ferris wheel at (wheelX, wheelZ).
 * Returns the per-frame updater (wheel + gondolas); push it into your update loop.
 */
export function buildNavyPier(k: Kit, placer: Placer, o: { shoreX: number; pierZ: number; wheelX: number; wheelZ: number }): (dt: number, t: number) => void {
  const bag = k.bag, group = k.group, vc = k.solidMat, vcGloss = k.glossMat, timeU = k.time, shoreX = o.shoreX;
  const lo = k.q === 'low';
  const local: Array<(dt: number, t: number) => void> = [];
  const updaters = { push: (f: (dt: number, t: number) => void) => local.push(f) };

    const px0 = shoreX - 2, px1 = shoreX + 230, pz = o.pierZ;
    const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.BoxGeometry(px1 - px0, 1.2, 44), '#cdbfa6', M.t((px0 + px1) / 2, 0.6, pz)],
      [new THREE.BoxGeometry(px1 - px0, 2.5, 46), '#8b7d6b', M.t((px0 + px1) / 2, -1.2, pz)],
      // exhibition halls
      [new THREE.BoxGeometry(150, 9, 16), '#e9dcc4', M.t(px0 + 140, 5.7, pz + 12)],
      [new THREE.BoxGeometry(152, 1.2, 18), '#2f6f6a', M.t(px0 + 140, 10.8, pz + 12)],
      [new THREE.BoxGeometry(40, 16, 30), '#d9c19b', M.t(px1 - 22, 9.2, pz)],
      [new THREE.CylinderGeometry(9, 12, 6, 8), '#2f6f6a', M.t(px1 - 22, 20, pz)],
      [new THREE.BoxGeometry(14, 22, 14), '#c9a77c', M.t(px0 + 18, 12.2, pz + 10)],
      [new THREE.ConeGeometry(10.5, 6, 4).rotateY(Math.PI / 4), '#2f6f6a', M.t(px0 + 18, 26.2, pz + 10)],
    ];
    // railing posts along the pier edge
    for (let x = px0 + 4; x < px1; x += 8) {
      parts.push([new THREE.BoxGeometry(0.3, 1.1, 0.3), '#3c3c3c', M.t(x, 1.75, pz - 21.5)]);
    }
    parts.push([new THREE.BoxGeometry(px1 - px0, 0.2, 0.2), '#3c3c3c', M.t((px0 + px1) / 2, 2.2, pz - 21.5)]);
    const pm = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
    pm.castShadow = pm.receiveShadow = true;
    group.add(pm);
    placer.reserve((px0 + px1) / 2, pz, 120);
    {
      const lx = px1 + 30, lz = pz - 34;
      k.solid.push([new THREE.BoxGeometry(60, 2.4, 6), '#cbc3b0', M.t(px1 + 8, -0.4, lz)]);
      k.solid.push([new THREE.CylinderGeometry(6, 6.5, 6, 12), '#e9e3d6', M.t(lx, 2, lz)]);
      k.solid.push([new THREE.CylinderGeometry(2.6, 3.2, 16, 12), '#f7f4ee', M.t(lx, 12, lz)]);
      k.solid.push([new THREE.CylinderGeometry(3.3, 3.3, 0.8, 12), '#c8102e', M.t(lx, 20.2, lz)]);
      k.glow.push([new THREE.CylinderGeometry(1.8, 1.8, 2.2, 10), '#fff2b0', M.t(lx, 21.8, lz)]);
      k.solid.push([new THREE.ConeGeometry(2.6, 2.6, 10), '#c8102e', M.t(lx, 24.2, lz)]);
      const np = k.paint.text('NAVY PIER', 512, 128, { bg: '#1d3f73', fg: '#ffffff', border: '#ffd23f' });
      k.paint.quad(np, 16, 4, M.trs(px0 + 18, 15, pz + 17.3, 0, 0, 0));
      k.paint.quad(np, 16, 4, M.trs(px0 + 10.8, 15, pz + 10, 0, -Math.PI / 2, 0));
      // Chicago flags along the pier promenade
      const fp = k.batch(PROPS.flagpole(), vc, { name: 'pierPoles' });
      const fl = k.batch(flagGeometry(2.4, 1.6), flagMaterial(bag, bag.add(flagTexture('chicago')), timeU), { cast: false, name: 'pierFlags' });
      for (let x = px0 + 40; x < px1 - 40; x += lo ? 40 : 20) {
        fp.add(x, 1.2, pz - 20.5, 0);
        fl.add(x, 1.2 + 7.9, pz - 20.5, -Math.PI / 2 + 0.5);
      }
    }

    const fw = { x: o.wheelX, z: o.wheelZ };
    const R = 28;
    const hubY = 1.2 + R + 4;
    const wheelRoot = new THREE.Group();
    wheelRoot.position.set(fw.x, 0, fw.z - 6);
    wheelRoot.rotation.y = Math.PI / 2; // wheel plane faces the track (west)
    group.add(wheelRoot);
    // static A-frame supports
    const sup = mergeColored([
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(-9, hubY / 2, 3.5, 0, 0, -0.28)],
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(9, hubY / 2, 3.5, 0, 0, 0.28)],
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(-9, hubY / 2, -3.5, 0, 0, -0.28)],
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(9, hubY / 2, -3.5, 0, 0, 0.28)],
      [new THREE.CylinderGeometry(1.4, 1.4, 9, 12).rotateX(Math.PI / 2), '#cfcfcf', M.t(0, hubY, 0)],
    ]);
    const supM = new THREE.Mesh(bag.add(sup), vcGloss);
    supM.castShadow = true;
    wheelRoot.add(supM);
    const wheel = new THREE.Group();
    wheel.position.y = hubY;
    wheelRoot.add(wheel);
    const wparts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.TorusGeometry(R, 0.45, 6, 64), '#ffffff', M.t(0, 0, 1.6)],
      [new THREE.TorusGeometry(R, 0.45, 6, 64), '#ffffff', M.t(0, 0, -1.6)],
      [new THREE.TorusGeometry(R * 0.55, 0.3, 6, 48), '#ff4d4d', M.t(0, 0, 0)],
    ];
    const NS = 20;
    for (let i = 0; i < NS; i++) {
      const a = (i / NS) * Math.PI * 2;
      for (const zz of [1.6, -1.6]) {
        wparts.push([new THREE.BoxGeometry(0.22, R, 0.22), i % 2 ? '#ff4d4d' : '#ffffff', M.trs(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, zz, 0, 0, a - Math.PI / 2)]);
      }
    }
    // rim lights
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      wparts.push([new THREE.SphereGeometry(0.42, 6, 4), i % 2 ? '#fff27a' : '#ff7ad9', M.t(Math.cos(a) * R, Math.sin(a) * R, 2.1)]);
    }
    const wheelMesh = new THREE.Mesh(bag.add(mergeColored(wparts)), bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2, emissive: '#331a22', emissiveIntensity: 0.4 })));
    wheelMesh.castShadow = true;
    wheel.add(wheelMesh);
    const NG = 24;
    const gondGeo = bag.add(
      mergeColored([
        [new THREE.CylinderGeometry(1.5, 1.3, 2.6, 8), '#ffffff', M.t(0, -2.2, 0)],
        [new THREE.CylinderGeometry(1.7, 1.7, 0.4, 8), '#ffffff', M.t(0, -0.8, 0)],
        [new THREE.CylinderGeometry(1.52, 1.52, 1.0, 8), '#3b5f8a', M.t(0, -1.7, 0)],
        [new THREE.BoxGeometry(0.2, 1.0, 0.2), '#888', M.t(0, -0.3, 0)],
      ]),
    );
    const gond = new THREE.InstancedMesh(gondGeo, vc, NG);
    gond.castShadow = true;
    const gcol = ['#ff5a5a', '#ffb02e', '#ffe14d', '#4cd97b', '#3aa8ff', '#b26bff'];
    for (let i = 0; i < NG; i++) gond.setColorAt(i, new THREE.Color(gcol[i % gcol.length]));
    gond.position.y = hubY;
    wheelRoot.add(gond);
    gond.frustumCulled = false;
    updaters.push((_dt, t) => {
      const rot = t * 0.12;
      wheel.rotation.z = rot;
      for (let i = 0; i < NG; i++) {
        const a = rot + (i / NG) * Math.PI * 2;
        setInstance(gond, i, Math.cos(a) * R, Math.sin(a) * R, 0, 0, 0, Math.sin(t * 1.5 + i) * 0.05, 1);
      }
      gond.instanceMatrix.needsUpdate = true;
    });

  return (dt, t) => {
    for (const u of local) u(dt, t);
  };
}

/**
 * Buckingham Fountain at (x, z): pink-marble tiers, four sea horses, water basins (using `water`)
 * and a GPU-animated spray of jets. Reserves a 34 m circle in the placer.
 */
export function buildBuckingham(k: Kit, placer: Placer, x: number, z: number, water: THREE.Material): void {
  const bag = k.bag, group = k.group, vc = k.solidMat, timeU = k.time, lakeMat = water, quality = k.q;
  const rng = new Rng(808);
  const fo = { x, z };
  const updaters = k.updaters;

    placer.reserve(fo.x, fo.z, 34);
    const pink = '#f1c6b5';
    const fparts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.CylinderGeometry(26, 26.5, 1.2, 48), pink, M.t(fo.x, 0.6, fo.z)],
      [new THREE.CylinderGeometry(9, 11, 3, 24), pink, M.t(fo.x, 1.5, fo.z)],
      [new THREE.CylinderGeometry(10, 8, 1.2, 24), pink, M.t(fo.x, 3.6, fo.z)],
      [new THREE.CylinderGeometry(4, 5, 3, 16), pink, M.t(fo.x, 5.5, fo.z)],
      [new THREE.CylinderGeometry(6, 4.5, 1, 20), pink, M.t(fo.x, 7.4, fo.z)],
      [new THREE.CylinderGeometry(1.6, 2.4, 3, 12), pink, M.t(fo.x, 9.2, fo.z)],
      [new THREE.CylinderGeometry(3, 2, 0.8, 16), pink, M.t(fo.x, 10.9, fo.z)],
    ];
    // sea horses
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      fparts.push([new THREE.CylinderGeometry(0.9, 1.3, 3, 8), '#5f8f7a', M.trs(fo.x + Math.cos(a) * 17, 2.2, fo.z + Math.sin(a) * 17, 0.3 * Math.sin(a), 0, -0.3 * Math.cos(a))]);
    }
    // plaza ring + flower beds
    fparts.push([new THREE.CylinderGeometry(36, 36, 0.3, 48), '#e9dcc3', M.t(fo.x, 0.05, fo.z)]);
    const fm = new THREE.Mesh(bag.add(mergeColored(fparts)), vc);
    fm.castShadow = fm.receiveShadow = true;
    group.add(fm);
    const basinWater = new THREE.Mesh(bag.add(new THREE.CircleGeometry(25.6, 48)), lakeMat);
    basinWater.rotation.x = -Math.PI / 2;
    basinWater.position.set(fo.x, 1.05, fo.z);
    group.add(basinWater);
    const tier = new THREE.Mesh(bag.add(new THREE.CircleGeometry(9.5, 24)), lakeMat);
    tier.rotation.x = -Math.PI / 2;
    tier.position.set(fo.x, 4.25, fo.z);
    group.add(tier);
    // central jet: animated translucent column
    const jetMat = bag.add(new THREE.MeshStandardMaterial({ color: '#e6f6ff', transparent: true, opacity: 0.7, roughness: 0.1, emissive: '#9fd8ff', emissiveIntensity: 0.3, depthWrite: false }));
    const jet = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(0.4, 1.0, 1, 10, 1, true).translate(0, 0.5, 0)), jetMat);
    jet.position.set(fo.x, 11.2, fo.z);
    group.add(jet);
    // spray particles (GPU animated)
    const N = quality === 'low' ? 300 : 900;
    const pg = new THREE.BufferGeometry();
    const seeds = new Float32Array(N * 4);
    const velArr: number[] = [];
    for (let i = 0; i < N; i++) {
      const kind = i < N * 0.35 ? 0 : i < N * 0.75 ? 1 : 2; // 0 central, 1 rim ring, 2 seahorses
      let ox = 0, oz = 0, ang = rng.next() * Math.PI * 2, vy = 0, vh = 0;
      if (kind === 0) {
        vy = rng.range(17, 21);
        vh = rng.range(0.4, 1.8);
      } else if (kind === 1) {
        const a = rng.next() * Math.PI * 2;
        ox = Math.cos(a) * 9.5;
        oz = Math.sin(a) * 9.5;
        ang = a + Math.PI;
        vy = rng.range(6, 8);
        vh = rng.range(2.5, 3.5);
      } else {
        const a = (rng.int(4) / 4) * Math.PI * 2 + Math.PI / 4;
        ox = Math.cos(a) * 17;
        oz = Math.sin(a) * 17;
        ang = a + Math.PI + rng.range(-0.08, 0.08);
        vy = rng.range(7, 8.5);
        vh = rng.range(4.5, 5.5);
      }
      seeds[i * 4] = ox + Math.cos(ang) * 0.001;
      seeds[i * 4 + 1] = oz;
      seeds[i * 4 + 2] = ang;
      seeds[i * 4 + 3] = rng.next();
      velArr.push(vy, vh, kind === 0 ? 11.4 : kind === 1 ? 4.6 : 3.4);
    }
    const vel = new Float32Array(velArr);
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    pg.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), 40);
    bag.add(pg);
    const sprite = bag.add(dotTexture('rgba(255,255,255,1)', 'rgba(200,235,255,0)'));
    const pm = bag.add(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: timeU, uMap: { value: sprite } },
        vertexShader: `attribute vec4 aSeed; attribute vec3 aVel; uniform float uTime; varying float vA;
          void main(){
            float life = fract(uTime * 0.55 + aSeed.w);
            float t = life * 2.2;
            vec3 p = vec3(aSeed.x, aVel.z, aSeed.y);
            p.x += cos(aSeed.z) * aVel.y * t;
            p.z += sin(aSeed.z) * aVel.y * t;
            p.y += aVel.x * t - 0.5 * 18.0 * t * t;
            vA = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.75, 1.0, life)) * step(1.0, p.y);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = (2.4 + life * 2.6) * (300.0 / -mv.z);
          }`,
        fragmentShader: `uniform sampler2D uMap; varying float vA;
          void main(){ vec4 c = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vec3(0.92,0.97,1.0), c.a * vA * 0.85); }`,
      }),
    );
    const pts = new THREE.Points(pg, pm);
    pts.position.set(fo.x, 0, fo.z);
    group.add(pts);
    updaters.push((_dt, t) => {
      jet.scale.set(1, 9 + Math.sin(t * 2.1) * 1.6, 1);
    });

}

/* ================================================================== Chicago houses */

/** Window with white frame on a facade at local (x, y), facing +Z at depth z (optionally transformed). */
export function win(parts: P, x: number, y: number, z: number, w = 1.3, h = 1.7, glass = '#2e4a6b', frame = '#f4f1e8', xf?: THREE.Matrix4) {
  const t = (m: THREE.Matrix4) => (xf ? xf.clone().multiply(m) : m);
  parts.push([new THREE.BoxGeometry(w + 0.3, h + 0.3, 0.12), frame, t(M.t(x, y, z))]);
  parts.push([new THREE.BoxGeometry(w, h, 0.16), glass, t(M.t(x, y, z + 0.02))]);
  parts.push([new THREE.BoxGeometry(w + 0.5, 0.14, 0.35), frame, t(M.t(x, y - h / 2 - 0.15, z + 0.1))]);
}

/** Chicago two-flat (8 x 8.4 x 14 m, `simple` drops the side windows for far LOD): body tinted by instance color (brick), details untinted. Front faces +Z. */
export function twoFlat(simple = false): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const W = 8, H = 8.4, D = 14;
  const body = mergeColored([
    [new THREE.BoxGeometry(W, H, D), '#ffffff', M.t(0, H / 2, 0)],
    [new THREE.BoxGeometry(3.2, H - 0.6, 1.4), '#ffffff', M.t(-1.6, (H - 0.6) / 2, D / 2 + 0.6)], // bay
  ]);
  const d: P = [
    [new THREE.BoxGeometry(W + 0.5, 0.7, D + 0.5), '#e9dcc4', M.t(0, H + 0.1, 0)], // cornice
    [new THREE.BoxGeometry(W + 0.1, 0.3, D + 0.1), '#d8cab0', M.t(0, H / 2, 0)],
    [new THREE.BoxGeometry(2.6, 1.2, 2.6), '#cfc6b8', M.t(2.4, 0.6, D / 2 + 1.3)], // stoop
    [new THREE.BoxGeometry(1.3, 2.4, 0.2), '#5a2f1c', M.t(2.4, 2.4, D / 2 + 0.02)], // door
    [new THREE.BoxGeometry(3.0, 0.25, 2.2), '#5d4037', M.t(2.4, 3.8, D / 2 + 1.1)], // canopy
  ];
  for (const y of [2.6, 6.2]) win(d, -1.6, y, D / 2 + 1.32, 2.2, 1.9);
  win(d, 2.4, 6.2, D / 2 + 0.02, 1.2, 1.8);
  if (!simple) for (const side of [-1, 1]) {
    const xf = new THREE.Matrix4().makeRotationY((side * Math.PI) / 2);
    for (const z of [-4, 0, 4]) for (const y of [2.6, 6.2]) win(d, z, y, W / 2 + 0.02, 1.1, 1.6, '#2e4a6b', '#f4f1e8', xf);
  }
  return { body, detail: mergeColored(d) };
}

/** Brick bungalow with a hipped roof and porch. */
export function bungalow(): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const W = 9, H = 4.2, D = 13;
  const body = mergeColored([[new THREE.BoxGeometry(W, H, D), '#ffffff', M.t(0, H / 2, 0)]]);
  const d: P = [
    [new THREE.ConeGeometry(Math.hypot(W, D) / 2 + 0.6, 4.2, 4, 1).rotateY(Math.PI / 4), '#4a4f5a', M.trs(0, H + 2.05, 0, 0, 0, 0, W / Math.hypot(W, D) * 1.05, 1, D / Math.hypot(W, D) * 1.05)],
    [new THREE.BoxGeometry(2.0, 2.2, 1.0), '#ffffff', M.t(0, H + 2.2, 2.5)], // dormer
    [new THREE.ConeGeometry(1.5, 1.0, 4).rotateY(Math.PI / 4), '#4a4f5a', M.t(0, H + 3.7, 2.5)],
    [new THREE.BoxGeometry(W - 1, 0.4, 3), '#cfc6b8', M.t(0, 0.6, D / 2 + 1.5)], // porch
    [new THREE.BoxGeometry(W - 1, 0.25, 3.2), '#e8e1d4', M.t(0, 3.4, D / 2 + 1.5)],
    [new THREE.BoxGeometry(0.35, 2.8, 0.35), '#f2efe8', M.t(-W / 2 + 0.8, 2.0, D / 2 + 2.8)],
    [new THREE.BoxGeometry(0.35, 2.8, 0.35), '#f2efe8', M.t(W / 2 - 0.8, 2.0, D / 2 + 2.8)],
    [new THREE.BoxGeometry(1.2, 2.2, 0.2), '#7a2e1f', M.t(1.8, 1.9, D / 2 + 0.02)],
  ];
  win(d, -2.0, 2.2, D / 2 + 0.02, 2.6, 1.6);
  win(d, 0, 6.5, 3.02, 1.2, 1.0);
  return { body, detail: mergeColored(d) };
}

/** Wooden frame house with a gable roof (siding color = instance tint). */
export function frameHouse(): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const W = 7.5, H = 6, D = 12;
  const gable = new THREE.BufferGeometry();
  const hw = W / 2, rh = 3.2;
  gable.setAttribute('position', new THREE.Float32BufferAttribute([-hw, 0, D / 2, hw, 0, D / 2, 0, rh, D / 2, hw, 0, -D / 2, -hw, 0, -D / 2, 0, rh, -D / 2], 3));
  gable.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  gable.computeVertexNormals();
  const body = mergeColored([
    [new THREE.BoxGeometry(W, H, D), '#ffffff', M.t(0, H / 2, 0)],
    [gable, '#ffffff', M.t(0, H, 0)],
  ]);
  const roofL = new THREE.BoxGeometry(Math.hypot(hw, rh) + 0.6, 0.25, D + 0.8);
  const ang = Math.atan2(rh, hw);
  const d: P = [
    [roofL, '#8b3a2e', M.trs(-hw / 2, H + rh / 2 + 0.1, 0, 0, 0, ang)],
    [roofL.clone(), '#8b3a2e', M.trs(hw / 2, H + rh / 2 + 0.1, 0, 0, 0, -ang)],
    [new THREE.BoxGeometry(W + 0.2, 0.3, 0.2), '#ffffff', M.t(0, H, D / 2 + 0.05)],
    [new THREE.BoxGeometry(1.2, 2.3, 0.2), '#2f4f8f', M.t(-2, 1.7, D / 2 + 0.02)],
    [new THREE.BoxGeometry(2.8, 0.6, 1.8), '#d8d0c2', M.t(-2, 0.3, D / 2 + 0.9)],
  ];
  win(d, 1.6, 2.2, D / 2 + 0.02, 1.6, 1.7);
  win(d, -1.6, 4.6, D / 2 + 0.02, 1.2, 1.4);
  win(d, 1.6, 4.6, D / 2 + 0.02, 1.2, 1.4);
  win(d, 0, 7.2, D / 2 + 0.02, 1.0, 1.0);
  return { body, detail: mergeColored(d) };
}


/* ================================================================== blues club, welcome billboard, wind */

/** Blues club storefront: dark brick, red door, and a big blue/red neon BLUES sign (blooms). Faces +Z. */
export function bluesClub(k: Kit, x: number, y: number, z: number, rot = 0, name = 'BLUES'): void {
  const b = M.trs(x, y, z, 0, rot, 0);
  k.facade('brick', boxUV(12, 9, 10, 0, 0, -5), b);
  k.solid.push([new THREE.BoxGeometry(12.6, 0.8, 10.6), '#2b2523', L(b, M.t(0, 9.2, -5))]);
  k.solid.push([new THREE.BoxGeometry(12.2, 3.4, 0.25), '#1b1416', L(b, M.t(0, 1.7, 0.06))]);
  k.solid.push([new THREE.BoxGeometry(1.4, 2.6, 0.3), '#b3121f', L(b, M.t(3.8, 1.3, 0.12))]);
  k.solid.push([new THREE.BoxGeometry(8, 0.2, 2.2), '#1b1416', L(b, M.trs(-1.5, 3.3, 1.0, 0.25, 0, 0))]);
  const sign = k.neon.draw(320, 112, (g, w, h) => {
    g.fillStyle = '#0b0a14';
    g.fillRect(0, 0, w, h);
    g.lineJoin = 'round';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'italic 900 78px "Arial Black", Impact, sans-serif';
    g.strokeStyle = '#2a6bff';
    g.lineWidth = 12;
    g.strokeText(name, w / 2, h / 2 + 4);
    g.strokeStyle = '#9fd0ff';
    g.lineWidth = 4;
    g.strokeText(name, w / 2, h / 2 + 4);
    g.strokeStyle = '#ff2a4a';
    g.lineWidth = 5;
    g.strokeRect(8, 8, w - 16, h - 16);
  }, `blues-${name}`);
  const note = k.neon.draw(96, 112, (g, w, h) => {
    g.fillStyle = '#0b0a14';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ff3a5a';
    g.fillStyle = '#ff3a5a';
    g.lineWidth = 7;
    g.beginPath();
    g.ellipse(32, 80, 14, 10, -0.4, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(44, 78);
    g.lineTo(44, 18);
    g.lineTo(76, 30);
    g.stroke();
  }, 'bluesNote');
  // projecting sign perpendicular to the facade + a flat one over the door
  k.solid.push([new THREE.BoxGeometry(0.5, 2.6, 6.6), '#111', L(b, M.t(-5.4, 6.2, 3.3))]);
  k.neon.quad(sign, 6.4, 2.2, L(b, M.trs(-5.1, 6.2, 3.3, 0, Math.PI / 2, 0)));
  k.neon.quad(sign, 6.4, 2.2, L(b, M.trs(-5.7, 6.2, 3.3, 0, -Math.PI / 2, 0)));
  k.neon.quad(sign, 5.4, 1.9, L(b, M.t(-1, 4.6, 0.2)));
  k.neon.quad(note, 1.4, 1.7, L(b, M.t(2.6, 4.6, 0.2)));
}

/**
 * Big lit welcome billboard: "SWEET HOME CHICAGO" over a skyline silhouette with the Chicago flag
 * stars. Faces +Z (both sides printed). ~20 m wide, 13 m tall: keep it well outside the walls.
 */
export function sweetHomeBillboard(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const art = k.paint.draw(512, 224, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#2f7fe0');
    sky.addColorStop(1, '#ffd6a0');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    // skyline silhouette: Willis, Hancock, Marina, generic
    g.fillStyle = '#1d2a44';
    const sil: Array<[number, number, number]> = [[20, 40, 70], [60, 26, 120], [90, 30, 96], [124, 22, 150], [150, 16, 82], [170, 26, 110], [370, 28, 130], [402, 20, 88], [426, 36, 160], [466, 24, 104], [492, 20, 78]];
    for (const [sx, sw, sh] of sil) g.fillRect(sx, h - sh, sw, sh);
    g.fillRect(132, h - 172, 3, 24);
    g.fillRect(142, h - 168, 3, 20);
    g.fillRect(436, h - 186, 3, 28);
    g.fillRect(450, h - 186, 3, 28);
    g.fillStyle = '#ffffff';
    g.fillRect(0, h - 8, w, 8);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.font = 'italic 900 44px "Arial Black", Impact, sans-serif';
    g.strokeStyle = '#0c2a5c';
    g.lineWidth = 9;
    g.strokeText('SWEET HOME', w / 2, 52);
    g.fillStyle = '#ffffff';
    g.fillText('SWEET HOME', w / 2, 52);
    g.font = '900 64px "Arial Black", Impact, sans-serif';
    g.strokeStyle = '#7a0a18';
    g.lineWidth = 11;
    g.strokeText('CHICAGO', w / 2, 112);
    g.fillStyle = '#E4002B';
    g.fillText('CHICAGO', w / 2, 112);
    g.fillStyle = '#41B6E6';
    g.fillRect(150, 150, 212, 8);
    g.fillRect(150, 186, 212, 8);
    g.fillStyle = '#E4002B';
    for (let i = 0; i < 4; i++) {
      const cx = 186 + i * 46, cy = 172, r = 12;
      g.beginPath();
      for (let j = 0; j < 12; j++) {
        const rr = j % 2 ? r * 0.5 : r, a = (j / 12) * Math.PI * 2 - Math.PI / 2;
        if (j === 0) g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        else g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.fill();
    }
  }, 'sweetHome');
  for (const px of [-7, 7]) {
    k.solid.push([new THREE.BoxGeometry(0.9, 7, 0.9), '#3a3f47', L(b, M.t(px, 3.5, 0))]);
    beam(k.solid, [px, 0, -2.5], [px, 6.5, -0.3], 0.4, '#3a3f47', b);
  }
  k.solid.push([new THREE.BoxGeometry(21.2, 9.6, 0.6), '#1b2235', L(b, M.t(0, 11.6, 0))]);
  k.solid.push([new THREE.BoxGeometry(21.6, 0.5, 1.6), '#2a3040', L(b, M.t(0, 6.6, 0.4))]);
  k.paint.quad(art, 20.4, 8.9, L(b, M.t(0, 11.6, 0.32)));
  k.paint.quad(art, 20.4, 8.9, L(b, M.trs(0, 11.6, -0.32, 0, Math.PI, 0)));
  // marquee bulbs along the frame (glow)
  for (let i = 0; i <= 26; i++) for (const yy of [7.0, 16.2]) k.glow.push([new THREE.OctahedronGeometry(0.17, 0), i % 2 ? '#fff1b0' : '#ffd060', L(b, M.t(-10.4 + i * 0.8, yy, 0.45))]);
}

/**
 * "Windy City" gusts: leaves / confetti specks blowing sideways around the camera (one draw call).
 * Returns nothing; animation runs on k.time.
 */
export function windGusts(k: Kit, colors: string[], count: number, opts: { size?: number; box?: number; speed?: number } = {}): void {
  if (count <= 0) return;
  const BOX = opts.box ?? 90;
  const rng = new Rng(4711);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    pos.set([rng.next() * BOX, rng.next() * 14, rng.next() * BOX], i * 3);
    c.set(rng.pick(colors));
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = k.bag.add(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const u = { uTime: k.time, uCam: { value: new THREE.Vector3() } };
  const mat = k.bag.add(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: u,
    vertexShader: `uniform float uTime; uniform vec3 uCam; attribute vec3 color; varying vec3 vC; varying float vA; varying float vR;
      void main(){
        vec3 p = position;
        float sp = ${(opts.speed ?? 9).toFixed(1)} * (0.7 + fract(position.y * 3.1) * 0.6);
        p.x += uTime * sp;
        p.z += sin(uTime * 0.9 + position.x) * 3.0 + uTime * sp * 0.35;
        p.y += sin(uTime * 2.3 + position.z * 0.7) * 1.4;
        vec3 box = vec3(${BOX.toFixed(1)}, 14.0, ${BOX.toFixed(1)});
        vec3 rel = mod(p - uCam + box * 0.5, box) - box * 0.5;
        rel.y = mod(p.y, 14.0);
        vec3 wp = vec3(uCam.x, 0.0, uCam.z) + vec3(rel.x, rel.y + 0.3, rel.z);
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        vA = smoothstep(${(BOX * 0.5).toFixed(1)}, 18.0, d) * smoothstep(1.0, 4.0, d);
        vC = color;
        vR = uTime * 6.0 + position.x;
        gl_PointSize = ${(opts.size ?? 0.35).toFixed(2)} * (300.0 / max(d, 0.5));
      }`,
    fragmentShader: `varying vec3 vC; varying float vA; varying float vR;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float c = cos(vR), s = sin(vR);
        q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        float leaf = 1.0 - smoothstep(0.18, 0.24, length(q * vec2(1.0, 2.2)));
        if (leaf * vA < 0.05) discard;
        gl_FragColor = vec4(vC, leaf * vA);
      }`,
  }));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.name = 'windGusts';
  pts.onBeforeRender = (_r, _s, cam) => u.uCam.value.copy(cam.position);
  k.group.add(pts);
}

/* ================================================================== public builder API */
// Stable names for other tracks (e.g. the "Sweet Home Chicago" tour). All builders add into a Kit:
// create `new Kit(bag, group, { lit, snow, quality })`, call builders, then `kit.flush()` once and
// `kit.update(dt, t)` every frame. Positions are world meters; `rot` turns the builder's +Z front.

/** Cloud Gate "the Bean": chrome blob (own city reflection map) on a plaza. Returns the mesh. */
export const buildBean = cloudGate;
/** Willis (Sears) Tower at (x, y, z), rot, scale s (~340 m tall incl. antennas at s = 1). */
export const buildWillis = willisTower;
/** John Hancock Center: tapered X-braced black tower, twin antennas (~320 m at s = 1). */
export const buildHancock = hancockCenter;
/** Trump-style stepped glass tower with spire. */
export const buildGlassSpire = glassSpireTower;
/** Aon Center white slab. */
export const buildAon = aonCenter;
/** Marina City corn-cob twin towers. */
export const buildMarinaCity = marinaCity;
/** Tribune Tower (gothic crown). */
export const buildTribune = tribuneTower;
/** Wrigley Building with the clock tower. */
export const buildWrigleyBuilding = wrigleyBuilding;
/** Old Chicago Water Tower (limestone castle). */
export const buildWaterTower = waterTowerCastle;
/** Merchandise Mart block. */
export const buildMerchMart = merchMart;
/** St. Regis-style wavy glass tower. */
export const buildWavyTower = wavyTower;
/** Crown Fountain: LED face towers that pucker and spit water (animated). */
export const buildCrownFountain = crownFountain;
/** Jay Pritzker Pavilion stage, steel ribbons and lawn trellis (lawn toward +Z). */
export const buildPritzker = pritzkerPavilion;
/** Picasso sculpture on its plaza. */
export const buildPicasso = picasso;
/** Classical art museum with the two bronze lions. */
export const buildArtMuseum = artMuseum;
/**
 * Elevated L structure + CTA trains between two points (columns auto-skip the track corridors),
 * stations with signs and waiting riders. `lines` = stripe colors, one train per entry.
 */
export const buildLTrack = elevatedL;
/** Alias of buildLTrack (the trains are part of it). */
export const buildLTrain = elevatedL;
/** Chicago-style hot dog stand with the giant dog and the NO KETCHUP sign. */
export const buildHotDogStand = hotDogStand;
/** Deep-dish pizzeria storefront. */
export const buildPizzeria = pizzeria;
/** Italian beef stand. */
export const buildBeefStand = beefStand;
/** Cheese + caramel popcorn shop. */
export const buildPopcornShop = popcornShop;
/** Chicago Theatre: vertical CHICAGO sign + chasing-bulb marquee with two text lines. */
export const buildMarquee = chicagoTheatre;
/** Ivy-walled ballpark with scoreboard, light towers and the red marquee. */
export const buildIvyBallparkWall = ballpark;
/** Corner tap with neon window signs. */
export const buildTavern = cornerTavern;
/** Blues club with BLUES neon. */
export const buildBluesClub = bluesClub;
/** "SWEET HOME CHICAGO" lit welcome billboard. */
export const buildSweetHomeBillboard = sweetHomeBillboard;
/** Chicago two-flat geometry pair {body (tint per instance), detail}. */
export const buildTwoFlat = twoFlat;
/** Brick bungalow geometry pair {body, detail}. */
export const buildBungalow = bungalow;
/** Navy Pier + Ferris wheel (returns its per-frame updater). */
export const buildNavyPierAndWheel = buildNavyPier;

/**
 * Chicago flags on poles: returns a collector; call add(x, y, z, yaw) per pole (y = ground).
 * Cloth waves via the kit clock. `scale` resizes pole + flag.
 */
export function buildChicagoFlag(k: Kit, scale = 1): { add(x: number, y: number, z: number, yaw?: number): void } {
  const poles = k.batch(PROPS.flagpole(), k.solidMat, { name: 'chiFlagPoles' });
  const cloth = k.batch(flagGeometry(2.6 * scale, 1.7 * scale), flagMaterial(k.bag, k.bag.add(flagTexture('chicago')), k.time), { cast: false, name: 'chiFlags' });
  return {
    add(x: number, y: number, z: number, yaw = Math.PI / 2 + 0.6) {
      poles.add(x, y, z, 0, scale);
      cloth.add(x, y + 7.9 * scale, z, yaw);
    },
  };
}

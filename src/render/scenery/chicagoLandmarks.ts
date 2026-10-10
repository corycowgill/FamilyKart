import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import { Batch, type Bag, boxUV, BUILD, flagGeometry, flagMaterial, M, mergeColored, type Placer, PROPS, setInstance, timeOfDay, tintMaskMat, vcMat, windowedMaterial } from './common';
import { crowdMaterial, masonry, sharedEnv } from './materials';
import { acornLamp, awningParts, bevelBox, ctaShelter, divvyDock, flowerBed, grassTuft, hydrant, lathe, newsBoxes, parkBench, personDetailed, personSimple, tireStack, trashCan } from './props';
import { canvasTexture, chicagoBannerTexture, cityEnvTexture, dotTexture, drawChicagoFlag, drawChicagoSkyline, flagTexture, windowLitTexture, windowTexture } from './textures';

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
  /**
   * Any geometry (uv 0..1, e.g. a cylinder side or a box) showing `r`, placed by m. Lets labels wrap
   * round tins, book covers etc. while still sharing the one atlas material.
   */
  mapped(r: Rect, geo: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const S = this.size;
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const u = Math.min(1, Math.max(0, uv.getX(i))), v = Math.min(1, Math.max(0, uv.getY(i)));
      uv.setXY(i, (r.x + 1 + u * (r.w - 2)) / S, 1 - (r.y + 1 + (1 - v) * (r.h - 2)) / S);
    }
    if (m) g = g.applyMatrix4(m);
    this.geos.push(g);
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

const MASONRY: Partial<Record<FacadeKind, { size: [number, number]; mortar?: number; mortarColor?: string; jitter?: number; bump?: number }>> = {
  brick: { size: [0.62, 0.24], mortar: 0.16, mortarColor: '#d8cbb6', jitter: 0.22, bump: 1.4 },
  rust: { size: [0.62, 0.24], mortar: 0.12, mortarColor: '#8a6a55', jitter: 0.16 },
  stone: { size: [1.5, 0.62], mortar: 0.08, mortarColor: '#cbbd9f', jitter: 0.08, bump: 1.0 },
  tan: { size: [1.3, 0.55], mortar: 0.08, mortarColor: '#bfa077', jitter: 0.1 },
  cream: { size: [1.4, 0.6], mortar: 0.07, mortarColor: '#d9ccb2', jitter: 0.07 },
  white: { size: [1.1, 0.55], mortar: 0.06, mortarColor: '#dcd8cc', jitter: 0.05, bump: 0.7 },
};

export interface KitOpts {
  /** window glow at dusk (0 = daytime, ~1 = night) */
  lit: number;
  snow: boolean;
  quality: Quality;
  /** paint atlas size (default 1024) */
  atlas?: number;
}

export class Kit {
  readonly solid: P = [];
  readonly gloss: P = [];
  /** bright stainless steel, double sided */
  readonly steel: P = [];
  /** unlit glowing bulbs / neon (blooms) */
  readonly glow: P = [];
  readonly paint: SignAtlas;
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
  /** small near-only details, merged per spatial cell and hidden beyond nearDist */
  private nearCells = new Map<string, { solid: P; gloss: P; steel: P; glow: P; x: number; z: number; n: number }>();
  readonly nearDist: number;
  constructor(readonly bag: Bag, readonly group: THREE.Group, readonly o: KitOpts) {
    this.paint = new SignAtlas(o.atlas ?? 1024);
    this.solidMat = vcMat(bag, { roughness: 0.78 });
    this.glossMat = vcMat(bag, { roughness: 0.3, metalness: 0.35 });
    this.steelMat = vcMat(bag, { roughness: 0.2, metalness: 0.7, side: THREE.DoubleSide });
    this.glowMat = bag.add(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(1.3, 1.3, 1.3) }));
    this.tintMat = tintMaskMat(bag, { roughness: 0.6 });
    this.nearDist = o.quality === 'high' ? 300 : 170;
    if (o.quality !== 'low') {
      // metals / glossy paint reflect a stylised city sky instead of going flat grey
      const dusk = o.lit > 0 || BUILD.tod !== 'day';
      const env = sharedEnv(bag, dusk);
      for (const [m, k] of [[this.steelMat, 0.9], [this.glossMat, 0.55]] as const) {
        m.envMap = env;
        m.envMapIntensity = k * (BUILD.tod === 'night' ? 0.6 : 1);
      }
    }
  }
  /** Is fine geometric detail built at this quality? */
  get fine(): boolean {
    return this.o.quality !== 'low';
  }
  /**
   * Small detail (window frames, rivets, rooftop clutter, street props...) only drawn near the
   * camera: merged per ~110 m cell into a THREE.LOD that drops it beyond nearDist. Skipped on 'low'.
   */
  near(layer: 'solid' | 'gloss' | 'steel' | 'glow', geo: THREE.BufferGeometry, col: THREE.ColorRepresentation, m: THREE.Matrix4): void {
    if (!this.fine) {
      geo.dispose();
      return;
    }
    const x = m.elements[12], z = m.elements[14];
    const key = `${Math.floor(x / 110)},${Math.floor(z / 110)}`;
    let c = this.nearCells.get(key);
    if (!c) this.nearCells.set(key, (c = { solid: [], gloss: [], steel: [], glow: [], x: 0, z: 0, n: 0 }));
    c[layer].push([geo, col, m]);
    c.x += x;
    c.z += z;
    c.n++;
  }
  /** Push many parts (same layer) to the near layer. */
  nearParts(layer: 'solid' | 'gloss' | 'steel' | 'glow', parts: P): void {
    for (const [g, c, m] of parts) this.near(layer, g, c, m ?? new THREE.Matrix4());
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
    if (this.o.quality !== 'low') {
      // stylised masonry on the wall parts of the facade (chunky bricks / ashlar blocks)
      const mz = MASONRY[kind];
      if (mz) masonry(m, { space: 'uv', cell: f.cell, wall: f.wall, ...mz });
    }
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
    for (const c of this.nearCells.values()) {
      const lod = new THREE.LOD();
      lod.position.set(c.x / c.n, 0, c.z / c.n);
      lod.name = 'nearDetail';
      const holder = new THREE.Group();
      const off = new THREE.Matrix4().makeTranslation(-lod.position.x, 0, -lod.position.z);
      const layer = (parts: P, mat: THREE.Material, cast: boolean) => {
        if (!parts.length) return;
        const geo = this.bag.add(mergeColored(parts.map(([g, col, m]) => [g, col, off.clone().multiply(m ?? new THREE.Matrix4())])));
        parts.forEach(([g]) => g.dispose());
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = cast && this.o.quality === 'high';
        mesh.receiveShadow = true;
        mesh.name = 'nearDetail';
        holder.add(mesh);
      };
      layer(c.solid, this.solidMat, true);
      layer(c.gloss, this.glossMat, true);
      layer(c.steel, this.steelMat, true);
      layer(c.glow, this.glowMat, false);
      lod.addLevel(holder, 0);
      lod.addLevel(new THREE.Object3D(), this.nearDist);
      this.group.add(lod);
    }
    this.nearCells.clear();
    if (this.people.length) {
      const mat = crowdMaterial(this.bag, this.time, { hop: 0.32, speed: 7 });
      const variants = this.o.quality === 'low' ? 1 : 3;
      const q = this.o.quality;
      const groups: Batch[] = [];
      for (let v = 0; v < variants; v++) {
        const near = this.bag.add(q === 'low' ? personSimple(v) : personDetailed(v * 2 + 1, q));
        const far = q === 'low' ? null : this.bag.add(personSimple(v * 2 + 1));
        groups.push(new Batch(near, mat, { cast: false, receive: false, name: 'people', lod: far ? { far, dist: q === 'high' ? 75 : 45, cull: q === 'high' ? 420 : 260, cell: 90 } : undefined }));
      }
      this.people.forEach((p, i) => groups[i % variants].addMatrix(p.m, p.c));
      groups.forEach((g) => g.build(this.group));
      this.people = [];
    }
  }
}

/* ================================================================== building dressing */

/** Wooden rooftop water tank on stilts as parts (base at y = 0). */
export function tankParts(parts: P, m: THREE.Matrix4, snow = false, seg = 12): void {
  for (const [lx, lz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) parts.push([new THREE.BoxGeometry(0.25, 3, 0.25), '#3b3b3b', L(m, M.t(lx, 1.5, lz))]);
  beam(parts, [-1.3, 0.3, -1.3], [1.3, 2.7, 1.3], 0.08, '#3b3b3b', m);
  beam(parts, [1.3, 0.3, -1.3], [-1.3, 2.7, 1.3], 0.08, '#3b3b3b', m);
  parts.push([new THREE.CylinderGeometry(2, 2, 0.3, seg), '#3b3b3b', L(m, M.t(0, 3, 0))]);
  parts.push([new THREE.CylinderGeometry(1.9, 2.0, 3.6, seg), '#8a5a36', L(m, M.t(0, 4.95, 0))]);
  for (const hy of [3.8, 5.0, 6.2]) parts.push([new THREE.CylinderGeometry(2.04, 2.04, 0.12, seg), '#2f2f2f', L(m, M.t(0, hy, 0))]);
  parts.push([new THREE.ConeGeometry(2.1, 1.4, seg), snow ? '#f4f8ff' : '#5a3a26', L(m, M.t(0, 7.45, 0))]);
  parts.push([new THREE.BoxGeometry(0.1, 4, 0.1), '#555', L(m, M.trs(2.0, 5, 0, 0, 0, 0))]);
}

/** Rooftop HVAC unit (box with a fan grille and ducts) as parts, base at y = 0. */
export function hvacParts(parts: P, m: THREE.Matrix4, w = 2.6, d = 1.8): void {
  parts.push([bevelBox(w, 1.2, d, 0.08), '#b9bec5', L(m, M.t(0, 0.6, 0))]);
  parts.push([new THREE.CylinderGeometry(0.55, 0.55, 0.12, 12), '#5d636b', L(m, M.t(-w * 0.2, 1.24, 0))]);
  parts.push([new THREE.BoxGeometry(1.1, 0.04, 0.08), '#33373c', L(m, M.trs(-w * 0.2, 1.31, 0, 0, 0.7, 0))]);
  parts.push([new THREE.BoxGeometry(0.4, 0.5, d * 0.6), '#9aa0a8', L(m, M.t(w * 0.3, 1.4, 0))]);
  parts.push([new THREE.CylinderGeometry(0.18, 0.18, 1.2, 8).rotateZ(Math.PI / 2), '#a8adb4', L(m, M.t(w / 2 + 0.5, 0.5, 0))]);
}

/**
 * Architectural dressing for a box building (w x h x d, base at y = 0, local frame m): a bevelled
 * cornice with dentils, string-course ledges, a base plinth and rooftop clutter (HVAC, water tank,
 * antenna). Silhouette pieces go into the always-on solid layer; small parts into the near layer.
 */
export function dressBlock(k: Kit, m: THREE.Matrix4, w: number, h: number, d: number, o: { cornice?: string; ledge?: number; plinth?: string; roof?: 'tank' | 'hvac' | 'antenna' | 'mixed' | 'none'; seed?: number; dentils?: boolean } = {}): void {
  const rng = new Rng(o.seed ?? Math.round(w * 13 + h * 7 + d));
  const cc = o.cornice ?? '#d9d2c3';
  k.solid.push([k.fine ? bevelBox(w + 1.0, 1.0, d + 1.0, 0.3) : new THREE.BoxGeometry(w + 1.0, 1.0, d + 1.0), cc, L(m, M.t(0, h + 0.1, 0))]);
  k.solid.push([new THREE.BoxGeometry(w + 0.5, 0.4, d + 0.5), cc, L(m, M.t(0, h - 0.55, 0))]);
  if (k.o.snow) k.solid.push([new THREE.BoxGeometry(w + 0.6, 0.35, d + 0.6), '#f4f8ff', L(m, M.t(0, h + 0.75, 0))]);
  if (o.ledge && k.fine) for (let y = o.ledge; y < h - 3; y += o.ledge) k.solid.push([bevelBox(w + 0.36, 0.32, d + 0.36, 0.1), cc, L(m, M.t(0, y, 0))]);
  if (o.plinth) k.solid.push([k.fine ? bevelBox(w + 0.5, 1.6, d + 0.5, 0.15) : new THREE.BoxGeometry(w + 0.5, 1.6, d + 0.5), o.plinth, L(m, M.t(0, 0.8, 0))]);
  if (k.fine && (o.dentils ?? w + d < 90)) {
    const step = 1.1;
    for (const [fx, fz, len, ry] of [[0, d / 2 + 0.28, w, 0], [0, -d / 2 - 0.28, w, 0], [w / 2 + 0.28, 0, d, Math.PI / 2], [-w / 2 - 0.28, 0, d, Math.PI / 2]] as const) {
      for (let t = -len / 2 + 0.5; t < len / 2 - 0.3; t += step) {
        const lx = ry ? fx : t, lz = ry ? t : fz;
        k.near('solid', new THREE.BoxGeometry(ry ? 0.45 : 0.4, 0.4, ry ? 0.4 : 0.45), cc, L(m, M.t(lx, h - 0.15, lz)));
      }
    }
  }
  const roof = o.roof ?? 'mixed';
  if (roof === 'none' || !k.fine) return;
  const parts: P = [];
  const at = (fx: number, fz: number) => L(m, M.trs(fx * w * 0.3, h + 0.6, fz * d * 0.3, 0, rng.next() * 3, 0));
  if (roof === 'tank' || (roof === 'mixed' && rng.chance(0.45))) tankParts(parts, at(rng.range(-1, 1), rng.range(-1, 1)), k.o.snow, k.q === 'high' ? 12 : 8);
  if (roof === 'hvac' || roof === 'mixed') for (let i = 0; i < (w * d > 400 ? 3 : 1); i++) hvacParts(parts, at(rng.range(-1, 1), rng.range(-1, 1)));
  if (roof === 'antenna' || (roof === 'mixed' && rng.chance(0.4))) {
    const am = at(rng.range(-1, 1), rng.range(-1, 1));
    parts.push([new THREE.CylinderGeometry(0.06, 0.1, 6, 5), '#c9cdd2', L(am, M.t(0, 3, 0))]);
    for (const y of [2, 3.5, 5]) parts.push([new THREE.BoxGeometry(1.2, 0.05, 0.05), '#c9cdd2', L(am, M.t(0, y, 0))]);
    parts.push([new THREE.SphereGeometry(0.6, 8, 4, 0, Math.PI * 2, 0, 1.0), '#e9ecef', L(am, M.trs(0.6, 1.2, 0, 0, 0, -1.1))]);
  }
  k.nearParts('solid', parts);
}

/**
 * Inset window: recessed glass behind a frame with mullions, a projecting sill and a lintel /
 * keystone (faces +Z at depth z). `fine` = full detail, else a cheap framed slab.
 */
export function winFine(parts: P, x: number, y: number, z: number, w = 1.3, h = 1.7, glass = '#2e4a6b', frame = '#f4f1e8', xf?: THREE.Matrix4, o: { mullion?: boolean; lintel?: string; keystone?: boolean } = {}): void {
  const t = (mm: THREE.Matrix4) => (xf ? xf.clone().multiply(mm) : mm);
  const fw = 0.12;
  parts.push([new THREE.BoxGeometry(w, h, 0.06), glass, t(M.t(x, y, z - 0.08))]);
  parts.push([new THREE.BoxGeometry(w + fw * 2, fw, 0.16), frame, t(M.t(x, y + h / 2 + fw / 2, z))]);
  parts.push([new THREE.BoxGeometry(fw, h, 0.16), frame, t(M.t(x - w / 2 - fw / 2, y, z))]);
  parts.push([new THREE.BoxGeometry(fw, h, 0.16), frame, t(M.t(x + w / 2 + fw / 2, y, z))]);
  if (o.mullion !== false) {
    parts.push([new THREE.BoxGeometry(0.06, h, 0.08), frame, t(M.t(x, y, z - 0.04))]);
    parts.push([new THREE.BoxGeometry(w, 0.06, 0.08), frame, t(M.t(x, y + h * 0.18, z - 0.04))]);
  }
  parts.push([bevelBox(w + 0.5, 0.14, 0.34, 0.05), o.lintel ?? frame, t(M.t(x, y - h / 2 - 0.1, z + 0.08))]);
  if (o.lintel) parts.push([bevelBox(w + 0.44, 0.3, 0.2, 0.06), o.lintel, t(M.t(x, y + h / 2 + 0.28, z + 0.02))]);
  if (o.keystone) parts.push([bevelBox(0.3, 0.42, 0.26, 0.05), o.lintel ?? frame, t(M.t(x, y + h / 2 + 0.3, z + 0.06))]);
}

/** Black steel fire escape (landings, railings, ladders) on a wall facing +Z at local z. */
export function fireEscapeParts(parts: P, xf: THREE.Matrix4, x: number, z: number, floors: number[], w = 3.2): void {
  const c = '#22262b';
  const t = (mm: THREE.Matrix4) => xf.clone().multiply(mm);
  for (const [i, y] of floors.entries()) {
    parts.push([new THREE.BoxGeometry(w, 0.08, 1.2), c, t(M.t(x, y, z + 0.6))]);
    parts.push([new THREE.BoxGeometry(w, 0.05, 0.05), c, t(M.t(x, y + 1.0, z + 1.18))]);
    parts.push([new THREE.BoxGeometry(w, 0.04, 0.04), c, t(M.t(x, y + 0.5, z + 1.18))]);
    for (const sx of [-1, 1]) parts.push([new THREE.BoxGeometry(0.05, 1.0, 1.2), c, t(M.t(x + sx * w / 2, y + 0.5, z + 0.6))]);
    for (let k = 0; k <= 6; k++) parts.push([new THREE.BoxGeometry(0.03, 1.0, 0.03), c, t(M.t(x - w / 2 + (k / 6) * w, y + 0.5, z + 1.18))]);
    parts.push([new THREE.BoxGeometry(0.08, 0.25, 1.1), c, t(M.trs(x - w / 2 + 0.2, y - 0.2, z + 0.6, 0, 0, 0.6))]);
    // stair to the landing below
    if (i > 0) {
      const y0 = floors[i - 1];
      beam(parts, [x - w / 2 + 0.4, y0 + 0.05, z + 0.85], [x + w / 2 - 0.4, y - 0.05, z + 0.85], 0.06, c, xf, 0.5);
      beam(parts, [x - w / 2 + 0.4, y0 + 0.9, z + 1.1], [x + w / 2 - 0.4, y + 0.8, z + 1.1], 0.04, c, xf);
    } else {
      // drop ladder
      for (const lx of [-0.25, 0.25]) parts.push([new THREE.BoxGeometry(0.04, 2.2, 0.04), c, t(M.t(x + w / 2 - 0.6 + lx, y - 1.1, z + 1.0))]);
      for (let r = 0; r < 6; r++) parts.push([new THREE.BoxGeometry(0.5, 0.03, 0.03), c, t(M.t(x + w / 2 - 0.6, y - 0.2 - r * 0.35, z + 1.0))]);
    }
    for (const sx of [-1, 1]) beam(parts, [x + sx * w * 0.4, y - 0.05, z + 1.1], [x + sx * w * 0.4, y - 0.9, z + 0.05], 0.05, c, xf);
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
  // dark-glass lobby podium + rooftop mechanical penthouses on the tallest tubes
  k.solid.push([k.fine ? bevelBox(3 * u + 3, 8, 3 * u + 3, 0.6) : new THREE.BoxGeometry(3 * u + 3, 8, 3 * u + 3), '#1a1d22', L(b, M.t(0, 4, 0))]);
  if (k.fine) {
    for (const [i, j] of [[0, 0], [0, 1]]) {
      k.solid.push([bevelBox(u - 3, 4, u - 3, 0.3), '#2a2d33', L(b, M.t(i * u, 270 + 2, j * u))]);
      const rp: P = [];
      hvacParts(rp, L(b, M.t(i * u - 2, 274, j * u + 2)), 3, 2.2);
      k.nearParts('solid', rp);
    }
    // vertical mullion fins catch the light on the black tubes
    for (const [i, j, h] of tubes) for (const [fx, fz, ry] of [[-u / 2 - 0.12, 0, Math.PI / 2], [u / 2 + 0.12, 0, Math.PI / 2], [0, -u / 2 - 0.12, 0], [0, u / 2 + 0.12, 0]] as const) {
      for (let t = -u / 2 + u / 6; t < u / 2 - 0.1; t += u / 3) {
        const lx = ry ? fx : t, lz = ry ? t : fz;
        k.solid.push([new THREE.BoxGeometry(ry ? 0.25 : 0.3, h - 10, ry ? 0.3 : 0.25), '#0e1013', L(b, M.t(i * u + lx, 8 + (h - 10) / 2, j * u + lz))]);
      }
    }
  }
  for (const [ax, az, ah] of [[-3, -3, 74], [3, u + 3, 64]]) {
    if (k.fine) for (let y = 12; y < ah - 6; y += 12) k.near('gloss', new THREE.BoxGeometry(2.6, 0.25, 0.25), '#dddddd', L(b, M.t(ax, 270 + y, az)));
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
  const st = '#e8dcc2', st2 = '#d8cbb0', dk = '#3a4458';
  const seg = k.q === 'high' ? 16 : 8;
  k.facade('stone', boxUV(24, 92, 20), b);
  k.facade('stone', boxUV(18, 12, 15, 0, 92, 0), b);
  // vertical piers running up the shaft (gothic verticality)
  if (k.fine) for (const [fx, fz, len, ry] of [[0, 10.15, 24, 0], [0, -10.15, 24, 0], [12.15, 0, 20, 1], [-12.15, 0, 20, 1]] as const) {
    for (let t = -len / 2 + 2; t <= len / 2 - 2; t += 4) {
      const lx = ry ? fx : t, lz = ry ? t : fz;
      k.solid.push([new THREE.BoxGeometry(ry ? 0.45 : 0.55, 90, ry ? 0.55 : 0.45), st, L(b, M.t(lx, 46, lz))]);
    }
  }
  dressBlock(k, b, 24, 92, 20, { cornice: st2, roof: 'none', dentils: true });
  // crown: octagonal lantern drum with tracery, flying buttresses ending in pinnacles
  k.solid.push([lathe([[8.6, 0], [8.2, 1], [7.6, 1.4], [7.6, 15], [8.3, 15.6], [8.3, 16.4], [6.8, 17]], 8), st, L(b, M.trs(0, 104, 0, 0, Math.PI / 8, 0))]);
  k.solid.push([new THREE.CylinderGeometry(5, 7, 7, 8), st2, L(b, M.t(0, 123.5, 0))]);
  k.solid.push([new THREE.ConeGeometry(4.5, 6, 8), '#cfc2a6', L(b, M.t(0, 130, 0))]);
  k.solid.push([new THREE.ConeGeometry(0.6, 4, 6), '#cfc2a6', L(b, M.t(0, 134.5, 0))]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const cx = Math.cos(a), cz = Math.sin(a);
    beam(k.solid, [cx * 12.5, 102, cz * 10.5], [cx * 8.2, 117, cz * 8.2], 0.9, st, b);
    if (k.fine) beam(k.solid, [cx * 11.8, 104, cz * 10], [cx * 8.2, 112, cz * 8.2], 0.5, st2, b);
    k.solid.push([new THREE.ConeGeometry(0.9, 5, 4), st, L(b, M.t(cx * 8.4, 122, cz * 8.4))]);
    // pinnacles on the buttress feet and on the crown ring
    k.solid.push([new THREE.CylinderGeometry(0.7, 0.8, 3, 4), st, L(b, M.t(cx * 12.3, 103.5, cz * 10.3))]);
    k.solid.push([new THREE.ConeGeometry(0.75, 4.2, 4), st, L(b, M.t(cx * 12.3, 107, cz * 10.3))]);
    // tall lancet windows between the drum piers
    const a2 = a + Math.PI / 8;
    k.solid.push([new THREE.BoxGeometry(1.6, 10, 0.3), dk, L(b, M.trs(Math.cos(a2) * 7.5, 111, Math.sin(a2) * 7.5, 0, -a2 + Math.PI / 2, 0))]);
    if (k.fine) {
      k.solid.push([new THREE.ConeGeometry(0.8, 1.6, 4).rotateY(Math.PI / 4), dk, L(b, M.trs(Math.cos(a2) * 7.5, 116.8, Math.sin(a2) * 7.5, 0, -a2 + Math.PI / 2, 0, 1, 1, 0.2))]);
      k.near('solid', new THREE.BoxGeometry(0.12, 10, 0.4), st, L(b, M.trs(Math.cos(a2) * 7.62, 111, Math.sin(a2) * 7.62, 0, -a2 + Math.PI / 2, 0)));
      k.solid.push([new THREE.ConeGeometry(0.5, 3.2, 4), st, L(b, M.t(cx * 7.3, 126, cz * 7.3))]);
    }
  }
  if (k.fine) for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    k.near('solid', new THREE.BoxGeometry(0.6, 0.9, 0.5), st2, L(b, M.trs(Math.cos(a) * 8.4, 120.6, Math.sin(a) * 8.4, 0, -a, 0)));
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
  dressBlock(k, b, 34, 54, 22, { cornice: '#f1ebdf', roof: 'none', ledge: 18, plinth: '#e6dfcf' });
  dressBlock(k, L(b, M.t(34, 0, 2)), 24, 34, 18, { cornice: '#f1ebdf', roof: 'hvac', plinth: '#e6dfcf' });
  if (k.fine) {
    // colonnade ring around the clock tower's upper tiers + corner finials + balustrade
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      k.solid.push([new THREE.CylinderGeometry(0.35, 0.4, 8, 8), w, L(b, M.t(Math.cos(a) * 5.6, 84.5, Math.sin(a) * 5.6))]);
    }
    k.solid.push([lathe([[6.6, 0], [6.6, 0.5], [6.1, 0.8], [6.1, 1.2], [6.5, 1.5]], 16), '#efe6d2', L(b, M.t(0, 79.6, 0))]);
    k.solid.push([lathe([[6.3, 0], [6.3, 0.6], [5.0, 1.2]], 16), '#efe6d2', L(b, M.t(0, 88.8, 0))]);
    for (const [cx, cz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
      k.solid.push([new THREE.CylinderGeometry(0.5, 0.6, 3, 8), w, L(b, M.t(cx, 71.5, cz))]);
      k.solid.push([new THREE.ConeGeometry(0.6, 2, 8), '#efe6d2', L(b, M.t(cx, 74, cz))]);
      k.solid.push([new THREE.SphereGeometry(0.5, 8, 6), w, L(b, M.t(cx * 0.86, 81, cz * 0.86))]);
    }
    for (let i = -6; i <= 6; i += 1.2) for (const [fx, fz, ry] of [[i, 7.2, 0], [i, -7.2, 0], [7.2, i, 1], [-7.2, i, 1]] as const) {
      k.near('solid', new THREE.CylinderGeometry(0.12, 0.16, 0.9, 6), w, L(b, M.t(fx, 70.5, fz)));
      void ry;
    }
  }
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
  if (k.fine) {
    // battlements on the turrets, arched lancets on the shaft, buttress ribs
    for (const [cx, cz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.solid.push([bevelBox(0.6, 0.8, 0.6, 0.12), st, L(b, M.t(cx + Math.cos(a) * 1.75, 15.3, cz + Math.sin(a) * 1.75))]);
    }
    for (const [r, h, y0] of tiers) for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      k.solid.push([new THREE.BoxGeometry(0.45, h * 0.95, 0.5), '#e2cf98', L(b, M.trs(Math.cos(a) * r * 0.98, y0 + h / 2, Math.sin(a) * r * 0.98, 0, -a, 0))]);
      const a2 = a - Math.PI / 8;
      k.near('solid', new THREE.ConeGeometry(0.45, 0.9, 4).rotateY(Math.PI / 4), dk, L(b, M.trs(Math.cos(a2) * r * 0.99, y0 + h * 0.79, Math.sin(a2) * r * 0.99, 0, -a2 + Math.PI / 2, 0, 1, 1, 0.3)));
    }
    for (const [sx, sz, ry] of [[0, 8.1, 0], [0, -8.1, 0], [8.1, 0, Math.PI / 2], [-8.1, 0, Math.PI / 2]] as const) {
      k.solid.push([new THREE.ConeGeometry(1.7, 1.6, 4).rotateY(Math.PI / 4), st, L(b, M.trs(sx, 7.6, sz, 0, ry, 0, 1, 1, 0.3))]);
      for (const wx of [-4.5, 4.5]) {
        k.near('solid', new THREE.BoxGeometry(1.1, 2.6, 0.2), dk, L(b, M.trs(sx + (ry ? 0 : wx), 6.2, sz + (ry ? wx : 0), 0, ry, 0)));
        k.near('solid', new THREE.ConeGeometry(0.6, 0.8, 4).rotateY(Math.PI / 4), dk, L(b, M.trs(sx + (ry ? 0 : wx), 7.8, sz + (ry ? wx : 0), 0, ry, 0, 1, 1, 0.2)));
      }
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
  const g = k.q === 'high' ? new THREE.SphereGeometry(1, 128, 64) : k.q === 'medium' ? new THREE.SphereGeometry(1, 80, 40) : new THREE.SphereGeometry(1, 48, 24);
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
  if (k.fine) {
    dressBlock(k, L(b, M.t(0, 0, -6)), 64, 15, 30, { cornice: '#e3dbc8', roof: 'hvac', plinth: '#d6cdb9', dentils: true });
    // fluted column capitals / bases
    for (let i = 0; i < 6; i++) {
      k.solid.push([bevelBox(2.1, 0.5, 2.1, 0.12), st, L(b, M.t(-10 + i * 4, 14.2, 11.5))]);
      k.solid.push([bevelBox(2.1, 0.5, 2.1, 0.12), st, L(b, M.t(-10 + i * 4, 3.75, 11.5))]);
    }
  }
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
  if (k.fine) dressBlock(k, L(b, M.t(0, 0, -9)), 36, 24, 18, { cornice: '#d8c9a8', roof: 'mixed', ledge: 8, plinth: '#8a6a50' });
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
  if (k.fine) awningParts(k.solid, 7.2, 1.6, '#c8102e', '#ffffff', L(b, M.t(0, 3.55, 2.3)), k.q);
  else for (let i = 0; i < 7; i++) k.solid.push([new THREE.BoxGeometry(1.0, 0.12, 1.6), i % 2 ? '#ffffff' : '#c8102e', L(b, M.trs(-3 + i, 3.15, 3.0, 0.4, 0, 0))]);
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
  if (k.fine) {
    awningParts(k.solid, 11.2, 1.5, '#1f8f3a', '#ffffff', L(b, M.t(0, 4.05, 0.05)), k.q);
    dressBlock(k, L(b, M.t(0, 0, -4)), 11, 6.5, 8, { cornice: '#e9dcc4', roof: 'hvac', plinth: '#7d6a58' });
    for (const wx of [-4.3, 4.3]) winFine(k.solid, wx, 1.9, 0.05, 1.3, 2.2, '#2b4566', '#3b2b20', b, { lintel: '#e9dcc4' });
  } else for (let i = 0; i < 9; i++) k.solid.push([new THREE.BoxGeometry(1.25, 0.12, 1.6), ['#1f8f3a', '#ffffff', '#c8102e'][i % 3], L(b, M.trs(-5 + i * 1.25, 3.6, 0.7, 0.45, 0, 0))]);
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
      if (x + step <= len) {
        beam(s, [x, deckY - 1.4, side], [x + step, deckY + 0.4, side], 0.18, steel, base);
        // second diagonal -> riveted X lattice
        if (k.q === 'high') beam(s, [x, deckY + 0.4, side], [x + step, deckY - 1.4, side], 0.14, steel, base);
      }
      if (k.fine) {
        // gusset plates at the lattice joints + rivet heads along the chords
        const out = Math.sign(side) * 0.22;
        k.near('solid', new THREE.BoxGeometry(0.9, 0.7, 0.05), steelD, P2(x, deckY + 0.3, side + out));
        k.near('solid', new THREE.BoxGeometry(0.9, 0.7, 0.05), steelD, P2(x, deckY - 1.3, side + out));
        if (k.q === 'high') for (const ry of [deckY + 0.62, deckY + 0.38, deckY - 1.38, deckY - 1.62]) for (let r = -1; r <= 1; r++) {
          k.near('solid', new THREE.CylinderGeometry(0.05, 0.05, 0.06, 5).rotateX(Math.PI / 2), steelD, P2(x + r * 0.6 + step / 2, ry, side + out * 1.1));
        }
      }
    }
  }
  // cross girders under the deck
  if (k.fine) for (let x = 1.5; x < len; x += 6) k.near('solid', new THREE.BoxGeometry(0.3, 0.6, 7.2), steelD, P2(x, deckY - 0.45, 0));
  // columns where the ground is clear
  for (let x = 6; x < len - 3; x += 16) {
    const p0 = toWorld(x, -3.3), p1 = toWorld(x, 3.3), pm = toWorld(x, 0);
    if (field.clearance(p0.x, p0.z) < 1.2 || field.clearance(p1.x, p1.z) < 1.2 || field.clearance(pm.x, pm.z) < 0.5) continue;
    const gy = Math.min(field.height(p0.x, p0.z), field.height(p1.x, p1.z));
    const h = deckY - 1.5 - gy;
    for (const cz of [-3.3, 3.3]) {
      s.push([new THREE.BoxGeometry(0.8, h, 0.8), steel, L(base, M.t(x, gy + h / 2, cz))]);
      s.push([k.fine ? bevelBox(1.4, 0.6, 1.4, 0.15) : new THREE.BoxGeometry(1.3, 0.4, 1.3), steelD, L(base, M.t(x, gy + 0.3, cz))]);
      if (k.fine) {
        // flared foot, flange edges and a capital plate
        s.push([new THREE.CylinderGeometry(0.45, 0.85, 1.4, 4).rotateY(Math.PI / 4), steel, L(base, M.t(x, gy + 1.3, cz))]);
        for (const fz of [-0.42, 0.42]) s.push([new THREE.BoxGeometry(0.95, h - 2, 0.08), steelD, L(base, M.t(x, gy + h / 2 + 0.5, cz + fz))]);
        s.push([bevelBox(1.5, 0.3, 1.5, 0.08), steelD, L(base, M.t(x, deckY - 1.65, cz))]);
        if (k.q === 'high') for (let ry = gy + 2.5; ry < deckY - 2; ry += 1.2) for (const fz of [-0.47, 0.47]) k.near('solid', new THREE.CylinderGeometry(0.05, 0.05, 0.06, 5).rotateX(Math.PI / 2), steelD, L(base, M.t(x + 0.3, ry, cz + fz)));
      }
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

/* ================================================================== street life & nature near the road */

const cullHint = <T extends THREE.BufferGeometry>(g: T, cull: number, cell = 100): T => {
  g.userData.lod = { cull, cell };
  return g;
};

export interface StreetLifeOpts {
  paths?: number[];
  /** multiplies every spacing (bigger = sparser) */
  sparse?: number;
  benches?: boolean;
  trash?: boolean;
  hydrants?: boolean;
  news?: boolean;
  shelters?: boolean;
  bikes?: boolean;
  beds?: boolean;
  lamps?: boolean;
  snow?: boolean;
  ads?: Array<[string, string]>;
}

/**
 * Street furniture along the course (outside the walls, via the placer so nothing overlaps):
 * benches, trash cans, hydrants, newspaper boxes, CTA shelters with ads, Divvy docks, acorn lamps
 * and raised flower beds. Instanced, distance-culled; nothing on 'low'.
 */
export function streetLife(k: Kit, placer: Placer, o: StreetLifeOpts = {}): void {
  if (!k.fine) return;
  const q = k.q, hi = q === 'high';
  const sp = (o.sparse ?? 1) * (hi ? 1 : 1.6);
  const near = hi ? 170 : 110, mid = hi ? 260 : 170;
  const paths = o.paths ?? [0];
  const rng = new Rng(4711);
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, spacing: number, offset: number, r: number, cull: number, name: string, yawOff = 0, color?: () => string) => {
    const bt = k.batch(cullHint(geo, cull), mat, { cast: hi, name });
    for (const pid of paths) for (const s of placer.along(pid, spacing * sp, offset, r, { jitter: 0.6 })) bt.add(s.x, s.y, s.z, s.yaw + yawOff, 1, 1, 1, color?.());
  };
  if (o.lamps) put(acornLamp('#20262e', '#fff3c4', q), k.solidMat, 46, 1.6, 0.6, mid, 'acornLamps');
  if (o.benches !== false && !o.snow) put(parkBench(), k.solidMat, 70, 3.2, 1.4, near, 'benches', Math.PI);
  if (o.trash !== false) put(trashCan(o.snow ? '#2a3a2f' : rng.pick(['#2a3a2f', '#1f3a5c'])), k.solidMat, 64, 2.2, 0.6, near, 'trashCans');
  if (o.hydrants !== false) put(hydrant(), k.glossMat, 95, 1.7, 0.5, near, 'hydrants');
  if (o.news !== false) put(newsBoxes(), k.solidMat, 140, 2.8, 1.2, near, 'newsBoxes', Math.PI);
  if (o.shelters !== false) {
    const ads = o.ads ?? [['#ff5f6d', '#ffd23f'], ['#2f7de1', '#ffffff'], ['#3ccf6e', '#ffe14d'], ['#b05cf0', '#ffd23f']];
    ads.forEach(([bg, fg], i) => {
      const bt = k.batch(cullHint(ctaShelter(bg, fg), mid), k.glossMat, { cast: hi, name: 'ctaShelters' });
      for (const pid of paths) placer.along(pid, 230 * sp, 3.6, 3.2, { jitter: 1 }).forEach((s, j) => {
        if (j % ads.length === i) bt.add(s.x, s.y, s.z, s.yaw + Math.PI);
      });
    });
  }
  if (o.bikes !== false && !o.snow) put(divvyDock(hi ? 6 : 4, q), k.solidMat, 260, 4.0, 4.4, near, 'divvyDocks', Math.PI);
  if (o.beds !== false && !o.snow) put(flowerBed(q, 2.0), k.tintMat, 90, 5.2, 2.4, near, 'flowerBeds', 0, () => rng.pick(['#ff5fa2', '#ffd23f', '#ff7a3d', '#b48cff', '#ffffff', '#ff4d4d']));
}

/** Racing dressing: tyre stacks behind the barriers on the outside of the fastest corners. */
export function tireWalls(k: Kit, placer: Placer, every = 2.2): void {
  if (!k.fine) return;
  const tr = placer.track;
  const p = tr.paths[0];
  const n = p.samples.length;
  const bt = k.batch(cullHint(tireStack(k.q), k.q === 'high' ? 220 : 140), k.tintMat, { cast: k.q === 'high', name: 'tireStacks' });
  const cols = ['#e3262b', '#ffffff', '#e3262b', '#2f6fd6'];
  let c = 0;
  for (let i = 0; i < n; i++) {
    let cv = 0;
    for (let d = -5; d <= 5; d++) cv += p.samples[(i + d + n) % n].curvature;
    cv /= 11;
    if (Math.abs(cv) < 0.018 || p.samples[i].gap) continue;
    const side = -Math.sign(cv);
    const smp = p.samples[i];
    for (let row = 0; row < 2; row++) {
      const lat = side * (smp.halfWidth + tr.def.shoulder + 1.75 + row * 0.95);
      const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
      if (placer.field.clearance(x, z, 64) < 1.0 || !placer.free(x, z, 0.5) || placer.field.insideOther(x, z, -1, -1)) continue;
      placer.reserve(x, z, 0.5);
      bt.add(x, placer.field.height(x, z), z, i * 0.7, 1, 1, 1, cols[c++ % cols.length]);
    }
    i += Math.max(0, Math.round(every / Math.max(0.5, (p.samples[1]?.s ?? 1) - p.samples[0].s)) - 1);
  }
}

/**
 * Instanced grass tufts (and optional wildflowers) in a band just outside the barriers, distance
 * culled (they only exist near the camera). Uses free ground only (placer / terrain / not water).
 */
export function edgeGrass(k: Kit, placer: Placer, o: { base: string; tip: string; flowers?: string[]; spacing?: number; band?: [number, number]; paths?: number[]; minY?: number; h?: number }): void {
  if (!k.fine) return;
  const q = k.q, hi = q === 'high';
  const tr = placer.track, field = placer.field;
  const rng = new Rng(9091);
  const cull = hi ? 95 : 60;
  const tufts = [0, 1].map((v) => k.batch(cullHint(grassTuft(o.base, o.tip, q, { seed: 11 + v * 17, h: (o.h ?? 0.7) * (v ? 1.3 : 1), blades: hi ? 9 : 6, spread: 0.22 }), cull, 60), k.solidMat, { cast: false, name: 'grassTufts' }));
  let flowers: Batch | null = null;
  if (o.flowers?.length) {
    const fg = grassTuft(o.base, o.tip, q, { seed: 5, blades: 4, h: 0.4 });
    const heads = mergeColored([0, 1, 2].map((i): [THREE.BufferGeometry, string, THREE.Matrix4] => [new THREE.IcosahedronGeometry(0.07, 0), '#ffffff', M.t(Math.cos(i * 2.1) * 0.12, 0.42 + i * 0.05, Math.sin(i * 2.1) * 0.12)]));
    const merged = mergeGeometries([fg, heads.index ? heads.toNonIndexed() : heads].map((g) => {
      if (!g.attributes.color) throw new Error('no color');
      return g;
    }), false)!;
    merged.userData.sway = fg.userData.sway;
    merged.userData.tintMask = true;
    fg.dispose();
    heads.dispose();
    flowers = k.batch(cullHint(merged, cull, 60), k.solidMat, { cast: false, name: 'wildflowers' });
  }
  const spacing = (o.spacing ?? 1.2) * (hi ? 1 : 1.7);
  const [b0, b1] = o.band ?? [0.7, 5];
  for (const pid of o.paths ?? tr.paths.map((p) => p.id)) {
    const p = tr.paths[pid];
    for (let s = 0; s < p.length; s += spacing * rng.range(0.6, 1.4)) {
      const smp = tr.sampleAt(pid, s);
      if (smp.gap) continue;
      for (const side of [-1, 1]) {
        // a few tufts hug the foot of the barrier on the shoulder, the rest grow in a band behind it
        const inner = tr.def.shoulder > 1.2 && rng.chance(0.35);
        const lat = inner ? side * (smp.halfWidth + tr.def.shoulder - rng.range(0.05, 0.6)) : side * (smp.halfWidth + tr.def.shoulder + rng.range(b0, b1));
        const jx = inner ? 0 : rng.range(-0.4, 0.4), jz = inner ? 0 : rng.range(-0.4, 0.4);
        const x = smp.x + smp.nx * lat + jx, z = smp.z + smp.nz * lat + jz;
        if ((!inner && field.clearance(x, z, 16) < 0.45) || field.insideOther(x, z, -1, -1)) continue;
        const y = field.height(x, z);
        if (y < (o.minY ?? -0.3) || !placer.free(x, z, 0.15)) continue;
        const sc = rng.range(0.8, 1.6) * (inner ? 0.8 : 1);
        if (flowers && rng.chance(0.16)) flowers.add(x, y, z, rng.next() * 6, sc, sc, sc, rng.pick(o.flowers!));
        else tufts[rng.int(2)].add(x, y - 0.02, z, rng.next() * 6, sc, sc * rng.range(0.8, 1.2), sc);
      }
    }
  }
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
      // exhibition halls (windowed facades on medium / high)
      ...(k.fine ? [] : [
        [new THREE.BoxGeometry(150, 9, 16), '#e9dcc4', M.t(px0 + 140, 5.7, pz + 12)],
        [new THREE.BoxGeometry(40, 16, 30), '#d9c19b', M.t(px1 - 22, 9.2, pz)],
        [new THREE.BoxGeometry(14, 22, 14), '#c9a77c', M.t(px0 + 18, 12.2, pz + 10)],
      ] as Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>),
      [new THREE.BoxGeometry(152, 1.2, 18), '#2f6f6a', M.t(px0 + 140, 10.8, pz + 12)],
      [new THREE.CylinderGeometry(9, 12, 6, 8), '#2f6f6a', M.t(px1 - 22, 20, pz)],
      [new THREE.ConeGeometry(10.5, 6, 4).rotateY(Math.PI / 4), '#2f6f6a', M.t(px0 + 18, 26.2, pz + 10)],
    ];
    // railing posts along the pier edge
    for (let x = px0 + 4; x < px1; x += 8) {
      parts.push([new THREE.BoxGeometry(0.3, 1.1, 0.3), '#3c3c3c', M.t(x, 1.75, pz - 21.5)]);
    }
    parts.push([new THREE.BoxGeometry(px1 - px0, 0.2, 0.2), '#3c3c3c', M.t((px0 + px1) / 2, 2.2, pz - 21.5)]);
    if (k.fine) {
      k.facade('cream', boxUV(150, 9, 16, px0 + 140, 1.2, pz + 12));
      k.facade('tan', boxUV(40, 16, 30, px1 - 22, 1.2, pz));
      k.facade('brick', boxUV(14, 22, 14, px0 + 18, 1.2, pz + 10));
      dressBlock(k, M.t(px0 + 18, 1.2, pz + 10), 14, 22, 14, { cornice: '#e6d8bd', roof: 'none' });
      dressBlock(k, M.t(px1 - 22, 1.2, pz), 40, 16, 30, { cornice: '#e6d8bd', roof: 'none', plinth: '#b8a888' });
      // arched glass end hall + promenade lamps and benches along the pier
      for (let x = px0 + 30; x < px1 - 50; x += 14) {
        const lp: P = [];
        lp.push([lathe([[0.25, 0], [0.18, 0.4], [0.08, 0.6], [0.07, 3.8], [0.14, 4.0]], 8), '#20262e', M.t(x, 1.2, pz - 19.5)]);
        lp.push([new THREE.SphereGeometry(0.3, 8, 6), '#fff3c4', M.trs(x, 5.5, pz - 19.5, 0, 0, 0, 1, 1.3, 1)]);
        lp.push([bevelBox(1.8, 0.1, 0.5, 0.03), '#a8713f', M.t(x + 7, 1.7, pz - 19.6)]);
        lp.push([bevelBox(1.8, 0.4, 0.08, 0.03), '#a8713f', M.t(x + 7, 2.0, pz - 19.9)]);
        k.nearParts('solid', lp);
      }
    }
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
    const hiQ = k.q === 'high', loQ = k.q === 'low';
    const tubSeg = hiQ ? 128 : loQ ? 64 : 96;
    const wparts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.TorusGeometry(R, 0.45, hiQ ? 8 : 6, tubSeg), '#ffffff', M.t(0, 0, 1.6)],
      [new THREE.TorusGeometry(R, 0.45, hiQ ? 8 : 6, tubSeg), '#ffffff', M.t(0, 0, -1.6)],
      [new THREE.TorusGeometry(R - 1.6, 0.25, 6, tubSeg), '#ffffff', M.t(0, 0, 1.6)],
      [new THREE.TorusGeometry(R - 1.6, 0.25, 6, tubSeg), '#ffffff', M.t(0, 0, -1.6)],
      [new THREE.TorusGeometry(R * 0.55, 0.3, 6, 48), '#ff4d4d', M.t(0, 0, 0)],
      [lathe([[1.9, -2.6], [2.2, -2.2], [2.2, 2.2], [1.9, 2.6], [0.6, 2.9]], 16).rotateX(Math.PI / 2), '#d9d9d9', M.t(0, 0, 0)],
    ];
    const NS = hiQ ? 40 : loQ ? 20 : 30;
    for (let i = 0; i < NS; i++) {
      const a = (i / NS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (const zz of [1.6, -1.6]) {
        // tangential spokes (offset from the hub like the real wheel)
        const ta = a + (zz > 0 ? 0.08 : -0.08);
        beam(wparts, [Math.cos(ta + Math.PI / 2) * 2.0, Math.sin(ta + Math.PI / 2) * 2.0, zz * 1.4], [ca * R, sa * R, zz], 0.16, i % 2 ? '#ff4d4d' : '#ffffff');
      }
      // rungs between the rims + truss diagonals
      if (!loQ) {
        beam(wparts, [ca * R, sa * R, 1.6], [ca * R, sa * R, -1.6], 0.14, '#ffffff');
        const a2 = ((i + 1) / NS) * Math.PI * 2;
        beam(wparts, [ca * R, sa * R, 1.6], [Math.cos(a2) * (R - 1.6), Math.sin(a2) * (R - 1.6), 1.6], 0.1, '#ffffff');
        beam(wparts, [ca * R, sa * R, -1.6], [Math.cos(a2) * (R - 1.6), Math.sin(a2) * (R - 1.6), -1.6], 0.1, '#ffffff');
      }
    }
    // rim lights
    const NL = hiQ ? 96 : 64;
    for (let i = 0; i < NL; i++) {
      const a = (i / NL) * Math.PI * 2;
      wparts.push([new THREE.SphereGeometry(0.38, 6, 4), i % 2 ? '#fff27a' : '#ff7ad9', M.t(Math.cos(a) * R, Math.sin(a) * R, 2.1)]);
    }
    const wheelMesh = new THREE.Mesh(bag.add(mergeColored(wparts)), bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25, emissive: '#331a22', emissiveIntensity: 0.4 })));
    wheelMesh.castShadow = true;
    wheel.add(wheelMesh);
    const NG = hiQ ? 42 : loQ ? 24 : 30;
    const gs = hiQ ? 12 : 8;
    const gondGeo = bag.add(
      mergeColored([
        [lathe([[0.2, -3.6], [1.2, -3.5], [1.5, -3.2], [1.55, -2.6], [1.55, -1.3], [1.45, -1.05]], gs), '#ffffff'],
        [new THREE.CylinderGeometry(1.58, 1.58, 1.0, gs, 1, true), '#3b5f8a', M.t(0, -1.95, 0)],
        [lathe([[1.75, 0], [1.7, 0.18], [1.2, 0.42], [0.3, 0.55], [0.0, 0.58]], gs), '#ffffff', M.t(0, -1.05, 0)],
        [new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), '#888', M.t(0, -0.3, 0)],
        ...(hiQ ? Array.from({ length: 6 }, (_, j): [THREE.BufferGeometry, string, THREE.Matrix4] => [new THREE.BoxGeometry(0.1, 1.0, 0.08), '#ffffff', M.trs(Math.cos((j / 6) * Math.PI * 2) * 1.58, -1.95, Math.sin((j / 6) * Math.PI * 2) * 1.58, 0, -(j / 6) * Math.PI * 2, 0)]) : []),
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
    const pink = '#f1c6b5', pink2 = '#e3b19f';
    const hq = quality === 'high', lq = quality === 'low';
    const sg = hq ? 64 : lq ? 32 : 48;
    const T = (px: number, py: number, pz: number) => M.t(fo.x + px, py, fo.z + pz);
    const fparts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      // great basin rim with a moulded lip
      [lathe([[25.6, 0], [26.6, 0], [26.6, 0.9], [26.9, 1.05], [26.9, 1.3], [26.2, 1.4], [25.6, 1.3]], sg), pink, T(0, 0, 0)],
      // lower tier: pedestal + scalloped bowl
      [lathe([[11, 0], [10.4, 0.4], [9.2, 1.0], [9, 3]], sg / 2), pink, T(0, 0, 0)],
      [lathe([[0, 3.0], [8, 3.0], [10.2, 3.6], [10.4, 4.25], [9.9, 4.35], [9.6, 4.2]], sg), pink, T(0, 0, 0)],
      // middle tier
      [lathe([[5, 4.2], [4.2, 4.6], [3.8, 6.2], [4.3, 7.0]], sg / 2), pink2, T(0, 0, 0)],
      [lathe([[0, 6.9], [4.5, 6.9], [6.1, 7.5], [6.2, 7.95], [5.8, 8.0]], sg), pink, T(0, 0, 0)],
      // top tier + spout
      [lathe([[2.4, 7.9], [1.8, 8.4], [1.5, 10.2], [2.0, 10.6]], sg / 2), pink2, T(0, 0, 0)],
      [lathe([[0, 10.5], [2.4, 10.5], [3.1, 10.95], [3.1, 11.25], [2.8, 11.3]], sg / 2), pink, T(0, 0, 0)],
      [lathe([[0.7, 11.2], [0.45, 11.6], [0.35, 12.2], [0.0, 12.3]], 12), pink2, T(0, 0, 0)],
    ];
    // scallops (shell lobes) round the tier lips
    if (!lq) for (const [r, y, n, sz] of [[10.2, 4.0, hq ? 32 : 20, 0.7], [6.1, 7.7, hq ? 24 : 14, 0.55], [3.0, 11.05, hq ? 14 : 10, 0.45]] as const) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        fparts.push([new THREE.SphereGeometry(sz, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), pink2, M.trs(fo.x + Math.cos(a) * r, y, fo.z + Math.sin(a) * r, Math.PI / 2, 0, -a + Math.PI / 2, 1, 0.5, 1)]);
      }
    }
    // sea horses: coiled tail, arched body, head with snout and fin
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const hb = M.trs(fo.x + Math.cos(a) * 17, 0.9, fo.z + Math.sin(a) * 17, 0, -a - Math.PI / 2, 0);
      const bronze = '#5f8f7a', bz2 = '#4d7865';
      fparts.push([new THREE.CylinderGeometry(1.6, 2.0, 1.2, 12), pink2, L(hb, M.t(0, 0.2, 0))]);
      fparts.push([new THREE.TorusGeometry(0.75, 0.3, 6, 12, Math.PI * 1.5), bronze, L(hb, M.trs(0, 1.6, -0.6, 0, Math.PI / 2, 0))]);
      fparts.push([new THREE.CapsuleGeometry(0.75, 1.8, 4, 10), bronze, L(hb, M.trs(0, 2.7, 0.2, 0.35, 0, 0))]);
      fparts.push([new THREE.SphereGeometry(0.7, 10, 8), bronze, L(hb, M.trs(0, 4.1, 0.9, 0, 0, 0, 0.8, 0.9, 1.1))]);
      fparts.push([new THREE.CylinderGeometry(0.22, 0.32, 1.2, 8).rotateX(Math.PI / 2), bz2, L(hb, M.t(0, 4.0, 1.8))]);
      fparts.push([new THREE.ConeGeometry(0.5, 1.4, 4), bz2, L(hb, M.trs(0, 4.8, 0.4, -0.5, 0, 0, 0.3, 1, 1))]);
      for (const sx of [-1, 1]) fparts.push([new THREE.ConeGeometry(0.4, 1.1, 4), bz2, L(hb, M.trs(sx * 0.6, 3.0, 0.6, 0.6, 0, sx * 0.8, 0.3, 1, 1))]);
    }
    // plaza ring, balustrade of posts on the outer basin and lamp standards
    fparts.push([new THREE.CylinderGeometry(36, 36, 0.3, sg), '#e9dcc3', M.t(fo.x, 0.05, fo.z)]);
    if (!lq) {
      const np = hq ? 120 : 64;
      for (let i = 0; i < np; i++) {
        const a = (i / np) * Math.PI * 2;
        k.near('solid', lathe([[0.16, 0], [0.12, 0.15], [0.17, 0.4], [0.1, 0.6], [0.16, 0.7]], 6), pink2, T(Math.cos(a) * 27.6, 0.2, Math.sin(a) * 27.6));
      }
      fparts.push([new THREE.TorusGeometry(27.6, 0.18, 4, sg).rotateX(Math.PI / 2), pink, T(0, 0.98, 0)]);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const lp: P = [];
        const lm = M.t(fo.x + Math.cos(a) * 31, 0.2, fo.z + Math.sin(a) * 31);
        lp.push([lathe([[0.4, 0], [0.3, 0.6], [0.14, 1.0], [0.1, 4.2], [0.18, 4.4]], 8), '#2b3238', lm]);
        lp.push([new THREE.SphereGeometry(0.42, 10, 8), '#fff3c4', L(lm, M.trs(0, 4.85, 0, 0, 0, 0, 1, 1.3, 1))]);
        k.nearParts('solid', lp);
      }
    }
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

/** Body material for instanced houses: stylised masonry (bricks) or lap siding on 'medium' / 'high'. */
export function houseBodyMat(bag: Bag, kind: 'brick' | 'siding' = 'brick'): THREE.MeshStandardMaterial {
  const m = vcMat(bag, { roughness: 0.85 });
  if (BUILD.quality === 'low') return m;
  return kind === 'brick'
    ? masonry(m, { space: 'local', size: [0.6, 0.23], mortar: 0.15, mortarColor: '#d8cbb6', jitter: 0.22, bump: 1.4, tintedOnly: true })
    : masonry(m, { space: 'local', size: [9, 0.28], mortar: 0.12, mortarColor: '#9a9a9a', jitter: 0.03, bump: 2.2, tintedOnly: true });
}

/** Detail level for house kits: 'high'/'medium' -> fine near detail with an LOD hint to `far`. */
const houseQ = (): Quality => BUILD.quality;
const lodHint = (near: THREE.BufferGeometry, far: THREE.BufferGeometry | null, dist: number): THREE.BufferGeometry => {
  near.userData.lod = { far, dist, cell: 110 };
  return near;
};

/** Angled three-sided bay (front width fw, back width bw, depth dd, height h) centred at x, front +Z at z. */
function bayGeo(x: number, z: number, bw: number, fw: number, dd: number, h: number): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(x - bw / 2, -(z - 0.05));
  sh.lineTo(x + bw / 2, -(z - 0.05));
  sh.lineTo(x + fw / 2, -(z + dd));
  sh.lineTo(x - fw / 2, -(z + dd));
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Chicago two-flat (8 x 8.4 x 14 m): brick body (tinted per instance), angled bay with three
 * windows per floor, bracketed cornice, stone lintels / keystones, stoop with steps, transom door
 * and a black fire escape on the side. `simple` = the cheap far version. Front faces +Z.
 */
export function twoFlat(simple = false): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const W = 8, H = 8.4, D = 14;
  const q = houseQ();
  const fine = !simple && q !== 'low';
  const body = mergeColored([
    [new THREE.BoxGeometry(W, H, D), '#ffffff', M.t(0, H / 2, 0)],
    fine ? [bayGeo(-1.6, D / 2, 3.4, 2.0, 1.2, H - 0.6), '#ffffff'] : [new THREE.BoxGeometry(3.2, H - 0.6, 1.4), '#ffffff', M.t(-1.6, (H - 0.6) / 2, D / 2 + 0.6)],
  ]);
  const farDetail = (): THREE.BufferGeometry => {
    const d: P = [
      [new THREE.BoxGeometry(W + 0.5, 0.7, D + 0.5), '#e9dcc4', M.t(0, H + 0.1, 0)],
      [new THREE.BoxGeometry(W + 0.1, 0.3, D + 0.1), '#d8cab0', M.t(0, H / 2, 0)],
      [new THREE.BoxGeometry(2.6, 1.2, 2.6), '#cfc6b8', M.t(2.4, 0.6, D / 2 + 1.3)],
      [new THREE.BoxGeometry(1.3, 2.4, 0.2), '#5a2f1c', M.t(2.4, 2.4, D / 2 + 0.02)],
      [new THREE.BoxGeometry(3.0, 0.25, 2.2), '#5d4037', M.t(2.4, 3.8, D / 2 + 1.1)],
    ];
    for (const y of [2.6, 6.2]) win(d, -1.6, y, D / 2 + 1.32, 2.2, 1.9);
    win(d, 2.4, 6.2, D / 2 + 0.02, 1.2, 1.8);
    return mergeColored(d);
  };
  if (!fine) return { body, detail: farDetail() };
  const stone = '#e6dcc8', trim = '#f4f1e8', glass = '#2b4566';
  const d: P = [
    // bracketed cornice + frieze band
    [bevelBox(W + 0.7, 0.55, D + 0.7, 0.18), stone, M.t(0, H + 0.2, 0)],
    [new THREE.BoxGeometry(W + 0.2, 0.5, D + 0.2), '#d8cab0', M.t(0, H - 0.25, 0)],
    [bevelBox(3.9, 0.45, 1.75, 0.12), stone, M.t(-1.6, H - 0.28, D / 2 + 0.75)],
    // string course between floors + stone base course
    [bevelBox(W + 0.16, 0.24, D + 0.16, 0.07), stone, M.t(0, H / 2, 0)],
    [bevelBox(W + 0.2, 0.9, D + 0.2, 0.1), '#b9ad98', M.t(0, 0.45, 0)],
    // stoop: landing, steps, cheek walls, door with transom, canopy
    [bevelBox(2.6, 1.3, 1.8, 0.08), '#cfc6b8', M.t(2.4, 0.65, D / 2 + 0.9)],
    [new THREE.BoxGeometry(1.4, 2.4, 0.14), '#5a2f1c', M.t(2.4, 2.5, D / 2 + 0.03)],
    [new THREE.BoxGeometry(1.2, 2.0, 0.1), '#6e3a22', M.t(2.4, 2.4, D / 2 + 0.08)],
    [new THREE.BoxGeometry(1.4, 0.45, 0.12), glass, M.t(2.4, 3.95, D / 2 + 0.04)],
    [bevelBox(1.9, 0.22, 0.36, 0.06), stone, M.t(2.4, 4.3, D / 2 + 0.12)],
    [new THREE.SphereGeometry(0.06, 6, 4), '#d4b04a', M.t(2.85, 2.4, D / 2 + 0.16)],
  ];
  for (let i = 0; i < 4; i++) d.push([bevelBox(2.0, 0.3, 0.42, 0.05), '#cfc6b8', M.t(2.4, 0.15 + i * 0.3, D / 2 + 1.8 + (3 - i) * 0.4)]);
  for (const sx of [-1, 1]) d.push([bevelBox(0.3, 1.4, 3.2, 0.06), '#bfb5a4', M.trs(2.4 + sx * 1.15, 0.7, D / 2 + 1.6, 0, 0, 0)]);
  // cornice brackets
  for (let x = -W / 2 + 0.4; x <= W / 2 - 0.3; x += 0.9) d.push([bevelBox(0.22, 0.5, 0.42, 0.05), stone, M.t(x, H - 0.45, D / 2 + 0.25)]);
  // bay: three windows per floor on the angled faces
  const bayZ = D / 2 + 1.2;
  const ang = Math.atan2(1.2, (3.4 - 2.0) / 2);
  for (const y of [2.7, 6.3]) {
    winFine(d, -1.6, y, bayZ + 0.02, 1.4, 1.9, glass, trim, undefined, { lintel: stone, keystone: true });
    for (const sx of [-1, 1]) {
      const cx = -1.6 + sx * (3.4 + 2.0) / 4, cz = D / 2 + 0.6;
      winFine(d, 0, y, 0.03, 0.7, 1.8, glass, trim, M.trs(cx, 0, cz, 0, sx * (Math.PI / 2 - ang), 0), { mullion: false, lintel: stone });
    }
  }
  winFine(d, 2.4, 6.3, D / 2 + 0.02, 1.2, 1.8, glass, trim, undefined, { lintel: stone, keystone: true });
  // side windows (+x side) and fire escape on the -x side
  const sideR = new THREE.Matrix4().makeRotationY(Math.PI / 2), sideL = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  for (const z of [-4, 0, 4]) for (const y of [2.6, 6.2]) {
    winFine(d, -z, y, W / 2 + 0.02, 1.1, 1.6, glass, trim, sideR, { mullion: false, lintel: stone });
    winFine(d, z, y, W / 2 + 0.02, 1.1, 1.6, glass, trim, sideL, { mullion: false, lintel: stone });
  }
  fireEscapeParts(d, sideL, 2, W / 2 + 0.02, [3.6, 7.2], 3.4);
  // rooftop: chimney + vent
  d.push([bevelBox(0.8, 1.6, 0.8, 0.08), '#8f4a35', M.t(2.8, H + 1.1, -4)]);
  d.push([new THREE.BoxGeometry(1.0, 0.15, 1.0), stone, M.t(2.8, H + 1.95, -4)]);
  d.push([new THREE.CylinderGeometry(0.15, 0.15, 0.8, 6), '#9aa0a8', M.t(-2, H + 0.8, 3)]);
  return { body, detail: lodHint(mergeColored(d), farDetail(), q === 'high' ? 120 : 75) };
}

/** Brick bungalow with a hipped roof, dormer and a columned porch. */
export function bungalow(): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const W = 9, H = 4.2, D = 13;
  const q = houseQ();
  const body = mergeColored([[new THREE.BoxGeometry(W, H, D), '#ffffff', M.t(0, H / 2, 0)]]);
  const base = (): P => [
    [new THREE.ConeGeometry(Math.hypot(W, D) / 2 + 0.6, 4.2, 4, 1).rotateY(Math.PI / 4), '#4a4f5a', M.trs(0, H + 2.05, 0, 0, 0, 0, W / Math.hypot(W, D) * 1.05, 1, D / Math.hypot(W, D) * 1.05)],
    [new THREE.BoxGeometry(2.0, 2.2, 1.0), '#ffffff', M.t(0, H + 2.2, 2.5)], // dormer
    [new THREE.ConeGeometry(1.5, 1.0, 4).rotateY(Math.PI / 4), '#4a4f5a', M.t(0, H + 3.7, 2.5)],
    [new THREE.BoxGeometry(W - 1, 0.4, 3), '#cfc6b8', M.t(0, 0.6, D / 2 + 1.5)], // porch
    [new THREE.BoxGeometry(W - 1, 0.25, 3.2), '#e8e1d4', M.t(0, 3.4, D / 2 + 1.5)],
  ];
  const far = (): THREE.BufferGeometry => {
    const d = base();
    d.push([new THREE.BoxGeometry(0.35, 2.8, 0.35), '#f2efe8', M.t(-W / 2 + 0.8, 2.0, D / 2 + 2.8)]);
    d.push([new THREE.BoxGeometry(0.35, 2.8, 0.35), '#f2efe8', M.t(W / 2 - 0.8, 2.0, D / 2 + 2.8)]);
    d.push([new THREE.BoxGeometry(1.2, 2.2, 0.2), '#7a2e1f', M.t(1.8, 1.9, D / 2 + 0.02)]);
    win(d, -2.0, 2.2, D / 2 + 0.02, 2.6, 1.6);
    win(d, 0, 6.5, 3.02, 1.2, 1.0);
    return mergeColored(d);
  };
  if (q === 'low') return { body, detail: far() };
  const d = base();
  const trim = '#f2efe8', glass = '#2b4566';
  // tapered craftsman porch columns on brick piers, railing, fascia, door
  for (const x of [-W / 2 + 0.8, 0, W / 2 - 0.8]) {
    d.push([bevelBox(0.7, 1.0, 0.7, 0.08), '#a8553d', M.t(x, 1.3, D / 2 + 2.8)]);
    d.push([new THREE.CylinderGeometry(0.17, 0.25, 1.6, 4).rotateY(Math.PI / 4), trim, M.t(x, 2.6, D / 2 + 2.8)]);
  }
  for (let x = -W / 2 + 1.2; x < W / 2 - 1; x += 0.3) if (Math.abs(x) > 0.5) d.push([new THREE.BoxGeometry(0.06, 0.6, 0.06), trim, M.t(x, 1.2, D / 2 + 2.9)]);
  d.push([new THREE.BoxGeometry(W - 1.4, 0.08, 0.1), trim, M.t(0, 1.5, D / 2 + 2.9)]);
  d.push([bevelBox(W + 1.3, 0.3, D + 1.3, 0.1), '#3d424c', M.t(0, H + 0.05, 0)]);
  d.push([new THREE.BoxGeometry(1.2, 2.2, 0.2), '#7a2e1f', M.t(1.8, 1.9, D / 2 + 0.02)]);
  for (let i = 0; i < 3; i++) d.push([new THREE.BoxGeometry(0.25, 0.2, 0.05), glass, M.t(1.8 + (i - 1) * 0.32, 2.6, D / 2 + 0.13)]);
  winFine(d, -2.0, 2.2, D / 2 + 0.02, 2.6, 1.6, glass, trim, undefined, { lintel: '#d9cfb9' });
  winFine(d, 0, 6.5, 3.02, 1.2, 1.0, glass, trim, undefined, { mullion: false });
  const sideR = new THREE.Matrix4().makeRotationY(Math.PI / 2), sideL = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  for (const z of [-3.5, 2.5]) {
    winFine(d, -z, 2.3, W / 2 + 0.02, 1.4, 1.4, glass, trim, sideR, { mullion: false, lintel: '#d9cfb9' });
    winFine(d, z, 2.3, W / 2 + 0.02, 1.4, 1.4, glass, trim, sideL, { mullion: false, lintel: '#d9cfb9' });
  }
  d.push([bevelBox(0.9, 2.2, 0.9, 0.08), '#8f4a35', M.t(-2.6, H + 2.6, -3)]);
  return { body, detail: lodHint(mergeColored(d), far(), q === 'high' ? 110 : 70) };
}

/** Wooden frame house with a gable roof (siding colour = instance tint), porch and shutters. */
export function frameHouse(): { body: THREE.BufferGeometry; detail: THREE.BufferGeometry } {
  const W = 7.5, H = 6, D = 12;
  const q = houseQ();
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
  const base = (): P => [
    [roofL.clone(), '#8b3a2e', M.trs(-hw / 2, H + rh / 2 + 0.1, 0, 0, 0, ang)],
    [roofL.clone(), '#8b3a2e', M.trs(hw / 2, H + rh / 2 + 0.1, 0, 0, 0, -ang)],
    [new THREE.BoxGeometry(W + 0.2, 0.3, 0.2), '#ffffff', M.t(0, H, D / 2 + 0.05)],
    [new THREE.BoxGeometry(1.2, 2.3, 0.2), '#2f4f8f', M.t(-2, 1.7, D / 2 + 0.02)],
    [new THREE.BoxGeometry(2.8, 0.6, 1.8), '#d8d0c2', M.t(-2, 0.3, D / 2 + 0.9)],
  ];
  const far = (): THREE.BufferGeometry => {
    const d = base();
    win(d, 1.6, 2.2, D / 2 + 0.02, 1.6, 1.7);
    win(d, -1.6, 4.6, D / 2 + 0.02, 1.2, 1.4);
    win(d, 1.6, 4.6, D / 2 + 0.02, 1.2, 1.4);
    win(d, 0, 7.2, D / 2 + 0.02, 1.0, 1.0);
    return mergeColored(d);
  };
  if (q === 'low') return { body, detail: far() };
  const d = base();
  const trim = '#ffffff', glass = '#2b4566', shutter = '#2f4f3f';
  // porch roof on posts, rake boards, corner boards, shutters
  d.push([bevelBox(4.2, 0.18, 2.2, 0.06), '#8b3a2e', M.trs(-1.2, 3.2, D / 2 + 1.1, 0.12, 0, 0)]);
  for (const x of [-3.1, 0.7]) d.push([bevelBox(0.18, 2.9, 0.18, 0.04), trim, M.t(x, 1.75, D / 2 + 2.0)]);
  for (const sx of [-1, 1]) {
    d.push([new THREE.BoxGeometry(0.18, H, 0.18), trim, M.t(sx * (W / 2 + 0.02), H / 2, D / 2 + 0.02)]);
    d.push([new THREE.BoxGeometry(Math.hypot(hw, rh) + 0.3, 0.22, 0.12), trim, M.trs(sx * hw / 2, H + rh / 2 + 0.02, D / 2 + 0.38, 0, 0, -sx * ang)]);
  }
  for (const [x, y, w, h] of [[1.6, 2.2, 1.6, 1.7], [-1.6, 4.6, 1.2, 1.4], [1.6, 4.6, 1.2, 1.4]] as const) {
    winFine(d, x, y, D / 2 + 0.02, w, h, glass, trim);
    for (const sx of [-1, 1]) d.push([bevelBox(0.42, h + 0.1, 0.08, 0.03), shutter, M.t(x + sx * (w / 2 + 0.38), y, D / 2 + 0.08)]);
  }
  winFine(d, 0, 7.2, D / 2 + 0.02, 1.0, 1.0, glass, trim, undefined, { mullion: false });
  return { body, detail: lodHint(mergeColored(d), far(), q === 'high' ? 110 : 70) };
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

/* ================================================================== lake, river, bascule bridges */

/**
 * Lake Michigan east of x = shoreX: animated water plane, seawall + railing along the shore and
 * `boats` sailboats cruising (animated). zRange limits the seawall / boat lanes.
 */
export function buildLakeMichigan(k: Kit, shoreX: number, zRange: [number, number], boats = 16, o: { plane?: boolean; seawall?: boolean; boatX?: [number, number] } = {}): THREE.MeshStandardMaterial {
  const rng = new Rng(77);
  const waterTex = k.bag.add(waterTextureLocal('#2b8be0', '#bfe9ff'));
  waterTex.repeat.set(220, 220);
  const lakeMat = k.bag.add(new THREE.MeshStandardMaterial({ color: '#4aa6f0', map: waterTex, roughness: 0.12, metalness: 0.25 }));
  const lake = new THREE.Mesh(k.bag.add(new THREE.PlaneGeometry(5000, 5000)), lakeMat);
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(shoreX + 2500 - 4, -0.9, (zRange[0] + zRange[1]) / 2);
  lake.receiveShadow = true;
  lake.name = 'lakeMichigan';
  if (o.plane !== false) k.group.add(lake);
  k.updaters.push((dt) => {
    waterTex.offset.x += dt * 0.004;
    waterTex.offset.y += dt * 0.0025;
  });
  const [z0, z1] = [zRange[0] - 400, zRange[1] + 400];
  if (o.seawall !== false) {
    k.solid.push([new THREE.BoxGeometry(3, 2.2, z1 - z0), '#d8d2c4', M.t(shoreX - 1.5, -0.9, (z0 + z1) / 2)]);
    k.solid.push([new THREE.BoxGeometry(0.3, 0.9, z1 - z0), '#5a6470', M.t(shoreX - 0.2, 0.6, (z0 + z1) / 2)]);
  }
  if (boats <= 0) return lakeMat;
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.2, 0.2, 0, 9, 0.2, 0, 1.2, -3.4, 0, 1.2, 0.2, 0, 1.2, -3.4, 0, 9, 0.2], 3));
  sail.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  sail.computeVertexNormals();
  const jib = new THREE.BufferGeometry();
  jib.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.2, 0.6, 0, 7.5, 0.4, 0, 1.2, 3.2, 0, 1.2, 0.6, 0, 1.2, 3.2, 0, 7.5, 0.4], 3));
  jib.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  jib.computeVertexNormals();
  const geo = k.bag.add(mergeColored([
    [new THREE.BoxGeometry(1.8, 0.9, 6.5), '#f4f4f0', M.t(0, 0.3, 0)],
    [new THREE.BoxGeometry(1.9, 0.18, 6.6), '#1d3f73', M.t(0, 0.62, 0)],
    [new THREE.CylinderGeometry(0.07, 0.09, 9.5, 5), '#dddddd', M.t(0, 5, 0.3)],
    [sail, '#ffffff'],
    [jib, '#ff6b6b'],
  ]));
  const mat = tintMaskMat(k.bag, { roughness: 0.6, side: THREE.DoubleSide });
  const [bx0, bx1] = o.boatX ?? [60, 600];
  const data = Array.from({ length: boats }, () => ({ x: shoreX + rng.range(bx0, bx1), z: rng.range(z0, z1), yaw: rng.range(-0.6, 0.6) + (rng.chance(0.5) ? Math.PI : 0), v: rng.range(1.5, 4), ph: rng.next() * 6 }));
  const im = new THREE.InstancedMesh(geo, mat, boats);
  const cols = ['#ffffff', '#ffe066', '#ff8fab', '#9be7ff', '#ffffff', '#c3f584', '#41B6E6'];
  data.forEach((_, i) => im.setColorAt(i, new THREE.Color(cols[i % cols.length])));
  im.frustumCulled = false;
  im.castShadow = true;
  im.name = 'sailboats';
  k.group.add(im);
  k.updaters.push((dt, t) => {
    data.forEach((b, i) => {
      b.z += Math.cos(b.yaw) * b.v * dt;
      b.x += Math.sin(b.yaw) * b.v * dt;
      if (b.z > z1) b.z = z0;
      if (b.z < z0) b.z = z1;
      setInstance(im, i, b.x, -0.75 + Math.sin(t * 1.3 + b.ph) * 0.15, b.z, Math.sin(t * 1.1 + b.ph) * 0.05, b.yaw, Math.sin(t * 0.9 + b.ph) * 0.08 + 0.12, 1.6);
    });
    im.instanceMatrix.needsUpdate = true;
  });
  return lakeMat;
}

function waterTextureLocal(base: string, light: string): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g, w, h, rng) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = light;
    g.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.25, 0.7);
      g.lineWidth = rng.range(1, 2.5);
      const x = rng.next() * w, y = rng.next() * h, l = rng.range(8, 26);
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + l / 2, y - 3, x + l, y);
      g.stroke();
    }
    g.globalAlpha = 1;
  }, { seed: 91 });
}

export interface RiverChannel { cx: number; cz: number; ax: number; az: number; halfLen: number; halfWidth: number }

/**
 * St. Patrick's-green Chicago River over a terrain channel (TrackField channel): water overlay at
 * y = waterY, stone river walls, a Riverwalk ledge with umbrellas, and `tourBoats` cruising
 * (keep `clearAt` (local x along the river) free of umbrellas, e.g. under a jump).
 */
export function buildGreenRiver(k: Kit, c: RiverChannel, o: { waterY?: number; tourBoats?: number; clearAt?: number } = {}): void {
  const rng = new Rng(31);
  const ang = -Math.atan2(c.az, c.ax);
  const base = M.trs(c.cx, 0, c.cz, 0, ang, 0);
  const at = (lx: number, ly: number, lz: number, ry = 0) => base.clone().multiply(M.trs(lx, ly, lz, 0, ry, 0));
  const tex = k.bag.add(waterTextureLocal('#13b24a', '#9dffb5'));
  tex.repeat.set((c.halfLen * 2) / 14, (c.halfWidth * 2) / 14);
  const mat = k.bag.add(new THREE.MeshStandardMaterial({ color: '#2fe06a', map: tex, roughness: 0.12, metalness: 0.15, emissive: '#0b5a26', emissiveIntensity: 0.35 }));
  const river = new THREE.Mesh(k.bag.add(new THREE.PlaneGeometry(c.halfLen * 2 + 4, c.halfWidth * 2 + 8).rotateX(-Math.PI / 2)), mat);
  river.applyMatrix4(at(0, o.waterY ?? -2.05, 0));
  river.receiveShadow = true;
  river.name = 'greenRiver';
  k.group.add(river);
  k.updaters.push((dt) => {
    tex.offset.x -= dt * 0.03;
  });
  const clear = o.clearAt ?? 1e9;
  for (const side of [-1, 1]) {
    k.solid.push([new THREE.BoxGeometry(c.halfLen * 2, 7.2, 1.2), '#bdb6a6', at(0, -3.3, side * (c.halfWidth + 1))]);
    k.solid.push([new THREE.BoxGeometry(c.halfLen * 2, 0.5, 2.4), '#d8cfbd', at(0, -0.95, side * (c.halfWidth - 0.4))]);
    for (let lx = -c.halfLen + 8; lx < c.halfLen - 8; lx += 16) {
      if (Math.abs(lx - clear) < 20) continue;
      k.solid.push([new THREE.CylinderGeometry(0.05, 0.05, 2.2, 4), '#dddddd', at(lx, 0.4, side * (c.halfWidth - 0.6))]);
      k.solid.push([new THREE.ConeGeometry(1.3, 0.6, 8), rng.pick(['#e8392b', '#ffd23f', '#1f8f3a', '#2f7de1']), at(lx, 1.6, side * (c.halfWidth - 0.6))]);
    }
  }
  const nb = o.tourBoats ?? 2;
  if (nb <= 0) return;
  const boatGeo = k.bag.add(mergeColored([
    [new THREE.BoxGeometry(11, 1.4, 3.8), '#ffffff', M.t(0, 0.4, 0)],
    [new THREE.BoxGeometry(11.1, 0.3, 3.9), '#1b2f5c', M.t(0, 1.0, 0)],
    [new THREE.BoxGeometry(6, 1.3, 3.2), '#eef3f8', M.t(-1.5, 1.8, 0)],
    [new THREE.BoxGeometry(5.6, 0.7, 3.25), '#33506e', M.t(-1.5, 1.9, 0)],
    [new THREE.BoxGeometry(6.4, 0.15, 3.6), '#ffd23f', M.t(-1.5, 2.5, 0)],
  ]));
  const im = new THREE.InstancedMesh(boatGeo, tintMaskMat(k.bag, { roughness: 0.4 }), nb);
  for (let i = 0; i < nb; i++) im.setColorAt(i, new THREE.Color(i % 2 ? '#fff4d6' : '#e8f4ff'));
  im.frustumCulled = false;
  im.castShadow = true;
  im.name = 'tourBoats';
  k.group.add(im);
  const tm = new THREE.Matrix4();
  k.updaters.push((_dt, t) => {
    for (let i = 0; i < nb; i++) {
      const span = c.halfLen * 2 - 24;
      const ph = (t / 40 + i / nb) % 2;
      const f = ph < 1 ? ph : 2 - ph;
      tm.copy(base).multiply(M.trs(-span / 2 + f * span, (o.waterY ?? -2.05) + 0.2 + Math.sin(t * 1.4 + i) * 0.06, (i % 2 ? 1 : -1) * Math.min(2.6, c.halfWidth * 0.3), 0, ph < 1 ? 0 : Math.PI, 0));
      im.setMatrixAt(i, tm);
    }
    im.instanceMatrix.needsUpdate = true;
  });
}

/**
 * One raised red bascule leaf truss (pair of side girders rising toward the river), hinged at
 * (x, y, z), pointing along yaw (its +Z), opened by `angle` radians, length `len`, plus a tender
 * house behind the hinge. Use one per bank and road side to frame a jump.
 */
export function basculeLeaf(k: Kit, x: number, y: number, z: number, yaw: number, angle = 0.75, len = 11, width = 1.2): void {
  const b = M.trs(x, y, z, 0, yaw, 0);
  const leaf = L(b, M.trs(0, 0, 0, -angle, 0, 0));
  const red = '#b3202a';
  k.gloss.push([new THREE.BoxGeometry(width, 0.6, len), red, L(leaf, M.t(0, 0, len / 2))]);
  k.gloss.push([new THREE.BoxGeometry(width, 0.6, len), red, L(leaf, M.t(0, 2.6, len / 2 - 0.4))]);
  const n = Math.max(3, Math.round(len / 2.2));
  for (let i = 0; i <= n; i++) {
    const zz = (i / n) * len;
    const hh = 2.6 * (1 - (i / n) * 0.15);
    k.gloss.push([new THREE.BoxGeometry(width * 0.5, hh, 0.3), red, L(leaf, M.t(0, hh / 2, zz))]);
    if (i < n) beam(k.gloss, [0, 0.1, zz], [0, hh - 0.1, zz + len / n], 0.25, red, leaf);
  }
  // counterweight + tender house
  k.solid.push([new THREE.BoxGeometry(2.4, 2.4, 2.4), '#5a5f66', L(leaf, M.t(0, -0.6, -1.6))]);
  k.solid.push([new THREE.BoxGeometry(5, 6, 5), '#e8dcc0', L(b, M.t(0, 3, -6))]);
  k.solid.push([new THREE.ConeGeometry(4, 3, 4).rotateY(Math.PI / 4), '#3f8f7a', L(b, M.t(0, 7.5, -6))]);
  k.solid.push([new THREE.BoxGeometry(1.6, 1.6, 0.2), '#1d2b3f', L(b, M.t(0, 3.6, -3.45))]);
}

/* ================================================================== atmosphere helpers */

/**
 * Let distant objects (a skyline across the lake) take only part of the scene fog, so they read as
 * hazy silhouettes instead of vanishing. Patches every material under root (chains onBeforeCompile).
 */
export function hazeObject(root: THREE.Object3D, amount = 0.55): void {
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat || done.has(mat)) continue;
      done.add(mat);
      const prev = mat.onBeforeCompile;
      const prevKey = mat.customProgramCacheKey.bind(mat);
      mat.onBeforeCompile = (sh, r) => {
        prev.call(mat, sh, r);
        sh.fragmentShader = sh.fragmentShader.replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
            #else
              float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
            #endif
            gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * ${amount.toFixed(3)} );
          #endif`,
        );
      };
      mat.customProgramCacheKey = () => `${prevKey()}|haze${amount}`;
      mat.needsUpdate = true;
    }
  });
}

/** Low-poly seagull (wings spread, +Z forward). */
export function seagullGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.5, -1.4, 0.45, -0.1, 0, 0, -0.4, 0, 0, 0.5, 0, 0, -0.4, 1.4, 0.45, -0.1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  g.computeVertexNormals();
  return mergeColored([
    [g, '#ffffff'],
    [new THREE.ConeGeometry(0.18, 1.2, 5).rotateX(Math.PI / 2), '#f0f0f0', M.t(0, 0, 0.1)],
    [new THREE.ConeGeometry(0.07, 0.25, 4).rotateX(Math.PI / 2), '#ffb300', M.t(0, 0, 0.8)],
  ]);
}

/** Flapping seagulls circling over an area (one instanced draw call, animated on the kit clock). */
export function seagulls(k: Kit, count: number, area: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }, seed = 808): void {
  if (count <= 0) return;
  const rng = new Rng(seed);
  const mat = k.bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }));
  const im = new THREE.InstancedMesh(k.bag.add(seagullGeo()), mat, count);
  im.frustumCulled = false;
  im.castShadow = false;
  im.name = 'seagulls';
  const gd = Array.from({ length: count }, () => ({
    cx: rng.range(area.x0, area.x1), cz: rng.range(area.z0, area.z1), r: rng.range(12, 40), h: rng.range(area.y0, area.y1),
    w: rng.range(0.25, 0.5) * (rng.chance(0.5) ? 1 : -1), ph: rng.next() * 6,
  }));
  k.group.add(im);
  k.updaters.push((_dt, t) => {
    gd.forEach((g, i) => {
      const a = t * g.w + g.ph;
      const flap = 1 + Math.sin(t * 9 + g.ph * 3) * 0.7;
      setInstance(im, i, g.cx + Math.cos(a) * g.r, g.h + Math.sin(t * 0.7 + g.ph) * 2, g.cz + Math.sin(a) * g.r, 0, -a + (g.w > 0 ? Math.PI : 0), -Math.sign(g.w) * 0.35, 1.6, 1.6 * flap, 1.6);
    });
    im.instanceMatrix.needsUpdate = true;
  });
}

/* ================================================================== lakefront */

/**
 * Harbor lighthouse (Montrose-style) at the end of a stone breakwater: white tower with a red band,
 * red lantern roof, glowing lamp and a slowly sweeping beam. `len` = breakwater length toward +Z.
 */
export function lighthouse(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, len = 0): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  if (len > 0) {
    k.solid.push([new THREE.BoxGeometry(7, 2.6, len), '#bdb6a6', L(b, M.t(0, -0.6, -len / 2))]);
    for (let i = 0; i < len / 6; i++) k.solid.push([new THREE.DodecahedronGeometry(1.6, 0), i % 2 ? '#9d978a' : '#aaa496', L(b, M.trs(i % 2 ? 3.6 : -3.6, -0.8, -3 - i * 6, i, i * 0.7, 0))]);
  }
  k.solid.push([new THREE.CylinderGeometry(3.2, 3.6, 2.2, 8), '#d7d0c0', L(b, M.t(0, 0.9, 0))]);
  k.solid.push([new THREE.CylinderGeometry(1.45, 2.1, 15, 16), '#f6f5ef', L(b, M.t(0, 9.5, 0))]);
  k.solid.push([new THREE.CylinderGeometry(1.7, 1.8, 2.2, 16), '#c8202f', L(b, M.t(0, 7.5, 0))]);
  k.solid.push([new THREE.BoxGeometry(0.9, 1.6, 0.2), '#2b3a4a', L(b, M.t(0, 2.6, 2.02))]);
  k.solid.push([new THREE.CylinderGeometry(2.3, 2.3, 0.35, 16), '#2a2d33', L(b, M.t(0, 17.2, 0))]);
  k.solid.push([new THREE.TorusGeometry(2.2, 0.06, 4, 20).rotateX(Math.PI / 2), '#2a2d33', L(b, M.t(0, 18.1, 0))]);
  k.glow.push([new THREE.CylinderGeometry(1.15, 1.15, 1.9, 12), '#fff1a8', L(b, M.t(0, 18.4, 0))]);
  for (let i = 0; i < 6; i++) beam(k.solid, [Math.cos(i) * 1.18, 17.4, Math.sin(i) * 1.18], [Math.cos(i) * 1.18, 19.4, Math.sin(i) * 1.18], 0.12, '#2a2d33', b);
  k.solid.push([new THREE.ConeGeometry(1.75, 1.6, 16), '#c8202f', L(b, M.t(0, 20.2, 0))]);
  k.solid.push([new THREE.SphereGeometry(0.3, 8, 6), '#2a2d33', L(b, M.t(0, 21.1, 0))]);
  // sweeping beam (additive, faint by day, strong once the scene gets dark)
  const beamGeo = k.bag.add(mergeGeometries([
    new THREE.ConeGeometry(5, 70, 12, 1, true).rotateZ(Math.PI / 2).translate(35, 0, 0),
    new THREE.ConeGeometry(5, 70, 12, 1, true).rotateZ(-Math.PI / 2).translate(-35, 0, 0),
  ])!);
  const beamMat = k.bag.add(new THREE.MeshBasicMaterial({ color: '#fff3c0', transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  const bm = new THREE.Mesh(beamGeo, beamMat);
  bm.name = 'lighthouseBeam';
  bm.position.set(x, y + 18.4 * s, z);
  bm.scale.setScalar(s);
  k.group.add(bm);
  k.updaters.push((_dt, t) => {
    bm.rotation.y = t * 0.9;
    const tod = timeOfDay(k.group);
    bm.visible = tod !== 'day';
    beamMat.opacity = tod === 'night' ? 0.4 : 0.2;
  });
}

/**
 * Chicago Park District-style wooden sign (dark brown board, cream routed letters, green tree
 * roundel) on two posts. Faces +Z. `w` = board width in meters.
 */
export function parkDistrictSign(k: Kit, x: number, y: number, z: number, rot: number, lines: [string, string], w = 9): void {
  const b = M.trs(x, y, z, 0, rot, 0);
  const h = w * 0.36;
  const r = k.paint.draw(512, 184, (g, cw, ch) => {
    g.fillStyle = '#4a2f1b';
    g.fillRect(0, 0, cw, ch);
    g.strokeStyle = '#e9dcb8';
    g.lineWidth = 6;
    g.strokeRect(8, 8, cw - 16, ch - 16);
    // tree roundel
    g.fillStyle = '#2d7a3a';
    g.beginPath();
    g.arc(70, ch / 2, 46, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e9dcb8';
    g.beginPath();
    g.moveTo(70, ch / 2 - 34);
    g.lineTo(98, ch / 2 + 12);
    g.lineTo(42, ch / 2 + 12);
    g.closePath();
    g.fill();
    g.fillRect(66, ch / 2 + 10, 8, 20);
    g.save();
    g.translate(128, 6);
    drawText(g, lines[0], cw - 146, ch * 0.6, { fg: '#f4e7c2', font: '900 $px Georgia, "Times New Roman", serif' });
    g.translate(0, ch * 0.56);
    drawText(g, lines[1], cw - 146, ch * 0.3, { fg: '#ffd23f', font: '700 $px Georgia, "Times New Roman", serif' });
    g.restore();
  }, `cpd|${lines.join('|')}`);
  k.paint.quad(r, w, h, L(b, M.t(0, 2.2 + h / 2, 0.16)));
  k.paint.quad(r, w, h, L(b, M.trs(0, 2.2 + h / 2, -0.16, 0, Math.PI, 0)));
  k.solid.push([new THREE.BoxGeometry(w + 0.4, h + 0.4, 0.28), '#3a2414', L(b, M.t(0, 2.2 + h / 2, 0))]);
  for (const px of [-w / 2 + 0.6, w / 2 - 0.6]) k.solid.push([new THREE.BoxGeometry(0.4, 2.4 + h, 0.4), '#3a2414', L(b, M.t(px, (2.4 + h) / 2, 0))]);
}

/* ================================================================== dogs of many breeds */

export type DogBreed = 'lab' | 'dachshund' | 'doodle' | 'husky' | 'corgi';

/**
 * Tag a part for the dog shader: code 2/3 = leg pairs (swing), 4 = tail (wag); uv.y = 0 at the
 * pivot-far end (paw / tail base) to 1, len = part length in meters.
 */
function dogPart(geo: THREE.BufferGeometry, code: number, len: number, tConst?: number): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = code + Math.min(0.099, len * 0.1);
    uv[i * 2 + 1] = tConst ?? (pos.getY(i) - bb.min.y) / Math.max(1e-4, bb.max.y - bb.min.y);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Cartoon dog of a breed: +Z forward, paws at y = 0, ~1.8 m tall; pure-white parts take the instance color. */
export function dogGeo(breed: DogBreed): THREE.BufferGeometry {
  const W = '#ffffff';
  const parts: P = [];
  const leg = (x: number, z: number, len: number, r: number, code: number, col = W) => parts.push([dogPart(new THREE.CylinderGeometry(r, r * 0.85, len, 6), code, len), col, M.t(x, len / 2, z)]);
  const eyes = (y: number, z: number, dx = 0.18) => {
    parts.push([new THREE.SphereGeometry(0.075, 6, 4), '#111', M.t(dx, y, z)]);
    parts.push([new THREE.SphereGeometry(0.075, 6, 4), '#111', M.t(-dx, y, z)]);
  };
  const collar = (y: number, z: number, r: number, col = '#e8443a') => parts.push([new THREE.TorusGeometry(r, 0.07, 5, 12).rotateX(Math.PI / 2), col, M.trs(0, y, z, 0.5, 0, 0)]);
  if (breed === 'lab' || breed === 'husky') {
    const husky = breed === 'husky';
    parts.push([new THREE.CapsuleGeometry(0.46, 1.15, 4, 8).rotateX(Math.PI / 2), W, M.t(0, 1.05, 0)]);
    if (husky) parts.push([new THREE.CapsuleGeometry(0.36, 0.9, 3, 8).rotateX(Math.PI / 2), '#f4f3ee', M.t(0, 0.86, 0.1)]);
    parts.push([new THREE.SphereGeometry(0.44, 10, 8), W, M.t(0, 1.62, 0.95)]);
    parts.push([new THREE.CapsuleGeometry(0.2, 0.3, 3, 8).rotateX(Math.PI / 2), husky ? '#f4f3ee' : W, M.t(0, 1.48, 1.32)]);
    parts.push([new THREE.SphereGeometry(0.11, 6, 4), '#1a1a1a', M.t(0, 1.55, 1.6)]);
    eyes(1.74, 1.3);
    if (husky) {
      for (const sx of [-1, 1]) parts.push([new THREE.ConeGeometry(0.16, 0.42, 4), W, M.trs(sx * 0.25, 2.08, 0.88, 0, 0, sx * -0.2)]);
      parts.push([dogPart(new THREE.TorusGeometry(0.3, 0.12, 5, 10, Math.PI * 1.3), 4, 0.6, 1), W, M.trs(0, 1.55, -0.95, 0, Math.PI / 2, 0)]);
    } else {
      for (const sx of [-1, 1]) parts.push([new THREE.SphereGeometry(0.26, 8, 6), W, M.trs(sx * 0.42, 1.62, 0.85, 0, 0, sx * 0.5, 0.55, 1.2, 0.5)]);
      parts.push([dogPart(new THREE.CylinderGeometry(0.05, 0.11, 0.8, 6), 4, 0.8), W, M.trs(0, 1.4, -1.1, -0.9, 0, 0)]);
    }
    collar(1.4, 0.72, 0.42, husky ? '#2f7de1' : '#e8443a');
    leg(0.27, 0.55, 0.8, 0.14, 2); leg(-0.27, -0.55, 0.8, 0.14, 2);
    leg(-0.27, 0.55, 0.8, 0.14, 3); leg(0.27, -0.55, 0.8, 0.14, 3);
  } else if (breed === 'dachshund' || breed === 'corgi') {
    const corgi = breed === 'corgi';
    parts.push([new THREE.CapsuleGeometry(corgi ? 0.42 : 0.33, corgi ? 1.1 : 1.6, 4, 8).rotateX(Math.PI / 2), W, M.t(0, corgi ? 0.72 : 0.62, 0)]);
    if (corgi) parts.push([new THREE.SphereGeometry(0.36, 8, 6), '#faf5ea', M.t(0, 0.62, 0.62)]);
    const hz = corgi ? 0.95 : 1.2, hy = corgi ? 1.18 : 1.0;
    parts.push([new THREE.SphereGeometry(corgi ? 0.38 : 0.3, 10, 8), W, M.t(0, hy, hz)]);
    parts.push([new THREE.CapsuleGeometry(corgi ? 0.16 : 0.13, corgi ? 0.25 : 0.42, 3, 8).rotateX(Math.PI / 2), corgi ? '#faf5ea' : W, M.t(0, hy - 0.1, hz + (corgi ? 0.32 : 0.4))]);
    parts.push([new THREE.SphereGeometry(0.08, 6, 4), '#1a1a1a', M.t(0, hy - 0.06, hz + (corgi ? 0.55 : 0.72))]);
    eyes(hy + 0.1, hz + 0.24, 0.14);
    if (corgi) for (const sx of [-1, 1]) parts.push([new THREE.ConeGeometry(0.17, 0.5, 4), W, M.trs(sx * 0.22, hy + 0.45, hz - 0.05, 0, 0, sx * -0.3)]);
    else for (const sx of [-1, 1]) parts.push([new THREE.SphereGeometry(0.2, 8, 6), '#5a3418', M.trs(sx * 0.3, hy - 0.12, hz - 0.05, 0, 0, sx * 0.2, 0.45, 1.3, 0.7)]);
    if (!corgi) parts.push([dogPart(new THREE.CylinderGeometry(0.03, 0.08, 0.7, 5), 4, 0.7), W, M.trs(0, 0.75, -1.2, -1.1, 0, 0)]);
    collar(hy - 0.3, hz - 0.3, corgi ? 0.34 : 0.27, corgi ? '#ffd23f' : '#3ccf6e');
    const ll = corgi ? 0.4 : 0.34, lz = corgi ? 0.5 : 0.7;
    leg(0.2, lz, ll, 0.11, 2); leg(-0.2, -lz, ll, 0.11, 2);
    leg(-0.2, lz, ll, 0.11, 3); leg(0.2, -lz, ll, 0.11, 3);
  } else {
    // doodle: all puffs (Lupin's cousins)
    for (let i = 0; i < 4; i++) parts.push([new THREE.IcosahedronGeometry(0.45, 1), W, M.t(0, 1.05 + (i % 2) * 0.06, -0.55 + i * 0.36)]);
    parts.push([new THREE.IcosahedronGeometry(0.5, 1), W, M.t(0, 1.68, 0.9)]);
    parts.push([new THREE.IcosahedronGeometry(0.3, 1), W, M.t(0, 2.1, 0.8)]);
    for (const sx of [-1, 1]) parts.push([new THREE.IcosahedronGeometry(0.26, 1), W, M.trs(sx * 0.48, 1.5, 0.82, 0, 0, 0, 0.8, 1.4, 0.8)]);
    parts.push([new THREE.SphereGeometry(0.24, 8, 6), '#f7efe0', M.t(0, 1.55, 1.3)]);
    parts.push([new THREE.SphereGeometry(0.1, 6, 4), '#1a1a1a', M.t(0, 1.62, 1.52)]);
    parts.push([new THREE.SphereGeometry(0.1, 6, 4), '#ff7aa8', M.trs(0, 1.38, 1.4, 0, 0, 0, 0.9, 0.5, 1)]);
    eyes(1.82, 1.3, 0.2);
    parts.push([dogPart(new THREE.IcosahedronGeometry(0.26, 1), 4, 0.6, 1), W, M.t(0, 1.5, -1.05)]);
    collar(1.38, 0.72, 0.42, '#1f3f8f');
    for (const [x, z, c] of [[0.27, 0.55, 2], [-0.27, -0.55, 2], [-0.27, 0.55, 3], [0.27, -0.55, 3]]) {
      leg(x, z, 0.8, 0.17, c);
      parts.push([dogPart(new THREE.IcosahedronGeometry(0.22, 0), c, 0.8, 0), W, M.t(x, 0.16, z)]);
    }
  }
  return mergeColored(parts);
}

/**
 * Material for dogGeo: pure-white vertices take the instance color, legs trot and tails wag
 * (phase from the instance position, so every dog moves differently). Animated on `time`.
 */
export function dogMat(bag: Bag, time: { value: number }): THREE.MeshStandardMaterial {
  const m = bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <color_vertex>',
        `vColor = vec3(1.0);
        #ifdef USE_COLOR
        vColor *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
        { float tm = step(2.97, color.r + color.g + color.b); vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, tm); }
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float ph = 0.0;
          #ifdef USE_INSTANCING
          ph = instanceMatrix[3].x * 1.37 + instanceMatrix[3].z * 0.71;
          #endif
          float code = floor(uv.x);
          float len = fract(uv.x) * 10.0;
          if (code > 1.5 && code < 3.5) {
            float sw = sin(uTime * 13.0 + ph + (code - 2.0) * 3.14159) * 0.6;
            transformed.z += sw * (1.0 - uv.y) * len;
            transformed.y += max(0.0, -sw) * (1.0 - uv.y) * len * 0.25;
          } else if (code > 3.5 && code < 4.5) {
            transformed.x += sin(uTime * 22.0 + ph) * 0.55 * uv.y * len;
          }
        }`,
      );
  };
  m.customProgramCacheKey = () => 'dogmat';
  return m;
}

/* ================================================================== Chicago food (giant, for the kitchen) */

/**
 * Deep-dish pizza in a black pan with one slice being lifted out on a loop, stretching strings of
 * mozzarella (cheese pull) and chunky tomato on top. Unit radius ~1 at s = 1.
 */
export function deepDishPizza(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, rng = new Rng(312), tilt = 0): void {
  let b = M.trs(x, y, z, 0, rot, 0, s);
  if (tilt) {
    // propped up on a wooden pizza stand so its top faces +Z (lets low cameras see the pie)
    const lift = Math.sin(tilt) * 1.25 + 0.15;
    k.solid.push([new THREE.CylinderGeometry(0.08, 0.1, lift * 2 + 0.3, 6), '#7a4f2a', L(b, M.t(0, 0.15, -0.9))]);
    k.solid.push([new THREE.CylinderGeometry(0.08, 0.1, 0.4, 6), '#7a4f2a', L(b, M.t(-0.8, 0.2, 0.7))]);
    k.solid.push([new THREE.CylinderGeometry(0.08, 0.1, 0.4, 6), '#7a4f2a', L(b, M.t(0.8, 0.2, 0.7))]);
    b = b.multiply(M.trs(0, lift, 0, tilt, 0, 0));
    k.solid.push([new THREE.CylinderGeometry(1.25, 1.25, 0.08, 32), '#b27a43', L(b, M.t(0, -0.04, 0))]);
  }
  const CUT = Math.PI / 4;
  const crust = '#d99a4e', cheese = '#ffd65c', sauce = '#c22d1b';
  // pan
  k.gloss.push([new THREE.CylinderGeometry(1.1, 1.06, 0.62, 40, 1, true), '#232327', L(b, M.t(0, 0.31, 0))]);
  k.gloss.push([new THREE.CylinderGeometry(1.06, 1.06, 0.05, 40), '#232327', L(b, M.t(0, 0.025, 0))]);
  k.gloss.push([new THREE.TorusGeometry(1.1, 0.035, 5, 40).rotateX(Math.PI / 2), '#2e2e33', L(b, M.t(0, 0.62, 0))]);
  // pie minus one slice: crust wall + lip, cheese body, sauce top
  k.solid.push([new THREE.CylinderGeometry(1.05, 1.03, 0.66, 40, 1, true, CUT, Math.PI * 2 - CUT), crust, L(b, M.t(0, 0.33, 0))]);
  k.solid.push([new THREE.TorusGeometry(1.0, 0.07, 6, 40, Math.PI * 2 - CUT).rotateX(Math.PI / 2).rotateY(-Math.PI / 2), crust, L(b, M.t(0, 0.66, 0))]);
  k.solid.push([new THREE.CylinderGeometry(0.96, 0.96, 0.5, 40, 1, false, CUT, Math.PI * 2 - CUT), sauce, L(b, M.t(0, 0.31, 0))]);
  const face = (parts: P, th: number, base: THREE.Matrix4) => {
    const d = (yy: number, hh: number, col: string) => parts.push([new THREE.BoxGeometry(1.0, hh, 0.012), col, L(base, M.trs(Math.sin(th) * 0.5, yy, Math.cos(th) * 0.5, 0, th - Math.PI / 2, 0))]);
    d(0.06, 0.12, crust);
    d(0.3, 0.36, cheese);
    d(0.52, 0.1, sauce);
    d(0.62, 0.08, crust);
  };
  face(k.solid, 0.002, b);
  face(k.solid, CUT - 0.002, b);
  // chunky tomato + parmesan + oregano on top
  for (let i = 0; i < 46; i++) {
    const a = CUT + rng.next() * (Math.PI * 2 - CUT - 0.1), r = Math.sqrt(rng.next()) * 0.85;
    k.solid.push([new THREE.IcosahedronGeometry(rng.range(0.05, 0.1), 0), rng.pick(['#a8180f', '#d6402a', '#b92a17']), L(b, M.trs(Math.sin(a) * r, 0.57, Math.cos(a) * r, rng.next() * 3, rng.next() * 3, 0, 1, 0.6, 1))]);
  }
  for (let i = 0; i < 60; i++) {
    const a = CUT + rng.next() * (Math.PI * 2 - CUT - 0.1), r = Math.sqrt(rng.next()) * 0.9;
    k.solid.push([new THREE.BoxGeometry(0.03, 0.01, 0.03), i % 3 ? '#f4eedc' : '#3f7a2a', L(b, M.t(Math.sin(a) * r, 0.565, Math.cos(a) * r))]);
  }
  // the lifted slice (own mesh so it can move) + spatula
  const sp: P = [];
  const id = new THREE.Matrix4();
  sp.push([new THREE.CylinderGeometry(1.0, 1.0, 0.58, 10, 1, false, 0.03, CUT - 0.06), cheese, M.t(0, 0.31, 0)]);
  sp.push([new THREE.CylinderGeometry(0.97, 0.97, 0.1, 10, 1, false, 0.03, CUT - 0.06), sauce, M.t(0, 0.57, 0)]);
  sp.push([new THREE.CylinderGeometry(1.04, 1.02, 0.66, 10, 1, true, 0.03, CUT - 0.06), crust, M.t(0, 0.33, 0)]);
  face(sp, 0.03, M.t(0, 0, 0));
  face(sp, CUT - 0.03, id);
  for (let i = 0; i < 6; i++) sp.push([new THREE.IcosahedronGeometry(0.08, 0), '#b92a17', M.t(Math.sin(0.2 + i * 0.08) * (0.3 + (i % 3) * 0.2), 0.62, Math.cos(0.2 + i * 0.08) * (0.3 + (i % 3) * 0.2))]);
  sp.push([new THREE.BoxGeometry(0.5, 0.02, 0.62), '#c8ccd2', M.trs(Math.sin(CUT / 2) * 0.5, -0.01, Math.cos(CUT / 2) * 0.5, 0, CUT / 2, 0)]);
  const slice = new THREE.Mesh(k.bag.add(mergeColored(sp)), k.solidMat);
  slice.matrixAutoUpdate = false;
  slice.castShadow = true;
  slice.name = 'pizzaSlice';
  k.group.add(slice);
  // cheese strings between the pie's cut faces and the slice
  const anchors: Array<[THREE.Vector3, THREE.Vector3]> = [];
  for (let i = 0; i < 7; i++) {
    const side = i % 2 ? CUT - 0.002 : 0.002;
    const r = 0.25 + (i / 7) * 0.65, yy = 0.35 + (i % 3) * 0.06;
    const a = new THREE.Vector3(Math.sin(side) * r, yy, Math.cos(side) * r);
    const sd = i % 2 ? CUT - 0.03 : 0.03;
    anchors.push([a, new THREE.Vector3(Math.sin(sd) * r, yy, Math.cos(sd) * r)]);
  }
  const strandMat = k.bag.add(new THREE.MeshStandardMaterial({ color: '#ffe27a', roughness: 0.5, emissive: '#3a2a00' }));
  const strands = new THREE.InstancedMesh(k.bag.add(new THREE.CylinderGeometry(1, 1, 1, 5).translate(0, 0.5, 0)), strandMat, anchors.length);
  strands.frustumCulled = false;
  strands.name = 'cheesePull';
  k.group.add(strands);
  const dir = new THREE.Vector3(Math.sin(CUT / 2), 0, Math.cos(CUT / 2));
  const sm = new THREE.Matrix4(), tmp = new THREE.Matrix4(), A = new THREE.Vector3(), B = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const axis = new THREE.Vector3(dir.z, 0, -dir.x);
  k.updaters.push((_dt, t) => {
    const c = (t % 7) / 7;
    const e = c < 0.35 ? c / 0.35 : c < 0.65 ? 1 : 1 - (c - 0.65) / 0.35;
    const lift = e * e * (3 - 2 * e);
    sm.makeTranslation(dir.x * lift * 0.45, lift * 0.85, dir.z * lift * 0.45).multiply(tmp.makeRotationAxis(axis, lift * 0.12));
    slice.matrix.copy(b).multiply(sm);
    slice.matrixWorldNeedsUpdate = true;
    anchors.forEach(([a, sa], i) => {
      A.copy(a).applyMatrix4(b);
      B.copy(sa).applyMatrix4(sm).applyMatrix4(b);
      const d = B.clone().sub(A);
      const len = Math.max(0.001, d.length());
      q.setFromUnitVectors(_up, d.normalize());
      const th = s * Math.max(0.012, 0.06 / Math.sqrt(1 + (len / s) * 4)) * (lift > 0.02 ? 1 : 0.01);
      tmp.compose(A, q, sc.set(th, len, th));
      strands.setMatrixAt(i, tmp);
    });
    strands.instanceMatrix.needsUpdate = true;
  });
}

/**
 * Italian beef on butcher paper: soaked roll, a pile of thin-sliced beef, hot giardiniera spilling
 * over and jus dripping (animated drops). Roll ~1 long at s = 1, +X along the roll.
 */
export function italianBeef(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, rng = new Rng(4545)): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const giard = ['#f28c1c', '#9ccc4a', '#3e9c35', '#d8392b', '#f4f0e0', '#e3c84a'];
  k.solid.push([new THREE.BoxGeometry(1.7, 0.012, 1.1), '#f2ede0', L(b, M.trs(0, 0.006, 0, 0, 0.12, 0))]);
  k.solid.push([new THREE.CylinderGeometry(0.42, 0.42, 0.012, 20), '#7b4320', L(b, M.trs(0.15, 0.014, 0.08, 0, 0, 0, 1.3, 1, 0.8))]);
  // bottom roll (dipped dark) + top roll hinged open
  k.solid.push([new THREE.CapsuleGeometry(0.17, 0.85, 4, 12).rotateZ(Math.PI / 2), '#a8692c', L(b, M.trs(0, 0.1, 0, 0, 0, 0, 1, 0.55, 1))]);
  k.solid.push([new THREE.CapsuleGeometry(0.17, 0.85, 4, 12).rotateZ(Math.PI / 2), '#e6b56e', L(b, M.trs(0, 0.33, -0.17, -0.55, 0, 0, 1, 0.5, 1))]);
  // beef ribbons
  for (let i = 0; i < 12; i++) {
    k.solid.push([new THREE.BoxGeometry(0.92, 0.022, 0.26), i % 2 ? '#7a3b22' : '#8f4a2a', L(b, M.trs(rng.range(-0.04, 0.04), 0.17 + i * 0.012, rng.range(-0.04, 0.04), rng.range(-0.25, 0.25), rng.range(-0.15, 0.15), rng.range(-0.08, 0.08)))]);
  }
  // giardiniera on top and spilling on the paper
  for (let i = 0; i < 34; i++) {
    const top = i < 22;
    const px = top ? rng.range(-0.42, 0.42) : rng.range(-0.75, 0.75), pz = top ? rng.range(-0.1, 0.12) : rng.range(0.2, 0.5) * (rng.chance(0.5) ? 1 : -1);
    const py = top ? 0.33 + rng.range(0, 0.06) : 0.03;
    const sz = rng.range(0.045, 0.08);
    k.solid.push([i % 4 ? new THREE.BoxGeometry(sz, sz * 0.7, sz * 1.4) : new THREE.CylinderGeometry(sz * 0.7, sz * 0.7, sz * 0.5, 8), rng.pick(giard), L(b, M.trs(px, py, pz, rng.next() * 3, rng.next() * 3, rng.next() * 3))]);
  }
  // sport-pepper style hot peppers
  for (const px of [-0.3, 0.25]) k.solid.push([new THREE.ConeGeometry(0.035, 0.16, 6).rotateZ(Math.PI / 2), '#7cc24a', L(b, M.t(px, 0.4, 0.02))]);
  // dripping jus
  const N = 6;
  const drops = new THREE.InstancedMesh(k.bag.add(new THREE.SphereGeometry(0.035, 6, 4).scale(1, 1.5, 1)), k.bag.add(new THREE.MeshStandardMaterial({ color: '#6b3415', roughness: 0.25, metalness: 0.1 })), N);
  drops.frustumCulled = false;
  drops.castShadow = false;
  drops.name = 'beefDrips';
  k.group.add(drops);
  const dd = Array.from({ length: N }, (_, i) => ({ x: -0.4 + i * 0.16, z: i % 2 ? 0.14 : -0.14, ph: rng.next() }));
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  k.updaters.push((_dt, t) => {
    dd.forEach((d, i) => {
      const c = (t * 0.6 + d.ph) % 1;
      const hang = c < 0.5;
      const yy = hang ? 0.06 - c * 0.04 : Math.max(0.02, 0.04 - (c - 0.5) * (c - 0.5) * 4 * 0.12);
      v.set(d.x, yy, d.z).applyMatrix4(b);
      const sq = hang ? 0.6 + c : 1;
      m.compose(v, new THREE.Quaternion(), new THREE.Vector3(s * sq, s * (hang ? 1.4 : 1), s * sq));
      drops.setMatrixAt(i, m);
    });
    drops.instanceMatrix.needsUpdate = true;
  });
}

/**
 * Chicago-style hot dog "dragged through the garden" in a paper boat: poppy-seed bun, all-beef frank,
 * yellow mustard, neon-green relish, chopped onions, tomato wedges, a pickle spear, sport peppers and
 * a dash of celery salt (never ketchup). Bun ~1 long at s = 1, +X along the dog.
 */
export function chicagoHotDog(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, rng = new Rng(1893)): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  // paper boat
  k.solid.push([new THREE.BoxGeometry(1.3, 0.03, 0.56), '#f6f2e8', L(b, M.t(0, 0.015, 0))]);
  for (const sz of [-1, 1]) k.solid.push([new THREE.BoxGeometry(1.3, 0.07, 0.02), '#d0121f', L(b, M.trs(0, 0.045, sz * 0.29, sz * 0.5, 0, 0))]);
  for (const sx of [-1, 1]) k.solid.push([new THREE.BoxGeometry(0.02, 0.07, 0.56), '#f6f2e8', L(b, M.trs(sx * 0.66, 0.045, 0, 0, 0, -sx * 0.5))]);
  // bun halves + poppy seeds
  for (const bz of [-0.12, 0.12]) {
    k.solid.push([new THREE.CapsuleGeometry(0.11, 0.86, 4, 10).rotateZ(Math.PI / 2), '#e4b46e', L(b, M.trs(0, 0.13, bz, bz * 2.2, 0, 0, 1, 0.9, 1))]);
    for (let i = 0; i < 26; i++) k.solid.push([new THREE.BoxGeometry(0.012, 0.012, 0.012), '#22201e', L(b, M.t(rng.range(-0.48, 0.48), 0.23 + rng.range(-0.01, 0.01), bz + Math.sign(bz) * rng.range(0, 0.07)))]);
  }
  // frank
  k.solid.push([new THREE.CapsuleGeometry(0.075, 0.98, 4, 10).rotateZ(Math.PI / 2), '#b5432a', L(b, M.t(0, 0.17, 0))]);
  // yellow mustard zigzag
  for (let i = 0; i < 10; i++) beam(k.solid, [-0.45 + i * 0.09, 0.25, (i % 2 ? 1 : -1) * 0.04], [-0.36 + i * 0.09, 0.25, (i % 2 ? -1 : 1) * 0.04], 0.022, '#ffd400', b);
  // neon-green relish
  for (let i = 0; i < 18; i++) k.solid.push([new THREE.BoxGeometry(0.035, 0.025, 0.035), '#3ef02a', L(b, M.trs(rng.range(-0.42, 0.42), 0.255, rng.range(-0.05, 0.05), 0, rng.next() * 3, 0))]);
  // chopped onions
  for (let i = 0; i < 14; i++) k.solid.push([new THREE.BoxGeometry(0.025, 0.02, 0.025), '#fbf8ee', L(b, M.trs(rng.range(-0.42, 0.42), 0.262, rng.range(-0.05, 0.05), 0, rng.next() * 3, 0))]);
  // tomato wedges (one side), pickle spear (other side), sport peppers
  for (const tx of [-0.28, 0, 0.28]) k.solid.push([new THREE.CylinderGeometry(0.075, 0.075, 0.06, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), '#e8392b', L(b, M.trs(tx, 0.235, 0.085, 0, 0.25, 0))]);
  k.solid.push([new THREE.CapsuleGeometry(0.04, 0.8, 3, 8).rotateZ(Math.PI / 2), '#4f8f2a', L(b, M.trs(0, 0.22, -0.1, 0, 0, 0, 1, 0.7, 1))]);
  for (const px of [-0.35, -0.05, 0.3]) k.solid.push([new THREE.ConeGeometry(0.025, 0.11, 6).rotateZ(Math.PI / 2), '#8cc63f', L(b, M.trs(px, 0.28, rng.range(-0.03, 0.03), 0, rng.range(-0.4, 0.4), 0))]);
  // celery salt
  for (let i = 0; i < 30; i++) k.solid.push([new THREE.BoxGeometry(0.008, 0.008, 0.008), i % 2 ? '#8f9a6a' : '#cfc7a6', L(b, M.t(rng.range(-0.45, 0.45), 0.27, rng.range(-0.08, 0.08)))]);
}

/**
 * Chicago-mix popcorn tin (cheese + caramel) with a skyline label wrapped round it and the lid
 * leaning against it. Radius ~1, height ~1.25 at s = 1.
 */
export function popcornTin(k: Kit, x: number, y: number, z: number, rot = 0, s = 1, rng = new Rng(606)): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const label = k.paint.draw(768, 192, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#1d4f9c');
    grd.addColorStop(1, '#0d2d63');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    const r = new Rng(77);
    for (let rep = 0; rep < 2; rep++) {
      drawChicagoSkyline(g, rep * (w / 2), h * 0.98, w / 2, h * 0.5, r, { tones: ['#2b62b8', '#3a74cc', '#2457a6'], dark: '#0a1d42', glass: '#4f8fe0', windows: 'rgba(255,230,140,0.55)' });
      drawText(g, rep ? 'CHEESE + CARAMEL' : 'CHICAGO MIX', w / 2, h * 0.42, { fg: '#ffd23f', stroke: '#0a1d42' });
      g.translate(w / 2, 0);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#ffd23f';
    g.fillRect(0, 0, w, 6);
    g.fillRect(0, h - 6, w, 6);
  }, 'popcornTinLabel');
  k.paint.mapped(label, new THREE.CylinderGeometry(1, 1, 1.25, 32, 1, true), L(b, M.t(0, 0.625, 0)));
  k.gloss.push([new THREE.CylinderGeometry(1, 1, 0.04, 32), '#c9ced6', L(b, M.t(0, 0.02, 0))]);
  k.gloss.push([new THREE.TorusGeometry(1.0, 0.03, 4, 32).rotateX(Math.PI / 2), '#e3c35a', L(b, M.t(0, 1.25, 0))]);
  // the lid leaning against the tin
  const lidN = new THREE.Vector3(Math.sin(1.3), Math.cos(1.3), 0);
  const lidC = new THREE.Vector3(1.32, 1.02, 0.25);
  k.gloss.push([new THREE.CylinderGeometry(1.04, 1.04, 0.12, 32), '#1d4f9c', L(b, M.trs(lidC.x, lidC.y, lidC.z, 0, 0, -1.3))]);
  const lidTop = k.paint.draw(240, 240, (g, w, h) => {
    g.fillStyle = '#1d4f9c';
    g.fillRect(0, 0, w, h);
    drawChicagoFlag(g, w * 0.12, h * 0.3, w * 0.76, h * 0.4);
  }, 'popcornLid');
  const lidQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), lidN).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2));
  k.paint.mapped(lidTop, new THREE.CircleGeometry(0.98, 28), L(b, new THREE.Matrix4().compose(lidC.clone().addScaledVector(lidN, 0.065), lidQ, new THREE.Vector3(1, 1, 1))));
  // heap: cheese half and caramel half
  for (let i = 0; i < 90; i++) {
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * 0.92;
    const px = Math.cos(a) * r, pz = Math.sin(a) * r;
    const py = 1.18 + (1 - r) * 0.35 + rng.range(-0.05, 0.08);
    const col = px < 0 ? rng.pick(['#f29a1e', '#f7b23a', '#e98a12']) : rng.pick(['#c98a2e', '#b8761f', '#d9a24a']);
    k.solid.push([new THREE.IcosahedronGeometry(rng.range(0.08, 0.12), 0), col, L(b, M.trs(px, py, pz, rng.next() * 3, rng.next() * 3, 0))]);
  }
  // a few kernels spilled
  for (let i = 0; i < 10; i++) k.solid.push([new THREE.IcosahedronGeometry(0.09, 0), i % 2 ? '#f29a1e' : '#c98a2e', L(b, M.t(rng.range(-1.6, 1.6), 0.08, rng.range(1.1, 1.8)))]);
}

/**
 * Dogs of mixed breeds running laps / figure-eights around the given spots (one instanced draw call
 * per breed, trotting legs and wagging tails in the shader). `height` = ground height lookup.
 */
export function runningDogs(
  k: Kit, height: (x: number, z: number) => number, spots: Array<{ x: number; z: number }>,
  o: { breeds?: DogBreed[]; scale?: [number, number]; r?: [number, number]; seed?: number } = {},
): void {
  if (!spots.length) return;
  const rng = new Rng(o.seed ?? 2024);
  const breeds = o.breeds ?? ['lab', 'doodle', 'dachshund', 'husky', 'corgi'];
  const coat: Record<DogBreed, string[]> = {
    lab: ['#e8c27a', '#2a2a2a', '#6b4424'], doodle: ['#f3e3c3', '#d9a066', '#fffaf0'], dachshund: ['#8a4a22', '#3a2416'],
    husky: ['#8a8f99', '#4a4f57', '#c9ccd2'], corgi: ['#e08a3c', '#c96f2a'],
  };
  const [s0, s1] = o.scale ?? [0.6, 0.8];
  const [r0, r1] = o.r ?? [3, 7];
  const dogs = spots.map((p, i) => ({ breed: breeds[i % breeds.length], x: p.x, z: p.z, r: rng.range(r0, r1), w: rng.range(0.7, 1.3) * (rng.chance(0.5) ? 1 : -1), ph: rng.next() * 6, s: rng.range(s0, s1), eight: rng.chance(0.4) }));
  const mat = dogMat(k.bag, k.time);
  const sets: Array<{ im: THREE.InstancedMesh; list: typeof dogs }> = [];
  for (const br of breeds) {
    const list = dogs.filter((d) => d.breed === br);
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(k.bag.add(dogGeo(br)), mat, list.length);
    list.forEach((_, i) => im.setColorAt(i, new THREE.Color(rng.pick(coat[br]))));
    im.frustumCulled = false;
    im.castShadow = k.q === 'high';
    im.name = `runningDogs-${br}`;
    k.group.add(im);
    sets.push({ im, list });
  }
  k.updaters.push((_dt, t) => {
    for (const { im, list } of sets) {
      list.forEach((d, i) => {
        const a = t * d.w + d.ph;
        const x = d.x + Math.cos(a) * d.r, z = d.z + (d.eight ? Math.sin(2 * a) * 0.5 : Math.sin(a)) * d.r;
        const dx = -Math.sin(a) * d.w, dz = (d.eight ? Math.cos(2 * a) : Math.cos(a)) * d.w;
        setInstance(im, i, x, height(x, z) + Math.abs(Math.sin(t * 9 + d.ph)) * 0.2, z, 0, Math.atan2(dx, dz), 0, d.s);
      });
      im.instanceMatrix.needsUpdate = true;
    }
  });
}

/** Diamond kites (Chicago colors on the tails) bobbing on the lake breeze above the given spots. */
export function kites(k: Kit, spots: Array<{ x: number; z: number; h: number }>, seed = 99): void {
  if (!spots.length) return;
  const rng = new Rng(seed);
  const geo = k.bag.add(mergeColored([
    [new THREE.OctahedronGeometry(1.6, 0), '#ffffff', M.trs(0, 0, 0, 0, 0, 0, 1, 1.4, 0.08)],
    [new THREE.BoxGeometry(0.05, 6, 0.05), '#f4f4f4', M.t(0, -4.2, 0)],
    ...[0, 1, 2, 3].map((i) => [new THREE.BoxGeometry(0.5, 0.25, 0.05), i % 2 ? CHI_RED : CHI_BLUE, M.trs(0, -2.6 - i * 1.2, 0, 0, 0, 0.5)] as [THREE.BufferGeometry, string, THREE.Matrix4]),
  ]));
  const im = new THREE.InstancedMesh(geo, k.tintMat, spots.length);
  const cols = [CHI_RED, CHI_BLUE, '#ffd23f', '#3ccf6e', '#ff8a3d'];
  const kd = spots.map((s) => ({ ...s, ph: rng.next() * 6 }));
  kd.forEach((_, i) => im.setColorAt(i, new THREE.Color(cols[i % cols.length])));
  im.frustumCulled = false;
  im.castShadow = false;
  im.name = 'kites';
  k.group.add(im);
  k.updaters.push((_dt, t) => {
    kd.forEach((q, i) => setInstance(im, i, q.x + Math.sin(t * 0.7 + q.ph) * 4, q.h + Math.sin(t * 1.1 + q.ph) * 2, q.z + Math.cos(t * 0.5 + q.ph) * 5, 0, Math.PI / 2 + Math.sin(t * 0.9 + q.ph) * 0.3, Math.sin(t * 1.7 + q.ph) * 0.35, 1));
    im.instanceMatrix.needsUpdate = true;
  });
}

/** Glass jar of hot giardiniera (veg mosaic under the glass, CHICAGO STYLE label). Radius ~1, height ~2.2 at s = 1. */
export function giardinieraJar(k: Kit, x: number, y: number, z: number, rot = 0, s = 1): void {
  const b = M.trs(x, y, z, 0, rot, 0, s);
  const side = k.paint.draw(768, 192, (g, w, h) => {
    const r = new Rng(19);
    g.fillStyle = '#c9c46a';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 520; i++) {
      g.fillStyle = r.pick(['#f28c1c', '#9ccc4a', '#3e9c35', '#d8392b', '#f4f0e0', '#e3c84a', '#6aa23a']);
      g.save();
      g.translate(r.next() * w, r.next() * h);
      g.rotate(r.next() * 3);
      g.fillRect(-r.range(4, 12), -r.range(3, 7), r.range(8, 24), r.range(6, 14));
      g.restore();
    }
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(w * 0.05, 0, w * 0.04, h);
    for (const lx of [w * 0.1, w * 0.6]) {
      g.fillStyle = '#fff8e6';
      g.fillRect(lx, h * 0.3, w * 0.3, h * 0.46);
      g.strokeStyle = CHI_RED;
      g.lineWidth = 6;
      g.strokeRect(lx + 6, h * 0.3 + 6, w * 0.3 - 12, h * 0.46 - 12);
      g.save();
      g.translate(lx, h * 0.31);
      drawText(g, 'HOT\nGIARDINIERA', w * 0.3, h * 0.3, { fg: '#1f6b3a' });
      g.translate(0, h * 0.29);
      drawText(g, 'CHICAGO STYLE', w * 0.3, h * 0.12, { fg: CHI_RED });
      g.restore();
    }
  }, 'giardJar');
  k.paint.mapped(side, new THREE.CylinderGeometry(1, 1, 2, 32, 1, true), L(b, M.t(0, 1, 0)));
  k.solid.push([new THREE.CylinderGeometry(1, 1, 0.04, 32), '#b9b46a', L(b, M.t(0, 0.02, 0))]);
  k.gloss.push([new THREE.CylinderGeometry(0.86, 0.9, 0.3, 32), '#d9b23a', L(b, M.t(0, 2.15, 0))]);
  k.gloss.push([new THREE.CylinderGeometry(0.92, 0.92, 0.1, 32), '#e6c24a', L(b, M.t(0, 2.0, 0))]);
}

/** "Greetings from Chicago" postcard-style poster: skyline over the lake, sailboats, flag. */
export function drawGreetingsPoster(g: CanvasRenderingContext2D, w: number, h: number): void {
  const r = new Rng(1837);
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#ff9a6b');
  sky.addColorStop(1, '#ffe2a8');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffd25a';
  g.beginPath();
  g.arc(w * 0.78, h * 0.38, h * 0.12, 0, Math.PI * 2);
  g.fill();
  drawChicagoSkyline(g, 0, h * 0.62, w, h * 0.42, r, { tones: ['#5b3f6a', '#6b4a78', '#7a5886'], dark: '#2a1c36', glass: '#8a6aa0', windows: 'rgba(255,220,150,0.5)' });
  const lake = g.createLinearGradient(0, h * 0.62, 0, h);
  lake.addColorStop(0, '#2f8fd8');
  lake.addColorStop(1, '#14508f');
  g.fillStyle = lake;
  g.fillRect(0, h * 0.62, w, h * 0.38);
  for (let i = 0; i < 4; i++) {
    const sx = w * (0.12 + i * 0.22), sy = h * (0.74 + (i % 2) * 0.08);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx, sy - 34);
    g.lineTo(sx + 22, sy);
    g.fill();
    g.fillStyle = '#7a3b22';
    g.fillRect(sx - 12, sy, 36, 6);
  }
  g.save();
  g.translate(0, h * 0.04);
  drawText(g, 'GREETINGS FROM', w, h * 0.12, { fg: '#ffffff', stroke: '#14315e' });
  g.translate(0, h * 0.1);
  drawText(g, 'CHICAGO', w, h * 0.2, { fg: CHI_RED, stroke: '#ffffff' });
  g.restore();
  drawChicagoFlag(g, w * 0.04, h * 0.84, w * 0.18, h * 0.12);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 10;
  g.strokeRect(5, 5, w - 10, h - 10);
}

import * as THREE from 'three';
import { mod } from '../../core/math';
import { RAMP_HEIGHT, type Track, type TrackPath, type TrackSample } from '../../sim/track/Track';
import type { SurfaceType, TrackTheme } from '../../sim/types';
import { getField, type TrackField } from '../scenery/field';
import {
  brickTexture, canvasTexture, checkerTexture, chevronTexture, grassTexture, noiseTexture, roadTexture, textTexture,
  type RoadTexOpts,
} from '../scenery/textures';
import { sunOffsetFor } from '../Environment';
import { createWaterMaterial, WATER_COLORS, type WaterMaterial } from '../Water';

export type Quality = 'low' | 'medium' | 'high';

export interface TrackViewHandle {
  group: THREE.Group;
  update(dt: number, time: number): void;
  dispose(): void;
  /** Toggle checkpoint / racing-line / centerline debug overlays. */
  showDebug?(on: boolean): void;
  /** Spatial helper (terrain height, corridor clearance) shared with scenery. */
  field: TrackField;
}

/* ------------------------------------------------------------------ geometry builder */

class GB {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] | null = null;
  idx: number[] = [];
  vert(x: number, y: number, z: number, u: number, v: number, c?: THREE.Color): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    if (c) {
      if (!this.col) this.col = [];
      this.col.push(c.r, c.g, c.b);
    }
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number): void {
    // a-b along the left edge, c-d along the right edge: (a,b,d) (a,d,c)
    this.idx.push(a, c, b, b, c, d);
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ theme styles */

interface WallProfile {
  kind: 'profile';
  /** [lateral offset outward from wall line, height] from road side to outside */
  profile: Array<[number, number]>;
  tex: () => THREE.Texture;
  texLen: number;
  rough: number;
}
interface WallStrip {
  kind: 'strip';
  height: number;
  tex: () => THREE.Texture;
  texLen: number;
}

interface Style {
  road: RoadTexOpts;
  /** Road texture for shortcut corridors (defaults to the main road). */
  scRoad?: RoadTexOpts;
  roadTile: number;
  roadRough: number;
  shoulder: () => THREE.Texture;
  shoulderTile: number;
  shoulderRough: number;
  curb: [string, string];
  wall: WallProfile | WallStrip;
  wallOffset: number;
  terrain: (ground: string) => THREE.Texture;
  terrainTile: number;
  water: string | null;
  waterLight: string;
  waterY: number;
  skirt: () => THREE.Texture;
  accent: string;
  accent2: string;
  rampColors: [string, string];
  /** Terrain is a finite slab (kitchen counter) instead of endless ground. */
  slab: boolean;
}

const jerseyTex = () =>
  canvasTexture(256, 64, (g, w, h, rng) => {
    // two 3m panels per tile: red, white
    for (let i = 0; i < 2; i++) {
      g.fillStyle = i ? '#f4f4f0' : '#e2312b';
      g.fillRect((i * w) / 2, 0, w / 2, h);
    }
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, h * 0.82, w, h * 0.18);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, 0, w, h * 0.08);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(w / 2 - 1, 0, 2, h);
    g.fillRect(w - 2, 0, 2, h);
    for (let i = 0; i < 300; i++) {
      g.fillStyle = `rgba(0,0,0,${rng.range(0.02, 0.08)})`;
      g.fillRect(rng.next() * w, rng.next() * h, 2, 2);
    }
  });

const hedgeTex = () =>
  canvasTexture(128, 128, (g, w, h, rng) => {
    g.fillStyle = '#3f7d2e';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rng.pick(['#2f6a22', '#4f9638', '#5aa543', '#356f27', '#6cb44f']);
      g.beginPath();
      g.ellipse(rng.next() * w, rng.next() * h, rng.range(2, 5), rng.range(1.5, 3.5), rng.next() * 3, 0, Math.PI * 2);
      g.fill();
    }
  });

const rulerTex = () =>
  canvasTexture(512, 64, (g, w, h) => {
    g.fillStyle = '#ffd23f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#2a2a2a';
    for (let i = 0; i <= 40; i++) {
      const x = (i / 40) * w;
      const len = i % 10 === 0 ? 0.5 : i % 5 === 0 ? 0.35 : 0.2;
      g.fillRect(x, h * 0.12, 2, h * len);
    }
    g.font = 'bold 18px Arial';
    for (let i = 0; i < 4; i++) g.fillText(String(i + 1), (i / 4) * w + 6, h * 0.86);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, h - 4, w, 4);
    g.fillRect(0, 0, w, 3);
  });

const fenceTex = () =>
  canvasTexture(256, 128, (g, w, h, rng) => {
    g.clearRect(0, 0, w, h);
    const wood = (x: number, y: number, ww: number, hh: number) => {
      g.fillStyle = rng.pick(['#a8733f', '#b98249', '#9a6634']);
      g.fillRect(x, y, ww, hh);
      g.fillStyle = 'rgba(60,30,10,0.35)';
      for (let i = 0; i < 4; i++) g.fillRect(x + rng.next() * ww, y, 1, hh);
    };
    wood(0, 4, 18, h - 4);
    wood(w / 2, 4, 18, h - 4);
    wood(0, h * 0.2, w, 16);
    wood(0, h * 0.58, w, 16);
    g.fillStyle = '#fff';
    g.fillRect(2, 0, 14, 6);
    g.fillRect(w / 2 + 2, 0, 14, 6);
  });

const snowbankTex = () =>
  canvasTexture(128, 128, (g, w, h, rng) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#c5d4ea');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = rng.chance(0.6) ? 'rgba(160,185,220,0.35)' : 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.arc(rng.next() * w, rng.next() * h, rng.range(1, 4), 0, Math.PI * 2);
      g.fill();
    }
    // dirty slush at the bottom
    g.fillStyle = 'rgba(110,110,120,0.3)';
    g.fillRect(0, h * 0.9, w, h * 0.1);
  });

const shoulderStripes = (a: string, b: string, edge?: string) => () =>
  canvasTexture(128, 128, (g, w, h, rng) => {
    g.fillStyle = a;
    g.fillRect(0, 0, w, h / 2);
    g.fillStyle = b;
    g.fillRect(0, h / 2, w, h / 2);
    for (let i = 0; i < 1600; i++) {
      g.fillStyle = rng.chance(0.5) ? 'rgba(0,40,0,0.18)' : 'rgba(255,255,200,0.12)';
      g.fillRect(rng.next() * w, rng.next() * h, 1, rng.range(2, 4));
    }
    if (edge) {
      g.fillStyle = edge;
      g.fillRect(0, 0, w * 0.07, h);
    }
  });

const STYLES: Record<TrackTheme, Style> = {
  chicago: {
    road: { base: '#666970', speck: ['#4a4c52', '#7b7e86', '#8a8478', '#55575d'], edge: '#ffffff', center: '#ffffff', patches: ['#45474d', '#66686e'] },
    roadTile: 16, roadRough: 0.88,
    shoulder: shoulderStripes('#6cc04f', '#5fb045', '#d8d4c8'), shoulderTile: 8, shoulderRough: 0.95,
    curb: ['#e3262b', '#f7f7f7'],
    wall: { kind: 'profile', profile: [[0, 0], [0.12, 0.3], [0.3, 0.75], [0.34, 1.15], [0.66, 1.15], [0.7, 0.75], [0.88, 0.3], [1.0, 0]], tex: jerseyTex, texLen: 6, rough: 0.7 },
    wallOffset: 0.2,
    terrain: (c) => grassTexture(c, '#4c9a3b', '#7cc65a', 3),
    terrainTile: 14,
    water: '#2c8f8c', waterLight: '#8fe0d6', waterY: -2.2,
    skirt: () => noiseTexture('#9b9a95', ['#7d7c78', '#b3b2ad'], 4),
    accent: '#e3262b', accent2: '#1f4fbf', rampColors: ['#ffcc00', '#222222'],
    slab: false,
  },
  neighborhood: {
    road: { base: '#4e5157', speck: ['#3a3c40', '#62656b', '#6e6a62'], edge: null, center: '#f2c94c', patches: ['#3a3c41', '#2f3135', '#5f6168'] },
    scRoad: { base: '#b3afa6', speck: ['#9a968e', '#c9c5bc', '#8a867e'], edge: null, center: null, patches: ['#a29e95', '#c2beb5'], lanes: 0 },
    roadTile: 16, roadRough: 0.9,
    shoulder: () =>
      canvasTexture(128, 128, (g, w, h, rng) => {
        g.fillStyle = '#c9c6bd';
        g.fillRect(0, 0, w * 0.08, h); // curb
        g.fillStyle = '#62b04a';
        g.fillRect(w * 0.08, 0, w * 0.42, h); // parkway
        for (let i = 0; i < 700; i++) {
          g.fillStyle = rng.chance(0.5) ? 'rgba(0,50,0,0.2)' : 'rgba(255,255,180,0.15)';
          g.fillRect(w * 0.08 + rng.next() * w * 0.42, rng.next() * h, 1, 3);
        }
        g.fillStyle = '#d9d5cb';
        g.fillRect(w * 0.5, 0, w * 0.42, h); // sidewalk
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(w * 0.5, 0, w * 0.42, 2);
        g.fillRect(w * 0.5, h / 2, w * 0.42, 2);
        g.fillStyle = '#5aa843';
        g.fillRect(w * 0.92, 0, w * 0.08, h);
      }),
    shoulderTile: 4, shoulderRough: 0.95,
    curb: ['#e3262b', '#f7f7f7'],
    wall: { kind: 'profile', profile: [[0, 0], [0.05, 1.0], [0.25, 1.45], [0.95, 1.45], [1.15, 1.0], [1.2, 0]], tex: hedgeTex, texLen: 4, rough: 1 },
    wallOffset: 0.2,
    terrain: (c) => grassTexture(c, '#4f9a3c', '#86cc63', 5, ['#ffffff', '#ffe066']),
    terrainTile: 12,
    water: '#3b8fc4', waterLight: '#a6dcf5', waterY: -1.6,
    skirt: () => noiseTexture('#a7a59f', ['#8a8883', '#c0beb8'], 4),
    accent: '#2f6fd6', accent2: '#ffcc33', rampColors: ['#ffcc00', '#222222'],
    slab: false,
  },
  kitchen: {
    road: { base: '#ffffff', speck: [], edge: '#2f6fd6', center: '#e8443a', style: 'placemat' },
    roadTile: 12, roadRough: 0.8,
    shoulder: () =>
      canvasTexture(128, 128, (g, w, h, rng) => {
        // butcher block
        for (let x = 0; x < w; x += 16) {
          const c = new THREE.Color('#d9a066');
          c.offsetHSL(0, 0, rng.range(-0.08, 0.06));
          g.fillStyle = `#${c.getHexString()}`;
          g.fillRect(x, 0, 16, h);
          g.fillStyle = 'rgba(90,50,20,0.25)';
          g.fillRect(x, 0, 1, h);
          for (let i = 0; i < 6; i++) g.fillRect(x + rng.next() * 16, rng.next() * h, 1, rng.range(10, 40));
        }
      }),
    shoulderTile: 6, shoulderRough: 0.7,
    curb: ['#ff5fa2', '#ffffff'],
    wall: { kind: 'profile', profile: [[0, 0], [0, 1.6], [0.45, 1.6], [0.45, 0]], tex: rulerTex, texLen: 12, rough: 0.5 },
    wallOffset: 0.2,
    terrain: () =>
      canvasTexture(512, 512, (g, w, h, rng) => {
        g.fillStyle = '#f3f0ea';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(120,120,135,0.14)';
        for (let i = 0; i < 14; i++) {
          g.lineWidth = rng.range(0.6, 2.2);
          g.beginPath();
          let x = rng.next() * w, y = rng.next() * h;
          g.moveTo(x, y);
          for (let k = 0; k < 12; k++) {
            x += rng.range(-30, 50);
            y += rng.range(-20, 30);
            g.lineTo(x, y);
          }
          g.stroke();
        }
        for (let i = 0; i < 3000; i++) {
          g.fillStyle = `rgba(100,100,110,${rng.range(0.03, 0.12)})`;
          g.fillRect(rng.next() * w, rng.next() * h, 2, 2);
        }
      }),
    terrainTile: 40,
    water: null, waterLight: '#fff', waterY: -60,
    skirt: () =>
      canvasTexture(128, 256, (g, w, h) => {
        g.fillStyle = '#7fb3d9';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = '#5d8fb8';
        g.lineWidth = 6;
        g.strokeRect(10, 14, w - 20, h - 28);
        g.fillStyle = '#c9a227';
        g.fillRect(w / 2 - 14, 30, 28, 8);
      }),
    accent: '#ff5fa2', accent2: '#2f6fd6', rampColors: ['#ff8a3d', '#ffe5c4'],
    slab: true,
  },
  dogpark: {
    road: { base: '#c08f5a', speck: ['#9c6e40', '#d6a873', '#8a5e34', '#e0bb8a'], edge: null, center: null, patches: ['#a8764a', '#d2a06a'], style: 'dirt', edgeInset: 0.04 },
    scRoad: { base: '#6e4826', speck: ['#4f3218', '#8a5e34', '#3e2610'], edge: null, center: null, patches: ['#5a3a1e', '#7d5530'], style: 'dirt', edgeInset: 0.06 },
    roadTile: 14, roadRough: 1,
    shoulder: shoulderStripes('#7cc35a', '#6db54d'), shoulderTile: 8, shoulderRough: 1,
    curb: ['#f28c28', '#fff4e0'],
    wall: { kind: 'strip', height: 1.6, tex: fenceTex, texLen: 5 },
    wallOffset: 0.3,
    terrain: (c) => grassTexture(c, '#58a83c', '#8fd06a', 8, ['#ffffff', '#ffe14d', '#ff8fc0', '#b48cff']),
    terrainTile: 12,
    water: '#3aa6dc', waterLight: '#b8ecff', waterY: -1.8,
    skirt: () => brickTexture('#9a6a3a', '#5a3a1e', 13),
    accent: '#ff7a1a', accent2: '#2fa84f', rampColors: ['#c98a4b', '#8a5a2b'],
    slab: false,
  },
  snow: {
    road: { base: '#c3ccd8', speck: ['#a9b4c4', '#e2e8f0', '#9aa6b6'], edge: null, center: null, patches: ['#b3bdcb', '#dfe6ef'], style: 'snow' },
    scRoad: { base: '#cfe8f7', speck: ['#ffffff', '#b5d6ec', '#e6f4fc'], edge: null, center: null, patches: ['#bfe0f3', '#eaf6fd'] },
    roadTile: 14, roadRough: 0.75,
    shoulder: shoulderStripes('#f4f8fd', '#e8eff8'), shoulderTile: 10, shoulderRough: 0.9,
    curb: ['#e3262b', '#ffffff'],
    wall: { kind: 'profile', profile: [[-0.2, 0], [0.05, 0.8], [0.5, 1.45], [1.1, 1.75], [1.9, 1.65], [2.6, 1.05], [3.2, 0.1]], tex: snowbankTex, texLen: 6, rough: 0.85 },
    wallOffset: 0.1,
    terrain: () => noiseTexture('#eef3f9', ['#d3deeb', '#ffffff', '#c7d4e6'], 15, ['#dbe5f1', '#ffffff']),
    terrainTile: 16,
    water: '#9cc9e3', waterLight: '#ffffff', waterY: -1.5,
    skirt: () => noiseTexture('#8e95a0', ['#737a85', '#a8afb9'], 4),
    accent: '#d7263d', accent2: '#1f8a4c', rampColors: ['#ffffff', '#d7263d'],
    slab: false,
  },
};

/* ------------------------------------------------------------------ surface textures */

function surfaceTexture(type: SurfaceType): THREE.Texture {
  return canvasTexture(128, 256, (g, w, h, rng) => {
    g.clearRect(0, 0, w, h);
    const base = type === 'ice' ? '#d8f2ff' : type === 'mud' ? '#6b4423' : type === 'milk' ? '#fffdf6' : '#a8865a';
    // blobby puddle mask across u, repeating along v
    g.fillStyle = base;
    for (let i = 0; i < 26; i++) {
      const y = (i / 26) * h;
      const r = rng.range(w * 0.28, w * 0.46);
      g.beginPath();
      g.ellipse(w / 2 + rng.range(-8, 8), y, r, rng.range(14, 26), 0, 0, Math.PI * 2);
      g.fill();
      if (i === 0) {
        g.beginPath();
        g.ellipse(w / 2, y + h, r, 20, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (type === 'ice') {
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 1.5;
      for (let i = 0; i < 14; i++) {
        let x = rng.range(w * 0.2, w * 0.8), y = rng.next() * h;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          x += rng.range(-14, 14);
          y += rng.range(-16, 16);
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.fillStyle = 'rgba(140,200,255,0.35)';
      for (let i = 0; i < 20; i++) g.fillRect(rng.range(w * 0.2, w * 0.8), rng.next() * h, rng.range(4, 20), 2);
    } else if (type === 'mud') {
      for (let i = 0; i < 60; i++) {
        g.fillStyle = rng.pick(['rgba(40,25,10,0.5)', 'rgba(140,95,55,0.5)', 'rgba(90,60,30,0.6)']);
        g.beginPath();
        g.ellipse(rng.range(w * 0.2, w * 0.8), rng.next() * h, rng.range(3, 12), rng.range(2, 7), 0, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(255,255,255,0.25)';
      for (let i = 0; i < 25; i++) g.fillRect(rng.range(w * 0.25, w * 0.75), rng.next() * h, rng.range(3, 8), 1.5);
    } else if (type === 'milk') {
      g.fillStyle = 'rgba(210,225,255,0.5)';
      for (let i = 0; i < 18; i++) {
        g.beginPath();
        g.ellipse(rng.range(w * 0.25, w * 0.75), rng.next() * h, rng.range(6, 16), rng.range(3, 8), 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
}

const TABLE_TINT = new THREE.Color('#d9a066');

/* ------------------------------------------------------------------ material helpers */

/**
 * Cheap "baked" shading via onBeforeCompile: `shade` is GLSL that returns a brightness multiplier
 * from the mesh's raw uv (`aoUv`), e.g. darkening the shoulder where it meets the wall.
 */
function withUvShade<T extends THREE.MeshStandardMaterial>(mat: T, key: string, shade: string): T {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 aoUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\naoUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 aoUv;\nfloat uvShade(){ ${shade} }`)
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= uvShade();');
  };
  mat.customProgramCacheKey = () => `uvshade-${key}`;
  return mat;
}

/**
 * Derive a detail map from the road's colour canvas: R = height (speckle luminance, for a subtle
 * bump), G = roughness (painted lines glossier than the asphalt, slight per-speck variation).
 */
function roadDetailTexture(src: THREE.Texture, baseColor: string, baseRough: number): THREE.Texture | null {
  const img = src.image as HTMLCanvasElement | undefined;
  if (!img || typeof document === 'undefined' || !(img instanceof HTMLCanvasElement)) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  const b = new THREE.Color(baseColor);
  const baseLum = (b.r + b.g + b.b) / 3;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 765;
    const paint = lum > Math.min(0.97, baseLum + 0.22) && Math.max(d[i], d[i + 1]) > 180;
    const n = ((i * 2654435761) >>> 0) / 4294967296;
    const rough = paint ? 0.38 : Math.min(1, baseRough * (0.86 + 0.24 * n) + (lum - baseLum) * 0.4);
    d[i] = Math.round(lum * 255);
    d[i + 1] = Math.round(Math.max(0.05, rough) * 255);
    d[i + 2] = 0;
  }
  g.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = src.wrapS;
  t.wrapT = src.wrapT;
  t.repeat.copy(src.repeat);
  t.anisotropy = 8;
  return t;
}

/* ------------------------------------------------------------------ build */

export function buildTrackView(track: Track, quality: Quality): TrackViewHandle {
  const def = track.def;
  const style = STYLES[def.theme];
  const field = getField(track);
  const group = new THREE.Group();
  group.name = 'trackView';
  const disposables: Array<{ dispose(): void }> = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const shoulder = def.shoulder;
  const wallDistOf = (smp: TrackSample) => smp.halfWidth + shoulder;
  const animated: Array<(dt: number, time: number) => void> = [];

  const addMesh = (gb: GB, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean; name?: string; order?: number } = {}) => {
    if (gb.empty) return null;
    const geo = own(gb.build());
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = !!opts.cast;
    m.receiveShadow = opts.receive ?? true;
    if (opts.name) m.name = opts.name;
    if (opts.order !== undefined) m.renderOrder = opts.order;
    group.add(m);
    return m;
  };

  const tex = (t: THREE.Texture) => own(t);

  /* ---------- road, shoulders */
  const roadTex = tex(roadTexture(style.road, 7 + def.id.length));
  const roadMat = own(new THREE.MeshStandardMaterial({ map: roadTex, roughness: style.roadRough, metalness: 0 }));
  if (quality !== 'low') {
    const detail = roadDetailTexture(roadTex, style.road.base, style.roadRough);
    if (detail) {
      own(detail);
      roadMat.roughnessMap = detail;
      roadMat.roughness = 1;
      if (quality === 'high') {
        roadMat.bumpMap = detail;
        roadMat.bumpScale = 0.9;
      }
    }
  }
  // slightly darker road edges (where the road meets curbs / shoulder)
  withUvShade(roadMat, 'road', 'return mix(0.84, 1.0, smoothstep(0.0, 0.045, aoUv.x) * smoothstep(1.0, 0.955, aoUv.x));');
  const shoulderMat = own(new THREE.MeshStandardMaterial({ map: tex(style.shoulder()), roughness: style.shoulderRough }));
  // contact shadow at the foot of the walls (shoulder u = 0 at the road edge, 1 under the wall)
  withUvShade(shoulderMat, 'shoulder', 'return mix(1.0, 0.58, smoothstep(0.8, 1.0, aoUv.x));');
  const roadGB = new GB();
  const scRoadGB = new GB();
  const scRoadMat = style.scRoad
    ? own(new THREE.MeshStandardMaterial({ map: tex(roadTexture(style.scRoad, 19)), roughness: def.theme === 'snow' ? 0.15 : style.roadRough, metalness: def.theme === 'snow' ? 0.2 : 0 }))
    : roadMat;
  const shoulderGB = new GB();

  // indices of a path's sample sequence including the wrap for closed paths
  const seq = (p: TrackPath): number[] => {
    const n = p.samples.length;
    const out = Array.from({ length: n }, (_, i) => i);
    if (p.closed) out.push(0);
    return out;
  };
  // s for sequence entry (wrap => path length)
  const sOf = (p: TrackPath, k: number, i: number) => (p.closed && k === p.samples.length ? p.length : p.samples[i].s);

  const ribbon = (gb: GB, p: TrackPath, latA: (s: TrackSample) => number, latB: (s: TrackSample) => number, yOff: number, tile: number, keep: (i: number) => boolean) => {
    const sq = seq(p);
    let prevL = -1, prevR = -1, prevKeep = false;
    for (let k = 0; k < sq.length; k++) {
      const i = sq[k];
      const smp = p.samples[i];
      const ok = keep(i);
      if (!ok) {
        prevKeep = false;
        continue;
      }
      const v = sOf(p, k, i) / tile;
      const a = latA(smp), b = latB(smp);
      const L = gb.vert(smp.x + smp.nx * a, smp.y + yOff, smp.z + smp.nz * a, 0, v);
      const R = gb.vert(smp.x + smp.nx * b, smp.y + yOff, smp.z + smp.nz * b, 1, v);
      if (prevKeep) gb.quad(prevL, L, prevR, R);
      prevL = L;
      prevR = R;
      prevKeep = true;
    }
  };

  for (const p of track.paths) {
    const isMain = p.id === 0;
    const L = p.length;
    const tile = p.closed ? L / Math.max(1, Math.round(L / style.roadTile)) : style.roadTile;
    const notGap = (i: number) => {
      const smp = p.samples[i];
      return !smp.gap;
    };
    // a segment exists if both ends are not gap; we approximate by dropping gap samples
    ribbon(isMain ? roadGB : scRoadGB, p, (s) => -s.halfWidth, (s) => s.halfWidth, isMain ? 0.05 : 0.025, tile, notGap);
    const stile = style.shoulderTile;
    const leftStart = shoulderGB.uv.length;
    ribbon(shoulderGB, p, (s) => -wallDistOf(s) - 0.3, (s) => -s.halfWidth + 0.01, isMain ? 0.0 : -0.02, stile, notGap);
    // right shoulder: mirror u so the texture's u=0 sits at the road edge
    const before = shoulderGB.uv.length;
    ribbon(shoulderGB, p, (s) => s.halfWidth - 0.01, (s) => wallDistOf(s) + 0.3, isMain ? 0.0 : -0.02, stile, notGap);
    // left strip: u=0 at the wall, flip so u=0 is at the road edge
    for (let j = leftStart; j < before; j += 2) shoulderGB.uv[j] = 1 - shoulderGB.uv[j];
  }
  addMesh(roadGB, roadMat, { name: 'road' });
  addMesh(scRoadGB, scRoadMat, { name: 'shortcutRoad' });
  addMesh(shoulderGB, shoulderMat, { name: 'shoulder' });

  /* ---------- curbs on corners */
  const curbTex = tex(canvasTexture(32, 64, (g, w, h) => {
    g.fillStyle = style.curb[0];
    g.fillRect(0, 0, w, h / 2);
    g.fillStyle = style.curb[1];
    g.fillRect(0, h / 2, w, h / 2);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(w - 4, 0, 4, h);
  }));
  const curbMat = own(new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.42, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  // rounded "bevel" shading across the curb
  withUvShade(curbMat, 'curb', 'return 0.72 + 0.36 * sin(clamp(aoUv.x, 0.0, 1.0) * 3.14159);');
  const curbGB = new GB();
  for (const p of track.paths) {
    const n = p.samples.length;
    const curv = p.samples.map((_, i) => {
      let c = 0;
      for (let k = -3; k <= 3; k++) {
        const j = p.closed ? mod(i + k, n) : Math.min(n - 1, Math.max(0, i + k));
        c += p.samples[j].curvature;
      }
      return c / 7;
    });
    const on = (i: number) => Math.abs(curv[i]) > 0.0105 && !p.samples[i].gap;
    // widen runs a little so curbs start before the corner
    const keep = (i: number) => {
      for (let k = -4; k <= 4; k++) {
        const j = p.closed ? mod(i + k, n) : Math.min(n - 1, Math.max(0, i + k));
        if (on(j)) return !p.samples[i].gap;
      }
      return false;
    };
    const w = p.id === 0 ? 1.3 : 0.9;
    const y = p.id === 0 ? 0.09 : 0.07;
    ribbon(curbGB, p, (s) => -s.halfWidth - w + 0.3, (s) => -s.halfWidth + 0.3, y, 3, keep);
    ribbon(curbGB, p, (s) => s.halfWidth - 0.3, (s) => s.halfWidth + w - 0.3, y, 3, keep);
  }
  addMesh(curbGB, curbMat, { name: 'curbs' });

  /* ---------- walls */
  const wallStyle = style.wall;
  const wallTex = tex(wallStyle.tex());
  const wallMat = own(
    wallStyle.kind === 'strip'
      ? new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true })
      : new THREE.MeshStandardMaterial({ map: wallTex, roughness: wallStyle.rough, side: THREE.DoubleSide, vertexColors: true }),
  );
  // ambient occlusion baked into vertex colours: darker at the wall foot
  const aoCol = (h: number) => wallAo.setScalar(0.6 + 0.4 * Math.min(1, Math.max(0, h / 0.8)));
  const wallAo = new THREE.Color();
  const wallGB = new GB();
  const skirtGB = new GB();
  for (const p of track.paths) {
    const n = p.samples.length;
    for (const side of [-1, 1]) {
      const lat = (smp: TrackSample) => side * (wallDistOf(smp) + style.wallOffset);
      const keepArr: boolean[] = p.samples.map((smp) => {
        if (smp.gap) return false;
        const l = lat(smp);
        return !field.insideOther(smp.x + smp.nx * l, smp.z + smp.nz * l, p.id, -0.2);
      });
      // runs of consecutive kept samples (segments i -> i+1)
      const runs: number[][] = [];
      if (p.closed && keepArr.every(Boolean)) {
        runs.push([...Array.from({ length: n }, (_, i) => i), 0]);
      } else {
        let start = 0;
        if (p.closed) {
          start = keepArr.findIndex((k) => !k);
        }
        let cur: number[] = [];
        const total = p.closed ? n : n;
        for (let k = 0; k <= total; k++) {
          const i = p.closed ? (start + k) % n : k;
          if (!p.closed && k === n) break;
          if (keepArr[i]) cur.push(i);
          else {
            if (cur.length > 1) runs.push(cur);
            cur = [];
          }
        }
        if (cur.length > 1) runs.push(cur);
      }
      for (const run of runs) {
        // distance along the run for UVs
        const ds: number[] = [0];
        for (let k = 1; k < run.length; k++) {
          const a = p.samples[run[k - 1]], b = p.samples[run[k]];
          ds.push(ds[k - 1] + Math.hypot(b.x - a.x, b.z - a.z));
        }
        if (wallStyle.kind === 'strip') {
          let prevA = -1, prevB = -1;
          run.forEach((i, k) => {
            const smp = p.samples[i];
            const l = lat(smp);
            const x = smp.x + smp.nx * l, z = smp.z + smp.nz * l;
            const v = ds[k] / wallStyle.texLen;
            const A = wallGB.vert(x, smp.y - 0.1, z, v, 0, aoCol(0));
            const B = wallGB.vert(x, smp.y + wallStyle.height, z, v, 1, aoCol(1));
            if (k > 0) wallGB.quad(prevA, A, prevB, B);
            prevA = A;
            prevB = B;
          });
        } else {
          const prof = wallStyle.profile;
          // perimeter of the profile for v coordinate
          const pv: number[] = [0];
          for (let j = 1; j < prof.length; j++) pv.push(pv[j - 1] + Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]));
          const per = pv[pv.length - 1];
          for (let j = 0; j < prof.length - 1; j++) {
            let pa = -1, pb = -1;
            run.forEach((i, k) => {
              const smp = p.samples[i];
              const base = wallDistOf(smp) + style.wallOffset;
              const u = ds[k] / wallStyle.texLen;
              const mk = (pt: [number, number], vv: number) => {
                const l = side * (base + pt[0]);
                return wallGB.vert(smp.x + smp.nx * l, smp.y + pt[1] - 0.05, smp.z + smp.nz * l, u, 1 - vv / per, aoCol(pt[1]));
              };
              const A = mk(prof[j], pv[j]);
              const B = mk(prof[j + 1], pv[j + 1]);
              if (k > 0) {
                if (side > 0) wallGB.quad(pa, A, pb, B);
                else wallGB.quad(pb, B, pa, A);
              }
              pa = A;
              pb = B;
            });
          }
          // end caps
          for (const endK of [0, run.length - 1]) {
            const smp = p.samples[run[endK]];
            const base = wallDistOf(smp) + style.wallOffset;
            const ids = prof.map((pt) => {
              const l = side * (base + pt[0]);
              return wallGB.vert(smp.x + smp.nx * l, smp.y + pt[1] - 0.05, smp.z + smp.nz * l, 0.02, 0.5, aoCol(pt[1]));
            });
            for (let j = 1; j < ids.length - 1; j++) {
              const flip = (endK === 0) !== (side > 0);
              if (flip) wallGB.tri(ids[0], ids[j], ids[j + 1]);
              else wallGB.tri(ids[0], ids[j + 1], ids[j]);
            }
          }
        }
        // skirts (bridges / embankments): from the outer wall foot down to the terrain
        run.forEach((i, k) => {
          if (k === 0) return;
          const a = p.samples[run[k - 1]], b = p.samples[i];
          const la = side * (wallDistOf(a) + style.wallOffset + 0.3), lb = side * (wallDistOf(b) + style.wallOffset + 0.3);
          const ax = a.x + a.nx * la, az = a.z + a.nz * la, bx = b.x + b.nx * lb, bz = b.z + b.nz * lb;
          const ha = field.height(ax, az), hb = field.height(bx, bz);
          if (ha > a.y - 0.8 && hb > b.y - 0.8) return;
          const v0 = ds[k - 1] / 6, v1 = ds[k] / 6;
          const A = skirtGB.vert(ax, a.y, az, v0, 0), B = skirtGB.vert(bx, b.y, bz, v1, 0);
          const C = skirtGB.vert(ax, Math.min(ha, a.y) - 1, az, v0, (a.y - ha) / 6), D = skirtGB.vert(bx, Math.min(hb, b.y) - 1, bz, v1, (b.y - hb) / 6);
          if (side > 0) skirtGB.quad(A, B, C, D);
          else skirtGB.quad(C, D, A, B);
        });
      }
    }
  }
  addMesh(wallGB, wallMat, { cast: true, name: 'walls' });

  // gap abutments: vertical faces where the road ends at a gap
  for (const p of track.paths) {
    const n = p.samples.length;
    for (let i = 0; i < n; i++) {
      const smp = p.samples[i];
      if (smp.gap) continue;
      const nextI = p.closed ? (i + 1) % n : i + 1, prevI = p.closed ? mod(i - 1, n) : i - 1;
      for (const [j, dir] of [[nextI, 1], [prevI, -1]] as const) {
        if (j < 0 || j >= n || !p.samples[j].gap) continue;
        const wd = wallDistOf(smp) + style.wallOffset + 1;
        const bottom = field.height(smp.x + smp.tx * dir * 3, smp.z + smp.tz * dir * 3) - 1;
        const a = skirtGB.vert(smp.x - smp.nx * wd, smp.y + 0.05, smp.z - smp.nz * wd, 0, 0);
        const b = skirtGB.vert(smp.x + smp.nx * wd, smp.y + 0.05, smp.z + smp.nz * wd, (wd * 2) / 6, 0);
        const c = skirtGB.vert(smp.x - smp.nx * wd, bottom, smp.z - smp.nz * wd, 0, (smp.y - bottom) / 6);
        const d = skirtGB.vert(smp.x + smp.nx * wd, bottom, smp.z + smp.nz * wd, (wd * 2) / 6, (smp.y - bottom) / 6);
        if (dir > 0) skirtGB.quad(a, c, b, d);
        else skirtGB.quad(a, b, c, d);
      }
    }
  }
  const skirtMat = own(new THREE.MeshStandardMaterial({ map: tex(style.skirt()), roughness: 0.9, side: THREE.DoubleSide }));
  addMesh(skirtGB, skirtMat, { cast: false, name: 'skirts' });

  /* ---------- terrain */
  const b = field.bounds;
  const margin = style.slab ? 60 : 170;
  const x0 = b.minX - margin, x1 = b.maxX + margin, z0 = b.minZ - margin, z1 = b.maxZ + margin;
  const step = quality === 'high' ? 3 : quality === 'medium' ? 4 : 6;
  const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
  const terrainGB = new GB();
  const tTile = style.terrainTile;
  const groundCol = new THREE.Color(def.lighting.ground);
  const heights = new Float32Array((nx + 1) * (nz + 1));
  const tint = new THREE.Color();
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + (i * (x1 - x0)) / nx, z = z0 + (j * (z1 - z0)) / nz;
      const h = field.height(x, z);
      heights[j * (nx + 1) + i] = h;
      const nn = Math.sin(x * 0.05 + Math.cos(z * 0.04) * 2) * 0.5 + Math.sin(z * 0.031 - x * 0.013) * 0.5;
      tint.setRGB(1, 1, 1).multiplyScalar(0.92 + nn * 0.08);
      if (h < -1 && !style.slab) tint.multiplyScalar(0.75); // darker river/lake banks
      if (style.slab && field.channels[0]) {
        const c = field.channels[0];
        const side = (x - c.cx) * -c.az + (z - c.cz) * c.ax;
        if (side < 0) tint.multiply(TABLE_TINT); // wooden breakfast table on the far side of the aisle
      }
      terrainGB.vert(x, h, z, x / tTile, z / tTile, tint);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      terrainGB.idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  }
  const terrainTex = tex(style.terrain(def.lighting.ground));
  const terrainMat = own(new THREE.MeshStandardMaterial({ map: terrainTex, color: style.slab ? 0xffffff : groundCol.clone().lerp(new THREE.Color(1, 1, 1), 0.55), vertexColors: true, roughness: style.slab ? 0.35 : 0.95, metalness: style.slab ? 0.05 : 0 }));
  addMesh(terrainGB, terrainMat, { name: 'terrain' });
  if (!style.slab) {
    // endless ground around the terrain patch (four big quads; split at the shoreline)
    const farMat = own(new THREE.MeshStandardMaterial({ color: groundCol.clone().multiplyScalar(0.9), roughness: 1 }));
    const farGB = new GB();
    const F = 4500;
    const rect = (ax: number, az: number, bx: number, bz: number) => {
      const xs = [ax];
      if (field.shoreX > ax && field.shoreX < bx) xs.push(field.shoreX);
      xs.push(bx);
      for (let k = 0; k < xs.length - 1; k++) {
        const y = xs[k] >= field.shoreX ? -4 : -0.05;
        const a = farGB.vert(xs[k], y, az, 0, 0), b2 = farGB.vert(xs[k], y, bz, 0, 0), c = farGB.vert(xs[k + 1], y, az, 0, 0), d = farGB.vert(xs[k + 1], y, bz, 0, 0);
        farGB.idx.push(a, b2, c, c, b2, d);
      }
    };
    rect(x0 - F, z1, x1 + F, z1 + F);
    rect(x0 - F, z0 - F, x1 + F, z0);
    rect(x0 - F, z0, x0, z1);
    rect(x1, z0, x1 + F, z1);
    const far = addMesh(farGB, farMat, { name: 'farGround' });
    if (far) far.receiveShadow = false;
  } else {
    // counter slab sides (cabinet doors) down to the floor
    const sideGB = new GB();
    const floorY = style.waterY;
    const edge = (ax: number, az: number, bx: number, bz: number, count: number, getH: (k: number) => number, flip: boolean) => {
      let pa = -1, pb = -1;
      for (let k = 0; k <= count; k++) {
        const t = k / count;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const d = Math.hypot(bx - ax, bz - az) * t;
        const A = sideGB.vert(x, getH(k), z, d / 14, 0);
        const B = sideGB.vert(x, floorY, z, d / 14, (getH(k) - floorY) / 14);
        if (k > 0) {
          if (flip) sideGB.quad(pb, B, pa, A);
          else sideGB.quad(pa, A, pb, B);
        }
        pa = A;
        pb = B;
      }
    };
    edge(x0, z0, x1, z0, nx, (k) => heights[k], false);
    edge(x0, z1, x1, z1, nx, (k) => heights[nz * (nx + 1) + k], true);
    edge(x0, z0, x0, z1, nz, (k) => heights[k * (nx + 1)], true);
    edge(x1, z0, x1, z1, nz, (k) => heights[k * (nx + 1) + nx], false);
    addMesh(sideGB, skirtMat, { name: 'slabSides' });
  }

  /* ---------- channel water */
  const waters: WaterMaterial[] = [];
  if (style.water) {
    const L = def.lighting;
    const skyHorizon = new THREE.Color(L.skyBottom).lerp(new THREE.Color(L.fog), 0.4);
    const waterBase = { skyTop: L.skyTop, skyHorizon, sunColor: L.sun, sunDir: sunOffsetFor(def.theme), quality };
    const pal = waterPalette(def.theme, def.landmarks, style);
    const waterMat = own(createWaterMaterial({ ...waterBase, ...pal.channel, scale: 0.55 }));
    waters.push(waterMat);
    for (const c of field.channels) {
      waterMat.uniforms.flow.value.set(c.ax, c.az).multiplyScalar(0.9);
      const geo = own(new THREE.PlaneGeometry(c.halfLen * 2, c.halfWidth * 2 + 8));
      const m = new THREE.Mesh(geo, waterMat);
      // plane in xz with its length along local x; the holder turns local x onto the channel axis
      m.rotation.x = -Math.PI / 2;
      const holder = new THREE.Group();
      holder.add(m);
      holder.position.set(c.cx, style.waterY, c.cz);
      holder.rotation.y = -Math.atan2(c.az, c.ax);
      m.receiveShadow = false;
      group.add(holder);
    }
    // open water beyond the shoreline (Lake Michigan): drawn a little above the scenery's lake plane
    if (Number.isFinite(field.shoreX) && pal.lake) {
      const lakeMat = own(createWaterMaterial({ ...waterBase, ...pal.lake, scale: 1 }));
      waters.push(lakeMat);
      const lake = new THREE.Mesh(own(new THREE.PlaneGeometry(5000, 5000).rotateX(-Math.PI / 2)), lakeMat);
      lake.position.set(field.shoreX + 2500 - 4, -0.55, (field.bounds.minZ + field.bounds.maxZ) / 2);
      lake.name = 'lakeWater';
      group.add(lake);
    }
    animated.push((_dt, time) => {
      for (const w of waters) w.setTime(time);
    });
  }

  /* ---------- surfaces (ice / mud / milk) */
  const surfGBs = new Map<SurfaceType, GB>();
  const L = track.length;
  const main = track.paths[0];
  for (const r of def.surfaces) {
    let a = r.from * L, bb = r.to * L;
    if (bb < a) bb += L;
    let gb = surfGBs.get(r.type);
    if (!gb) surfGBs.set(r.type, (gb = new GB()));
    let prevA = -1, prevB = -1;
    let first = true;
    for (let s = a; s <= bb + 0.01; s += 2) {
      const smp = track.sampleAt(0, s);
      if (smp.gap) {
        first = true;
        continue;
      }
      const hw = smp.halfWidth;
      const la = r.side === 'right' ? 0 : -hw * 0.98, lb = r.side === 'left' ? 0 : hw * 0.98;
      const v = (s - a) / 10;
      const A = gb.vert(smp.x + smp.nx * la, smp.y + 0.1, smp.z + smp.nz * la, 0, v);
      const B = gb.vert(smp.x + smp.nx * lb, smp.y + 0.1, smp.z + smp.nz * lb, 1, v);
      if (!first) gb.quad(prevA, A, prevB, B);
      prevA = A;
      prevB = B;
      first = false;
    }
  }
  for (const [type, gb] of surfGBs) {
    const t = tex(surfaceTexture(type));
    const mat = own(new THREE.MeshStandardMaterial({
      map: t, transparent: true, alphaTest: 0.35, depthWrite: true,
      roughness: type === 'ice' ? 0.05 : type === 'milk' ? 0.25 : 1, metalness: type === 'ice' ? 0.35 : 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      emissive: type === 'ice' ? new THREE.Color('#244a66') : new THREE.Color(0), emissiveIntensity: type === 'ice' ? 0.25 : 0,
    }));
    addMesh(gb, mat, { name: `surface-${type}` });
  }
  void main;

  /* ---------- start line, grid slots */
  const paintGB = new GB();
  const checkGB = new GB();
  {
    const s0 = track.sampleAt(0, 0);
    const len = 3;
    const hw = s0.halfWidth;
    const pts: number[] = [];
    for (const [ds, lat] of [[-len / 2, -hw], [len / 2, -hw], [-len / 2, hw], [len / 2, hw]]) {
      const smp = track.sampleAt(0, ds);
      pts.push(checkGB.vert(smp.x + smp.nx * lat, smp.y + 0.11, smp.z + smp.nz * lat, (lat + hw) / 3, (ds + len / 2) / 3));
    }
    checkGB.quad(pts[0], pts[1], pts[2], pts[3]);
    for (const g of track.startGrid(8)) {
      // a white "[" in front of each slot
      const smp = track.sampleAt(0, g.s + 1.6);
      const lat = (g.pos.x - smp.x) * smp.nx + (g.pos.z - smp.z) * smp.nz;
      const quadAt = (sA: number, sB: number, la: number, lb: number) => {
        const p0 = track.sampleAt(0, sA), p1 = track.sampleAt(0, sB);
        const a1 = paintGB.vert(p0.x + p0.nx * la, p0.y + 0.1, p0.z + p0.nz * la, 0, 0);
        const b1 = paintGB.vert(p1.x + p1.nx * la, p1.y + 0.1, p1.z + p1.nz * la, 0, 0);
        const c1 = paintGB.vert(p0.x + p0.nx * lb, p0.y + 0.1, p0.z + p0.nz * lb, 0, 0);
        const d1 = paintGB.vert(p1.x + p1.nx * lb, p1.y + 0.1, p1.z + p1.nz * lb, 0, 0);
        paintGB.quad(a1, b1, c1, d1);
      };
      quadAt(g.s + 1.5, g.s + 1.85, lat - 1.6, lat + 1.6);
      quadAt(g.s - 0.5, g.s + 1.85, lat - 1.6, lat - 1.3);
      quadAt(g.s - 0.5, g.s + 1.85, lat + 1.3, lat + 1.6);
    }
  }
  const checkMat = own(new THREE.MeshStandardMaterial({ map: tex(checkerTexture('#ffffff', '#111111', 4)), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  addMesh(checkGB, checkMat, { name: 'startLine' });
  const paintMat = own(new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  addMesh(paintGB, paintMat, { name: 'gridPaint' });

  /* ---------- start gantry (when the theme has no start arch landmark) */
  if (!def.landmarks.some((l) => l.kind === 'startArch')) {
    const s0 = track.sampleAt(0, 0);
    const wd = wallDistOf(s0) + 1;
    const gantry = new THREE.Group();
    const pillarMat = own(new THREE.MeshStandardMaterial({ color: style.accent, roughness: 0.5 }));
    const pillarGeo = own(new THREE.BoxGeometry(1.2, 9, 1.2));
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(pillarGeo, pillarMat);
      m.position.set(side * wd, 4.5, 0);
      m.castShadow = true;
      gantry.add(m);
    }
    const beamGeo = own(new THREE.BoxGeometry(wd * 2 + 1.2, 2.6, 1));
    const beam = new THREE.Mesh(beamGeo, own(new THREE.MeshStandardMaterial({ color: style.accent2, roughness: 0.5 })));
    beam.position.y = 9.6;
    beam.castShadow = true;
    gantry.add(beam);
    const banner = new THREE.Mesh(
      own(new THREE.PlaneGeometry(Math.min(wd * 2 - 2, 22), 2.2)),
      own(new THREE.MeshBasicMaterial({ map: tex(textTexture(def.name.toUpperCase(), { bg: style.accent2, fg: '#ffffff', stroke: '#00000055', w: 1024, h: 128 })), side: THREE.DoubleSide })),
    );
    banner.position.set(0, 9.6, -0.52);
    banner.rotation.y = Math.PI;
    gantry.add(banner);
    const banner2 = banner.clone();
    banner2.position.z = 0.52;
    banner2.rotation.y = 0;
    gantry.add(banner2);
    const chk = new THREE.Mesh(own(new THREE.BoxGeometry(wd * 2 + 1.2, 0.8, 1.05)), own(new THREE.MeshStandardMaterial({ map: tex(checkerTexture('#ffffff', '#111111', 8)) })));
    (chk.material as THREE.MeshStandardMaterial).map!.repeat.set(6, 1);
    chk.position.y = 11.3;
    gantry.add(chk);
    // start lights
    const lightGeo = own(new THREE.SphereGeometry(0.35, 12, 8));
    const lightMat = own(new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a2a, emissiveIntensity: 2.6 }));
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(lightGeo, lightMat);
      m.position.set((i - 1.5) * 1.2, 8.0, -0.6);
      gantry.add(m);
    }
    gantry.position.set(s0.x, s0.y, s0.z);
    gantry.rotation.y = Math.atan2(s0.tx, s0.tz);
    group.add(gantry);
  }

  /* ---------- ramps */
  const rampTex = tex(canvasTexture(64, 128, (g, w, h) => {
    g.fillStyle = style.rampColors[0];
    g.fillRect(0, 0, w, h);
    g.fillStyle = style.rampColors[1];
    for (let k = 0; k < 2; k++) {
      const y0 = k * (h / 2);
      g.beginPath();
      g.moveTo(w * 0.1, y0 + h * 0.4);
      g.lineTo(w * 0.5, y0 + h * 0.12);
      g.lineTo(w * 0.9, y0 + h * 0.4);
      g.lineTo(w * 0.9, y0 + h * 0.48);
      g.lineTo(w * 0.5, y0 + h * 0.22);
      g.lineTo(w * 0.1, y0 + h * 0.48);
      g.closePath();
      g.fill();
    }
  }));
  const rampMat = own(new THREE.MeshStandardMaterial({ map: rampTex, roughness: 0.6 }));
  const rampSideMat = own(new THREE.MeshStandardMaterial({ color: style.rampColors[1], roughness: 0.7 }));
  const rampGB = new GB();
  const rampSideGB = new GB();
  for (const r of track.ramps) {
    const steps = Math.max(2, Math.ceil((r.s1 - r.s0) / 1));
    let pl = -1, pr = -1;
    let lastSm: TrackSample | null = null;
    const sideRows: Array<{ smp: TrackSample; h: number }> = [];
    for (let k = 0; k <= steps; k++) {
      const s = r.s0 + ((r.s1 - r.s0) * k) / steps;
      const smp = track.sampleAt(r.pathId, s);
      const h = RAMP_HEIGHT * (k / steps);
      const hw = smp.halfWidth;
      const l = rampGB.vert(smp.x - smp.nx * hw, smp.y + h + 0.06, smp.z - smp.nz * hw, 0, (k / steps) * 2.4);
      const rr = rampGB.vert(smp.x + smp.nx * hw, smp.y + h + 0.06, smp.z + smp.nz * hw, Math.max(1, hw / 4), (k / steps) * 2.4);
      if (k > 0) rampGB.quad(pl, l, pr, rr);
      pl = l;
      pr = rr;
      lastSm = smp;
      sideRows.push({ smp, h });
    }
    // sides
    for (const side of [-1, 1]) {
      for (let k = 1; k < sideRows.length; k++) {
        const a = sideRows[k - 1], c = sideRows[k];
        const la = side * a.smp.halfWidth, lc = side * c.smp.halfWidth;
        const A = rampSideGB.vert(a.smp.x + a.smp.nx * la, a.smp.y, a.smp.z + a.smp.nz * la, 0, 0);
        const B = rampSideGB.vert(a.smp.x + a.smp.nx * la, a.smp.y + a.h + 0.06, a.smp.z + a.smp.nz * la, 0, 0);
        const C = rampSideGB.vert(c.smp.x + c.smp.nx * lc, c.smp.y, c.smp.z + c.smp.nz * lc, 0, 0);
        const D = rampSideGB.vert(c.smp.x + c.smp.nx * lc, c.smp.y + c.h + 0.06, c.smp.z + c.smp.nz * lc, 0, 0);
        if (side > 0) rampSideGB.quad(A, C, B, D);
        else rampSideGB.quad(A, B, C, D);
      }
    }
    if (lastSm) {
      const hw = lastSm.halfWidth;
      const A = rampSideGB.vert(lastSm.x - lastSm.nx * hw, lastSm.y + RAMP_HEIGHT + 0.06, lastSm.z - lastSm.nz * hw, 0, 0);
      const B = rampSideGB.vert(lastSm.x + lastSm.nx * hw, lastSm.y + RAMP_HEIGHT + 0.06, lastSm.z + lastSm.nz * hw, 0, 0);
      const C = rampSideGB.vert(lastSm.x - lastSm.nx * hw, lastSm.y - 0.5, lastSm.z - lastSm.nz * hw, 0, 0);
      const D = rampSideGB.vert(lastSm.x + lastSm.nx * hw, lastSm.y - 0.5, lastSm.z + lastSm.nz * hw, 0, 0);
      rampSideGB.quad(A, C, B, D);
    }
  }
  addMesh(rampGB, rampMat, { cast: true, name: 'ramps' });
  addMesh(rampSideGB, own(rampSideMat), { cast: true, name: 'rampSides' });
  rampSideMat.side = THREE.DoubleSide;

  /* ---------- boost pads */
  const padTex = tex(chevronTexture('#fff36b', '#ff8a1a'));
  padTex.repeat.set(1, 1.5);
  const padMat = own(new THREE.MeshBasicMaterial({ map: padTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
  // slightly over-bright so the chevrons and the pad edge glow through the bloom pass
  padMat.color.setScalar(1.35);
  const padBaseMat = own(new THREE.MeshStandardMaterial({ color: 0x2a2fd8, emissive: 0x3a3cff, emissiveIntensity: 1.2, roughness: 0.25, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  const padGB = new GB();
  const padBaseGB = new GB();
  for (const p of track.boostPads) {
    const smp = track.sampleAt(0, p.s);
    const lat = (p.pos.x - smp.x) * smp.nx + (p.pos.z - smp.z) * smp.nz;
    const W = 1.9, H = 2.8;
    const corner = (gb: GB, ds: number, dl: number, u: number, v: number, y: number) => {
      const q = track.sampleAt(0, p.s + ds);
      return gb.vert(q.x + q.nx * (lat + dl), q.y + y, q.z + q.nz * (lat + dl), u, v);
    };
    for (const [gb, y, grow] of [[padBaseGB, 0.11, 0.25], [padGB, 0.13, 0]] as const) {
      const a = corner(gb, -H - grow, -W - grow, 0, 0, y), bb = corner(gb, H + grow, -W - grow, 0, 1, y);
      const c = corner(gb, -H - grow, W + grow, 1, 0, y), d = corner(gb, H + grow, W + grow, 1, 1, y);
      gb.quad(a, bb, c, d);
    }
  }
  addMesh(padBaseGB, padBaseMat, { name: 'padBase' });
  const padMesh = addMesh(padGB, padMat, { name: 'boostPads', order: 2 });
  if (padMesh) padMesh.receiveShadow = false;
  animated.push((dt, time) => {
    padTex.offset.y -= dt * 1.6;
    padBaseMat.emissiveIntensity = 1.3 + 0.7 * Math.sin(time * 8);
  });

  /* ---------- debug overlays */
  const debug = new THREE.Group();
  debug.visible = false;
  debug.name = 'trackDebug';
  {
    const linePts: number[] = [];
    const n = main.samples.length;
    for (let i = 0; i < n; i++) {
      const a = main.samples[i], c = main.samples[(i + 1) % n];
      const ra = track.racingLine[i], rc = track.racingLine[(i + 1) % n];
      linePts.push(a.x + a.nx * ra, a.y + 0.4, a.z + a.nz * ra, c.x + c.nx * rc, c.y + 0.4, c.z + c.nz * rc);
    }
    const lg = own(new THREE.BufferGeometry());
    lg.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
    debug.add(new THREE.LineSegments(lg, own(new THREE.LineBasicMaterial({ color: 0xff00ff, depthTest: false }))));
    const center: number[] = [];
    for (const p of track.paths) {
      const m = p.samples.length;
      for (let i = 0; i < (p.closed ? m : m - 1); i++) {
        const a = p.samples[i], c = p.samples[(i + 1) % m];
        center.push(a.x, a.y + 0.3, a.z, c.x, c.y + 0.3, c.z);
      }
    }
    const cg = own(new THREE.BufferGeometry());
    cg.setAttribute('position', new THREE.Float32BufferAttribute(center, 3));
    debug.add(new THREE.LineSegments(cg, own(new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false }))));
    const cps: number[] = [];
    for (const s of track.checkpoints) {
      const smp = track.sampleAt(0, s);
      const wd = wallDistOf(smp);
      for (const h of [0.3, 3]) cps.push(smp.x - smp.nx * wd, smp.y + h, smp.z - smp.nz * wd, smp.x + smp.nx * wd, smp.y + h, smp.z + smp.nz * wd);
      cps.push(smp.x - smp.nx * wd, smp.y, smp.z - smp.nz * wd, smp.x - smp.nx * wd, smp.y + 3, smp.z - smp.nz * wd);
      cps.push(smp.x + smp.nx * wd, smp.y, smp.z + smp.nz * wd, smp.x + smp.nx * wd, smp.y + 3, smp.z + smp.nz * wd);
    }
    const kg = own(new THREE.BufferGeometry());
    kg.setAttribute('position', new THREE.Float32BufferAttribute(cps, 3));
    debug.add(new THREE.LineSegments(kg, own(new THREE.LineBasicMaterial({ color: 0xffee00, depthTest: false }))));
    debug.traverse((o) => (o.renderOrder = 10));
  }
  group.add(debug);

  return {
    group,
    field,
    update(dt: number, time: number) {
      for (const f of animated) f(dt, time);
    },
    showDebug(on: boolean) {
      debug.visible = on;
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}

/** Water colours per theme; Chicago's river channel is dyed green to match the river landmark. */
function waterPalette(theme: TrackTheme, landmarks: Array<{ kind: string }>, style: Style): {
  channel: { deep: string; shallow: string; opacity?: number };
  lake: { deep: string; shallow: string } | null;
} {
  const hasRiver = landmarks.some((l) => l.kind === 'river');
  switch (theme) {
    case 'chicago':
      return { channel: hasRiver ? WATER_COLORS.greenRiver : WATER_COLORS.lake, lake: WATER_COLORS.lake };
    case 'snow':
      return { channel: WATER_COLORS.icy, lake: WATER_COLORS.icy };
    default:
      return { channel: style.water ? { deep: style.water, shallow: style.waterLight } : WATER_COLORS.pond, lake: WATER_COLORS.pond };
  }
}

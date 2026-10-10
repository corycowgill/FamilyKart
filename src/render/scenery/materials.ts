import * as THREE from 'three';
import type { Bag } from './common';
import { cityEnvTexture } from './textures';

/*
 * Stylised surface treatments injected into MeshStandardMaterial (onBeforeCompile), shared by the
 * scenery builders and the track view:
 *  - wind sway for foliage / grass (vertex shader, weighted by local height)
 *  - procedural masonry (chunky bevelled bricks / ashlar blocks with soft per-block colour
 *    variation and a derivative bump so highlights catch the brick edges)
 *  - facade detail maps (window recess normal map + glass/wall roughness & metalness) and a
 *    shared city reflection map for glass
 *  - cheering crowd (per-instance hop + waving arms marked by uv.x > 1.5)
 * Everything keeps the emissive / customProgramCacheKey conventions NightLights relies on.
 */

/* ------------------------------------------------------------------ wind */

/** Global wind clock (seconds), advanced by any swaying mesh right before it renders. */
export const WIND = { value: 0 };
let windStamp = -1;
const tickWind = () => {
  const now = performance.now();
  if (now === windStamp) return;
  windStamp = now;
  WIND.value = now / 1000;
};

export interface Sway {
  /** local height where swaying starts / reaches full strength */
  from: number;
  to: number;
  /** metres of horizontal sway at full strength */
  amp: number;
  /** extra fast leaf flutter (fraction of amp) */
  flutter?: number;
}

const swayGLSL = (s: Sway) => `
  {
    float sw = smoothstep(${s.from.toFixed(2)}, ${s.to.toFixed(2)}, position.y);
    float ph = 0.0;
    #ifdef USE_INSTANCING
    ph = instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.053;
    #endif
    float gust = 0.65 + 0.35 * sin(uWind * 0.37 + ph * 0.5);
    float bx = sin(uWind * 1.35 + ph) * gust;
    float bz = sin(uWind * 1.05 + ph * 1.7) * 0.6 * gust;
    float fl = sin(uWind * 6.3 + position.x * 2.1 + position.z * 1.7 + ph * 3.0) * ${(s.flutter ?? 0.15).toFixed(3)};
    transformed.x += (bx + fl) * ${s.amp.toFixed(3)} * sw;
    transformed.z += (bz + fl * 0.7) * ${s.amp.toFixed(3)} * sw;
    transformed.y -= abs(bx) * ${(s.amp * 0.15).toFixed(3)} * sw;
  }`;

const swayCache = new WeakMap<THREE.Material, Map<string, THREE.Material>>();

/** Clone `base` (a MeshStandardMaterial) with wind sway. Cached per (material, sway). */
export function swayVariant(base: THREE.Material, s: Sway): THREE.Material {
  if (!(base instanceof THREE.MeshStandardMaterial)) return base;
  const key = `${s.from}|${s.to}|${s.amp}|${s.flutter ?? 0.15}`;
  let m = swayCache.get(base);
  if (!m) swayCache.set(base, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const mat = base.clone();
  const prev = base.onBeforeCompile;
  const prevKey = base.customProgramCacheKey?.() ?? '';
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(base, sh, r);
    sh.uniforms.uWind = WIND;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${swayGLSL(s)}`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|sway-${key}`;
  m.set(key, mat);
  return mat;
}

/** Hook a mesh so the wind clock advances while it is drawn. */
export function windDriver(o: THREE.Object3D): void {
  o.onBeforeRender = tickWind;
}

/* ------------------------------------------------------------------ masonry */

export interface Masonry {
  /** block size in metres (w, h) */
  size: [number, number];
  /** mortar width (fraction of block height) */
  mortar?: number;
  mortarColor?: string;
  /** per-block brightness jitter */
  jitter?: number;
  /** bump strength */
  bump?: number;
  /**
   * Where the pattern comes from: 'uv' = facade UVs in metres (vMapUv * cell), 'local' = object
   * space position (instanced house bodies, picked per face by the dominant normal axis).
   */
  space: 'uv' | 'local';
  cell?: [number, number];
  /** apply only where the sampled map is close to this wall colour (facade textures) */
  wall?: string;
  /** apply only to vertex-coloured parts that are tinted (white base colour) */
  tintedOnly?: boolean;
}

const pnArb = `
vec3 mzPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float fd) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * fd;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
float mzHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`;

/** Adds procedural masonry to a MeshStandardMaterial (chainable with other injections). */
export function masonry<T extends THREE.MeshStandardMaterial>(mat: T, o: Masonry): T {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey?.() ?? '';
  const mortar = o.mortar ?? 0.14;
  const mc = new THREE.Color(o.mortarColor ?? '#d9cfc0');
  const wall = o.wall ? new THREE.Color(o.wall) : null;
  const cell = o.cell ?? [1, 1];
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    const local = o.space === 'local';
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vMzPos;\nvarying vec3 vMzNrm;${o.tintedOnly ? '\nvarying float vMzTint;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMzPos = position; vMzNrm = normal;${o.tintedOnly ? '\n#ifdef USE_COLOR\nvMzTint = step(2.97, color.r + color.g + color.b);\n#else\nvMzTint = 1.0;\n#endif' : ''}`);
    let coord: string;
    if (local) {
      coord = `vec3 an = abs(vMzNrm); vec2 bp = an.x > 0.5 ? vMzPos.zy : an.z > 0.5 ? vMzPos.xy : vMzPos.xz;`;
    } else {
      coord = `
        #ifdef USE_MAP
        vec2 bp = vMapUv * vec2(${cell[0].toFixed(3)}, ${cell[1].toFixed(3)});
        #else
        vec2 bp = vMzPos.xy;
        #endif`;
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vMzPos;\nvarying vec3 vMzNrm;${o.tintedOnly ? '\nvarying float vMzTint;' : ''}\nfloat mzH = 0.0;\nfloat mzMask = 0.0;\n${pnArb}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          ${coord}
          vec2 bs = vec2(${o.size[0].toFixed(3)}, ${o.size[1].toFixed(3)});
          vec2 g = bp / bs;
          float row = floor(g.y);
          g.x += mod(row, 2.0) * 0.5;
          vec2 id = floor(g);
          vec2 f = fract(g);
          float mw = ${mortar.toFixed(3)};
          vec2 e = min(f, 1.0 - f) * vec2(bs.x / bs.y, 1.0);
          float d = min(e.x, e.y);
          float h = smoothstep(mw * 0.5, mw * 1.6, d);
          // fade the pattern out where it would alias (far away / grazing)
          float fw = length(fwidth(bp / bs.y));
          float fade = 1.0 - smoothstep(0.25, 0.7, fw);
          float m = fade;
          ${wall ? `m *= 1.0 - smoothstep(0.06, 0.16, distance(diffuseColor.rgb / max(vec3(1e-3), diffuse), vec3(${wall.r.toFixed(3)}, ${wall.g.toFixed(3)}, ${wall.b.toFixed(3)})));` : ''}
          ${o.tintedOnly ? 'm *= vMzTint;' : ''}
          ${local ? 'm *= step(abs(vMzNrm.y), 0.5);' : ''}
          float jit = (mzHash(id) - 0.5) * ${(o.jitter ?? 0.16).toFixed(3)};
          vec3 col = diffuseColor.rgb * (1.0 + jit) * mix(0.9, 1.04, h);
          vec3 mor = vec3(${mc.r.toFixed(3)}, ${mc.g.toFixed(3)}, ${mc.b.toFixed(3)}) * mix(vec3(0.85), diffuseColor.rgb / max(0.2, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b))), 0.25);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(mor, col, h), m);
          mzH = h * m;
          mzMask = m;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (mzMask > 0.01) {
          vec2 dh = vec2(dFdx(mzH), dFdy(mzH)) * ${(o.bump ?? 1.2).toFixed(3)};
          normal = mzPerturb(-vViewPosition, normal, dh, faceDirection);
        }`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey}|mz-${o.space}-${o.size.join('x')}-${mortar}-${o.wall ?? ''}-${o.tintedOnly ? 1 : 0}-${cell.join('x')}`;
  return mat;
}

/* ------------------------------------------------------------------ facade detail maps */

const facadeMapCache = new WeakMap<THREE.Texture, { normal: THREE.Texture; orm: THREE.Texture }>();

/**
 * From an authored window texture (wall colour = top-left pixel), derive a normal map where the
 * glass sits recessed behind a bevelled reveal with a sill, plus an ORM-style map (G = roughness,
 * B = metalness): glossy reflective glass, matte walls.
 */
export function facadeDetailMaps(map: THREE.Texture, o: { wallRough: number; glassRough?: number; glassMetal?: number; depth?: number } ): { normal: THREE.Texture; orm: THREE.Texture } | null {
  const hit = facadeMapCache.get(map);
  if (hit) return hit;
  const img = map.image as HTMLCanvasElement | undefined;
  if (typeof document === 'undefined' || !img || !(img instanceof HTMLCanvasElement)) return null;
  const w = img.width, h = img.height;
  const src = img.getContext('2d')?.getImageData(0, 0, w, h);
  if (!src) return null;
  const d = src.data;
  const wr = d[0], wg = d[1], wb = d[2];
  const glass = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const diff = Math.abs(d[i * 4] - wr) + Math.abs(d[i * 4 + 1] - wg) + Math.abs(d[i * 4 + 2] - wb);
    glass[i] = diff > 40 ? 1 : 0;
  }
  // height: wall 1, glass 0 with a soft bevel (box blur, wrapping)
  const hgt = new Float32Array(w * h);
  const R = Math.max(1, Math.round(w / 128));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      s += glass[((y + dy + h) % h) * w + ((x + dx + w) % w)];
      n++;
    }
    hgt[y * w + x] = 1 - s / n;
  }
  const nc = document.createElement('canvas');
  nc.width = w;
  nc.height = h;
  const ng = nc.getContext('2d')!;
  const nd = ng.createImageData(w, h);
  const oc = document.createElement('canvas');
  oc.width = w;
  oc.height = h;
  const og = oc.getContext('2d')!;
  const od = og.createImageData(w, h);
  const k = (o.depth ?? 2.2) * (w / 128);
  const at = (x: number, y: number) => hgt[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * k;
    const dy = (at(x, y + 1) - at(x, y - 1)) * k;
    // canvas y runs down, texture v runs up -> flip dy
    const nx = -dx, ny = dy, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const i = (y * w + x) * 4;
    nd.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
    nd.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
    nd.data[i + 2] = ((nz / l) * 0.5 + 0.5) * 255;
    nd.data[i + 3] = 255;
    const g = glass[y * w + x];
    od.data[i] = 255;
    od.data[i + 1] = (g ? (o.glassRough ?? 0.1) : o.wallRough) * 255;
    od.data[i + 2] = (g ? (o.glassMetal ?? 0.55) : 0) * 255;
    od.data[i + 3] = 255;
  }
  ng.putImageData(nd, 0, 0);
  og.putImageData(od, 0, 0);
  const mk = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = map.wrapS;
    t.wrapT = map.wrapT;
    t.anisotropy = 8;
    return t;
  };
  const out = { normal: mk(nc), orm: mk(oc) };
  facadeMapCache.set(map, out);
  // the derived maps live and die with the colour map
  map.addEventListener('dispose', () => {
    out.normal.dispose();
    out.orm.dispose();
    facadeMapCache.delete(map);
  });
  return out;
}

const envCache = new WeakMap<Bag, Map<string, THREE.Texture>>();

/** One shared equirect city reflection per scenery bag (PMREM'd once by the renderer). */
export function sharedEnv(bag: Bag, dusk: boolean): THREE.Texture {
  let m = envCache.get(bag);
  if (!m) envCache.set(bag, (m = new Map()));
  const k = dusk ? 'dusk' : 'day';
  let t = m.get(k);
  if (!t) m.set(k, (t = bag.add(cityEnvTexture(dusk))));
  return t;
}

/* ------------------------------------------------------------------ crowd */

/**
 * Vertex-coloured crowd material: white parts take the instance colour (shirts), every instance
 * hops on its own phase and vertices with uv.x > 1.5 (arms: 2 = left, 3 = right) wave about the
 * shoulder pivot.
 */
export function crowdMaterial(bag: Bag, time: { value: number }, o: { hop?: number; speed?: number } = {}): THREE.MeshStandardMaterial {
  const m = bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }));
  const hop = o.hop ?? 0.3, speed = o.speed ?? 7;
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
          float excited = step(0.45, fract(ph * 0.31));
          if (uv.x > 1.5) {
            float side = uv.x > 2.5 ? 1.0 : -1.0;
            vec2 piv = vec2(side * 0.25, 1.38);
            float a = side * (sin(uTime * ${(speed * 0.9).toFixed(2)} + ph * 2.0) * mix(0.25, 0.7, excited) - 0.1);
            vec2 q = transformed.xy - piv;
            float c = cos(a), s = sin(a);
            transformed.xy = piv + vec2(c * q.x - s * q.y, s * q.x + c * q.y);
          }
          float hp = abs(sin(uTime * ${speed.toFixed(2)} + ph));
          transformed.y += hp * ${hop.toFixed(3)} * excited;
          transformed.x += sin(uTime * 2.0 + ph) * 0.05 * position.y;
        }`,
      );
  };
  m.customProgramCacheKey = () => `crowd-${hop}-${speed}`;
  return m;
}

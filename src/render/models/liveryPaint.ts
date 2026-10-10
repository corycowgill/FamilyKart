import * as THREE from 'three';
import type { CharacterId } from '../../sim/types';
import { liveryById, type LiveryId } from './liveries';
import { cachedMat } from './materials';

/**
 * Procedural livery paint: a clear-coated MeshPhysicalMaterial whose base colour (plus optional
 * roughness / metalness / neon emissive) is computed per pixel from the OBJECT-space position of the
 * kart tub or side pods. Patterns only depend on (y, z) for the pods and on (x, y, z) for the tub,
 * which sits at the body origin — so the look is identical before and after KartView merges the
 * static kart meshes into body space (pods only move along x).
 */

/** Kart body measurements the patterns are laid out against (kart space, metres). */
export interface LiveryDims {
  len: number; // nose z
  rear: number; // tail z
  bodyW: number;
  noseY: number;
  dashY: number;
  dashZ: number;
  cockpitY: number;
  engineY: number;
  cockBack: number; // z where the cockpit opening ends / engine deck starts
  podTop: number;
}

const lin = (hex: string): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/** Shared GLSL helpers available to every pattern. */
const HELPERS = /* glsl */ `
uniform vec4 uLivA; // len, rear, bodyW/2, isPod
uniform vec4 uLivB; // noseY, dashY, dashZ, cockpitY
uniform vec4 uLivC; // engineY, cockBack, podTop, 0
varying vec3 vLivPos;
varying vec3 vLivNrm;
float livAA(float x) { return max(fwidth(x) * 0.8, 1e-4); }
float livStep(float edge, float x) { float w = livAA(x); return smoothstep(edge - w, edge + w, x); }
float livBand(float x, float a, float b) { float w = livAA(x); return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }
float livLine(float d, float halfW) { float w = max(fwidth(d) * 0.8, 1e-4); return 1.0 - smoothstep(halfW - w, halfW + w, abs(d)); }
float livHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float livNoise(vec2 x) {
  vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(livHash(i), livHash(i + vec2(1.0, 0.0)), f.x), mix(livHash(i + vec2(0.0, 1.0)), livHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float livTri(float x) { return abs(fract(x) - 0.5) * 4.0 - 1.0; }
/** Height of the kart's top surface (side profile) at z. */
float livTopAt(float z) {
  if (uLivA.w > 0.5) return uLivC.z;
  float L = uLivA.x;
  if (z > uLivB.z) return mix(uLivB.y, uLivB.x, clamp((z - uLivB.z) / max(L - uLivB.z, 0.01), 0.0, 1.0));
  if (z > uLivC.y) return uLivB.w;
  return uLivC.x;
}
`;

interface Pattern {
  roughness: number;
  metalness: number;
  clearcoat?: number;
  /** GLSL body: inputs p (object pos), n (object normal), isPod; must set col; may set em, rough, metal. */
  glsl: string;
}

/**
 * Per-livery shader patterns. `top` = upward facing surface, `side` = sideways facing.
 * For pods (isPod) x is not usable (pods are positioned along x) — use y/z only.
 */
const PATTERNS: Record<LiveryId, Pattern> = {
  chicagoFlag: {
    roughness: 0.3, metalness: 0.05,
    glsl: `
      col = ${lin('#f4f6f8')};
      vec3 blue = ${lin('#41b6e6')};
      if (!isPod) {
        // two light-blue racing stripes along the top, like the flag's stripes
        float ax = abs(p.x);
        float topM = smoothstep(0.25, 0.55, n.y);
        col = mix(col, blue, livBand(ax, 0.12, 0.2) * topM);
        // thin blue pinstripe low along each side
        col = mix(col, blue, livBand(p.y, 0.235, 0.275) * (1.0 - topM));
      } else {
        col = mix(col, blue, livBand(p.y, 0.17, 0.205));
      }`,
  },
  windyCity: {
    roughness: 0.28, metalness: 0.05,
    glsl: `
      col = ${lin('#59b8f0')};
      vec3 white = ${lin('#ffffff')};
      float topM = isPod ? 0.0 : smoothstep(0.35, 0.6, n.y);
      float s = mix(p.y, p.x * 0.55 + 0.4, topM);
      float m = 0.0;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float c = 0.25 + fi * 0.085 + 0.022 * sin(p.z * 8.0 + fi * 2.1);
        float seg = smoothstep(-0.25, 0.15, sin(p.z * 3.1 + fi * 1.9));
        m = max(m, livLine(s - c, 0.009 + 0.006 * seg) * seg);
      }
      col = mix(col, white, m);`,
  },
  lowerWacker: {
    roughness: 0.42, metalness: 0.2,
    glsl: `
      col = ${lin('#15161a')};
      vec3 sodium = ${lin('#ffb020')};
      float topM = isPod ? 0.0 : smoothstep(0.35, 0.6, n.y);
      // diagonal hazard stripes along the bottom edge
      float hz = livStep(0.5, fract((p.z + p.y) * 7.0)) * (1.0 - livStep(0.215, p.y)) * (1.0 - topM);
      col = mix(col, sodium, hz);
      // glowing sodium-lamp pinstripes
      float side = livBand(p.y, 0.3, 0.322) * (1.0 - topM);
      float top = isPod ? 0.0 : livBand(abs(p.x), 0.1, 0.13) * topM;
      float glowM = max(side, top);
      col = mix(col, sodium, glowM);
      em += sodium * glowM * 0.9;`,
  },
  chicagoDog: {
    roughness: 0.5, metalness: 0.0, clearcoat: 0.6,
    glsl: `
      col = ${lin('#e3b16a')};
      float topM = isPod ? 0.0 : smoothstep(0.35, 0.6, n.y);
      // poppy seeds
      vec2 cell = vec2(p.x * 1.3 + p.y, p.z) * 26.0;
      vec2 id = floor(cell);
      vec2 f = fract(cell) - 0.5 + (vec2(livHash(id), livHash(id + 7.3)) - 0.5) * 0.5;
      float seed = (1.0 - smoothstep(0.08, 0.13, length(f * vec2(1.0, 1.6)))) * step(0.45, livHash(id + 3.1));
      col = mix(col, ${lin('#2b2420')}, seed * 0.85);
      // relish stripe low on the sides
      col = mix(col, ${lin('#3fae2a')}, livBand(p.y, 0.19, 0.25) * (1.0 - topM));
      // mustard zigzag: along the sides and down the middle of the top
      float zz = mix(p.y - (0.315 + 0.03 * livTri(p.z * 4.0)), (isPod ? 1.0 : p.x) - 0.07 * livTri(p.z * 3.0), topM);
      col = mix(col, ${lin('#f5c518')}, livLine(zz, mix(0.013, 0.03, topM)));`,
  },
  bluesClub: {
    roughness: 0.25, metalness: 0.15,
    glsl: `
      col = ${lin('#12206b')};
      vec3 pink = ${lin('#ff3fa4')};
      vec3 cyan = ${lin('#3fd8ff')};
      float topM = isPod ? 0.0 : smoothstep(0.35, 0.6, n.y);
      // subtle starlight sparkle
      vec2 id = floor(vec2(p.x + p.y, p.z) * 40.0);
      col += vec3(0.02, 0.03, 0.08) * step(0.93, livHash(id));
      float pk = livLine(p.y - 0.305, 0.011) * (1.0 - topM);
      float cy = livLine(p.y - 0.345, 0.007) * (1.0 - topM);
      if (!isPod) pk = max(pk, livLine(abs(p.x) - 0.3, 0.014) * topM);
      if (!isPod) cy = max(cy, livLine(abs(p.x) - 0.26, 0.008) * topM);
      if (isPod) { pk = livLine(p.y - 0.19, 0.012); cy = livLine(p.y - uLivC.z + 0.03, 0.008); }
      col = mix(col, pink, pk);
      col = mix(col, cyan, cy);
      em += pink * pk * 1.6 + cyan * cy * 1.6;`,
  },
  lTrain: {
    roughness: 0.3, metalness: 0.85,
    glsl: `
      // brushed stainless steel: fine streaks along the car
      float streak = livHash(vec2(floor((p.y + p.x * 0.7) * 260.0), 1.0));
      col = ${lin('#c9ced6')} * (0.9 + 0.12 * streak);
      rough = 0.26 + 0.12 * streak;
      float topM = isPod ? 0.0 : smoothstep(0.35, 0.6, n.y);
      // CTA line stripe: red over blue
      float red = livBand(p.y, 0.265, 0.3) * (1.0 - topM);
      float blue = livBand(p.y, 0.305, 0.325) * (1.0 - topM);
      if (isPod) { red = livBand(p.y, 0.17, 0.2); blue = 0.0; }
      col = mix(col, ${lin('#c60c30')}, red);
      col = mix(col, ${lin('#00a1de')}, blue);
      metal = mix(0.85, 0.1, max(red, blue));
      // dark roof ribs on top
      if (!isPod) col = mix(col, ${lin('#4a5058')}, topM * livLine(fract(p.x * 9.0) - 0.5, 0.05) * 0.6);`,
  },
  deepDish: {
    roughness: 0.42, metalness: 0.0, clearcoat: 0.7,
    glsl: `
      col = ${lin('#c8281e')};
      float topM = isPod ? 0.0 : smoothstep(0.4, 0.65, n.y);
      vec2 q = isPod ? vec2(p.y * 2.0, p.z) : vec2(p.x + p.y, p.z);
      // sauce texture: darker tomato chunks
      col *= 0.86 + 0.18 * livNoise(q * 22.0);
      // melty cheese: blobs on top, drips running down from the top edge
      float top = livTopAt(p.z);
      float drip = 0.03 + 0.075 * max(0.0, sin(p.z * 11.0 + 1.3) * sin(p.z * 4.7));
      float blobs = smoothstep(0.5, 0.56, livNoise(q * 7.0 + 3.0));
      float cheese = max(topM * blobs, livStep(top - drip, p.y) * (1.0 - topM));
      col = mix(col, ${lin('#ffd35a')} * (0.92 + 0.1 * livNoise(q * 30.0)), cheese);
      // pepperoni
      vec2 cell = q * 6.0;
      vec2 id = floor(cell);
      vec2 f = fract(cell) - 0.5 + (vec2(livHash(id), livHash(id + 5.1)) - 0.5) * 0.4;
      float pep = (1.0 - smoothstep(0.26, 0.29, length(f))) * step(0.5, livHash(id + 9.7)) * max(topM, 1.0 - livStep(top - 0.12, p.y));
      col = mix(col, ${lin('#8e1a12')} * (0.85 + 0.3 * livNoise(cell * 3.0)), pep);
      // golden-brown crust along the bottom
      float crust = 1.0 - livStep(0.24 + 0.012 * sin(p.z * 23.0), p.y);
      col = mix(col, ${lin('#a8652e')} * (0.85 + 0.25 * livNoise(vec2(p.y, p.z) * 40.0)), crust * (1.0 - topM));
      rough = mix(0.42, 0.75, crust);`,
  },
  lakeMichigan: {
    roughness: 0.22, metalness: 0.1,
    glsl: `
      float top = livTopAt(p.z);
      float t = clamp((p.y - 0.15) / max(top - 0.15, 0.05), 0.0, 1.0);
      float topM = isPod ? 0.0 : smoothstep(0.35, 0.6, n.y);
      col = mix(${lin('#0b2d6b')}, ${lin('#1fb5b0')}, smoothstep(0.35, 1.0, t) * (1.0 - topM) + topM * 0.45);
      col = mix(col, ${lin('#1fb5b0')}, topM * smoothstep(0.2, 0.9, fract(p.z * 1.2 + 0.2 * sin(p.x * 9.0))) * 0.35);
      // rolling waves near the waterline + foam
      float w1 = livLine(p.y - (0.225 + 0.018 * sin(p.z * 15.0)), 0.007);
      float w2 = livLine(p.y - (0.265 + 0.015 * sin(p.z * 15.0 + 2.2)), 0.005);
      float w3 = isPod ? 0.0 : livLine(p.x - 0.18 * sin(p.z * 5.0), 0.01) * topM * 0.8;
      col = mix(col, ${lin('#ffffff')}, max(max(w1, w2 * 0.8) * (1.0 - topM), w3));`,
  },
  bean: {
    roughness: 0.05, metalness: 1.0,
    glsl: `col = ${lin('#e9edf2')};`,
  },
};

const VERT_DECL = 'varying vec3 vLivPos;\nvarying vec3 vLivNrm;\n';

/** Patterned body/pod paint for a livery on one kart. Cached + shared. */
export function liveryPaint(id: LiveryId, character: CharacterId, part: 'tub' | 'pod', d: LiveryDims): THREE.MeshPhysicalMaterial {
  return cachedMat(`livery:${id}:${character}:${part}`, () => {
    const pat = PATTERNS[id];
    const m = new THREE.MeshPhysicalMaterial({
      color: '#ffffff', roughness: pat.roughness, metalness: pat.metalness, clearcoat: pat.clearcoat ?? 1, clearcoatRoughness: id === 'bean' ? 0.02 : 0.08,
    });
    m.name = `livery-${id}-${part}`;
    if (id === 'bean') {
      m.color.set(liveryById(id).colors.body);
      return m;
    }
    const uniforms = {
      uLivA: { value: new THREE.Vector4(d.len, d.rear, d.bodyW / 2, part === 'pod' ? 1 : 0) },
      uLivB: { value: new THREE.Vector4(d.noseY, d.dashY, d.dashZ, d.cockpitY) },
      uLivC: { value: new THREE.Vector4(d.engineY, d.cockBack, d.podTop, 0) },
    };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = VERT_DECL + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vLivPos = position; vLivNrm = normal;',
      );
      shader.fragmentShader = HELPERS + shader.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 livEm = vec3(0.0); float livR = -1.0; float livM = -1.0;
          {
            vec3 p = vLivPos; vec3 n = normalize(vLivNrm); bool isPod = uLivA.w > 0.5;
            vec3 col = vec3(1.0); vec3 em = vec3(0.0); float rough = -1.0; float metal = -1.0;
            ${pat.glsl}
            diffuseColor.rgb *= col; livEm = em; livR = rough; livM = metal;
          }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n if (livR >= 0.0) roughnessFactor = livR;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n if (livM >= 0.0) metalnessFactor = livM;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += livEm;');
    };
    m.customProgramCacheKey = () => `livery-pattern:${id}`;
    return m;
  });
}

/** Solid clear-coat paint for a livery's secondary parts (chrome for The Bean). */
export function liverySolid(id: LiveryId, color: string, roughness = 0.32): THREE.MeshPhysicalMaterial {
  return cachedMat(`liverysolid:${id}:${color}:${roughness}`, () => {
    const bean = id === 'bean';
    const lt = id === 'lTrain';
    return new THREE.MeshPhysicalMaterial({
      color, roughness: bean ? 0.06 : lt ? 0.32 : roughness, metalness: bean ? 1 : lt ? 0.6 : 0.15, clearcoat: 1, clearcoatRoughness: 0.08,
    });
  });
}

/** Glowing trim (neon / sodium) that stays bright at night. */
export function liveryGlow(color: string, intensity: number): THREE.MeshStandardMaterial {
  return cachedMat(`liveryglow:${color}:${intensity}`, () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.35 }));
}

/** Decal material for livery graphics; Blues Club (neon) and Lower Wacker (sodium) decals glow at night. */
export function liveryDecalMat(key: string, tex: THREE.Texture | null, id: LiveryId): THREE.MeshStandardMaterial {
  return cachedMat(`livdecal:${key}`, () => {
    const glowing = id === 'bluesClub' || id === 'lowerWacker';
    const glowAmt = id === 'bluesClub' ? 0.9 : 0.45;
    return new THREE.MeshStandardMaterial({
      map: tex ?? null,
      transparent: true,
      opacity: tex ? 1 : 0,
      roughness: id === 'bean' || id === 'lTrain' ? 0.25 : 0.35,
      metalness: 0.05,
      emissive: glowing ? '#ffffff' : '#000000',
      emissiveMap: glowing ? tex ?? null : null,
      emissiveIntensity: glowing ? glowAmt : 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  });
}

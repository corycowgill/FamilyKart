import * as THREE from 'three';
import { particleAtlas, SPRITE, type SpriteId } from './vfx/atlas';
import { Rings } from './vfx/Rings';
import { Arcs } from './vfx/Arcs';

export { SPRITE } from './vfx/atlas';

export type VfxQuality = 'low' | 'medium' | 'high';

export interface EmitOptions {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  spread?: number;
  color: THREE.ColorRepresentation;
  /** colour at the end of life (default = color) */
  color2?: THREE.ColorRepresentation;
  size?: number;
  life?: number;
  gravity?: number;
  drag?: number;
  grow?: number; // size multiplier over life (smoke grows)
  count?: number;
  /** atlas sprite (default SOFT) */
  sprite?: SpriteId;
  /** initial rotation (radians; random when spin is set and rot is not) */
  rot?: number;
  /** rotation speed rad/s (random sign) */
  spin?: number;
  /** >0: stretch the sprite along its screen-space velocity (sparks, streaks, droplets) */
  stretch?: number;
  /** confetti-like flip flutter */
  flutter?: boolean;
  /** alpha/size over life: 'fade' (default), 'shrink' (cel puffs: stay opaque, pop in then shrink away), 'flash' (instant on, fast fade) */
  curve?: 'fade' | 'shrink' | 'flash';
  /** bounce / settle on this height */
  floor?: number;
  /** alpha multiplier 0..1 (default 1) */
  opacity?: number;
  /** fraction 0..1 of particles to skip on medium (detail particles) — default 0 */
}

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const CURVE = { fade: 0, shrink: 1, flash: 2 } as const;

/**
 * Pooled CPU-simulated sprite particles drawn in a single draw call (THREE.Points + atlas). Each
 * particle has its own sprite, rotation/spin, size- and colour-over-life, optional velocity stretch
 * (sparks become streaks) and confetti flutter. One instance for additive effects (sparks, flames,
 * stars) and one for alpha-blended ones (cel smoke puffs, dust, confetti, shards, droplets).
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  /** size, alpha, rotation, sprite */
  private data: Float32Array;
  /** velocity xyz + stretch (>0) / flutter (<0) */
  private pvel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private grow: Float32Array;
  private spin: Float32Array;
  private curve: Uint8Array;
  private floor: Float32Array;
  private opac: Float32Array;
  private cursor = 0;
  private alive = 0;
  private geom: THREE.BufferGeometry;
  private time = 0;

  constructor(max: number, additive: boolean, texture: THREE.Texture, intensity = 1) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.data = new Float32Array(max * 4);
    this.pvel = new Float32Array(max * 4);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.curve = new Uint8Array(max);
    this.floor = new Float32Array(max).fill(-1e9);
    this.opac = new Float32Array(max).fill(1);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('pdata', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('pvel', new THREE.BufferAttribute(this.pvel, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: texture }, scale: { value: 600 }, intensity: { value: intensity }, tint: { value: new THREE.Color(1, 1, 1) }, time: { value: 0 } },
      vertexShader: /* glsl */ `attribute vec4 pdata; attribute vec4 pvel; uniform float scale; uniform float time;
        varying vec3 vColor; varying float vAlpha; varying vec2 vRot; varying float vFrame; varying float vStretch;
        void main(){
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float depth = max(-mv.z, 0.05);
          float sz = pdata.x * scale / depth;
          float rot = pdata.z;
          float st = 1.0;
          gl_Position = projectionMatrix * mv;
          if (pvel.w > 0.0) {
            // velocity stretch: project a point a little along the velocity, measure it in pixels
            vec4 c2 = projectionMatrix * (modelViewMatrix * vec4(position + pvel.xyz * 0.035 * pvel.w, 1.0));
            vec2 a = gl_Position.xy / gl_Position.w, b = c2.xy / max(c2.w, 1e-3);
            float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
            vec2 d = (b - a) * vec2(aspect, 1.0) * scale * 0.55;
            float len = length(d);
            st = clamp(1.0 + len / max(sz, 1.0), 1.0, 7.0);
            if (len > 0.01) rot = atan(d.y, d.x);
          } else if (pvel.w < 0.0) {
            // confetti flip: squash the sprite periodically
            st = 1.0 / max(0.18, abs(cos(time * 7.0 + pdata.z * 5.0)));
          }
          vStretch = st;
          vRot = vec2(cos(rot), sin(rot));
          vFrame = pdata.w;
          gl_PointSize = pvel.w > 0.0 ? sz * st : sz;
          // fade particles that get right in front of the lens (no screen-filling smoke)
          vAlpha = pdata.y * smoothstep(0.35, 1.6, depth);
          if (vAlpha < 0.003) gl_PointSize = 0.0;
        }`,
      fragmentShader: /* glsl */ `uniform sampler2D map; uniform float intensity; uniform vec3 tint;
        varying vec3 vColor; varying float vAlpha; varying vec2 vRot; varying float vFrame; varying float vStretch;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          p.y = -p.y;
          p = vec2(vRot.x * p.x + vRot.y * p.y, -vRot.y * p.x + vRot.x * p.y);
          p.y *= vStretch;
          if (abs(p.x) > 0.5 || abs(p.y) > 0.5) discard;
          float f = floor(vFrame + 0.5);
          vec2 cell = vec2(mod(f, 4.0), floor(f / 4.0));
          vec2 uv = vec2(p.x + 0.5, 0.5 - p.y);
          // canvas textures are flipped (row 0 of the atlas is at the top = v near 1)
          vec4 t = texture2D(map, vec2((cell.x + uv.x) * 0.25, 1.0 - (cell.y + uv.y) * 0.25));
          float a = t.a * vAlpha;
          if (a < 0.01) discard;
          // hot white core for additive sparks so they bloom
          vec3 col = (vColor * t.rgb * intensity + vec3(pow(t.a, 4.0) * (intensity - 1.0) * 0.6)) * tint;
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      vertexColors: true,
    });
    this.points = new THREE.Points(this.geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  emit(o: EmitOptions): void {
    const n = o.count ?? 1;
    tmpColor.set(o.color);
    tmpColor2.set(o.color2 ?? o.color);
    const sp = o.spread ?? 0;
    const sprite = o.sprite ?? SPRITE.SOFT;
    const pw = o.stretch && o.stretch > 0 ? o.stretch : o.flutter ? -1 : 0;
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      if (this.life[i] <= 0) this.alive++;
      const i3 = i * 3, i4 = i * 4;
      this.pos[i3] = o.x;
      this.pos[i3 + 1] = o.y;
      this.pos[i3 + 2] = o.z;
      this.vel[i3] = (o.vx ?? 0) + (Math.random() - 0.5) * 2 * sp;
      this.vel[i3 + 1] = (o.vy ?? 0) + (Math.random() - 0.5) * 2 * sp;
      this.vel[i3 + 2] = (o.vz ?? 0) + (Math.random() - 0.5) * 2 * sp;
      this.c0[i3] = tmpColor.r; this.c0[i3 + 1] = tmpColor.g; this.c0[i3 + 2] = tmpColor.b;
      this.c1[i3] = tmpColor2.r; this.c1[i3 + 1] = tmpColor2.g; this.c1[i3 + 2] = tmpColor2.b;
      this.col[i3] = tmpColor.r; this.col[i3 + 1] = tmpColor.g; this.col[i3 + 2] = tmpColor.b;
      const life = (o.life ?? 0.6) * (0.75 + Math.random() * 0.5);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.baseSize[i] = (o.size ?? 0.5) * (0.8 + Math.random() * 0.4);
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 1;
      this.grow[i] = o.grow ?? 1;
      this.spin[i] = o.spin ? o.spin * (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.8) : 0;
      this.curve[i] = CURVE[o.curve ?? 'fade'];
      this.floor[i] = o.floor ?? -1e9;
      this.opac[i] = o.opacity ?? 1;
      this.data[i4] = 0;
      this.data[i4 + 1] = 0;
      this.data[i4 + 2] = o.rot ?? (o.spin || o.flutter || sprite !== SPRITE.SOFT ? Math.random() * Math.PI * 2 : 0);
      this.data[i4 + 3] = sprite;
      this.pvel[i4 + 3] = pw;
    }
  }

  update(dt: number): void {
    this.time += dt;
    (this.points.material as THREE.ShaderMaterial).uniforms.time.value = this.time;
    if (this.alive <= 0) {
      this.alive = 0;
      return;
    }
    let alive = 0;
    const P = this.pos, V = this.vel, D = this.data, PV = this.pvel, C = this.col;
    for (let i = 0; i < this.max; i++) {
      const i4 = i * 4;
      if (this.life[i] <= 0) {
        if (D[i4 + 1] !== 0) {
          D[i4 + 1] = 0;
          D[i4] = 0;
        }
        continue;
      }
      this.life[i] -= dt;
      alive++;
      const i3 = i * 3;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const d = Math.exp(-this.drag[i] * dt);
      V[i3] *= d;
      V[i3 + 1] = V[i3 + 1] * d - this.grav[i] * dt;
      V[i3 + 2] *= d;
      P[i3] += V[i3] * dt;
      P[i3 + 1] += V[i3 + 1] * dt;
      P[i3 + 2] += V[i3 + 2] * dt;
      if (P[i3 + 1] < this.floor[i]) {
        P[i3 + 1] = this.floor[i];
        V[i3 + 1] = Math.abs(V[i3 + 1]) * 0.3;
        V[i3] *= 0.6;
        V[i3 + 2] *= 0.6;
        this.spin[i] *= 0.5;
      }
      PV[i4] = V[i3]; PV[i4 + 1] = V[i3 + 1]; PV[i4 + 2] = V[i3 + 2];
      C[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      C[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      C[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      const g = 1 + (this.grow[i] - 1) * t;
      const cv = this.curve[i];
      let s = this.baseSize[i] * g;
      let a: number;
      if (cv === 1) {
        // cel puff: pop in (overshoot), hold, shrink away
        s *= t < 0.12 ? 0.4 + (t / 0.12) * 0.75 : t < 0.2 ? 1.15 - (t - 0.12) * 1.9 : 1 - Math.max(0, (t - 0.55) / 0.45) ** 2;
        a = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
      } else if (cv === 2) {
        a = (1 - t) * (1 - t);
      } else {
        a = t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9;
      }
      D[i4] = s;
      D[i4 + 1] = this.life[i] <= 0 ? 0 : a * this.opac[i];
      D[i4 + 2] += this.spin[i] * dt;
    }
    this.alive = alive;
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.pdata as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.pvel as THREE.BufferAttribute).needsUpdate = true;
  }

  /** live particle count (stats) */
  get count(): number {
    return this.alive;
  }

  setViewportHeight(h: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = h * 0.9;
  }

  dispose(): void {
    this.geom.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Soft round sprite (kept for callers that want a plain glow texture). */
export function makeSoftTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Fading tyre marks: a ring buffer of road-hugging quads drawn in one call. Each wheel continues its
 * own strip while drifting; vertices carry their birth time and fade out in the shader.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private birth: Float32Array;
  private geo: THREE.BufferGeometry;
  private cursor = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  private strips = new Map<number, { x: number; y: number; z: number; lx: number; lz: number; rx: number; rz: number; active: boolean }>();
  private time = 0;

  constructor(private max: number, life: number, color: THREE.ColorRepresentation, opacity: number) {
    this.pos = new Float32Array(max * 4 * 3);
    this.birth = new Float32Array(max * 4).fill(-1e6);
    const idx: number[] = [];
    for (let i = 0; i < max; i++) {
      const b = i * 4;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('birth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 }, life: { value: life }, color: { value: new THREE.Color(color) }, opacity: { value: opacity } }]),
      vertexShader: `#include <common>
        #include <fog_pars_vertex>
        attribute float birth; uniform float time; uniform float life; varying float vA;
        void main(){ vA = clamp(1.0 - (time - birth) / life, 0.0, 1.0); vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform vec3 color; uniform float opacity; varying float vA;
        #include <common>
        #include <fog_pars_fragment>
        void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(color, opacity * vA * vA);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Extend the strip `key` (kart*2+wheel) to a new contact point. */
  add(key: number, x: number, y: number, z: number, width = 0.34): void {
    let st = this.strips.get(key);
    if (!st) {
      st = { x, y, z, lx: x, lz: z, rx: x, rz: z, active: false };
      this.strips.set(key, st);
    }
    const dx = x - st.x, dz = z - st.z;
    const d = Math.hypot(dx, dz);
    if (st.active && d < 0.45) return;
    const nx = d > 1e-4 ? -dz / d : 0, nz = d > 1e-4 ? dx / d : 0;
    const lx = x + nx * width * 0.5, lz = z + nz * width * 0.5, rx = x - nx * width * 0.5, rz = z - nz * width * 0.5;
    if (st.active && d < 4) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const p = this.pos, o = i * 12;
      p[o] = st.lx; p[o + 1] = st.y; p[o + 2] = st.lz;
      p[o + 3] = st.rx; p[o + 4] = st.y; p[o + 5] = st.rz;
      p[o + 6] = lx; p[o + 7] = y; p[o + 8] = lz;
      p[o + 9] = rx; p[o + 10] = y; p[o + 11] = rz;
      this.birth.fill(this.time, i * 4, i * 4 + 4);
      this.dirtyMin = Math.min(this.dirtyMin, i);
      this.dirtyMax = Math.max(this.dirtyMax, i);
    }
    st.x = x; st.y = y; st.z = z;
    st.lx = lx; st.lz = lz; st.rx = rx; st.rz = rz;
    st.active = true;
  }

  /** The wheel stopped skidding: next add() starts a new strip. */
  lift(key: number): void {
    const st = this.strips.get(key);
    if (st) st.active = false;
  }

  update(dt: number): void {
    this.time += dt;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.time.value = this.time;
    if (this.dirtyMax < 0) return;
    const pa = this.geo.attributes.position as THREE.BufferAttribute, ba = this.geo.attributes.birth as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    ba.clearUpdateRanges();
    pa.addUpdateRange(this.dirtyMin * 12, (this.dirtyMax - this.dirtyMin + 1) * 12);
    ba.addUpdateRange(this.dirtyMin * 4, (this.dirtyMax - this.dirtyMin + 1) * 4);
    pa.needsUpdate = true;
    ba.needsUpdate = true;
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Per-theme particle colours (kicked-up ground material). */
export function sprayColor(theme: string | undefined, surface: string): { color: string; glow?: string; sprite?: SpriteId; chunk?: string } {
  if (surface === 'mud') return { color: '#7a5532', chunk: '#4e3420' };
  if (surface === 'milk') return { color: '#fffaf0', glow: '#ffffff', sprite: SPRITE.DROP };
  if (surface === 'ice') return { color: '#e6f6ff', glow: '#bfe9ff', sprite: SPRITE.SPARKLE };
  switch (theme) {
    case 'snow': return { color: '#f4f8ff', glow: '#ffffff', sprite: SPRITE.SNOW };
    case 'kitchen': return { color: '#ead9b8', chunk: '#d9b27a' };
    case 'dogpark': return { color: '#d8b47a', chunk: '#a8804a' };
    default: return { color: '#b9d48a', sprite: SPRITE.LEAF, chunk: '#5fae3a' };
  }
}

/** Both particle layers bundled, plus rings, electric arcs and skid marks (medium/high). */
export class Effects {
  readonly glow: ParticleSystem;
  readonly smoke: ParticleSystem;
  readonly skids: SkidMarks | null = null;
  /** additive shockwave rings */
  readonly rings: Rings;
  /** alpha-blended dust / splash rings */
  readonly dustRings: Rings;
  readonly arcs: Arcs;
  readonly quality: VfxQuality;
  readonly ultra: boolean;
  /** particle budget multiplier for this tier (low 0.35 .. ultra 1.4) */
  readonly density: number;
  /** 0 = day .. 1 = night: sparks glow brighter, boosting karts leave light trails */
  night = 0;
  private tex: THREE.Texture;
  private glowBase: number;
  constructor(scene: THREE.Scene, quality: VfxQuality, readonly theme?: string, ultra = false) {
    this.quality = quality;
    this.ultra = ultra && quality === 'high';
    this.tex = particleAtlas();
    const n = quality === 'low' ? 1200 : quality === 'medium' ? 2400 : this.ultra ? 6000 : 4000;
    this.density = quality === 'low' ? 0.35 : quality === 'medium' ? 0.6 : this.ultra ? 1.4 : 1;
    this.glowBase = quality === 'low' ? 1 : 1.35;
    this.glow = new ParticleSystem(n, true, this.tex, this.glowBase);
    this.smoke = new ParticleSystem(n, false, this.tex);
    this.rings = new Rings(quality === 'low' ? 12 : 32, true);
    this.dustRings = new Rings(quality === 'low' ? 8 : 24, false);
    this.arcs = new Arcs(6);
    scene.add(this.glow.points, this.smoke.points, this.rings.mesh, this.dustRings.mesh, this.arcs.lines);
    if (quality !== 'low') {
      const skidColor = theme === 'snow' ? '#5a6478' : theme === 'kitchen' ? '#3a2e2a' : theme === 'dogpark' ? '#5a3d22' : '#151517';
      this.skids = new SkidMarks(quality === 'high' ? 1600 : 500, quality === 'high' ? 9 : 4, skidColor, theme === 'snow' ? 0.32 : 0.42);
      scene.add(this.skids.mesh);
    }
  }
  /** Scale a particle count by the tier budget (at least 1 when n > 0). */
  n(count: number): number {
    if (count <= 0) return 0;
    const v = count * this.density;
    const f = Math.floor(v);
    return Math.max(1, f + (Math.random() < v - f ? 1 : 0));
  }
  /** Time-of-day: additive sparks get a hotter core at night so they bloom against the dark. */
  setNight(n: number): void {
    this.night = n;
    (this.glow.points.material as THREE.ShaderMaterial).uniforms.intensity.value = this.glowBase * (1 + 0.3 * n);
    // unlit smoke / dust would glow white against the night: tint it into the moonlight
    (this.smoke.points.material as THREE.ShaderMaterial).uniforms.tint.value.setRGB(1 - 0.62 * n, 1 - 0.56 * n, 1 - 0.4 * n);
    this.dustRings.tint.setRGB(1 - 0.62 * n, 1 - 0.56 * n, 1 - 0.4 * n);
  }
  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
    this.rings.update(dt);
    this.dustRings.update(dt);
    this.arcs.update(dt);
    // give the thin arc lines some body: glow sparks at their tips
    for (const t of this.arcs.tips) {
      if (Math.random() < 0.5) this.glow.emit({ x: t.x, y: t.y, z: t.z, color: '#9fdcff', size: 0.5, life: 0.12, curve: 'flash' });
    }
    this.skids?.update(dt);
  }
  setViewportHeight(h: number): void {
    this.glow.setViewportHeight(h);
    this.smoke.setViewportHeight(h);
  }
  /** Toon explosion of sparks + stars (+ confetti and streamers for big celebrations). */
  burst(x: number, y: number, z: number, colors: THREE.ColorRepresentation[], count = 30, speed = 8): void {
    const c = this.n(count);
    for (let i = 0; i < c; i++) {
      const col = colors[i % colors.length];
      if (i % 3 === 0) this.glow.emit({ x, y, z, spread: speed * 0.8, vy: speed * 0.5, color: col, sprite: SPRITE.STAR, size: 0.6, life: 0.8, gravity: 9, drag: 2.2, spin: 6, curve: 'shrink' });
      else this.glow.emit({ x, y, z, spread: speed, vy: speed * 0.5, color: col, size: 0.32, life: 0.6, gravity: 12, drag: 1.5, stretch: 1 });
    }
    this.glow.emit({ x, y, z, color: colors[0], sprite: SPRITE.BURST, size: 2.2 + speed * 0.1, life: 0.28, curve: 'flash', grow: 1.6 });
    // big celebrations (finish line, podium) also throw slow-falling confetti and streamers
    if (count >= 50 && this.quality !== 'low') {
      for (let i = 0; i < c; i++) {
        const streamer = i % 4 === 0;
        this.smoke.emit({
          x, y: y + 1, z, spread: speed * 0.7, vy: speed * 0.9, color: colors[(i * 7) % colors.length], sprite: streamer ? SPRITE.STREAMER : SPRITE.CONFETTI,
          size: streamer ? 0.7 : 0.34, life: 2.8, gravity: 3.5, drag: 1.2, flutter: !streamer, spin: streamer ? 3 : 4,
        });
      }
    }
  }
  /** Mini cel smoke puff (helper for one-liners). */
  puff(x: number, y: number, z: number, color: THREE.ColorRepresentation, size = 1, opts: Partial<EmitOptions> = {}): void {
    this.smoke.emit({ x, y, z, color, sprite: SPRITE.PUFF, size, life: 0.7, grow: 1.8, drag: 2.5, curve: 'shrink', spin: 1, ...opts });
  }
  dispose(): void {
    this.glow.points.removeFromParent();
    this.smoke.points.removeFromParent();
    this.skids?.mesh.removeFromParent();
    this.glow.dispose();
    this.smoke.dispose();
    this.rings.dispose();
    this.dustRings.dispose();
    this.arcs.dispose();
    this.skids?.dispose();
    // the atlas is shared between races (re-uploads on next use if a scene traversal disposed it)
  }
}

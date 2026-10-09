import * as THREE from 'three';

export interface EmitOptions {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  spread?: number;
  color: THREE.ColorRepresentation;
  size?: number;
  life?: number;
  gravity?: number;
  drag?: number;
  grow?: number; // size multiplier over life (smoke grows)
  count?: number;
}

const tmpColor = new THREE.Color();

/**
 * Pooled CPU-simulated point particles drawn in a single draw call. One instance for additive
 * effects (sparks, flames, confetti glow) and one for alpha-blended effects (smoke, dust, splashes).
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private grow: Float32Array;
  private cursor = 0;
  private geom: THREE.BufferGeometry;

  constructor(max: number, additive: boolean, texture: THREE.Texture, intensity = 1) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: texture }, scale: { value: 600 }, intensity: { value: intensity } },
      vertexShader: `attribute float psize; attribute float palpha; varying vec3 vColor; varying float vAlpha; uniform float scale;
        void main(){ vColor = color; vAlpha = palpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = psize * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; uniform float intensity; varying vec3 vColor; varying float vAlpha;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a*vAlpha < 0.01) discard;
          // hot white core for additive sparks so they bloom
          vec3 col = vColor * t.rgb * intensity + vec3(pow(t.a, 4.0) * (intensity - 1.0) * 0.6);
          gl_FragColor = vec4(col, t.a * vAlpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      vertexColors: true,
    });
    this.points = new THREE.Points(this.geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(o: EmitOptions): void {
    const n = o.count ?? 1;
    tmpColor.set(o.color);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const sp = o.spread ?? 0;
      this.pos[i * 3] = o.x;
      this.pos[i * 3 + 1] = o.y;
      this.pos[i * 3 + 2] = o.z;
      this.vel[i * 3] = (o.vx ?? 0) + (Math.random() - 0.5) * 2 * sp;
      this.vel[i * 3 + 1] = (o.vy ?? 0) + (Math.random() - 0.5) * 2 * sp;
      this.vel[i * 3 + 2] = (o.vz ?? 0) + (Math.random() - 0.5) * 2 * sp;
      this.col[i * 3] = tmpColor.r;
      this.col[i * 3 + 1] = tmpColor.g;
      this.col[i * 3 + 2] = tmpColor.b;
      const life = (o.life ?? 0.6) * (0.75 + Math.random() * 0.5);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.baseSize[i] = (o.size ?? 0.5) * (0.8 + Math.random() * 0.4);
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 1;
      this.grow[i] = o.grow ?? 1;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          this.size[i] = 0;
        }
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.baseSize[i] * (1 + (this.grow[i] - 1) * t);
      this.alpha[i] = t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9;
      if (this.life[i] <= 0) this.alpha[i] = 0;
    }
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.psize as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.palpha as THREE.BufferAttribute).needsUpdate = true;
  }

  setViewportHeight(h: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = h * 0.9;
  }

  dispose(): void {
    this.geom.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Soft round sprite used by all particles. */
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
export function sprayColor(theme: string | undefined, surface: string): { color: string; glow?: string } {
  if (surface === 'mud') return { color: '#6b4a2b' };
  if (surface === 'milk') return { color: '#fffaf0', glow: '#ffffff' };
  if (surface === 'ice') return { color: '#e6f6ff', glow: '#bfe9ff' };
  switch (theme) {
    case 'snow': return { color: '#f4f8ff', glow: '#ffffff' };
    case 'kitchen': return { color: '#ead9b8' };
    case 'dogpark': return { color: '#c4a06a' };
    default: return { color: '#9bbf6a' };
  }
}

/** Both particle layers bundled, plus skid marks (medium/high). */
export class Effects {
  readonly glow: ParticleSystem;
  readonly smoke: ParticleSystem;
  readonly skids: SkidMarks | null = null;
  readonly quality: 'low' | 'medium' | 'high';
  private tex: THREE.Texture;
  constructor(scene: THREE.Scene, quality: 'low' | 'medium' | 'high', readonly theme?: string) {
    this.quality = quality;
    this.tex = makeSoftTexture();
    const n = quality === 'low' ? 1200 : quality === 'medium' ? 2200 : 3000;
    this.glow = new ParticleSystem(n, true, this.tex, quality === 'low' ? 1 : 1.35);
    this.smoke = new ParticleSystem(n, false, this.tex);
    scene.add(this.glow.points, this.smoke.points);
    if (quality !== 'low') {
      const skidColor = theme === 'snow' ? '#5a6478' : theme === 'kitchen' ? '#3a2e2a' : theme === 'dogpark' ? '#5a3d22' : '#151517';
      this.skids = new SkidMarks(quality === 'high' ? 1600 : 500, quality === 'high' ? 9 : 4, skidColor, theme === 'snow' ? 0.32 : 0.42);
      scene.add(this.skids.mesh);
    }
  }
  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
    this.skids?.update(dt);
  }
  setViewportHeight(h: number): void {
    this.glow.setViewportHeight(h);
    this.smoke.setViewportHeight(h);
  }
  burst(x: number, y: number, z: number, colors: THREE.ColorRepresentation[], count = 30, speed = 8): void {
    for (let i = 0; i < count; i++) {
      this.glow.emit({ x, y, z, spread: speed, vy: speed * 0.5, color: colors[i % colors.length], size: 0.5, life: 0.7, gravity: 12, drag: 1.5 });
    }
    // big celebrations (finish line, podium) also throw slow-falling confetti
    if (count >= 50 && this.quality !== 'low') {
      for (let i = 0; i < count; i++) {
        this.smoke.emit({ x, y: y + 1, z, spread: speed * 0.7, vy: speed * 0.9, color: colors[(i * 7) % colors.length], size: 0.32, life: 2.6, gravity: 3.5, drag: 1.2 });
      }
    }
  }
  dispose(): void {
    this.glow.points.removeFromParent();
    this.smoke.points.removeFromParent();
    this.skids?.mesh.removeFromParent();
    this.glow.dispose();
    this.smoke.dispose();
    this.skids?.dispose();
    this.tex.dispose();
  }
}

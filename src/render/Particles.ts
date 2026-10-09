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

  constructor(max: number, additive: boolean, texture: THREE.Texture) {
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
      uniforms: { map: { value: texture }, scale: { value: 600 } },
      vertexShader: `attribute float psize; attribute float palpha; varying vec3 vColor; varying float vAlpha; uniform float scale;
        void main(){ vColor = color; vAlpha = palpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = psize * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec3 vColor; varying float vAlpha;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a*vAlpha < 0.01) discard; gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha); }`,
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

/** Both particle layers bundled. */
export class Effects {
  readonly glow: ParticleSystem;
  readonly smoke: ParticleSystem;
  private tex: THREE.Texture;
  constructor(scene: THREE.Scene, quality: 'low' | 'medium' | 'high') {
    this.tex = makeSoftTexture();
    const n = quality === 'low' ? 1200 : 3000;
    this.glow = new ParticleSystem(n, true, this.tex);
    this.smoke = new ParticleSystem(n, false, this.tex);
    scene.add(this.glow.points, this.smoke.points);
  }
  update(dt: number): void {
    this.glow.update(dt);
    this.smoke.update(dt);
  }
  setViewportHeight(h: number): void {
    this.glow.setViewportHeight(h);
    this.smoke.setViewportHeight(h);
  }
  burst(x: number, y: number, z: number, colors: THREE.ColorRepresentation[], count = 30, speed = 8): void {
    for (let i = 0; i < count; i++) {
      this.glow.emit({ x, y, z, spread: speed, vy: speed * 0.5, color: colors[i % colors.length], size: 0.5, life: 0.7, gravity: 12, drag: 1.5 });
    }
  }
  dispose(): void {
    this.glow.points.removeFromParent();
    this.smoke.points.removeFromParent();
    this.glow.dispose();
    this.smoke.dispose();
    this.tex.dispose();
  }
}

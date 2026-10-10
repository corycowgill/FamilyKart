import * as THREE from 'three';
import type { TrackDef } from '../sim/types';
import type { Quality } from './Renderer';

/**
 * Navy Pier summer fireworks: shells launch from the lake (or ahead of the camera), climb with a
 * sparkling trail and burst into peonies, rings, willows and crackling palms in Chicago-flag colours.
 * Every spark lives in one pooled, CPU-simulated additive Points cloud (one draw call), shared by all
 * split-screen views. Bursts also flash the sky / ambient via the `onFlash` callback.
 */

const PALETTES: string[][] = [
  ['#ff2338', '#ff5a6a'], // Chicago-star red
  ['#ffffff', '#dfefff'],
  ['#7fd3ff', '#b8e8ff'], // flag light blue
  ['#ffc43a', '#ffe08a'], // gold
  ['#ff2338', '#ffffff'],
  ['#7fd3ff', '#ffffff'],
  ['#ffc43a', '#ff2338'],
];

type Pattern = 'peony' | 'ring' | 'willow' | 'palm' | 'crackle';

interface Shell {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  fuse: number;
  pattern: Pattern;
  colors: THREE.Color[];
  big: number;
}

export class Fireworks {
  readonly points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private base: Float32Array;
  private size: Float32Array;
  private bright: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private flick: Float32Array;
  private cursor = 0;
  private geo = new THREE.BufferGeometry();
  private shells: Shell[] = [];
  private timer = 0.4;
  private opening = 3;
  private finaleQueue: Array<{ t: number; x: number; z: number; y: number }> = [];
  private time = 0;
  private lake: { x: number; z: number } | null;
  private shoreX: number;
  private burstCount: number;
  private interval: number;
  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private active = 0;
  onFlash: ((c: THREE.Color, amount: number) => void) | null = null;

  constructor(def: TrackDef, quality: Quality, private rate: number) {
    this.max = quality === 'high' ? 3600 : 1600;
    this.burstCount = quality === 'high' ? 120 : 64;
    this.interval = (quality === 'high' ? 1.1 : 2.2) / Math.max(0.1, rate);
    const lm = def.landmarks.find((l) => l.kind === 'lake') ?? null;
    const shore = def.landmarks.find((l) => l.kind === 'shore') ?? null;
    this.shoreX = shore ? shore.x : lm ? lm.x - 150 : NaN;
    this.lake = lm ? { x: Math.max(lm.x, this.shoreX + 170), z: lm.z } : shore ? { x: shore.x + 220, z: shore.z } : null;
    const n = this.max;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.base = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.bright = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.flick = new Float32Array(n);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('fsize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: /* glsl */ `attribute float fsize; uniform float scale; varying vec3 vCol;
        void main(){ vCol = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = fsize > 0.0 ? clamp(fsize * scale / -mv.z, 1.5, 160.0) : 0.0;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `varying vec3 vCol;
        void main(){ vec2 p = gl_PointCoord - 0.5; float r2 = dot(p, p) * 4.0;
          float a = exp(-r2 * 6.0) * 0.55 + exp(-r2 * 30.0);
          if (a < 0.004) discard;
          vec3 c = vCol * a + vec3(exp(-r2 * 60.0)) * dot(vCol, vec3(0.25));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'fireworks';
  }

  setViewportHeight(h: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = h * 0.9;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: THREE.Color, size: number, life: number, grav: number, drag: number, bright: number, flick = 0): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o = i * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
    this.base[o] = c.r; this.base[o + 1] = c.g; this.base[o + 2] = c.b;
    this.size[i] = size;
    this.bright[i] = bright;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.flick[i] = flick;
  }

  /** Pick a launch point: out over the lake when it's roughly in view, else ahead of the camera. */
  private launchSite(): { x: number; z: number; y: number } {
    const fx = this.camFwd.x, fz = this.camFwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    if (this.lake) {
      const lx = this.lake.x + (Math.random() - 0.5) * 120;
      const lz = THREE.MathUtils.clamp(this.camPos.z + (Math.random() - 0.5) * 360, this.lake.z - 600, this.lake.z + 600);
      const dx = lx - this.camPos.x, dz = lz - this.camPos.z;
      const dot = (dx * fx + dz * fz) / (fl * (Math.hypot(dx, dz) || 1));
      if (dot > 0.35 || Math.random() < 0.25) return { x: lx, z: lz, y: 0 };
    }
    return this.aheadSite();
  }

  private aheadSite(): { x: number; z: number; y: number } {
    const fx = this.camFwd.x, fz = this.camFwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    const d = 170 + Math.random() * 130;
    const side = (Math.random() - 0.5) * 1.1;
    const ax = fx / fl, az = fz / fl;
    return { x: this.camPos.x + (ax * Math.cos(side) - az * Math.sin(side)) * d, z: this.camPos.z + (az * Math.cos(side) + ax * Math.sin(side)) * d, y: this.camPos.y - 10 };
  }

  private launch(site?: { x: number; z: number; y: number }, big = 1): void {
    const s = site ?? this.launchSite();
    const pal = PALETTES[Math.floor(Math.random() * PALETTES.length)];
    const patterns: Pattern[] = ['peony', 'peony', 'ring', 'willow', 'palm', 'crackle'];
    const apex = 70 + Math.random() * 45 + (big > 1 ? 15 : 0);
    const vy = 62 + Math.random() * 10;
    this.shells.push({
      x: s.x, y: s.y, z: s.z,
      vx: (Math.random() - 0.5) * 6, vy, vz: (Math.random() - 0.5) * 6,
      fuse: Math.min(2.6, (apex) / vy * 1.35),
      pattern: patterns[Math.floor(Math.random() * patterns.length)],
      colors: pal.map((c) => new THREE.Color(c)),
      big,
    });
  }

  private burst(sh: Shell): void {
    const n = Math.round(this.burstCount * sh.big * (sh.pattern === 'ring' ? 0.6 : 1));
    const speed = (sh.pattern === 'willow' ? 36 : sh.pattern === 'palm' ? 50 : 46) * Math.sqrt(sh.big);
    // ring orientation
    const ax = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.4, Math.random() - 0.5).normalize();
    const u = new THREE.Vector3(1, 0, 0).cross(ax).normalize();
    const w = ax.clone().cross(u);
    for (let i = 0; i < n; i++) {
      let dx: number, dy: number, dz: number;
      if (sh.pattern === 'ring') {
        const a = (i / n) * Math.PI * 2;
        dx = u.x * Math.cos(a) + w.x * Math.sin(a);
        dy = u.y * Math.cos(a) + w.y * Math.sin(a);
        dz = u.z * Math.cos(a) + w.z * Math.sin(a);
      } else if (sh.pattern === 'palm') {
        const arm = i % 7, a = (arm / 7) * Math.PI * 2;
        const el = 0.35 + Math.random() * 0.2;
        dx = Math.cos(a) * Math.cos(el); dy = Math.sin(el); dz = Math.sin(a) * Math.cos(el);
        const k = 0.6 + (i / n) * 0.5;
        dx *= k; dy *= k; dz *= k;
      } else {
        // fibonacci sphere with jitter: even, round peonies
        const t = (i + 0.5) / n;
        const phi = Math.acos(1 - 2 * t), th = Math.PI * (1 + Math.sqrt(5)) * i;
        dx = Math.sin(phi) * Math.cos(th); dy = Math.cos(phi); dz = Math.sin(phi) * Math.sin(th);
        const j = 0.88 + Math.random() * 0.2;
        dx *= j; dy *= j; dz *= j;
      }
      const c = sh.colors[i % sh.colors.length];
      const willow = sh.pattern === 'willow';
      const life = willow ? 3.2 + Math.random() * 0.8 : 1.7 + Math.random() * 0.7;
      const gold = willow ? this.tmpC.set('#ffc860') : c;
      this.spawn(sh.x, sh.y, sh.z, dx * speed + sh.vx * 0.3, dy * speed, dz * speed + sh.vz * 0.3, gold, willow ? 3.4 : 4.2, life, willow ? 7 : 9, willow ? 1.5 : 1.15, willow ? 2.4 : 3.6, sh.pattern === 'crackle' ? 1 : 0);
    }
    // bright flash at the heart of the burst (blooms)
    this.spawn(sh.x, sh.y, sh.z, 0, 0, 0, sh.colors[0], 70 * sh.big, 0.3, 0, 0, 3);
    this.spawn(sh.x, sh.y, sh.z, 0, 0, 0, this.tmpC.set('#ffffff'), 30 * sh.big, 0.18, 0, 0, 4);
    if (this.onFlash) {
      const d = Math.hypot(sh.x - this.camPos.x, sh.z - this.camPos.z);
      this.onFlash(sh.colors[0], Math.min(0.9, (180 / Math.max(120, d)) * 0.55 * sh.big));
    }
  }

  /** A big celebratory salvo in front of the camera (player finished). */
  finale(): void {
    const fx = this.camFwd.x, fz = this.camFwd.z, fl = Math.hypot(fx, fz) || 1;
    for (let i = 0; i < 9; i++) {
      const a = (i / 8 - 0.5) * 1.3;
      const d = 170 + Math.random() * 60;
      const ax = fx / fl, az = fz / fl;
      this.finaleQueue.push({
        t: this.time + i * 0.22 + Math.random() * 0.1,
        x: this.camPos.x + (ax * Math.cos(a) - az * Math.sin(a)) * d,
        z: this.camPos.z + (az * Math.cos(a) + ax * Math.sin(a)) * d,
        y: this.camPos.y - 8,
      });
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.camPos.copy(camera.position);
    camera.getWorldDirection(this.camFwd);
    this.timer -= dt;
    if (this.timer <= 0 && this.rate > 0) {
      const salvo = Math.random() < 0.18 ? 3 : 1;
      // open the show where the player is looking
      if (this.opening > 0) {
        this.opening--;
        this.launch(this.aheadSite());
      } else for (let i = 0; i < salvo; i++) this.launch();
      this.timer = this.interval * (0.6 + Math.random() * 0.8) * (salvo > 1 ? 1.8 : 1);
    }
    for (let i = this.finaleQueue.length - 1; i >= 0; i--) {
      if (this.finaleQueue[i].t <= this.time) {
        this.launch(this.finaleQueue[i], 1.35);
        this.finaleQueue.splice(i, 1);
      }
    }
    // shells: climb, trail, burst
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      sh.vy -= 9.8 * dt;
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      sh.z += sh.vz * dt;
      sh.fuse -= dt;
      this.spawn(sh.x, sh.y, sh.z, (Math.random() - 0.5) * 2, -3 - Math.random() * 3, (Math.random() - 0.5) * 2, this.tmpC.set('#ffd28a'), 2.2, 0.5 + Math.random() * 0.3, 4, 1, 2.2, 0.6);
      if (sh.fuse <= 0 || sh.vy < 4) {
        this.burst(sh);
        this.shells.splice(i, 1);
      }
    }
    // sparks
    let alive = 0;
    const t = this.time;
    for (let i = 0; i < this.max; i++) {
      const o = i * 3;
      if (this.life[i] <= 0) {
        if (this.size[i] !== 0) this.size[i] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[o] *= d;
      this.vel[o + 1] = this.vel[o + 1] * d - this.grav[i] * dt;
      this.vel[o + 2] *= d;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      let b = this.bright[i] * Math.pow(k, 0.8);
      // crackle: strobe in the second half of life
      if (this.flick[i] > 0 && k < 0.6) b *= Math.sin(t * 50 + i * 12.9) > 0.1 ? 1.6 : 0.08;
      // colour cools toward warm white-gold as sparks die
      const warm = 1 - k;
      this.col[o] = (this.base[o] + (1 - this.base[o]) * warm * 0.3) * b;
      this.col[o + 1] = (this.base[o + 1] * (1 - warm * 0.25)) * b;
      this.col[o + 2] = (this.base[o + 2] * (1 - warm * 0.6)) * b;
      if (this.life[i] <= 0) this.size[i] = 0;
    }
    this.active = alive;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.fsize as THREE.BufferAttribute).needsUpdate = true;
  }

  /** live spark count (debug / tests) */
  get liveParticles(): number {
    return this.active;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

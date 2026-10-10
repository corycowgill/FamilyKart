import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PostFX, type PostConfig } from './PostFX';

export type Quality = 'low' | 'medium' | 'high';

export interface Viewport {
  camera: THREE.PerspectiveCamera;
  /** normalized rect: x, y (from bottom), w, h */
  rect: [number, number, number, number];
  /**
   * optional per-view effect drivers: speed relative to max speed (speed lines / vignette), boost 0..1
   * (radial blur, chromatic aberration), hit flash 0..1 + colour, world position of the exhaust heat shimmer
   */
  fx?: { speed: number; boost: number; hit?: number; hitColor?: THREE.Color; heatWorld?: THREE.Vector3 };
}

/** Sky/lighting description used to build a matching reflection environment. */
export interface EnvLighting {
  skyTop: string;
  skyBottom: string;
  sun: string;
  ground: string;
  fog?: string;
}

/** What each quality tier turns on. Read by Environment / TrackView / Particles too. */
export const QUALITY_TIERS: Record<Quality, { dprMax: number; post: PostConfig | null }> = {
  high: { dprMax: 2, post: { bloomLevels: 5, bloomDiv: 2, samples: 4, speedLines: true, ao: 1, screenFx: true } },
  medium: { dprMax: 1.25, post: { bloomLevels: 3, bloomDiv: 4, samples: 4, speedLines: true } },
  low: { dprMax: 0.85, post: null },
};

/** Opt-in "Ultra" on top of high: wider/denser AO, higher pixel ratio, SMAA when MSAA is missing (+ 4096 shadows, more particles elsewhere). */
export const ULTRA_TIER: { dprMax: number; post: PostConfig } = {
  dprMax: 2.5, post: { bloomLevels: 6, bloomDiv: 2, samples: 4, speedLines: true, ao: 2, screenFx: true, smaa: true },
};

/** Owns the WebGL renderer, canvas sizing, quality settings, post-processing and (split-screen) viewport rendering. */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  quality: Quality = 'high';
  /** Ultra graphics (opt-in, desktop): only takes effect on top of 'high'. */
  private ultraOn = false;
  width = 1;
  height = 1;
  private onResizeCbs: Array<() => void> = [];
  private post: PostFX | null = null;
  private postOk = true;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    // we render several passes per frame (split-screen, post) so count draw calls per frame ourselves
    this.gl.info.autoReset = false;
    this.canvas = this.gl.domElement;
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);
    window.addEventListener('resize', () => this.resize());
    this.setQuality('high');
    this.resize();
  }

  private env: THREE.Texture | null = null;
  /** Shared prefiltered environment map so clear-coat paint and chrome have something to reflect. */
  envMap(): THREE.Texture {
    if (!this.env) {
      const pm = new THREE.PMREMGenerator(this.gl);
      this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    return this.env;
  }

  private skyEnvs: Array<{ key: string; tex: THREE.Texture }> = [];
  /**
   * Outdoor reflection environment matching a track's sky: gradient dome, warm sun hot-spot and a
   * ground hemisphere, so kart clear-coat reflects the actual sky colours instead of a grey room.
   * Cached per lighting setup (one PMREM bake when the track changes).
   */
  skyEnvMap(l: EnvLighting, sunDir: THREE.Vector3): THREE.Texture {
    const key = JSON.stringify(l) + sunDir.toArray().map((v) => v.toFixed(2)).join();
    const hit = this.skyEnvs.find((e) => e.key === key);
    if (hit) return hit.tex;
    // keep a few (attract-mode track + race track); drop the oldest
    if (this.skyEnvs.length >= 3) this.skyEnvs.shift()!.tex.dispose();
    const scene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(l.skyTop) },
        bottom: { value: new THREE.Color(l.skyBottom) },
        ground: { value: new THREE.Color(l.ground).multiplyScalar(0.55) },
        sun: { value: new THREE.Color(l.sun) },
        sunDir: { value: sunDir.clone().normalize() },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 ground; uniform vec3 sun; uniform vec3 sunDir; varying vec3 vDir;
        void main(){ vec3 d = normalize(vDir);
          vec3 sky = mix(bottom * 1.1, top, pow(clamp(d.y * 1.3 + 0.05, 0.0, 1.0), 0.7));
          vec3 c = d.y > -0.02 ? sky : mix(bottom * 0.6, ground, clamp(-d.y * 4.0, 0.0, 1.0));
          float s = max(dot(d, sunDir), 0.0);
          c += sun * (pow(s, 24.0) * 3.0 + pow(s, 4.0) * 0.3);
          gl_FragColor = vec4(c, 1.0); }`,
    });
    scene.add(new THREE.Mesh(geo, mat));
    const pm = new THREE.PMREMGenerator(this.gl);
    const tex = pm.fromScene(scene, 0.02).texture;
    pm.dispose();
    geo.dispose();
    mat.dispose();
    this.skyEnvs.push({ key, tex });
    return tex;
  }

  onResize(cb: () => void): void {
    this.onResizeCbs.push(cb);
  }

  /** true when Ultra rendering is active (requested and quality is high) */
  get ultra(): boolean {
    return this.ultraOn && this.quality === 'high';
  }

  /** Toggle Ultra graphics (rebuilds the post chain; new races pick up shadows / particle budgets). */
  setUltra(on: boolean): void {
    if (on === this.ultraOn) return;
    this.ultraOn = on;
    this.setQuality(this.quality);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const tier = this.ultra ? ULTRA_TIER : QUALITY_TIERS[q];
    const dpr = Math.min(window.devicePixelRatio || 1, tier.dprMax);
    this.gl.setPixelRatio(dpr);
    this.gl.shadowMap.enabled = q !== 'low';
    // rebuild the post chain for the new tier (dispose GPU targets of the old one)
    this.post?.dispose();
    this.post = null;
    if (tier.post && this.postOk) {
      try {
        this.post = new PostFX(this.gl, tier.post);
      } catch (e) {
        console.warn('[gfx] post-processing unavailable, rendering directly', e);
        this.postOk = false;
      }
    }
    this.resize();
  }

  resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.gl.setSize(this.width, this.height);
    if (this.post) {
      const pr = this.gl.getPixelRatio();
      this.post.setSize(this.width * pr, this.height * pr);
    }
    this.onResizeCbs.forEach((c) => c());
  }

  render(scene: THREE.Scene, viewports: Viewport[]): void {
    const gl = this.gl;
    gl.info.reset();
    const full = viewports.length === 1 && viewports[0].rect[2] === 1 && viewports[0].rect[3] === 1;
    const prevShadowAuto = gl.shadowMap.autoUpdate;
    // post-processing is opt-in per scene (race scenes set scene.userData.grade via Environment);
    // other scenes (showroom, podium) keep rendering straight to the canvas as they were authored
    const post = scene.userData.grade ? this.post : null;
    if (post) {
      const pr = gl.getPixelRatio();
      const W = Math.floor(this.width * pr), H = Math.floor(this.height * pr);
      viewports.forEach((v, i) => {
        const [x, y, w, h] = v.rect;
        const px = Math.floor(x * W), py = Math.floor(y * H), pw = Math.ceil(w * W), ph = Math.ceil(h * H);
        this.fitCamera(v.camera, full ? this.width / this.height : pw / ph);
        post.bindViewport(px, py, pw, ph);
        // the shadow map only depends on the light, render it once per frame
        if (i > 0) gl.shadowMap.autoUpdate = false;
        gl.render(scene, v.camera);
      });
      gl.shadowMap.autoUpdate = prevShadowAuto;
      const flare = scene.userData.sunFlare as { dir: THREE.Vector3 } | undefined;
      post.finish(scene, viewports.map((v) => ({
        rect: v.rect, speed: v.fx?.speed ?? 0, boost: v.fx?.boost ?? 0, sun: flare ? sunScreen(v.camera, flare.dir) : undefined,
        hit: v.fx?.hit, hitColor: v.fx?.hitColor, heat: v.fx?.heatWorld ? heatScreen(v.camera, v.fx.heatWorld) : undefined, camera: v.camera,
      })), this.width, this.height);
      return;
    }
    gl.setRenderTarget(null);
    if (full) {
      const cam = viewports[0].camera;
      this.fitCamera(cam, this.width / this.height);
      gl.setScissorTest(false);
      gl.setViewport(0, 0, this.width, this.height);
      gl.render(scene, cam);
      return;
    }
    gl.setScissorTest(true);
    viewports.forEach((v, i) => {
      const [x, y, w, h] = v.rect;
      const px = Math.floor(x * this.width), py = Math.floor(y * this.height), pw = Math.ceil(w * this.width), ph = Math.ceil(h * this.height);
      gl.setViewport(px, py, pw, ph);
      gl.setScissor(px, py, pw, ph);
      this.fitCamera(v.camera, pw / ph);
      if (i > 0) gl.shadowMap.autoUpdate = false;
      gl.render(scene, v.camera);
    });
    gl.shadowMap.autoUpdate = prevShadowAuto;
    gl.setScissorTest(false);
  }

  private fitCamera(cam: THREE.PerspectiveCamera, aspect: number): void {
    if (Math.abs(cam.aspect - aspect) > 1e-3) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
  }
}

const tmpHeat = new THREE.Vector3();
/** Exhaust position in viewport uv + strength (0 when behind the camera / off screen). */
function heatScreen(cam: THREE.PerspectiveCamera, p: THREE.Vector3): [number, number, number] {
  tmpHeat.copy(p).project(cam);
  if (tmpHeat.z > 1 || Math.abs(tmpHeat.x) > 1.2 || Math.abs(tmpHeat.y) > 1.2) return [0, 0, 0];
  return [tmpHeat.x * 0.5 + 0.5, tmpHeat.y * 0.5 + 0.5, 1];
}

const tmpSun = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
/** Sun position in viewport uv (0..1) plus a 0..1 visibility (in front of the camera, fading off-screen). */
function sunScreen(cam: THREE.PerspectiveCamera, dir: THREE.Vector3): [number, number, number] {
  cam.getWorldDirection(tmpFwd);
  const facing = tmpFwd.dot(dir);
  if (facing <= 0.05) return [0, 0, 0];
  tmpSun.copy(cam.position).addScaledVector(dir, 1000).project(cam);
  const x = tmpSun.x * 0.5 + 0.5, y = tmpSun.y * 0.5 + 0.5;
  const edge = Math.max(Math.abs(tmpSun.x), Math.abs(tmpSun.y));
  const vis = Math.min(1, Math.max(0, (1.25 - edge) / 0.35)) * Math.min(1, (facing - 0.05) * 4);
  return [x, y, vis];
}

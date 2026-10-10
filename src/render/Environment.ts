import * as THREE from 'three';
import type { TrackDef } from '../sim/types';
import type { GradeSettings } from './PostFX';
import type { Quality } from './Renderer';
import { todLook, type TimeOfDay, type TodLook } from './timeOfDay';

/** Direction (and distance) from the focus point to the sun. Shared with water / reflection env. */
export const SUN_OFFSET = new THREE.Vector3(-120, 220, 90);

/**
 * Per-theme sun placement. Chicago: low golden-hour sun out over Lake Michigan (east), so the
 * skyline glows and the lake throws sun glints toward the camera. Snow: very low dusk sun.
 */
export function sunOffsetFor(theme?: string): THREE.Vector3 {
  switch (theme) {
    case 'chicago': return new THREE.Vector3(175, 118, -75);
    case 'snow': return new THREE.Vector3(-170, 62, 115);
    default: return SUN_OFFSET.clone();
  }
}

const SKY_VERT = /* glsl */ `varying vec3 vDir;
  void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 top; uniform vec3 bottom; uniform vec3 haze; uniform vec3 sunCol; uniform vec3 sunDir;
  uniform vec3 cloudLit; uniform vec3 cloudShade; uniform float time; uniform float cover; uniform float sunDisc;
  uniform vec3 midCol; uniform float midAmt; uniform float discCos; uniform float glowAmt; uniform float stars; uniform float flash; uniform vec3 flashCol; uniform float haloAmt; uniform float discEdge;
  varying vec3 vDir;
  float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5, s = 0.0;
    for (int i = 0; i < CLOUD_OCTAVES; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
    return s; }
  void main(){
    vec3 d = normalize(vDir);
    float h = d.y;
    // gradient: warm hazy horizon band -> saturated zenith
    vec3 c = mix(bottom, top, pow(smoothstep(-0.04, 0.45, h), 0.85));
    c = mix(c, haze, exp(-max(h, 0.0) * 30.0) * 0.35);
    // sunset: pink/purple band between the orange horizon and the deep zenith
    c = mix(c, midCol, midAmt * smoothstep(-0.02, 0.12, h) * (1.0 - smoothstep(0.12, 0.5, h)));
    if (h < 0.0) c = mix(c, haze * 0.92, clamp(-h * 6.0, 0.0, 1.0));
    float s = max(dot(d, sunDir), 0.0);
    // broad warm glow around the sun + a soft disc that blooms
    c += sunCol * (pow(s, 10.0) * 0.12 + pow(s, 64.0) * 0.32) * haloAmt;
    c += sunCol * glowAmt * (pow(s, 3.0) * 0.18 + pow(s, 24.0) * 0.45);
    float disc = smoothstep(discCos - discEdge, discCos, s);
    #if MOON
      // craters: soft darker blotches on the lunar disc
      vec3 md = d - sunDir;
      float cr = sin(md.x * 900.0 + 1.3) * sin(md.y * 760.0 + 0.4) * sin(md.z * 830.0);
      disc *= 0.82 + 0.18 * cr;
    #endif
    c += sunCol * disc * sunDisc;
    #if STARS
    if (h > 0.0) {
      vec3 sp = d * 160.0;
      vec3 cell = floor(sp);
      float hs = hash3(cell);
      if (hs > 0.985) {
        vec3 off = vec3(hash3(cell + 7.1), hash3(cell + 3.7), hash3(cell + 1.9)) * 0.6 + 0.2;
        float dd = length(fract(sp) - off);
        float tw = 0.65 + 0.35 * sin(time * (1.5 + hs * 40.0) + hs * 300.0);
        float b = smoothstep(0.16, 0.0, dd) * tw * (hs > 0.997 ? 2.4 : 1.0);
        vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash3(cell + 11.0));
        c += sc * b * stars * smoothstep(0.03, 0.3, h) * (1.0 - smoothstep(0.995, 1.0, s));
      }
    }
    #endif
    #if CLOUD_OCTAVES > 0
    if (h > 0.0) {
      vec2 uv = d.xz / (h + 0.18) * 1.6 + vec2(time * 0.006, time * 0.002);
      float n = fbm(uv);
      float a = smoothstep(cover, cover + 0.07, n);
      // fake lighting: sample toward the sun, denser there = shaded underside
      float n2 = fbm(uv + sunDir.xz * 0.14);
      float lit = clamp(0.6 + (n - n2) * 4.0 + (n - cover) * 1.5, 0.0, 1.0);
      vec3 cc = mix(cloudShade, cloudLit, smoothstep(0.45, 0.6, lit));
      // silver lining near the sun
      cc += sunCol * pow(s, 16.0) * 0.35;
      a *= smoothstep(0.02, 0.2, h) * 0.95;
      c = mix(c, cc, a);
    }
    #endif
    c += flashCol * flash * (0.35 + 0.65 * smoothstep(-0.1, 0.5, h));
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** Per-theme look: grade (post), exposure, cloud cover. */
interface ThemeLook {
  grade: Partial<GradeSettings>;
  clouds: boolean;
  cover: number;
  sunDisc: number;
  /** key light tweaks: intensity multiplier and a colour to lean toward */
  sunMul: number;
  sunWarm: string;
  sunWarmAmt: number;
  hemiMul: number;
}

function themeLook(theme: string | undefined): ThemeLook {
  switch (theme) {
    case 'kitchen':
      return { grade: { saturation: 1.16, contrast: 1.1, tint: '#fff8f0', shadowTint: '#f0f2ff', highlightTint: '#fffaf2', vignette: 0.26, bloomThreshold: 1.6, bloomStrength: 0.5 }, clouds: false, cover: 1, sunDisc: 0, sunMul: 1.05, sunWarm: '#ffe2b8', sunWarmAmt: 0.1, hemiMul: 1 };
    case 'snow':
      // cozy blue dusk: cool shadows, warm highlights, low threshold so street lamps / windows / holiday lights glow
      return {
        grade: { saturation: 1.12, contrast: 1.07, tint: '#ffffff', shadowTint: '#d6e0ff', highlightTint: '#fff0dc', vignette: 0.34, exposure: 0.97, bloomThreshold: 0.9, bloomStrength: 0.8 },
        clouds: true, cover: 0.58, sunDisc: 2.2, sunMul: 1.15, sunWarm: '#ff9e6e', sunWarmAmt: 0.2, hemiMul: 1.1,
      };
    case 'chicago':
      // "Sweet Home Chicago" postcard: golden low sun, teal-blue shadows, neon/marquee lights bloom
      return {
        grade: { saturation: 1.16, contrast: 1.09, tint: '#fffaf2', shadowTint: '#e6efff', highlightTint: '#fff6e8', vignette: 0.28, bloomThreshold: 1.1, bloomStrength: 0.7 },
        clouds: true, cover: 0.6, sunDisc: 3, sunMul: 1.3, sunWarm: '#ffc887', sunWarmAmt: 0.22, hemiMul: 1.0,
      };
    default:
      return { grade: { saturation: 1.16, contrast: 1.08, tint: '#fff4e4', vignette: 0.26 }, clouds: true, cover: 0.62, sunDisc: 3, sunMul: 1.08, sunWarm: '#ffd9a8', sunWarmAmt: 0.15, hemiMul: 1 };
  }
}

/** Gradient sky dome with sun + stylised clouds, sun/hemisphere/rim lighting, shadows and fog driven by TrackDef.lighting. */
export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly rim: THREE.DirectionalLight | null = null;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private sunOffset: THREE.Vector3;
  /** normalized direction toward the sun (for water / reflections) */
  readonly sunDir: THREE.Vector3;
  private shadowExt = 0;
  private lastFocus = new THREE.Vector3();
  private lastT = 0;
  private speed = 0;
  private t0 = performance.now();
  private lightBasis: { right: THREE.Vector3; up: THREE.Vector3 } | null = null;

  /** time-of-day look (null = authored daylight) */
  readonly tod: TodLook | null;
  private hemiBase = 1;
  private hemiCol = new THREE.Color();
  private hemiFlash = new THREE.Color();
  private flashAmt = 0;

  /** Ultra graphics: 4096 shadow map with a tighter fit around the player */
  private ultra: boolean;
  /** warm ground-bounce fill (fake GI) from below on medium/high */
  readonly bounce: THREE.DirectionalLight | null = null;

  constructor(scene: THREE.Scene, authored: TrackDef['lighting'], private quality: Quality, theme?: string, tod: TimeOfDay = 'day', def?: TrackDef, ultra = false) {
    this.ultra = ultra && quality === 'high';
    const look = themeLook(theme);
    const tl = def ? todLook(def, tod) : null;
    this.tod = tl;
    const lighting = tl ? tl.lighting : authored;
    this.sunOffset = tl ? tl.keyOffset.clone() : sunOffsetFor(theme);
    this.sunDir = this.sunOffset.clone().normalize();
    const top = new THREE.Color(lighting.skyTop);
    const bottom = new THREE.Color(lighting.skyBottom);
    const sunCol = new THREE.Color(lighting.sun);
    const haze = tl ? new THREE.Color(tl.sky.haze) : bottom.clone().lerp(new THREE.Color(lighting.fog), 0.35);
    const cloudLit = tl ? new THREE.Color(tl.sky.cloudLit) : new THREE.Color('#ffffff').lerp(sunCol, 0.12).multiplyScalar(1.12);
    const cloudShade = tl ? new THREE.Color(tl.sky.cloudShade) : top.clone().lerp(new THREE.Color('#ffffff'), 0.6).lerp(new THREE.Color('#c8c4e8'), 0.25).multiplyScalar(0.9);
    const octaves = !look.clouds ? 0 : quality === 'high' ? 4 : quality === 'medium' ? 3 : 2;
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      defines: { CLOUD_OCTAVES: octaves, STARS: tl && tl.sky.stars > 0 ? 1 : 0, MOON: tl?.sky.moon ? 1 : 0 },
      uniforms: {
        top: { value: top },
        bottom: { value: bottom },
        haze: { value: haze },
        sunCol: { value: tl ? new THREE.Color(tl.sky.discCol) : sunCol.clone() },
        sunDir: { value: this.sunOffset.clone().normalize() },
        cloudLit: { value: cloudLit },
        cloudShade: { value: cloudShade },
        time: { value: 0 },
        cover: { value: tl ? tl.sky.cover : look.cover },
        sunDisc: { value: tl ? tl.sky.disc : look.sunDisc },
        midCol: { value: new THREE.Color(tl?.sky.mid ?? '#000000') },
        midAmt: { value: tl?.sky.midAmt ?? 0 },
        discCos: { value: tl?.sky.discCos ?? 0.9993 },
        glowAmt: { value: tl?.sky.glow ?? 0 },
        stars: { value: tl?.sky.stars ?? 0 },
        flash: { value: 0 },
        haloAmt: { value: tl?.sky.moon ? 0.3 : 1 },
        discEdge: { value: tl?.sky.moon ? 0.00005 : 0.0008 },
        flashCol: { value: new THREE.Color() },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.group.add(this.sky);

    this.hemiBase = tl ? tl.hemiIntensity : look.hemiMul;
    this.hemi = new THREE.HemisphereLight(lighting.ambient, lighting.ground, this.hemiBase);
    this.hemiCol.copy(this.hemi.color);
    this.group.add(this.hemi);
    // slightly warmer, punchier key light
    const keyCol = tl ? new THREE.Color(tl.keyColor) : sunCol.clone().lerp(new THREE.Color(look.sunWarm), look.sunWarmAmt);
    this.sun = new THREE.DirectionalLight(keyCol, tl ? tl.keyIntensity : lighting.sunIntensity * look.sunMul);
    this.sun.position.copy(this.sunOffset);
    if (quality !== 'low') {
      this.sun.castShadow = true;
      const size = this.ultra ? 4096 : quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      const cam = this.sun.shadow.camera;
      cam.near = 10;
      cam.far = 600;
      this.setShadowExtent(this.ultra ? 36 : quality === 'high' ? 45 : 55);
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.035;
      // cool sky-coloured rim/back light gives silhouettes some definition (no shadows)
      this.rim = tl?.rim
        ? new THREE.DirectionalLight(tl.rim.color, tl.rim.intensity)
        : new THREE.DirectionalLight(top.clone().lerp(new THREE.Color('#ffffff'), 0.5), 0.55);
      this.group.add(this.rim, this.rim.target);
      // stylised bounce light: sunlit ground colour reflected back up onto karts / undersides (cheap GI feel)
      const nightAmt = tl ? tl.night : 0;
      const bounceCol = new THREE.Color(lighting.ground).lerp(keyCol, 0.35);
      this.bounce = new THREE.DirectionalLight(bounceCol, (indoorTheme(theme) ? 0.18 : 0.28) * (1 - nightAmt * 0.85));
      this.group.add(this.bounce, this.bounce.target);
    }
    this.group.add(this.sun);
    this.group.add(this.sun.target);
    scene.add(this.group);
    scene.fog = new THREE.Fog(lighting.fog, lighting.fogNear, lighting.fogFar);
    scene.background = new THREE.Color(lighting.skyBottom);
    scene.userData.grade = tl ? { ...look.grade, ...tl.grade } : look.grade;
    scene.userData.timeOfDay = tod;
    if (tl && tl.flare > 0) scene.userData.sunFlare = { dir: this.sunDir.clone(), strength: tl.flare, color: tl.flareColor };
  }

  /** Brief sky + ambient flash (fireworks bursts). Decays on its own in follow(). */
  flash(color: THREE.Color, amount: number): void {
    const prev = this.flashAmt;
    this.flashAmt = Math.min(1.2, this.flashAmt + amount);
    this.hemiFlash.lerp(color, prev > 0 ? amount / this.flashAmt : 1);
  }

  private setShadowExtent(ext: number): void {
    if (ext === this.shadowExt) return;
    this.shadowExt = ext;
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.updateProjectionMatrix();
  }

  /**
   * Keep the shadow frustum centred on (and a little ahead of) the focus point. The frustum grows
   * with speed and is snapped to whole shadow-map texels so shadows don't shimmer while driving.
   */
  follow(focus: THREE.Vector3, camera?: THREE.Camera): void {
    const now = performance.now();
    const dt = (now - this.lastT) / 1000;
    if (this.lastT > 0 && dt > 0 && dt < 0.5) {
      const v = Math.hypot(focus.x - this.lastFocus.x, focus.z - this.lastFocus.z) / dt;
      this.speed += (Math.min(v, 60) - this.speed) * Math.min(1, dt * 2);
    }
    this.lastT = now;
    this.lastFocus.copy(focus);
    this.skyMat.uniforms.time.value = (now - this.t0) / 1000;
    if (this.flashAmt > 0 || this.skyMat.uniforms.flash.value !== 0) {
      this.flashAmt = Math.max(0, this.flashAmt - Math.max(0, Math.min(0.1, dt)) * 2.5);
      this.skyMat.uniforms.flash.value = this.flashAmt * 0.06;
      this.skyMat.uniforms.flashCol.value.copy(this.hemiFlash);
      this.hemi.intensity = this.hemiBase * (1 + this.flashAmt * 0.45);
      this.hemi.color.copy(this.hemiCol).lerp(this.hemiFlash, this.flashAmt * 0.18);
    }
    this.sky.position.copy(focus);

    const center = tmpC.copy(focus);
    if (this.sun.castShadow) {
      const base = this.ultra ? 30 : this.quality === 'high' ? 40 : 50;
      const ext = base + Math.round(Math.min(1, this.speed / 35) * 4) * 5;
      this.setShadowExtent(ext);
      if (camera) {
        camera.getWorldDirection(tmpF);
        tmpF.y = 0;
        if (tmpF.lengthSq() > 1e-4) center.addScaledVector(tmpF.normalize(), ext * 0.45);
      }
      // texel snapping in light space
      if (!this.lightBasis) {
        const dir = this.sunOffset.clone().normalize();
        const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
        const up = new THREE.Vector3().crossVectors(dir, right).normalize();
        this.lightBasis = { right, up };
      }
      const texel = (ext * 2) / this.sun.shadow.mapSize.x;
      const { right, up } = this.lightBasis;
      const r = center.dot(right), u = center.dot(up);
      const dr = Math.round(r / texel) * texel - r, du = Math.round(u / texel) * texel - u;
      center.addScaledVector(right, dr).addScaledVector(up, du);
    }
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).add(this.sunOffset);
    if (this.bounce) {
      this.bounce.target.position.copy(focus);
      this.bounce.position.set(focus.x - this.sunOffset.x * 0.3, focus.y - 40, focus.z - this.sunOffset.z * 0.3);
    }
    if (this.rim) {
      this.rim.target.position.copy(focus);
      this.rim.position.set(focus.x - this.sunOffset.x, focus.y + this.sunOffset.y * 0.35, focus.z - this.sunOffset.z);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.sun.shadow.map?.dispose();
  }
}

const indoorTheme = (t?: string) => t === 'kitchen';
const tmpC = new THREE.Vector3();
const tmpF = new THREE.Vector3();

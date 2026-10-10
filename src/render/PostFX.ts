import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** Per-scene colour grade. Stored on `scene.userData.grade` (see Environment) so each track keeps its mood. */
export interface GradeSettings {
  exposure: number;
  saturation: number;
  contrast: number;
  /** multiplicative display-space tint (warmth) */
  tint: THREE.ColorRepresentation;
  vignette: number;
  /** split-tone "LUT": multiplier for the shadows and for the highlights */
  shadowTint: THREE.ColorRepresentation;
  highlightTint: THREE.ColorRepresentation;
  bloomStrength: number;
  bloomThreshold: number;
}

export const DEFAULT_GRADE: GradeSettings = {
  exposure: 1, saturation: 1.12, contrast: 1.05, tint: '#fff8ee', vignette: 0.28, shadowTint: '#ffffff', highlightTint: '#ffffff', bloomStrength: 0.6, bloomThreshold: 1.2,
};

export interface PostViewport {
  /** normalized rect x, y (from bottom), w, h */
  rect: [number, number, number, number];
  /** 0..1+ forward speed relative to max speed (drives speed lines) */
  speed: number;
  /** 0..1 boost amount */
  boost: number;
  /** sun in viewport-local uv (x, y) + visibility 0..1 for the sunset lens flare */
  sun?: [number, number, number];
}

export interface PostConfig {
  /** bloom chain levels (each half the previous); 0 disables bloom */
  bloomLevels: number;
  /** divisor of the drawing buffer size for the first bloom level */
  bloomDiv: number;
  samples: number;
  speedLines: boolean;
}

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Lightweight post pipeline: MSAA HDR scene target -> dual-filter bloom (a handful of passes at
 * 1/2..1/32 resolution) -> one final pass doing bloom composite + ACES tone mapping + sRGB + colour
 * grade + vignette + speed lines. Split-screen viewports are rendered into the same scene target
 * (scissored) and graded in that single final pass, with per-viewport vignette and speed lines.
 */
export class PostFX {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private prefilterMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  private finalMat: THREE.ShaderMaterial;
  private w = 1;
  private h = 1;
  private time = 0;
  private lastT = performance.now();
  private smooth = [
    { speed: 0, boost: 0 },
    { speed: 0, boost: 0 },
  ];
  private tint = new THREE.Color();

  constructor(private gl: THREE.WebGLRenderer, readonly cfg: PostConfig) {
    const hdrType = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, samples: cfg.samples, depthBuffer: true, stencilBuffer: false });
    this.sceneRT.texture.generateMipmaps = false;
    for (let i = 0; i < cfg.bloomLevels; i++) {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, depthBuffer: false, stencilBuffer: false });
      rt.texture.generateMipmaps = false;
      rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
      this.bloomRTs.push(rt);
    }
    this.prefilterMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 }, knee: { value: 0.5 } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `uniform sampler2D tSrc; uniform vec2 texel; uniform float threshold; uniform float knee; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tSrc, vUv + texel * vec2(-1.0,-1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0,-1.0)).rgb
                 + texture2D(tSrc, vUv + texel * vec2(-1.0,1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0,1.0)).rgb;
          c = min(c * 0.25, vec3(24.0));
          float br = max(c.r, max(c.g, c.b));
          float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee + 1e-4);
          float w = max(soft, br - threshold) / max(br, 1e-4);
          gl_FragColor = vec4(c * w, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.downMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
          c += texture2D(tSrc, vUv + texel * vec2(-1.0,-1.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(1.0,-1.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(-1.0,1.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(1.0,1.0)).rgb;
          gl_FragColor = vec4(c * 0.125, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tSrc, vUv + texel * vec2(-2.0, 0.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(2.0, 0.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(0.0, -2.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(0.0, 2.0)).rgb;
          c += texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb * 2.0;
          c += texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb * 2.0;
          c += texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb * 2.0;
          c += texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb * 2.0;
          gl_FragColor = vec4(c / 12.0, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false, depthWrite: false,
    });
    this.finalMat = new THREE.ShaderMaterial({
      defines: { BLOOM: cfg.bloomLevels > 0 ? 1 : 0, SPEED_LINES: cfg.speedLines ? 1 : 0 },
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tBloom: { value: this.bloomRTs[0]?.texture ?? null },
        bloomStrength: { value: DEFAULT_GRADE.bloomStrength },
        exposure: { value: 1 },
        saturation: { value: 1 },
        contrast: { value: 1 },
        tint: { value: new THREE.Color(1, 1, 1) },
        shadowTint: { value: new THREE.Color(1, 1, 1) },
        highlightTint: { value: new THREE.Color(1, 1, 1) },
        vignette: { value: 0.3 },
        time: { value: 0 },
        vp0: { value: new THREE.Vector4(0, 0, 1, 1) },
        vp1: { value: new THREE.Vector4(0, 0, 0, 0) },
        fx0: { value: new THREE.Vector2() },
        fx1: { value: new THREE.Vector2() },
        aspect: { value: 1 },
        sun0: { value: new THREE.Vector3() },
        sun1: { value: new THREE.Vector3() },
        flareCol: { value: new THREE.Color() },
        flareStrength: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform sampler2D tBloom; uniform float bloomStrength; uniform float exposure;
        uniform float saturation; uniform float contrast; uniform vec3 tint; uniform vec3 shadowTint; uniform vec3 highlightTint; uniform float vignette; uniform float time;
        uniform vec4 vp0; uniform vec4 vp1; uniform vec2 fx0; uniform vec2 fx1; uniform float aspect;
        uniform vec3 sun0; uniform vec3 sun1; uniform vec3 flareCol; uniform float flareStrength;
        varying vec2 vUv;
        float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main(){
          vec3 c = texture2D(tScene, vUv).rgb;
          #if BLOOM
            c += texture2D(tBloom, vUv).rgb * bloomStrength;
          #endif
          bool second = vp1.z > 0.0 && vUv.x >= vp1.x && vUv.x <= vp1.x + vp1.z && vUv.y >= vp1.y && vUv.y <= vp1.y + vp1.w;
          vec4 r = second ? vp1 : vp0;
          vec2 luv = (vUv - r.xy) / r.zw;
          float la = aspect * r.z / r.w;
          if (flareStrength > 0.0) {
            // cheap sunset lens flare: halo + anamorphic streak + ghosts, occluded by sampling bloom at the sun
            vec3 sn = second ? sun1 : sun0;
            if (sn.z > 0.001) {
              vec2 sp = sn.xy;
              float occ = 1.0;
              #if BLOOM
                vec3 bs = texture2D(tBloom, r.xy + clamp(sp, 0.0, 1.0) * r.zw).rgb;
                occ = smoothstep(0.08, 0.7, dot(bs, vec3(0.3333)));
              #endif
              vec2 dv = (luv - sp) * vec2(la, 1.0);
              float dl = length(dv);
              vec3 f = flareCol * (exp(-dl * 6.0) * 0.55 + exp(-abs(dv.y) * 120.0) * exp(-abs(dv.x) * 2.2) * 0.4);
              vec2 axis = vec2(0.5) - sp;
              for (int i = 0; i < 4; i++) {
                float fi = float(i);
                float k = 0.6 + fi * 0.48;
                vec2 gp = sp + axis * k * 2.0;
                float rad = 0.03 + 0.025 * mod(fi * 1.7, 3.0);
                float gd = length((luv - gp) * vec2(la, 1.0));
                vec3 gc = mix(vec3(1.0, 0.55, 0.35), vec3(0.55, 0.7, 1.0), fract(fi * 0.37 + 0.2));
                f += gc * smoothstep(rad, rad * 0.55, gd) * 0.07;
              }
              c += f * sn.z * occ * flareStrength;
            }
          }
          gl_FragColor = vec4(c * exposure, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          c = gl_FragColor.rgb;
          // display-space grade: saturation, contrast (around mid grey), warm tint
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, saturation);
          c = (c - 0.5) * contrast + 0.5;
          c *= tint * mix(shadowTint, highlightTint, smoothstep(0.08, 0.85, l));
          // viewport-local effects
          vec2 fx = second ? fx1 : fx0;
          vec2 d = (luv - vec2(0.5, 0.55)) * vec2(la, 1.0);
          float rad = length(d) / max(1.0, la * 0.62);
          c *= 1.0 - vignette * smoothstep(0.35, 1.05, length((luv - 0.5) * vec2(1.0, 0.85)) * 1.25);
          #if SPEED_LINES
            float amt = clamp((fx.x - 0.72) * 2.4, 0.0, 1.0) * 0.55 + fx.y * 0.6;
            if (amt > 0.01) {
              float ang = atan(d.y, d.x) * 30.0;
              float id = floor(ang);
              float f = fract(ang);
              float hs = hash11(id + floor(time * 14.0) * 13.7);
              float line = step(0.78, hs) * smoothstep(0.42, 0.0, abs(f - 0.5)) ;
              float mask = smoothstep(0.32 + hs * 0.18, 0.95, rad);
              vec3 lc = mix(vec3(1.0), vec3(1.0, 0.85, 0.55), fx.y);
              c = mix(c, lc, clamp(line * mask * amt * 0.55, 0.0, 1.0));
            }
          #endif
          // dither to avoid banding in sky gradients
          c += (hash21(gl_FragCoord.xy + fract(time) * 61.0) - 0.5) / 255.0;
          gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
  }

  setSize(w: number, h: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.sceneRT.setSize(w, h);
    let bw = Math.max(1, Math.round(w / this.cfg.bloomDiv)), bh = Math.max(1, Math.round(h / this.cfg.bloomDiv));
    for (const rt of this.bloomRTs) {
      rt.setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
  }

  /** Bind the HDR scene target for a viewport (rect in drawing-buffer pixels). */
  bindViewport(px: number, py: number, pw: number, ph: number): void {
    this.sceneRT.viewport.set(px, py, pw, ph);
    this.sceneRT.scissor.set(px, py, pw, ph);
    this.sceneRT.scissorTest = true;
    this.gl.setRenderTarget(this.sceneRT);
  }

  /** Bloom + final grade to the canvas. */
  finish(scene: THREE.Scene, viewports: PostViewport[], cssW: number, cssH: number): void {
    const gl = this.gl;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.time += dt;
    const grade = { ...DEFAULT_GRADE, ...(scene.userData.grade as Partial<GradeSettings> | undefined) };
    const prevAutoClear = gl.autoClear;
    gl.autoClear = false;
    this.sceneRT.scissorTest = false;
    this.sceneRT.viewport.set(0, 0, this.w, this.h);
    this.sceneRT.scissor.set(0, 0, this.w, this.h);
    const n = this.bloomRTs.length;
    if (n > 0) {
      const src = this.sceneRT;
      this.prefilterMat.uniforms.tSrc.value = src.texture;
      this.prefilterMat.uniforms.texel.value.set(0.5 / this.bloomRTs[0].width, 0.5 / this.bloomRTs[0].height);
      this.prefilterMat.uniforms.threshold.value = grade.bloomThreshold;
      this.prefilterMat.uniforms.knee.value = grade.bloomThreshold * 0.2;
      this.pass(this.prefilterMat, this.bloomRTs[0]);
      for (let i = 1; i < n; i++) {
        const s = this.bloomRTs[i - 1];
        this.downMat.uniforms.tSrc.value = s.texture;
        this.downMat.uniforms.texel.value.set(1 / s.width, 1 / s.height);
        this.pass(this.downMat, this.bloomRTs[i]);
      }
      for (let i = n - 1; i > 0; i--) {
        const s = this.bloomRTs[i];
        this.upMat.uniforms.tSrc.value = s.texture;
        this.upMat.uniforms.texel.value.set(0.5 / s.width, 0.5 / s.height);
        this.pass(this.upMat, this.bloomRTs[i - 1]);
      }
    }
    const u = this.finalMat.uniforms;
    u.bloomStrength.value = grade.bloomStrength / Math.max(1, n * 0.5);
    u.exposure.value = grade.exposure;
    u.saturation.value = grade.saturation;
    u.contrast.value = grade.contrast;
    u.tint.value.copy(this.tint.set(grade.tint));
    u.shadowTint.value.set(grade.shadowTint);
    u.highlightTint.value.set(grade.highlightTint);
    u.vignette.value = grade.vignette;
    u.time.value = this.time;
    u.aspect.value = cssW / Math.max(1, cssH);
    const flare = scene.userData.sunFlare as { strength: number; color: THREE.ColorRepresentation } | undefined;
    u.flareStrength.value = flare ? flare.strength : 0;
    if (flare) u.flareCol.value.set(flare.color);
    const k = 1 - Math.exp(-6 * dt);
    viewports.slice(0, 2).forEach((v, i) => {
      const s = this.smooth[i];
      s.speed += (v.speed - s.speed) * k;
      s.boost += (v.boost - s.boost) * k;
      (i === 0 ? u.vp0 : u.vp1).value.set(...v.rect);
      (i === 0 ? u.fx0 : u.fx1).value.set(s.speed, s.boost);
      const sn = v.sun;
      (i === 0 ? u.sun0 : u.sun1).value.set(sn ? sn[0] : 0, sn ? sn[1] : 0, sn ? sn[2] : 0);
    });
    if (viewports.length < 2) u.vp1.value.set(0, 0, 0, 0);
    gl.setRenderTarget(null);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, cssW, cssH);
    this.quad.material = this.finalMat;
    this.quad.render(gl);
    gl.autoClear = prevAutoClear;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.gl.setRenderTarget(target);
    this.quad.material = mat;
    this.quad.render(this.gl);
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.bloomRTs.forEach((r) => r.dispose());
    this.prefilterMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.finalMat.dispose();
    this.quad.dispose();
  }
}

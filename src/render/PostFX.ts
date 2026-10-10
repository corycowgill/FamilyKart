import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

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
  /** 0..1 hit flash amount + its colour (screen-edge vignette pulse) */
  hit?: number;
  hitColor?: THREE.Color;
  /** exhaust heat shimmer: viewport-local uv + strength */
  heat?: [number, number, number];
  /** viewport camera (ambient occlusion reconstructs view-space positions from depth) */
  camera?: THREE.PerspectiveCamera;
}

export interface PostConfig {
  /** bloom chain levels (each half the previous); 0 disables bloom */
  bloomLevels: number;
  /** divisor of the drawing buffer size for the first bloom level */
  bloomDiv: number;
  samples: number;
  speedLines: boolean;
  /** screen-space ambient occlusion: 0 off, 1 half-res 8 taps (high), 2 half-res 14 taps + wider blur (ultra) */
  ao?: 0 | 1 | 2;
  /** boost radial blur + chromatic aberration + exhaust heat shimmer (high) */
  screenFx?: boolean;
  /** SMAA on the final image when the GPU has no MSAA (ultra) */
  smaa?: boolean;
}

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;


/** Shared GLSL: viewport selection (split-screen) + view-space reconstruction from the depth buffer. */
const VIEW_GLSL = /* glsl */ `
  uniform vec4 vp0; uniform vec4 vp1; uniform vec4 cam0; uniform vec4 cam1;
  bool isSecond(vec2 uv){ return vp1.z > 0.0 && uv.x >= vp1.x && uv.x <= vp1.x + vp1.z && uv.y >= vp1.y && uv.y <= vp1.y + vp1.w; }
  float viewZOf(float d, vec4 cam){ return (cam.z * cam.w) / ((cam.w - cam.z) * d - cam.w); }
  vec3 viewPosOf(vec2 uv, float d, vec4 r, vec4 cam){
    float z = viewZOf(d, cam);
    vec2 ndc = ((uv - r.xy) / r.zw) * 2.0 - 1.0;
    return vec3(ndc.x * cam.x * cam.y * -z, ndc.y * cam.x * -z, z);
  }
`;

/**
 * Lightweight post pipeline: MSAA HDR scene target -> (optional) half-res SAO ambient occlusion from the
 * resolved depth -> dual-filter bloom (a handful of passes at 1/2..1/32 resolution) -> one final pass
 * doing AO + bloom composite + boost radial blur / chromatic aberration / heat shimmer + ACES tone
 * mapping + sRGB + colour grade + vignette (speed, hit flash) + speed lines. Split-screen viewports are
 * rendered into the same scene target (scissored) and graded in that single final pass, with
 * per-viewport camera, vignette and effects.
 */
export class PostFX {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private aoBlurRT: THREE.WebGLRenderTarget | null = null;
  private aoMat: THREE.ShaderMaterial | null = null;
  private aoBlurMat: THREE.ShaderMaterial | null = null;
  private ldrRT: THREE.WebGLRenderTarget | null = null;
  private smaa: SMAAPass | null = null;
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
    { speed: 0, boost: 0, heat: 0 },
    { speed: 0, boost: 0, heat: 0 },
  ];
  private tint = new THREE.Color();

  constructor(private gl: THREE.WebGLRenderer, readonly cfg: PostConfig) {
    const hdrType = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const maxSamples = gl.capabilities.maxSamples ?? 0;
    const samples = Math.min(cfg.samples, maxSamples);
    const ao = cfg.ao ?? 0;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, samples, depthBuffer: true, stencilBuffer: false });
    this.sceneRT.texture.generateMipmaps = false;
    if (ao > 0) {
      // depth resolved alongside the MSAA colour (blit) so the AO pass can read it
      const dt = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      this.sceneRT.depthTexture = dt;
      const mk = () => {
        const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
        rt.texture.generateMipmaps = false;
        rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
        return rt;
      };
      this.aoRT = mk();
      this.aoBlurRT = mk();
      const taps = ao >= 2 ? 14 : 8;
      this.aoMat = new THREE.ShaderMaterial({
        defines: { TAPS: taps },
        uniforms: {
          tDepth: { value: dt }, res: { value: new THREE.Vector2(1, 1) }, radius: { value: ao >= 2 ? 1.8 : 1.5 }, intensity: { value: ao >= 2 ? 3.2 : 2.8 },
          vp0: { value: new THREE.Vector4(0, 0, 1, 1) }, vp1: { value: new THREE.Vector4() }, cam0: { value: new THREE.Vector4(0.6, 1.7, 0.3, 4000) }, cam1: { value: new THREE.Vector4(0.6, 1.7, 0.3, 4000) },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */ `uniform sampler2D tDepth; uniform vec2 res; uniform float radius; uniform float intensity; varying vec2 vUv;
          ${VIEW_GLSL}
          void main(){
            bool second = isSecond(vUv);
            vec4 r = second ? vp1 : vp0; vec4 cam = second ? cam1 : cam0;
            float d = texture2D(tDepth, vUv).x;
            if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
            vec3 P = viewPosOf(vUv, d, r, cam);
            vec3 N = normalize(cross(dFdx(P), dFdy(P)));
            if (dot(N, P) > 0.0) N = -N;
            float uvR = min(radius / (-P.z * cam.x * 2.0) * r.w, 0.12 * r.w);
            if (uvR * res.y < 1.5) { gl_FragColor = vec4(1.0); return; }
            float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            float sum = 0.0;
            float r2 = radius * radius;
            for (int i = 0; i < TAPS; i++) {
              float fi = (float(i) + noise) / float(TAPS);
              float a = (float(i) + noise) * 2.39996 * 1.0 + noise * 6.283;
              vec2 off = vec2(cos(a), sin(a)) * sqrt(fi) * uvR;
              off.x *= res.y / res.x;
              vec2 suv = clamp(vUv + off, r.xy + 0.0005, r.xy + r.zw - 0.0005);
              float sd = texture2D(tDepth, suv).x;
              vec3 S = viewPosOf(suv, sd, r, cam);
              vec3 v = S - P;
              float vv = dot(v, v);
              float vn = dot(v, N);
              float f = max(r2 - vv, 0.0) / r2;
              sum += f * f * max(vn - 0.02 * -P.z * 0.05 - 0.015, 0.0) / (vv + 0.02);
            }
            float ao = max(0.0, 1.0 - intensity * 2.0 * sum / float(TAPS));
            ao = mix(ao, 1.0, smoothstep(45.0, 110.0, -P.z));
            gl_FragColor = vec4(ao, -P.z / 200.0, 0.0, 1.0);
          }`,
        depthTest: false, depthWrite: false,
      });
      this.aoBlurMat = new THREE.ShaderMaterial({
        defines: { WIDE: ao >= 2 ? 1 : 0 },
        uniforms: { tAO: { value: this.aoRT.texture }, texel: { value: new THREE.Vector2() } },
        vertexShader: VERT,
        fragmentShader: /* glsl */ `uniform sampler2D tAO; uniform vec2 texel; varying vec2 vUv;
          void main(){
            vec4 c = texture2D(tAO, vUv);
            float sum = c.x, wsum = 1.0;
            #if WIDE
              const int R = 2;
            #else
              const int R = 1;
            #endif
            for (int y = -R; y <= R; y++) for (int x = -R; x <= R; x++) {
              if (x == 0 && y == 0) continue;
              vec4 s = texture2D(tAO, vUv + vec2(float(x), float(y)) * texel * 1.5);
              float w = exp(-abs(s.y - c.y) * 200.0 / max(c.y * 200.0, 1.0) * 6.0);
              sum += s.x * w; wsum += w;
            }
            gl_FragColor = vec4(sum / wsum, c.y, 0.0, 1.0);
          }`,
        depthTest: false, depthWrite: false,
      });
    }
    for (let i = 0; i < cfg.bloomLevels; i++) {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: hdrType, depthBuffer: false, stencilBuffer: false });
      rt.texture.generateMipmaps = false;
      rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
      this.bloomRTs.push(rt);
    }
    if (cfg.smaa && samples < 2) {
      this.ldrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
      this.ldrRT.texture.generateMipmaps = false;
      this.smaa = new SMAAPass(1, 1);
      this.smaa.renderToScreen = true;
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
      defines: { BLOOM: cfg.bloomLevels > 0 ? 1 : 0, SPEED_LINES: cfg.speedLines ? 1 : 0, AO: ao > 0 ? 1 : 0, SCREENFX: cfg.screenFx ? 1 : 0 },
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tBloom: { value: this.bloomRTs[0]?.texture ?? null },
        tAO: { value: this.aoBlurRT?.texture ?? null },
        aoStrength: { value: ao >= 2 ? 0.85 : 0.75 },
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
        cam0: { value: new THREE.Vector4() },
        cam1: { value: new THREE.Vector4() },
        fx0: { value: new THREE.Vector4() },
        fx1: { value: new THREE.Vector4() },
        heat0: { value: new THREE.Vector2() },
        heat1: { value: new THREE.Vector2() },
        hit0: { value: new THREE.Color() },
        hit1: { value: new THREE.Color() },
        aspect: { value: 1 },
        sun0: { value: new THREE.Vector3() },
        sun1: { value: new THREE.Vector3() },
        flareCol: { value: new THREE.Color() },
        flareStrength: { value: 0 },
        toneExp: { value: 1 },
      },
      toneMapped: false,
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tAO; uniform float aoStrength; uniform float bloomStrength; uniform float exposure;
        uniform float saturation; uniform float contrast; uniform vec3 tint; uniform vec3 shadowTint; uniform vec3 highlightTint; uniform float vignette; uniform float time;
        uniform vec4 fx0; uniform vec4 fx1; uniform vec2 heat0; uniform vec2 heat1; uniform vec3 hit0; uniform vec3 hit1; uniform float aspect;
        uniform vec3 sun0; uniform vec3 sun1; uniform vec3 flareCol; uniform float flareStrength;
        varying vec2 vUv;
        ${VIEW_GLSL}
        uniform float toneExp;
        vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
        vec3 acesTone(vec3 color){
          const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
          const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
          color *= toneExp / 0.6;
          color = ACESOutputMat * RRTAndODTFit(ACESInputMat * color);
          return clamp(color, 0.0, 1.0);
        }
        vec3 toSRGB(vec3 c){ return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }
        float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        vec3 sceneAt(vec2 uv){
          vec3 c = texture2D(tScene, uv).rgb;
          #if AO
            // contact shadows only darken the lit scene (not the bloom glow)
            float ao = texture2D(tAO, uv).r;
            c *= mix(1.0, ao, aoStrength);
          #endif
          #if BLOOM
            c += texture2D(tBloom, uv).rgb * bloomStrength;
          #endif
          return c;
        }
        void main(){
          bool second = isSecond(vUv);
          vec4 r = second ? vp1 : vp0;
          vec2 luv = (vUv - r.xy) / r.zw;
          float la = aspect * r.z / r.w;
          vec4 fx = second ? fx1 : fx0;
          vec2 uv = vUv;
          vec2 lo = r.xy + 0.5 / vec2(4096.0), hi = r.xy + r.zw - 0.5 / vec2(4096.0);
          #if SCREENFX
            // exhaust heat shimmer: wobble the image in a soft blob around the exhausts
            if (fx.z > 0.01) {
              vec2 hp = second ? heat1 : heat0;
              vec2 dd = (luv - hp) * vec2(la, 1.0) * vec2(1.0, 1.6);
              float m = exp(-dot(dd, dd) * 55.0) * fx.z * smoothstep(-0.02, 0.06, hp.y - luv.y + 0.08);
              uv += vec2(sin(luv.y * 160.0 + time * 31.0), cos(luv.x * 120.0 - time * 27.0)) * 0.0045 * m * r.zw;
            }
          #endif
          vec3 c = sceneAt(uv);
          #if SCREENFX
            // boost: radial zoom blur toward the edges + chromatic aberration
            if (fx.y > 0.01) {
              vec2 dir = luv - vec2(0.5, 0.55);
              float rl = length(dir * vec2(la, 1.0));
              float m = smoothstep(0.25, 0.95, rl) * fx.y;
              if (m > 0.002) {
                vec3 acc = c;
                for (int i = 1; i < 6; i++) acc += sceneAt(clamp(uv - dir * r.zw * float(i) * 0.008 * m, lo, hi));
                c = acc / 6.0;
                vec2 ca = dir * r.zw * 0.0035 * m;
                c.r = mix(c.r, sceneAt(clamp(uv + ca, lo, hi)).r, 0.85);
                c.b = mix(c.b, sceneAt(clamp(uv - ca, lo, hi)).b, 0.85);
              }
            }
          #endif
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
          // tone mapping + sRGB done by hand so the final pass can also render into an LDR target (SMAA path)
          c = toSRGB(acesTone(c * exposure));
          // display-space grade: saturation, contrast (around mid grey), warm tint
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, saturation);
          c = (c - 0.5) * contrast + 0.5;
          c *= tint * mix(shadowTint, highlightTint, smoothstep(0.08, 0.85, l));
          // viewport-local effects
          vec2 d = (luv - vec2(0.5, 0.55)) * vec2(la, 1.0);
          float rad = length(d) / max(1.0, la * 0.62);
          float vig = smoothstep(0.35, 1.05, length((luv - 0.5) * vec2(1.0, 0.85)) * 1.25);
          // speed vignette: edges close in a little at top speed / on boost
          c *= 1.0 - (vignette + clamp(fx.x - 0.65, 0.0, 0.6) * 0.3 + fx.y * 0.1) * vig;
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
          // hit flash: a coloured pulse from the screen edges
          if (fx.w > 0.001) {
            vec3 hc = second ? hit1 : hit0;
            float e = smoothstep(0.15, 1.0, length((luv - 0.5) * vec2(1.0, 0.9)) * 1.45);
            c = mix(c, hc, clamp(fx.w * (0.12 + e * 0.6), 0.0, 0.8));
          }
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
    if (this.sceneRT.depthTexture) {
      this.sceneRT.depthTexture.image.width = w;
      this.sceneRT.depthTexture.image.height = h;
    }
    const aw = Math.max(1, Math.round(w / 2)), ah = Math.max(1, Math.round(h / 2));
    this.aoRT?.setSize(aw, ah);
    this.aoBlurRT?.setSize(aw, ah);
    this.ldrRT?.setSize(w, h);
    this.smaa?.setSize(w, h);
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

  /** AO + bloom + final grade to the canvas. */
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
    const u = this.finalMat.uniforms;
    // per-viewport rects + camera params (shared by AO and the final pass)
    viewports.slice(0, 2).forEach((v, i) => {
      (i === 0 ? u.vp0 : u.vp1).value.set(...v.rect);
      const cam = v.camera;
      const cv = (i === 0 ? u.cam0 : u.cam1).value as THREE.Vector4;
      if (cam) cv.set(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), cam.aspect, cam.near, cam.far);
    });
    if (viewports.length < 2) u.vp1.value.set(0, 0, 0, 0);
    if (this.aoMat && this.aoRT && this.aoBlurRT && this.aoBlurMat) {
      const a = this.aoMat.uniforms;
      a.vp0.value.copy(u.vp0.value);
      a.vp1.value.copy(u.vp1.value);
      a.cam0.value.copy(u.cam0.value);
      a.cam1.value.copy(u.cam1.value);
      a.res.value.set(this.aoRT.width, this.aoRT.height);
      this.pass(this.aoMat, this.aoRT);
      this.aoBlurMat.uniforms.texel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
      this.pass(this.aoBlurMat, this.aoBlurRT);
    }
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
    u.bloomStrength.value = grade.bloomStrength / Math.max(1, n * 0.5);
    u.exposure.value = grade.exposure;
    u.saturation.value = grade.saturation;
    u.contrast.value = grade.contrast;
    u.tint.value.copy(this.tint.set(grade.tint));
    u.shadowTint.value.set(grade.shadowTint);
    u.highlightTint.value.set(grade.highlightTint);
    u.vignette.value = grade.vignette;
    u.time.value = this.time;
    u.toneExp.value = gl.toneMappingExposure;
    u.aspect.value = cssW / Math.max(1, cssH);
    const flare = scene.userData.sunFlare as { strength: number; color: THREE.ColorRepresentation } | undefined;
    u.flareStrength.value = flare ? flare.strength : 0;
    if (flare) u.flareCol.value.set(flare.color);
    const k = 1 - Math.exp(-6 * dt);
    viewports.slice(0, 2).forEach((v, i) => {
      const s = this.smooth[i];
      s.speed += (v.speed - s.speed) * k;
      s.boost += (v.boost - s.boost) * k;
      s.heat += ((v.heat ? v.heat[2] : 0) - s.heat) * (1 - Math.exp(-4 * dt));
      (i === 0 ? u.fx0 : u.fx1).value.set(s.speed, s.boost, s.heat, v.hit ?? 0);
      if (v.heat) (i === 0 ? u.heat0 : u.heat1).value.set(v.heat[0], v.heat[1]);
      if (v.hitColor) (i === 0 ? u.hit0 : u.hit1).value.copy(v.hitColor);
      const sn = v.sun;
      (i === 0 ? u.sun0 : u.sun1).value.set(sn ? sn[0] : 0, sn ? sn[1] : 0, sn ? sn[2] : 0);
    });
    this.quad.material = this.finalMat;
    if (this.smaa && this.ldrRT) {
      this.ldrRT.viewport.set(0, 0, this.w, this.h);
      gl.setRenderTarget(this.ldrRT);
      this.quad.render(gl);
      gl.setRenderTarget(null);
      gl.setScissorTest(false);
      gl.setViewport(0, 0, cssW, cssH);
      this.smaa.render(gl, null as unknown as THREE.WebGLRenderTarget, this.ldrRT, 0, false);
    } else {
      gl.setRenderTarget(null);
      gl.setScissorTest(false);
      gl.setViewport(0, 0, cssW, cssH);
      this.quad.render(gl);
    }
    gl.autoClear = prevAutoClear;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.gl.setRenderTarget(target);
    this.quad.material = mat;
    this.quad.render(this.gl);
  }

  dispose(): void {
    this.sceneRT.depthTexture?.dispose();
    this.sceneRT.dispose();
    this.bloomRTs.forEach((r) => r.dispose());
    this.aoRT?.dispose();
    this.aoBlurRT?.dispose();
    this.aoMat?.dispose();
    this.aoBlurMat?.dispose();
    this.ldrRT?.dispose();
    this.smaa?.dispose();
    this.prefilterMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.finalMat.dispose();
    this.quad.dispose();
  }
}

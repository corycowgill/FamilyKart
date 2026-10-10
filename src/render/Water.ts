import * as THREE from 'three';

export interface WaterOptions {
  /** colour looking straight down */
  deep: THREE.ColorRepresentation;
  /** lighter colour of the ripple crests / shallows */
  shallow: THREE.ColorRepresentation;
  /** sky colours used for the fresnel reflection */
  skyTop: THREE.ColorRepresentation;
  skyHorizon: THREE.ColorRepresentation;
  sunColor: THREE.ColorRepresentation;
  sunDir: THREE.Vector3;
  quality: 'low' | 'medium' | 'high';
  /** wave scale multiplier (1 = lake-sized ripples) */
  scale?: number;
  opacity?: number;
  /** main flow direction (river current) in world xz */
  flow?: THREE.Vector2;
}

export type WaterMaterial = THREE.ShaderMaterial & { setTime(t: number): void };

/** Water palettes by name so other modules (scenery, track view) can stay consistent. */
export const WATER_COLORS = {
  lake: { deep: '#1262b4', shallow: '#2aa6dc' },
  /** Chicago river dyed green (St. Patrick's day) */
  greenRiver: { deep: '#08705c', shallow: '#3fd6ae' },
  pond: { deep: '#2a86c8', shallow: '#7fd8f2' },
  icy: { deep: '#6fa9cf', shallow: '#cfeefc' },
};

/**
 * Stylised animated water: analytic sine-wave ripples (no textures), fresnel blend toward the sky
 * colours, sharp sun glint plus twinkling sparkles near the camera. One ShaderMaterial, fog aware,
 * cheap enough for phones (sparkles only on high).
 */
export function createWaterMaterial(o: WaterOptions): WaterMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      deep: { value: new THREE.Color(o.deep) },
      shallow: { value: new THREE.Color(o.shallow) },
      skyTop: { value: new THREE.Color(o.skyTop) },
      skyHorizon: { value: new THREE.Color(o.skyHorizon) },
      sunCol: { value: new THREE.Color(o.sunColor) },
      sunDir: { value: o.sunDir.clone().normalize() },
      time: { value: 0 },
      scale: { value: 1 / (o.scale ?? 1) },
      opacity: { value: o.opacity ?? 1 },
      flow: { value: (o.flow ?? new THREE.Vector2(0.6, 0.25)).clone() },
      /** night: elongated moon / city-light reflection column (0 = off, daytime look unchanged) */
      glintStretch: { value: 0 },
      /** warm city-light shimmer on the water at night (0 = off) */
      cityGlow: { value: new THREE.Color(0, 0, 0) },
    },
  ]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    transparent: (o.opacity ?? 1) < 1,
    defines: { SPARKLE: o.quality === 'high' ? 1 : 0, WAVES: o.quality === 'low' ? 2 : 4 },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 deep; uniform vec3 shallow; uniform vec3 skyTop; uniform vec3 skyHorizon; uniform vec3 sunCol; uniform vec3 sunDir;
      uniform float time; uniform float scale; uniform float opacity; uniform vec2 flow; uniform float glintStretch; uniform vec3 cityGlow;
      varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      // gradient of a*sin(dot(d,p)*f + t*s)
      vec2 wave(vec2 p, vec2 d, float f, float s, float a, inout float hgt){
        float ph = dot(d, p) * f + time * s;
        hgt += a * sin(ph);
        return d * (a * f * cos(ph));
      }
      void main(){
        vec2 p = vWorld.xz * scale + flow * time * 0.6;
        float hgt = 0.0;
        vec2 g = wave(p, vec2(0.83, 0.55), 0.55, 1.3, 0.16, hgt);
        g += wave(p, vec2(-0.45, 0.89), 0.9, 1.7, 0.09, hgt);
        #if WAVES > 2
        g += wave(p, vec2(0.98, -0.2), 1.9, 2.6, 0.035, hgt);
        g += wave(p, vec2(-0.7, -0.71), 3.1, 3.3, 0.02, hgt);
        #endif
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / dist;
        // flatten ripples with distance to avoid shimmer
        float fade = 1.0 / (1.0 + dist * 0.012);
        vec3 n = normalize(vec3(-g.x * fade, 1.0, -g.y * fade));
        float ndv = max(dot(n, v), 0.0);
        float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
        vec3 r = reflect(-v, n);
        vec3 refl = mix(skyHorizon, skyTop, clamp(r.y * 2.5 + 0.45, 0.0, 1.0));
        // stylised body colour: lighter on crests, darker in troughs, broad slow blotches
        float blot = sin(vWorld.x * 0.021 + time * 0.05) * sin(vWorld.z * 0.017 - time * 0.04);
        vec3 body = mix(deep, shallow, clamp(0.35 + hgt * 1.4 + blot * 0.2, 0.0, 1.0));
        vec3 c = mix(body, refl, clamp(fres * 0.6, 0.0, 1.0));
        float sd = max(dot(r, sunDir), 0.0);
        c += sunCol * (pow(sd, 220.0) * 6.0 + pow(sd, 18.0) * 0.12);
        if (glintStretch > 0.0) {
          // moonlight path: the glint smeared toward the viewer (matches azimuth, broad in elevation)
          vec2 rh = normalize(r.xz + 1e-5), sh = normalize(sunDir.xz + 1e-5);
          float az = max(dot(rh, sh), 0.0);
          float el = abs(r.y - sunDir.y);
          float ripple = 0.55 + 0.45 * sin(hgt * 18.0 + vWorld.x * 0.7 + time * 2.0);
          float col = pow(az, 700.0) * smoothstep(0.75, 0.0, el) * ripple;
          c += sunCol * col * glintStretch * 2.2;
          c += cityGlow * fres * (0.6 + 0.4 * ripple);
        }
        #if SPARKLE
        {
          vec2 cell = floor(vWorld.xz * 1.2);
          float hs = h21(cell + floor(time * 2.5 + h21(cell) * 8.0));
          vec2 f = fract(vWorld.xz * 1.2) - 0.5;
          float star = smoothstep(0.12, 0.0, length(f)) * step(0.975, hs);
          c += sunCol * star * pow(sd, 4.0) * 5.0 * smoothstep(90.0, 15.0, dist);
        }
        #endif
        gl_FragColor = vec4(c, opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  }) as WaterMaterial;
  mat.setTime = (t: number) => {
    mat.uniforms.time.value = t;
  };
  return mat;
}

import * as THREE from 'three';

/**
 * Bubble shield: fresnel rim + glowing hexagon cells (object-space spherical mapping) + soft
 * iridescent sheen, with a ripple wave that runs over the surface from the impact direction when a
 * hit is blocked. Additive, no depth write, one draw call.
 */
export function createShieldMaterial(): THREE.ShaderMaterial & { ripple(dir: THREE.Vector3): void; tick(dt: number, time: number): void } {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      color: { value: new THREE.Color('#5fd2ff') },
      color2: { value: new THREE.Color('#c58bff') },
      opacity: { value: 1 },
      hitDir: { value: new THREE.Vector3(0, 0, 1) },
      hitT: { value: 10 },
      pop: { value: 0 },
    },
    vertexShader: /* glsl */ `uniform float hitT; uniform vec3 hitDir; uniform float pop;
      varying vec3 vObj; varying vec3 vN; varying vec3 vView;
      void main(){
        vObj = normalize(position);
        // ripple bulge travelling from the impact point
        float d = acos(clamp(dot(vObj, normalize(hitDir)), -1.0, 1.0));
        float wave = exp(-pow((d - hitT * 4.5) * 3.0, 2.0)) * exp(-hitT * 2.5);
        vec3 p = position * (1.0 + wave * 0.08 + pop * 0.12);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `uniform float time; uniform vec3 color; uniform vec3 color2; uniform float opacity; uniform vec3 hitDir; uniform float hitT; uniform float pop;
      varying vec3 vObj; varying vec3 vN; varying vec3 vView;
      // distance to the nearest hexagon edge (0 at the edge)
      float hexEdge(vec2 p){
        const vec2 s = vec2(1.0, 1.7320508);
        vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
        vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
        vec2 q = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
        q = abs(q);
        return 0.5 - max(dot(q, s * 0.5), q.x);
      }
      void main(){
        float facing = abs(dot(normalize(vN), normalize(vView)));
        float fres = pow(1.0 - facing, 2.2);
        vec2 sp = vec2(atan(vObj.z, vObj.x) * 2.6, vObj.y * 4.2);
        float e = hexEdge(sp * 1.6 + vec2(time * 0.08, 0.0));
        float lines = 1.0 - smoothstep(0.0, 0.06, e);
        float d = acos(clamp(dot(vObj, normalize(hitDir)), -1.0, 1.0));
        float wave = exp(-pow((d - hitT * 4.5) * 2.2, 2.0)) * exp(-hitT * 2.0);
        float shimmer = 0.5 + 0.5 * sin(time * 2.0 + vObj.y * 6.0 + vObj.x * 3.0);
        vec3 base = mix(color, color2, fres * 0.6 + shimmer * 0.25);
        float a = fres * 0.9 + lines * (0.12 + fres * 0.5 + wave * 1.4) + 0.05 + wave * 0.35 + pop * 0.4;
        vec3 col = base * a + vec3(1.0) * (pow(fres, 4.0) * 0.6 + wave * lines * 0.8);
        gl_FragColor = vec4(col * opacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }) as THREE.ShaderMaterial & { ripple(dir: THREE.Vector3): void; tick(dt: number, time: number): void };
  mat.ripple = (dir: THREE.Vector3) => {
    mat.uniforms.hitDir.value.copy(dir).normalize();
    mat.uniforms.hitT.value = 0;
    mat.uniforms.pop.value = 1;
  };
  mat.tick = (dt: number, time: number) => {
    mat.uniforms.time.value = time;
    mat.uniforms.hitT.value += dt;
    mat.uniforms.pop.value = Math.max(0, mat.uniforms.pop.value - dt * 5);
  };
  return mat;
}

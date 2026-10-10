import * as THREE from 'three';

export interface RingOptions {
  x: number;
  y: number;
  z: number;
  /** plane normal (default: up = ground ring) */
  normal?: THREE.Vector3;
  color: THREE.ColorRepresentation;
  /** final radius */
  size: number;
  /** start radius fraction (default 0.15) */
  start?: number;
  life?: number;
  /** band thickness as a fraction of the radius (0..1) */
  thickness?: number;
  alpha?: number;
  /** 0 = crisp toon shockwave band, 1 = soft dust donut */
  style?: 0 | 1;
}

const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const q = new THREE.Quaternion();
const m = new THREE.Matrix4();
const s = new THREE.Vector3();
const p = new THREE.Vector3();
const c = new THREE.Color();

/**
 * Expanding rings (boost shockwaves, landing dust rings, GO pulses, teleport halos) as ONE instanced
 * quad mesh; the ring shape is computed in the fragment shader (crisp outlined band, cel feel).
 */
export class Rings {
  readonly mesh: THREE.InstancedMesh;
  private age: Float32Array;
  private life: Float32Array;
  private r0: Float32Array;
  private r1: Float32Array;
  private quat: Float32Array;
  private posA: Float32Array;
  private params: Float32Array;
  private colors: Float32Array;
  private baseAlpha: Float32Array;
  private cursor = 0;
  private active = 0;
  private geo: THREE.PlaneGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(private max: number, additive: boolean) {
    this.geo = new THREE.PlaneGeometry(2, 2);
    this.params = new Float32Array(max * 4);
    this.colors = new Float32Array(max * 3);
    this.geo.setAttribute('iParams', new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { tint: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `attribute vec4 iParams; attribute vec3 iColor; varying vec2 vUv; varying vec4 vP; varying vec3 vC;
        void main(){ vUv = uv; vP = iParams; vC = iColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform vec3 tint; varying vec2 vUv; varying vec4 vP; varying vec3 vC;
        void main(){
          float r = length(vUv - 0.5) * 2.0;
          float t = vP.x; float th = vP.y * (1.0 - 0.55 * t); float a = vP.z;
          if (a <= 0.001 || r > 1.0) discard;
          float d = abs(r - (1.0 - th * 0.5));
          float band;
          vec3 col = vC;
          if (vP.w < 0.5) {
            // toon shockwave: crisp bright band with a white leading edge, faint inner fill
            float aa = fwidth(r) * 1.5;
            band = 1.0 - smoothstep(th * 0.5 - aa, th * 0.5, d);
            float lead = 1.0 - smoothstep(0.0, th * 0.22 + aa, abs(r - (1.0 - th * 0.15)));
            col = mix(col, vec3(1.0), lead * 0.7) * (1.0 + lead);
            band += smoothstep(1.0 - th * 2.5, 1.0 - th, r) * 0.18;
          } else {
            band = 1.0 - smoothstep(0.0, th * 0.5, d);
            band *= band;
          }
          float fade = (1.0 - t) * (1.0 - t);
          gl_FragColor = vec4(col * tint, clamp(band * a * fade, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.count = 0;
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.r0 = new Float32Array(max);
    this.r1 = new Float32Array(max);
    this.quat = new Float32Array(max * 4);
    this.posA = new Float32Array(max * 3);
    this.baseAlpha = new Float32Array(max);
  }

  spawn(o: RingOptions): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.age[i] = 0;
    this.life[i] = o.life ?? 0.5;
    this.r1[i] = o.size;
    this.r0[i] = o.size * (o.start ?? 0.15);
    q.setFromUnitVectors(Z, o.normal ? p.copy(o.normal).normalize() : UP);
    q.toArray(this.quat, i * 4);
    this.posA[i * 3] = o.x;
    this.posA[i * 3 + 1] = o.y;
    this.posA[i * 3 + 2] = o.z;
    c.set(o.color);
    this.colors.set([c.r, c.g, c.b], i * 3);
    this.params[i * 4 + 1] = o.thickness ?? 0.18;
    this.baseAlpha[i] = o.alpha ?? 1;
    this.params[i * 4 + 3] = o.style ?? 0;
    this.active = Math.max(this.active, 1);
  }

  update(dt: number): void {
    if (!this.active) return;
    let hi = 0;
    for (let i = 0; i < this.max; i++) {
      const lf = this.life[i];
      if (lf <= 0) continue;
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / lf);
      if (t >= 1) {
        this.life[i] = 0;
        this.params[i * 4 + 2] = 0;
        m.makeScale(0, 0, 0);
        m.toArray(this.mesh.instanceMatrix.array, i * 16);
        continue;
      }
      hi = i + 1;
      const e = 1 - (1 - t) ** 3; // fast out, slow settle
      const r = this.r0[i] + (this.r1[i] - this.r0[i]) * e;
      q.fromArray(this.quat, i * 4);
      m.compose(p.fromArray(this.posA, i * 3), q, s.set(r, r, r));
      m.toArray(this.mesh.instanceMatrix.array, i * 16);
      this.params[i * 4] = t;
      this.params[i * 4 + 2] = this.baseAlpha[i];
    }
    // ring buffer: render up to the highest live slot
    let maxLive = 0;
    for (let i = 0; i < this.max; i++) if (this.life[i] > 0) maxLive = i + 1;
    this.mesh.count = Math.max(hi, maxLive);
    if (!this.mesh.count) this.active = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.geo.attributes.iParams as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.iColor as THREE.BufferAttribute).needsUpdate = true;
  }

  get tint(): THREE.Color {
    return this.mat.uniforms.tint.value;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}

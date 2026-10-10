import * as THREE from 'three';

export interface WindOptions {
  kind: 'tunnel' | 'tornado';
  radius: number;
  length: number;
  color?: THREE.ColorRepresentation;
  /** streak lanes around the circumference */
  lanes?: number;
  /** twist (turns per length) */
  swirl?: number;
  /** probability a lane segment shows a streak */
  density?: number;
  additive?: boolean;
  /** streak width multiplier */
  width?: number;
}

/**
 * Stylised wind volume: an open cylinder (tunnel along +Z, or a flared tornado along +Y) whose
 * shader draws sparse tapered streaks scrolling along it, optionally twisted into a swirl. Used for
 * high-speed wind lines around the player kart, the Windy City Gust sweep and the "blown" swirl.
 */
export class WindVolume {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;

  constructor(o: WindOptions) {
    if (o.kind === 'tunnel') {
      this.geo = new THREE.CylinderGeometry(o.radius, o.radius * 0.8, o.length, 28, 1, true).rotateX(Math.PI / 2);
    } else {
      this.geo = new THREE.CylinderGeometry(o.radius * 1.35, o.radius * 0.55, o.length, 24, 1, true).translate(0, o.length / 2, 0);
    }
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: {
        time: { value: 0 },
        amount: { value: 0 },
        color: { value: new THREE.Color(o.color ?? '#ffffff') },
        lanes: { value: o.lanes ?? 24 },
        swirl: { value: o.swirl ?? 0 },
        density: { value: o.density ?? 0.35 },
        speed: { value: 1.5 },
        spin: { value: 0 },
        streaks: { value: o.kind === 'tunnel' ? 2.2 : 1.6 },
        width: { value: o.width ?? 1 },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; varying float vFacing;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal); vFacing = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `uniform float time; uniform float amount; uniform vec3 color; uniform float lanes; uniform float swirl;
        uniform float density; uniform float speed; uniform float spin; uniform float streaks; uniform float width; varying vec2 vUv; varying float vFacing;
        float hash(float n){ return fract(sin(n * 12.9898) * 43758.5453); }
        void main(){
          if (amount <= 0.001) discard;
          float u = vUv.x + vUv.y * swirl + time * spin;
          float id = floor(u * lanes);
          float fu = fract(u * lanes);
          float h = hash(id + 1.7);
          float y = vUv.y * streaks - time * speed * (0.7 + h * 0.6) + h * 7.0;
          float cellY = floor(y);
          float seg = fract(y);
          float on = step(1.0 - density, hash(id * 7.13 + cellY * 3.1));
          float streak = smoothstep(0.0, 0.12, seg) * (1.0 - smoothstep(0.35, 0.75, seg));
          float w = 1.0 - smoothstep(0.08 * width, 0.3 * width, abs(fu - 0.5));
          float ends = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
          float a = on * streak * w * ends * amount * (0.35 + 0.65 * (1.0 - vFacing));
          if (a < 0.004) discard;
          gl_FragColor = vec4(color, min(a, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.mat.uniforms;
  }

  /** amount 0..1; hides the mesh entirely when 0 (no draw call). */
  set(amount: number, time: number, speed = 1.5, spin = 0): void {
    this.mat.uniforms.amount.value = amount;
    this.mat.uniforms.time.value = time;
    this.mat.uniforms.speed.value = speed;
    this.mat.uniforms.spin.value = spin;
    this.mesh.visible = amount > 0.003;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

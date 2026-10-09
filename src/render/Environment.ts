import * as THREE from 'three';
import type { TrackDef } from '../sim/types';
import type { Quality } from './Renderer';

/** Gradient sky dome + sun/hemisphere lighting + fog driven by TrackDef.lighting. */
export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private sky: THREE.Mesh;
  private sunOffset = new THREE.Vector3(-120, 220, 90);

  constructor(scene: THREE.Scene, lighting: TrackDef['lighting'], quality: Quality) {
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(lighting.skyTop) },
        bottom: { value: new THREE.Color(lighting.skyBottom) },
        sunDir: { value: this.sunOffset.clone().normalize() },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y*1.4+0.12,0.0,1.0); vec3 c = mix(bottom, top, pow(h,0.75));
        float s = max(dot(normalize(vDir), sunDir),0.0); c += vec3(1.0,0.9,0.7)*pow(s,64.0)*0.8 + vec3(1.0,0.8,0.5)*pow(s,6.0)*0.15;
        gl_FragColor = vec4(c,1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.group.add(this.sky);

    this.hemi = new THREE.HemisphereLight(lighting.ambient, lighting.ground, 1.25);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(lighting.sun, lighting.sunIntensity);
    this.sun.position.copy(this.sunOffset);
    if (quality !== 'low') {
      this.sun.castShadow = true;
      const size = quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      const ext = 70;
      const cam = this.sun.shadow.camera;
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.near = 10;
      cam.far = 600;
      this.sun.shadow.bias = -0.0005;
      this.sun.shadow.normalBias = 0.04;
    }
    this.group.add(this.sun);
    this.group.add(this.sun.target);
    scene.add(this.group);
    scene.fog = new THREE.Fog(lighting.fog, lighting.fogNear, lighting.fogFar);
    scene.background = new THREE.Color(lighting.skyBottom);
  }

  /** Keep the shadow frustum centred on the focus point (the local player). */
  follow(focus: THREE.Vector3): void {
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(this.sunOffset);
    this.sky.position.copy(focus);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.sun.shadow.map?.dispose();
  }
}

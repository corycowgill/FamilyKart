import * as THREE from 'three';

export type Quality = 'low' | 'medium' | 'high';

export interface Viewport {
  camera: THREE.PerspectiveCamera;
  /** normalized rect: x, y (from bottom), w, h */
  rect: [number, number, number, number];
}

/** Owns the WebGL renderer, canvas sizing, quality settings and (split-screen) viewport rendering. */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  quality: Quality = 'high';
  width = 1;
  height = 1;
  private onResizeCbs: Array<() => void> = [];

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.gl.domElement;
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);
    window.addEventListener('resize', () => this.resize());
    this.setQuality('high');
    this.resize();
  }

  onResize(cb: () => void): void {
    this.onResizeCbs.push(cb);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : q === 'medium' ? 1.25 : 0.85);
    this.gl.setPixelRatio(dpr);
    this.gl.shadowMap.enabled = q !== 'low';
    this.resize();
  }

  resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.gl.setSize(this.width, this.height);
    this.onResizeCbs.forEach((c) => c());
  }

  render(scene: THREE.Scene, viewports: Viewport[]): void {
    const gl = this.gl;
    if (viewports.length === 1 && viewports[0].rect[2] === 1 && viewports[0].rect[3] === 1) {
      const cam = viewports[0].camera;
      const aspect = this.width / this.height;
      if (Math.abs(cam.aspect - aspect) > 1e-3) {
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
      }
      gl.setScissorTest(false);
      gl.setViewport(0, 0, this.width, this.height);
      gl.render(scene, cam);
      return;
    }
    gl.setScissorTest(true);
    for (const v of viewports) {
      const [x, y, w, h] = v.rect;
      const px = Math.floor(x * this.width), py = Math.floor(y * this.height), pw = Math.ceil(w * this.width), ph = Math.ceil(h * this.height);
      gl.setViewport(px, py, pw, ph);
      gl.setScissor(px, py, pw, ph);
      const aspect = pw / ph;
      if (Math.abs(v.camera.aspect - aspect) > 1e-3) {
        v.camera.aspect = aspect;
        v.camera.updateProjectionMatrix();
      }
      gl.render(scene, v.camera);
    }
    gl.setScissorTest(false);
  }
}

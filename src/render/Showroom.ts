import * as THREE from 'three';
import { CHARACTERS } from '../data/characters';
import type { CharacterId } from '../sim/types';
import { buildCharacter } from './models/characterModels';
import { buildKart } from './models/kartModels';
import type { CharacterRig, KartRig } from './models/types';
import type { Renderer } from './Renderer';

/**
 * Character-select 3D scene: the six karts parked in an arc on a stage; the selected one rolls
 * onto a spotlit turntable that the player can drag to rotate.
 */
export class Showroom {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
  private entries: Array<{ id: CharacterId; kart: KartRig; ch: CharacterRig; home: THREE.Vector3; homeYaw: number }> = [];
  private selected: CharacterId = 'dad';
  private secondary: CharacterId | null = null;
  private spin = 0;
  private spinVel = 0.6;
  private dragging = false;
  private lastX = 0;
  private time = 0;
  private turntable: THREE.Mesh;
  private confetti: THREE.Points;
  private handlers: Array<[string, EventListener]> = [];

  constructor(private renderer: Renderer) {
    this.scene.background = new THREE.Color('#3a6fe0');
    this.scene.fog = new THREE.Fog('#3a6fe0', 30, 90);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(80, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying float vy; void main(){ vec3 a = vec3(1.0,0.78,0.55); vec3 b = vec3(0.16,0.36,0.9); gl_FragColor = vec4(mix(a,b,clamp(vy*1.8+0.15,0.0,1.0)),1.0); }',
    }));
    this.scene.add(sky);
    this.scene.add(new THREE.HemisphereLight('#bcd7ff', '#3a2a60', 1.6));
    const key = new THREE.DirectionalLight('#fff3dc', 2.4);
    key.position.set(6, 12, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);
    const spot = new THREE.SpotLight('#ffe9a8', 60, 30, 0.5, 0.5);
    spot.position.set(0, 12, 4);
    spot.target.position.set(0, 0, 0);
    this.scene.add(spot, spot.target);

    // stage
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#4a63d6', roughness: 0.5 }));
    floor.receiveShadow = true;
    this.scene.add(floor);
    const ringMat = new THREE.MeshStandardMaterial({ color: '#ffd23f', emissive: '#ff9d00', emissiveIntensity: 0.4 });
    this.turntable = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.35, 48), new THREE.MeshStandardMaterial({ color: '#f4f6ff', roughness: 0.3 }));
    this.turntable.position.y = 0.17;
    this.turntable.receiveShadow = true;
    this.scene.add(this.turntable);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.12, 8, 64).rotateX(Math.PI / 2), ringMat);
    ring.position.y = 0.35;
    this.scene.add(ring);
    // checkered backdrop
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#ffffff' : '#1b1b1b';
      g.fillRect(x * 8, y * 8, 8, 8);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(10, 2);
    tex.magFilter = THREE.NearestFilter;
    const banner = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 3, 64, 1, true, Math.PI * 0.6, Math.PI * 0.8), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
    banner.position.y = 5;
    banner.rotation.y = Math.PI;
    this.scene.add(banner);
    // floating confetti
    const n = 300;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const palette = ['#ff4d6d', '#ffd23f', '#3ec1ff', '#7cff6a', '#c77dff'].map((x) => new THREE.Color(x));
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 50;
      pos[i * 3 + 1] = Math.random() * 18;
      pos[i * 3 + 2] = -Math.random() * 30 - 2;
      const p = palette[i % palette.length];
      col.set([p.r, p.g, p.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.confetti = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.25, vertexColors: true }));
    this.scene.add(this.confetti);

    CHARACTERS.forEach((def, i) => {
      const kart = buildKart(def);
      const ch = buildCharacter(def.id);
      kart.seat.add(ch.root);
      const a = Math.PI * (0.18 + (i / (CHARACTERS.length - 1)) * 0.64);
      const home = new THREE.Vector3(Math.cos(a) * 11, 0, -Math.sin(a) * 8 - 3);
      kart.root.position.copy(home);
      const homeYaw = Math.atan2(-home.x, -home.z) * 0.6;
      kart.root.rotation.y = homeYaw;
      kart.root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true;
      });
      this.scene.add(kart.root);
      this.entries.push({ id: def.id, kart, ch, home, homeYaw });
    });
    this.camera.position.set(0, 3.4, 9.5);
    this.camera.lookAt(0, 1.2, 0);

    const canvas = renderer.canvas;
    const down = (e: Event) => {
      const pe = e as PointerEvent;
      this.dragging = true;
      this.lastX = pe.clientX;
    };
    const move = (e: Event) => {
      const pe = e as PointerEvent;
      if (!this.dragging) return;
      const dx = pe.clientX - this.lastX;
      this.lastX = pe.clientX;
      this.spin += dx * 0.012;
      this.spinVel = dx * 0.6;
    };
    const up = () => {
      this.dragging = false;
    };
    for (const [n2, fn] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointerleave', up]] as Array<[string, EventListener]>) {
      canvas.addEventListener(n2, fn);
      this.handlers.push([n2, fn]);
    }
  }

  select(id: CharacterId, secondary: CharacterId | null = null): void {
    if (id !== this.selected) this.spin = 0;
    this.selected = id;
    this.secondary = secondary;
  }

  frame(dt: number): void {
    this.time += dt;
    if (!this.dragging) {
      this.spinVel += (0.6 - this.spinVel) * Math.min(1, dt * 2);
      this.spin += this.spinVel * dt;
    }
    for (const e of this.entries) {
      const isSel = e.id === this.selected;
      const isSec = e.id === this.secondary;
      const target = isSel ? new THREE.Vector3(0, 0.35, 0) : isSec ? new THREE.Vector3(4.2, 0, 1) : e.home;
      e.kart.root.position.lerp(target, Math.min(1, dt * 5));
      const yawTarget = isSel ? Math.PI * 0.85 + this.spin : isSec ? Math.PI * 0.8 : e.homeYaw + Math.PI;
      let d = yawTarget - e.kart.root.rotation.y;
      if (!isSel) {
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
      }
      e.kart.root.rotation.y += isSel && e.kart.root.position.distanceTo(target) < 0.3 ? d : d * Math.min(1, dt * 5);
      e.ch.update(dt, {
        steer: isSel ? Math.sin(this.time * 1.3) * 0.6 : 0, speed: 0, drifting: false, driftDir: 0, airborne: false, boosting: false,
        reaction: isSel ? 'win' : 'none', reactionTime: isSel ? 1 : 0, time: this.time,
      });
      for (const w of e.kart.wheels) w.rotation.x = 0;
    }
    this.turntable.rotation.y = this.spin;
    this.confetti.rotation.y = Math.sin(this.time * 0.1) * 0.2;
    this.confetti.position.y = Math.sin(this.time * 0.5) * 0.5;
    const camX = 0;
    this.camera.position.set(camX, 3.3, 9.2);
    this.camera.lookAt(0, 1.3, 0);
    this.renderer.render(this.scene, [{ camera: this.camera, rect: [0, 0, 1, 1] }]);
  }

  dispose(): void {
    for (const [n, fn] of this.handlers) this.renderer.canvas.removeEventListener(n, fn);
    for (const e of this.entries) {
      e.kart.dispose();
      e.ch.dispose();
    }
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose();
        const m = o.material as THREE.Material & { map?: THREE.Texture };
        m.map?.dispose();
        m.dispose();
      }
    });
    this.scene.clear();
  }
}

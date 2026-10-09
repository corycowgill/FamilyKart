import * as THREE from 'three';
import { characterById } from '../data/characters';
import type { CharacterId } from '../sim/types';
import { buildCharacter } from './models/characterModels';
import { buildKart } from './models/kartModels';
import type { CharacterRig, KartRig } from './models/types';
import { Effects } from './Particles';
import type { Renderer } from './Renderer';

/** Animated podium ceremony for the top three finishers, with confetti and an orbiting camera. */
export class Podium {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 500);
  private racers: Array<{ kart: KartRig; ch: CharacterRig; place: number; delay: number; y: number }> = [];
  private fx: Effects;
  private time = 0;

  constructor(private renderer: Renderer, top: CharacterId[], others: CharacterId[] = []) {
    this.scene.environment = renderer.envMap();
    this.scene.environmentIntensity = 0.45;
    this.scene.background = new THREE.Color('#2a63d9');
    this.scene.fog = new THREE.Fog('#2a63d9', 40, 120);
    this.scene.add(new THREE.HemisphereLight('#dfeaff', '#4a3a70', 1.7));
    const sun = new THREE.DirectionalLight('#fff1d0', 2.6);
    sun.position.set(-6, 14, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    this.scene.add(sun);
    // sky gradient dome
    const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying float vy; void main(){ vec3 a = vec3(1.0,0.86,0.62); vec3 b = vec3(0.17,0.45,0.95); gl_FragColor = vec4(mix(a,b,clamp(vy*1.6+0.2,0.0,1.0)),1.0); }',
    }));
    this.scene.add(sky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#58b84a' }));
    ground.receiveShadow = true;
    this.scene.add(ground);
    const heights = [3, 2, 1.3];
    const xs = [0, -3.4, 3.4];
    const colors = ['#ffd23f', '#d9dee8', '#ff9a5a'];
    for (let i = 0; i < 3; i++) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(3.2, heights[i], 3), new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.4 }));
      block.position.set(xs[i], heights[i] / 2, 0);
      block.castShadow = block.receiveShadow = true;
      this.scene.add(block);
      const num = makeNumber(String(i + 1));
      num.position.set(xs[i], heights[i] / 2, 1.51);
      this.scene.add(num);
    }
    top.slice(0, 3).forEach((id, i) => {
      const kart = buildKart(characterById(id));
      const ch = buildCharacter(id);
      kart.seat.add(ch.root);
      kart.root.position.set(xs[i], heights[i] + 8, -0.2);
      kart.root.rotation.y = 0;
      kart.root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true;
      });
      this.scene.add(kart.root);
      this.racers.push({ kart, ch, place: i + 1, delay: 0.4 + (2 - i) * 0.6, y: heights[i] });
    });
    others.forEach((id, i) => {
      const kart = buildKart(characterById(id));
      const ch = buildCharacter(id);
      kart.seat.add(ch.root);
      kart.root.position.set(-6 + i * 4, 0, -6);
      kart.root.rotation.y = 0.2;
      this.scene.add(kart.root);
      this.racers.push({ kart, ch, place: 4 + i, delay: 0, y: 0 });
    });
    this.fx = new Effects(this.scene, 'medium');
  }

  frame(dt: number): void {
    this.time += dt;
    for (const r of this.racers) {
      const t = this.time - r.delay;
      if (r.place <= 3) {
        const targetY = r.y;
        if (t > 0) {
          const y = r.kart.root.position.y;
          r.kart.root.position.y = Math.max(targetY, y - dt * 14);
          if (y > targetY && r.kart.root.position.y === targetY) {
            const p = r.kart.root.position;
            this.fx.burst(p.x, p.y + 1, p.z, ['#ff4d6d', '#ffd23f', '#3ec1ff', '#7cff6a'], 50, 9);
          }
        }
      }
      r.ch.update(dt, {
        steer: 0, speed: 0, drifting: false, driftDir: 0, airborne: false, boosting: false,
        reaction: r.place <= 3 ? 'win' : 'lose', reactionTime: 1, time: this.time + r.place,
      });
    }
    // continuous confetti
    if (Math.random() < 0.9) {
      const colors = ['#ff4d6d', '#ffd23f', '#3ec1ff', '#7cff6a', '#c77dff'];
      this.fx.glow.emit({ x: (Math.random() - 0.5) * 16, y: 12, z: (Math.random() - 0.5) * 6, vy: -2, spread: 1.5, color: colors[Math.floor(Math.random() * 5)], size: 0.35, life: 4, gravity: 0.5, drag: 0.3, count: 2 });
    }
    this.fx.update(dt);
    this.fx.setViewportHeight(this.renderer.height);
    const a = Math.sin(this.time * 0.25) * 0.5;
    const intro = Math.max(0, 1 - this.time / 2.5);
    this.camera.position.set(Math.sin(a) * (12 + intro * 8) - 3, 4.5 + intro * 3, Math.cos(a) * (12 + intro * 8));
    this.camera.lookAt(-2.5, 2.6, 0);
    this.renderer.render(this.scene, [{ camera: this.camera, rect: [0, 0, 1, 1] }]);
  }

  dispose(): void {
    for (const r of this.racers) {
      r.kart.dispose();
      r.ch.dispose();
    }
    this.fx.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material & { map?: THREE.Texture };
        m.map?.dispose();
        m.dispose();
      }
    });
    this.scene.clear();
  }
}

function makeNumber(text: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.font = 'bold 100px "Lilita One", Arial Black, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#7a2a00';
  g.lineWidth = 8;
  g.strokeText(text, 64, 68);
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}

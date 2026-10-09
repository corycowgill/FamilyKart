import * as THREE from 'three';
import type { RaceSim } from '../sim/race/RaceSim';
import type { DroppedHazard, MovingHazard, Projectile } from '../sim/types';
import type { Effects } from './Particles';

/** Item boxes, projectiles, dropped hazards and moving track hazards. */
export class ItemsView {
  readonly group = new THREE.Group();
  private boxes: THREE.Group[] = [];
  private projMeshes = new Map<number, THREE.Object3D>();
  private hazardMeshes = new Map<number, THREE.Object3D>();
  private movingMeshes = new Map<number, THREE.Object3D>();
  private disposables: Array<{ dispose(): void }> = [];
  private boxMat: THREE.MeshPhysicalMaterial;
  private boxGeo: THREE.BufferGeometry;
  private qMat: THREE.MeshBasicMaterial;
  private qGeo: THREE.PlaneGeometry;
  /** one additive glow halo per box, all in a single Points draw call */
  private halo: THREE.Points;
  private haloPos: Float32Array;

  constructor(private sim: RaceSim) {
    const qTex = questionTexture();
    this.boxGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    this.boxMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, roughness: 0.1, clearcoat: 1, emissive: '#ffcc33', emissiveIntensity: 0.35, depthWrite: false });
    this.qMat = new THREE.MeshBasicMaterial({ map: qTex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    this.qGeo = new THREE.PlaneGeometry(1.0, 1.0);
    this.disposables.push(qTex, this.boxGeo, this.boxMat, this.qMat, this.qGeo);
    for (const b of sim.items.boxes) {
      const g = new THREE.Group();
      const cube = new THREE.Mesh(this.boxGeo, this.boxMat);
      cube.renderOrder = 3;
      g.add(cube);
      for (let i = 0; i < 4; i++) {
        const q = new THREE.Mesh(this.qGeo, this.qMat);
        q.rotation.y = (i * Math.PI) / 2;
        q.position.set(Math.sin((i * Math.PI) / 2) * 0.76, 0, Math.cos((i * Math.PI) / 2) * 0.76);
        q.renderOrder = 4;
        g.add(q);
      }
      g.position.set(b.pos.x, b.pos.y, b.pos.z);
      this.boxes.push(g);
      this.group.add(g);
    }
    this.haloPos = new Float32Array(Math.max(1, sim.items.boxes.length) * 3);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(this.haloPos, 3).setUsage(THREE.DynamicDrawUsage));
    const haloTex = haloTexture();
    const haloMat = new THREE.PointsMaterial({ map: haloTex, size: 3.6, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: '#ffcc33', opacity: 0.55 });
    this.halo = new THREE.Points(hg, haloMat);
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 2;
    this.group.add(this.halo);
    this.disposables.push(hg, haloMat, haloTex);
  }

  update(dt: number, time: number, alpha: number, fx: Effects | null): void {
    const sim = this.sim;
    sim.items.boxes.forEach((b, i) => {
      const g = this.boxes[i];
      const hidden = b.respawn > 0;
      const wasVisible = g.visible;
      g.visible = !hidden || b.respawn < 0.3;
      if (hidden && wasVisible && fx) fx.burst(b.pos.x, b.pos.y, b.pos.z, ['#ff5a5a', '#ffd93a', '#4ad9ff', '#7cff6a', '#e56cff'], 26, 7);
      const scale = hidden ? Math.max(0.01, 1 - b.respawn / 0.3) : 1;
      g.scale.setScalar(scale);
      g.rotation.y = time * 1.6 + i;
      g.rotation.x = Math.sin(time * 1.3 + i) * 0.35;
      g.position.y = b.pos.y + Math.sin(time * 2.5 + i * 0.7) * 0.18;
    });
    const hue = (time * 0.15) % 1;
    this.boxMat.emissive.setHSL(hue, 0.9, 0.5);
    // shimmering halo, slightly over-bright so it catches the bloom
    this.boxes.forEach((g, i) => {
      const o = i * 3;
      this.haloPos[o] = g.position.x;
      this.haloPos[o + 1] = g.visible && g.scale.x > 0.5 ? g.position.y : -1e4;
      this.haloPos[o + 2] = g.position.z;
    });
    (this.halo.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    const hm = this.halo.material as THREE.PointsMaterial;
    hm.color.setHSL(hue, 0.85, 0.62).multiplyScalar(1.3);
    hm.size = 3.4 + Math.sin(time * 5) * 0.4;

    // projectiles
    const seenP = new Set<number>();
    for (const p of sim.items.projectiles) {
      seenP.add(p.id);
      let m = this.projMeshes.get(p.id);
      if (!m) {
        m = buildProjectile(p);
        this.projMeshes.set(p.id, m);
        this.group.add(m);
      }
      m.position.set(p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha, p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha, p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha);
      m.rotation.y = p.kind === 'bone' ? p.yaw : time * 8;
      if (p.kind === 'bone') m.children[0].rotation.x = time * 14;
      if (fx && Math.random() < 0.6) {
        fx.glow.emit({ x: m.position.x, y: m.position.y, z: m.position.z, spread: 0.5, color: p.kind === 'pie' ? '#ff9ad5' : p.kind === 'pizza' ? '#ffb347' : '#ffffff', size: 0.45, life: 0.4, drag: 2 });
      }
    }
    for (const [id, m] of this.projMeshes) {
      if (!seenP.has(id)) {
        if (fx) fx.burst(m.position.x, m.position.y, m.position.z, ['#ffcf4a', '#ff6b3d', '#ffffff'], 24, 8);
        disposeObject(m);
        this.projMeshes.delete(id);
      }
    }
    // dropped hazards
    const seenH = new Set<number>();
    for (const h of sim.items.hazards) {
      seenH.add(h.id);
      let m = this.hazardMeshes.get(h.id);
      if (!m) {
        m = buildHazard(h);
        this.hazardMeshes.set(h.id, m);
        this.group.add(m);
      }
      m.position.set(h.pos.x, h.pos.y, h.pos.z);
      if (h.kind === 'tennisBall') m.rotation.x = time * 6;
      if (h.kind === 'banana') m.rotation.y = h.id;
      if (h.kind === 'pothole') {
        const s = Math.min(1, h.age * 3) * Math.min(1, h.life);
        m.scale.setScalar(Math.max(0.01, s));
      }
    }
    for (const [id, m] of this.hazardMeshes) {
      if (!seenH.has(id)) {
        disposeObject(m);
        this.hazardMeshes.delete(id);
      }
    }
    // moving track hazards
    for (const h of sim.movingHazards) {
      if (h.def.kind === 'train') continue;
      let m = this.movingMeshes.get(h.id);
      if (!m) {
        m = buildMovingHazard(h);
        this.movingMeshes.set(h.id, m);
        this.group.add(m);
      }
      m.position.set(h.pos.x, h.pos.y, h.pos.z);
      m.rotation.y = h.yaw + (h.def.kind === 'snowplow' ? Math.PI / 2 * Math.sign(Math.cos(((time + h.phase) / (h.def.period ?? 4)) * Math.PI * 2)) : 0);
      if (h.def.kind === 'rollingFruit') m.children[0].rotation.x = time * 5;
      if (h.def.kind === 'sprinkler' && fx && Math.random() < 0.8) {
        const a = time * 3 + h.id;
        fx.smoke.emit({ x: h.pos.x, y: h.pos.y + 0.8, z: h.pos.z, vx: Math.cos(a) * 6, vy: 5, vz: Math.sin(a) * 6, color: '#bfe8ff', size: 0.35, life: 0.9, gravity: 12, drag: 0.5 });
      }
      if (h.def.kind === 'tennisBallCannon') m.rotation.y = h.yaw + Math.sin(time) * 0.5;
    }
    void dt;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [...this.projMeshes.values(), ...this.hazardMeshes.values(), ...this.movingMeshes.values()]) disposeObject(m);
    this.disposables.forEach((d) => d.dispose());
  }
}

function disposeObject(o: THREE.Object3D): void {
  o.removeFromParent();
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => m.dispose());
    }
  });
}

function haloTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 6, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  // four-point sparkle
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillRect(31, 2, 2, 60);
  g.fillRect(2, 31, 60, 2);
  return new THREE.CanvasTexture(c);
}

function questionTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.font = 'bold 110px "Baloo 2", Arial Black, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = '#7a3c00';
  g.strokeText('?', 64, 70);
  g.fillStyle = '#ffd93a';
  g.fillText('?', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...extra });

function buildProjectile(p: Projectile): THREE.Object3D {
  const g = new THREE.Group();
  if (p.kind === 'pizza') {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-0.7, 1.4);
    shape.quadraticCurveTo(0, 1.7, 0.7, 1.4);
    shape.lineTo(0, 0);
    const slice = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.15, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05 }), std('#ffcf5a'));
    slice.rotation.x = -Math.PI / 2;
    slice.position.z = -0.7;
    g.add(slice);
    for (let i = 0; i < 4; i++) {
      const pep = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 12), std('#c8312a'));
      pep.position.set((i % 2 - 0.5) * 0.4, 0.2, -0.2 + Math.floor(i / 2) * 0.45);
      g.add(pep);
    }
    const crust = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.12, 8, 16, Math.PI * 0.45), std('#c98a3a'));
    crust.rotation.x = -Math.PI / 2;
    crust.rotation.z = Math.PI * 0.27;
    crust.position.set(0, 0.1, -0.7);
    g.add(crust);
  } else if (p.kind === 'pie') {
    const tin = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.65, 0.35, 20), std('#d9d9e0', { metalness: 0.7, roughness: 0.3 }));
    const fill = new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1), std('#e9b46a'));
    fill.position.y = 0.15;
    const cream = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), std('#ffffff'));
    cream.position.y = 0.45;
    const cherry = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), std('#e0103a', { roughness: 0.2 }));
    cherry.position.y = 0.72;
    g.add(tin, fill, cream, cherry);
  } else {
    const bone = new THREE.Group();
    const mat = std('#fff6e0', { roughness: 0.6 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 2.4, 14).rotateZ(Math.PI / 2), mat);
    bone.add(shaft);
    for (const x of [-1.25, 1.25]) for (const z of [-0.3, 0.3]) {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), mat);
      knob.position.set(x, 0, z);
      bone.add(knob);
    }
    g.add(bone);
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}

function buildHazard(h: DroppedHazard): THREE.Object3D {
  const g = new THREE.Group();
  if (h.kind === 'banana') {
    const mat = std('#ffd83a', { roughness: 0.4 });
    for (let i = 0; i < 3; i++) {
      const peel = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.7, 4, 8), mat);
      peel.rotation.set(1.1, (i * Math.PI * 2) / 3, 0);
      peel.position.set(Math.sin((i * Math.PI * 2) / 3) * 0.35, 0.18, Math.cos((i * Math.PI * 2) / 3) * 0.35);
      g.add(peel);
    }
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.4, 8), std('#6b4a1a'));
    stem.position.y = 0.45;
    g.add(stem);
  } else if (h.kind === 'tennisBall') {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.55, 18, 14), std('#d7f23a', { roughness: 0.9 }));
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.04, 6, 32), std('#ffffff'));
    seam.rotation.x = Math.PI / 2.4;
    ball.add(seam);
    g.add(ball);
  } else {
    const hole = new THREE.Mesh(new THREE.CircleGeometry(2.0, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#1a1410' }));
    hole.position.y = 0.06;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.28, 6, 20).rotateX(Math.PI / 2), std('#4a4038', { roughness: 1 }));
    rim.position.y = 0.1;
    for (let i = 0; i < 7; i++) {
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25 + Math.random() * 0.2), std('#3a3a3a'));
      const a = Math.random() * Math.PI * 2;
      chunk.position.set(Math.cos(a) * 2.4, 0.15, Math.sin(a) * 2.4);
      g.add(chunk);
    }
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.1, 12), std('#ff7a1a'));
    cone.position.set(2.5, 0.55, 0);
    g.add(hole, rim, cone);
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}

function buildMovingHazard(h: MovingHazard): THREE.Object3D {
  const g = new THREE.Group();
  switch (h.def.kind) {
    case 'rollingFruit': {
      const colors = ['#ff8c1a', '#e8262e', '#8fd13a'];
      const fruit = new THREE.Mesh(new THREE.SphereGeometry(h.radius, 24, 18), std(colors[h.id % 3], { roughness: 0.35 }));
      fruit.position.y = h.radius;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(h.radius * 0.3, 8, 6).scale(1, 0.3, 0.6), std('#3c9a2a'));
      leaf.position.y = h.radius;
      fruit.add(leaf);
      g.add(fruit);
      break;
    }
    case 'snowplow': {
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.2, 4), std('#ff9a1a'));
      body.position.y = 1.6;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.3, 1.8), std('#2d3b4f', { metalness: 0.4 }));
      cab.position.set(0, 3.2, -0.6);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.4, 0.4), std('#e9e9e9', { metalness: 0.6 }));
      blade.position.set(0, 0.8, 2.3);
      blade.rotation.y = 0.25;
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffb020' }));
      light.position.set(0, 4, -0.6);
      for (const [x, z] of [[-1.2, 1.2], [1.2, 1.2], [-1.2, -1.3], [1.2, -1.3]]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.5, 14).rotateZ(Math.PI / 2), std('#1d1d1d'));
        w.position.set(x, 0.6, z);
        g.add(w);
      }
      g.add(body, cab, blade, light);
      break;
    }
    case 'tennisBallCannon': {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 1.2, 16), std('#3a6fd8'));
      base.position.y = 0.6;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 2.4, 16).rotateX(Math.PI / 2.6), std('#ffd23a'));
      barrel.position.set(0, 1.8, 0.4);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(h.radius * 0.6, 16, 12), std('#d7f23a', { roughness: 0.9 }));
      ball.position.y = 0.6;
      g.add(base, barrel, ball);
      break;
    }
    case 'sprinkler': {
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 0.6, 10), std('#2a8a3a'));
      head.position.y = 0.3;
      g.add(head);
      break;
    }
    default: {
      const s = new THREE.Mesh(new THREE.SphereGeometry(h.radius, 16, 12), std('#ff4040'));
      s.position.y = h.radius;
      g.add(s);
    }
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}

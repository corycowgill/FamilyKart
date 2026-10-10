import * as THREE from 'three';
import type { RaceSim } from '../sim/race/RaceSim';
import type { DroppedHazard, MovingHazard, Projectile } from '../sim/types';
import { SPRITE, type Effects } from './Particles';

const BOX_COLORS = ['#ff4a5a', '#ffd23a', '#3ec1ff', '#7cff6a', '#e56cff'];

/** Item box shatter: coloured glassy shards, sparkle stars and a quick ring flash. */
export function shatterBox(fx: Effects, x: number, y: number, z: number): void {
  const n = fx.n(22);
  for (let i = 0; i < n; i++) {
    const c = BOX_COLORS[i % BOX_COLORS.length];
    fx.smoke.emit({ x, y, z, spread: 7, vy: 5, color: c, sprite: SPRITE.SHARD, size: 0.42, life: 0.9, gravity: 16, drag: 1.2, spin: 12, floor: y - 1.2 });
  }
  for (let i = 0; i < fx.n(14); i++) {
    fx.glow.emit({ x, y, z, spread: 6, vy: 2, color: BOX_COLORS[i % 5], sprite: i % 2 ? SPRITE.SPARKLE : SPRITE.STAR, size: 0.55, life: 0.6, drag: 3, spin: 6, curve: 'shrink' });
  }
  fx.glow.emit({ x, y, z, color: '#fff2b0', sprite: SPRITE.BURST, size: 3.2, life: 0.22, curve: 'flash', grow: 1.5 });
  fx.rings.spawn({ x, y, z, color: '#ffe27a', size: 2.6, life: 0.35, thickness: 0.22 });
}

/** Projectile impact: toon "pow" + flavour bits (cheese & pepperoni / whipped cream / bone dust). */
export function projectileImpact(fx: Effects, kind: string, x: number, y: number, z: number): void {
  if (kind === 'pie') {
    creamSplat(fx, x, y, z);
    return;
  }
  const hot = kind === 'pizza';
  fx.glow.emit({ x, y, z, color: hot ? '#ffb347' : '#fff1d0', sprite: SPRITE.BURST, size: 3.4, life: 0.3, curve: 'flash', grow: 1.6, rot: Math.random() * 6 });
  for (let i = 0; i < fx.n(16); i++) fx.glow.emit({ x, y, z, spread: 8, vy: 4, color: i % 2 ? '#ffd23f' : '#ffffff', size: 0.3, life: 0.45, gravity: 12, drag: 1.5, stretch: 1 });
  for (let i = 0; i < fx.n(6); i++) fx.puff(x, y, z, hot ? '#ffd9a0' : '#e8dcc4', 1.0, { spread: 3, vy: 1.5, life: 0.7 });
  if (hot) {
    for (let i = 0; i < fx.n(10); i++) {
      const pep = i % 3 === 0;
      fx.smoke.emit({ x, y, z, spread: 6, vy: 5, color: pep ? '#c8312a' : '#ffd84a', sprite: pep ? SPRITE.BALL : SPRITE.BLOB, size: pep ? 0.32 : 0.28, life: 0.9, gravity: 14, spin: 6, floor: y - 1.5 });
    }
  }
  fx.rings.spawn({ x, y, z, color: hot ? '#ffb347' : '#ffffff', size: 3.2, life: 0.35, thickness: 0.2, normal: new THREE.Vector3(0, 1, 0) });
}

/** Grandma's pie: big whipped-cream splat with dripping blobs. */
export function creamSplat(fx: Effects, x: number, y: number, z: number): void {
  fx.smoke.emit({ x, y, z, color: '#ffffff', sprite: SPRITE.BLOB, size: 3.0, life: 0.5, curve: 'shrink', grow: 1.3 });
  for (let i = 0; i < fx.n(22); i++) fx.smoke.emit({ x, y, z, spread: 6, vy: 4, color: i % 5 === 0 ? '#e9b46a' : '#fffaf5', sprite: SPRITE.BLOB, size: 0.4 + Math.random() * 0.3, life: 1.1, gravity: 13, spin: 3, floor: y - 1.4 });
  for (let i = 0; i < fx.n(5); i++) fx.glow.emit({ x, y, z, spread: 4, vy: 2, color: '#ff9ad5', sprite: SPRITE.STAR, size: 0.5, life: 0.5, spin: 6, curve: 'shrink' });
  fx.dustRings.spawn({ x, y: y - 0.4, z, color: '#ffffff', size: 3.0, life: 0.5, thickness: 0.4, style: 1, alpha: 0.9 });
}

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
      if (hidden && wasVisible && fx) shatterBox(fx, g.position.x, g.position.y, g.position.z);
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
      if (fx) this.projectileTrail(fx, p, m, time);
    }
    for (const [id, m] of this.projMeshes) {
      if (!seenP.has(id)) {
        if (fx) projectileImpact(fx, m.userData.kind as string, m.position.x, m.position.y, m.position.z);
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
        m.userData.kind = h.kind;
        this.hazardMeshes.set(h.id, m);
        this.group.add(m);
        if (fx) hazardSpawn(fx, h);
      }
      if (fx && h.kind === 'pothole' && h.age < 0.5 && Math.random() < 0.5) {
        // asphalt still crumbling in
        const a = Math.random() * Math.PI * 2;
        fx.smoke.emit({ x: h.pos.x + Math.cos(a) * 1.8, y: h.pos.y + 0.3, z: h.pos.z + Math.sin(a) * 1.8, vy: 2.5, spread: 1.2, color: '#4a4440', sprite: SPRITE.SHARD, size: 0.3, life: 0.6, gravity: 12, spin: 8, floor: h.pos.y + 0.05 });
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
        if (fx) {
          for (let i = 0; i < fx.n(5); i++) fx.puff(m.position.x, m.position.y + 0.4, m.position.z, m.userData.kind === 'banana' ? '#fff2a0' : '#d9d2c8', 0.8, { spread: 2, vy: 1.5, life: 0.5 });
          if (m.userData.kind === 'banana') for (let i = 0; i < fx.n(8); i++) fx.smoke.emit({ x: m.position.x, y: m.position.y + 0.3, z: m.position.z, spread: 4, vy: 4, color: '#ffd83a', sprite: SPRITE.BLOB, size: 0.25, life: 0.6, gravity: 14, floor: m.position.y });
        }
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

  private projectileTrail(fx: Effects, p: Projectile, m: THREE.Object3D, time: number): void {
    const x = m.position.x, y = m.position.y, z = m.position.z;
    const glow = m.userData.glow as THREE.Sprite | undefined;
    if (glow) {
      glow.material.rotation = time * 6;
      glow.scale.setScalar(2.6 + Math.sin(time * 18) * 0.3);
    }
    const dx = p.pos.x - p.prevPos.x, dz = p.pos.z - p.prevPos.z;
    const d = Math.hypot(dx, dz) || 1;
    const bx = -dx / d, bz = -dz / d;
    if (p.kind === 'pizza') {
      // stretchy cheese strings sagging behind + hot sparks
      if (Math.random() < 0.8) fx.smoke.emit({ x: x + bx * 0.6, y: y + 0.1, z: z + bz * 0.6, vx: bx * 2, vz: bz * 2, vy: 0.5, spread: 0.4, color: '#ffe066', color2: '#ffc93a', sprite: SPRITE.SOFT, size: 0.22, life: 0.5, gravity: 7, drag: 1, stretch: 2.5 });
      if (Math.random() < 0.5) fx.glow.emit({ x, y: y + 0.2, z, spread: 0.8, vy: 0.5, color: '#ffb347', sprite: SPRITE.SPARKLE, size: 0.4, life: 0.35, spin: 6, curve: 'shrink' });
    } else if (p.kind === 'pie') {
      if (Math.random() < 0.7) fx.glow.emit({ x, y: y + 0.5, z, spread: 0.8, color: '#ff9ad5', sprite: Math.random() < 0.5 ? SPRITE.STAR : SPRITE.SPARKLE, size: 0.42, life: 0.45, spin: 5, curve: 'shrink' });
      if (Math.random() < 0.3) fx.smoke.emit({ x, y: y + 0.3, z, spread: 0.6, vy: 1, color: '#ffffff', sprite: SPRITE.BLOB, size: 0.2, life: 0.5, gravity: 9 });
    } else {
      // giant bone: rolling dust clouds kicked up from the road
      if (Math.random() < 0.7) fx.smoke.emit({ x: x + bx * 1.2 + (Math.random() - 0.5) * 2, y: y - 0.3, z: z + bz * 1.2, vx: bx * 2, vz: bz * 2, vy: 1.2, spread: 0.6, color: '#d8c6a4', sprite: SPRITE.DUST, size: 1.0, life: 0.7, grow: 2, drag: 2, curve: 'shrink', spin: 1 });
      if (Math.random() < 0.3) fx.smoke.emit({ x, y: y - 0.3, z, vx: bx * 3, vz: bz * 3, vy: 3, spread: 1.5, color: '#8a7a60', sprite: SPRITE.SHARD, size: 0.18, life: 0.5, gravity: 14, spin: 10, floor: y - 0.5 });
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [...this.projMeshes.values(), ...this.hazardMeshes.values(), ...this.movingMeshes.values()]) disposeObject(m);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** New dropped hazard: banana plop, tennis-ball bounce, pothole crumbling asphalt. */
function hazardSpawn(fx: Effects, h: DroppedHazard): void {
  const { x, y, z } = h.pos;
  if (h.kind === 'pothole') {
    for (let i = 0; i < fx.n(18); i++) fx.smoke.emit({ x, y: y + 0.3, z, spread: 5, vy: 5, color: i % 3 ? '#3a3632' : '#6a625a', sprite: SPRITE.SHARD, size: 0.35, life: 0.9, gravity: 14, spin: 10, floor: y + 0.05 });
    for (let i = 0; i < fx.n(8); i++) fx.puff(x, y + 0.4, z, '#a89c8c', 1.4, { spread: 3, vy: 1.6, life: 1.0, grow: 2.2 });
    fx.dustRings.spawn({ x, y: y + 0.15, z, color: '#b8ab98', size: 4.2, life: 0.6, thickness: 0.35, style: 1, alpha: 0.8 });
  } else if (h.kind === 'banana') {
    for (let i = 0; i < fx.n(4); i++) fx.puff(x, y + 0.3, z, '#f4ecd0', 0.6, { spread: 1.5, vy: 1, life: 0.5 });
    fx.glow.emit({ x, y: y + 0.8, z, color: '#ffe14a', sprite: SPRITE.STAR, size: 0.6, life: 0.4, curve: 'shrink', spin: 4 });
  } else {
    for (let i = 0; i < fx.n(8); i++) fx.smoke.emit({ x, y: y + 0.5, z, spread: 4, vy: 4, color: i % 2 ? '#d7f23a' : '#ffffff', sprite: SPRITE.CONFETTI, size: 0.26, life: 1.0, gravity: 8, drag: 1.5, flutter: true });
    fx.puff(x, y + 0.3, z, '#efe6cf', 0.8, { spread: 1, vy: 1 });
  }
}

function disposeObject(o: THREE.Object3D): void {
  o.removeFromParent();
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => m.dispose());
    } else if (c instanceof THREE.Sprite) {
      c.material.dispose();
    }
  });
}

let sharedHalo: THREE.Texture | null = null;
function haloTex(): THREE.Texture {
  return (sharedHalo ??= haloTexture());
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
  g.userData.kind = p.kind;
  if (p.kind !== 'bone') {
    // spinning additive glow behind the projectile (catches the bloom)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex(), color: new THREE.Color(p.kind === 'pizza' ? '#ffb347' : '#ff9ad5').multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }));
    glow.scale.setScalar(2.6);
    glow.position.y = 0.3;
    glow.renderOrder = 6;
    g.add(glow);
    g.userData.glow = glow;
  }
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

import * as THREE from 'three';

interface Arc {
  center: () => THREE.Vector3 | null;
  life: number;
  radius: number;
  color: THREE.Color;
  flick: number;
}

const BOLTS = 4;
const SEGS = 6;

/**
 * Electric arcs (Lightning Dash): jagged bolts re-randomised every frame around a moving centre.
 * All arcs share one additive LineSegments draw call; callers add glow sparks for thickness.
 */
export class Arcs {
  readonly lines: THREE.LineSegments;
  private arcs: Arc[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.LineBasicMaterial;
  /** endpoints of the bolts drawn this frame (for spark emission) */
  readonly tips: THREE.Vector3[] = [];

  constructor(private maxArcs = 6) {
    const n = maxArcs * BOLTS * SEGS * 2;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 7;
  }

  add(center: () => THREE.Vector3 | null, life: number, color: THREE.ColorRepresentation, radius = 2.6): void {
    if (this.arcs.length >= this.maxArcs) this.arcs.shift();
    this.arcs.push({ center, life, radius, color: new THREE.Color(color).multiplyScalar(2.5), flick: 0 });
  }

  update(dt: number): void {
    this.tips.length = 0;
    let v = 0;
    this.arcs = this.arcs.filter((a) => (a.life -= dt) > 0);
    for (const a of this.arcs) {
      const c = a.center();
      if (!c) continue;
      for (let b = 0; b < BOLTS; b++) {
        if (Math.random() < 0.25) continue; // flicker
        const th = Math.random() * Math.PI * 2;
        const ph = (Math.random() - 0.3) * 1.2;
        const r = a.radius * (0.6 + Math.random() * 0.5);
        const ex = c.x + Math.cos(th) * Math.cos(ph) * r, ey = c.y + 0.6 + Math.sin(ph) * r * 0.6, ez = c.z + Math.sin(th) * Math.cos(ph) * r;
        let px = c.x + (Math.random() - 0.5) * 0.4, py = c.y + 0.8, pz = c.z + (Math.random() - 0.5) * 0.4;
        for (let s = 1; s <= SEGS; s++) {
          const f = s / SEGS;
          const j = s === SEGS ? 0 : 0.45 * a.radius / 2.6;
          const nx = c.x + (ex - c.x) * f + (Math.random() - 0.5) * j, ny = c.y + 0.8 + (ey - c.y - 0.8) * f + (Math.random() - 0.5) * j, nz = c.z + (ez - c.z) * f + (Math.random() - 0.5) * j;
          const o = v * 3;
          this.pos[o] = px; this.pos[o + 1] = py; this.pos[o + 2] = pz;
          this.pos[o + 3] = nx; this.pos[o + 4] = ny; this.pos[o + 5] = nz;
          const k = 1 - f * 0.5;
          for (let q = 0; q < 2; q++) {
            this.col[o + q * 3] = a.color.r * k;
            this.col[o + q * 3 + 1] = a.color.g * k;
            this.col[o + q * 3 + 2] = a.color.b * k;
          }
          v += 2;
          px = nx; py = ny; pz = nz;
        }
        this.tips.push(new THREE.Vector3(ex, ey, ez));
      }
    }
    this.geo.setDrawRange(0, v);
    if (v > 0) {
      (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  get activeCount(): number {
    return this.arcs.length;
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

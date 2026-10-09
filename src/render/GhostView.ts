import * as THREE from 'three';
import { characterById } from '../data/characters';
import type { GhostData } from '../persist/Save';
import { buildCharacter } from './models/characterModels';
import { buildKart } from './models/kartModels';

/** Translucent replay of the best time-trial run, sampled at 10 Hz and interpolated. */
export class GhostView {
  readonly root = new THREE.Group();
  constructor(private ghost: GhostData) {
    const kart = buildKart(characterById(ghost.character));
    const ch = buildCharacter(ghost.character);
    kart.seat.add(ch.root);
    this.root.add(kart.root);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        o.material = mats.map((m) => {
          const c = (m as THREE.Material).clone() as THREE.MeshStandardMaterial;
          c.transparent = true;
          c.opacity = 0.35;
          c.depthWrite = false;
          return c;
        });
        o.castShadow = false;
      }
    });
  }

  update(raceTime: number): void {
    const f = this.ghost.frames;
    const n = f.length / 4;
    if (n < 2 || raceTime < 0) {
      this.root.visible = raceTime < 0 ? false : this.root.visible;
      return;
    }
    const idx = raceTime / 0.1;
    const i = Math.min(n - 2, Math.floor(idx));
    const t = Math.min(1, idx - i);
    this.root.visible = idx < n;
    const a = i * 4, b = (i + 1) * 4;
    this.root.position.set(f[a] + (f[b] - f[a]) * t, f[a + 1] + (f[b + 1] - f[a + 1]) * t, f[a + 2] + (f[b + 2] - f[a + 2]) * t);
    let dy = f[b + 3] - f[a + 3];
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    this.root.rotation.y = f[a + 3] + dy * t;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

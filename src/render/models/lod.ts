import * as THREE from 'three';

/**
 * Level-of-detail plumbing shared by the kart and character builders.
 *
 * Every rig keeps ONE animated hierarchy (the nodes KartView / the character animator drive). Each
 * animated node that carries geometry gets a single `THREE.LOD` child whose level objects are plain
 * groups of static meshes — so animation drives one hierarchy and the LOD only swaps which static
 * level is drawn underneath each moving node.
 *
 * Levels: 0 = high (close-ups, chase cam), 1 = medium, 2 = low. Which ones are built depends on the
 * module-level model quality (see `setModelQuality`).
 *
 * Freshly built rigs are "pinned" to their most detailed level (LOD.autoUpdate = false) so close-up
 * views (showroom, podium, portraits) always show the best level that was built. `optimizeKartRig`
 * (used by in-race KartViews) switches every LOD to distance-based selection.
 */

export type ModelQuality = 'low' | 'medium' | 'high';
export type Lv = 0 | 1 | 2;

let quality: ModelQuality = 'high';

/** Pick which detail levels the next buildKart()/buildCharacter() calls produce. Default 'high'. */
export function setModelQuality(q: ModelQuality): void {
  quality = q;
}

export function getModelQuality(): ModelQuality {
  return quality;
}

/** Levels built for the current quality, most detailed first. */
export function builtLevels(q: ModelQuality = quality): Lv[] {
  return q === 'high' ? [0, 1, 2] : q === 'medium' ? [1, 2] : [2];
}

/** Camera distance (m) at which each level starts being used. */
export const LOD_DISTANCE: Record<Lv, number> = { 0: 0, 1: 11, 2: 26 };
const HYSTERESIS = 0.08;

/** Per-rig helper: hands out one level group per (animated node, level). */
export class Lods {
  readonly levels: Lv[];
  private slots = new Map<THREE.Object3D, Map<Lv, THREE.Group>>();

  constructor(levels: Lv[] = builtLevels()) {
    this.levels = levels;
  }

  get top(): Lv {
    return this.levels[0];
  }

  /** The level groups under `node` (created on first use), keyed by level. */
  slot(node: THREE.Object3D): Map<Lv, THREE.Group> {
    let s = this.slots.get(node);
    if (s) return s;
    s = new Map();
    const lod = new THREE.LOD();
    lod.name = 'lod';
    lod.autoUpdate = false;
    node.add(lod);
    for (const lv of this.levels) {
      const g = new THREE.Group();
      g.name = `lod${lv}`;
      lod.addLevel(g, lv === this.levels[0] ? 0 : LOD_DISTANCE[lv], HYSTERESIS);
      g.visible = lv === this.levels[0];
      s.set(lv, g);
    }
    this.slots.set(node, s);
    return s;
  }

  /** Run `fill(group, lv)` once per built level for `node`. */
  each(node: THREE.Object3D, fill: (g: THREE.Group, lv: Lv) => void): void {
    for (const [lv, g] of this.slot(node)) fill(g, lv);
  }
}

/** Switch every LOD under `root` to automatic, camera-distance based level selection (in-race use). */
export function enableAutoLod(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.LOD).isLOD) (o as THREE.LOD).autoUpdate = true;
  });
}

/** Pin every LOD under `root` to its most detailed level (close-up views). */
export function pinTopLod(root: THREE.Object3D): void {
  root.traverse((o) => {
    const lod = o as THREE.LOD;
    if (!lod.isLOD) return;
    lod.autoUpdate = false;
    lod.levels.forEach((l, i) => (l.object.visible = i === 0));
  });
}

/** Pick a value by level: [high, medium, low]. */
export function byLv<T>(lv: Lv, hi: T, med: T, low: T): T {
  return lv === 0 ? hi : lv === 1 ? med : low;
}

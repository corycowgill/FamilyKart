import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CharacterAnimState, CharacterRig, KartRig } from './types';

/**
 * Draw-call optimiser for the procedural kart + driver rigs.
 *
 * A rig is ~120-150 small meshes but only a handful of them ever move. We find the animated nodes
 * empirically: snapshot every node, drive the rig through all of its animation states via `probe`
 * (which calls `sample()` after each step), and flag any node whose local transform, visibility,
 * material or geometry changed. Every other leaf mesh is static relative to its parent, so static
 * siblings sharing a material are merged into one mesh under that same parent. Animated nodes
 * (and anything listed in `keep`) are left untouched, so the rig code's references stay valid.
 * Materials are shared, not cloned, so property tweaks (face texture swaps, colour pulses) still apply.
 */
export function mergeStaticMeshes(root: THREE.Object3D, probe: (sample: () => void) => void, keep: Iterable<THREE.Object3D> = []): { before: number; after: number } {
  interface Snap { e: number[]; visible: boolean; material: unknown; geometry: unknown }
  const snaps = new Map<THREE.Object3D, Snap>();
  const animated = new Set<THREE.Object3D>(keep);
  const snap = (o: THREE.Object3D): Snap => {
    o.updateMatrix();
    const m = o as THREE.Mesh;
    return { e: Array.from(o.matrix.elements), visible: o.visible, material: m.material, geometry: m.geometry };
  };
  root.traverse((o) => snaps.set(o, snap(o)));
  const sample = () => {
    for (const [o, s] of snaps) {
      if (animated.has(o)) continue;
      const n = snap(o);
      if (n.visible !== s.visible || n.material !== s.material || n.geometry !== s.geometry || n.e.some((v, i) => Math.abs(v - s.e[i]) > 1e-5)) animated.add(o);
    }
  };
  probe(sample);

  let before = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) before++;
  });

  // A static mesh can merge up to its nearest moving (or kept) ancestor: every node in between is static,
  // so its transform relative to that anchor never changes.
  const anchors = new Map<THREE.Mesh, THREE.Object3D>();
  const anchorOf = (m: THREE.Object3D): THREE.Object3D => {
    let a = m.parent!;
    while (a !== root && !animated.has(a) && a.parent) a = a.parent;
    return a;
  };
  root.updateMatrixWorld(true);
  const groups = new Map<string, THREE.Mesh[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (animated.has(m) || m.children.length || !m.parent || Array.isArray(m.material)) return;
    const g = m.geometry;
    if (!g || g.morphAttributes.position) return; // draw groups are irrelevant with a single material
    if (!g.attributes.position) return;
    const anchor = anchorOf(m);
    anchors.set(m, anchor);
    const key = [anchor.uuid, (m.material as THREE.Material).uuid, m.castShadow, m.receiveShadow, m.renderOrder, m.frustumCulled].join('|');
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(m);
  });

  for (const meshes of groups.values()) {
    if (meshes.length < 2 && meshes[0].parent === anchors.get(meshes[0])) continue;
    const wantColor = !!(meshes[0].material as THREE.MeshStandardMaterial).vertexColors;
    const anchor = anchors.get(meshes[0])!;
    const toAnchor = new THREE.Matrix4().copy(anchor.matrixWorld).invert();
    const geos = meshes.map((m) => normalize(m.geometry, new THREE.Matrix4().multiplyMatrices(toAnchor, m.matrixWorld), wantColor));
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const first = meshes[0];
    const mesh = new THREE.Mesh(merged, first.material);
    mesh.name = 'merged-static';
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    mesh.frustumCulled = first.frustumCulled;
    anchor.add(mesh);
    // originals may share cached geometries with other rigs, so only detach them
    for (const m of meshes) m.removeFromParent();
  }

  let after = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) after++;
  });
  return { before, after };
}


/** Bring a geometry to a common layout (non-indexed position/normal/uv[/color]) so siblings can merge. */
function normalize(src: THREE.BufferGeometry, matrix: THREE.Matrix4, wantColor: boolean): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const out = new THREE.BufferGeometry();
  const n = g.attributes.position.count;
  out.setAttribute('position', g.attributes.position);
  if (!g.attributes.normal) g.computeVertexNormals();
  out.setAttribute('normal', g.attributes.normal);
  out.setAttribute('uv', g.attributes.uv ?? new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (wantColor) out.setAttribute('color', g.attributes.color ?? new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  out.applyMatrix4(matrix);
  return out;
}

/**
 * Merge the static parts of an assembled kart + driver (call after the driver is seated, before
 * effects are attached). The driver is run through every animation state to discover moving parts;
 * the kart's wheels, steering pivots, body, seat and effect anchors are always kept.
 */
export function optimizeKartRig(kart: KartRig, character: CharacterRig): { before: number; after: number } {
  const keep = [kart.body, kart.seat, ...kart.wheels, ...kart.frontPivots, ...kart.exhausts, ...kart.rearContacts, character.root];
  return mergeStaticMeshes(kart.root, (sample) => {
    const reactions: CharacterAnimState['reaction'][] = ['none', 'hit', 'item', 'overtake', 'jump', 'win', 'lose'];
    let time = 0;
    const run = (s: Partial<CharacterAnimState>, steps: number) => {
      for (let i = 0; i < steps; i++) {
        time += 0.05;
        const rt = s.reaction && s.reaction !== 'none' ? Math.max(0.01, 1.2 - i * 0.05) : 0;
        character.update(0.05, { steer: 0, speed: 0, drifting: false, driftDir: 0, airborne: false, boosting: false, reaction: 'none', reactionTime: rt, time, ...s });
        sample();
      }
    };
    run({ speed: 0 }, 70); // idle long enough to catch blinks
    for (const steer of [-1, 1]) run({ steer, speed: 25 }, 12);
    run({ drifting: true, driftDir: 1, steer: 1, speed: 25 }, 12);
    run({ drifting: true, driftDir: -1, steer: -1, speed: 25 }, 12);
    run({ airborne: true, speed: 30 }, 12);
    run({ boosting: true, speed: 35 }, 12);
    for (const reaction of reactions) run({ reaction, speed: 15 }, 26);
    run({ speed: 0 }, 20);
  }, keep);
}

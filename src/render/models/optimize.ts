import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { enableAutoLod } from './lod';
import { cachedGeo } from './materials';
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
 *
 * Level of detail: every `THREE.LOD` and each of its level objects is a merge anchor, so meshes are
 * only ever merged within one detail level (the LOD keeps switching whole level groups). By the rig
 * contract (see lod.ts) nothing below an LOD level moves, so those subtrees are not probed.
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
  // LODs + their level groups are anchors; their (static) contents are not probed
  const probeTree = (o: THREE.Object3D) => {
    if ((o as THREE.LOD).isLOD) {
      animated.add(o);
      for (const l of (o as THREE.LOD).levels) animated.add(l.object);
      return;
    }
    snaps.set(o, snap(o));
    for (const c of o.children) probeTree(c);
  };
  probeTree(root);
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
    // shadow flags are not part of the key (tiny no-shadow details would otherwise cost extra draw calls);
    // the merged mesh casts / receives if any part did
    const key = [anchor.uuid, (m.material as THREE.Material).uuid, m.renderOrder, m.frustumCulled].join('|');
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
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
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


/**
 * Build-time merge inside every LOD level: everything below a level object is static relative to it
 * (rig contract), so its visible leaf meshes are merged per material. This keeps the draw calls of
 * un-optimised close-up rigs (showroom, podium, portraits, ghost) low. Merged geometry is cached under
 * `rigKey` when the material is shared, so identical racers share one copy.
 */
export function mergeLodLevels(root: THREE.Object3D, rigKey: string): void {
  const lods: THREE.LOD[] = [];
  root.traverse((o) => {
    if ((o as THREE.LOD).isLOD) lods.push(o as THREE.LOD);
  });
  root.updateMatrixWorld(true);
  const pathOf = (o: THREE.Object3D): string => {
    const parts: number[] = [];
    while (o !== root && o.parent) {
      parts.push(o.parent.children.indexOf(o));
      o = o.parent;
    }
    return parts.reverse().join('.');
  };
  for (const lod of lods) {
    const path = pathOf(lod);
    for (const level of lod.levels) {
      const lg = level.object;
      const inv = new THREE.Matrix4().copy(lg.matrixWorld).invert();
      const groups = new Map<string, THREE.Mesh[]>();
      lg.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || !m.visible || m.children.length || Array.isArray(m.material)) return;
        if (!m.geometry?.attributes.position || m.geometry.morphAttributes.position) return;
        const key = [(m.material as THREE.Material).uuid, m.renderOrder, m.frustumCulled].join('|');
        let arr = groups.get(key);
        if (!arr) groups.set(key, (arr = []));
        arr.push(m);
      });
      let gi = 0;
      for (const meshes of groups.values()) {
        gi++;
        if (meshes.length < 2) continue;
        const first = meshes[0];
        const mat = first.material as THREE.MeshStandardMaterial;
        const make = () => {
          const geos = meshes.map((m) => normalize(m.geometry, new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld), !!mat.vertexColors));
          const merged = mergeGeometries(geos, false);
          geos.forEach((g) => g.dispose());
          return merged;
        };
        const merged = mat.userData.shared ? cachedGeo(`lvmerge:${rigKey}:${path}:${lg.name}:${gi}:${mat.uuid}`, () => make() ?? new THREE.BufferGeometry()) : make();
        if (!merged || !merged.attributes.position) continue;
        const mesh = new THREE.Mesh(merged, first.material);
        mesh.name = 'merged-level';
        mesh.castShadow = meshes.some((m) => m.castShadow);
        mesh.receiveShadow = meshes.some((m) => m.receiveShadow);
        mesh.renderOrder = first.renderOrder;
        mesh.frustumCulled = first.frustumCulled;
        lg.add(mesh);
        for (const m of meshes) m.removeFromParent();
      }
    }
  }
}

/** Bring a geometry to a common layout (non-indexed position/normal/uv[/color]) in `matrix` space, in one pass. */
const _v = new THREE.Vector3();
const _nm = new THREE.Matrix3();
function normalize(src: THREE.BufferGeometry, matrix: THREE.Matrix4, wantColor: boolean): THREE.BufferGeometry {
  if (!src.attributes.normal) src.computeVertexNormals();
  const pos = src.attributes.position;
  const nrm = src.attributes.normal;
  const uv = src.attributes.uv;
  const col = src.attributes.color;
  const index = src.index;
  const n = index ? index.count : pos.count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const U = new Float32Array(n * 2);
  const C = wantColor ? new Float32Array(n * 3) : null;
  _nm.getNormalMatrix(matrix);
  for (let i = 0; i < n; i++) {
    const j = index ? index.getX(i) : i;
    _v.fromBufferAttribute(pos, j).applyMatrix4(matrix);
    P[i * 3] = _v.x;
    P[i * 3 + 1] = _v.y;
    P[i * 3 + 2] = _v.z;
    _v.fromBufferAttribute(nrm, j).applyMatrix3(_nm).normalize();
    N[i * 3] = _v.x;
    N[i * 3 + 1] = _v.y;
    N[i * 3 + 2] = _v.z;
    if (uv) {
      U[i * 2] = uv.getX(j);
      U[i * 2 + 1] = uv.getY(j);
    }
    if (C) {
      C[i * 3] = col ? col.getX(j) : 1;
      C[i * 3 + 1] = col ? col.getY(j) : 1;
      C[i * 3 + 2] = col ? col.getZ(j) : 1;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (C) out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  // a mirroring transform flips the winding: swap two vertices per triangle
  if (matrix.determinant() < 0) {
    for (const a of [out.attributes.position, out.attributes.normal, out.attributes.uv, out.attributes.color]) {
      if (!a) continue;
      const arr = a.array as Float32Array;
      const k = a.itemSize;
      for (let t = 0; t + 2 < n; t += 3) {
        for (let c = 0; c < k; c++) {
          const tmp = arr[(t + 1) * k + c];
          arr[(t + 1) * k + c] = arr[(t + 2) * k + c];
          arr[(t + 2) * k + c] = tmp;
        }
      }
    }
  }
  return out;
}

/**
 * Merge the static parts of an assembled kart + driver (call after the driver is seated, before
 * effects are attached). The driver is run through every animation state to discover moving parts;
 * the kart's wheels, steering pivots, body, seat and effect anchors are always kept.
 */
export function optimizeKartRig(kart: KartRig, character: CharacterRig): { before: number; after: number } {
  const keep = [kart.body, kart.seat, ...kart.wheels, ...kart.frontPivots, ...kart.exhausts, ...kart.rearContacts, character.root];
  // in-race views pick the detail level by camera distance (rigs are built pinned to the top level)
  enableAutoLod(kart.root);
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

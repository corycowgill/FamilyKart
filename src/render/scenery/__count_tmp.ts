import * as THREE from 'three';
/** TEMP: scenery triangle / mesh count (removed before hand-off). */
export function countScenery(root: THREE.Object3D, label: string): void {
  let tris = 0, meshes = 0;
  const per: Record<string, number> = {};
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh && !(o as THREE.Points).isPoints) return;
    meshes++;
    const g = m.geometry;
    let t = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if ((m as THREE.InstancedMesh).isInstancedMesh) t *= (m as THREE.InstancedMesh).count;
    tris += t;
    per[m.name || m.type] = (per[m.name || m.type] ?? 0) + t;
  });
  const top = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${Math.round(v / 1000)}k`).join(' ');
  console.warn(`SCENERY ${label} meshes=${meshes} tris=${Math.round(tris)} | ${top}`);
}

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Shared material / geometry caches for the procedural character + kart models.
 * Six karts (and drivers) are on screen at once, so anything that does not vary per instance is
 * created once and reused. Shared resources are tagged `userData.shared = true` so rig dispose()
 * implementations leave them alone.
 */

const matCache = new Map<string, THREE.Material>();
const geoCache = new Map<string, THREE.BufferGeometry>();

function share<T extends THREE.Material | THREE.BufferGeometry>(o: T): T {
  o.userData.shared = true;
  return o;
}

export function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) {
    m = share(make());
    matCache.set(key, m);
  }
  return m;
}

export function cachedGeo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key) as T | undefined;
  if (!g) {
    g = share(make());
    geoCache.set(key, g);
  }
  return g;
}

/** Glossy clear-coated car paint. */
export function paint(color: string, roughness = 0.32): THREE.MeshPhysicalMaterial {
  return cachedMat(`paint:${color}:${roughness}`, () =>
    new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08 }),
  );
}

/** Generic plastic / fabric. */
export function plastic(color: string, roughness = 0.55, metalness = 0): THREE.MeshStandardMaterial {
  return cachedMat(`plastic:${color}:${roughness}:${metalness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness }));
}

export function chrome(): THREE.MeshStandardMaterial {
  return cachedMat('chrome', () => new THREE.MeshStandardMaterial({ color: '#e8ecf2', roughness: 0.18, metalness: 1 }));
}

export function glow(color: string, intensity = 1.5): THREE.MeshStandardMaterial {
  return cachedMat(`glow:${color}:${intensity}`, () =>
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.3 }),
  );
}

/** Fur locks: per-instance colour x per-vertex root->tip shading. */
export function lockMat(): THREE.MeshStandardMaterial {
  return cachedMat('furlock', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, vertexColors: true }));
}

/** White base material for instanced meshes that use per-instance colours. */
export function furMat(): THREE.MeshStandardMaterial {
  return cachedMat('fur', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 }));
}

export function textured(key: string, tex: THREE.Texture | null, fallback: string, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return cachedMat(`tex:${key}`, () =>
    new THREE.MeshStandardMaterial({ color: tex ? '#ffffff' : fallback, map: tex ?? null, roughness: 0.6, ...opts }),
  );
}

/** Decal material: transparent overlay that never z-fights with the surface below. */
export function decalMat(key: string, tex: THREE.Texture | null, roughness = 0.35): THREE.MeshStandardMaterial {
  return cachedMat(`decal:${key}`, () => {
    const m = new THREE.MeshStandardMaterial({
      map: tex ?? null,
      transparent: true,
      opacity: tex ? 1 : 0,
      roughness,
      metalness: 0.05,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    return m;
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

export const sphereGeo = (w = 20, h = 14) => cachedGeo(`sphere:${w}:${h}`, () => new THREE.SphereGeometry(1, w, h));
/** Unit capsule along +Y from y=0 to y=1 (radius 1 * r scaling done by caller is NOT uniform-safe; use capsule()). */
export function capsuleGeo(radius: number, length: number, seg = 10): THREE.BufferGeometry {
  const k = `capsule:${radius.toFixed(3)}:${length.toFixed(3)}:${seg}`;
  return cachedGeo(k, () => new THREE.CapsuleGeometry(radius, length, 3, seg).translate(0, length / 2, 0));
}
export function roundedBox(w: number, h: number, d: number, r: number, seg = 1): THREE.BufferGeometry {
  const k = `rbox:${w.toFixed(3)}:${h.toFixed(3)}:${d.toFixed(3)}:${r.toFixed(3)}:${seg}`;
  return cachedGeo(k, () => new RoundedBoxGeometry(w, h, d, seg, r));
}
export function cylinderGeo(rt: number, rb: number, h: number, seg = 16): THREE.BufferGeometry {
  return cachedGeo(`cyl:${rt}:${rb}:${h}:${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
}

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

/** Orient an object so that its local +Y axis points from `a` to `b`, positioned at `a`. */
const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
export function alignY(o: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): number {
  _d.subVectors(b, a);
  const len = _d.length();
  o.position.copy(a);
  if (len > 1e-6) o.quaternion.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
  return len;
}

/** Frame-rate independent exponential smoothing. */
export function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic tiny PRNG for fur variation (models look identical every load). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Count rendered triangles below an object (InstancedMesh multiplied by instance count). */
export function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry;
    const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    n += tris * inst;
  });
  return Math.round(n);
}

/** Dispose every non-shared geometry / material / texture beneath `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if (mat && !mat.userData.shared) mat.dispose();
  });
}

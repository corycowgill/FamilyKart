import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cachedGeo, clamp } from './materials';

/**
 * Geometry helpers for the high-detail stylised racers: smooth (creased-normal) extrusions, tubes,
 * coil springs, sculpted hair/fur clumps, curls and displaced (sculpted) head spheres. Everything is
 * cached by key and shared between rigs.
 */

/** Smooth shading across soft bevels, hard edges only above `angle` (radians). */
export function creased(g: THREE.BufferGeometry, angle = Math.PI / 5): THREE.BufferGeometry {
  g.deleteAttribute('normal');
  const out = toCreasedNormals(g, angle);
  g.dispose();
  return out;
}

/** Drop uv/normal, weld seams and recompute normals: perfectly smooth closed surfaces. */
export function welded(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  g.dispose();
  return m;
}

/** Tube along a Catmull-Rom path through `pts`. */
export function tubeGeo(key: string, pts: THREE.Vector3[], radius: number, tubular: number, radial: number): THREE.BufferGeometry {
  return cachedGeo(`tube:${key}:${radius}:${tubular}:${radial}`, () => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
    return new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  });
}

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private r: number, private h: number, private turns: number) {
    super();
  }
  getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.r, t * this.h, Math.sin(a) * this.r);
  }
}

/** Coil spring along +Y from 0..h. */
export function helixGeo(r: number, h: number, turns: number, wire: number, seg: number, radial: number): THREE.BufferGeometry {
  return cachedGeo(`helix:${r}:${h}:${turns}:${wire}:${seg}:${radial}`, () => {
    return new THREE.TubeGeometry(new HelixCurve(r, h, turns), seg, wire, radial, false);
  });
}

/** Lathe around Y from (radius, y) pairs. */
export function latheGeo(key: string, prof: Array<[number, number]>, seg: number): THREE.BufferGeometry {
  return cachedGeo(`lathe:${key}:${seg}`, () => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg));
}

/**
 * Sculpted hair / fur clump: a flattened, tapered tube that leaves the root along local -Y and curls
 * towards local -Z (with +Z = scalp normal, positive bend hugs the head, negative flicks outward).
 * Unit half-width 1, length `aspect`, tip offset `bend` (both in half-width units) so instances can be
 * scaled uniformly (correct normals). Root is buried in the scalp, tip is a point. Vertex colours
 * shade root -> tip.
 */
export function clumpGeo(radial: number, rings: number, bend: number, flat = 0.55, aspect = 2.5, soft = 0.6, wave = 0): THREE.BufferGeometry {
  return cachedGeo(`clump3:${radial}:${rings}:${bend}:${flat}:${aspect}:${soft}:${wave}`, () => buildClump(radial, rings, bend, flat, aspect, soft, wave));
}

/** Uncached clump builder (see clumpGeo). */
export function buildClump(radial: number, rings: number, bend: number, flat = 0.55, aspect = 2.5, soft = 0.6, wave = 0): THREE.BufferGeometry {
  {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const center = (t: number) => new THREE.Vector3(wave * Math.sin(t * Math.PI * 2.2) * t, -t * aspect, -bend * t * t);
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const c = center(t);
      // thickness ramps up from the root so clumps grow out of the scalp instead of starting as a step
      const thick = 0.3 + 0.7 * smooth01(Math.min(1, t / 0.55));
      const c2 = center(Math.min(1, t + 0.01));
      const c1 = center(Math.max(0, t - 0.01));
      const tan = c2.sub(c1).normalize();
      const side = new THREE.Vector3(1, 0, 0);
      const nrm = new THREE.Vector3().crossVectors(side, tan).normalize();
      // leaf shape: closed rounded root, widest at ~25%, long pointed tip
      const w = t <= 0 || t >= 1 ? 0 : t < 0.25 ? Math.pow(Math.sin((t / 0.25) * Math.PI * 0.5), 0.6) : Math.pow(Math.cos(((t - 0.25) / 0.75) * Math.PI * 0.5), 0.85);
      const shadeK = 0.5 + 0.56 * Math.pow(t, 0.65); // dark roots read as depth between clumps
      for (let i = 0; i < radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const x = Math.cos(a) * w;
        const z = Math.sin(a) * w * flat * (Math.sin(a) > 0 ? thick : 0.6);
        pos.push(c.x + side.x * x + nrm.x * z, c.y + side.y * x + nrm.y * z, c.z + side.z * x + nrm.z * z);
        const top = 0.93 + 0.07 * Math.sin(a);
        col.push(shadeK * top, shadeK * top * 0.985, shadeK * top * 0.96);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < radial; i++) {
        const a = j * radial + i;
        const b = j * radial + ((i + 1) % radial);
        const c = (j + 1) * radial + i;
        const d = (j + 1) * radial + ((i + 1) % radial);
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (soft > 0) {
      // bend normals towards the scalp normal (+Z) so clumps shade like one sculpted volume
      const nr = g.attributes.normal;
      const v = new THREE.Vector3();
      for (let i = 0; i < nr.count; i++) {
        v.fromBufferAttribute(nr, i);
        v.z += soft;
        v.normalize();
        nr.setXYZ(i, v.x, v.y, v.z);
      }
    }
    return g;
  }
}

function smooth01(x: number): number {
  return x * x * (3 - 2 * x);
}

export interface BakeItem {
  matrix: THREE.Matrix4;
  color: THREE.Color;
  geo: THREE.BufferGeometry;
}

/**
 * Bake many transformed, vertex-coloured copies (hair clumps, fur locks, curls) into ONE geometry:
 * a single draw call that the static-mesh optimiser can merge further. Normals use the proper
 * normal matrix, colours are multiplied by each item's colour.
 */
export function bakeItems(key: string, make: () => BakeItem[]): THREE.BufferGeometry {
  return cachedGeo(`bake:${key}`, () => {
    const items = make();
    const parts = items.map((it) => {
      const g = (it.geo.index ? it.geo.toNonIndexed() : it.geo.clone()) as THREE.BufferGeometry;
      g.applyMatrix4(it.matrix);
      const n = g.attributes.position.count;
      const src = g.attributes.color;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        col[i * 3] = (src ? src.getX(i) : 1) * it.color.r;
        col[i * 3 + 1] = (src ? src.getY(i) : 1) * it.color.g;
        col[i * 3 + 2] = (src ? src.getZ(i) : 1) * it.color.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      if (g.attributes.uv) g.deleteAttribute('uv');
      return g;
    });
    if (!parts.length) return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const out = mergeGeometries(parts, false)!;
    parts.forEach((g) => g.dispose());
    return out;
  });
}

/** Clone of `geo` with a constant vertex colour (so plain shapes can share a vertex-coloured material). */
export function tinted(key: string, geo: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  return cachedGeo(`tint:${key}:${color}`, () => {
    const g = geo.clone();
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
}

/** Puffy perm curl (Grandma): a soft dome with a swirl groove on its face, vertex-shaded. Unit radius, +Z out. */
export function curlGeo(w: number, h: number): THREE.BufferGeometry {
  return cachedGeo(`curl3:${w}:${h}`, () => {
    const g = new THREE.SphereGeometry(1, w, h);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const front = clamp(v.z, 0, 1);
      const rr = Math.hypot(v.x, v.y);
      const phase = Math.atan2(v.y, v.x) + rr * 9;
      const groove = front * (0.5 + 0.5 * Math.cos(phase));
      v.multiplyScalar(1 - groove * 0.14);
      v.z *= 0.72;
      p.setXYZ(i, v.x, v.y, v.z);
      const k = 0.72 + 0.34 * clamp((v.z + 0.4) / 1.1, 0, 1) - groove * 0.12;
      col[i * 3] = k;
      col[i * 3 + 1] = k;
      col[i * 3 + 2] = k * 1.01;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    return g;
  });
}

/**
 * Sphere (or partial sphere) radially displaced by `bump(dphi, theta)` where dphi is the horizontal
 * angle from +Z and theta the polar angle from +Y. Used for sculpted heads: the skull and the face
 * patch use the same function so the textured face sits flush on the sculpted shape.
 */
export function sculptedSphere(
  key: string,
  w: number,
  h: number,
  bump: (dphi: number, theta: number) => number,
  part?: { phiStart: number; phiLen: number; thetaStart: number; thetaLen: number },
): THREE.BufferGeometry {
  return cachedGeo(`sculpt:${key}:${w}:${h}:${part ? 'patch' : 'full'}`, () => {
    let g: THREE.BufferGeometry = part
      ? new THREE.SphereGeometry(1, w, h, part.phiStart, part.phiLen, part.thetaStart, part.thetaLen)
      : new THREE.SphereGeometry(1, w, h);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const theta = Math.acos(clamp(v.y / Math.max(1e-6, v.length()), -1, 1));
      const dphi = Math.atan2(v.x, v.z);
      v.multiplyScalar(1 + bump(dphi, theta));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    if (!part) g = welded(g);
    else g.computeVertexNormals();
    return g;
  });
}

/** Gaussian bump helper for sculpt functions (angles wrap). */
export function gauss(dphi: number, theta: number, cphi: number, ctheta: number, sphi: number, stheta: number): number {
  let d = dphi - cphi;
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const a = d / sphi;
  const b = (theta - ctheta) / stheta;
  return Math.exp(-(a * a + b * b));
}

/** Rounded profile extruded across X, creased normals (soft bevels) — high quality body panels. */
export function roundedShape(pts: Array<[number, number, number]>, cornerSeg = 1): THREE.Shape {
  const s = new THREE.Shape();
  const n = pts.length;
  const at = (i: number) => pts[(i + n) % n];
  for (let i = 0; i < n; i++) {
    const [x, y, r] = at(i);
    const [px, py] = at(i - 1);
    const [nx, ny] = at(i + 1);
    const d1 = Math.hypot(px - x, py - y);
    const d2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, d1 * 0.45, d2 * 0.45);
    const ax = x + ((px - x) / d1) * rr;
    const ay = y + ((py - y) / d1) * rr;
    const bx = x + ((nx - x) / d2) * rr;
    const by = y + ((ny - y) / d2) * rr;
    if (i === 0) s.moveTo(ax, ay);
    else s.lineTo(ax, ay);
    if (cornerSeg <= 1) s.quadraticCurveTo(x, y, bx, by);
    else {
      // explicit sampling so low LODs can use very few points
      for (let k = 1; k <= cornerSeg; k++) {
        const t = k / cornerSeg;
        const u = 1 - t;
        s.lineTo(u * u * ax + 2 * u * t * x + t * t * bx, u * u * ay + 2 * u * t * y + t * t * by);
      }
    }
  }
  s.closePath();
  return s;
}

export function sideExtrudeHD(key: string, pts: Array<[number, number, number]>, width: number, bevel: number, q: { bevelSeg: number; curveSeg: number }): THREE.BufferGeometry {
  return cachedGeo(`sideexHD:${key}:${q.bevelSeg}:${q.curveSeg}`, () => {
    const shape = roundedShape(pts);
    const depth = Math.max(0.01, width - bevel * 2);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: q.bevelSeg, curveSegments: q.curveSeg,
    });
    g.translate(0, 0, -depth / 2);
    g.rotateY(-Math.PI / 2);
    return creased(g, q.bevelSeg >= 3 ? Math.PI / 4 : Math.PI / 6);
  });
}

/** Extrude a flat shape (XY) along Z with soft bevels and creased normals; centred on z = 0. */
export function bevelExtrude(key: string, shape: THREE.Shape, depth: number, bevel: number, bevelSeg: number, curveSeg: number): THREE.BufferGeometry {
  return cachedGeo(`bevex:${key}:${depth}:${bevel}:${bevelSeg}:${curveSeg}`, () => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(0.001, depth - bevel * 2), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: bevelSeg, curveSegments: curveSeg,
    });
    g.translate(0, 0, -(depth - bevel * 2) / 2);
    return creased(g, Math.PI / 4.5);
  });
}

/** Row of short dashes (stitching, zipper teeth) along a Catmull-Rom polyline, merged into one geometry. */
export function dashGeo(key: string, pts: THREE.Vector3[], dash = 0.018, gap = 0.012, size = 0.006): THREE.BufferGeometry {
  return cachedGeo(`dash:${key}:${dash}:${gap}:${size}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const curve = new THREE.CatmullRomCurve3(pts);
    const len = curve.getLength();
    const n = Math.max(1, Math.floor(len / (dash + gap)));
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const b = new THREE.BoxGeometry(size, dash, size);
      b.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(yAxis, tan));
      b.translate(p.x, p.y, p.z);
      b.deleteAttribute('uv');
      parts.push(b);
    }
    const out = mergeGeometries(parts, false)!;
    parts.forEach((g) => g.dispose());
    return out;
  });
}

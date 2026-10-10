import * as THREE from 'three';
import type { Track } from '../sim/track/Track';
import type { KartView } from './KartView';
import type { Quality } from './Renderer';
import { getField } from './scenery/field';
import type { TodLook } from './timeOfDay';

/*
 * Time-of-day dressing that runs after the scenery is built:
 *  - emissive boost of lit windows / neon / marquee bulbs / holiday lights (so the city blazes)
 *  - generated lit-window masks for window facades that were authored for daytime
 *  - sky props (clouds) dimmed, water retinted (moon path on the lake), wet-road sheen
 *  - fake street lamps: additive light-pool decals + glowing heads (no real lights)
 *  - batched kart head/tail lights, headlight cones on the road and one real SpotLight (high)
 */

/* ------------------------------------------------------------------ materials */

/**
 * Emissive mask for an authored window texture: every pixel that differs from the wall colour (the
 * top-left pixel) is glass; a random subset of the 4x4 window cells lights up in warm / cool tones.
 */
function litWindowsFor(map: THREE.Texture, prob: number, litCache: Map<string, THREE.Texture>): THREE.Texture | null {
  const img = map.image as (HTMLCanvasElement | HTMLImageElement | ImageBitmap | undefined);
  if (!img || !(img instanceof HTMLCanvasElement)) return null;
  const key = map.uuid + prob.toFixed(2);
  const hit = litCache.get(key);
  if (hit) return hit;
  const w = img.width, h = img.height;
  const src = img.getContext('2d')?.getImageData(0, 0, w, h);
  if (!src) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const out = g.createImageData(w, h);
  const d = src.data;
  const wr = d[0], wg = d[1], wb = d[2];
  // deterministic per-texture random so it doesn't flicker between races
  let seed = 0;
  for (let i = 0; i < map.uuid.length; i++) seed = (seed * 31 + map.uuid.charCodeAt(i)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cells: Array<[number, number, number] | null> = [];
  const warm: Array<[number, number, number]> = [[255, 214, 140], [255, 196, 110], [255, 232, 180], [210, 228, 255], [255, 240, 205]];
  for (let i = 0; i < 16; i++) cells.push(rnd() < prob ? warm[Math.floor(rnd() * warm.length)].map((v) => v * (0.55 + rnd() * 0.45)) as [number, number, number] : null);
  let glass = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const diff = Math.abs(d[o] - wr) + Math.abs(d[o + 1] - wg) + Math.abs(d[o + 2] - wb);
      out.data[o + 3] = 255;
      if (diff < 40) continue;
      glass++;
      const cell = cells[Math.min(3, Math.floor((y / h) * 4)) * 4 + Math.min(3, Math.floor((x / w) * 4))];
      if (!cell) continue;
      out.data[o] = cell[0];
      out.data[o + 1] = cell[1];
      out.data[o + 2] = cell[2];
    }
  }
  // not a window texture (mostly "glass") -> leave it alone
  if (glass > w * h * 0.75 || glass < w * h * 0.05) return null;
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = map.wrapS;
  t.wrapT = map.wrapT;
  t.repeat.copy(map.repeat);
  t.offset.copy(map.offset);
  litCache.set(key, t);
  return t;
}

/** Make the scenery glow for the time of day. Idempotent per material (keeps the authored base values). */
export function applyNightMaterials(roots: THREE.Object3D[], look: TodLook): void {
  const seen = new Set<THREE.Material>();
  const litCache = new Map<string, THREE.Texture>();
  const e = look.emissive;
  const black = new THREE.Color(0, 0, 0);
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Sprite).isSprite) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        const ud = m.userData as { todBase?: { ei?: number; e?: THREE.Color; c?: THREE.Color } };
        if (m instanceof THREE.MeshStandardMaterial) {
          ud.todBase ??= { ei: m.emissiveIntensity, e: m.emissive.clone(), c: m.color.clone() };
          const base = ud.todBase;
          // sky props (clouds: fog-less, self-lit): darken into the evening sky instead of glowing
          if (m.fog === false && !m.emissiveMap && !m.map) {
            const k = look.tod === 'night' ? 0.12 : 0.8;
            m.color.copy(base.c!).multiplyScalar(k);
            m.emissive.copy(base.e!).multiplyScalar(look.tod === 'night' ? 0.25 : 1).lerp(look.tod === 'night' ? new THREE.Color('#1c2448') : new THREE.Color('#ff9a8a'), 0.5);
            continue;
          }
          // authored-for-daytime window facades: add a lit-window mask
          if (!m.emissiveMap && m.map && e.windowProb > 0 && (m.customProgramCacheKey?.() ?? '').startsWith('windowed-')) {
            const lit = litWindowsFor(m.map, e.windowProb, litCache);
            if (lit) {
              m.emissiveMap = lit;
              m.emissive.set('#ffffff');
              m.emissiveIntensity = look.tod === 'night' ? 1.3 : 0.5;
              m.needsUpdate = true;
              ud.todBase = { ei: 0, e: black.clone(), c: base.c };
              continue;
            }
          }
          if (m.emissiveMap) {
            // self-lit signs (emissive map == colour map) glow gently; window masks blaze
            const self = m.emissiveMap === m.map;
            // capped: scenes that were already authored with lit windows (snowy dusk) must not blow out
            const v = base.ei! > 0.6 ? base.ei! * Math.min(1.35, e.map) : Math.min(Math.max(base.ei! * e.map, e.mapMin * (base.ei! > 0 ? 1 : 0)), 1.7);
            m.emissiveIntensity = self ? Math.min(v, Math.max(base.ei!, look.tod === 'night' ? 0.75 : 0.4)) : v;
          } else if (base.e!.r + base.e!.g + base.e!.b > 0.01 && base.ei! > 0) {
            m.emissiveIntensity = base.ei! * e.plain;
          }
        } else if (m instanceof THREE.MeshBasicMaterial || m instanceof THREE.SpriteMaterial) {
          // unlit glow (neon tubes, marquee bulbs, holiday lights): push further into bloom
          ud.todBase ??= { c: m.color.clone() };
          const c = ud.todBase.c!;
          const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
          if ((m.toneMapped === false || lum > 1) && m.blending !== THREE.AdditiveBlending) m.color.copy(c).multiplyScalar(e.basic);
        }
      }
    });
  }
}

/** Retint stylised water (TrackView lake / channels) for sunset & night: dark body, moon path, city shimmer. */
export function retintWater(root: THREE.Object3D, look: TodLook, moonDir: THREE.Vector3): void {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (!m || seen.has(m) || !(m as THREE.ShaderMaterial).isShaderMaterial) return;
    seen.add(m);
    const u = m.uniforms;
    if (!u?.deep || !u.sunCol || !u.skyTop) return;
    const w = look.water;
    const tint = new THREE.Color(w.tint);
    u.deep.value.multiplyScalar(w.body).multiply(tint);
    u.shallow.value.multiplyScalar(w.body).multiply(tint);
    u.skyTop.value.set(w.skyTop);
    u.skyHorizon.value.set(w.skyHorizon);
    u.sunCol.value.set(w.glint);
    u.sunDir.value.copy(moonDir);
    if (u.glintStretch) u.glintStretch.value = w.stretch;
    if (u.cityGlow && look.tod === 'night') u.cityGlow.value.set('#ffb070').multiplyScalar(0.18);
  });
}

/** Night: slightly glossy, "just rained" asphalt so lights streak on the road. */
export function wetRoad(trackGroup: THREE.Object3D, look: TodLook): void {
  if (look.wet <= 0) return;
  for (const name of ['road', 'shortcutRoad']) {
    const m = (trackGroup.getObjectByName(name) as THREE.Mesh | undefined)?.material as THREE.MeshStandardMaterial | undefined;
    if (!m || !(m instanceof THREE.MeshStandardMaterial) || m.userData.todWet) continue;
    m.userData.todWet = true;
    m.roughness *= 1 - 0.35 * look.wet;
    m.envMapIntensity = (m.envMapIntensity ?? 1) * (1 + 0.6 * look.wet);
  }
}

/* ------------------------------------------------------------------ glow sprites */

/** World-sized additive glow points (one draw call), fading with distance fog. */
class GlowPoints {
  readonly points: THREE.Points;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly size: Float32Array;
  /** optional facing per point (0 = omni): lights fade when seen from behind */
  readonly dir: Float32Array;
  private geo = new THREE.BufferGeometry();
  constructor(readonly count: number, fog: THREE.Fog | null, dynamic: boolean, maxPx = 220) {
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.dir = new Float32Array(count * 3);
    const usage = dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage;
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(usage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(usage));
    this.geo.setAttribute('gsize', new THREE.BufferAttribute(this.size, 1).setUsage(usage));
    this.geo.setAttribute('gdir', new THREE.BufferAttribute(this.dir, 3).setUsage(usage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: { scale: { value: 600 }, maxPx: { value: maxPx }, fogNear: { value: fog?.near ?? 1e5 }, fogFar: { value: fog?.far ?? 2e5 } },
      vertexShader: /* glsl */ `attribute float gsize; attribute vec3 gdir; uniform float scale; uniform float maxPx; uniform float fogNear; uniform float fogFar; varying vec3 vCol;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float f = 1.0 - smoothstep(fogNear, fogFar, -mv.z);
          if (dot(gdir, gdir) > 0.0) {
            vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
            f *= 0.12 + 0.88 * smoothstep(-0.15, 0.45, dot(normalize(cameraPosition - wp), gdir));
          }
          vCol = color * f;
          gl_PointSize = gsize > 0.0 ? clamp(gsize * scale / -mv.z, 1.5, maxPx) : 0.0;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `varying vec3 vCol;
        void main(){ vec2 p = gl_PointCoord - 0.5; float r2 = dot(p, p) * 4.0;
          float a = exp(-r2 * 5.0) * 0.7 + exp(-r2 * 40.0) * 1.6;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vCol * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }
  setViewportHeight(h: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = h * 0.9;
  }
  flush(): void {
    for (const k of ['position', 'color', 'gsize', 'gdir']) (this.geo.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose(): void {
    this.points.removeFromParent();
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/* ------------------------------------------------------------------ street lamps */

/** Fake street lighting along the main path: pole + glowing head + halo + additive light pool on the road. */
class StreetLamps {
  readonly group = new THREE.Group();
  private disposables: Array<{ dispose(): void }> = [];
  halos: GlowPoints | null = null;

  constructor(track: Track, look: TodLook, quality: Quality, fog: THREE.Fog | null) {
    this.group.name = 'streetLamps';
    const def = track.def;
    const main = track.paths[0];
    const field = getField(track);
    const spacing = quality === 'high' ? 30 : 46;
    const n = Math.floor(main.length / spacing);
    const lamps: Array<{ s: number; side: number; x: number; y: number; z: number; yaw: number; hx: number; hy: number; hz: number; lat: number }> = [];
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * (main.length / n);
      const smp = track.sampleAt(0, s);
      if (smp.gap) continue;
      // skip around gaps / ramps (jumps) so poles don't stand in the air
      if (track.sampleAt(0, s - 12).gap || track.sampleAt(0, s + 12).gap) continue;
      const side = i % 2 === 0 ? 1 : -1;
      const wall = smp.halfWidth + def.shoulder;
      const lat = side * (wall + 1.1);
      const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
      const gy = field.height(x, z);
      if (Math.abs(gy - smp.y) > 2.5) continue;
      const y = Math.min(gy, smp.y);
      const yaw = Math.atan2(-smp.nx * side, -smp.nz * side); // +Z toward the road
      const headLat = side * (wall - 1.2);
      lamps.push({ s, side, x, y, z, yaw, hx: smp.x + smp.nx * headLat, hy: smp.y + 7.0, hz: smp.z + smp.nz * headLat, lat: headLat });
    }
    if (!lamps.length) return;
    const own = <T extends { dispose(): void }>(x: T): T => (this.disposables.push(x), x);

    // poles (instanced): post + arm reaching over the shoulder
    const post = new THREE.CylinderGeometry(0.11, 0.16, 7.2, 8).translate(0, 3.6, 0);
    const arm = new THREE.BoxGeometry(0.12, 0.12, 2.5).translate(0, 7.1, 1.15);
    const poleGeo = own(mergeTwo(post, arm));
    const poleMat = own(new THREE.MeshStandardMaterial({ color: '#2a3140', roughness: 0.5, metalness: 0.6 }));
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
    const headGeo = own(new THREE.BoxGeometry(0.42, 0.16, 0.9).translate(0, 6.98, 2.25));
    const lampCol = new THREE.Color(look.lampColor);
    const headMat = own(new THREE.MeshBasicMaterial({ color: lampCol.clone().multiplyScalar(4 * look.lamps + 0.5), toneMapped: false }));
    const heads = new THREE.InstancedMesh(headGeo, headMat, lamps.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    lamps.forEach((l, i) => {
      m4.compose(new THREE.Vector3(l.x, l.y, l.z), q.setFromAxisAngle(up, l.yaw), one);
      poles.setMatrixAt(i, m4);
      heads.setMatrixAt(i, m4);
    });
    poles.castShadow = false;
    poles.receiveShadow = false;
    this.group.add(poles, heads);

    // halos around the heads
    if (quality !== 'low') {
      this.halos = new GlowPoints(lamps.length, fog, false, 90);
      const hc = lampCol.clone().multiplyScalar(0.9 * look.lamps);
      lamps.forEach((l, i) => {
        // head sits ~2.25 m along the arm toward the road
        this.halos!.pos.set([l.x + Math.sin(l.yaw) * 2.25, l.y + 6.85, l.z + Math.cos(l.yaw) * 2.25], i * 3);
        this.halos!.col.set([hc.r, hc.g, hc.b], i * 3);
        this.halos!.size[i] = 2.4;
      });
      this.halos.flush();
      this.group.add(this.halos.points);
    }

    // light pools: one merged additive ribbon patch per lamp that hugs the road / shoulder
    const R = 12;
    const cols = 10;
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const strength = look.lamps * (def.theme === 'snow' ? 0.25 : 0.6);
    for (const l of lamps) {
      const rows: number[] = [];
      for (let ds = -R; ds <= R + 0.01; ds += 2) rows.push(ds);
      const base = pos.length / 3;
      let ok = true;
      for (const ds of rows) {
        const smp = track.sampleAt(0, l.s + ds);
        if (smp.gap) ok = false;
        const wall = smp.halfWidth + def.shoulder + 0.3;
        for (let c = 0; c < cols; c++) {
          const lat = -wall + (2 * wall * c) / (cols - 1);
          const dl = lat - l.lat;
          const d = Math.hypot(ds, dl * 1.15);
          let f = Math.max(0, 1 - d / R);
          f = f * f * (3 - 2 * f);
          pos.push(smp.x + smp.nx * lat, smp.y + 0.075, smp.z + smp.nz * lat);
          col.push(lampCol.r * f * strength, lampCol.g * f * strength, lampCol.b * f * strength);
        }
      }
      if (!ok) {
        pos.length = base * 3;
        col.length = base * 3;
        continue;
      }
      for (let r = 0; r < rows.length - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = base + r * cols + c, b = a + 1, d = a + cols, e = d + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
    }
    if (idx.length) {
      const geo = own(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mat = own(new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: true,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12,
      }));
      const pools = new THREE.Mesh(geo, mat);
      pools.name = 'lightPools';
      pools.renderOrder = 2;
      pools.frustumCulled = false;
      this.group.add(pools);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.halos?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const A = a.index ? a.toNonIndexed() : a, B = b.index ? b.toNonIndexed() : b;
  const out = new THREE.BufferGeometry();
  for (const k of ['position', 'normal']) {
    const x = A.attributes[k].array as Float32Array, y = B.attributes[k].array as Float32Array;
    const arr = new Float32Array(x.length + y.length);
    arr.set(x);
    arr.set(y, x.length);
    out.setAttribute(k, new THREE.BufferAttribute(arr, 3));
  }
  [a, b, A, B].forEach((g) => g.dispose());
  return out;
}

/* ------------------------------------------------------------------ kart lights */

let coneTex: THREE.Texture | null = null;
function headlightConeTexture(): THREE.Texture {
  if (coneTex) return coneTex;
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1); // 0 at the kart, 1 far ahead
    for (let x = 0; x < W; x++) {
      const u = (x / (W - 1)) * 2 - 1;
      const spread = 0.18 + v * 0.82;
      const across = Math.max(0, 1 - Math.abs(u) / spread);
      const along = Math.min(1, v * 6) * Math.pow(1 - v, 1.4);
      const a = Math.pow(across, 1.6) * along;
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(255 * Math.min(1, a * 1.3));
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  coneTex = new THREE.CanvasTexture(c);
  return coneTex;
}

/** All karts' head/tail light glows in one draw call, plus instanced headlight cones on the road. */
class KartLights {
  readonly group = new THREE.Group();
  private glows: GlowPoints;
  private cones: THREE.InstancedMesh | null = null;
  private coneGeo: THREE.BufferGeometry | null = null;
  private coneMat: THREE.MeshBasicMaterial | null = null;
  private spot: THREE.SpotLight | null = null;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private head = new THREE.Color('#fff4dc');
  private tail = new THREE.Color('#ff1a24');

  constructor(private views: KartView[], private track: Track, private look: TodLook, quality: Quality, private spotFor: KartView | null, fog: THREE.Fog | null) {
    this.glows = new GlowPoints(views.length * 4, null, true, 48);
    void fog;
    this.group.add(this.glows.points);
    if (quality !== 'low') {
      this.coneGeo = new THREE.PlaneGeometry(7, 15).rotateX(-Math.PI / 2).translate(0, 0, 7.5);
      // texture v runs along the cone: flip so v=0 sits at the kart
      const uv = this.coneGeo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
      this.coneMat = new THREE.MeshBasicMaterial({
        map: headlightConeTexture(), color: new THREE.Color('#fff0d0').multiplyScalar(0.55 * look.headlights), transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16,
      });
      this.cones = new THREE.InstancedMesh(this.coneGeo, this.coneMat, views.length);
      this.cones.frustumCulled = false;
      this.cones.renderOrder = 3;
      this.group.add(this.cones);
    }
    if (spotFor && quality === 'high') {
      this.spot = new THREE.SpotLight('#fff1d6', 260 * look.headlights, 70, 0.62, 0.6, 1.6);
      this.spot.castShadow = false;
      this.group.add(this.spot, this.spot.target);
    }
  }

  update(): void {
    const g = this.glows;
    const hl = this.look.headlights;
    this.views.forEach((v, i) => {
      const k = v.kartState;
      const vis = v.root.visible && v.kart.root.visible;
      const cy = Math.cos(v.interpYaw), sy = Math.sin(v.interpYaw);
      const put = (j: number, a: THREE.Vector3, c: THREE.Color, mul: number, size: number) => {
        const o = (i * 4 + j) * 3;
        const back = j >= 2 ? -1 : 1;
        g.dir[o] = sy * back;
        g.dir[o + 1] = 0;
        g.dir[o + 2] = cy * back;
        g.pos[o] = v.interpPos.x + a.x * cy + a.z * sy;
        g.pos[o + 1] = v.interpPos.y + a.y;
        g.pos[o + 2] = v.interpPos.z - a.x * sy + a.z * cy;
        g.col[o] = c.r * mul;
        g.col[o + 1] = c.g * mul;
        g.col[o + 2] = c.b * mul;
        g.size[i * 4 + j] = vis ? size : 0;
      };
      const tailMul = (0.7 + v.brake * 1.6) * hl;
      put(0, v.lightAnchors.head[0], this.head, 1.3 * hl, 0.6);
      put(1, v.lightAnchors.head[1], this.head, 1.3 * hl, 0.6);
      put(2, v.lightAnchors.tail[0], this.tail, tailMul, 0.36 + v.brake * 0.14);
      put(3, v.lightAnchors.tail[1], this.tail, tailMul, 0.36 + v.brake * 0.14);
      if (this.cones) {
        if (!vis || !k.grounded) {
          this.m4.makeScale(0, 0, 0);
        } else {
          // tilt the cone with the road slope so it doesn't sink into hills
          const smp = this.track.sampleAt(0, k.mainS);
          const along = smp.tx * sy + smp.tz * cy;
          const pitch = -Math.atan(smp.slope * along);
          this.e.set(pitch, v.interpYaw, 0, 'YXZ');
          this.q.setFromEuler(this.e);
          const front = v.lightAnchors.head[0].z;
          this.v.set(v.interpPos.x + sy * front, k.groundY + 0.09, v.interpPos.z + cy * front);
          this.m4.compose(this.v, this.q, this.sc.set(1, 1, 1));
        }
        this.cones.setMatrixAt(i, this.m4);
      }
    });
    g.flush();
    if (this.cones) this.cones.instanceMatrix.needsUpdate = true;
    if (this.spot && this.spotFor) {
      const v = this.spotFor;
      const cy = Math.cos(v.interpYaw), sy = Math.sin(v.interpYaw);
      const f = v.lightAnchors.head[0].z;
      this.spot.position.set(v.interpPos.x + sy * f, v.interpPos.y + 1.3, v.interpPos.z + cy * f);
      this.spot.target.position.set(v.interpPos.x + sy * (f + 22), v.kartState.groundY - 0.5, v.interpPos.z + cy * (f + 22));
      this.spot.visible = v.root.visible;
    }
  }

  setViewportHeight(h: number): void {
    this.glows.setViewportHeight(h);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.glows.dispose();
    this.coneGeo?.dispose();
    this.coneMat?.dispose();
    this.spot?.dispose();
  }
}

/* ------------------------------------------------------------------ facade */

export interface NightLightsOptions {
  scene: THREE.Scene;
  track: Track;
  look: TodLook;
  quality: Quality;
  /** scenery + track view roots whose materials get the emissive treatment */
  dressRoots: THREE.Object3D[];
  trackGroup: THREE.Object3D;
  kartViews: KartView[];
  /** the kart that gets the one real SpotLight (high quality), usually player 1 */
  spotKart: KartView | null;
  moonDir: THREE.Vector3;
}

/** Owns all time-of-day dressing for one race scene. */
export class NightLights {
  private lamps: StreetLamps | null = null;
  private karts: KartLights | null = null;

  constructor(o: NightLightsOptions) {
    const { look, quality } = o;
    applyNightMaterials(o.dressRoots, look);
    retintWater(o.trackGroup, look, o.moonDir);
    if (quality !== 'low') wetRoad(o.trackGroup, look);
    const fog = o.scene.fog instanceof THREE.Fog ? o.scene.fog : null;
    if (look.lamps > 0 && quality !== 'low' && !look.indoor) {
      this.lamps = new StreetLamps(o.track, look, quality, fog);
      o.scene.add(this.lamps.group);
    }
    if (look.headlights > 0) {
      this.karts = new KartLights(o.kartViews, o.track, look, quality, o.spotKart, fog);
      o.scene.add(this.karts.group);
    }
  }

  update(): void {
    this.karts?.update();
  }

  setViewportHeight(h: number): void {
    this.karts?.setViewportHeight(h);
    this.lamps?.halos?.setViewportHeight(h);
  }

  dispose(): void {
    this.lamps?.dispose();
    this.karts?.dispose();
  }
}

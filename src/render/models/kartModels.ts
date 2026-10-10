import * as THREE from 'three';
import type { CharacterDef } from '../../data/characters';
import type { CharacterId } from '../../sim/types';
import type { KartRig } from './types';
import {
  brushed,
  cachedGeo,
  cachedMat,
  capsuleGeo,
  chrome,
  cylinderGeo,
  decalMat,
  disposeTree,
  fabric,
  glossy,
  glow,
  lensMat,
  mesh,
  paint,
  plastic,
  roundedBox,
  rubber,
  textured,
} from './materials';
import { hoodTexture, numberPlateTexture, sideTexture, tennisBallTexture, treadColorTexture, treadNormalTexture, treadTexture } from './textures';
import { liveryById, type LiveryId } from './liveries';
import { liveryDecalMat, liveryPaint, liverySolid, type LiveryDims } from './liveryPaint';
import { addLiveryProp, type PropAnchor } from './liveryProps';
import { liveryHoodTexture, liverySideTexture } from './liveryTextures';
import { bevelExtrude, dashGeo as stitchGeo, helixGeo, latheGeo, roundedShape, sideExtrudeHD, tubeGeo } from './hdGeometry';
import { byLv, Lods, type Lv } from './lod';
import { mergeLodLevels } from './optimize';

export { setModelQuality, getModelQuality, type ModelQuality } from './lod';

// ---------------------------------------------------------------------------------------------
// Livery registry: which paint job each racer's kart gets the next time buildKart() runs.
// The game sets this from the save before building a race / showroom / podium. Unset = factory paint.
// ---------------------------------------------------------------------------------------------

const liveryRegistry = new Map<CharacterId, LiveryId>();

export function setLivery(character: CharacterId, livery: LiveryId | null): void {
  if (livery) liveryRegistry.set(character, livery);
  else liveryRegistry.delete(character);
}

export function getLivery(character: CharacterId): LiveryId | null {
  return liveryRegistry.get(character) ?? null;
}

/** Back to factory paint for everyone. */
export function clearLiveries(): void {
  liveryRegistry.clear();
}

/**
 * Procedural cartoon go-karts. One parametric builder; each racer gets a style that changes the
 * body profile, proportions, wheels, bumpers, spoiler and accessories so silhouettes differ.
 *
 * Layout (kart space, +Z forward, y up, origin at ground contact centre):
 *   root ── body (tilted by renderer) ── LOD[tub, pods, decals, seat, engine, spoiler, ...]
 *        │                             ├─ seat (driver anchor), exhaust tips (flame anchors)
 *        ├─ LOD[axles]
 *        ├─ front pivots (steer around Y) ── LOD[fender, caliper] + wheel spin group ── LOD[tyre, rim]
 *        ├─ rear holders ── LOD[fender, caliper] + wheel spin group ── LOD[tyre, rim]
 *        └─ rear contacts
 *
 * Every LOD level is a complete static model of that node at one detail level (see lod.ts).
 */

type Spoiler = 'bigwing' | 'wing' | 'fin' | 'lip' | 'bone' | 'retro';
type Bumper = 'splitter' | 'bar' | 'blade' | 'round' | 'chrome';

interface WheelSpec {
  r: number;
  w: number;
  x: number;
  z: number;
}

interface KartStyle {
  len: number;
  rear: number;
  bodyW: number;
  noseY: number;
  dashY: number;
  dashZ: number;
  cockpitY: number;
  engineY: number;
  round: number;
  podW: number;
  podTop: number;
  wf: WheelSpec;
  wr: WheelSpec;
  body: string;
  pod: string;
  trim: string;
  seat: string;
  rim: string;
  hub: string;
  spoiler: Spoiler;
  bumper: Bumper;
  fenders: 'none' | 'front' | 'all';
  whitewall?: boolean;
  roundLights?: boolean;
  spokes: number;
  num: string;
}

function styleFor(def: CharacterDef): KartStyle {
  const c = def.colors;
  const base: KartStyle = {
    len: 1.1, rear: -0.98, bodyW: 0.94, noseY: 0.36, dashY: 0.62, dashZ: 0.38, cockpitY: 0.44, engineY: 0.64, round: 0.12,
    podW: 0.24, podTop: 0.5,
    wf: { r: 0.26, w: 0.26, x: 0.68, z: 0.74 },
    wr: { r: 0.31, w: 0.34, x: 0.7, z: -0.72 },
    body: c.primary, pod: c.secondary, trim: c.accent, seat: '#1c1c20', rim: '#c9ccd2', hub: c.secondary,
    spoiler: 'wing', bumper: 'bar', fenders: 'none', spokes: 5, num: '1',
  };
  const by: Record<CharacterId, Partial<KartStyle>> = {
    dad: {
      bodyW: 1.02, noseY: 0.4, dashY: 0.68, engineY: 0.68, round: 0.1, podW: 0.28, podTop: 0.54,
      wf: { r: 0.28, w: 0.32, x: 0.72, z: 0.76 }, wr: { r: 0.33, w: 0.44, x: 0.75, z: -0.72 },
      pod: c.secondary, trim: '#ffffff', rim: '#d4d7dd', hub: c.secondary, spoiler: 'bigwing', bumper: 'splitter', spokes: 6, num: '1',
    },
    mom: {
      len: 1.08, bodyW: 0.96, noseY: 0.36, dashY: 0.62, round: 0.24, podTop: 0.5,
      pod: c.secondary, trim: '#ffffff', seat: '#4d1f6b', rim: '#ffffff', hub: c.primary, spoiler: 'lip', bumper: 'round', fenders: 'front', spokes: 5, num: '2',
    },
    bro1: {
      bodyW: 0.9, noseY: 0.34, round: 0.1, pod: '#161616', trim: '#ffffff', rim: '#1d1d1d', hub: c.primary, spoiler: 'wing', bumper: 'bar', spokes: 6, num: '7',
    },
    bro2: {
      len: 1.16, rear: -0.95, bodyW: 0.78, noseY: 0.29, dashY: 0.58, round: 0.05, podW: 0.2, podTop: 0.46,
      wf: { r: 0.25, w: 0.24, x: 0.64, z: 0.78 }, wr: { r: 0.3, w: 0.32, x: 0.68, z: -0.72 },
      pod: '#151515', trim: c.accent, rim: c.accent, hub: '#151515', spoiler: 'fin', bumper: 'blade', spokes: 3, num: '9',
    },
    lupin: {
      len: 0.98, rear: -0.9, bodyW: 0.98, noseY: 0.42, dashY: 0.62, engineY: 0.62, round: 0.26, podTop: 0.5,
      wf: { r: 0.27, w: 0.28, x: 0.68, z: 0.68 }, wr: { r: 0.3, w: 0.32, x: 0.7, z: -0.66 },
      pod: '#2a2a2a', trim: '#ffffff', seat: '#c0392b', rim: '#2a2a2a', hub: c.primary, spoiler: 'bone', bumper: 'round', fenders: 'all', spokes: 4, num: '4',
    },
    grandma: {
      len: 1.08, rear: -1.0, bodyW: 0.98, noseY: 0.4, dashY: 0.62, round: 0.2, podTop: 0.5,
      pod: '#ffffff', trim: '#ffffff', seat: '#f2a7c3', rim: '#e9ecef', hub: '#e9ecef', spoiler: 'retro', bumper: 'chrome', fenders: 'all',
      whitewall: true, roundLights: true, spokes: 8, num: '6',
    },
  };
  return { ...base, ...by[def.id] };
}

// ---------------------------------------------------------------------------------------------
// Shared per-build context
// ---------------------------------------------------------------------------------------------

interface Ctx {
  def: CharacterDef;
  id: CharacterId;
  st: KartStyle;
  liv: LiveryId | null;
  L: ReturnType<typeof liveryById> | null;
  LEN: number;
  R: number;
  seatZ: number;
  dims: LiveryDims;
  bodyPaint: THREE.Material;
  podPaint: THREE.Material;
  podSidePaint: THREE.Material;
  solid: (color: string, r?: number) => THREE.Material;
  dark: THREE.Material;
  metal: THREE.Material;
  accentPaint: THREE.Material;
  exR: number;
  exhaustPipes: Array<{ pos: THREE.Vector3; rotX: number }>;
}

const seg = (lv: Lv, hi: number, med: number, low: number) => byLv(lv, hi, med, low);

function sphereG(w: number, h: number): THREE.BufferGeometry {
  return cachedGeo(`ksphere:${w}:${h}`, () => new THREE.SphereGeometry(1, w, h));
}

function rbox(lv: Lv, w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  if (lv === 2) return cachedGeo(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
  return roundedBox(w, h, d, r, lv === 0 && Math.max(w, h, d) > 0.25 ? 2 : 1);
}

// ---------------------------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------------------------

/**
 * Tyre lathe: profile parameterised so v (texture) maps 0..0.22 inner sidewall+shoulder, 0.22..0.78
 * tread, 0.78..1 outer shoulder+sidewall (lettering band) — matches treadColor/treadNormal textures.
 */
function tireProfile(r: number, w: number, lv: Lv): THREE.Vector2[] {
  const hw = w / 2;
  const rin = r * 0.62;
  const c = Math.min(w * 0.32, r * 0.24);
  const nSide = seg(lv, 3, 2, 1);
  const nSh = seg(lv, 4, 3, 2);
  const nTr = seg(lv, 6, 4, 2);
  const pts: THREE.Vector2[] = [];
  // inner sidewall: from rim (x=-hw*0.88) outwards
  for (let i = 0; i <= nSide; i++) {
    const t = i / nSide;
    const bulge = Math.sin(t * Math.PI) * w * 0.05;
    pts.push(new THREE.Vector2(rin + (r - c - rin) * t, -hw * 0.9 - bulge - hw * 0.1 * t));
  }
  // inner shoulder arc
  for (let i = 1; i <= nSh; i++) {
    const a = -Math.PI / 2 + (i / nSh) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, -hw + c + Math.sin(a) * c));
  }
  // tread (slight crown)
  for (let i = 1; i < nTr; i++) {
    const t = i / nTr;
    pts.push(new THREE.Vector2(r + Math.sin(t * Math.PI) * r * 0.012, -hw + c + (hw * 2 - c * 2) * t));
  }
  // outer shoulder arc
  for (let i = 0; i < nSh; i++) {
    const a = (i / nSh) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, hw - c + Math.sin(a) * c));
  }
  for (let i = 0; i <= nSide; i++) {
    const t = i / nSide;
    const bulge = Math.sin(t * Math.PI) * w * 0.05;
    pts.push(new THREE.Vector2(r - c - (r - c - rin) * t, hw + bulge - hw * 0.1 * t));
  }
  return pts;
}

/**
 * Tyre lathe: profile parameterised so v (texture) maps 0..0.22 inner sidewall+shoulder, 0.22..0.78
 * tread, 0.78..1 outer shoulder+sidewall (lettering band) — matches treadColor/treadNormal textures.
 */
function tireGeo(r: number, w: number, lv: Lv): THREE.BufferGeometry {
  return cachedGeo(`hdtire:${r}:${w}:${lv}`, () => {
    // lathe around Y (profile y = axle position) then lay the axle along X (+x = outer sidewall)
    const g = new THREE.LatheGeometry(tireProfile(r, w, lv).map((p) => new THREE.Vector2(p.x, -p.y)), seg(lv, 40, 20, 12));
    g.rotateZ(Math.PI / 2);
    return g;
  });
}

/** White band hugging the outer sidewall (Grandma's whitewalls). */
function whitewallGeo(r: number, w: number, lv: Lv): THREE.BufferGeometry {
  return cachedGeo(`whitewall2:${r}:${w}:${lv}`, () => {
    const prof = tireProfile(r, w, Math.min(lv, 1) as Lv).filter((p) => p.y > 0 && p.x < r * 0.9 && p.x > r * 0.66);
    const pts = prof.map((p) => new THREE.Vector2(p.x, -(p.y + 0.003)));
    const g = new THREE.LatheGeometry(pts, seg(lv, 40, 24, 14));
    g.rotateZ(Math.PI / 2);
    return g;
  });
}

/** Alloy wheel face: a disc with `n` rounded windows, softly bevelled, facing +X. */
function rimFaceGeo(rr: number, n: number, lv: Lv): THREE.BufferGeometry {
  return cachedGeo(`rimface:${rr}:${n}:${lv}`, () => {
    const outer = new THREE.Shape();
    outer.absarc(0, 0, rr, 0, Math.PI * 2, false);
    const ri = rr * 0.36;
    const ro = rr * 0.84;
    const spoke = n >= 8 ? 0.16 : n === 3 ? 0.55 : 0.32; // spoke angular width (rad) at the rim
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2;
      const span = (Math.PI * 2) / n;
      const aIn0 = a0 + spoke * 0.9;
      const aIn1 = a0 + span - spoke * 0.9;
      const aOut0 = a0 + spoke * 0.5;
      const aOut1 = a0 + span - spoke * 0.5;
      const cr = rr * (n >= 8 ? 0.04 : 0.09);
      const pts: Array<[number, number, number]> = [
        [Math.cos(aIn0) * ri, Math.sin(aIn0) * ri, cr],
        [Math.cos(aOut0) * ro, Math.sin(aOut0) * ro, cr],
        [Math.cos((aOut0 + aOut1) / 2) * ro * 1.02, Math.sin((aOut0 + aOut1) / 2) * ro * 1.02, cr * 2],
        [Math.cos(aOut1) * ro, Math.sin(aOut1) * ro, cr],
        [Math.cos(aIn1) * ri, Math.sin(aIn1) * ri, cr],
      ];
      const hole = roundedShape(pts, lv === 0 ? 2 : 1);
      outer.holes.push(new THREE.Path(hole.getPoints(lv === 0 ? 3 : 2).reverse()));
    }
    const g = bevelExtrude(`rimface:${rr}:${n}`, outer, 0.035, lv === 0 ? 0.008 : 0.006, 1, seg(lv, 20, 12, 8));
    const out = g.clone();
    out.rotateY(Math.PI / 2);
    return out;
  });
}

function buildWheelLevel(g: THREE.Group, lv: Lv, ws: WheelSpec, k: Ctx, side: number): void {
  const st = k.st;
  const inner = new THREE.Group();
  if (side < 0) inner.rotation.y = Math.PI; // hub detail always faces outward
  g.add(inner);
  const tireMat =
    lv === 2
      ? rubber('#26262a')
      : lv === 1
        ? textured('tire', treadTexture(), '#26262a', { roughness: 0.85 })
        : cachedMat('tireHD', () => {
            const cm = treadColorTexture();
            const nm = treadNormalTexture();
            return new THREE.MeshPhysicalMaterial({
              color: cm ? '#ffffff' : '#2a2a2e', map: cm, normalMap: nm, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.78,
              sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color('#5a5a62'),
            });
          });
  inner.add(mesh(tireGeo(ws.r, ws.w, lv), tireMat));
  const rr = ws.r * 0.6;
  const isChrome = st.rim === '#ffffff' || st.rim === '#e9ecef' || st.rim === '#c9ccd2' || st.rim === '#d4d7dd';
  const rimMat = isChrome ? chrome() : glossy(st.rim, 0.28);
  const darkMetal = brushed('#3b3e45', 0.45);
  // rim barrel with a rolled lip
  const barrel = mesh(
    latheGeo(`barrel:${rr}:${ws.w}`, [
      [rr * 0.94, -ws.w * 0.4], [rr, -ws.w * 0.38], [rr * 0.97, -ws.w * 0.3], [rr * 0.97, ws.w * 0.28], [rr * 1.04, ws.w * 0.36], [rr * 1.02, ws.w * 0.41], [rr * 0.93, ws.w * 0.4],
    ], seg(lv, 40, 14, 10)),
    lv === 2 ? plastic('#2b2b30', 0.5) : darkMetal,
  );
  barrel.rotation.z = -Math.PI / 2;
  inner.add(barrel);
  if (lv === 2) {
    const face = mesh(cylinderGeo(rr * 0.98, rr * 0.98, 0.02, 10), rimMat);
    face.rotation.z = Math.PI / 2;
    face.position.x = ws.w * 0.36;
    inner.add(face);
    const cap = mesh(cylinderGeo(rr * 0.3, rr * 0.34, 0.07, 8), plastic(st.hub, 0.35, 0.2));
    cap.rotation.z = Math.PI / 2;
    cap.position.x = ws.w * 0.42;
    inner.add(cap);
  } else {
    // brake disc + hat visible through the spokes
    const disc = mesh(cylinderGeo(rr * 0.78, rr * 0.78, 0.022, seg(lv, 32, 16, 8)), darkMetal);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = ws.w * 0.05;
    inner.add(disc);
    if (lv === 0) {
      const ring = mesh(cachedGeo(`discring:${rr}`, () => new THREE.TorusGeometry(rr * 0.62, rr * 0.11, 4, 28)), darkMetal);
      ring.rotation.y = Math.PI / 2;
      ring.position.x = ws.w * 0.065;
      ring.scale.z = 0.12;
      inner.add(ring);
    }
    // alloy face with windows (medium: flat dish + spokes) + a hub disc behind it in the hub colour
    if (lv === 0) {
      const face = mesh(rimFaceGeo(rr * 0.98, st.spokes, lv), rimMat);
      face.position.x = ws.w * 0.33;
      inner.add(face);
    } else {
      const dish = mesh(cylinderGeo(rr * 0.98, rr * 0.98, 0.02, 16), darkMetal);
      dish.rotation.z = Math.PI / 2;
      dish.position.x = ws.w * 0.32;
      inner.add(dish);
      const spokeGeo = cachedGeo(`spoke:${rr}`, () => new THREE.BoxGeometry(0.03, rr * 0.8, rr * 0.3));
      for (let i = 0; i < st.spokes; i++) {
        const a = (i / st.spokes) * Math.PI * 2;
        const sp = mesh(spokeGeo, rimMat);
        sp.position.set(ws.w * 0.37, Math.cos(a) * rr * 0.5, Math.sin(a) * rr * 0.5);
        sp.rotation.x = a;
        inner.add(sp);
      }
    }
    const hubDisc = mesh(cylinderGeo(rr * 0.4, rr * 0.4, 0.03, seg(lv, 28, 14, 8)), glossy(st.hub, 0.3));
    hubDisc.rotation.z = Math.PI / 2;
    hubDisc.position.x = ws.w * 0.31;
    inner.add(hubDisc);
    const cap = mesh(
      latheGeo(`hubcap:${rr}`, [[0, 0.075], [rr * 0.12, 0.072], [rr * 0.24, 0.055], [rr * 0.3, 0.03], [rr * 0.32, 0]], seg(lv, 28, 14, 8)),
      rimMat,
    );
    cap.rotation.z = -Math.PI / 2;
    cap.position.x = ws.w * 0.36;
    inner.add(cap);
    // lug nuts
    const nutGeo = cylinderGeo(rr * 0.055, rr * 0.055, 0.03, 6);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const nut = mesh(nutGeo, chrome(), false);
      nut.rotation.z = Math.PI / 2;
      nut.position.set(ws.w * 0.38, Math.cos(a) * rr * 0.2, Math.sin(a) * rr * 0.2);
      inner.add(nut);
    }
  }
  if (st.whitewall) {
    // painted white band on the outer sidewall
    inner.add(mesh(whitewallGeo(ws.r, ws.w, lv), cachedMat('whitewall', () => new THREE.MeshPhysicalMaterial({ color: '#f4f4ef', roughness: 0.45, sheen: 0.3, side: THREE.DoubleSide }))));
  }
}

/** Non-spinning wheel parts on the holder / steering pivot: brake caliper + bubble fender. */
function buildHolderLevel(g: THREE.Group, lv: Lv, ws: WheelSpec, k: Ctx, side: number, fender: boolean): void {
  const st = k.st;
  if (lv !== 2) {
    const rr = ws.r * 0.6;
    const cal = mesh(rbox(lv, 0.05, rr * 0.55, rr * 0.38, 0.015), k.def.id === 'grandma' ? glossy('#d93a5a', 0.3) : k.accentPaint);
    cal.position.set(side * ws.w * 0.13, rr * 0.5, -rr * 0.42);
    cal.rotation.x = -0.7;
    g.add(cal);
  }
  if (fender) {
    const mat = k.L ? k.solid(k.L.colors.fender) : paint(st.body);
    const f = mesh(sphereG(seg(lv, 32, 18, 10), seg(lv, 18, 10, 6)), mat);
    f.scale.set(ws.w / 2 + 0.07, ws.r * 0.55, ws.r + 0.12);
    f.position.set(0, ws.r * 0.62, 0);
    g.add(f);
    if (lv === 0) {
      // trim bead around the fender + mounting strut to the body
      const bead = mesh(cachedGeo(`fbead:${ws.r}`, () => new THREE.TorusGeometry(1, 0.035, 6, 40, Math.PI)), chrome(), false);
      bead.scale.set(ws.r + 0.12, ws.r * 0.55, ws.w / 2 + 0.07);
      bead.rotation.y = Math.PI / 2;
      bead.position.set(0, ws.r * 0.62, 0);
      g.add(bead);
      const strut = mesh(cylinderGeo(0.018, 0.018, 0.22, 10), chrome());
      strut.rotation.z = Math.PI / 2;
      strut.position.set(-side * 0.12, ws.r * 0.7, 0);
      g.add(strut);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

export function buildKart(baseDef: CharacterDef): KartRig {
  const liv = getLivery(baseDef.id);
  const L = liv ? liveryById(liv) : null;
  // a livery re-colours every part that used the racer's colours
  const def: CharacterDef = L ? { ...baseDef, colors: { ...baseDef.colors, primary: L.colors.wing, secondary: L.colors.pod, accent: L.colors.trim } } : baseDef;
  const st = styleFor(def);
  if (L) {
    st.body = L.colors.body;
    st.pod = L.colors.pod;
    st.trim = L.colors.trim;
    st.hub = L.colors.hub;
    if (liv === 'bean' || liv === 'lTrain') st.rim = '#ffffff';
  }
  const id = def.id;
  const lods = new Lods();
  const root = new THREE.Group();
  root.name = `kart:${id}`;
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const seatZ = -0.15;
  const dims: LiveryDims = {
    len: st.len, rear: st.rear, bodyW: st.bodyW, noseY: st.noseY, dashY: st.dashY, dashZ: st.dashZ, cockpitY: st.cockpitY, engineY: st.engineY,
    cockBack: seatZ - 0.3 - 0.12, podTop: st.podTop,
  };
  const podPaint: THREE.Material = liv ? liverySolid(liv, st.pod) : st.pod === '#151515' || st.pod === '#161616' || st.pod === '#2a2a2a' ? paint(st.pod, 0.4) : paint(st.pod);
  const k: Ctx = {
    def, id, st, liv, L, LEN: st.len, R: st.rear, seatZ, dims,
    bodyPaint: liv ? liveryPaint(liv, id, 'tub', dims) : paint(st.body),
    podPaint,
    podSidePaint: liv ? liveryPaint(liv, id, 'pod', dims) : podPaint,
    solid: (color: string, r?: number): THREE.Material => (liv ? liverySolid(liv, color, r) : paint(color, r)),
    dark: plastic('#1d1d22', 0.6, 0.2),
    metal: brushed('#7d838c', 0.4),
    accentPaint: liv ? liverySolid(liv, st.trim) : paint(def.colors.secondary === '#151515' ? def.colors.primary : def.colors.secondary),
    exR: id === 'dad' ? 0.075 : 0.058,
    exhaustPipes: [],
  };

  // ---- exhaust pipe frames (shared by every level) + flame anchors ----
  const exhausts: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const pos = new THREE.Vector3(s * (id === 'dad' ? 0.3 : 0.24), st.engineY - 0.12, k.R + 0.02);
    k.exhaustPipes.push({ pos, rotX: -0.25 });
    const pipe = new THREE.Object3D();
    pipe.name = 'exhaust-pipe';
    pipe.position.copy(pos);
    pipe.rotation.x = -0.25;
    body.add(pipe);
    const tip = new THREE.Object3D();
    tip.name = 'exhaust';
    tip.position.z = -0.3;
    pipe.add(tip);
    exhausts.push(tip);
  }

  lods.each(body, (g, lv) => buildBodyLevel(g, lv, k));

  const seat = new THREE.Object3D();
  seat.name = 'seat';
  seat.position.set(0, st.cockpitY + 0.06, seatZ);
  body.add(seat);

  // ---- wheels ----
  const wheels: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  lods.each(root, (g, lv) => {
    for (const ws of [st.wf, st.wr]) {
      const axle = mesh(cylinderGeo(0.03, 0.03, ws.x * 2, seg(lv, 16, 8, 6)), k.metal);
      axle.rotation.z = Math.PI / 2;
      axle.position.set(0, ws.r, ws.z);
      g.add(axle);
    }
  });
  for (const [ws, front] of [[st.wf, true], [st.wr, false]] as Array<[WheelSpec, boolean]>) {
    for (const s of [1, -1]) {
      const holder = new THREE.Group();
      holder.name = front ? 'front-pivot' : 'rear-holder';
      holder.position.set(s * ws.x, ws.r, ws.z);
      root.add(holder);
      const spin = new THREE.Group(); // renderer spins this around local X
      spin.name = 'wheel';
      holder.add(spin);
      lods.each(spin, (g, lv) => buildWheelLevel(g, lv, ws, k, s));
      wheels.push(spin);
      if (front) frontPivots.push(holder);
      const wantFender = st.fenders === 'all' || (st.fenders === 'front' && front);
      lods.each(holder, (g, lv) => buildHolderLevel(g, lv, ws, k, s, wantFender));
    }
  }
  // order: front-left, front-right, rear-left, rear-right (as built: +X first)

  const rearContacts: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const c = new THREE.Object3D();
    c.position.set(s * st.wr.x, 0.02, st.wr.z);
    root.add(c);
    rearContacts.push(c);
  }

  // static contents of every detail level -> one mesh per material (cached per racer / paint / quality)
  mergeLodLevels(root, `kart:${id}:${liv ?? 'factory'}:${lods.levels.join('')}`);

  return {
    root, body, seat, wheels, frontPivots, exhausts, rearContacts,
    dispose() {
      disposeTree(root);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Body (one complete level)
// ---------------------------------------------------------------------------------------------

function buildBodyLevel(body: THREE.Group, lv: Lv, k: Ctx): void {
  const { st, def, id, liv, LEN, R, seatZ } = k;
  const hi = lv === 0;
  const notLow = lv !== 2;
  const chromeM = chrome();

  // ---- chassis floor ----
  const floor = mesh(rbox(lv, st.bodyW + 0.12, 0.09, st.len - st.rear + 0.05, 0.04), k.dark);
  floor.position.set(0, 0.14, (st.len + st.rear) / 2);
  body.add(floor);

  // ---- main tub (side profile extruded across the width, soft bevels) ----
  const cockFront = st.dashZ - 0.06;
  const cockBack = seatZ - 0.3;
  const prof: Array<[number, number, number]> = [
    [LEN - 0.04, 0.15, 0.05],
    [LEN, st.noseY, st.round],
    [st.dashZ, st.dashY, 0.08],
    [cockFront, st.cockpitY + 0.02, 0.04],
    [cockBack, st.cockpitY, 0.04],
    [cockBack - 0.12, st.engineY, 0.08],
    [R + 0.02, st.engineY - 0.04, st.round],
    [R, 0.18, 0.06],
  ];
  const q = { bevelSeg: seg(lv, 4, 2, 1), curveSeg: seg(lv, 10, 5, 2) };
  const tub = mesh(sideExtrudeHD(`tub:${id}`, prof, st.bodyW, 0.06, q), k.bodyPaint);
  body.add(tub);

  // hood decal on the straight hood segment
  const hoodA = new THREE.Vector2(LEN, st.noseY);
  const hoodB = new THREE.Vector2(st.dashZ, st.dashY);
  const slope = Math.atan2(hoodB.y - hoodA.y, hoodA.x - hoodB.x);
  const hoodN = new THREE.Vector2(Math.sin(slope), Math.cos(slope));
  {
    const hoodLen = hoodA.distanceTo(hoodB);
    const mid = hoodA.clone().lerp(hoodB, 0.5);
    const dw = st.bodyW * 0.82;
    const dl = Math.min(hoodLen * 0.85, dw * 2);
    const tex = liv ? liveryHoodTexture(liv, id, dl / dw) : hoodTexture(id, def.emblem, def.colors);
    const decal = new THREE.Mesh(cachedGeo(`hoodplane:${dw}:${dl}`, () => new THREE.PlaneGeometry(dw, dl)), liv ? liveryDecalMat(`hood:${liv}:${id}`, tex, liv) : decalMat(`hood:${id}`, tex));
    if (liv && !tex) decal.visible = false;
    decal.position.set(0, mid.y + hoodN.y * 0.066, mid.x + hoodN.x * 0.066);
    decal.rotation.x = -Math.PI / 2 + slope;
    decal.renderOrder = 1;
    body.add(decal);
  }
  if (hi) {
    // panel shut line across the nose + a fuel filler cap on the engine deck
    const p = hoodA.clone().lerp(hoodB, 0.08);
    const shut = mesh(roundedBox(st.bodyW * 0.9, 0.012, 0.012, 0.005, 1), k.dark, false);
    shut.position.set(0, p.y + hoodN.y * 0.058, p.x + hoodN.x * 0.058);
    shut.rotation.x = slope;
    body.add(shut);
    const fill = mesh(latheGeo('fuelcap', [[0, 0.02], [0.035, 0.018], [0.045, 0.008], [0.046, 0]], 24), chromeM, false);
    fill.position.set(-st.bodyW * 0.28, st.engineY + 0.055, cockBack - 0.3);
    body.add(fill);
  }

  // dashboard cowl + tinted wind deflector
  const cowl = mesh(rbox(lv, st.bodyW * 0.86, 0.1, 0.18, 0.045), k.podPaint);
  cowl.position.set(0, st.dashY + 0.02, st.dashZ - 0.02);
  cowl.rotation.x = -0.25;
  body.add(cowl);
  if (notLow) {
    const screen = mesh(
      cachedGeo(`screen:${st.bodyW}:${lv}`, () => new THREE.CylinderGeometry(st.bodyW * 0.5, st.bodyW * 0.5, 0.12, seg(lv, 32, 12, 6), 1, true, -0.55, 1.1)),
      lensMat(),
      false,
    );
    screen.scale.set(0.9, 1, 0.28);
    screen.position.set(0, st.dashY + 0.12, st.dashZ - 0.16);
    screen.rotation.x = -0.35;
    body.add(screen);
  }
  // mirrors on stalks
  if (notLow) {
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(s * st.bodyW * 0.42, st.dashY + 0.06, st.dashZ - 0.04);
      body.add(g);
      const stalk = mesh(capsuleGeo(0.008, 0.07, 6), k.dark, false);
      stalk.rotation.z = -s * 1.0;
      g.add(stalk);
      const house = mesh(rbox(lv, 0.1, 0.06, 0.035, 0.016), k.solid(def.colors.primary));
      house.position.set(s * 0.065, 0.045, 0);
      house.rotation.y = s * 0.25;
      g.add(house);
      if (hi) {
        const glass = mesh(roundedBox(0.084, 0.046, 0.004, 0.012, 1), chromeM, false);
        glass.position.set(s * 0.065, 0.045, -0.018);
        glass.rotation.y = s * 0.25;
        g.add(glass);
      }
    }
  }

  // ---- side pods ----
  const podX = st.bodyW / 2 + st.podW / 2 - 0.04;
  const podProf: Array<[number, number, number]> = [
    [0.4, 0.16, 0.06],
    [0.42, st.podTop - 0.1, 0.12],
    [0.22, st.podTop, 0.1],
    [-0.36, st.podTop - 0.02, 0.1],
    [-0.4, 0.18, 0.06],
  ];
  const podGeo = sideExtrudeHD(`pod:${id}`, podProf, st.podW, 0.045, { bevelSeg: seg(lv, 4, 2, 1), curveSeg: seg(lv, 8, 4, 2) });
  const sideTex = liv ? liverySideTexture(liv, id, def.emblem) : sideTexture(id, def.emblem, def.colors);
  const sideMat = liv ? liveryDecalMat(`side:${liv}:${id}`, sideTex, liv) : decalMat(`side:${id}`, sideTex);
  const trimMat = glossy(st.trim, 0.3);
  for (const s of [-1, 1]) {
    const pod = mesh(podGeo, k.podSidePaint);
    pod.position.x = s * podX;
    body.add(pod);
    const dw = 0.74;
    const dh = 0.23;
    const decal = new THREE.Mesh(cachedGeo(`sideplane:${dw}:${dh}`, () => new THREE.PlaneGeometry(dw, dh)), sideMat);
    decal.position.set(s * (podX + st.podW / 2 + 0.006), (0.16 + st.podTop) / 2 + 0.01, 0.01);
    decal.rotation.y = (s * Math.PI) / 2;
    decal.renderOrder = 1;
    body.add(decal);
    // trim strip along the pod top
    const strip = mesh(capsuleGeo(0.018, 0.56, seg(lv, 12, 6, 4)), trimMat);
    strip.rotation.x = Math.PI / 2;
    strip.position.set(s * (podX + st.podW * 0.32), st.podTop + 0.03, -0.3);
    body.add(strip);
    if (notLow) {
      // front air intake: dark recessed grille with slats
      const grille = mesh(rbox(lv, st.podW * 0.7, (st.podTop - 0.16) * 0.55, 0.04, 0.02), k.dark);
      grille.position.set(s * podX, (0.16 + st.podTop) / 2 + 0.01, 0.415);
      body.add(grille);
      if (hi) {
        for (let i = 0; i < 3; i++) {
          const slat = mesh(roundedBox(st.podW * 0.66, 0.012, 0.03, 0.005, 1), chromeM, false);
          slat.position.set(s * podX, (0.16 + st.podTop) / 2 + 0.01 + (i - 1) * 0.045, 0.43);
          body.add(slat);
        }
        // rivets along the pod top edge
        const rivet = sphereG(7, 4);
        for (let i = 0; i < 7; i++) {
          const r = mesh(rivet, chromeM, false);
          r.scale.set(0.011, 0.007, 0.011);
          r.position.set(s * (podX + st.podW * 0.44), st.podTop - 0.035 - (i === 0 || i === 6 ? 0.02 : 0), -0.3 + i * 0.09);
          r.rotation.z = (s * Math.PI) / 2;
          body.add(r);
        }
      }
    }
  }

  // ---- side nerf bars (visible chassis tubes between the wheels) ----
  if (notLow) {
    for (const s of [-1, 1]) {
      const x0 = podX + st.podW / 2 + 0.05;
      const pts = [
        new THREE.Vector3(s * (st.bodyW / 2 - 0.02), 0.17, st.wf.z - st.wf.r - 0.02),
        new THREE.Vector3(s * x0, 0.2, st.wf.z - st.wf.r - 0.12),
        new THREE.Vector3(s * (x0 + 0.02), 0.21, 0),
        new THREE.Vector3(s * x0, 0.2, st.wr.z + st.wr.r + 0.12),
        new THREE.Vector3(s * (st.bodyW / 2 - 0.02), 0.17, st.wr.z + st.wr.r + 0.02),
      ];
      const tube = mesh(tubeGeo(`nerf:${id}:${s}`, pts, 0.022, seg(lv, 32, 12, 8), seg(lv, 8, 5, 4)), k.metal);
      body.add(tube);
    }
  }

  // ---- seat ----
  const seatMat = fabric(st.seat, id === 'grandma' ? 0.9 : 0.72);
  const comfy = id === 'grandma';
  const dogBed = id === 'lupin';
  const backH = comfy ? 0.62 : dogBed ? 0.34 : 0.56;
  const backD = comfy || dogBed ? 0.2 : 0.12;
  const seatBack = mesh(rbox(lv, 0.6, backH, backD, comfy || dogBed ? 0.09 : 0.05), seatMat);
  const backPos = new THREE.Vector3(0, st.cockpitY + 0.04 + backH / 2, seatZ - 0.3);
  seatBack.position.copy(backPos);
  seatBack.rotation.x = -0.18;
  body.add(seatBack);
  const seatBase = mesh(rbox(lv, 0.58, 0.1, 0.45, 0.04), seatMat);
  seatBase.position.set(0, st.cockpitY + 0.02, seatZ + 0.02);
  body.add(seatBase);
  if (notLow && !comfy && !dogBed) {
    // quilted centre panel + contrast stitching
    const panel = new THREE.Group();
    panel.position.copy(backPos);
    panel.rotation.x = -0.18;
    body.add(panel);
    const pad = mesh(rbox(lv, 0.3, backH * 0.8, 0.03, 0.014), seatMat);
    pad.position.set(0, -backH * 0.04, backD / 2 + 0.005);
    panel.add(pad);
    if (hi) {
      const thread = trimMat;
      for (const sx of [-1, 1]) {
        const pts = [new THREE.Vector3(sx * 0.16, -backH * 0.42, backD / 2 + 0.012), new THREE.Vector3(sx * 0.16, backH * 0.34, backD / 2 + 0.012)];
        panel.add(mesh(stitchGeo(`seatv:${backH}:${backD}:${sx}`, pts), thread, false));
      }
      for (let i = 1; i < 4; i++) {
        const y = -backH * 0.42 + (i / 4) * backH * 0.76;
        const pts = [new THREE.Vector3(-0.14, y, backD / 2 + 0.022), new THREE.Vector3(0.14, y, backD / 2 + 0.022)];
        panel.add(mesh(stitchGeo(`seath:${backH}:${i}`, pts), thread, false));
      }
    }
  }
  if (comfy) {
    // tufted buttons + a knitted cushion
    for (const [x, y] of [[-0.14, 0.18], [0.14, 0.18], [0, 0.32], [-0.14, 0.46], [0.14, 0.46]]) {
      const b = mesh(sphereG(seg(lv, 10, 8, 6), seg(lv, 6, 6, 4)), plastic('#d77fa4', 0.6), false);
      b.scale.setScalar(0.022);
      b.position.set(x, st.cockpitY + y, seatZ - 0.19 - y * 0.18);
      body.add(b);
    }
    const pillow = mesh(rbox(lv, 0.36, 0.2, 0.1, 0.05), fabric('#fff4b8', 0.95));
    pillow.position.set(0, st.cockpitY + 0.7, seatZ - 0.33);
    pillow.rotation.x = -0.25;
    body.add(pillow);
  } else if (!dogBed) {
    // racing headrest wings
    for (const s of [-1, 1]) {
      const wing = mesh(rbox(lv, 0.08, 0.3, 0.16, 0.035), seatMat);
      wing.position.set(s * 0.29, st.cockpitY + 0.42, seatZ - 0.25);
      wing.rotation.y = -s * 0.35;
      body.add(wing);
    }
  } else if (notLow) {
    // dog bed: a plump bolster ring
    const bolster = mesh(cachedGeo(`bolster:${lv}`, () => new THREE.TorusGeometry(0.24, 0.07, seg(lv, 12, 6, 4), seg(lv, 36, 16, 8), Math.PI * 1.2)), seatMat);
    bolster.rotation.set(Math.PI / 2, 0, -Math.PI * 0.1 - Math.PI);
    bolster.position.set(0, st.cockpitY + 0.08, seatZ - 0.02);
    body.add(bolster);
  }

  // ---- engine ----
  buildEngine(body, lv, k);

  // ---- exhausts (pipe frames are shared anchors; geometry per level) ----
  for (const p of k.exhaustPipes) {
    const pipe = new THREE.Group();
    pipe.position.copy(p.pos);
    pipe.rotation.x = p.rotX;
    body.add(pipe);
    const exR = k.exR;
    if (lv === 2) {
      const tube = mesh(cylinderGeo(exR, exR * 0.9, 0.34, 8), chromeM);
      tube.rotation.x = Math.PI / 2;
      tube.position.z = -0.1;
      pipe.add(tube);
    } else {
      // header bending up into the engine + flared chrome tip
      const s = Math.sign(p.pos.x);
      const header = mesh(
        tubeGeo(`header:${id}:${s}`, [new THREE.Vector3(-s * 0.1, 0.18, 0.2), new THREE.Vector3(-s * 0.03, 0.1, 0.12), new THREE.Vector3(0, 0.02, 0.02), new THREE.Vector3(0, 0, -0.12)], exR * 0.8, seg(lv, 20, 10, 6), seg(lv, 10, 6, 6)),
        k.metal,
      );
      pipe.add(header);
      const tip = mesh(
        latheGeo(`extip:${exR}`, [[exR * 0.72, 0.0], [exR * 0.8, 0.005], [exR * 1.0, 0.012], [exR * 0.98, 0.06], [exR * 1.08, 0.15], [exR * 1.14, 0.19], [exR * 1.1, 0.2], [exR * 0.86, 0.2], [exR * 0.84, 0.17]], seg(lv, 28, 14, 8)),
        chromeM,
      );
      tip.rotation.x = -Math.PI / 2;
      tip.position.z = -0.1;
      pipe.add(tip);
      if (hi) {
        const clamp = mesh(cachedGeo(`exclamp:${exR}`, () => new THREE.TorusGeometry(exR * 1.02, 0.008, 6, 24)), k.dark, false);
        clamp.position.z = -0.115;
        pipe.add(clamp);
      }
    }
    const hole = mesh(cylinderGeo(exR * 0.82, exR * 0.82, 0.01, seg(lv, 16, 10, 8)), k.dark, false);
    hole.rotation.x = Math.PI / 2;
    hole.position.z = -0.272;
    pipe.add(hole);
  }

  // ---- lights ----
  const headGlow = glow('#fff6d8', 1.2);
  for (const s of [-1, 1]) {
    if (st.roundLights) {
      const ring = mesh(cachedGeo(`hlring:${lv}`, () => new THREE.TorusGeometry(0.075, 0.02, seg(lv, 10, 6, 4), seg(lv, 32, 16, 8))), chromeM);
      ring.position.set(s * 0.3, st.noseY - 0.04, LEN + 0.05);
      body.add(ring);
      const lamp = mesh(sphereG(seg(lv, 20, 12, 8), seg(lv, 12, 8, 6)), headGlow, false);
      lamp.scale.set(0.072, 0.072, 0.04);
      lamp.position.copy(ring.position);
      body.add(lamp);
    } else {
      const lamp = mesh(rbox(lv, 0.16, 0.06, 0.05, 0.02), headGlow, false);
      lamp.position.set(s * st.bodyW * 0.33, st.noseY - 0.05, LEN + 0.025);
      lamp.rotation.z = s * 0.15;
      body.add(lamp);
      if (hi) {
        const bezel = mesh(roundedBox(0.18, 0.08, 0.03, 0.03, 2), chromeM, false);
        bezel.position.set(s * st.bodyW * 0.33, st.noseY - 0.05, LEN + 0.005);
        bezel.rotation.z = s * 0.15;
        body.add(bezel);
      }
    }
    const tail = mesh(rbox(lv, 0.12, 0.06, 0.04, 0.02), glow('#ff2a2a', 0.9), false);
    tail.position.set(s * st.bodyW * 0.36, st.engineY - 0.06, R - 0.025);
    body.add(tail);
    if (hi) {
      const bezel = mesh(roundedBox(0.14, 0.08, 0.03, 0.025, 2), k.dark, false);
      bezel.position.set(s * st.bodyW * 0.36, st.engineY - 0.06, R - 0.01);
      body.add(bezel);
    }
  }

  // ---- number plate on the tail ----
  if (notLow) {
    const plate = new THREE.Group();
    plate.position.set(0, st.engineY - 0.18, R - 0.075);
    plate.rotation.y = Math.PI;
    body.add(plate);
    const back = mesh(rbox(lv, 0.24, 0.13, 0.015, 0.02), k.dark);
    plate.add(back);
    const tex = numberPlateTexture(id, st.num, def.colors.primary);
    const face = new THREE.Mesh(cachedGeo('plateplane', () => new THREE.PlaneGeometry(0.22, 0.11)), decalMat(`plate:${id}`, tex, 0.4));
    face.position.z = 0.009;
    face.renderOrder = 1;
    plate.add(face);
  }

  // ---- suspension: coil-over shocks at each corner ----
  if (notLow) {
    const springMat = k.accentPaint;
    for (const [ws, front] of [[st.wf, true], [st.wr, false]] as Array<[WheelSpec, boolean]>) {
      for (const s of [-1, 1]) {
        const a = new THREE.Vector3(s * (ws.x - ws.w / 2 - 0.06), ws.r + 0.02, ws.z + (front ? -0.06 : 0.06));
        const b = new THREE.Vector3(s * (st.bodyW / 2 - 0.08), ws.r + 0.24, ws.z + (front ? -0.14 : 0.14));
        const g = new THREE.Group();
        g.position.copy(a);
        const dir = b.clone().sub(a);
        const len = dir.length();
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        body.add(g);
        const coil = mesh(helixGeo(0.034, len * 0.7, hi ? 7 : 5, hi ? 0.0075 : 0.009, hi ? 64 : 30, hi ? 4 : 3), springMat, false);
        coil.position.y = len * 0.15;
        g.add(coil);
        const shock = mesh(cylinderGeo(0.018, 0.018, len, seg(lv, 12, 6, 4)), chromeM, false);
        shock.position.y = len / 2;
        g.add(shock);
        const can = mesh(cylinderGeo(0.024, 0.024, len * 0.4, seg(lv, 14, 8, 4)), k.dark, false);
        can.position.y = len * 0.75;
        g.add(can);
      }
    }
  }

  // ---- bumpers ----
  const bumperMat = st.bumper === 'chrome' ? chromeM : id === 'dad' ? k.accentPaint : k.dark;
  if (st.bumper === 'blade') {
    const wing = mesh(rbox(lv, 1.42, 0.035, 0.2, 0.015), k.dark);
    wing.position.set(0, 0.2, LEN + 0.06);
    body.add(wing);
    for (const s of [-1, 1]) {
      const plate = mesh(rbox(lv, 0.03, 0.12, 0.24, 0.012), k.solid(st.trim));
      plate.position.set(s * 0.71, 0.24, LEN + 0.06);
      body.add(plate);
    }
  } else {
    const r = st.bumper === 'round' ? 0.075 : 0.06;
    const bm = st.bumper === 'round' ? k.solid(st.pod === '#2a2a2a' ? '#2a2a2a' : st.pod) : bumperMat;
    if (hi) {
      // tubular bumper wrapping back towards the wheels
      const hw = (st.bodyW + 0.2) / 2;
      const pts = [
        new THREE.Vector3(-hw + 0.02, 0.2, LEN - 0.12),
        new THREE.Vector3(-hw + 0.04, 0.22, LEN + 0.0),
        new THREE.Vector3(-hw * 0.6, 0.22, LEN + 0.06),
        new THREE.Vector3(hw * 0.6, 0.22, LEN + 0.06),
        new THREE.Vector3(hw - 0.04, 0.22, LEN + 0.0),
        new THREE.Vector3(hw - 0.02, 0.2, LEN - 0.12),
      ];
      body.add(mesh(tubeGeo(`fbump:${id}`, pts, r, 32, 10), bm));
    } else {
      const bar = mesh(capsuleGeo(r, st.bodyW + 0.2, seg(lv, 16, 10, 6)), bm);
      bar.rotation.z = Math.PI / 2;
      bar.position.set((st.bodyW + 0.2) / 2, 0.22, LEN + 0.05);
      body.add(bar);
    }
    if (st.bumper === 'splitter') {
      const sp = mesh(rbox(lv, st.bodyW + 0.5, 0.05, 0.26, 0.02), k.solid(def.colors.secondary));
      sp.position.set(0, 0.13, LEN + 0.02);
      body.add(sp);
      for (const s of [-1, 1]) {
        const can = mesh(rbox(lv, 0.22, 0.03, 0.14, 0.01), k.dark);
        can.position.set(s * (st.bodyW / 2 + 0.06), 0.3, LEN - 0.05);
        can.rotation.z = s * -0.25;
        body.add(can);
      }
    }
  }
  if (hi) {
    const hw = (st.bodyW + 0.1) / 2;
    const pts = [
      new THREE.Vector3(-hw + 0.02, 0.22, R + 0.1),
      new THREE.Vector3(-hw + 0.03, 0.24, R - 0.03),
      new THREE.Vector3(-hw * 0.6, 0.24, R - 0.07),
      new THREE.Vector3(hw * 0.6, 0.24, R - 0.07),
      new THREE.Vector3(hw - 0.03, 0.24, R - 0.03),
      new THREE.Vector3(hw - 0.02, 0.22, R + 0.1),
    ];
    body.add(mesh(tubeGeo(`rbump:${id}`, pts, 0.055, 32, 10), bumperMat));
  } else {
    const rearBar = mesh(capsuleGeo(0.055, st.bodyW + 0.1, seg(lv, 16, 10, 6)), bumperMat);
    rearBar.rotation.z = Math.PI / 2;
    rearBar.position.set((st.bodyW + 0.1) / 2, 0.24, R - 0.06);
    body.add(rearBar);
  }

  // ---- spoiler / accessories ----
  const anchor = buildSpoiler(body, lv, k);
  if (liv) addLiveryProp(liv, body, anchor);
  else if (notLow && (id === 'dad' || id === 'mom' || id === 'bro1' || id === 'bro2')) {
    // whip antenna with a team pennant
    const ax = -st.bodyW * 0.36;
    const az = R + 0.12;
    const rod = mesh(cylinderGeo(0.006, 0.009, 0.7, 6), k.dark, false);
    rod.position.set(ax, st.engineY + 0.38, az);
    body.add(rod);
    const tipBall = mesh(sphereG(10, 8), glow('#ff2a2a', 0.9), false);
    tipBall.scale.setScalar(0.018);
    tipBall.position.set(ax, st.engineY + 0.73, az);
    body.add(tipBall);
    const flag = mesh(
      cachedGeo(`pennant:${lv}`, () => {
        const g = new THREE.BufferGeometry();
        const n = seg(lv, 8, 4, 2);
        const pos: number[] = [];
        const idx: number[] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const wave = Math.sin(t * 5) * 0.02 * t;
          const h = 0.12 * (1 - t);
          pos.push(wave, 0, -t * 0.26, wave, -h, -t * 0.26);
        }
        for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2, i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        return g;
      }),
      k.solid(def.colors.primary),
      false,
    );
    flag.position.set(ax, st.engineY + 0.7, az);
    body.add(flag);
  }
}

function buildEngine(body: THREE.Group, lv: Lv, k: Ctx): void {
  const { st, R } = k;
  const hi = lv === 0;
  const ez = R + 0.27;
  const engine = mesh(rbox(lv, 0.5, 0.18, 0.3, 0.05), k.metal);
  engine.position.set(0, st.engineY + 0.04, ez);
  body.add(engine);
  if (lv === 2) {
    for (const s of [-1, 1]) {
      const head = mesh(cylinderGeo(0.05, 0.05, 0.24, 8), chrome());
      head.rotation.x = Math.PI / 2;
      head.position.set(s * 0.12, st.engineY + 0.14, ez);
      body.add(head);
    }
    return;
  }
  // finned cylinder (air-cooled kart engine) leaning back
  const cyl = new THREE.Group();
  cyl.position.set(0.04, st.engineY + 0.13, ez + 0.02);
  cyl.rotation.x = -0.35;
  body.add(cyl);
  const barrel = mesh(cylinderGeo(0.07, 0.075, 0.2, seg(lv, 28, 14, 8)), k.metal);
  barrel.position.y = 0.1;
  cyl.add(barrel);
  const fins = hi ? 7 : 3;
  const finMat = k.metal;
  for (let i = 0; i < fins; i++) {
    const fin = mesh(cylinderGeo(0.115, 0.115, 0.009, seg(lv, 24, 12, 8)), finMat, false);
    fin.position.y = 0.03 + (i / (fins - 1)) * 0.16;
    cyl.add(fin);
  }
  const headCap = mesh(rbox(lv, 0.2, 0.05, 0.2, 0.022), k.accentPaint);
  headCap.position.y = 0.215;
  cyl.add(headCap);
  if (hi) {
    // spark plug + HT lead
    const plug = mesh(cylinderGeo(0.012, 0.012, 0.05, 8), chrome(), false);
    plug.position.set(0, 0.26, 0);
    cyl.add(plug);
    const lead = mesh(
      tubeGeo('htlead', [new THREE.Vector3(0, 0.28, 0), new THREE.Vector3(-0.06, 0.3, -0.04), new THREE.Vector3(-0.14, 0.2, -0.06), new THREE.Vector3(-0.2, 0.08, 0)], 0.007, 20, 5),
      k.accentPaint,
      false,
    );
    cyl.add(lead);
  }
  // pleated air filter on the side
  const filter = mesh(
    cachedGeo(`airfilter:${lv}`, () => {
      const n = hi ? 40 : 14;
      const g = new THREE.CylinderGeometry(0.075, 0.075, 0.12, n, 1, false);
      if (hi) {
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const z = p.getZ(i);
          const a = Math.atan2(z, x);
          const r = Math.hypot(x, z);
          if (r < 0.07) continue;
          const kk = 1 + 0.06 * Math.cos(a * 20);
          p.setXYZ(i, x * kk, p.getY(i), z * kk);
        }
        g.computeVertexNormals();
      }
      return g;
    }),
    k.accentPaint,
  );
  filter.rotation.z = Math.PI / 2;
  filter.position.set(-0.26, st.engineY + 0.07, ez);
  body.add(filter);
  const filterCap = mesh(cylinderGeo(0.078, 0.078, 0.02, seg(lv, 28, 14, 8)), chrome());
  filterCap.rotation.z = Math.PI / 2;
  filterCap.position.set(-0.33, st.engineY + 0.07, ez);
  body.add(filterCap);
  // pull-start cover
  const starter = mesh(cylinderGeo(0.08, 0.085, 0.03, seg(lv, 28, 14, 8)), k.dark);
  starter.rotation.z = Math.PI / 2;
  starter.position.set(0.27, st.engineY + 0.04, ez);
  body.add(starter);
  if (hi) {
    const handle = mesh(capsuleGeo(0.012, 0.05, 8), plastic('#151515', 0.5), false);
    handle.rotation.x = Math.PI / 2;
    handle.position.set(0.295, st.engineY + 0.04, ez - 0.025);
    body.add(handle);
    // drive chain guard towards the rear axle
    const guard = mesh(rbox(lv, 0.04, 0.12, 0.3, 0.02), k.dark);
    guard.position.set(0.2, st.wr.r + 0.02, st.wr.z + 0.12);
    body.add(guard);
  }
}

/** Builds the spoiler and returns where a livery accessory can sit on top of it. */
function buildSpoiler(body: THREE.Group, lv: Lv, k: Ctx): PropAnchor {
  const { st, def, R } = k;
  const paintF = k.solid;
  const c = def.colors;
  const y0 = st.engineY;
  const hi = lv === 0;
  let anchor: PropAnchor = { x: 0, y: y0 + 0.1, z: R + 0.3, post: 0.2 };
  const bolts = (x: number, y: number, z: number, n: number, dz: number) => {
    if (!hi) return;
    for (let i = 0; i < n; i++) {
      const b = mesh(cylinderGeo(0.012, 0.012, 0.012, 6), chrome(), false);
      b.rotation.z = Math.PI / 2;
      b.position.set(x, y, z + (i - (n - 1) / 2) * dz);
      body.add(b);
    }
  };
  switch (st.spoiler) {
    case 'bigwing':
    case 'wing': {
      const big = st.spoiler === 'bigwing';
      const h = big ? 0.42 : 0.34;
      for (const s of [-1, 1]) {
        const strut = mesh(rbox(lv, 0.05, h, 0.12, 0.015), k.dark);
        strut.position.set(s * (big ? 0.3 : 0.26), y0 + h / 2 - 0.02, R + 0.08);
        strut.rotation.x = 0.12;
        body.add(strut);
      }
      // aerofoil section extruded across the width
      const wingW = big ? 1.4 : 1.1;
      const chord = big ? 0.34 : 0.25;
      const thick = big ? 0.07 : 0.05;
      const foil = new THREE.Shape();
      foil.moveTo(chord / 2, 0);
      foil.bezierCurveTo(chord * 0.3, thick * 0.9, -chord * 0.4, thick * 0.7, -chord / 2, thick * 0.15);
      foil.lineTo(-chord / 2, -thick * 0.1);
      foil.bezierCurveTo(-chord * 0.3, -thick * 0.25, chord * 0.3, -thick * 0.3, chord / 2, 0);
      const wingGeo = cachedGeo(`wingfoil:${wingW}:${lv}`, () => {
        const g = bevelExtrude(`wingfoil:${wingW}`, foil, wingW, 0.012, seg(lv, 3, 1, 1), seg(lv, 16, 6, 3)).clone();
        g.rotateY(Math.PI / 2);
        return g;
      });
      const wing = mesh(wingGeo, big ? paintF(c.primary) : paintF('#151515', 0.4));
      wing.position.set(0, y0 + h - thick * 0.3, R + 0.04);
      wing.rotation.x = 0.14;
      body.add(wing);
      for (const s of [-1, 1]) {
        const plate = mesh(rbox(lv, 0.05, big ? 0.3 : 0.2, big ? 0.42 : 0.3, 0.02), paintF(c.secondary === '#151515' ? c.primary : c.secondary));
        plate.position.set(s * (big ? 0.71 : 0.56), y0 + h - 0.04, R + 0.04);
        body.add(plate);
        bolts(s * ((big ? 0.71 : 0.56) + 0.028 * s), y0 + h - 0.04, R + 0.04, 3, 0.09);
      }
      if (big) {
        const stripe = mesh(rbox(lv, 1.38, 0.075, 0.08, 0.02), paintF(c.secondary));
        stripe.position.set(0, y0 + h + 0.004, R + 0.16);
        stripe.rotation.x = -0.14;
        body.add(stripe);
      }
      anchor = { x: 0, y: y0 + h + (big ? 0.035 : 0.025), z: R + 0.06, post: 0 };
      break;
    }
    case 'fin': {
      const shape = new THREE.Shape();
      shape.moveTo(0.25, 0);
      shape.lineTo(-0.12, 0.42);
      shape.lineTo(-0.22, 0.42);
      shape.lineTo(-0.2, 0);
      shape.closePath();
      const fin = mesh(
        cachedGeo(`finfin:${lv}`, () => {
          const g = bevelExtrude('finfin', shape, 0.06, 0.015, seg(lv, 3, 1, 1), 4).clone();
          g.rotateY(-Math.PI / 2);
          return g;
        }),
        paintF(c.primary),
      );
      fin.position.set(0, y0 - 0.02, R + 0.25);
      body.add(fin);
      const wing = mesh(rbox(lv, 1.05, 0.035, 0.2, 0.015), paintF('#151515', 0.4));
      wing.position.set(0, y0 + 0.4, R + 0.0);
      wing.rotation.x = -0.18;
      body.add(wing);
      for (const s of [-1, 1]) {
        const plate = mesh(rbox(lv, 0.03, 0.18, 0.28, 0.01), paintF(c.accent));
        plate.position.set(s * 0.53, y0 + 0.36, R + 0.0);
        plate.rotation.x = 0.25;
        body.add(plate);
        bolts(s * 0.548, y0 + 0.36, R, 2, 0.12);
      }
      anchor = { x: 0.3, y: y0 + 0.42, z: R, post: 0 };
      break;
    }
    case 'lip': {
      const lip = mesh(capsuleGeo(0.065, st.bodyW * 0.85, seg(lv, 20, 12, 6)), paintF(c.secondary));
      lip.rotation.z = Math.PI / 2;
      lip.position.set((st.bodyW * 0.85) / 2, y0 + 0.07, R + 0.08);
      body.add(lip);
      const pod = mesh(sphereG(seg(lv, 32, 16, 8), seg(lv, 22, 12, 6)), paintF(c.primary));
      pod.scale.set(0.2, 0.12, 0.2);
      pod.position.set(0, y0 + 0.06, R + 0.3);
      body.add(pod);
      anchor = { x: 0, y: y0 + 0.16, z: R + 0.3, post: 0 };
      break;
    }
    case 'bone': {
      const boneMat = plastic('#f6efe0', 0.5);
      for (const s of [-1, 1]) {
        const strut = mesh(cylinderGeo(0.025, 0.03, 0.34, seg(lv, 12, 8, 6)), k.dark);
        strut.position.set(s * 0.25, y0 + 0.15, R + 0.1);
        body.add(strut);
      }
      const bone = new THREE.Group();
      bone.position.set(0, y0 + 0.34, R + 0.08);
      body.add(bone);
      const shaft = mesh(capsuleGeo(0.06, 0.95, seg(lv, 20, 12, 6)), boneMat);
      shaft.rotation.z = Math.PI / 2;
      shaft.position.x = 0.475;
      bone.add(shaft);
      const knobG = sphereG(seg(lv, 22, 12, 6), seg(lv, 16, 9, 5));
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const knob = mesh(knobG, boneMat);
          knob.scale.setScalar(0.095);
          knob.position.set(sx * 0.5, sy * 0.065, 0);
          bone.add(knob);
        }
      }
      // tennis-ball antenna
      const rod = mesh(cylinderGeo(0.008, 0.008, 0.62, 6), k.dark);
      rod.position.set(-0.36, y0 + 0.31, R + 0.32);
      body.add(rod);
      const ball = mesh(sphereG(seg(lv, 28, 14, 8), seg(lv, 20, 10, 6)), textured('tennisball', tennisBallTexture(), '#d9ef3a', { roughness: 0.95 }));
      ball.scale.setScalar(0.085);
      ball.position.set(-0.36, y0 + 0.66, R + 0.32);
      body.add(ball);
      // little bone on the nose
      const mini = new THREE.Group();
      mini.position.set(0, st.noseY + 0.02, st.len - 0.02);
      body.add(mini);
      const ms = mesh(capsuleGeo(0.025, 0.18, seg(lv, 12, 8, 6)), boneMat);
      ms.rotation.z = Math.PI / 2;
      ms.position.x = 0.09;
      mini.add(ms);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const kk = mesh(sphereG(seg(lv, 14, 10, 6), seg(lv, 10, 8, 4)), boneMat);
          kk.scale.setScalar(0.035);
          kk.position.set(sx * 0.1, sy * 0.025, 0);
          mini.add(kk);
        }
      }
      anchor = { x: 0, y: y0 + 0.395, z: R + 0.08, post: 0 };
      break;
    }
    case 'retro': {
      // little 50s tail fins with chrome tips + a daisy on a spring
      const shape = new THREE.Shape();
      shape.moveTo(0.32, 0);
      shape.quadraticCurveTo(0.0, 0.05, -0.12, 0.26);
      shape.lineTo(-0.18, 0.26);
      shape.lineTo(-0.16, 0);
      shape.closePath();
      const finGeo = cachedGeo(`retrofin:${lv}`, () => {
        const g = bevelExtrude('retrofin', shape, 0.09, 0.02, seg(lv, 3, 2, 1), seg(lv, 12, 6, 3)).clone();
        g.rotateY(-Math.PI / 2);
        return g;
      });
      for (const s of [-1, 1]) {
        const fin = mesh(finGeo, paintF(c.primary));
        fin.position.set(s * (st.bodyW / 2 - 0.06), y0 - 0.06, R + 0.2);
        body.add(fin);
        const tip = mesh(sphereG(seg(lv, 16, 10, 6), seg(lv, 12, 8, 4)), glow('#ff2a2a', 0.9));
        tip.scale.setScalar(0.04);
        tip.position.set(s * (st.bodyW / 2 - 0.06), y0 + 0.2, R + 0.03);
        body.add(tip);
      }
      const spring = lv === 2 ? mesh(cylinderGeo(0.008, 0.008, 0.5, 6), chrome()) : mesh(helixGeo(0.012, 0.5, 14, 0.004, lv === 0 ? 112 : 56, 3), chrome(), false);
      spring.position.set(0.3, y0 + (lv === 2 ? 0.25 : 0), R + 0.3);
      body.add(spring);
      const daisy = new THREE.Group();
      daisy.position.set(0.3, y0 + 0.52, R + 0.3);
      body.add(daisy);
      const petalMat = plastic('#ffffff', 0.6);
      const petalG = sphereG(seg(lv, 8, 6, 4), seg(lv, 5, 4, 3));
      for (let i = 0; i < 10; i++) {
        const p = mesh(petalG, petalMat, false);
        const a = (i / 10) * Math.PI * 2;
        p.scale.set(0.022, 0.06, 0.012);
        p.position.set(Math.sin(a) * 0.06, Math.cos(a) * 0.06, 0);
        p.rotation.z = -a;
        daisy.add(p);
      }
      const ctr = mesh(sphereG(seg(lv, 14, 10, 6), seg(lv, 10, 8, 4)), plastic('#ffd23f', 0.5), false);
      ctr.scale.set(0.035, 0.035, 0.02);
      daisy.add(ctr);
      daisy.rotation.y = Math.PI;
      anchor = { x: -0.3, y: y0 - 0.03, z: R + 0.3, post: 0.26 };
      break;
    }
  }
  return anchor;
}

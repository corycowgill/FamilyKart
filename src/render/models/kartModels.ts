import * as THREE from 'three';
import type { CharacterDef } from '../../data/characters';
import type { CharacterId } from '../../sim/types';
import type { KartRig } from './types';
import {
  cachedGeo,
  capsuleGeo,
  chrome,
  cylinderGeo,
  decalMat,
  disposeTree,
  glow,
  mesh,
  paint,
  plastic,
  roundedBox,
  sphereGeo,
  textured,
} from './materials';
import { hoodTexture, sideTexture, tennisBallTexture, treadTexture } from './textures';

/**
 * Procedural cartoon go-karts. One parametric builder; each racer gets a style that changes the
 * body profile, proportions, wheels, bumpers, spoiler and accessories so silhouettes differ.
 *
 * Layout (kart space, +Z forward, y up, origin at ground contact centre):
 *   root ── body (tilted by renderer) ── tub, pods, decals, seat, spoiler, exhausts
 *        ├─ front pivots (steer around Y) ── wheel spin group (spins around X)
 *        ├─ rear holders ── wheel spin group
 *        └─ rear contacts
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
}

function styleFor(def: CharacterDef): KartStyle {
  const c = def.colors;
  const base: KartStyle = {
    len: 1.1, rear: -0.98, bodyW: 0.94, noseY: 0.36, dashY: 0.62, dashZ: 0.38, cockpitY: 0.44, engineY: 0.64, round: 0.12,
    podW: 0.24, podTop: 0.5,
    wf: { r: 0.26, w: 0.26, x: 0.68, z: 0.74 },
    wr: { r: 0.31, w: 0.34, x: 0.7, z: -0.72 },
    body: c.primary, pod: c.secondary, trim: c.accent, seat: '#1c1c20', rim: '#c9ccd2', hub: c.secondary,
    spoiler: 'wing', bumper: 'bar', fenders: 'none',
  };
  const by: Record<CharacterId, Partial<KartStyle>> = {
    dad: {
      bodyW: 1.02, noseY: 0.4, dashY: 0.68, engineY: 0.68, round: 0.1, podW: 0.28, podTop: 0.54,
      wf: { r: 0.28, w: 0.32, x: 0.72, z: 0.76 }, wr: { r: 0.33, w: 0.44, x: 0.75, z: -0.72 },
      pod: c.secondary, trim: '#ffffff', rim: '#d4d7dd', hub: c.secondary, spoiler: 'bigwing', bumper: 'splitter',
    },
    mom: {
      len: 1.08, bodyW: 0.96, noseY: 0.36, dashY: 0.62, round: 0.24, podTop: 0.5,
      pod: c.secondary, trim: '#ffffff', seat: '#4d1f6b', rim: '#ffffff', hub: c.primary, spoiler: 'lip', bumper: 'round', fenders: 'front',
    },
    bro1: {
      bodyW: 0.9, noseY: 0.34, round: 0.1, pod: '#161616', trim: '#ffffff', rim: '#1d1d1d', hub: c.primary, spoiler: 'wing', bumper: 'bar',
    },
    bro2: {
      len: 1.16, rear: -0.95, bodyW: 0.78, noseY: 0.29, dashY: 0.58, round: 0.05, podW: 0.2, podTop: 0.46,
      wf: { r: 0.25, w: 0.24, x: 0.64, z: 0.78 }, wr: { r: 0.3, w: 0.32, x: 0.68, z: -0.72 },
      pod: '#151515', trim: c.accent, rim: c.accent, hub: '#151515', spoiler: 'fin', bumper: 'blade',
    },
    lupin: {
      len: 0.98, rear: -0.9, bodyW: 0.98, noseY: 0.42, dashY: 0.62, engineY: 0.62, round: 0.26, podTop: 0.5,
      wf: { r: 0.27, w: 0.28, x: 0.68, z: 0.68 }, wr: { r: 0.3, w: 0.32, x: 0.7, z: -0.66 },
      pod: '#2a2a2a', trim: '#ffffff', seat: '#c0392b', rim: '#2a2a2a', hub: c.primary, spoiler: 'bone', bumper: 'round', fenders: 'all',
    },
    grandma: {
      len: 1.08, rear: -1.0, bodyW: 0.98, noseY: 0.4, dashY: 0.62, round: 0.2, podTop: 0.5,
      pod: '#ffffff', trim: '#ffffff', seat: '#f2a7c3', rim: '#e9ecef', hub: '#e9ecef', spoiler: 'retro', bumper: 'chrome', fenders: 'all',
      whitewall: true, roundLights: true,
    },
  };
  return { ...base, ...by[def.id] };
}

// ---------------------------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------------------------

/** Shape from (x, y, cornerRadius) points with rounded corners. */
function roundedShape(pts: Array<[number, number, number]>): THREE.Shape {
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
    s.quadraticCurveTo(x, y, bx, by);
  }
  s.closePath();
  return s;
}

/** Extrude a side profile (z forward, y up) across X with soft bevels. Result is centred on x=0. */
function sideExtrude(key: string, pts: Array<[number, number, number]>, width: number, bevel = 0.045): THREE.BufferGeometry {
  return cachedGeo(`sideex:${key}`, () => {
    const shape = roundedShape(pts);
    const depth = Math.max(0.01, width - bevel * 2);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 5,
    });
    g.translate(0, 0, -depth / 2);
    g.rotateY(-Math.PI / 2);
    g.computeVertexNormals();
    return g;
  });
}

function tireGeo(r: number, w: number): THREE.BufferGeometry {
  return cachedGeo(`tire:${r}:${w}`, () => {
    const hw = w / 2;
    const rin = r * 0.6;
    const c = Math.min(w * 0.35, r * 0.25);
    const pts: THREE.Vector2[] = [];
    pts.push(new THREE.Vector2(rin, -hw * 0.9));
    pts.push(new THREE.Vector2(r - c, -hw));
    for (let i = 1; i <= 4; i++) {
      const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
      pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, -hw + c + Math.sin(a) * c));
    }
    pts.push(new THREE.Vector2(r, -hw * 0.3));
    pts.push(new THREE.Vector2(r, hw * 0.3));
    for (let i = 0; i <= 3; i++) {
      const a = (i / 4) * (Math.PI / 2);
      pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, hw - c + Math.sin(a) * c));
    }
    pts.push(new THREE.Vector2(r - c, hw));
    pts.push(new THREE.Vector2(rin, hw * 0.9));
    // lathe around Y (profile goes -y -> +y with x = radius) then lay the axle along X
    const g = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p.x, -p.y)), 20);
    g.rotateZ(Math.PI / 2);
    return g;
  });
}

function buildWheel(ws: WheelSpec, st: KartStyle, side: number): THREE.Group {
  const spin = new THREE.Group(); // renderer spins this around local X
  const inner = new THREE.Group();
  if (side < 0) inner.rotation.y = Math.PI; // hub detail always faces outward
  spin.add(inner);
  const tread = treadTexture();
  const tireMat = textured('tire', tread, '#26262a', { roughness: 0.85 });
  inner.add(mesh(tireGeo(ws.r, ws.w), tireMat));
  const rr = ws.r * 0.6;
  const rimMat = st.rim === '#ffffff' || st.rim === '#e9ecef' || st.rim === '#c9ccd2' || st.rim === '#d4d7dd' ? chrome() : plastic(st.rim, 0.35, 0.3);
  const rim = mesh(cylinderGeo(rr, rr, ws.w * 0.8, 16), plastic('#2b2b30', 0.5));
  rim.rotation.z = Math.PI / 2;
  inner.add(rim);
  // dished face with spokes + hub cap so spinning reads clearly
  const face = mesh(cylinderGeo(rr * 0.98, rr * 0.98, 0.02, 16), rimMat);
  face.rotation.z = Math.PI / 2;
  face.position.x = ws.w * 0.36;
  inner.add(face);
  const spokeGeo = cachedGeo(`spoke:${rr}`, () => new THREE.BoxGeometry(0.03, rr * 0.8, rr * 0.3));
  const spokeMat = plastic(st.hub, 0.35, 0.2);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const sp = mesh(spokeGeo, spokeMat);
    sp.position.set(ws.w * 0.41, Math.cos(a) * rr * 0.5, Math.sin(a) * rr * 0.5);
    sp.rotation.x = a;
    inner.add(sp);
  }
  const cap = mesh(cylinderGeo(rr * 0.28, rr * 0.34, 0.07, 14), rimMat);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = ws.w * 0.44;
  inner.add(cap);
  if (st.whitewall) {
    const ww = mesh(cachedGeo(`whitewall:${ws.r}`, () => new THREE.TorusGeometry(ws.r * 0.8, 0.028, 5, 22)), plastic('#f5f5f0', 0.6));
    ww.rotation.y = Math.PI / 2;
    ww.position.x = ws.w * 0.47;
    inner.add(ww);
  }
  return spin;
}


// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

export function buildKart(def: CharacterDef): KartRig {
  const st = styleFor(def);
  const id = def.id;
  const root = new THREE.Group();
  root.name = `kart:${id}`;
  const body = new THREE.Group();
  root.add(body);

  const bodyPaint = paint(st.body);
  const podPaint = st.pod === '#151515' || st.pod === '#161616' || st.pod === '#2a2a2a' ? paint(st.pod, 0.4) : paint(st.pod);
  const dark = plastic('#1d1d22', 0.6, 0.2);
  const metal = plastic('#5b5f68', 0.35, 0.8);

  // ---- chassis floor ----
  const floor = mesh(roundedBox(st.bodyW + 0.12, 0.09, st.len - st.rear + 0.05, 0.04, 1), dark);
  floor.position.set(0, 0.14, (st.len + st.rear) / 2);
  body.add(floor);

  // ---- main tub (side profile extruded across the width) ----
  const L = st.len;
  const R = st.rear;
  const seatZ = -0.15;
  const cockFront = st.dashZ - 0.06;
  const cockBack = seatZ - 0.3;
  const prof: Array<[number, number, number]> = [
    [L - 0.04, 0.15, 0.05],
    [L, st.noseY, st.round],
    [st.dashZ, st.dashY, 0.08],
    [cockFront, st.cockpitY + 0.02, 0.04],
    [cockBack, st.cockpitY, 0.04],
    [cockBack - 0.12, st.engineY, 0.08],
    [R + 0.02, st.engineY - 0.04, st.round],
    [R, 0.18, 0.06],
  ];
  const tubKey = `${id}`;
  const tub = mesh(sideExtrude(`tub:${tubKey}`, prof, st.bodyW, 0.05), bodyPaint);
  body.add(tub);

  // hood decal sits on the straight hood segment
  {
    const hoodA = new THREE.Vector2(L, st.noseY);
    const hoodB = new THREE.Vector2(st.dashZ, st.dashY);
    const hoodLen = hoodA.distanceTo(hoodB);
    const slope = Math.atan2(hoodB.y - hoodA.y, hoodA.x - hoodB.x);
    const mid = hoodA.clone().lerp(hoodB, 0.5);
    const tex = hoodTexture(id, def.emblem, def.colors);
    const dw = st.bodyW * 0.82;
    const dl = Math.min(hoodLen * 0.85, dw * 2);
    const decal = new THREE.Mesh(cachedGeo(`hoodplane:${dw}:${dl}`, () => new THREE.PlaneGeometry(dw, dl)), decalMat(`hood:${id}`, tex));
    const n = new THREE.Vector2(Math.sin(slope), Math.cos(slope));
    decal.position.set(0, mid.y + n.y * 0.056, mid.x + n.x * 0.056);
    decal.rotation.x = -Math.PI / 2 + slope;
    decal.renderOrder = 1;
    body.add(decal);
  }

  // dashboard cowl + little windscreen lip
  const cowl = mesh(roundedBox(st.bodyW * 0.86, 0.1, 0.18, 0.045, 1), podPaint);
  cowl.position.set(0, st.dashY + 0.02, st.dashZ - 0.02);
  cowl.rotation.x = -0.25;
  body.add(cowl);

  // ---- side pods ----
  const podX = st.bodyW / 2 + st.podW / 2 - 0.04;
  const podProf: Array<[number, number, number]> = [
    [0.4, 0.16, 0.06],
    [0.42, st.podTop - 0.1, 0.12],
    [0.22, st.podTop, 0.1],
    [-0.36, st.podTop - 0.02, 0.1],
    [-0.4, 0.18, 0.06],
  ];
  const podGeo = sideExtrude(`pod:${id}`, podProf, st.podW, 0.04);
  const sideTex = sideTexture(id, def.emblem, def.colors);
  for (const s of [-1, 1]) {
    const pod = mesh(podGeo, podPaint);
    pod.position.x = s * podX;
    body.add(pod);
    const dw = 0.74;
    const dh = 0.23;
    const decal = new THREE.Mesh(cachedGeo(`sideplane:${dw}:${dh}`, () => new THREE.PlaneGeometry(dw, dh)), decalMat(`side:${id}`, sideTex));
    decal.position.set(s * (podX + st.podW / 2 + 0.006), (0.16 + st.podTop) / 2 + 0.01, 0.01);
    decal.rotation.y = s * Math.PI / 2;
    decal.renderOrder = 1;
    body.add(decal);
    // trim strip along the pod top
    const strip = mesh(capsuleGeo(0.018, 0.56, 6), plastic(st.trim, 0.4));
    strip.rotation.x = Math.PI / 2;
    strip.position.set(s * (podX + st.podW * 0.32), st.podTop + 0.03, -0.3);
    body.add(strip);
  }

  // ---- seat ----
  const seatMat = plastic(st.seat, id === 'grandma' ? 0.85 : 0.55);
  const comfy = id === 'grandma';
  const dogBed = id === 'lupin';
  const backH = comfy ? 0.62 : dogBed ? 0.34 : 0.56;
  const seatBack = mesh(roundedBox(0.6, backH, comfy || dogBed ? 0.2 : 0.12, comfy || dogBed ? 0.09 : 0.05, 2), seatMat);
  seatBack.position.set(0, st.cockpitY + 0.04 + backH / 2, seatZ - 0.3);
  seatBack.rotation.x = -0.18;
  body.add(seatBack);
  const seatBase = mesh(roundedBox(0.58, 0.1, 0.45, 0.04, 1), seatMat);
  seatBase.position.set(0, st.cockpitY + 0.02, seatZ + 0.02);
  body.add(seatBase);
  if (comfy) {
    // tufted buttons + a knitted cushion
    for (const [x, y] of [[-0.14, 0.18], [0.14, 0.18], [0, 0.32], [-0.14, 0.46], [0.14, 0.46]]) {
      const b = mesh(sphereGeo(8, 6), plastic('#d77fa4', 0.6), false);
      b.scale.setScalar(0.022);
      b.position.set(x, st.cockpitY + y, seatZ - 0.19 - y * 0.18);
      body.add(b);
    }
    const pillow = mesh(roundedBox(0.36, 0.2, 0.1, 0.05, 1), plastic('#fff4b8', 0.9));
    pillow.position.set(0, st.cockpitY + 0.7, seatZ - 0.33);
    pillow.rotation.x = -0.25;
    body.add(pillow);
  } else if (!dogBed) {
    // racing headrest wings
    for (const s of [-1, 1]) {
      const wing = mesh(roundedBox(0.08, 0.3, 0.16, 0.035, 1), seatMat);
      wing.position.set(s * 0.29, st.cockpitY + 0.42, seatZ - 0.25);
      wing.rotation.y = -s * 0.35;
      body.add(wing);
    }
  }
  const seat = new THREE.Object3D();
  seat.name = 'seat';
  seat.position.set(0, st.cockpitY + 0.06, seatZ);
  body.add(seat);

  // ---- engine + exhausts ----
  const engine = mesh(roundedBox(0.5, 0.18, 0.3, 0.05, 1), metal);
  engine.position.set(0, st.engineY + 0.04, R + 0.27);
  body.add(engine);
  for (const s of [-1, 1]) {
    const head = mesh(cylinderGeo(0.05, 0.05, 0.24, 12), chrome());
    head.rotation.x = Math.PI / 2;
    head.position.set(s * 0.12, st.engineY + 0.14, R + 0.27);
    body.add(head);
  }
  const exhausts: THREE.Object3D[] = [];
  const exR = id === 'dad' ? 0.075 : 0.058;
  for (const s of [-1, 1]) {
    const pipe = new THREE.Group();
    pipe.position.set(s * (id === 'dad' ? 0.3 : 0.24), st.engineY - 0.12, R + 0.02);
    pipe.rotation.x = -0.25;
    body.add(pipe);
    const tube = mesh(cylinderGeo(exR, exR * 0.9, 0.34, 14), chrome());
    tube.rotation.x = Math.PI / 2;
    tube.position.z = -0.1;
    pipe.add(tube);
    const hole = mesh(cylinderGeo(exR * 0.72, exR * 0.72, 0.01, 12), plastic('#0d0d0d', 0.9), false);
    hole.rotation.x = Math.PI / 2;
    hole.position.z = -0.272;
    pipe.add(hole);
    const tip = new THREE.Object3D();
    tip.position.z = -0.29;
    pipe.add(tip);
    exhausts.push(tip);
  }

  // ---- lights ----
  for (const s of [-1, 1]) {
    if (st.roundLights) {
      const ring = mesh(cachedGeo('hlring', () => new THREE.TorusGeometry(0.075, 0.02, 6, 16)), chrome());
      ring.position.set(s * 0.3, st.noseY - 0.04, L + 0.05);
      body.add(ring);
      const lamp = mesh(sphereGeo(14, 10), glow('#fff6d8', 1.2), false);
      lamp.scale.set(0.072, 0.072, 0.04);
      lamp.position.copy(ring.position);
      body.add(lamp);
    } else {
      const lamp = mesh(roundedBox(0.16, 0.06, 0.05, 0.02, 1), glow('#fff6d8', 1.2), false);
      lamp.position.set(s * st.bodyW * 0.33, st.noseY - 0.05, L + 0.025);
      lamp.rotation.z = s * 0.15;
      body.add(lamp);
    }
    const tail = mesh(roundedBox(0.12, 0.06, 0.04, 0.02, 1), glow('#ff2a2a', 0.9), false);
    tail.position.set(s * st.bodyW * 0.36, st.engineY - 0.06, R - 0.025);
    body.add(tail);
  }

  // ---- bumpers ----
  const bumperMat = st.bumper === 'chrome' ? chrome() : plastic(id === 'dad' ? def.colors.secondary : '#1f1f24', 0.5);
  if (st.bumper === 'blade') {
    const wing = mesh(roundedBox(1.42, 0.035, 0.2, 0.015, 1), plastic('#151515', 0.4));
    wing.position.set(0, 0.2, L + 0.06);
    body.add(wing);
    for (const s of [-1, 1]) {
      const plate = mesh(roundedBox(0.03, 0.12, 0.24, 0.012, 1), paint(st.trim));
      plate.position.set(s * 0.71, 0.24, L + 0.06);
      body.add(plate);
    }
  } else {
    const r = st.bumper === 'round' ? 0.075 : 0.06;
    const bar = mesh(capsuleGeo(r, st.bodyW + 0.2, 10), st.bumper === 'round' ? paint(st.pod === '#2a2a2a' ? '#2a2a2a' : st.pod) : bumperMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set((st.bodyW + 0.2) / 2, 0.22, L + 0.05);
    body.add(bar);
    if (st.bumper === 'splitter') {
      const sp = mesh(roundedBox(st.bodyW + 0.5, 0.05, 0.26, 0.02, 1), paint(def.colors.secondary));
      sp.position.set(0, 0.13, L + 0.02);
      body.add(sp);
      // aggressive canards
      for (const s of [-1, 1]) {
        const can = mesh(roundedBox(0.22, 0.03, 0.14, 0.01, 1), plastic('#151515', 0.4));
        can.position.set(s * (st.bodyW / 2 + 0.06), 0.3, L - 0.05);
        can.rotation.z = s * -0.25;
        body.add(can);
      }
    }
  }
  const rearBar = mesh(capsuleGeo(0.055, st.bodyW + 0.1, 10), bumperMat);
  rearBar.rotation.z = Math.PI / 2;
  rearBar.position.set((st.bodyW + 0.1) / 2, 0.24, R - 0.06);
  body.add(rearBar);

  // ---- spoiler / accessories ----
  buildSpoiler(body, st, def, R);

  // ---- wheels ----
  const wheels: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  const axleMat = metal;
  for (const [ws, front] of [[st.wf, true], [st.wr, false]] as Array<[WheelSpec, boolean]>) {
    const axle = mesh(cylinderGeo(0.03, 0.03, ws.x * 2, 8), axleMat);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, ws.r, ws.z);
    root.add(axle);
    for (const s of [1, -1]) {
      const holder = new THREE.Group();
      holder.position.set(s * ws.x, ws.r, ws.z);
      root.add(holder);
      const w = buildWheel(ws, st, s);
      holder.add(w);
      wheels.push(w);
      if (front) frontPivots.push(holder);
      const wantFender = st.fenders === 'all' || (st.fenders === 'front' && front);
      if (wantFender) {
        // cartoon bubble mudguard hugging the top of the tyre
        const f = mesh(sphereGeo(14, 9), paint(st.body));
        f.scale.set(ws.w / 2 + 0.07, ws.r * 0.55, ws.r + 0.12);
        f.position.set(0, ws.r * 0.62, 0);
        holder.add(f);
      }
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

  return {
    root, body, seat, wheels, frontPivots, exhausts, rearContacts,
    dispose() {
      disposeTree(root);
    },
  };
}

function buildSpoiler(body: THREE.Group, st: KartStyle, def: CharacterDef, R: number): void {
  const c = def.colors;
  const y0 = st.engineY;
  switch (st.spoiler) {
    case 'bigwing':
    case 'wing': {
      const big = st.spoiler === 'bigwing';
      const h = big ? 0.42 : 0.34;
      for (const s of [-1, 1]) {
        const strut = mesh(roundedBox(0.05, h, 0.12, 0.015, 1), plastic('#1d1d22', 0.5));
        strut.position.set(s * (big ? 0.3 : 0.26), y0 + h / 2 - 0.02, R + 0.08);
        strut.rotation.x = 0.12;
        body.add(strut);
      }
      const wing = mesh(roundedBox(big ? 1.4 : 1.1, big ? 0.07 : 0.05, big ? 0.34 : 0.25, big ? 0.03 : 0.02, 2), big ? paint(c.primary) : paint('#151515', 0.4));
      wing.position.set(0, y0 + h, R + 0.04);
      wing.rotation.x = -0.14;
      body.add(wing);
      for (const s of [-1, 1]) {
        const plate = mesh(roundedBox(0.05, big ? 0.3 : 0.2, big ? 0.42 : 0.3, 0.02, 1), paint(c.secondary === '#151515' ? c.primary : c.secondary));
        plate.position.set(s * (big ? 0.71 : 0.56), y0 + h - 0.04, R + 0.04);
        body.add(plate);
      }
      if (big) {
        const stripe = mesh(roundedBox(1.38, 0.075, 0.08, 0.02, 1), paint(c.secondary));
        stripe.position.set(0, y0 + h + 0.004, R + 0.16);
        stripe.rotation.x = -0.14;
        body.add(stripe);
      }
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
        cachedGeo('finfin', () => {
          const g = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1 });
          g.translate(0, 0, -0.02);
          g.rotateY(-Math.PI / 2);
          return g;
        }),
        paint(c.primary),
      );
      fin.position.set(0, y0 - 0.02, R + 0.25);
      body.add(fin);
      const wing = mesh(roundedBox(1.05, 0.035, 0.2, 0.015, 1), paint('#151515', 0.4));
      wing.position.set(0, y0 + 0.4, R + 0.0);
      wing.rotation.x = -0.18;
      body.add(wing);
      for (const s of [-1, 1]) {
        const plate = mesh(roundedBox(0.03, 0.18, 0.28, 0.01, 1), paint(c.accent));
        plate.position.set(s * 0.53, y0 + 0.36, R + 0.0);
        plate.rotation.x = 0.25;
        body.add(plate);
      }
      break;
    }
    case 'lip': {
      const lip = mesh(capsuleGeo(0.065, st.bodyW * 0.85, 12), paint(c.secondary));
      lip.rotation.z = Math.PI / 2;
      lip.position.set((st.bodyW * 0.85) / 2, y0 + 0.07, R + 0.08);
      body.add(lip);
      const pod = mesh(sphereGeo(16, 12), paint(c.primary));
      pod.scale.set(0.2, 0.12, 0.2);
      pod.position.set(0, y0 + 0.06, R + 0.3);
      body.add(pod);
      break;
    }
    case 'bone': {
      const boneMat = plastic('#f6efe0', 0.5);
      for (const s of [-1, 1]) {
        const strut = mesh(cylinderGeo(0.025, 0.03, 0.34, 8), plastic('#2a2a2a', 0.5));
        strut.position.set(s * 0.25, y0 + 0.15, R + 0.1);
        body.add(strut);
      }
      const bone = new THREE.Group();
      bone.position.set(0, y0 + 0.34, R + 0.08);
      body.add(bone);
      const shaft = mesh(capsuleGeo(0.06, 0.95, 12), boneMat);
      shaft.rotation.z = Math.PI / 2;
      shaft.position.x = 0.475;
      bone.add(shaft);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const knob = mesh(sphereGeo(12, 9), boneMat);
          knob.scale.setScalar(0.095);
          knob.position.set(sx * 0.5, sy * 0.065, 0);
          bone.add(knob);
        }
      }
      // tennis-ball antenna
      const rod = mesh(cylinderGeo(0.008, 0.008, 0.62, 6), plastic('#333333', 0.4, 0.6));
      rod.position.set(-0.36, y0 + 0.31, R + 0.32);
      body.add(rod);
      const ball = mesh(sphereGeo(14, 10), textured('tennisball', tennisBallTexture(), '#d9ef3a', { roughness: 0.95 }));
      ball.scale.setScalar(0.085);
      ball.position.set(-0.36, y0 + 0.66, R + 0.32);
      body.add(ball);
      // food-bowl style dash ornament: a little bone on the nose
      const mini = new THREE.Group();
      mini.position.set(0, st.noseY + 0.02, st.len - 0.02);
      body.add(mini);
      const ms = mesh(capsuleGeo(0.025, 0.18, 8), boneMat);
      ms.rotation.z = Math.PI / 2;
      ms.position.x = 0.09;
      mini.add(ms);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const k = mesh(sphereGeo(10, 8), boneMat);
          k.scale.setScalar(0.035);
          k.position.set(sx * 0.1, sy * 0.025, 0);
          mini.add(k);
        }
      }
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
      const finGeo = cachedGeo('retrofin', () => {
        const g = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
        g.translate(0, 0, -0.025);
        g.rotateY(-Math.PI / 2);
        return g;
      });
      for (const s of [-1, 1]) {
        const fin = mesh(finGeo, paint(c.primary));
        fin.position.set(s * (st.bodyW / 2 - 0.06), y0 - 0.06, R + 0.2);
        body.add(fin);
        const tip = mesh(sphereGeo(12, 8), glow('#ff3b3b', 0.9));
        tip.scale.setScalar(0.04);
        tip.position.set(s * (st.bodyW / 2 - 0.06), y0 + 0.2, R + 0.03);
        body.add(tip);
      }
      const spring = mesh(cylinderGeo(0.008, 0.008, 0.5, 6), chrome());
      spring.position.set(0.3, y0 + 0.25, R + 0.3);
      body.add(spring);
      const daisy = new THREE.Group();
      daisy.position.set(0.3, y0 + 0.52, R + 0.3);
      body.add(daisy);
      const petalMat = plastic('#ffffff', 0.6);
      for (let i = 0; i < 10; i++) {
        const p = mesh(sphereGeo(6, 4), petalMat, false);
        const a = (i / 10) * Math.PI * 2;
        p.scale.set(0.022, 0.06, 0.012);
        p.position.set(Math.sin(a) * 0.06, Math.cos(a) * 0.06, 0);
        p.rotation.z = -a;
        daisy.add(p);
      }
      const ctr = mesh(sphereGeo(10, 8), plastic('#ffd23f', 0.5), false);
      ctr.scale.set(0.035, 0.035, 0.02);
      daisy.add(ctr);
      daisy.rotation.y = Math.PI;
      break;
    }
  }
}

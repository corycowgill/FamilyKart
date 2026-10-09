import * as THREE from 'three';
import { characterById } from '../../data/characters';
import type { CharacterId } from '../../sim/types';
import type { CharacterAnimState, CharacterRig } from './types';
import {
  alignY,
  cachedGeo,
  cachedMat,
  capsuleGeo,
  clamp,
  cylinderGeo,
  damp,
  disposeTree,
  furMat,
  lockMat,
  glow,
  mesh,
  plastic,
  roundedBox,
  seeded,
  smoothstep,
  sphereGeo,
  textured,
} from './materials';
import { FACE, type Expression, type FaceStyle, bandanaTexture, eyeAngles, faceTexture, suitTexture } from './textures';

/**
 * Procedural cartoon drivers. Every character (including Lupin the dog) is built on the same rig:
 *
 *   root
 *   ├─ pelvis ── spine ── neck ── head (headShape: skull + face patch + hair + glasses)
 *   │               └─ shoulder anchors
 *   ├─ arms (2-bone IK: upper / lower / hand groups, solved every frame in root space)
 *   └─ wheel (steering wheel, spins with steer; hand grips are children of the rim)
 *
 * so the animation code in `animate()` is shared; per-character extras (ponytail, ears, tail,
 * tongue, fur) hook in through optional fields.
 */

// ---------------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------------

type HairStyle = 'dad' | 'mom' | 'brennan' | 'parker' | 'grandma';

interface HumanSpec {
  torsoH: number;
  torsoR: number;
  sx: number;
  headR: number;
  headScale: [number, number, number];
  neck: number;
  armL1: number;
  armL2: number;
  armR: number;
  handR: number;
  legR: number;
  skin: string;
  glove: string;
  cuff: string;
  hair: HairStyle;
  hairColor: string;
  hairColor2: string;
  glasses?: { style: 'rect' | 'soft' | 'round'; color: string };
  nose: number;
  face: FaceStyle;
  wheelY: number;
}

const baseFace = { eyeTheta: 1.47, mouthTheta: 1.88, browThick: 12, blush: 0.7 };

const SPECS: Record<Exclude<CharacterId, 'lupin'>, HumanSpec> = {
  dad: {
    torsoH: 0.47, torsoR: 0.235, sx: 1.32, headR: 0.295, headScale: [1, 1.05, 0.98], neck: 0.07,
    armL1: 0.27, armL2: 0.27, armR: 0.078, handR: 0.092, legR: 0.095,
    skin: '#eeb08a', glove: '#1a1a1c', cuff: '#d62b2b', hair: 'dad', hairColor: '#3b2a20', hairColor2: '#9b958e',
    glasses: { style: 'rect', color: '#151515' }, nose: 0.15,
    face: { ...baseFace, skin: '#eeb08a', iris: '#5a3a1e', brow: '#3e3029', lip: '#9c4a44', blush: 0.55, eyeR: 0.13, eyeSep: 0.3, mouthW: 0.52, browThick: 15, beard: '#a7a29b', stubble: true },
    wheelY: 0.31,
  },
  mom: {
    torsoH: 0.42, torsoR: 0.205, sx: 1.18, headR: 0.285, headScale: [1.03, 0.98, 0.97], neck: 0.07,
    armL1: 0.25, armL2: 0.25, armR: 0.068, handR: 0.08, legR: 0.08,
    skin: '#f4c09e', glove: '#c73a92', cuff: '#e84fb0', hair: 'mom', hairColor: '#87593a', hairColor2: '#a77548',
    glasses: { style: 'soft', color: '#2e2220' }, nose: 0.12,
    face: { ...baseFace, skin: '#f4c09e', iris: '#5d7a3a', brow: '#6a4428', lip: '#c4566a', blush: 0.85, eyeR: 0.15, eyeSep: 0.3, mouthW: 0.56, browThick: 10, lashes: true },
    wheelY: 0.3,
  },
  brennan: {
    torsoH: 0.36, torsoR: 0.18, sx: 1.16, headR: 0.285, headScale: [1, 0.98, 0.97], neck: 0.05,
    armL1: 0.22, armL2: 0.22, armR: 0.062, handR: 0.078, legR: 0.07,
    skin: '#f3bf98', glove: '#151515', cuff: '#d81e1e', hair: 'brennan', hairColor: '#6a4024', hairColor2: '#865430',
    nose: 0.115,
    face: { ...baseFace, skin: '#f3bf98', iris: '#6b4a2a', brow: '#5a3820', lip: '#b5545a', eyeR: 0.165, eyeSep: 0.31, mouthW: 0.5, browThick: 11 },
    wheelY: 0.27,
  },
  parker: {
    torsoH: 0.33, torsoR: 0.17, sx: 1.14, headR: 0.285, headScale: [1.02, 0.97, 0.97], neck: 0.045,
    armL1: 0.21, armL2: 0.21, armR: 0.06, handR: 0.076, legR: 0.068,
    skin: '#f6c5a2', glove: '#151515', cuff: '#ffd21f', hair: 'parker', hairColor: '#ddb258', hairColor2: '#f4da8e',
    nose: 0.11,
    face: { ...baseFace, skin: '#f6c5a2', iris: '#3b86c9', brow: '#b98a3c', lip: '#b8565c', eyeR: 0.17, eyeSep: 0.31, mouthW: 0.52, browThick: 10, freckles: true },
    wheelY: 0.26,
  },
  grandma: {
    torsoH: 0.41, torsoR: 0.215, sx: 1.2, headR: 0.28, headScale: [1, 1.0, 0.97], neck: 0.06,
    armL1: 0.24, armL2: 0.24, armR: 0.068, handR: 0.08, legR: 0.08,
    skin: '#f3c2a5', glove: '#ffffff', cuff: '#2ec4c4', hair: 'grandma', hairColor: '#d4d5dc', hairColor2: '#b3b4bf',
    glasses: { style: 'round', color: '#3a2630' }, nose: 0.125,
    face: { ...baseFace, skin: '#f3c2a5', iris: '#4f86b8', brow: '#a8a6ad', lip: '#c25866', blush: 1.15, eyeR: 0.135, eyeSep: 0.3, mouthW: 0.48, browThick: 10, lashes: true, wrinkles: true },
    wheelY: 0.3,
  },
};

const CHAR_SCALE: Record<CharacterId, number> = { dad: 1.2, mom: 1.18, brennan: 1.2, parker: 1.2, lupin: 1.22, grandma: 1.18 };

const WHEEL_Z = 0.4;
const WHEEL_R = 0.15;
const WHEEL_TILT = 0.62;

// ---------------------------------------------------------------------------------------------
// Rig structure
// ---------------------------------------------------------------------------------------------

interface Arm {
  side: number; // +1 = character's left (+X), -1 = right
  shoulder: THREE.Object3D;
  upper: THREE.Group;
  lower: THREE.Group;
  hand: THREE.Group;
  l1: number;
  l2: number;
}

interface DogParts {
  earL: THREE.Group;
  earR: THREE.Group;
  tail: THREE.Group;
  tongue: THREE.Group;
  mouth: THREE.Mesh;
  headFur: THREE.Object3D;
  bodyFur: THREE.Object3D;
}

interface Rig {
  root: THREE.Group;
  pelvis: THREE.Group;
  spine: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  faceMat: THREE.MeshStandardMaterial;
  faceKey: (e: Expression) => THREE.Texture | null;
  arms: Arm[];
  wheelSpin: THREE.Group;
  grips: THREE.Object3D[];
  stars: THREE.Group;
  ponytail?: THREE.Group;
  dog?: DogParts;
  pelvisY: number;
  headY: number;
}

/** Point on a sphere of radius r: dphi = horizontal angle from +Z, theta = polar angle from +Y. */
function spherePt(r: number, dphi: number, theta: number): THREE.Vector3 {
  return new THREE.Vector3(r * Math.sin(theta) * Math.sin(dphi), r * Math.cos(theta), r * Math.sin(theta) * Math.cos(dphi));
}

function facePatchGeo(): THREE.BufferGeometry {
  return cachedGeo('facepatch', () =>
    new THREE.SphereGeometry(1, 30, 26, Math.PI / 2 - FACE.phiSpan / 2, FACE.phiSpan, FACE.theta0, FACE.thetaSpan),
  );
}

function torsoGeo(): THREE.BufferGeometry {
  // unit-height, unit-radius jelly-bean torso; v evenly spaced along height so suit prints are not squashed
  return cachedGeo('torso', () => {
    const pts: THREE.Vector2[] = [new THREE.Vector2(0.0, 0)];
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let f: number;
      if (t < 0.74) f = 0.84 + 0.18 * Math.sin((t / 0.74) * Math.PI * 0.5);
      else {
        const u = (t - 0.74) / 0.27;
        f = Math.max(0.36, 1.02 * Math.sqrt(Math.max(0, 1 - u * u)));
      }
      pts.push(new THREE.Vector2(f, t));
    }
    pts.push(new THREE.Vector2(0.0, 1.0));
    const g = new THREE.LatheGeometry(pts, 28);
    g.rotateY(Math.PI); // put the u=0.5 print centre at the front (+Z)
    return g;
  });
}

function starGeo(): THREE.BufferGeometry {
  return cachedGeo('star', () => {
    const s = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
      const r = i % 2 ? 0.035 : 0.08;
      if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1 });
    g.center();
    return g;
  });
}

function makeStars(y: number): THREE.Group {
  const g = new THREE.Group();
  g.position.y = y;
  const mat = glow('#ffd84a', 0.9);
  for (let i = 0; i < 3; i++) {
    const m = mesh(starGeo(), mat, false);
    const a = (i / 3) * Math.PI * 2;
    m.position.set(Math.cos(a) * 0.28, 0, Math.sin(a) * 0.28);
    g.add(m);
  }
  g.visible = false;
  return g;
}

function makeSteeringWheel(rig: { root: THREE.Group }, y: number, accent: string, rimColor = '#202024'): { spin: THREE.Group; grips: THREE.Object3D[] } {
  const mount = new THREE.Group();
  mount.position.set(0, y, WHEEL_Z);
  mount.rotation.x = WHEEL_TILT;
  rig.root.add(mount);
  const spin = new THREE.Group();
  mount.add(spin);
  const rimGeo = cachedGeo('wheelrim', () => new THREE.TorusGeometry(WHEEL_R, 0.024, 8, 22));
  spin.add(mesh(rimGeo, plastic(rimColor, 0.5)));
  // coloured grip sleeves
  const gripGeo = cachedGeo('wheelgrip', () => new THREE.TorusGeometry(WHEEL_R, 0.03, 8, 8, 0.7));
  for (const s of [1, -1]) {
    const gm = mesh(gripGeo, plastic(accent, 0.5));
    gm.rotation.z = s > 0 ? 0.1 : Math.PI - 0.8;
    spin.add(gm);
  }
  const hub = mesh(cylinderGeo(0.055, 0.055, 0.05, 16), plastic(accent, 0.4));
  hub.rotation.x = Math.PI / 2;
  spin.add(hub);
  const spokeGeo = roundedBox(0.03, WHEEL_R, 0.02, 0.008, 1);
  for (const a of [0.2, Math.PI - 0.2, -Math.PI / 2]) {
    const sp = mesh(spokeGeo, plastic(rimColor, 0.5));
    sp.position.set(Math.cos(a) * WHEEL_R * 0.5, Math.sin(a) * WHEEL_R * 0.5, 0);
    sp.rotation.z = a - Math.PI / 2;
    spin.add(sp);
  }
  // column into the dash (local +Z points forward/down)
  const col = mesh(cylinderGeo(0.022, 0.028, 0.34, 10), plastic('#3a3a40', 0.4, 0.6));
  col.rotation.x = Math.PI / 2;
  col.position.z = 0.17;
  mount.add(col);
  const grips: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const gp = new THREE.Object3D();
    const a = s > 0 ? 0.42 : Math.PI - 0.42;
    gp.position.set(Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R, -0.01);
    spin.add(gp);
    grips.push(gp);
  }
  return { spin, grips };
}

function buildArm(
  rig: { root: THREE.Group },
  side: number,
  shoulder: THREE.Object3D,
  o: { l1: number; l2: number; r: number; handR: number; sleeve: THREE.Material; glove: THREE.Material; cuff: THREE.Material; paw?: boolean },
): Arm {
  const upper = new THREE.Group();
  const lower = new THREE.Group();
  const hand = new THREE.Group();
  upper.add(mesh(capsuleGeo(o.r, o.l1, 9), o.sleeve));
  lower.add(mesh(capsuleGeo(o.r * 0.9, o.l2, 9), o.sleeve));
  if (o.paw) {
    const paw = mesh(sphereGeo(16, 12), o.glove);
    paw.scale.set(o.handR * 1.05, o.handR * 0.95, o.handR * 1.05);
    paw.position.y = o.handR * 0.3;
    hand.add(paw);
    // toe bumps
    for (let i = -1; i <= 1; i++) {
      const toe = mesh(sphereGeo(10, 8), o.glove);
      toe.scale.setScalar(o.handR * 0.32);
      toe.position.set(i * o.handR * 0.45, o.handR * 1.0, o.handR * 0.4);
      hand.add(toe);
    }
  } else {
    // flared cuff + chunky cartoon glove with thumb
    const cuff = mesh(cylinderGeo(o.r * 1.35, o.r * 1.05, o.handR * 0.7, 14), o.cuff);
    cuff.position.y = -o.handR * 0.25;
    hand.add(cuff);
    const palm = mesh(sphereGeo(16, 12), o.glove);
    palm.scale.set(o.handR * 1.08, o.handR * 1.2, o.handR * 0.82);
    palm.position.y = o.handR * 0.75;
    hand.add(palm);
    const fingers = mesh(capsuleGeo(o.handR * 0.42, o.handR * 1.2, 8), o.glove);
    fingers.rotation.z = Math.PI / 2;
    fingers.position.set(o.handR * 0.6, o.handR * 1.25, o.handR * 0.3);
    hand.add(fingers);
    const thumb = mesh(capsuleGeo(o.handR * 0.3, o.handR * 0.55, 8), o.glove);
    thumb.position.set(0, o.handR * 0.6, o.handR * 0.55);
    thumb.rotation.x = 0.9;
    hand.add(thumb);
  }
  rig.root.add(upper, lower, hand);
  return { side, shoulder, upper, lower, hand, l1: o.l1, l2: o.l2 };
}

// ---------------------------------------------------------------------------------------------
// Glasses
// ---------------------------------------------------------------------------------------------

function ringGeo(style: 'rect' | 'soft' | 'round', hw: number, hh: number): THREE.BufferGeometry {
  return cachedGeo(`glassring:${style}:${hw}:${hh}`, () => {
    const t = 0.01;
    const outer = new THREE.Shape();
    const inner = new THREE.Path();
    if (style === 'round') {
      outer.absarc(0, 0, hw + t, 0, Math.PI * 2, false);
      inner.absarc(0, 0, hw, 0, Math.PI * 2, true);
    } else {
      const rr = style === 'rect' ? 0.012 : hh * 0.75;
      const rrect = (p: THREE.Path, w: number, h: number, r: number, cw: boolean) => {
        if (!cw) {
          p.moveTo(-w + r, -h);
          p.lineTo(w - r, -h);
          p.quadraticCurveTo(w, -h, w, -h + r);
          p.lineTo(w, h - r);
          p.quadraticCurveTo(w, h, w - r, h);
          p.lineTo(-w + r, h);
          p.quadraticCurveTo(-w, h, -w, h - r);
          p.lineTo(-w, -h + r);
          p.quadraticCurveTo(-w, -h, -w + r, -h);
        } else {
          p.moveTo(-w + r, -h);
          p.quadraticCurveTo(-w, -h, -w, -h + r);
          p.lineTo(-w, h - r);
          p.quadraticCurveTo(-w, h, -w + r, h);
          p.lineTo(w - r, h);
          p.quadraticCurveTo(w, h, w, h - r);
          p.lineTo(w, -h + r);
          p.quadraticCurveTo(w, -h, w - r, -h);
          p.lineTo(-w + r, -h);
        }
      };
      rrect(outer, hw + t, hh + t, rr + t * 0.5, false);
      rrect(inner, hw, hh, rr, true);
    }
    outer.holes.push(inner);
    const g = new THREE.ExtrudeGeometry(outer, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 1, curveSegments: style === 'round' ? 7 : 3 });
    g.translate(0, 0, -0.006);
    return g;
  });
}

function buildGlasses(head: THREE.Object3D, sp: HumanSpec): void {
  if (!sp.glasses) return;
  const r = sp.headR;
  const st = sp.glasses.style;
  const k = r / 0.27;
  const hw = +((st === 'round' ? 0.052 : st === 'rect' ? 0.064 : 0.058) * k).toFixed(4);
  const hh = +((st === 'round' ? 0.052 : st === 'rect' ? 0.043 : 0.045) * k).toFixed(4);
  const frame = plastic(sp.glasses.color, 0.35);
  const lensMat = textured('lens', null, '#cfe8ff', { transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2, depthWrite: false });
  const g = new THREE.Group();
  head.add(g);
  const eyes = eyeAngles(sp.face);
  const lensPos: THREE.Vector3[] = [];
  for (const [dphi, theta] of eyes) {
    const p = spherePt(r * 1.08, dphi * 0.88, theta + 0.01);
    lensPos.push(p);
    const ring = mesh(ringGeo(st, hw, hh), frame, false);
    ring.position.copy(p);
    ring.rotation.y = dphi * 0.55;
    g.add(ring);
    const lens = new THREE.Mesh(cachedGeo(`lens:${st}:${hw}:${hh}`, () => (st === 'round' ? new THREE.CircleGeometry(hw, 20) : new THREE.PlaneGeometry(hw * 2, hh * 2))), lensMat);
    lens.position.copy(p);
    lens.rotation.y = dphi * 0.55;
    g.add(lens);
    // temple arm back to the ear
    const side = Math.sign(dphi);
    const a = p.clone().add(new THREE.Vector3(side * hw * 0.95, hh * 0.4, -0.01));
    const b = new THREE.Vector3(side * r * 1.0, a.y - 0.01, -r * 0.25);
    const arm = new THREE.Group();
    const len = alignY(arm, a, b);
    const am = mesh(cylinderGeo(0.007, 0.007, 1, 6), frame, false);
    am.position.y = len / 2;
    am.scale.y = len;
    arm.add(am);
    g.add(arm);
  }
  // bridge
  const bridge = new THREE.Group();
  const l = lensPos[0];
  const rr = lensPos[1];
  const a = new THREE.Vector3(l.x + hw * 0.9, l.y + hh * 0.3, l.z);
  const b = new THREE.Vector3(rr.x - hw * 0.9, rr.y + hh * 0.3, rr.z);
  const len = alignY(bridge, a, b);
  const bm = mesh(cylinderGeo(0.008, 0.008, 1, 6), frame, false);
  bm.position.y = len / 2;
  bridge.add(bm);
  bm.scale.y = len;
  bridge.position.z += 0.012;
  g.add(bridge);
}

// ---------------------------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------------------------

function instancedPuffs(
  pts: Array<{ p: THREE.Vector3; s: THREE.Vector3; c: string; rot?: THREE.Euler }>,
  seg: [number, number] = [8, 6],
): THREE.InstancedMesh {
  const geo = sphereGeo(seg[0], seg[1]);
  const im = new THREE.InstancedMesh(geo, furMat(), pts.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  pts.forEach((pt, i) => {
    q.setFromEuler(pt.rot ?? new THREE.Euler());
    m.compose(pt.p, q, pt.s);
    im.setMatrixAt(i, m);
    im.setColorAt(i, col.set(pt.c));
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = true;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

/** Hair cap with baked vertex colours: soft streaks between the two hair tones (+ optional grey temples). */
function hairCapVC(key: string, theta: number, tilt: number, c1: string, c2: string, greySides = false): THREE.BufferGeometry {
  return cachedGeo(`hcap:${key}:${theta}:${tilt}`, () => {
    const g = new THREE.SphereGeometry(1, 30, 16, 0, Math.PI * 2, 0, theta).rotateX(-tilt);
    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const a = new THREE.Color(c1);
    const b = new THREE.Color(c2);
    const c = new THREE.Color();
    const rnd = seeded(key.length * 31 + 7);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const ang = Math.atan2(x, z);
      let w = 0.5 + 0.5 * Math.sin(ang * 13 + Math.sin(ang * 4) * 2.5 + y * 3);
      w = w * w * 0.55;
      if (greySides) {
        let gw = smoothstep(0.6, 0.86, Math.abs(x)) * smoothstep(0.45, 0.05, y);
        gw = Math.max(gw, smoothstep(-0.55, -0.85, z) * smoothstep(0.1, -0.25, y) * 0.85);
        w = clamp(gw + (rnd() - 0.5) * 0.3 * gw + w * 0.25, 0, 1);
      }
      c.copy(a).lerp(b, w);
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    return g;
  });
}

function hairVCMat(): THREE.MeshStandardMaterial {
  return cachedMat('hairVC', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.72, vertexColors: true }));
}

function buildHair(head: THREE.Group, sp: HumanSpec, rig: Partial<Rig>): void {
  const r = sp.headR;
  const hairMat = plastic(sp.hairColor, 0.75);
  const hair2 = plastic(sp.hairColor2, 0.75);
  const cap = (theta: number, tilt: number, scale: number, greySides = false) => {
    const m = mesh(hairCapVC(sp.hair, theta, tilt, sp.hairColor, sp.hairColor2, greySides), hairVCMat());
    m.scale.setScalar(r * scale);
    head.add(m);
    return m;
  };
  const rnd = seeded(sp.hair.length * 97 + 13);
  /** lock rooted on the scalp at (dphi, theta), pointing along its normal blended with gravity by `droop` */
  const lock = (dphi: number, theta: number, len: number, wid: number, droop: number, c: string, push = 1.0): Strand => {
    const n = spherePt(1, dphi, theta);
    return { p: n.clone().multiplyScalar(r * push), n, len: r * len, wid: r * wid, c, droop };
  };
  switch (sp.hair) {
    case 'dad': {
      cap(1.5, 0.52, 1.05, true);
      // smooth front quiff volume
      const q = mesh(sphereGeo(20, 14), hairMat);
      q.position.copy(spherePt(r * 0.86, 0, 0.62));
      q.scale.set(r * 0.72, r * 0.34, r * 0.55);
      q.rotation.x = -0.35;
      head.add(q);
      break;
    }
    case 'mom': {
      cap(1.62, 0.66, 1.05);
      // swept side-part volume
      const sw = mesh(sphereGeo(20, 14), hairMat);
      sw.position.copy(spherePt(r * 0.86, -0.25, 0.7));
      sw.scale.set(r * 0.78, r * 0.3, r * 0.55);
      sw.rotation.set(-0.3, -0.2, 0.25);
      head.add(sw);
      // ponytail on a swinging pivot
      const pivot = new THREE.Group();
      pivot.position.set(0, r * 0.4, -r * 0.92);
      head.add(pivot);
      const tie = mesh(cachedGeo('hairtie', () => new THREE.TorusGeometry(0.05, 0.022, 8, 16)), plastic('#e84fb0', 0.5));
      tie.rotation.x = 0.5;
      pivot.add(tie);
      const segs: Array<[number, number, number, number]> = [
        [0, -0.03, -0.08, 0.09],
        [0, -0.13, -0.13, 0.1],
        [0, -0.24, -0.14, 0.09],
        [0, -0.34, -0.11, 0.07],
        [0, -0.42, -0.07, 0.045],
      ];
      segs.forEach(([x, y, z, rr], i) => {
        const b = mesh(sphereGeo(12, 9), i % 2 ? hair2 : hairMat);
        b.position.set(x, y, z);
        b.scale.set(rr, rr * 1.35, rr);
        pivot.add(b);
      });
      rig.ponytail = pivot;
      break;
    }
    case 'brennan': {
      cap(1.45, 0.5, 1.05);
      const strands: Strand[] = [];
      // forward-swept fringe
      for (let i = -4; i <= 4; i++) strands.push(lock(i * 0.14, 0.7 + Math.abs(i) * 0.03, 0.36, 0.12, 0.45, i % 2 ? sp.hairColor2 : sp.hairColor, 0.97));
      // short textured top
      for (let i = 0; i < 18; i++) {
        const dphi = (rnd() - 0.5) * 4.4;
        strands.push(lock(dphi, 0.12 + rnd() * 0.62, 0.3, 0.12, -0.1, rnd() > 0.5 ? sp.hairColor2 : sp.hairColor, 0.96));
      }
      head.add(shaggy(strands, rnd, 8));
      break;
    }
    case 'parker': {
      cap(1.5, 0.45, 1.05);
      // messy spiky blond tufts sticking out in all directions
      const strands: Strand[] = [];
      for (let i = 0; i < 30; i++) {
        const dphi = (rnd() - 0.5) * Math.PI * 2;
        const theta = 0.1 + rnd() * 0.95;
        if (Math.cos(dphi) > 0.5 && theta > 0.75) continue;
        strands.push(lock(dphi, theta, 0.36 + rnd() * 0.14, 0.12, -0.3 + rnd() * 0.7, rnd() > 0.45 ? sp.hairColor2 : sp.hairColor, 0.96));
      }
      // fringe flopping onto the forehead
      for (let i = -4; i <= 4; i++) strands.push(lock(i * 0.15, 0.76, 0.36, 0.12, 0.65, i % 2 ? sp.hairColor2 : sp.hairColor, 0.96));
      head.add(shaggy(strands, rnd, 8));
      break;
    }
    case 'grandma': {
      cap(1.4, 0.36, 1.03);
      const pts: Array<{ p: THREE.Vector3; s: THREE.Vector3; c: string }> = [];
      // tight curls covering the cap
      for (let i = 0; i < 70; i++) {
        const y = 1 - (i + 0.5) / 70;
        const theta = Math.acos(y) * 1.12;
        const dphi = i * 2.39996;
        const front = Math.cos(dphi) * Math.sin(theta);
        const lim = front > 0.35 ? 0.95 : front > 0 ? 1.45 : 1.95;
        if (theta > lim) continue;
        const p = spherePt(r * 1.06, dphi, theta);
        const sz = r * (0.2 + rnd() * 0.07);
        pts.push({ p, s: new THREE.Vector3(sz, sz, sz), c: rnd() > 0.5 ? sp.hairColor : rnd() > 0.5 ? sp.hairColor2 : '#eeeef2' });
      }
      head.add(instancedPuffs(pts, [8, 6]));
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Human builder
// ---------------------------------------------------------------------------------------------

function newFaceMat(id: CharacterId, face: FaceStyle): { mat: THREE.MeshStandardMaterial; get: (e: Expression) => THREE.Texture | null } {
  const tex = faceTexture(id, face, 'normal');
  const mat = new THREE.MeshStandardMaterial({ color: tex ? '#ffffff' : face.skin, map: tex, roughness: 0.62 });
  return { mat, get: (e) => faceTexture(id, face, e) };
}

function buildHuman(id: Exclude<CharacterId, 'lupin'>): Rig {
  const sp = SPECS[id];
  const def = characterById(id);
  const root = new THREE.Group();
  root.name = `character:${id}`;
  const suitTex = suitTexture(id, def.colors.suit, def.colors.suitAccent);
  const suitPrint = textured(`suitprint:${id}`, suitTex, def.colors.suit, { roughness: 0.65 });
  const suit = plastic(def.colors.suit, 0.65);
  const skin = plastic(sp.skin, 0.62);
  const glove = plastic(sp.glove, 0.5);
  const cuff = plastic(sp.cuff, 0.55);

  const pelvis = new THREE.Group();
  root.add(pelvis);
  const hips = mesh(sphereGeo(18, 12), suit);
  hips.scale.set(sp.torsoR * sp.sx * 0.95, 0.12, sp.torsoR * 0.95);
  hips.position.y = 0.04;
  pelvis.add(hips);
  // thighs + shins (mostly hidden under the dash, but they ground the pose)
  for (const s of [-1, 1]) {
    const a = new THREE.Vector3(s * sp.torsoR * 0.55, 0.05, 0.02);
    const k = new THREE.Vector3(s * sp.torsoR * 0.65, 0.12, 0.4);
    const f = new THREE.Vector3(s * sp.torsoR * 0.7, -0.12, 0.6);
    const th = new THREE.Group();
    const l1 = alignY(th, a, k);
    th.add(mesh(capsuleGeo(sp.legR, l1), suit));
    pelvis.add(th);
    const sh = new THREE.Group();
    const l2 = alignY(sh, k, f);
    sh.add(mesh(capsuleGeo(sp.legR * 0.85, l2), suit));
    pelvis.add(sh);
  }

  const spine = new THREE.Group();
  spine.position.y = 0.02;
  pelvis.add(spine);
  const torso = mesh(torsoGeo(), suitPrint);
  torso.scale.set(sp.torsoR * sp.sx, sp.torsoH, sp.torsoR * 0.86);
  spine.add(torso);
  // collar
  const collar = mesh(cachedGeo('collar', () => new THREE.TorusGeometry(1, 0.28, 8, 20)), plastic(def.colors.suitAccent, 0.55));
  collar.scale.set(sp.torsoR * 0.42, sp.torsoR * 0.42, sp.torsoR * 0.42);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = sp.torsoH * 0.97;
  spine.add(collar);
  if (id === 'mom') {
    // hood bunched behind the neck
    const hood = mesh(sphereGeo(16, 12), suit);
    hood.scale.set(sp.torsoR * 0.95, sp.torsoR * 0.5, sp.torsoR * 0.55);
    hood.position.set(0, sp.torsoH * 0.92, -sp.torsoR * 0.55);
    spine.add(hood);
  }

  const shoulders: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const sh = new THREE.Object3D();
    sh.position.set(s * sp.torsoR * sp.sx * 0.86, sp.torsoH * 0.8, 0);
    spine.add(sh);
    shoulders.push(sh);
    const ball = mesh(sphereGeo(16, 12), suit);
    ball.scale.setScalar(sp.armR * 1.45);
    ball.position.copy(sh.position);
    spine.add(ball);
  }

  const neck = new THREE.Group();
  neck.position.y = sp.torsoH * 0.95;
  spine.add(neck);
  const neckM = mesh(cylinderGeo(sp.headR * 0.33, sp.headR * 0.38, sp.neck + 0.08, 12), skin);
  neckM.position.y = sp.neck / 2;
  neck.add(neckM);

  const head = new THREE.Group();
  const headY = sp.neck + sp.headR * 0.82;
  head.position.y = headY;
  neck.add(head);
  const headShape = new THREE.Group();
  headShape.scale.set(...sp.headScale);
  head.add(headShape);
  const skull = mesh(sphereGeo(28, 20), skin);
  skull.scale.setScalar(sp.headR);
  headShape.add(skull);
  const face = newFaceMat(id, sp.face);
  const patch = mesh(facePatchGeo(), face.mat);
  patch.scale.setScalar(sp.headR * 1.004);
  headShape.add(patch);
  // nose + ears
  const noseMat = plastic(new THREE.Color(sp.skin).lerp(new THREE.Color('#e88a7a'), 0.25).getStyle(), 0.55);
  const nose = mesh(sphereGeo(14, 10), noseMat);
  nose.position.copy(spherePt(sp.headR * 0.98, 0, 1.76));
  nose.scale.set(sp.headR * sp.nose * 1.05, sp.headR * sp.nose * 0.9, sp.headR * sp.nose);
  headShape.add(nose);
  for (const s of [-1, 1]) {
    const ear = mesh(sphereGeo(12, 10), skin);
    ear.position.set(s * sp.headR * 0.98, -sp.headR * 0.08, -sp.headR * 0.05);
    ear.scale.set(sp.headR * 0.12, sp.headR * 0.22, sp.headR * 0.17);
    headShape.add(ear);
  }
  const rigPartial: Partial<Rig> = {};
  buildHair(headShape, sp, rigPartial);
  buildGlasses(headShape, sp);
  if (id === 'dad') {
    // chunky 3D goatee tuft for silhouette
    const tuft = mesh(sphereGeo(12, 10), plastic(sp.face.beard!, 0.9));
    tuft.position.copy(spherePt(sp.headR * 0.92, 0, 2.28));
    tuft.scale.set(sp.headR * 0.24, sp.headR * 0.2, sp.headR * 0.16);
    headShape.add(tuft);
    const stache = mesh(capsuleGeo(sp.headR * 0.065, sp.headR * 0.32, 8), plastic(sp.face.beard!, 0.9));
    stache.rotation.z = Math.PI / 2;
    stache.position.copy(spherePt(sp.headR * 1.0, 0, 1.87)).add(new THREE.Vector3(sp.headR * 0.16, 0, 0));
    headShape.add(stache);
  }
  const stars = makeStars(sp.headR * 1.25);
  head.add(stars);

  const wheel = makeSteeringWheel({ root }, sp.wheelY, def.colors.suitAccent === '#ffffff' ? def.colors.primary : def.colors.suitAccent);
  const arms = shoulders.map((sh, i) =>
    buildArm({ root }, i === 0 ? 1 : -1, sh, { l1: sp.armL1, l2: sp.armL2, r: sp.armR, handR: sp.handR, sleeve: suit, glove, cuff }),
  );

  return {
    root, pelvis, spine, neck, head, faceMat: face.mat, faceKey: face.get, arms,
    wheelSpin: wheel.spin, grips: wheel.grips, stars, ponytail: rigPartial.ponytail, pelvisY: 0, headY,
  };
}

// ---------------------------------------------------------------------------------------------
// Lupin
// ---------------------------------------------------------------------------------------------

const LUPIN_FACE: FaceStyle = {
  skin: '#ecdab4', iris: '#2a1a10', brow: '#a77c4c', lip: '#4a1518', blush: 0, eyeR: 0.16, eyeSep: 0.36,
  eyeTheta: 1.4, mouthTheta: 2.1, mouthW: 0.3, browThick: 8, dog: true,
};

const FUR = ['#f0e0bd', '#e6d0a6', '#f6ead2', '#d9bd90', '#e0c79c', '#cfae7c'];
const FUR_LIGHT = ['#f6ead2', '#f2e4c6', '#ecdab4'];
const EAR_FUR = ['#c49a62', '#b48650', '#d1aa72', '#a77a46', '#bf935c'];

function furColor(rnd: () => number, pal: string[]): string {
  return pal[Math.floor(rnd() * pal.length) % pal.length];
}

interface Strand {
  p: THREE.Vector3; // root point
  n: THREE.Vector3; // surface normal
  len: number;
  wid: number;
  c: string;
  droop?: number; // 0..1 how much it hangs with gravity
}

/** Tapered teardrop "lock" of hair hanging along -Y from the origin, darker towards the tip. */
function lockGeo(seg = 5): THREE.BufferGeometry {
  return cachedGeo(`furlockgeo:${seg}`, () => {
    const prof: Array<[number, number]> = [[0.0, -1.0], [0.5, -0.9], [0.85, -0.66], [1.0, -0.36], [0.78, -0.06], [0.0, 0.08]];
    const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = clamp(-pos.getY(i), 0, 1);
      const k = 1.06 - t * 0.2;
      col[i * 3] = k;
      col[i * 3 + 1] = k * 0.98;
      col[i * 3 + 2] = k * 0.95;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
}

/** Shaggy fur: tapered locks hanging from root points (one InstancedMesh per group). */
function shaggy(strands: Strand[], rnd: () => number, seg = 5): THREE.InstancedMesh {
  const down = new THREE.Vector3(0, -1, 0);
  const up = new THREE.Vector3(0, 1, 0);
  const im = new THREE.InstancedMesh(lockGeo(seg), lockMat(), strands.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  strands.forEach((st, i) => {
    const n = st.n.clone().normalize();
    const d = down.clone().addScaledVector(n, -n.dot(down));
    if (d.lengthSq() < 0.09) {
      const out = new THREE.Vector3(st.p.x, 0, st.p.z);
      if (out.lengthSq() < 1e-4) out.set(0, 0, -1);
      d.lerp(out.normalize(), 0.7);
    }
    d.normalize();
    const droop = st.droop ?? 0.8;
    const dir = d.multiplyScalar(droop).addScaledVector(n, 1 - droop * 0.75).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(down, dir);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, rnd() * Math.PI));
    const pos = st.p.clone().addScaledVector(n, st.wid * 0.15);
    m.compose(pos, q, new THREE.Vector3(st.wid, st.len, st.wid * 0.8));
    im.setMatrixAt(i, m);
    im.setColorAt(i, col.set(st.c));
  });
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = true;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  return im;
}

function fib(i: number, n: number): [number, number] {
  const y = 1 - ((i + 0.5) / n) * 2;
  return [Math.acos(clamp(y, -1, 1)), i * 2.39996];
}

function buildLupin(): Rig {
  const def = characterById('lupin');
  const root = new THREE.Group();
  root.name = 'character:lupin';
  const rnd = seeded(4242);
  const cream = plastic('#e9d6ae', 0.95);
  const light = plastic('#f3e6cc', 0.95);

  const pelvis = new THREE.Group();
  pelvis.position.y = 0.02;
  root.add(pelvis);
  const hip = mesh(sphereGeo(14, 10), cream);
  hip.scale.set(0.21, 0.15, 0.22);
  hip.position.set(0, 0.08, -0.02);
  pelvis.add(hip);
  // hind legs tucked forward
  const legStrands: Strand[] = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      legStrands.push({ p: new THREE.Vector3(s * 0.16, 0.14, -0.02 + i * 0.09), n: new THREE.Vector3(s, 0.6, 0), len: 0.15, wid: 0.06, c: furColor(rnd, FUR) });
    }
  }
  pelvis.add(shaggy(legStrands, rnd));

  // tail: curled plume over the back
  const tail = new THREE.Group();
  tail.position.set(0, 0.2, -0.19);
  pelvis.add(tail);
  const tailStrands: Strand[] = [];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const a = t * Math.PI * 0.9;
    const p = new THREE.Vector3((rnd() - 0.5) * 0.05, Math.sin(a) * 0.24 + t * 0.06, -Math.cos(a) * 0.12 + 0.02 - t * 0.12);
    tailStrands.push({ p: p.multiplyScalar(1.35), n: new THREE.Vector3((rnd() - 0.5) * 0.6, 0.4, -1), len: 0.17 + Math.sin(t * Math.PI) * 0.08, wid: 0.07, c: furColor(rnd, t > 0.3 ? EAR_FUR : FUR), droop: 0.5 });
  }
  tail.add(shaggy(tailStrands, rnd));

  const spine = new THREE.Group();
  spine.position.y = 0.04;
  pelvis.add(spine);
  const chestCore = mesh(sphereGeo(16, 12), cream);
  chestCore.scale.set(0.17, 0.23, 0.15);
  chestCore.position.set(0, 0.2, 0.0);
  spine.add(chestCore);
  const bodyStrands: Strand[] = [];
  const NB = 56;
  for (let i = 0; i < NB; i++) {
    const [th, ph] = fib(i, NB * 1.3);
    const n = new THREE.Vector3(Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph));
    const p = new THREE.Vector3(n.x * 0.16, 0.2 + n.y * 0.21, n.z * 0.14);
    const front = n.z > 0.3;
    if (n.z > 0.45 && n.y > 0.25) continue;
    bodyStrands.push({ p, n, len: 0.19 + rnd() * 0.05, wid: 0.05 + rnd() * 0.012, c: front ? furColor(rnd, FUR_LIGHT) : furColor(rnd, FUR), droop: 0.92 });
  }
  const bodyFur = shaggy(bodyStrands, rnd);
  const bodyFurGroup = new THREE.Group();
  bodyFurGroup.add(bodyFur);
  spine.add(bodyFurGroup);

  const shoulders: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const sh = new THREE.Object3D();
    sh.position.set(s * 0.12, 0.3, 0.08);
    spine.add(sh);
    shoulders.push(sh);
  }

  const neck = new THREE.Group();
  neck.position.set(0, 0.4, 0.03);
  spine.add(neck);
  // bandana: knotted collar + triangle bib with white paw prints
  const navy = def.colors.suit;
  const bTex = bandanaTexture(navy);
  const bandMat = textured('bandana', bTex, navy, { roughness: 0.8, side: THREE.DoubleSide });
  const collar = mesh(cachedGeo('dogcollar', () => new THREE.TorusGeometry(0.16, 0.045, 8, 20)), plastic(navy, 0.8));
  collar.rotation.x = Math.PI / 2 - 0.25;
  collar.position.set(0, -0.02, 0);
  neck.add(collar);
  const bib = mesh(cachedGeo('bandanabib', () => new THREE.ConeGeometry(0.2, 0.26, 18, 1, true, -Math.PI * 0.55, Math.PI * 1.1)), bandMat);
  bib.rotation.x = Math.PI - 0.3;
  bib.scale.set(1, 1, 0.75);
  bib.position.set(0, -0.12, 0.1);
  neck.add(bib);

  const head = new THREE.Group();
  const headY = 0.2;
  head.position.y = headY;
  neck.add(head);
  const headShape = new THREE.Group();
  head.add(headShape);
  const HR = 0.21;
  const skull = mesh(sphereGeo(22, 16), cream);
  skull.scale.setScalar(HR);
  headShape.add(skull);
  const face = newFaceMat('lupin', LUPIN_FACE);
  const patch = mesh(facePatchGeo(), face.mat);
  patch.scale.setScalar(HR * 1.004);
  headShape.add(patch);

  // muzzle, nose, mouth, tongue
  const muzzle = mesh(sphereGeo(16, 12), light);
  muzzle.scale.set(0.12, 0.085, 0.1);
  muzzle.position.set(0, -0.07, 0.175);
  headShape.add(muzzle);
  const nose = mesh(sphereGeo(14, 10), plastic('#1b1412', 0.18));
  nose.scale.set(0.05, 0.036, 0.036);
  nose.position.set(0, -0.04, 0.27);
  headShape.add(nose);
  const mouth = mesh(sphereGeo(12, 8), plastic('#4a1518', 0.6));
  mouth.scale.set(0.065, 0.028, 0.04);
  mouth.position.set(0, -0.125, 0.22);
  headShape.add(mouth);
  const tongue = new THREE.Group();
  tongue.position.set(0, -0.13, 0.235);
  headShape.add(tongue);
  const tongueM = mesh(capsuleGeo(0.034, 0.075, 10), plastic('#f06b86', 0.4));
  tongueM.scale.set(1, 1, 0.45);
  tongueM.rotation.x = Math.PI * 0.82;
  tongue.add(tongueM);

  // head fur: shaggy strands everywhere except the eye/muzzle window
  const headStrands: Strand[] = [];
  const NH = 112;
  for (let i = 0; i < NH; i++) {
    const [th, ph] = fib(i, NH);
    const dphi = Math.atan2(Math.sin(ph), Math.cos(ph));
    if (Math.abs(dphi) < 0.95 && th > 0.98 && th < 2.4) continue;
    const n = spherePt(1, dphi, th);
    const top = th < 0.98 && Math.abs(dphi) < 1.0;
    headStrands.push({ p: n.clone().multiplyScalar(HR * 0.97), n, len: top ? 0.13 : 0.17 + rnd() * 0.05, wid: 0.045 + rnd() * 0.012, c: furColor(rnd, FUR), droop: 0.9 });
  }
  // fringe falling over the forehead (stops above the eyes)
  for (let i = -3; i <= 3; i++) {
    const n = spherePt(1, i * 0.21, 0.86);
    headStrands.push({ p: n.clone().multiplyScalar(HR * 0.98), n, len: 0.085, wid: 0.05, c: furColor(rnd, FUR), droop: 0.9 });
  }
  // cheeks + beard around the muzzle
  for (let i = 0; i < 14; i++) {
    const a = Math.PI * (0.95 + (i / 13) * 1.1);
    const n = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.6, 0.6).normalize();
    const p = new THREE.Vector3(Math.cos(a) * 0.12, -0.075 + Math.sin(a) * 0.06, 0.15);
    headStrands.push({ p, n, len: 0.12, wid: 0.045, c: furColor(rnd, FUR_LIGHT), droop: 0.95 });
  }
  const headFur = shaggy(headStrands, rnd);
  const headFurGroup = new THREE.Group();
  headFurGroup.add(headFur);
  headShape.add(headFurGroup);

  // big floppy ears
  const ears: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const ear = new THREE.Group();
    ear.position.copy(spherePt(HR * 0.98, s * 1.25, 0.78));
    headShape.add(ear);
    const strands: Strand[] = [];
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const p = new THREE.Vector3(s * (0.035 + (rnd() - 0.2) * 0.03), -t * 0.2, (rnd() - 0.5) * 0.08);
      strands.push({ p, n: new THREE.Vector3(s, 0, 0), len: 0.15 + t * 0.06, wid: 0.06, c: furColor(rnd, EAR_FUR), droop: 0.95 });
    }
    ear.add(shaggy(strands, rnd));
    ears.push(ear);
  }

  const stars = makeStars(0.32);
  head.add(stars);

  const wheel = makeSteeringWheel({ root }, 0.24, def.colors.primary);
  const legMat = plastic('#e6d2aa', 0.95);
  const pawMat = plastic('#f4e9d2', 0.95);
  const arms = shoulders.map((sh, i) =>
    buildArm({ root }, i === 0 ? 1 : -1, sh, { l1: 0.19, l2: 0.19, r: 0.062, handR: 0.072, sleeve: legMat, glove: pawMat, cuff: legMat, paw: true }),
  );
  // fluffy leg strands
  for (const a of arms) {
    for (const [grp, len] of [[a.upper, a.l1], [a.lower, a.l2]] as Array<[THREE.Group, number]>) {
      const strands: Strand[] = [];
      for (let i = 0; i < 3; i++) {
        const ang = rnd() * Math.PI * 2;
        const n = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
        strands.push({ p: new THREE.Vector3(n.x * 0.045, (i + 0.3) * (len / 3), n.z * 0.045), n, len: 0.1, wid: 0.05, c: furColor(rnd, FUR), droop: 0.3 });
      }
      grp.add(shaggy(strands, rnd));
    }
  }

  return {
    root, pelvis, spine, neck, head, faceMat: face.mat, faceKey: face.get, arms,
    wheelSpin: wheel.spin, grips: wheel.grips, stars, pelvisY: 0.02, headY,
    dog: { earL: ears[0], earR: ears[1], tail, tongue, mouth, headFur: headFurGroup, bodyFur: bodyFurGroup },
  };
}

// ---------------------------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------------------------

type ReactKey = 'hit' | 'item' | 'overtake' | 'jump' | 'win' | 'lose';
const REACTS: ReactKey[] = ['hit', 'item', 'overtake', 'jump', 'win', 'lose'];

const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _e = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();

function solveArm(rig: Rig, arm: Arm, target: THREE.Vector3): void {
  arm.shoulder.getWorldPosition(_s);
  rig.root.worldToLocal(_s);
  _dir.subVectors(target, _s);
  let d = _dir.length();
  const max = arm.l1 + arm.l2 - 1e-3;
  const min = Math.abs(arm.l1 - arm.l2) + 0.02;
  if (d < 1e-5) _dir.set(0, 0, 1);
  _dir.normalize();
  d = clamp(d, min, max);
  const a = (arm.l1 * arm.l1 - arm.l2 * arm.l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, arm.l1 * arm.l1 - a * a));
  _pole.set(arm.side * 1.0, -0.7, -0.35);
  _pole.addScaledVector(_dir, -_pole.dot(_dir)).normalize();
  _e.copy(_s).addScaledVector(_dir, a).addScaledVector(_pole, h);
  _t.copy(_s).addScaledVector(_dir, d);
  alignY(arm.upper, _s, _e);
  alignY(arm.lower, _e, _t);
  arm.hand.position.copy(_t);
  arm.hand.quaternion.copy(arm.lower.quaternion);
}

interface AnimState {
  steer: number;
  drift: number;
  boost: number;
  accel: number;
  prevSpeed: number;
  reaction: CharacterAnimState['reaction'];
  age: number;
  w: Record<ReactKey, number>;
  blinkAt: number;
  blinkUntil: number;
  wasAirborne: boolean;
  furX: number;
  furV: number;
  earSwing: number;
  earSwingV: number;
  tailPhase: number;
  earPhase: number;
  expr: Expression;
  rnd: () => number;
}

function animate(rig: Rig, st: AnimState, dt: number, s: CharacterAnimState): void {
  dt = clamp(dt, 0, 0.1);
  const t = s.time;
  if (s.reaction !== st.reaction) {
    st.reaction = s.reaction;
    st.age = 0;
  } else st.age += dt;
  const age = st.age;
  for (const k of REACTS) {
    let on = s.reaction === k ? 1 : 0;
    if (k === 'jump' && s.airborne) on = 1;
    st.w[k] = damp(st.w[k], on, on ? 14 : 7, dt);
  }
  const w = st.w;
  st.steer = damp(st.steer, clamp(s.steer, -1, 1), 9, dt);
  st.drift = damp(st.drift, s.drifting ? Math.sign(s.driftDir || s.steer || 1) : 0, 6, dt);
  st.boost = damp(st.boost, s.boosting ? 1 : 0, 6, dt);
  if (dt > 0) {
    const raw = (s.speed - st.prevSpeed) / dt;
    st.accel = damp(st.accel, clamp(raw / 18, -1, 1), 3, dt);
  }
  st.prevSpeed = s.speed;
  const speedN = clamp(Math.abs(s.speed) / 28, 0, 1.3);
  const steer = st.steer;
  const drift = st.drift;

  // ---- body ----
  let pelvisY = rig.pelvisY + Math.sin(t * 31) * 0.003 * speedN;
  let spX = -0.04 - st.boost * 0.14 - st.accel * 0.07;
  let spY = -steer * 0.08;
  let spZ = steer * 0.13 + drift * 0.15;
  let hX = 0.03 + st.boost * 0.06 + Math.sin(t * 2.4 + 1) * 0.015;
  let hY = -(steer * 0.38 + drift * 0.22);
  let hZ = steer * 0.08;
  const breathe = 1 + Math.sin(t * 2.4) * 0.012;

  // hit: dizzy wobble
  if (w.hit > 0.01) {
    const k = w.hit;
    spY += Math.sin(age * 9) * 0.35 * k;
    spZ += Math.sin(age * 7) * 0.18 * k;
    hZ += Math.sin(age * 12) * 0.35 * k;
    hY += Math.cos(age * 12) * 0.45 * k;
    hX -= 0.1 * k;
  }
  if (w.win > 0.01) {
    const k = w.win;
    pelvisY += Math.abs(Math.sin(age * 7)) * 0.07 * k;
    spY += Math.sin(age * 3.5) * 0.25 * k;
    spX -= 0.06 * k;
    hX -= 0.18 * k;
    hZ += Math.sin(age * 7) * 0.1 * k;
  }
  if (w.lose > 0.01) {
    const k = w.lose;
    spX += 0.32 * k;
    hX += 0.38 * k;
    hY += Math.sin(age * 4) * 0.32 * k * (0.5 + 0.5 * Math.sin(age * 0.8));
    pelvisY -= 0.02 * k;
  }
  if (w.overtake > 0.01) {
    const k = w.overtake;
    hX -= 0.16 * k;
    hZ += Math.sin(age * 14) * 0.08 * k;
    spY -= 0.12 * k;
  }
  if (w.jump > 0.01) {
    const k = w.jump;
    spX -= 0.1 * k;
    hX -= 0.12 * k;
    pelvisY += 0.03 * k;
  }
  if (w.item > 0.01) {
    const k = w.item;
    const p = clamp(age / 0.6, 0, 1);
    spY += (p < 0.35 ? 0.22 : -0.15) * k;
    hX -= 0.08 * k;
  }

  rig.pelvis.position.y = pelvisY;
  rig.spine.rotation.set(spX + (rig.dog ? 0.08 : 0), spY, spZ);
  rig.spine.scale.set(1, breathe, 1);
  rig.neck.rotation.set(-spX * 0.5, 0, -spZ * 0.4);
  rig.head.rotation.set(hX, hY, hZ, 'YXZ');
  rig.head.position.y = rig.headY;

  rig.wheelSpin.rotation.z = steer * 1.3 + drift * 0.55 + (w.hit > 0.01 ? Math.sin(age * 15) * 0.5 * w.hit : 0);

  // ---- arms ----
  rig.root.updateMatrixWorld(true);
  const targets: THREE.Vector3[] = [];
  for (let i = 0; i < 2; i++) {
    const arm = rig.arms[i];
    const side = arm.side;
    const grip = rig.grips[i].getWorldPosition(new THREE.Vector3());
    rig.root.worldToLocal(grip);
    arm.shoulder.getWorldPosition(_p);
    rig.root.worldToLocal(_p);
    const sh = _p.clone();
    const tgt = grip;
    const lerpTo = (x: number, y: number, z: number, k: number) => {
      _v.set(sh.x + x, sh.y + y, sh.z + z);
      tgt.lerp(_v, clamp(k, 0, 1));
    };
    if (w.jump > 0.01) lerpTo(side * 0.22, 0.4 + Math.sin(age * 16 + side) * 0.05, 0.1, w.jump);
    if (w.win > 0.01) lerpTo(side * 0.17, 0.38 + 0.12 * Math.sin(age * 9 + (side > 0 ? 0 : Math.PI)), 0.08, w.win);
    if (w.hit > 0.01) {
      const k = w.hit * (age < 0.5 ? 0.9 : 0.45);
      lerpTo(side * 0.3, 0.2 + Math.sin(age * 14 + side * 2) * 0.1, 0.12 + Math.cos(age * 11 + side) * 0.08, k);
    }
    if (side < 0) {
      if (w.item > 0.01) {
        const p = clamp(age / 0.6, 0, 1);
        const wind = smoothstep(0, 0.3, p) * (1 - smoothstep(0.35, 0.55, p));
        const thr = smoothstep(0.35, 0.55, p);
        _v.set(sh.x - 0.08, sh.y + 0.4, sh.z - 0.1).lerp(_v.clone().set(sh.x - 0.05, sh.y + 0.28, sh.z + 0.42), thr);
        tgt.lerp(_v, clamp(w.item * Math.max(wind, thr * (1 - smoothstep(0.75, 1, p) * 0.6)), 0, 1));
      }
      if (w.overtake > 0.01) lerpTo(-0.06, 0.34 + Math.sin(age * 18) * 0.09, 0.14, w.overtake);
    }
    targets.push(tgt);
  }
  for (let i = 0; i < 2; i++) solveArm(rig, rig.arms[i], targets[i]);

  // ---- stars ----
  rig.stars.visible = w.hit > 0.15;
  if (rig.stars.visible) {
    rig.stars.rotation.y = t * 6;
    rig.stars.scale.setScalar(w.hit);
  }

  // ---- face ----
  let expr: Expression = 'normal';
  if (s.reaction === 'hit') expr = age < 0.35 ? 'shocked' : 'dizzy';
  else if (s.reaction === 'lose') expr = 'sad';
  else if (s.reaction === 'win' || s.reaction === 'item' || s.reaction === 'overtake' || s.reaction === 'jump' || s.airborne) expr = 'laugh';
  else if (s.drifting || s.boosting) expr = 'determined';
  if (expr === 'normal') {
    if (t > st.blinkAt) {
      st.blinkUntil = t + 0.13;
      st.blinkAt = t + 2.2 + st.rnd() * 2.8;
    }
    if (t < st.blinkUntil) expr = 'blink';
  }
  if (expr !== st.expr) {
    st.expr = expr;
    const tex = rig.faceKey(expr);
    if (tex) rig.faceMat.map = tex;
  }

  // ---- secondary motion ----
  // spring driven by road buzz, landings, bounces
  if (st.wasAirborne && !s.airborne) st.furV -= 1.6;
  st.wasAirborne = s.airborne;
  st.furV += (st.rnd() - 0.5) * speedN * 0.6;
  if (w.win > 0.01) st.furV += Math.cos(age * 7) * 0.25 * w.win;
  if (w.hit > 0.01) st.furV += Math.sin(age * 20) * 0.3 * w.hit;
  st.furV += (-120 * st.furX - 9 * st.furV) * dt;
  st.furX = clamp(st.furX + st.furV * dt, -0.15, 0.15);

  // lateral swing for ears / ponytail (lags behind steering)
  const swingTarget = -steer * 0.45 - drift * 0.3 + spY * 0.5;
  st.earSwingV += (60 * (swingTarget - st.earSwing) - 6 * st.earSwingV) * dt;
  st.earSwing += st.earSwingV * dt;

  if (rig.ponytail) {
    const p = rig.ponytail;
    p.rotation.x = 0.15 + speedN * 0.45 + st.accel * 0.25 + st.furX * 2 - w.lose * 0.2;
    p.rotation.z = st.earSwing * 0.8 + Math.sin(t * 5) * 0.03;
  }

  if (rig.dog) {
    const d = rig.dog;
    const excited = Math.max(w.win, w.overtake, w.item, w.jump);
    // ears flap harder the faster we go
    const flapAmp = 0.07 + speedN * 0.32 + excited * 0.25 + w.hit * 0.4;
    st.earPhase += dt * (6 + speedN * 12 + excited * 6);
    for (const [ear, side] of [[d.earL, 1], [d.earR, -1]] as Array<[THREE.Group, number]>) {
      const flap = Math.sin(st.earPhase + (side > 0 ? 0 : 0.7)) * flapAmp;
      const lift = 0.12 + speedN * 0.55 + excited * 0.5 - w.lose * 0.35;
      ear.rotation.z = side * (lift + flap) + st.earSwing * 0.6 + st.furX * side * 2.2;
      ear.rotation.x = -speedN * 0.55 + Math.sin(st.earPhase * 0.6 + side) * flapAmp * 0.4 + w.lose * 0.25;
    }
    // tail wags faster when overtaking / winning
    const wagFreq = 9 + excited * 12 + speedN * 2 - w.lose * 6;
    st.tailPhase += dt * wagFreq;
    const wagAmp = (0.35 + excited * 0.35) * (1 - w.lose * 0.7);
    d.tail.rotation.z = Math.sin(st.tailPhase) * wagAmp;
    d.tail.rotation.y = Math.sin(st.tailPhase) * wagAmp * 0.4;
    d.tail.rotation.x = -w.lose * 0.8 + speedN * 0.15;
    // tongue waggle
    const tLen = expr === 'laugh' ? 1.35 : expr === 'determined' ? 0.75 : expr === 'sad' ? 0.45 : expr === 'shocked' ? 0.6 : 1;
    d.tongue.scale.set(1, damp(d.tongue.scale.y, tLen, 10, dt), 1);
    d.tongue.rotation.z = Math.sin(t * 11) * (0.18 + speedN * 0.2 + excited * 0.2) + (expr === 'dizzy' ? Math.sin(t * 5) * 0.5 : 0);
    d.tongue.rotation.x = 0.1 + Math.sin(t * 7) * 0.12 * (0.5 + speedN) - st.furX * 2;
    const mOpen = expr === 'laugh' ? 1.9 : expr === 'shocked' ? 2.2 : expr === 'sad' ? 0.6 : 1;
    d.mouth.scale.y = damp(d.mouth.scale.y, 0.028 * mOpen, 12, dt);
    // fur bounce
    const b = st.furX;
    d.headFur.scale.set(1 - b * 0.35, 1 + b, 1 - b * 0.35);
    d.bodyFur.scale.set(1 - b * 0.4, 1 + b * 1.1, 1 - b * 0.4);
    d.headFur.position.y = b * 0.02;
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function buildCharacter(id: CharacterId): CharacterRig {
  const rig = id === 'lupin' ? buildLupin() : buildHuman(id);
  // drivers are chunky and oversized relative to the kart (poster proportions)
  const outer = new THREE.Group();
  outer.name = rig.root.name;
  rig.root.name += ':scaled';
  rig.root.scale.setScalar(CHAR_SCALE[id]);
  outer.add(rig.root);
  const rndSeed = { dad: 1, mom: 2, brennan: 3, parker: 4, lupin: 5, grandma: 6 }[id] * 7919 + Math.floor(Math.random() * 1000);
  const rnd = seeded(rndSeed);
  const st: AnimState = {
    steer: 0, drift: 0, boost: 0, accel: 0, prevSpeed: 0, reaction: 'none', age: 0,
    w: { hit: 0, item: 0, overtake: 0, jump: 0, win: 0, lose: 0 },
    blinkAt: 1 + rnd() * 3, blinkUntil: 0, wasAirborne: false, furX: 0, furV: 0, earSwing: 0, earSwingV: 0,
    tailPhase: 0, earPhase: 0, expr: 'normal', rnd,
  };
  // initial pose so the rig looks right before the first update
  animate(rig, st, 0, { steer: 0, speed: 0, drifting: false, driftDir: 0, airborne: false, boosting: false, reaction: 'none', reactionTime: 0, time: 0 });
  return {
    id,
    root: outer,
    update(dt: number, s: CharacterAnimState) {
      animate(rig, st, dt, s);
    },
    dispose() {
      disposeTree(outer);
    },
  };
}

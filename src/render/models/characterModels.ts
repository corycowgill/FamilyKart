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
  corneaMat,
  cylinderGeo,
  damp,
  disposeTree,
  fabric,
  glossy,
  glow,
  hairMat,
  lensMat,
  mesh,
  plastic,
  roundedBox,
  seeded,
  skinMat,
  smoothstep,
  wetMat,
} from './materials';
import { FACE, type Expression, type FaceStyle, bandanaTexture, eyeAngles, faceTexture, patchTexture, suitTexture } from './textures';
import { bakeItems, buildClump, curlGeo, dashGeo, gauss, latheGeo, sculptedSphere, tinted, tubeGeo } from './hdGeometry';
import { byLv, Lods, type Lv } from './lod';
import { mergeLodLevels } from './optimize';

export { setModelQuality, getModelQuality, type ModelQuality } from './lod';

/**
 * Procedural cartoon drivers. Every character (including Lupin the dog) is built on the same rig:
 *
 *   root
 *   ├─ pelvis ── spine ── neck ── head ── headShape (skull + face patch + hair + glasses)
 *   │               └─ shoulder anchors          ├─ ponytail pivot / ears / tongue / mouth (animated)
 *   │                                            └─ eye shine (toggled with the expression)
 *   ├─ arms (2-bone IK: upper / lower / hand groups, solved every frame in root space)
 *   └─ wheel (steering wheel, spins with steer; hand grips are children of the rim)
 *
 * so the animation code in `animate()` is shared; per-character extras (ponytail, ears, tail,
 * tongue, fur) hook in through optional fields.
 *
 * Level of detail: each animated node holds one THREE.LOD whose levels are complete static models
 * of that node (high / medium / low, see lod.ts). The animated hierarchy itself is shared.
 */

// ---------------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------------

type HairStyle = 'dad' | 'mom' | 'bro1' | 'bro2' | 'grandma';

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
  bro1: {
    torsoH: 0.36, torsoR: 0.18, sx: 1.16, headR: 0.285, headScale: [1, 0.98, 0.97], neck: 0.05,
    armL1: 0.22, armL2: 0.22, armR: 0.062, handR: 0.078, legR: 0.07,
    skin: '#f3bf98', glove: '#151515', cuff: '#d81e1e', hair: 'bro1', hairColor: '#6a4024', hairColor2: '#865430',
    nose: 0.115,
    face: { ...baseFace, skin: '#f3bf98', iris: '#6b4a2a', brow: '#5a3820', lip: '#b5545a', eyeR: 0.165, eyeSep: 0.31, mouthW: 0.5, browThick: 11 },
    wheelY: 0.27,
  },
  bro2: {
    torsoH: 0.33, torsoR: 0.17, sx: 1.14, headR: 0.285, headScale: [1.02, 0.97, 0.97], neck: 0.045,
    armL1: 0.21, armL2: 0.21, armR: 0.06, handR: 0.076, legR: 0.068,
    skin: '#f6c5a2', glove: '#151515', cuff: '#ffd21f', hair: 'bro2', hairColor: '#ddb258', hairColor2: '#f4da8e',
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

const CHAR_SCALE: Record<CharacterId, number> = { dad: 1.2, mom: 1.18, bro1: 1.2, bro2: 1.2, lupin: 1.22, grandma: 1.18 };

const WHEEL_Z = 0.4;
const WHEEL_R = 0.15;
const WHEEL_TILT = 0.62;

const seg = (lv: Lv, hi: number, med: number, low: number) => byLv(lv, hi, med, low);
function sphereG(w: number, h: number): THREE.BufferGeometry {
  return cachedGeo(`csphere:${w}:${h}`, () => new THREE.SphereGeometry(1, w, h));
}
/** Sphere detail per level from a "high" segment count. */
function sph(lv: Lv, hi: number): THREE.BufferGeometry {
  const w = Math.max(6, Math.round(hi * byLv(lv, 0.85, 0.5, 0.28)));
  return sphereG(w, Math.max(4, Math.round(w * 0.7)));
}
function caps(lv: Lv, r: number, len: number, hiSeg = 20): THREE.BufferGeometry {
  return capsuleGeo(r, len, Math.max(5, Math.round(hiSeg * byLv(lv, 1, 0.5, 0.3))));
}

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
  mouth: THREE.Object3D;
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
  eyeShine?: THREE.Object3D;
  ponytail?: THREE.Group;
  dog?: DogParts;
  pelvisY: number;
  headY: number;
}

/** Point on a sphere of radius r: dphi = horizontal angle from +Z, theta = polar angle from +Y. */
function spherePt(r: number, dphi: number, theta: number): THREE.Vector3 {
  return new THREE.Vector3(r * Math.sin(theta) * Math.sin(dphi), r * Math.cos(theta), r * Math.sin(theta) * Math.cos(dphi));
}

const FACE_PART = { phiStart: Math.PI / 2 - FACE.phiSpan / 2, phiLen: FACE.phiSpan, thetaStart: FACE.theta0, thetaLen: FACE.thetaSpan };

/** Sculpt for a human head: cheeks, brow ridge, soft eye sockets, chin, lips and a tapered jaw. */
function humanBump(f: FaceStyle): (dphi: number, theta: number) => number {
  return (dphi, th) => {
    let b = 0;
    for (const s of [-1, 1]) {
      b += 0.055 * gauss(dphi, th, s * (f.eyeSep + 0.12), f.eyeTheta + 0.36, 0.2, 0.16); // cheeks
      b += 0.022 * gauss(dphi, th, s * f.eyeSep, f.eyeTheta - f.eyeR - 0.11, 0.24, 0.07); // brow ridge
      b -= 0.016 * gauss(dphi, th, s * f.eyeSep, f.eyeTheta + 0.02, f.eyeR * 0.85, f.eyeR * 0.8); // eye sockets
      b -= 0.035 * gauss(dphi, th, s * 1.35, 1.95, 0.4, 0.45); // jaw taper
      b -= 0.02 * gauss(dphi, th, s * 1.15, 1.25, 0.25, 0.3); // temples
    }
    b += 0.04 * gauss(dphi, th, 0, f.mouthTheta + 0.42, 0.26, 0.14); // chin
    b += 0.018 * gauss(dphi, th, 0, f.mouthTheta + 0.03, 0.28, 0.08); // lips
    b += 0.012 * gauss(dphi, th, 0, f.eyeTheta + 0.05, 0.08, 0.2); // nose bridge
    return b;
  };
}

function torsoF(t: number): number {
  if (t < 0.74) return 0.84 + 0.18 * Math.sin((t / 0.74) * Math.PI * 0.5);
  const u = (t - 0.74) / 0.27;
  return Math.max(0.36, 1.02 * Math.sqrt(Math.max(0, 1 - u * u)));
}

function torsoGeo(lv: Lv): THREE.BufferGeometry {
  // unit-height, unit-radius jelly-bean torso; v evenly spaced along height so suit prints are not squashed
  return cachedGeo(`torso:${lv}`, () => {
    const pts: THREE.Vector2[] = [new THREE.Vector2(0.0, 0)];
    const n = seg(lv, 28, 16, 8);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(new THREE.Vector2(torsoF(t), t));
    }
    pts.push(new THREE.Vector2(0.0, 1.0));
    const g = new THREE.LatheGeometry(pts, seg(lv, 44, 24, 12));
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
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 2 });
    g.center();
    return g;
  });
}

function makeStars(y: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'stars';
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

function makeSteeringWheel(lods: Lods, root: THREE.Group, y: number, accent: string, rimColor = '#202024'): { spin: THREE.Group; grips: THREE.Object3D[] } {
  const mount = new THREE.Group();
  mount.name = 'wheel-mount';
  mount.position.set(0, y, WHEEL_Z);
  mount.rotation.x = WHEEL_TILT;
  root.add(mount);
  const spin = new THREE.Group();
  spin.name = 'wheel-spin';
  mount.add(spin);
  const rimMat = glossy(rimColor, 0.45);
  const gripMat = fabric(accent, 0.7);
  const hubMat = glossy(accent, 0.3);
  lods.each(spin, (g, lv) => {
    const rimGeo = cachedGeo(`wheelrim:${lv}`, () => new THREE.TorusGeometry(WHEEL_R, 0.024, seg(lv, 10, 7, 5), seg(lv, 44, 22, 12)));
    g.add(mesh(rimGeo, rimMat));
    // coloured grip sleeves (ridged on high)
    const gripGeo = cachedGeo(`wheelgrip:${lv}`, () => {
      const t = new THREE.TorusGeometry(WHEEL_R, 0.03, seg(lv, 10, 7, 5), seg(lv, 20, 8, 4), 0.7);
      if (lv === 0) {
        const p = t.attributes.position;
        const v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i);
          const a = Math.atan2(v.y, v.x);
          const c = new THREE.Vector3(Math.cos(a) * WHEEL_R, Math.sin(a) * WHEEL_R, 0);
          const d = v.clone().sub(c);
          d.multiplyScalar(1 + 0.12 * Math.max(0, Math.sin(a * 60)));
          p.setXYZ(i, c.x + d.x, c.y + d.y, c.z + d.z);
        }
        t.computeVertexNormals();
      }
      return t;
    });
    for (const s of [1, -1]) {
      const gm = mesh(gripGeo, gripMat);
      gm.rotation.z = s > 0 ? 0.1 : Math.PI - 0.8;
      g.add(gm);
    }
    const hub = mesh(
      lv === 2 ? cylinderGeo(0.055, 0.055, 0.05, 10) : latheGeo('wheelhub', [[0, 0.035], [0.03, 0.034], [0.05, 0.028], [0.06, 0.012], [0.062, -0.02], [0, -0.02]], seg(lv, 32, 16, 8)),
      hubMat,
    );
    hub.rotation.x = Math.PI / 2;
    g.add(hub);
    const spokeGeo = roundedBox(0.03, WHEEL_R, 0.02, 0.008, 1);
    for (const a of [0.2, Math.PI - 0.2, -Math.PI / 2]) {
      const sp = mesh(spokeGeo, rimMat);
      sp.position.set(Math.cos(a) * WHEEL_R * 0.5, Math.sin(a) * WHEEL_R * 0.5, 0);
      sp.rotation.z = a - Math.PI / 2;
      g.add(sp);
    }
  });
  // column into the dash (local +Z points forward/down)
  lods.each(mount, (g, lv) => {
    const col = mesh(cylinderGeo(0.022, 0.028, 0.34, seg(lv, 16, 10, 6)), plastic('#3a3a40', 0.4, 0.6));
    col.rotation.x = Math.PI / 2;
    col.position.z = 0.17;
    g.add(col);
    if (lv !== 2) {
      const boot = mesh(cylinderGeo(0.03, 0.05, 0.08, seg(lv, 20, 10, 6)), plastic('#3a3a40', 0.4, 0.6));
      boot.rotation.x = Math.PI / 2;
      boot.position.z = 0.3;
      g.add(boot);
    }
  });
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

/** Capsule-ish segment between two points inside a hand/limb frame. */
function boneSeg(g: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, lv: Lv, hiSeg = 12): void {
  const grp = new THREE.Group();
  const len = alignY(grp, a, b);
  grp.add(mesh(caps(lv, r, len, hiSeg), mat));
  g.add(grp);
}

function buildGlove(g: THREE.Group, lv: Lv, h: number, side: number, glove: THREE.Material, cuff: THREE.Material, r: number, _accent: THREE.Material): void {
  // flared cuff with a contrasting band
  const cuffM = mesh(
    lv === 2 ? cylinderGeo(r * 1.35, r * 1.05, h * 0.7, 8) : latheGeo(`gcuff:${r}:${h}`, [[r * 1.02, -h * 0.35], [r * 1.12, -h * 0.25], [r * 1.38, h * 0.3], [r * 1.3, h * 0.36], [r * 0.9, h * 0.34]], seg(lv, 28, 14, 8)),
    cuff,
  );
  cuffM.position.y = -h * 0.25;
  g.add(cuffM);
  if (lv === 0) {
    const band = mesh(cachedGeo(`gband:${r}`, () => new THREE.TorusGeometry(r * 1.22, r * 0.09, 6, 28)), cuff, false);
    band.rotation.x = Math.PI / 2;
    band.position.y = -h * 0.2;
    g.add(band);
  }
  const palm = mesh(sph(lv, 28), glove);
  palm.scale.set(h * 1.0, h * 1.05, h * 0.8);
  palm.position.y = h * 0.75;
  g.add(palm);
  if (lv === 0) {
    // four curled fingers (two phalanges each) wrapping the rim + thumb
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * h * 0.36;
      const l = i === 1 || i === 2 ? 1.06 : i === 3 ? 0.86 : 0.96;
      const fr = h * (i === 3 ? 0.2 : 0.23);
      const k0 = new THREE.Vector3(x, h * 1.3, h * 0.1);
      const k1 = new THREE.Vector3(x * 1.02, h * (1.32 + 0.22 * l), h * (0.48 * l));
      const k2 = new THREE.Vector3(x * 1.02, h * (1.12 + 0.1 * l), h * (0.82 * l));
      boneSeg(g, k0, k1, fr, glove, lv, 7);
      boneSeg(g, k1, k2, fr * 0.94, glove, lv, 7);
    }
    boneSeg(g, new THREE.Vector3(-side * h * 0.45, h * 0.62, h * 0.38), new THREE.Vector3(-side * h * 0.28, h * 1.02, h * 0.8), h * 0.25, glove, lv);
    // knuckle seam stitching
    g.add(mesh(dashGeo(`knuckle:${h}`, [new THREE.Vector3(-h * 0.6, h * 1.12, -h * 0.55), new THREE.Vector3(0, h * 1.22, -h * 0.62), new THREE.Vector3(h * 0.6, h * 1.12, -h * 0.55)], h * 0.12, h * 0.08, h * 0.035), cuff, false));
  } else if (lv === 1) {
    const fingers = mesh(caps(lv, h * 0.42, h * 1.2), glove);
    fingers.rotation.z = Math.PI / 2;
    fingers.position.set(h * 0.6, h * 1.25, h * 0.3);
    g.add(fingers);
    const thumb = mesh(caps(lv, h * 0.3, h * 0.55), glove);
    thumb.position.set(0, h * 0.6, h * 0.55);
    thumb.rotation.x = 0.9;
    g.add(thumb);
  } else {
    const thumb = mesh(sph(lv, 10), glove);
    thumb.scale.setScalar(h * 0.4);
    thumb.position.set(0, h * 1.0, h * 0.55);
    g.add(thumb);
  }
}

function buildArm(
  lods: Lods,
  root: THREE.Group,
  side: number,
  shoulder: THREE.Object3D,
  o: { l1: number; l2: number; r: number; handR: number; sleeve: THREE.Material; glove: THREE.Material; cuff: THREE.Material; accent: THREE.Material; paw?: boolean; fur?: (g: THREE.Group, lv: Lv, part: 'upper' | 'lower' | 'hand') => void },
): Arm {
  const upper = new THREE.Group();
  upper.name = 'arm-upper';
  const lower = new THREE.Group();
  lower.name = 'arm-lower';
  const hand = new THREE.Group();
  hand.name = 'hand';
  lods.each(upper, (g, lv) => {
    g.add(mesh(caps(lv, o.r, o.l1, 22), o.sleeve));
    if (lv === 0 && !o.paw) {
      // shoulder seam piping
      const seam = mesh(cachedGeo(`armseam:${o.r}`, () => new THREE.TorusGeometry(o.r * 1.01, o.r * 0.07, 6, 28)), o.accent, false);
      seam.rotation.x = Math.PI / 2;
      seam.position.y = o.l1 * 0.12;
      g.add(seam);
    }
    o.fur?.(g, lv, 'upper');
  });
  lods.each(lower, (g, lv) => {
    g.add(mesh(caps(lv, o.r * 0.9, o.l2, 22), o.sleeve));
    if (lv !== 2 && !o.paw) {
      // racing stripe band near the wrist
      const band = mesh(cachedGeo(`armband:${o.r}:${lv}`, () => new THREE.TorusGeometry(o.r * 0.92, o.r * 0.12, seg(lv, 6, 4, 3), seg(lv, 28, 14, 8))), o.accent, false);
      band.rotation.x = Math.PI / 2;
      band.position.y = o.l2 * 0.78;
      g.add(band);
    }
    o.fur?.(g, lv, 'lower');
  });
  lods.each(hand, (g, lv) => {
    if (o.paw) {
      const paw = mesh(sph(lv, 28), o.glove);
      paw.scale.set(o.handR * 1.05, o.handR * 0.95, o.handR * 1.05);
      paw.position.y = o.handR * 0.3;
      g.add(paw);
      // toe bumps (+ pads on high)
      for (let i = -1; i <= 1; i++) {
        const toe = mesh(sph(lv, 16), o.glove);
        toe.scale.setScalar(o.handR * 0.34);
        toe.position.set(i * o.handR * 0.45, o.handR * 1.0, o.handR * 0.4);
        g.add(toe);
      }
      o.fur?.(g, lv, 'hand');
    } else buildGlove(g, lv, o.handR, side, o.glove, o.cuff, o.r, o.accent);
  });
  root.add(upper, lower, hand);
  return { side, shoulder, upper, lower, hand, l1: o.l1, l2: o.l2 };
}

// ---------------------------------------------------------------------------------------------
// Glasses
// ---------------------------------------------------------------------------------------------

function ringGeo(style: 'rect' | 'soft' | 'round', hw: number, hh: number, lv: Lv): THREE.BufferGeometry {
  return cachedGeo(`glassring:${style}:${hw}:${hh}:${lv}`, () => {
    const t = style === 'rect' ? 0.013 : 0.01;
    const outer = new THREE.Shape();
    const inner = new THREE.Path();
    if (style === 'round') {
      outer.absarc(0, 0, hw + t, 0, Math.PI * 2, false);
      inner.absarc(0, 0, hw, 0, Math.PI * 2, true);
    } else {
      const rr = style === 'rect' ? 0.014 : hh * 0.75;
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
    const g = new THREE.ExtrudeGeometry(outer, {
      depth: 0.012, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.004, bevelSegments: seg(lv, 3, 1, 1),
      curveSegments: style === 'round' ? seg(lv, 40, 16, 8) : seg(lv, 8, 3, 2),
    });
    g.translate(0, 0, -0.006);
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    return g;
  });
}

function lensGeo(st: 'rect' | 'soft' | 'round', hw: number, hh: number, lv: Lv): THREE.BufferGeometry {
  return cachedGeo(`lens:${st}:${hw}:${hh}:${lv}`, () => {
    // gently domed lens
    const g = st === 'round' ? new THREE.CircleGeometry(hw, seg(lv, 32, 16, 8)) : new THREE.PlaneGeometry(hw * 2, hh * 2, seg(lv, 6, 2, 1), seg(lv, 4, 2, 1));
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / hw;
      const y = p.getY(i) / hh;
      p.setZ(i, 0.006 * (1 - Math.min(1, x * x * 0.6 + y * y * 0.6)));
    }
    g.computeVertexNormals();
    return g;
  });
}

function buildGlasses(head: THREE.Object3D, sp: HumanSpec, lv: Lv, bump: (d: number, t: number) => number): void {
  if (!sp.glasses) return;
  const r = sp.headR;
  const st = sp.glasses.style;
  const k = r / 0.27;
  const hw = +((st === 'round' ? 0.052 : st === 'rect' ? 0.064 : 0.058) * k).toFixed(4);
  const hh = +((st === 'round' ? 0.052 : st === 'rect' ? 0.043 : 0.045) * k).toFixed(4);
  const frame = glossy(sp.glasses.color, 0.25);
  const g = new THREE.Group();
  head.add(g);
  const eyes = eyeAngles(sp.face);
  const lensPos: THREE.Vector3[] = [];
  for (const [dphi, theta] of eyes) {
    const p = spherePt(r * (1.08 + bump(dphi * 0.88, theta) * 0.6), dphi * 0.88, theta + 0.01);
    lensPos.push(p);
    const ring = mesh(ringGeo(st, hw, hh, lv), frame, false);
    ring.position.copy(p);
    ring.rotation.y = dphi * 0.55;
    g.add(ring);
    if (lv !== 2) {
      const lens = new THREE.Mesh(lensGeo(st, hw, hh, lv), lensMat());
      lens.position.copy(p);
      lens.rotation.y = dphi * 0.55;
      lens.renderOrder = 2;
      g.add(lens);
    }
    // temple arm back to the ear (tapered), with a hinge block on high
    const side = Math.sign(dphi);
    const a = p.clone().add(new THREE.Vector3(side * hw * 0.95, hh * 0.4, -0.01));
    const b = new THREE.Vector3(side * r * 1.0, a.y - 0.01, -r * 0.3);
    const arm = new THREE.Group();
    const len = alignY(arm, a, b);
    const am = mesh(cylinderGeo(0.0055, 0.008, 1, seg(lv, 10, 6, 4)), frame, false);
    am.position.y = len / 2;
    am.scale.y = len;
    arm.add(am);
    g.add(arm);
    if (lv === 0) {
      const hinge = mesh(roundedBox(0.016, 0.02, 0.018, 0.005, 2), frame, false);
      hinge.position.copy(a);
      g.add(hinge);
      // nose pad
      const pad = mesh(sphereG(10, 8), lensMat(), false);
      pad.scale.set(0.006, 0.012, 0.004);
      pad.position.copy(p).add(new THREE.Vector3(-side * hw * 0.9, -hh * 0.5, -0.012));
      g.add(pad);
    }
  }
  // bridge (arched on high)
  const l = lensPos[0];
  const rr = lensPos[1];
  const a = new THREE.Vector3(l.x + hw * 0.9, l.y + hh * 0.3, l.z);
  const b = new THREE.Vector3(rr.x - hw * 0.9, rr.y + hh * 0.3, rr.z);
  if (lv === 0) {
    const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, hh * 0.25, 0.012));
    g.add(mesh(tubeGeo(`bridge:${sp.hair}`, [a, mid, b], 0.0065, 16, 8), frame, false));
  } else {
    const bridge = new THREE.Group();
    const len = alignY(bridge, a, b);
    const bm = mesh(cylinderGeo(0.008, 0.008, 1, 6), frame, false);
    bm.position.y = len / 2;
    bridge.add(bm);
    bm.scale.y = len;
    bridge.position.z += 0.012;
    g.add(bridge);
  }
}


// ---------------------------------------------------------------------------------------------
// Hair & fur clumps
// ---------------------------------------------------------------------------------------------

interface Clump {
  p: THREE.Vector3; // root
  n: THREE.Vector3; // surface normal at the root
  dir: THREE.Vector3; // where the clump goes (projected to the surface tangent by `lie`)
  len: number;
  wid: number;
  c: string;
  lie?: number; // 1 = flat along the surface, 0 = straight along dir
  twist?: number;
  bend?: number;
}

/**
 * All clumps of one part baked into a single vertex-coloured mesh (one draw call; merges with the
 * hair cap). Each clump keeps its exact length / width / curl. Cached per `key`.
 * `bendOf` returns the wanted tip curl in units of the clump's half-width.
 */
function clumpMeshes(key: string, list: Clump[], lv: Lv, bendOf: (c: Clump) => number, mat: THREE.Material, fur = false): THREE.Mesh {
  const radial = fur ? seg(lv, 5, 4, 3) : seg(lv, 5, 4, 4);
  const rings = fur ? seg(lv, 6, 3, 2) : seg(lv, 7, 4, 3);
  const geo = bakeItems(`clumps:${key}:${lv}`, () => {
    const rnd = seeded(key.length * 13 + lv);
    return list.map((c) => {
      const n = c.n.clone().normalize();
      const lie = c.lie ?? 0.85;
      const tangential = c.dir.clone().addScaledVector(n, -c.dir.dot(n));
      const d = tangential.lengthSq() > 1e-6 ? tangential.normalize() : new THREE.Vector3(0, -1, 0);
      const dir = c.dir.clone().normalize().lerp(d, lie).normalize();
      const y = dir.clone().negate();
      const z = n.clone().addScaledVector(dir, -n.dot(dir));
      if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
      z.normalize();
      const x = new THREE.Vector3().crossVectors(y, z).normalize();
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.twist ?? (rnd() - 0.5) * 0.5));
      const bend = c.bend ?? bendOf(c);
      const g = buildClump(radial, rings, bend, fur ? 0.7 : 0.5, c.len / c.wid, fur ? 0.45 : 0.4, fur ? 0.5 + rnd() * 0.5 : 0);
      return { geo: g, matrix: new THREE.Matrix4().compose(c.p, q, new THREE.Vector3(c.wid, c.wid, c.wid)), color: new THREE.Color(c.c) };
    });
  });
  const m = mesh(geo, mat);
  m.name = 'clumps';
  return m;
}

/** Hair cap with baked vertex colours: soft streaks between the two hair tones (+ optional grey temples). */
function hairCapVC(key: string, theta: number, tilt: number, c1: string, c2: string, greySides: boolean, lv: Lv): THREE.BufferGeometry {
  return cachedGeo(`hcap:${key}:${theta}:${tilt}:${lv}`, () => {
    const g = new THREE.SphereGeometry(1, seg(lv, 64, 32, 16), seg(lv, 28, 14, 8), 0, Math.PI * 2, 0, theta).rotateX(-tilt);
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
        gw = Math.max(gw, smoothstep(-0.55, -0.85, z) * smoothstep(0.1, -0.25, y) * 0.4);
        w = clamp((gw + (rnd() - 0.5) * 0.3 * gw) * 0.75 + w * 0.25, 0, 1);
      }
      c.copy(a).lerp(b, w).multiplyScalar(0.85);
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    return g;
  });
}

function shadeHex(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  if (f < 1) c.multiplyScalar(f);
  else c.lerp(new THREE.Color('#ffffff'), f - 1);
  return `#${c.getHexString()}`;
}

/** Keep `keep` fraction of a list (deterministically spread) for lower LODs. */
function thin<T>(arr: T[], keep: number): T[] {
  if (keep >= 1) return arr;
  const out: T[] = [];
  let acc = 0;
  for (const a of arr) {
    acc += keep;
    if (acc >= 1) {
      acc -= 1;
      out.push(a);
    }
  }
  return out;
}

function hairMaterial(sp: HumanSpec): THREE.MeshPhysicalMaterial {
  return hairMat(sp.hair, sp.hair === 'grandma' ? 0.7 : 0.5, new THREE.Color(sp.hairColor2).lerp(new THREE.Color('#ffffff'), 0.25).getStyle(), sp.hair === 'grandma' ? 0.6 : 0.4);
}

function buildHair(head: THREE.Group, sp: HumanSpec, lv: Lv, rig: Partial<Rig>, lods: Lods, ponytailOwner: THREE.Group): void {
  const r = sp.headR;
  const hm = hairMaterial(sp);
  const cap = (theta: number, tilt: number, scale: number, greySides = false) => {
    const m = mesh(hairCapVC(sp.hair, theta, tilt, sp.hairColor, sp.hairColor2, greySides, lv), hm);
    m.scale.setScalar(r * scale);
    head.add(m);
    return m;
  };
  const rnd = seeded(sp.hair.length * 97 + 13 + lv * 7);
  const tone = (a: string, b: string, k = rnd()) => shadeHex(new THREE.Color(a).lerp(new THREE.Color(b), k).getStyle(), 0.86 + rnd() * 0.2);
  /** clump rooted on the scalp at (dphi, theta), flowing along `flow` (head space) */
  const on = (dphi: number, theta: number, len: number, wid: number, flow: THREE.Vector3, c: string, lie = 0.85, push = 1.02): Clump => {
    const n = spherePt(1, dphi, theta);
    return { p: n.clone().multiplyScalar(r * push), n, dir: flow.clone(), len: r * len, wid: r * wid, c, lie };
  };
  const keep = byLv(lv, 1, 0.38, 0);
  let part = 0;
  const add = (list: Clump[], bendOf: (c: Clump) => number) => {
    const l = thin(list, keep);
    for (const c of l) c.bend = bendOf(c);
    if (l.length) head.add(clumpMeshes(`${sp.hair}:${part++}`, l, lv, bendOf, hm));
  };
  // hug the scalp: tip offset ~ len^2 / (2 r) relative to width
  const hug = (k = 1) => (c: Clump) => (k * (c.len * c.len)) / (2 * r * 1.05 * c.wid);
  /**
   * Rows of overlapping clumps over the scalp (front hairline -> nape). `cover(dphi, theta)` says
   * whether a spot has hair, `flow` gives the combing direction, `style` tweaks each clump.
   */
  const rows = (o: {
    t0: number; t1: number; step: number; cover: (dphi: number, theta: number) => boolean; flow: (dphi: number, theta: number) => THREE.Vector3;
    len: number; wid: number; color: (dphi: number, theta: number) => string; lie?: number; jitter?: number;
  }): Clump[] => {
    const out: Clump[] = [];
    let row = 0;
    for (let th = o.t0; th <= o.t1; th += o.step, row++) {
      const n = Math.max(1, Math.round((Math.PI * 2 * Math.sin(th)) / o.step));
      for (let i = 0; i < n; i++) {
        const dphi = ((i + (row % 2) * 0.5) / n) * Math.PI * 2 - Math.PI + (rnd() - 0.5) * o.step * 0.5;
        const t = th + (rnd() - 0.5) * o.step * (o.jitter ?? 0.4);
        if (!o.cover(dphi, t)) continue;
        out.push(on(dphi, t, o.len * (0.85 + rnd() * 0.3), o.wid * (0.85 + rnd() * 0.3), o.flow(dphi, t), o.color(dphi, t), o.lie ?? 0.92, 1.0));
      }
    }
    return out;
  };
  const back = (k = 0.15) => (dphi: number) => new THREE.Vector3(Math.sin(dphi) * 0.25, k, -1);
  switch (sp.hair) {
    case 'dad': {
      cap(1.5, 0.52, 1.03, true);
      // short, neatly combed back; grey only at the temples / above the ears
      const list = rows({
        t0: 0.7, t1: 2.0, step: 0.2, len: 0.6, wid: 0.16,
        cover: (d, t) => (Math.cos(d) > 0.3 ? t < 1.0 + (1 - Math.cos(d)) * 0.9 : t < 1.95 - Math.max(0, Math.cos(d)) * 0.3) && !(Math.abs(Math.abs(d) - 1.57) < 0.35 && t > 1.45),
        flow: (d, t) => (t > 1.2 ? new THREE.Vector3(Math.sin(d) * 0.2, -0.7, -1) : back(0.1)(d)),
        color: (d, t) => {
          const ad = Math.abs(d);
          const g = smoothstep(1.0, 1.35, t) * smoothstep(0.75, 1.1, ad) * (1 - smoothstep(1.8, 2.3, ad));
          return new THREE.Color(tone(sp.hairColor, '#4e3a2b')).lerp(new THREE.Color(tone(sp.hairColor2, '#d2cdc5')), clamp(g * (0.8 + rnd() * 0.4), 0, 1)).getStyle();
        },
        lie: 0.96,
      });
      add(list, hug(1.0));
      // soft quiff: the front rows lift a little before sweeping back
      const quiff: Clump[] = [];
      for (const [th, n, l] of [[0.6, 11, 0.7], [0.48, 9, 0.62]] as Array<[number, number, number]>) {
        for (let i = 0; i < n; i++) {
          const d = (i / (n - 1) - 0.5) * 1.5 + (rnd() - 0.5) * 0.05;
          quiff.push(on(d, th + Math.abs(d) * 0.1, l, 0.19, new THREE.Vector3(d * 0.15, 0.12, -1), tone(sp.hairColor, '#5c4636'), 0.88, 1.02));
        }
      }
      add(quiff, hug(0.75));
      if (lv !== 0) {
        // smooth quiff volume (instead of many clumps)
        const q = mesh(tinted(`quiff:${lv}`, sph(lv, 24), sp.hairColor), hm);
        q.position.copy(spherePt(r * 0.86, 0, 0.62));
        q.scale.set(r * 0.72, r * 0.34, r * 0.55);
        q.rotation.x = -0.35;
        head.add(q);
      }
      break;
    }
    case 'mom': {
      cap(1.62, 0.66, 1.03);
      const tie = new THREE.Vector3(0, r * 0.4, -r * 0.95);
      // everything combed towards the ponytail tie, face kept clear
      const list = rows({
        t0: 0.5, t1: 1.9, step: 0.19, len: 0.95, wid: 0.17,
        cover: (d, t) => (Math.cos(d) > 0.45 ? t < 0.82 : t < 1.85) && !(Math.cos(d) < -0.6 && t < 0.9),
        flow: (d, t) => tie.clone().sub(spherePt(r, d, t)),
        color: () => tone(sp.hairColor, sp.hairColor2),
      });
      // side-swept fringe from the part (character's right) across the forehead
      for (let i = 0; i < 9; i++) {
        const dphi = -0.42 + i * 0.1;
        list.push(on(dphi, 0.55 + (i % 2) * 0.05, 0.75 - i * 0.02, 0.24, new THREE.Vector3(1, -0.4, 0.2), tone(sp.hairColor, sp.hairColor2, 0.3 + rnd() * 0.5), 0.92, 1.03));
      }
      add(list, hug(1.0));
      if (lv !== 0) {
        const sw = mesh(tinted(`momsw:${lv}`, sph(lv, 24), sp.hairColor), hm);
        sw.position.copy(spherePt(r * 0.84, -0.25, 0.72));
        sw.scale.set(r * 0.66, r * 0.24, r * 0.48);
        sw.rotation.set(-0.3, -0.2, 0.25);
        head.add(sw);
      }
      // ponytail pivot (animated, shared) is created once; its levels are filled per level here
      if (!rig.ponytail) {
        const pivot = new THREE.Group();
        pivot.name = 'ponytail';
        pivot.position.set(0, r * 0.4, -r * 0.92);
        ponytailOwner.add(pivot);
        rig.ponytail = pivot;
      }
      const pl = lods.slot(rig.ponytail).get(lv)!;
      const tieM = mesh(tinted(`hairtie:${lv}`, cachedGeo(`hairtie:${lv}`, () => new THREE.TorusGeometry(0.05, 0.022, seg(lv, 10, 6, 4), seg(lv, 28, 14, 8))), '#e84fb0'), hm);
      tieM.rotation.x = 0.5;
      pl.add(tieM);
      const segs: Array<[number, number, number, number]> = [
        [0, -0.03, -0.08, 0.09],
        [0, -0.13, -0.13, 0.1],
        [0, -0.24, -0.14, 0.09],
        [0, -0.34, -0.11, 0.07],
        [0, -0.42, -0.07, 0.045],
      ];
      const coreScale = lv === 0 ? 0.78 : 1;
      segs.forEach(([x, y, z, rr], i) => {
        const b = mesh(tinted(`ponycore:${lv}:${i % 2}`, sph(lv, 20), i % 2 ? sp.hairColor2 : sp.hairColor), hm);
        b.position.set(x, y, z);
        b.scale.set(rr * coreScale, rr * 1.35 * coreScale, rr * coreScale);
        pl.add(b);
      });
      if (lv !== 2) {
        const tail: Clump[] = [];
        const n = lv === 0 ? 34 : 12;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
          const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a) * 0.8);
          const p = new THREE.Vector3(out.x * 0.035, -0.02, -0.06 + out.z * 0.035);
          const dir = new THREE.Vector3(out.x * 0.25, -1, -0.45 + out.z * 0.2);
          tail.push({ p, n: out, dir, len: 0.36 + rnd() * 0.12, wid: 0.05 + rnd() * 0.015, c: tone(sp.hairColor, sp.hairColor2), lie: 0.2 });
        }
        pl.add(clumpMeshes('ponytail', tail, lv, () => 0.3, hm));
      }
      break;
    }
    case 'bro1': {
      cap(1.45, 0.5, 1.03);
      // short tousled crop combed back, slightly lifted
      const list = rows({
        t0: 0.75, t1: 1.9, step: 0.2, len: 0.6, wid: 0.17,
        cover: (d, t) => (Math.cos(d) > 0.3 ? t < 1.0 + (1 - Math.cos(d)) * 0.9 : t < 1.85 - Math.max(0, Math.cos(d)) * 0.3),
        flow: (d, t) => (t > 1.25 ? new THREE.Vector3(Math.sin(d) * 0.2, -0.8, -1) : back(0.25)(d)),
        color: () => tone(sp.hairColor, sp.hairColor2),
        lie: 0.88,
      });
      add(list, (c) => (rnd() > 0.8 ? -0.3 : hug(0.9)(c)));
      // messy fringe pushed forward / up at the hairline + a crown swirl
      const fringe: Clump[] = [];
      for (let i = -5; i <= 5; i++) {
        fringe.push(on(i * 0.14, 0.58 + Math.abs(i) * 0.03, 0.5 + rnd() * 0.12, 0.19, new THREE.Vector3(i * 0.15, 0.55, 0.7), tone(sp.hairColor, sp.hairColor2), 0.7, 1.02));
      }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        fringe.push(on(Math.PI + Math.sin(a) * 0.35, 0.5 + Math.cos(a) * 0.12, 0.5, 0.17, new THREE.Vector3(Math.cos(a), 0.2, Math.sin(a)), tone(sp.hairColor, sp.hairColor2), 0.9, 1.02));
      }
      add(fringe, () => -0.2);
      break;
    }
    case 'bro2': {
      cap(1.5, 0.45, 1.03);
      // messy, wind-swept blond hair: longer clumps, varied flow, some tips flicking out
      const list = rows({
        t0: 0.55, t1: 1.9, step: 0.2, len: 0.85, wid: 0.18, jitter: 0.8,
        cover: (d, t) => (Math.cos(d) > 0.4 ? t < 0.95 : t < 1.85),
        flow: () => new THREE.Vector3(0.45 + (rnd() - 0.5) * 0.9, 0.2 + rnd() * 0.5, -1),
        color: () => tone(sp.hairColor, sp.hairColor2),
        lie: 0.8,
      });
      add(list, (c) => (rnd() > 0.75 ? -0.45 : hug(0.85)(c)));
      // big floppy fringe swept across the forehead
      const fringe: Clump[] = [];
      for (let i = -4; i <= 4; i++) {
        fringe.push(on(i * 0.16, 0.6 + (i % 2) * 0.05, 0.7, 0.24, new THREE.Vector3(0.8, -0.15, 0.6), tone(sp.hairColor, sp.hairColor2), 0.8, 1.02));
      }
      add(fringe, () => 0.6);
      break;
    }
    case 'grandma': {
      cap(1.4, 0.36, 1.03);
      // tight perm curls covering the cap (fibonacci spread)
      const n = byLv(lv, 88, 46, 30);
      const pts: Array<{ p: THREE.Vector3; n: THREE.Vector3; s: number; c: string }> = [];
      for (let i = 0; i < n; i++) {
        const y = 1 - (i + 0.5) / n;
        const theta = Math.acos(y) * 1.12;
        const dphi = i * 2.39996;
        const front = Math.cos(dphi) * Math.sin(theta);
        const lim = front > 0.35 ? 0.95 : front > 0 ? 1.45 : 1.95;
        if (theta > lim) continue;
        const nn = spherePt(1, dphi, theta);
        const sz = r * (0.16 + rnd() * 0.05) * (lv === 0 ? 1 : lv === 1 ? 1.25 : 1.5);
        pts.push({ p: nn.clone().multiplyScalar(r * 1.06), n: nn, s: sz, c: rnd() > 0.5 ? sp.hairColor : rnd() > 0.5 ? sp.hairColor2 : '#f2f2f6' });
      }
      const geo = lv === 2 ? sph(lv, 12) : lv === 1 ? curlGeo(9, 6) : curlGeo(13, 9);
      const zAxis = new THREE.Vector3(0, 0, 1);
      const spins = pts.map(() => rnd() * Math.PI * 2);
      const baked = bakeItems(`curls:${lv}`, () =>
        pts.map((pt, i) => {
          const q = new THREE.Quaternion().setFromUnitVectors(zAxis, pt.n);
          q.multiply(new THREE.Quaternion().setFromAxisAngle(zAxis, spins[i]));
          return { geo, matrix: new THREE.Matrix4().compose(pt.p, q, new THREE.Vector3(pt.s, pt.s, pt.s * (lv === 2 ? 1 : 0.9))), color: new THREE.Color(pt.c) };
        }),
      );
      head.add(mesh(baked, hm));
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Human builder
// ---------------------------------------------------------------------------------------------

function newFaceMat(id: CharacterId, face: FaceStyle): { mat: THREE.MeshStandardMaterial; get: (e: Expression) => THREE.Texture | null } {
  const tex = faceTexture(id, face, 'normal');
  // per-rig instance: the expression system swaps `map` on it
  const warm = new THREE.Color(face.skin).lerp(new THREE.Color('#ff5a3c'), 0.5);
  const mat = new THREE.MeshPhysicalMaterial({
    color: tex ? '#ffffff' : face.skin, map: tex, roughness: 0.55, sheen: face.dog ? 0.6 : 0.35, sheenRoughness: 0.5,
    sheenColor: face.dog ? new THREE.Color('#fff4e0') : warm, specularIntensity: 0.6,
    emissive: new THREE.Color(face.skin).multiply(new THREE.Color('#ff7050')), emissiveIntensity: face.dog ? 0 : 0.07,
  });
  return { mat, get: (e) => faceTexture(id, face, e) };
}

/** Additive cornea gloss over each painted eye (hidden while the eyes are shut). */
function buildEyeShine(g: THREE.Group, lv: Lv, f: FaceStyle, r: number, bump: (d: number, t: number) => number): void {
  if (lv === 2) return;
  for (const [dphi, theta] of eyeAngles(f)) {
    const surf = r * (1 + bump(dphi, theta));
    const n = spherePt(1, dphi, theta);
    const ry = f.eyeR * r * 1.05;
    const rx = ry * (f.dog ? 1 : 0.88);
    const m = mesh(sph(lv, 22), corneaMat(), false);
    m.scale.set(rx, ry, ry * 0.42);
    m.position.copy(n.clone().multiplyScalar(surf - ry * 0.18));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.renderOrder = 3;
    g.add(m);
  }
}

function buildHuman(id: Exclude<CharacterId, 'lupin'>, lods: Lods): Rig {
  const sp = SPECS[id];
  const def = characterById(id);
  const root = new THREE.Group();
  root.name = `character:${id}`;
  const suitTex = suitTexture(id, def.colors.suit, def.colors.suitAccent);
  const suitPrint = fabric(def.colors.suit, 0.72, suitTex, `print:${id}`);
  const suit = fabric(def.colors.suit, 0.75);
  const accent = fabric(def.colors.suitAccent, 0.65);
  const skin = skinMat(sp.skin);
  const glove = id === 'grandma' ? fabric(sp.glove, 0.7) : glossy(sp.glove, 0.45);
  const cuff = fabric(sp.cuff, 0.65);
  const bump = humanBump(sp.face);

  const pelvis = new THREE.Group();
  pelvis.name = 'pelvis';
  root.add(pelvis);
  lods.each(pelvis, (g, lv) => {
    const hips = mesh(sph(lv, 28), suit);
    hips.scale.set(sp.torsoR * sp.sx * 0.95, 0.12, sp.torsoR * 0.95);
    hips.position.y = 0.04;
    g.add(hips);
    // thighs + shins (mostly hidden under the dash, but they ground the pose) + sneakers
    for (const s of [-1, 1]) {
      const a = new THREE.Vector3(s * sp.torsoR * 0.55, 0.05, 0.02);
      const k = new THREE.Vector3(s * sp.torsoR * 0.65, 0.12, 0.4);
      const f = new THREE.Vector3(s * sp.torsoR * 0.7, -0.12, 0.6);
      if (lv === 2) continue; // legs are hidden under the dash from any distance
      boneSeg(g, a, k, sp.legR, suit, lv, 18);
      boneSeg(g, k, f, sp.legR * 0.85, suit, lv, 18);
      const shoe = mesh(sph(lv, 18), fabric('#f4f4f2', 0.6));
      shoe.scale.set(sp.legR * 1.1, sp.legR * 0.8, sp.legR * 1.7);
      shoe.position.copy(f).add(new THREE.Vector3(0, -0.02, 0.06));
      g.add(shoe);
      const sole = mesh(sph(lv, 16), accent);
      sole.scale.set(sp.legR * 1.15, sp.legR * 0.35, sp.legR * 1.75);
      sole.position.copy(f).add(new THREE.Vector3(0, -0.06, 0.06));
      g.add(sole);
    }
    if (lv !== 2) {
      // belt band at the waist
      const belt = mesh(cachedGeo(`belt:${lv}`, () => new THREE.TorusGeometry(1, 0.09, seg(lv, 8, 5, 4), seg(lv, 48, 20, 10))), accent);
      belt.scale.set(sp.torsoR * sp.sx * 0.86, sp.torsoR * 0.86, sp.torsoR * 0.75);
      belt.rotation.x = Math.PI / 2;
      belt.position.y = 0.1;
      g.add(belt);
    }
  });

  const spine = new THREE.Group();
  spine.name = 'spine';
  spine.position.y = 0.02;
  pelvis.add(spine);
  const shoulderPos: THREE.Vector3[] = [];
  for (const s of [1, -1]) shoulderPos.push(new THREE.Vector3(s * sp.torsoR * sp.sx * 0.86, sp.torsoH * 0.8, 0));
  const frontZ = (t: number) => torsoF(t) * sp.torsoR * 0.86;
  lods.each(spine, (g, lv) => {
    const torso = mesh(torsoGeo(lv), suitPrint);
    torso.scale.set(sp.torsoR * sp.sx, sp.torsoH, sp.torsoR * 0.86);
    g.add(torso);
    // stand-up collar
    const collar = mesh(
      lv === 2
        ? cachedGeo('collar:low', () => new THREE.TorusGeometry(1, 0.28, 5, 12))
        : latheGeo('collarband', [[1.0, -0.2], [1.12, -0.1], [1.12, 0.32], [1.04, 0.42], [0.92, 0.36], [0.94, -0.15]], seg(lv, 40, 20, 10)),
      accent,
    );
    collar.scale.set(sp.torsoR * 0.42, lv === 2 ? sp.torsoR * 0.42 : sp.torsoR * 0.3, sp.torsoR * 0.42);
    if (lv === 2) collar.rotation.x = Math.PI / 2;
    collar.position.y = sp.torsoH * 0.97;
    g.add(collar);
    if (lv !== 2) {
      // front zipper: tape + teeth + pull tab
      const zpts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = 0.94 - (i / 8) * 0.56;
        zpts.push(new THREE.Vector3(0, t * sp.torsoH, frontZ(t) + 0.003));
      }
      const zmat = plastic('#c9ccd2', 0.25, 1);
      if (lv === 1) g.add(mesh(tubeGeo(`ztape:${id}`, zpts, 0.005, 10, 4), zmat, false));
      if (lv === 0) {
        const tpts = zpts.map((p) => p.clone().add(new THREE.Vector3(0, 0, 0.004)));
        g.add(mesh(dashGeo(`zteeth:${id}`, tpts, 0.006, 0.004, 0.009), zmat, false));
        const pull = mesh(roundedBox(0.018, 0.034, 0.006, 0.004, 2), zmat, false);
        pull.position.set(0, 0.86 * sp.torsoH - 0.02, frontZ(0.86) + 0.012);
        pull.rotation.x = 0.25;
        g.add(pull);
      }
      // embroidered chest badge (character's left)
      const tpatch = 0.66;
      const px = sp.torsoR * sp.sx * 0.38;
      const ang = Math.atan2(px / (sp.torsoR * sp.sx), 1);
      const ptex = patchTexture(id, def.emblem, def.colors.primary, '#ffffff');
      const patch = mesh(cachedGeo(`patchdisc:${lv}`, () => new THREE.CircleGeometry(1, seg(lv, 32, 16, 8))), cachedMat(`patchmat:${id}`, () => new THREE.MeshPhysicalMaterial({ map: ptex, color: ptex ? '#ffffff' : def.colors.primary, roughness: 0.65, sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffffff') })), false);
      patch.scale.setScalar(sp.torsoR * 0.32);
      patch.position.set(px, tpatch * sp.torsoH, frontZ(tpatch) * Math.cos(ang) + 0.006);
      patch.rotation.y = ang * 1.6;
      g.add(patch);
    }
    if (id === 'mom') {
      // hoodie hood bunched behind the neck + drawstrings
      const hood = mesh(sph(lv, 32), suit);
      hood.scale.set(sp.torsoR * 0.95, sp.torsoR * 0.5, sp.torsoR * 0.55);
      hood.position.set(0, sp.torsoH * 0.92, -sp.torsoR * 0.55);
      g.add(hood);
      if (lv === 0) {
        for (const s of [-1, 1]) {
          const t0 = 0.93;
          const a = new THREE.Vector3(s * 0.035, t0 * sp.torsoH, frontZ(t0) + 0.004);
          const b = new THREE.Vector3(s * 0.045, 0.7 * sp.torsoH, frontZ(0.7) + 0.012);
          boneSeg(g, a, b, 0.006, accent, lv, 8);
          const aglet = mesh(cylinderGeo(0.008, 0.008, 0.02, 8), accent, false);
          aglet.position.copy(b).add(new THREE.Vector3(0, -0.01, 0));
          g.add(aglet);
        }
      }
    }
    // rounded shoulders
    for (const p of shoulderPos) {
      const ball = mesh(sph(lv, 32), suit);
      ball.scale.setScalar(sp.armR * 1.45);
      ball.position.copy(p);
      g.add(ball);
      if (lv === 0) {
        // shoulder panel piping
        const pipe = mesh(cachedGeo(`shpipe:${sp.armR}`, () => new THREE.TorusGeometry(sp.armR * 1.3, sp.armR * 0.08, 6, 32, Math.PI)), accent, false);
        pipe.position.copy(p).add(new THREE.Vector3(0, sp.armR * 0.1, 0));
        pipe.rotation.set(0, Math.PI / 2, 0);
        g.add(pipe);
      }
    }
  });

  const shoulders: THREE.Object3D[] = [];
  for (const p of shoulderPos) {
    const sh = new THREE.Object3D();
    sh.position.copy(p);
    spine.add(sh);
    shoulders.push(sh);
  }

  const neck = new THREE.Group();
  neck.name = 'neck';
  neck.position.y = sp.torsoH * 0.95;
  spine.add(neck);
  lods.each(neck, (g, lv) => {
    const neckM = mesh(cylinderGeo(sp.headR * 0.33, sp.headR * 0.38, sp.neck + 0.08, seg(lv, 28, 14, 8)), skin);
    neckM.position.y = sp.neck / 2;
    g.add(neckM);
  });

  const head = new THREE.Group();
  head.name = 'head';
  const headY = sp.neck + sp.headR * 0.82;
  head.position.y = headY;
  neck.add(head);
  const headShape = new THREE.Group();
  headShape.name = 'headShape';
  headShape.scale.set(...sp.headScale);
  head.add(headShape);
  const face = newFaceMat(id, sp.face);
  const rigPartial: Partial<Rig> = {};
  lods.each(headShape, (g, lv) => {
    const skull = mesh(sculptedSphere(`skull:${id}:${lv}`, seg(lv, 36, 20, 14), seg(lv, 24, 14, 9), bump), skin);
    skull.scale.setScalar(sp.headR);
    g.add(skull);
    const patch = mesh(sculptedSphere(`face:${id}:${lv}`, seg(lv, 42, 22, 16), seg(lv, 36, 18, 12), bump, FACE_PART), face.mat);
    patch.scale.setScalar(sp.headR * 1.004);
    g.add(patch);
    buildNose(g, lv, sp, skin, bump);
    buildEars(g, lv, sp, skin);
    buildHair(g, sp, lv, rigPartial, lods, headShape);
    buildGlasses(g, sp, lv, bump);
    if (id === 'dad') {
      // chunky 3D goatee + moustache (sculpted clumps on high)
      const hm = hairMaterial(sp);
      const tuft = mesh(tinted(`goatee:${lv}`, sph(lv, 20), sp.face.beard!), hm);
      tuft.position.copy(spherePt(sp.headR * (0.92 + bump(0, 2.28)), 0, 2.28));
      tuft.scale.set(sp.headR * 0.24, sp.headR * 0.2, sp.headR * 0.16);
      g.add(tuft);
      const stache = mesh(tinted(`stache:${lv}`, caps(lv, sp.headR * 0.065, sp.headR * 0.32, 18), sp.face.beard!), hm);
      stache.rotation.z = Math.PI / 2;
      stache.position.copy(spherePt(sp.headR * (1.0 + bump(0, 1.87)), 0, 1.87)).add(new THREE.Vector3(sp.headR * 0.16, 0, 0));
      g.add(stache);
      if (lv === 0) {
        const list: Clump[] = [];
        const rnd = seeded(91);
        for (let i = 0; i < 26; i++) {
          const dphi = (rnd() - 0.5) * 0.7;
          const th = 2.08 + rnd() * 0.28;
          const n = spherePt(1, dphi, th);
          list.push({ p: n.clone().multiplyScalar(sp.headR * (0.98 + bump(dphi, th))), n, dir: new THREE.Vector3(dphi * 0.3, -1, 0.15), len: sp.headR * (0.16 + rnd() * 0.06), wid: sp.headR * 0.07, c: shadeHex(sp.face.beard!, 0.85 + rnd() * 0.35), lie: 0.8 });
        }
        g.add(clumpMeshes('dadbeard', list, lv, () => 0.3, hm));
      }
    }
  });
  const eyeShine = new THREE.Group();
  eyeShine.name = 'eye-shine';
  headShape.add(eyeShine);
  lods.each(eyeShine, (g, lv) => buildEyeShine(g, lv, sp.face, sp.headR * 1.004, bump));
  const stars = makeStars(sp.headR * 1.25);
  head.add(stars);

  const wheel = makeSteeringWheel(lods, root, sp.wheelY, def.colors.suitAccent === '#ffffff' ? def.colors.primary : def.colors.suitAccent);
  const arms = shoulders.map((sh, i) =>
    buildArm(lods, root, i === 0 ? 1 : -1, sh, { l1: sp.armL1, l2: sp.armL2, r: sp.armR, handR: sp.handR, sleeve: suit, glove, cuff, accent }),
  );

  return {
    root, pelvis, spine, neck, head, faceMat: face.mat, faceKey: face.get, arms,
    wheelSpin: wheel.spin, grips: wheel.grips, stars, eyeShine, ponytail: rigPartial.ponytail, pelvisY: 0, headY,
  };
}

function buildNose(g: THREE.Group, lv: Lv, sp: HumanSpec, mat: THREE.Material, bump: (d: number, t: number) => number): void {
  const r = sp.headR;
  const tipTheta = 1.76;
  const base = spherePt(r * (0.98 + bump(0, tipTheta)), 0, tipTheta);
  const ns = r * sp.nose;
  const bulb = mesh(sph(lv, 26), mat);
  bulb.position.copy(base);
  bulb.scale.set(ns * 1.0, ns * 0.88, ns * 0.95);
  g.add(bulb);
  if (lv === 2) return;
  // nostril wings
  for (const s of [-1, 1]) {
    const wing = mesh(sph(lv, 14), mat);
    wing.position.copy(base).add(new THREE.Vector3(s * ns * 0.78, -ns * 0.32, -ns * 0.3));
    wing.scale.set(ns * 0.5, ns * 0.42, ns * 0.5);
    g.add(wing);
  }
  if (lv === 0) {
    // bridge rising towards the brow
    const top = spherePt(r * (0.99 + bump(0, 1.5)), 0, 1.5);
    boneSeg(g, top, base.clone().add(new THREE.Vector3(0, ns * 0.2, -ns * 0.25)), ns * 0.42, mat, lv, 16);
  }
}

function buildEars(g: THREE.Group, lv: Lv, sp: HumanSpec, skin: THREE.Material): void {
  const r = sp.headR;
  for (const s of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(s * r * 0.97, -r * 0.08, -r * 0.05);
    ear.rotation.y = s * 0.35;
    g.add(ear);
    const lobe = mesh(sph(lv, 18), skin);
    lobe.scale.set(r * 0.1, r * 0.21, r * 0.16);
    ear.add(lobe);
    if (lv === 2) continue;
    // helix rim + inner bowl
    const rim = mesh(cachedGeo(`earrim:${lv}`, () => new THREE.TorusGeometry(1, 0.24, seg(lv, 10, 6, 4), seg(lv, 32, 14, 6), Math.PI * 1.55)), skin);
    rim.scale.set(r * 0.15, r * 0.2, r * 0.15);
    rim.rotation.set(0, (s * Math.PI) / 2, -Math.PI * 0.62);
    rim.position.x = s * r * 0.05;
    ear.add(rim);
    if (lv === 0) {
      const bowl = mesh(sphereG(12, 8), skin, false);
      bowl.scale.set(r * 0.03, r * 0.12, r * 0.08);
      bowl.position.x = s * r * 0.075;
      ear.add(bowl);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lupin
// ---------------------------------------------------------------------------------------------

const LUPIN_FACE: FaceStyle = {
  skin: '#ecdab4', iris: '#2a1a10', brow: '#a77c4c', lip: '#4a1518', blush: 0, eyeR: 0.16, eyeSep: 0.36,
  eyeTheta: 1.4, mouthTheta: 2.1, mouthW: 0.3, browThick: 8, dog: true,
};

const FUR = ['#f0e0bd', '#e6d0a6', '#f6ead2', '#d9bd90', '#e0c79c', '#cfae7c', '#efdcb5'];
const FUR_LIGHT = ['#f8eedb', '#f2e4c6', '#ecdab4', '#fff6e6'];
const EAR_FUR = ['#c49a62', '#b48650', '#d1aa72', '#a77a46', '#bf935c', '#caa070'];

/** Fur colour with a little per-clump lightness jitter. */
function furColor(rnd: () => number, pal: string[]): string {
  const a = new THREE.Color(pal[Math.floor(rnd() * pal.length) % pal.length]);
  const b = new THREE.Color(pal[Math.floor(rnd() * pal.length) % pal.length]);
  return shadeHex(a.lerp(b, 0.5).getStyle(), 0.95 + rnd() * 0.1);
}

function fib(i: number, n: number): [number, number] {
  const y = 1 - ((i + 0.5) / n) * 2;
  return [Math.acos(clamp(y, -1, 1)), i * 2.39996];
}

const DOWN = new THREE.Vector3(0, -1, 0);

function buildLupin(lods: Lods): Rig {
  const def = characterById('lupin');
  const root = new THREE.Group();
  root.name = 'character:lupin';
  const cream = fabric('#e9d6ae', 0.95);
  const light = fabric('#f3e6cc', 0.95);
  const furM = hairMat('fur', 0.85);
  const furN = (lv: Lv, hi: number) => Math.round(hi * byLv(lv, 1, 0.42, 0.18));
  const furClumps = (list: Clump[], lv: Lv, key: string) => clumpMeshes(`lupin:${key}`, list, lv, () => 0.3, furM, true);
  // fluffier on high: more, slightly thinner locks
  const fw = (lv: Lv) => byLv(lv, 0.85, 1.15, 1.5);

  const pelvis = new THREE.Group();
  pelvis.name = 'pelvis';
  pelvis.position.y = 0.02;
  root.add(pelvis);
  lods.each(pelvis, (g, lv) => {
    const rnd = seeded(11 + lv);
    const hip = mesh(sph(lv, 20), cream);
    hip.scale.set(0.21, 0.15, 0.22);
    hip.position.set(0, 0.08, -0.02);
    g.add(hip);
    // hind legs tucked forward
    const legs: Clump[] = [];
    const n = furN(lv, 14);
    for (const s of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const p = new THREE.Vector3(s * (0.13 + rnd() * 0.06), 0.1 + rnd() * 0.08, -0.06 + (i / n) * 0.36);
        legs.push({ p, n: new THREE.Vector3(s, 0.6, 0), dir: DOWN, len: 0.15 + rnd() * 0.04, wid: 0.055 * fw(lv), c: furColor(rnd, FUR), lie: 0.3 });
      }
    }
    g.add(furClumps(legs, lv, 'legs'));
  });

  // tail: curled plume over the back
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.position.set(0, 0.2, -0.19);
  pelvis.add(tail);
  lods.each(tail, (g, lv) => {
    const rnd = seeded(21 + lv);
    const list: Clump[] = [];
    const n = furN(lv, 46);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const a = t * Math.PI * 0.9;
      const p = new THREE.Vector3((rnd() - 0.5) * 0.06, Math.sin(a) * 0.24 + t * 0.06, -Math.cos(a) * 0.12 + 0.02 - t * 0.12).multiplyScalar(1.35);
      const nn = new THREE.Vector3((rnd() - 0.5) * 1.2, 0.4, -1).normalize();
      list.push({ p, n: nn, dir: new THREE.Vector3(nn.x, -0.5, -0.6), len: 0.15 + Math.sin(t * Math.PI) * 0.09 + rnd() * 0.03, wid: 0.06 * fw(lv), c: furColor(rnd, t > 0.3 ? EAR_FUR : FUR), lie: 0.3 });
    }
    g.add(furClumps(list, lv, 'tail'));
  });

  const spine = new THREE.Group();
  spine.name = 'spine';
  spine.position.y = 0.04;
  pelvis.add(spine);
  lods.each(spine, (g, lv) => {
    const chestCore = mesh(sph(lv, 24), cream);
    chestCore.scale.set(0.17, 0.23, 0.15);
    chestCore.position.set(0, 0.2, 0.0);
    g.add(chestCore);
  });
  const bodyFurGroup = new THREE.Group();
  bodyFurGroup.name = 'body-fur';
  spine.add(bodyFurGroup);
  lods.each(bodyFurGroup, (g, lv) => {
    const rnd = seeded(41 + lv);
    const list: Clump[] = [];
    const NB = furN(lv, 135);
    for (let i = 0; i < NB; i++) {
      const [th, ph] = fib(i, NB * 1.3);
      const n = new THREE.Vector3(Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph));
      const p = new THREE.Vector3(n.x * 0.16, 0.2 + n.y * 0.21, n.z * 0.14);
      const front = n.z > 0.3;
      if (n.z > 0.45 && n.y > 0.25) continue;
      list.push({ p, n, dir: DOWN, len: 0.18 + rnd() * 0.07, wid: (0.05 + rnd() * 0.012) * fw(lv), c: front ? furColor(rnd, FUR_LIGHT) : furColor(rnd, FUR), lie: 0.75 });
    }
    g.add(furClumps(list, lv, 'body'));
  });

  const shoulders: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const sh = new THREE.Object3D();
    sh.position.set(s * 0.12, 0.3, 0.08);
    spine.add(sh);
    shoulders.push(sh);
  }

  const neck = new THREE.Group();
  neck.name = 'neck';
  neck.position.set(0, 0.4, 0.03);
  spine.add(neck);
  // bandana: knotted collar + triangle bib with white paw prints
  const navy = def.colors.suit;
  const bTex = bandanaTexture(navy);
  const bandMat = cachedMat('bandanaHD', () => new THREE.MeshPhysicalMaterial({ map: bTex, color: bTex ? '#ffffff' : navy, roughness: 0.8, side: THREE.DoubleSide, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color('#9ab0e0') }));
  lods.each(neck, (g, lv) => {
    const collar = mesh(cachedGeo(`dogcollar:${lv}`, () => new THREE.TorusGeometry(0.16, 0.045, seg(lv, 12, 8, 5), seg(lv, 44, 20, 10))), fabric(navy, 0.8));
    collar.rotation.x = Math.PI / 2 - 0.25;
    collar.position.set(0, -0.02, 0);
    g.add(collar);
    const bib = mesh(cachedGeo(`bandanabib:${lv}`, () => new THREE.ConeGeometry(0.2, 0.26, seg(lv, 36, 18, 8), seg(lv, 4, 1, 1), true, -Math.PI * 0.55, Math.PI * 1.1)), bandMat);
    bib.rotation.x = Math.PI - 0.3;
    bib.scale.set(1, 1, 0.75);
    bib.position.set(0, -0.12, 0.1);
    g.add(bib);
    if (lv === 0) {
      // knot at the back with two tails
      const knot = mesh(sph(lv, 16), fabric(navy, 0.8));
      knot.scale.set(0.045, 0.04, 0.035);
      knot.position.set(0, 0.0, -0.17);
      g.add(knot);
      for (const s of [-1, 1]) {
        const tl = mesh(roundedBox(0.035, 0.09, 0.012, 0.006, 2), fabric(navy, 0.8));
        tl.position.set(s * 0.025, -0.05, -0.18);
        tl.rotation.z = s * 0.4;
        g.add(tl);
      }
    }
  });

  const head = new THREE.Group();
  head.name = 'head';
  const headY = 0.2;
  head.position.y = headY;
  neck.add(head);
  const headShape = new THREE.Group();
  headShape.name = 'headShape';
  head.add(headShape);
  const HR = 0.21;
  const face = newFaceMat('lupin', LUPIN_FACE);
  const noBump = () => 0;
  lods.each(headShape, (g, lv) => {
    const skull = mesh(sph(lv, 32), cream);
    skull.scale.setScalar(HR);
    g.add(skull);
    const patch = mesh(sculptedSphere(`face:lupin:${lv}`, seg(lv, 56, 30, 18), seg(lv, 48, 26, 14), noBump, FACE_PART), face.mat);
    patch.scale.setScalar(HR * 1.004);
    g.add(patch);
    // muzzle + glossy nose
    const muzzle = mesh(sph(lv, 32), light);
    muzzle.scale.set(0.12, 0.085, 0.1);
    muzzle.position.set(0, -0.07, 0.175);
    g.add(muzzle);
    const nose = mesh(sph(lv, 28), wetMat('#1b1412'));
    nose.scale.set(0.05, 0.036, 0.036);
    nose.position.set(0, -0.04, 0.27);
    g.add(nose);
    if (lv === 0) {
      for (const s of [-1, 1]) {
        const nostril = mesh(sphereG(12, 8), wetMat('#1b1412'), false);
        nostril.scale.set(0.011, 0.007, 0.006);
        nostril.position.set(s * 0.018, -0.046, 0.302);
        g.add(nostril);
      }
      // philtrum groove
      const groove = mesh(caps(lv, 0.004, 0.03, 6), wetMat('#1b1412'), false);
      groove.position.set(0, -0.09, 0.27);
      g.add(groove);
    }
  });
  // mouth (scaled open/closed by the animator)
  const mouth = new THREE.Group();
  mouth.name = 'mouth';
  mouth.position.set(0, -0.125, 0.22);
  mouth.scale.set(0.065, 0.028, 0.04);
  headShape.add(mouth);
  lods.each(mouth, (g, lv) => g.add(mesh(sph(lv, 24), plastic('#4a1518', 0.6))));
  const tongue = new THREE.Group();
  tongue.name = 'tongue';
  tongue.position.set(0, -0.13, 0.235);
  headShape.add(tongue);
  lods.each(tongue, (g, lv) => {
    const tongueM = mesh(caps(lv, 0.034, 0.075, 20), glossy('#f06b86', 0.35));
    tongueM.scale.set(1, 1, 0.45);
    tongueM.rotation.x = Math.PI * 0.82;
    g.add(tongueM);
    if (lv === 0) {
      const groove = mesh(caps(lv, 0.004, 0.06, 6), glossy('#c94a66', 0.35), false);
      groove.rotation.x = Math.PI * 0.82;
      groove.position.set(0, -0.004, 0.012);
      g.add(groove);
    }
  });

  // head fur: shaggy clumps everywhere except the eye/muzzle window
  const headFurGroup = new THREE.Group();
  headFurGroup.name = 'head-fur';
  headShape.add(headFurGroup);
  lods.each(headFurGroup, (g, lv) => {
    const rnd = seeded(61 + lv);
    const list: Clump[] = [];
    const NH = furN(lv, 235);
    for (let i = 0; i < NH; i++) {
      const [th, ph] = fib(i, NH);
      const dphi = Math.atan2(Math.sin(ph), Math.cos(ph));
      if (Math.abs(dphi) < 0.95 && th > 0.98 && th < 2.4) continue;
      const n = spherePt(1, dphi, th);
      const top = th < 0.98 && Math.abs(dphi) < 1.0;
      list.push({ p: n.clone().multiplyScalar(HR * 0.97), n, dir: DOWN, len: top ? 0.13 + rnd() * 0.03 : 0.17 + rnd() * 0.06, wid: (0.034 + rnd() * 0.01) * fw(lv), c: furColor(rnd, FUR), lie: 0.7 });
    }
    // fringe falling over the forehead (stops above the eyes)
    const nf = furN(lv, 13);
    for (let i = 0; i < nf; i++) {
      const dphi = (i / (nf - 1 || 1) - 0.5) * 1.3;
      const n = spherePt(1, dphi, 0.84 + rnd() * 0.06);
      list.push({ p: n.clone().multiplyScalar(HR * 0.98), n, dir: new THREE.Vector3(dphi * 0.2, -1, 0.3), len: 0.075 + rnd() * 0.02, wid: 0.045 * fw(lv), c: furColor(rnd, FUR), lie: 0.9 });
    }
    // cheeks + beard around the muzzle
    const nb = furN(lv, 34);
    for (let i = 0; i < nb; i++) {
      const a = Math.PI * (0.92 + (i / (nb - 1 || 1)) * 1.16);
      const n = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.6, 0.6).normalize();
      const p = new THREE.Vector3(Math.cos(a) * 0.12, -0.075 + Math.sin(a) * 0.06, 0.15 + rnd() * 0.02);
      list.push({ p, n, dir: DOWN, len: 0.1 + rnd() * 0.04, wid: 0.04 * fw(lv), c: furColor(rnd, FUR_LIGHT), lie: 0.6 });
    }
    g.add(furClumps(list, lv, 'head'));
  });

  // big floppy ears
  const ears: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const ear = new THREE.Group();
    ear.name = 'ear';
    ear.position.copy(spherePt(HR * 0.98, s * 1.25, 0.78));
    headShape.add(ear);
    lods.each(ear, (g, lv) => {
      const rnd = seeded(81 + lv + (s > 0 ? 0 : 50));
      if (lv !== 0) {
        const flap = mesh(sph(lv, 20), fabric('#c49a62', 0.95));
        flap.scale.set(0.035, 0.12, 0.07);
        flap.position.set(s * 0.04, -0.1, 0);
        g.add(flap);
      }
      const list: Clump[] = [];
      const n = furN(lv, 40);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const p = new THREE.Vector3(s * (0.03 + (rnd() - 0.2) * 0.035), -t * 0.2, (rnd() - 0.5) * 0.1);
        list.push({ p, n: new THREE.Vector3(s, 0, (rnd() - 0.5) * 0.6), dir: DOWN, len: 0.14 + t * 0.07 + rnd() * 0.02, wid: 0.055 * fw(lv), c: furColor(rnd, EAR_FUR), lie: 0.3 });
      }
      g.add(furClumps(list, lv, `ear${s}`));
    });
    ears.push(ear);
  }

  const eyeShine = new THREE.Group();
  eyeShine.name = 'eye-shine';
  headShape.add(eyeShine);
  lods.each(eyeShine, (g, lv) => buildEyeShine(g, lv, LUPIN_FACE, HR * 1.004, noBump));

  const stars = makeStars(0.32);
  head.add(stars);

  const wheel = makeSteeringWheel(lods, root, 0.24, def.colors.primary);
  const legMat = fabric('#e6d2aa', 0.95);
  const pawMat = fabric('#f4e9d2', 0.95);
  const arms = shoulders.map((sh, i) =>
    buildArm(lods, root, i === 0 ? 1 : -1, sh, {
      l1: 0.19, l2: 0.19, r: 0.062, handR: 0.072, sleeve: legMat, glove: pawMat, cuff: legMat, accent: legMat, paw: true,
      fur: (g, lv, part) => {
        const rnd = seeded(101 + lv + (part === 'upper' ? 0 : part === 'lower' ? 7 : 13) + i * 31);
        const len = part === 'upper' ? 0.19 : 0.19;
        const list: Clump[] = [];
        const n = part === 'hand' ? furN(lv, 8) : furN(lv, 12);
        for (let j = 0; j < n; j++) {
          const ang = rnd() * Math.PI * 2;
          const nn = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
          const y = part === 'hand' ? 0.02 : (j / n) * len;
          list.push({ p: new THREE.Vector3(nn.x * 0.05, y, nn.z * 0.05), n: nn, dir: new THREE.Vector3(nn.x * 0.4, part === 'hand' ? 0.3 : 1, nn.z * 0.4), len: 0.09 + rnd() * 0.03, wid: 0.045 * fw(lv), c: furColor(rnd, FUR), lie: 0.5 });
        }
        if (list.length) g.add(furClumps(list, lv, `arm${i}:${part}`));
      },
    }),
  );

  return {
    root, pelvis, spine, neck, head, faceMat: face.mat, faceKey: face.get, arms,
    wheelSpin: wheel.spin, grips: wheel.grips, stars, eyeShine, pelvisY: 0.02, headY,
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
        _v.set(sh.x - 0.14, sh.y + 0.55, sh.z - 0.16).lerp(_v.clone().set(sh.x - 0.04, sh.y + 0.3, sh.z + 0.48), thr);
        tgt.lerp(_v, clamp(w.item * Math.max(wind, thr * (1 - smoothstep(0.75, 1, p) * 0.6)), 0, 1));
      }
      if (w.overtake > 0.01) lerpTo(-0.08, 0.42 + Math.sin(age * 18) * 0.1, 0.12, w.overtake);
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
  if (rig.eyeShine) rig.eyeShine.visible = expr === 'normal' || expr === 'determined' || expr === 'shocked' || expr === 'sad';
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
  const lods = new Lods();
  const rig = id === 'lupin' ? buildLupin(lods) : buildHuman(id, lods);
  // drivers are chunky and oversized relative to the kart (poster proportions)
  const outer = new THREE.Group();
  outer.name = rig.root.name;
  rig.root.name += ':scaled';
  rig.root.scale.setScalar(CHAR_SCALE[id]);
  outer.add(rig.root);
  const rndSeed = { dad: 1, mom: 2, bro1: 3, bro2: 4, lupin: 5, grandma: 6 }[id] * 7919 + Math.floor(Math.random() * 1000);
  const rnd = seeded(rndSeed);
  const st: AnimState = {
    steer: 0, drift: 0, boost: 0, accel: 0, prevSpeed: 0, reaction: 'none', age: 0,
    w: { hit: 0, item: 0, overtake: 0, jump: 0, win: 0, lose: 0 },
    blinkAt: 1 + rnd() * 3, blinkUntil: 0, wasAirborne: false, furX: 0, furV: 0, earSwing: 0, earSwingV: 0,
    tailPhase: 0, earPhase: 0, expr: 'normal', rnd,
  };
  // static contents of every detail level -> one mesh per material (cached per racer / quality)
  mergeLodLevels(outer, `char:${id}:${lods.levels.join('')}`);
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

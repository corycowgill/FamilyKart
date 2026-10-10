import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { TrackSample } from '../../sim/track/Track';
import type { SceneryContext, SceneryHandle } from './types';
import { addClouds, Batch, boxUV, ctxBits, disposeGroup, M, mergeColored, PROPS, setInstance, timeOfDay, trimShadows, vcMat } from './common';
import { getField } from './field';
import { canvasTexture, noiseTexture, textTexture } from './textures';
import {
  aonCenter, buildChicagoFlag, CTA, elevatedL, buildLakeMichigan, dogGeo, dogMat, type DogBreed, faceRoad, findSpot, glassSpireTower, hancockCenter, hazeObject, hotDogStand,
  Kit, kites, lifeguardGeo, lighthouse, marinaCity, parkDistrictSign, seagulls, tribuneTower, wavyTower, willisTower,
} from './chicagoLandmarks';

type P = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;

function tennisTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g, w, h, rng) => {
    g.fillStyle = '#d7f03a';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = rng.chance(0.5) ? 'rgba(255,255,255,0.25)' : 'rgba(120,150,0,0.2)';
      g.fillRect(rng.next() * w, rng.next() * h, 2, 2);
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 4) * h * 0.28;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  });
}

function barkTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g, w, h, rng) => {
    g.fillStyle = '#7a4f2a';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = rng.pick(['#5e3b1e', '#8d6236', '#6b4424']);
      g.fillRect(rng.next() * w, 0, rng.range(2, 6), h);
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(40,20,5,0.4)';
      g.fillRect(rng.next() * w, rng.next() * h, rng.range(4, 10), 2);
    }
  });
}

export function buildDogPark(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const rng = new Rng(5150);
  const def = track.def;
  const lm = (kind: string) => def.landmarks.filter((l) => l.kind === kind);
  const updaters: Array<(dt: number, t: number) => void> = [];
  const vc = vcMat(bag, { roughness: 0.7 });
  const b = field.bounds;
  const parts: P = [];
  const kit = new Kit(bag, group, { lit: 0, snow: false, quality });
  const hi = quality === 'high', lo = quality === 'low';
  const shoreX = field.shoreX;
  const beach = Number.isFinite(shoreX);
  const beachW = field.beachW || 50;
  /** inland edge of the sand */
  const sandX = shoreX - beachW - 12;
  const onBeach = (x: number) => beach && x > sandX - 8;
  const shirt = ['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#41B6E6', '#14315e', '#ff5fa2'];
  const nearestMain = (x: number, z: number): TrackSample => {
    let best = track.paths[0].samples[0], bd = Infinity;
    for (const s of track.paths[0].samples) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };

  /* ------------------------------------------------ tunnels over the road */
  {
    const stripes = bag.add(canvasTexture(256, 64, (g, w, h) => {
      const cols = ['#ff4d6d', '#ffd23f', '#3ccf6e', '#2f7de1', '#b26bff', '#ff8a3d'];
      for (let i = 0; i < 6; i++) {
        g.fillStyle = cols[i];
        g.fillRect((i * w) / 6, 0, w / 6 + 1, h);
      }
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let i = 0; i < 6; i++) g.fillRect((i * w) / 6, 0, 3, h);
    }));
    stripes.repeat.set(1, 1);
    const mat = bag.add(new THREE.MeshStandardMaterial({ map: stripes, side: THREE.DoubleSide, roughness: 0.7 }));
    for (const t of lm('tunnel')) {
      const smp = nearestMain(t.x, t.z);
      const r = smp.halfWidth + def.shoulder + 1.2;
      const len = 26;
      const geo = bag.add(new THREE.CylinderGeometry(r, r, len, 40, 1, true, 0, Math.PI).rotateZ(Math.PI / 2));
      // u around, v along: swap so stripes run around the tube in rings
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i) * 3, uv.getX(i));
      const m = new THREE.Mesh(geo, mat);
      m.position.set(smp.x, smp.y - 0.3, smp.z);
      m.rotation.y = Math.atan2(smp.tx, smp.tz) + Math.PI / 2;
      m.castShadow = true;
      group.add(m);
      // hoops at the ends
      for (const e of [-len / 2, len / 2]) {
        parts.push([new THREE.TorusGeometry(r, 0.6, 8, 40, Math.PI), '#ffffff', M.trs(smp.x + smp.tx * e, smp.y - 0.3, smp.z + smp.tz * e, 0, Math.atan2(smp.tx, smp.tz), 0)]);
      }
      placer.reserve(smp.x + smp.nx * r, smp.z + smp.nz * r, 4);
      placer.reserve(smp.x - smp.nx * r, smp.z - smp.nz * r, 4);
    }
  }

  /* ------------------------------------------------ hollow log around the shortcut */
  for (const l of lm('hollowLog')) {
    const sc = track.paths[1];
    if (!sc) break;
    let best = sc.samples[0], bd = Infinity;
    for (const s of sc.samples) {
      const d = (s.x - l.x) ** 2 + (s.z - l.z) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    const r = best.halfWidth + def.shoulder + 1.5;
    const len = 46;
    const bark = bag.add(barkTexture());
    bark.repeat.set(4, 2);
    const outer = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(r, r, len, 28, 1, true).rotateZ(Math.PI / 2)), bag.add(new THREE.MeshStandardMaterial({ map: bark, roughness: 1 })));
    const inner = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(r - 1.2, r - 1.2, len, 28, 1, true).rotateZ(Math.PI / 2)), bag.add(new THREE.MeshStandardMaterial({ color: '#c8925a', roughness: 1, side: THREE.BackSide })));
    const ring = new THREE.Mesh(bag.add(new THREE.RingGeometry(r - 1.2, r, 28)), bag.add(new THREE.MeshStandardMaterial({ color: '#e0b27a', side: THREE.DoubleSide })));
    const g = new THREE.Group();
    g.add(outer, inner);
    for (const e of [-len / 2, len / 2]) {
      const rr = ring.clone();
      rr.position.x = e;
      rr.rotation.y = Math.PI / 2;
      g.add(rr);
    }
    g.position.set(best.x, best.y + r - 2.5, best.z);
    g.rotation.y = Math.atan2(best.tx, best.tz) + Math.PI / 2;
    outer.castShadow = true;
    group.add(g);
    // mushrooms on top
    for (let i = 0; i < 5; i++) {
      const a = rng.range(-len / 2.5, len / 2.5);
      parts.push([new THREE.CylinderGeometry(0.4, 0.5, 1.4, 6), '#fff4e0', M.t(best.x + best.tx * a, best.y + r * 2 - 2.3, best.z + best.tz * a)]);
      parts.push([new THREE.SphereGeometry(1.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#e8443a', M.t(best.x + best.tx * a, best.y + r * 2 - 1.7, best.z + best.tz * a)]);
    }
    placer.reserve(best.x, best.z, len / 2 + 2);
  }

  /* ------------------------------------------------ wooden bridge over the creek */
  for (const l of lm('woodBridge')) {
    const smp = nearestMain(l.x, l.z);
    const yaw = Math.atan2(smp.tx, smp.tz);
    const wd = smp.halfWidth + def.shoulder + 0.5;
    const base = M.trs(smp.x, smp.y, smp.z, 0, yaw, 0);
    const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => parts.push([g, col, base.clone().multiply(local)]);
    p(new THREE.BoxGeometry(wd * 2, 1.2, 34), '#9a6634', M.t(0, -0.8, 0));
    for (const x of [-wd + 2, 0, wd - 2]) p(new THREE.BoxGeometry(1.2, 1.4, 36), '#7a4f2a', M.t(x, -1.8, 0));
    for (const z of [-10, 10]) for (const x of [-wd + 2, wd - 2]) p(new THREE.CylinderGeometry(0.9, 0.9, 10, 8), '#6b4424', M.t(x, -5.5, z));
    for (const side of [-1, 1]) {
      p(new THREE.BoxGeometry(0.5, 0.5, 34), '#c98a4b', M.t(side * (wd + 0.4), 1.6, 0));
      for (let z = -16; z <= 16; z += 4) p(new THREE.BoxGeometry(0.5, 1.8, 0.5), '#a8733f', M.t(side * (wd + 0.4), 0.8, z));
    }
  }

  /* ------------------------------------------------ dog houses */
  {
    const house = mergeColored([
      [new THREE.BoxGeometry(6, 4.5, 7), '#ffffff', M.t(0, 2.25, 0)],
      [new THREE.BoxGeometry(2.4, 3, 0.2), '#3a2414', M.t(0, 1.5, 3.52)],
      [new THREE.BoxGeometry(4.6, 0.35, 8), '#d7262e', M.trs(-1.6, 5.4, 0, 0, 0, 0.62)],
      [new THREE.BoxGeometry(4.6, 0.35, 8), '#d7262e', M.trs(1.6, 5.4, 0, 0, 0, -0.62)],
      [new THREE.BoxGeometry(6.0, 2.6, 6.8), '#ffffff', M.trs(0, 4.6, 0, 0, 0, Math.PI / 4, 0.7, 0.7, 1)],
      [new THREE.CylinderGeometry(1.0, 1.1, 0.5, 14), '#2f7de1', M.t(2.2, 0.25, 5)],
    ]);
    const houses = new Batch(bag.add(house), vc, { name: 'dogHouses' });
    const cols = ['#ffd23f', '#8fc1e3', '#ffffff', '#a8e0c2', '#f4a7a0'];
    lm('dogHouse').forEach((d, i) => {
      houses.add(d.x, field.height(d.x, d.z), d.z, d.rot ?? 0, 1.3, 1.3, 1.3, cols[i % cols.length]);
      placer.reserve(d.x, d.z, 7);
    });
    for (const s of placer.scatter(Math.round(6 * density), { minX: b.minX - 60, maxX: b.maxX + 60, minZ: b.minZ - 60, maxZ: b.maxZ + 60 }, 5, 6)) if (!onBeach(s.x)) houses.add(s.x, s.y, s.z, s.yaw, 1.1, 1.1, 1.1, rng.pick(cols));
    houses.build(group);
    // name sign over the first dog house
    const d0 = lm('dogHouse')[0];
    if (d0) {
      const t = bag.add(textTexture('LUPIN', { w: 256, h: 64, bg: '#2f7de1', fg: '#ffffff', border: '#ffd23f' }));
      const sign = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(4, 1)), bag.add(new THREE.MeshStandardMaterial({ map: t })));
      const rot = d0.rot ?? 0;
      sign.position.set(d0.x + Math.sin(rot) * 4.7, field.height(d0.x, d0.z) + 5.1, d0.z + Math.cos(rot) * 4.7);
      sign.rotation.y = rot;
      group.add(sign);
    }
  }

  /* ------------------------------------------------ giant tennis balls (some bouncing) + bones */
  const ballTex = bag.add(tennisTexture());
  const ballMat = bag.add(new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.95 }));
  const ballGeo = bag.add(new THREE.SphereGeometry(1, 24, 16));
  const balls: Array<{ x: number; y: number; z: number; s: number; bounce: number; ph: number }> = [];
  for (const t of lm('tennisBall')) {
    balls.push({ x: t.x, y: field.height(t.x, t.z), z: t.z, s: t.scale ?? 4, bounce: 0, ph: 0 });
    placer.reserve(t.x, t.z, (t.scale ?? 4) + 1);
  }
  for (const s of placer.scatter(Math.round(16 * density), { minX: b.minX - 40, maxX: b.maxX + 40, minZ: b.minZ - 40, maxZ: b.maxZ + 40 }, 2, 4)) {
    balls.push({ x: s.x, y: s.y, z: s.z, s: rng.range(1.2, 2.2), bounce: rng.chance(0.5) ? rng.range(3, 7) : 0, ph: rng.next() * 6 });
  }
  const ballIM = new THREE.InstancedMesh(ballGeo, ballMat, balls.length);
  ballIM.castShadow = true;
  ballIM.receiveShadow = true;
  group.add(ballIM);
  updaters.push((_dt, t) => {
    balls.forEach((bb, i) => {
      const h = bb.bounce ? Math.abs(Math.sin(t * 2.2 + bb.ph)) * bb.bounce : 0;
      const squash = bb.bounce && h < 0.4 ? 0.85 : 1;
      setInstance(ballIM, i, bb.x, bb.y + bb.s * squash + h, bb.z, 0, bb.ph + t * (bb.bounce ? 0.5 : 0), 0, bb.s, bb.s * squash, bb.s);
    });
    ballIM.instanceMatrix.needsUpdate = true;
  });
  {
    const bone = mergeColored([
      [new THREE.CylinderGeometry(0.8, 0.8, 7, 12).rotateZ(Math.PI / 2), '#fbf6ea', M.t(0, 1.3, 0)],
      [new THREE.SphereGeometry(1.25, 12, 10), '#fbf6ea', M.t(-3.6, 1.3, 0.8)],
      [new THREE.SphereGeometry(1.25, 12, 10), '#fbf6ea', M.t(-3.6, 1.3, -0.8)],
      [new THREE.SphereGeometry(1.25, 12, 10), '#fbf6ea', M.t(3.6, 1.3, 0.8)],
      [new THREE.SphereGeometry(1.25, 12, 10), '#fbf6ea', M.t(3.6, 1.3, -0.8)],
    ]);
    const bones = new Batch(bag.add(bone), vc, { name: 'bones' });
    for (const t of lm('bone')) {
      bones.add(t.x, field.height(t.x, t.z), t.z, t.rot ?? 0, (t.scale ?? 1) * 2.2);
      placer.reserve(t.x, t.z, 10 * (t.scale ?? 1));
    }
    for (const s of placer.scatter(Math.round(10 * density), { minX: b.minX - 40, maxX: b.maxX + 40, minZ: b.minZ - 40, maxZ: b.maxZ + 40 }, 4, 4)) bones.add(s.x, s.y, s.z, s.yaw, rng.range(0.8, 1.3));
    bones.build(group);
  }

  /* ------------------------------------------------ agility course */
  for (const a of lm('agility')) {
    const y = field.height(a.x, a.z);
    const m = M.trs(a.x, y, a.z, 0, rng.next() * 3, 0);
    const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => parts.push([g, col, m.clone().multiply(local)]);
    // weave poles
    for (let i = 0; i < 8; i++) {
      p(new THREE.CylinderGeometry(0.15, 0.15, 3.2, 6), '#ffffff', M.t(-10 + i * 2.2, 1.6, -8));
      for (let k = 0; k < 3; k++) p(new THREE.CylinderGeometry(0.17, 0.17, 0.4, 6), i % 2 ? '#e8443a' : '#2f7de1', M.t(-10 + i * 2.2, 0.6 + k * 1.0, -8));
    }
    // jump bars
    for (const x of [-8, 0, 8]) {
      p(new THREE.BoxGeometry(0.3, 2.2, 0.3), '#ffffff', M.t(x - 2, 1.1, 2));
      p(new THREE.BoxGeometry(0.3, 2.2, 0.3), '#ffffff', M.t(x + 2, 1.1, 2));
      p(new THREE.CylinderGeometry(0.12, 0.12, 4, 6).rotateZ(Math.PI / 2), x === 0 ? '#ffd23f' : '#3ccf6e', M.t(x, 1.4, 2));
    }
    // hoop
    p(new THREE.TorusGeometry(1.6, 0.18, 8, 24), '#ff8a3d', M.t(12, 2.6, -2));
    p(new THREE.BoxGeometry(0.3, 2.6, 0.3), '#ffffff', M.t(12, 0.9, -2));
    p(new THREE.BoxGeometry(2.4, 0.2, 1.2), '#ffffff', M.t(12, 0.1, -2));
    // A-frame
    p(new THREE.BoxGeometry(3, 0.3, 6), '#ffd23f', M.trs(-4, 1.5, 9.5, 0.55, 0, 0));
    p(new THREE.BoxGeometry(3, 0.3, 6), '#2f7de1', M.trs(-4, 1.5, 14.5, -0.55, 0, 0));
    placer.reserve(a.x, a.z, 18);
  }

  /* ------------------------------------------------ fire hydrant + Lupin statue near the start */
  for (const h of lm('fireHydrant')) {
    const y = field.height(h.x, h.z);
    parts.push([new THREE.CylinderGeometry(1.2, 1.4, 4, 12), '#e8443a', M.t(h.x, y + 2, h.z)]);
    parts.push([new THREE.SphereGeometry(1.3, 12, 8), '#e8443a', M.t(h.x, y + 4.1, h.z)]);
    parts.push([new THREE.CylinderGeometry(0.5, 0.5, 3.6, 8).rotateZ(Math.PI / 2), '#ffd23f', M.t(h.x, y + 2.8, h.z)]);
    placer.reserve(h.x, h.z, 3);
  }
  {
    const s0 = track.sampleAt(0, 0);
    const side = -1;
    const lat = side * (s0.halfWidth + def.shoulder + 12);
    const x = s0.x + s0.nx * lat, z = s0.z + s0.nz * lat;
    if (placer.ok(x, z, 7, 1)) {
      placer.reserve(x, z, 8);
      const y = field.height(x, z);
      const face = Math.atan2(-s0.nx * side, -s0.nz * side);
      const m = M.trs(x, y, z, 0, face, 0);
      const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => parts.push([g, col, m.clone().multiply(local)]);
      p(new THREE.CylinderGeometry(5, 5.5, 1.6, 16), '#b9b2a2', M.t(0, 0.8, 0));
      const cream = '#f3e3c3';
      const blob = (x2: number, y2: number, z2: number, r: number) => p(new THREE.IcosahedronGeometry(r, 1), cream, M.t(x2, y2, z2));
      blob(0, 4.5, 0, 2.8);
      blob(0, 3.2, -2.0, 2.4);
      blob(0, 7.8, 1.2, 2.3);
      for (const k of [[-1.2, 8.8, 0.2], [1.2, 8.8, 0.2], [0, 9.6, 0.8], [-2.2, 7.3, 0.8], [2.2, 7.3, 0.8]]) blob(k[0], k[1], k[2], 1.2);
      p(new THREE.SphereGeometry(0.95, 10, 8), '#f6ead2', M.t(0, 7.2, 3.1));
      p(new THREE.SphereGeometry(0.42, 8, 6), '#222', M.t(0, 7.4, 4.0));
      p(new THREE.SphereGeometry(0.3, 8, 6), '#222', M.t(-0.75, 8.2, 3.2));
      p(new THREE.SphereGeometry(0.3, 8, 6), '#222', M.t(0.75, 8.2, 3.2));
      p(new THREE.SphereGeometry(0.45, 8, 6), '#ff7aa8', M.trs(0, 6.5, 3.4, 0, 0, 0, 0.8, 0.5, 1));
      p(new THREE.ConeGeometry(2.1, 2.2, 3).rotateX(Math.PI), '#1f3f8f', M.trs(0, 5.6, 1.9, -0.4, 0, 0));
      for (const lx of [-1.1, 1.1]) for (const lz of [1.6, -2.6]) blob(lx, 1.9, lz, 1.0);
      p(new THREE.IcosahedronGeometry(0.9, 1), cream, M.t(0, 5.2, -4.3));
    }
  }

  /* ------------------------------------------------ trees, bushes, flowers, rocks */
  {
    const rect = { minX: b.minX - 170, maxX: b.maxX + 170, minZ: b.minZ - 170, maxZ: b.maxZ + 170 };
    const treeA = new Batch(bag.add(PROPS.roundTree('#4fb04a', '#7fd060', '#7a5230')), vc, { name: 'trees' });
    const treeB = new Batch(bag.add(PROPS.roundTree('#2f9a52', '#5cc06a', '#6b4425')), vc);
    const pines = new Batch(bag.add(PROPS.coneTree('#2e8f55', '#6b4a2b')), vc);
    for (const s of placer.scatter(Math.round(300 * density), rect, 3.2, 4)) {
      if (onBeach(s.x + 10)) continue;
      const r = rng.next();
      (r < 0.4 ? treeA : r < 0.75 ? treeB : pines).add(s.x, s.y - 0.2, s.z, s.yaw, rng.range(0.9, 1.6));
    }
    treeA.build(group);
    treeB.build(group);
    pines.build(group);
    const bushes = new Batch(bag.add(PROPS.bush('#4c9c3c', '#77c257')), vc, { cast: false });
    for (const s of placer.scatter(Math.round(200 * density), rect, 1.4, 1.5)) if (!onBeach(s.x)) bushes.add(s.x, s.y - 0.1, s.z, s.yaw, rng.range(0.7, 1.5));
    bushes.build(group);
    const flowerGeo = bag.add(mergeColored([
      [new THREE.CylinderGeometry(0.05, 0.05, 0.8, 4), '#3f8f3a', M.t(0, 0.4, 0)],
      [new THREE.IcosahedronGeometry(0.32, 0), '#ffffff', M.t(0, 0.85, 0)],
      [new THREE.CylinderGeometry(0.05, 0.05, 0.6, 4), '#3f8f3a', M.t(0.5, 0.3, 0.3)],
      [new THREE.IcosahedronGeometry(0.28, 0), '#ffffff', M.t(0.5, 0.65, 0.3)],
      [new THREE.CylinderGeometry(0.05, 0.05, 0.7, 4), '#3f8f3a', M.t(-0.4, 0.35, -0.3)],
      [new THREE.IcosahedronGeometry(0.3, 0), '#ffffff', M.t(-0.4, 0.75, -0.3)],
    ]));
    const flowers = new Batch(flowerGeo, vc, { cast: false });
    for (const s of placer.scatter(Math.round(500 * density), { minX: b.minX - 60, maxX: b.maxX + 60, minZ: b.minZ - 60, maxZ: b.maxZ + 60 }, 0.6, 0.8, Infinity, 6, false)) {
      if (field.channelAt(s.x, s.z) || onBeach(s.x)) continue;
      flowers.add(s.x, s.y, s.z, s.yaw, rng.range(1.5, 2.5), rng.range(1.5, 2.5), rng.range(1.5, 2.5), rng.pick(['#ff6fa8', '#ffd23f', '#ffffff', '#b48cff', '#ff8a3d']));
    }
    flowers.build(group);
    // rocks along the creek
    const rocks = new Batch(bag.add(new THREE.DodecahedronGeometry(1, 0)), bag.add(new THREE.MeshStandardMaterial({ color: '#9a9a92', roughness: 0.95, flatShading: true })), { cast: false });
    for (const c of field.channels) {
      for (let k = -c.halfLen; k < c.halfLen; k += 3) {
        for (const side of [-1, 1]) {
          if (!rng.chance(0.6)) continue;
          const x = c.cx + c.ax * k - c.az * side * (c.halfWidth + rng.range(0, 3));
          const z = c.cz + c.az * k + c.ax * side * (c.halfWidth + rng.range(0, 3));
          if (field.clearance(x, z) < 1) continue;
          rocks.add(x, field.height(x, z) + 0.2, z, rng.next() * 6, rng.range(0.8, 2.2), rng.range(0.5, 1.2), rng.range(0.8, 2), rng.pick(['#a8a89e', '#8f8f86', '#b9b4a6']));
        }
      }
    }
    rocks.build(group);
  }

  /* ------------------------------------------------ picnic blankets, benches */
  {
    const chk = bag.add(canvasTexture(64, 64, (g, w, h) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? '#e8443a' : '#ffffff';
        g.fillRect((x * w) / 8, (y * h) / 8, w / 8, h / 8);
      }
    }));
    const blankets = new Batch(bag.add(new THREE.PlaneGeometry(6, 5).rotateX(-Math.PI / 2).translate(0, 0.08, 0)), bag.add(new THREE.MeshStandardMaterial({ map: chk, roughness: 1 })), { cast: false });
    for (const s of placer.scatter(Math.round(8 * density + 2), { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ }, 4, 6)) {
      if (Math.abs(field.height(s.x + 2, s.z) - s.y) > 0.6) continue;
      blankets.add(s.x, s.y, s.z, s.yaw);
      parts.push([new THREE.BoxGeometry(1.4, 0.9, 1.0), '#c98a4b', M.trs(s.x + 1, s.y + 0.45, s.z + 0.5, 0, s.yaw, 0)]);
    }
    blankets.build(group);
    const benches = new Batch(bag.add(PROPS.bench()), vc, { cast: false });
    for (const s of placer.along(0, 70, 3, 1.5)) benches.add(s.x, s.y, s.z, s.yaw + Math.PI);
    benches.build(group);
  }

  /* ------------------------------------------------ dogs of many breeds: playing in the meadows, fetching in the lake */
  {
    const breeds: DogBreed[] = ['lab', 'doodle', 'dachshund', 'husky', 'corgi'];
    const coat: Record<DogBreed, string[]> = {
      lab: ['#e8c27a', '#2a2a2a', '#6b4424', '#f3dca8'],
      doodle: ['#f3e3c3', '#d9a066', '#fffaf0', '#8a6a4a'],
      dachshund: ['#8a4a22', '#3a2416', '#b5652f'],
      husky: ['#8a8f99', '#4a4f57', '#c9ccd2'],
      corgi: ['#e08a3c', '#c96f2a'],
    };
    type Dog = { breed: DogBreed; col: string; s: number; ph: number; mode: 0 | 1; cx: number; cz: number; r: number; w: number; ax: number; az: number; bx: number; bz: number; v: number };
    const dd: Dog[] = [];
    const rect = { minX: b.minX - 30, maxX: b.maxX + 30, minZ: b.minZ - 30, maxZ: b.maxZ + 30 };
    let bi = 0;
    const nextBreed = () => breeds[bi++ % breeds.length];
    for (const sp of placer.scatter(Math.round(12 * density + 3), rect, 9, 6)) {
      if (onBeach(sp.x)) continue;
      const br = nextBreed();
      dd.push({ breed: br, col: rng.pick(coat[br]), s: rng.range(1.2, 1.5), ph: rng.next() * 6, mode: 0, cx: sp.x, cz: sp.z, r: rng.range(4, 8), w: rng.range(0.6, 1.2) * (rng.chance(0.5) ? 1 : -1), ax: 0, az: 0, bx: 0, bz: 0, v: 0 });
    }
    if (beach) {
      // fetch runs: from the dry sand out into Lake Michigan and back
      const nb = hi ? 16 : lo ? 6 : 10;
      for (let i = 0; i < nb; i++) {
        const z = rng.range(b.minZ - 60, b.maxZ + 60);
        const ax = shoreX - rng.range(12, beachW * 0.7);
        if (!placer.ok(ax, z, 2, 6)) continue;
        const br = nextBreed();
        dd.push({ breed: br, col: rng.pick(coat[br]), s: rng.range(1.0, 1.25), ph: rng.next() * 6, mode: 1, cx: 0, cz: 0, r: 0, w: 0, ax, az: z, bx: shoreX + rng.range(4, 12), bz: z + rng.range(-14, 14), v: rng.range(0.08, 0.14) });
      }
    }
    const mat = dogMat(bag, kit.time);
    const meshes = new Map<DogBreed, { im: THREE.InstancedMesh; list: Dog[] }>();
    for (const br of breeds) {
      const list = dd.filter((d) => d.breed === br);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(bag.add(dogGeo(br)), mat, list.length);
      list.forEach((d, i) => im.setColorAt(i, new THREE.Color(d.col)));
      im.castShadow = true;
      im.frustumCulled = false;
      im.name = `dogs-${br}`;
      group.add(im);
      meshes.set(br, { im, list });
    }
    updaters.push((_dt, t) => {
      for (const { im, list } of meshes.values()) {
        list.forEach((d, i) => {
          let x: number, z: number, yaw: number;
          if (d.mode === 0) {
            const a = t * d.w + d.ph;
            x = d.cx + Math.cos(a) * d.r;
            z = d.cz + Math.sin(a) * d.r;
            yaw = Math.atan2(-Math.sin(a) * Math.sign(d.w), Math.cos(a) * Math.sign(d.w));
          } else {
            const c = (t * d.v + d.ph) % 2;
            const f = c < 1 ? c : 2 - c;
            const e = f * f * (3 - 2 * f);
            x = d.ax + (d.bx - d.ax) * e;
            z = d.az + (d.bz - d.az) * e;
            yaw = Math.atan2(d.bx - d.ax, d.bz - d.az) + (c < 1 ? 0 : Math.PI);
          }
          const hop = Math.abs(Math.sin(t * 9 + d.ph)) * 0.35;
          setInstance(im, i, x, Math.max(field.height(x, z), -1.0) + hop, z, 0, yaw, 0, d.s);
        });
        im.instanceMatrix.needsUpdate = true;
      }
    });
  }

  /* ------------------------------------------------ Chicago Park District sign + flags at the entrance */
  const flags = buildChicagoFlag(kit, 1.1);
  {
    const s0 = track.sampleAt(0, 60);
    const lat = s0.halfWidth + def.shoulder + 5;
    const x = s0.x + s0.nx * lat, z = s0.z + s0.nz * lat;
    const yaw = Math.atan2(-s0.nx, -s0.nz);
    parkDistrictSign(kit, x, field.height(x, z), z, yaw, ["LUPIN'S DOG BEACH", 'CHICAGO PARK DISTRICT'], 15);
    placer.reserve(x, z, 9);
    for (const d of [-10, 10]) {
      const fx = x + Math.cos(yaw) * d, fz = z - Math.sin(yaw) * d;
      flags.add(fx, field.height(fx, fz), fz);
      placer.reserve(fx, fz, 2);
    }
    // more Chicago flags along the start straight
    for (const sp of placer.along(0, 55, 4, 2, { side: 0, from: 0, to: 260 })) flags.add(sp.x, sp.y, sp.z);
    for (const sp of placer.along(0, 150, 5, 2, { side: 1, from: 300 })) flags.add(sp.x, sp.y, sp.z);
  }

  /* ------------------------------------------------ the Brown Line L rumbling past the west edge of the park */
  {
    const lx = b.minX - 70;
    elevatedL(kit, placer, {
      a: [lx, b.minZ - 260], b: [lx, b.maxZ + 260], deckY: 12,
      lines: lo ? [CTA.brown] : [CTA.brown, CTA.red], cars: lo ? 4 : 6,
      stations: [{ at: 0.5, name: 'MONTROSE', color: CTA.brown }],
      period: 26,
    });
  }

  if (parts.length) {
    const m = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  if (beach) buildDogBeach();
  kit.flush();
  updaters.push(addClouds(ctx, bag, quality === 'low' ? 10 : 24, [120, 220], 1200, '#ffffff', 77));
  trimShadows(group, quality);

  /* ================================================ Montrose-style dog beach on Lake Michigan */
  function buildDogBeach(): void {
    const z0 = b.minZ - 700, z1 = b.maxZ + 700;
    /* ---------- sand over the beach terrain (fades into the dune grass inland) */
    {
      const step = hi ? 4 : lo ? 8 : 6;
      const xs: number[] = [];
      for (let x = sandX; x < shoreX + 10; x += step) xs.push(x);
      xs.push(shoreX + 10);
      const nz = Math.ceil((z1 - z0) / step);
      const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];
      const c = new THREE.Color(), sand = new THREE.Color('#efd6a0'), wet = new THREE.Color('#c8a873'), grass = new THREE.Color('#9fbf62');
      const ok: boolean[] = [];
      for (let j = 0; j <= nz; j++) {
        const z = z0 + (j * (z1 - z0)) / nz;
        xs.forEach((x, i) => {
          const h = field.height(x, z);
          const edge = i === 0;
          pos.push(x, edge ? h - 0.4 : h + 0.14, z);
          const wetF = Math.max(0, Math.min(1, (x - (shoreX - 7)) / 5));
          const inl = Math.max(0, Math.min(1, (x - sandX) / 14));
          c.copy(grass).lerp(sand, inl).lerp(wet, wetF);
          c.multiplyScalar(0.94 + Math.sin(x * 0.7 + z * 0.13) * 0.03 + Math.sin(z * 0.05) * 0.03);
          col.push(c.r, c.g, c.b);
          uv.push(x / 9, z / 9);
          ok.push(field.clearance(x, z, 40) > 1.5);
        });
      }
      const nx = xs.length;
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b2 = a + 1, c2 = a + nx, d = c2 + 1;
        if (!ok[a] || !ok[b2] || !ok[c2] || !ok[d]) continue;
        idx.push(a, c2, b2, b2, c2, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const tex = bag.add(noiseTexture('#ffffff', ['#e9dcc0', '#f7efdc', '#d8c8a4'], 21));
      const m = new THREE.Mesh(bag.add(g), bag.add(new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
      m.receiveShadow = true;
      m.name = 'beachSand';
      group.add(m);
    }

    /* ---------- surf: wave crests rolling in to the shore */
    {
      const N = hi ? 5 : 3;
      const zc = (b.minZ + b.maxZ) / 2, len = b.maxZ - b.minZ + 900;
      const foam = new THREE.InstancedMesh(bag.add(new THREE.PlaneGeometry(1, len, 1, 1).rotateX(-Math.PI / 2)), bag.add(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthWrite: false })), N + 1);
      foam.frustumCulled = false;
      foam.renderOrder = 2;
      foam.name = 'surf';
      group.add(foam);
      updaters.push((_dt, t) => {
        for (let i = 0; i < N; i++) {
          const c = (t * 0.09 + i / N) % 1;
          const w = c < 0.85 ? 0.6 + c * 1.6 : (1 - c) / 0.15 * 2;
          setInstance(foam, i, shoreX + 60 * (1 - c) + 1.5, -0.42 + c * 0.04, zc + Math.sin(t * 0.3 + i) * 6, 0, 0.01 * Math.sin(i), 0, Math.max(0.01, w), 1, 1);
        }
        setInstance(foam, N, shoreX + 0.8, -0.4, zc, 0, 0, 0, 2.2 + Math.sin(t * 1.3) * 0.8, 1, 1);
        foam.instanceMatrix.needsUpdate = true;
      });
    }

    /* ---------- sailboats, gulls, the harbor lighthouse */
    buildLakeMichigan(kit, shoreX, [b.minZ - 300, b.maxZ + 300], hi ? 12 : lo ? 4 : 8, { plane: false, seawall: false, boatX: [70, 520] });
    seagulls(kit, hi ? 22 : lo ? 6 : 12, { x0: shoreX - 80, x1: shoreX + 160, z0: b.minZ - 80, z1: b.maxZ + 80, y0: 12, y1: 32 });
    lighthouse(kit, shoreX + 150, -0.6, b.minZ - 60, Math.PI / 2, 1.4, 112);

    /* ---------- dunes with marram grass between the park and the sand */
    {
      const dune = kit.batch(mergeColored([
        [new THREE.IcosahedronGeometry(1, 1), '#d6b97c', M.trs(0, 0, 0, 0, 0, 0, 1, 0.34, 1)],
        [new THREE.IcosahedronGeometry(0.8, 1), '#8fb352', M.trs(0.1, 0.1, 0.05, 0, 0, 0, 1, 0.34, 1)],
      ]), kit.solidMat, { cast: false, name: 'dunes' });
      const tuft = kit.batch(mergeColored([0, 1, 2, 3, 4].map((i) => [new THREE.ConeGeometry(0.08, 1.4, 3), i % 2 ? '#a9c25e' : '#8aa84a', M.trs(Math.cos(i * 1.3) * 0.25, 0.65, Math.sin(i * 1.3) * 0.25, Math.cos(i) * 0.3, 0, Math.sin(i) * 0.3)] as [THREE.BufferGeometry, string, THREE.Matrix4])), kit.solidMat, { cast: false, name: 'marram' });
      for (let z = z0 + 200; z < z1 - 200; z += rng.range(10, 18) * (lo ? 2 : 1)) {
        const x = sandX + rng.range(-4, 10);
        if (!placer.ok(x, z, 6, 3)) continue;
        const sc = rng.range(6, 11);
        dune.add(x, field.height(x, z) - 0.3, z, rng.next() * 6, sc, sc * rng.range(0.6, 1.1), sc * rng.range(0.8, 1.4));
        for (let k = 0; k < (lo ? 2 : 5); k++) {
          const tx = x + rng.range(-sc * 0.6, sc * 0.6), tz = z + rng.range(-sc * 0.6, sc * 0.6);
          tuft.add(tx, field.height(tx, tz) + 0.4, tz, rng.next() * 6, rng.range(1.2, 2));
        }
      }
    }

    /* ---------- umbrellas, towels, lifeguard chairs, beach-goers */
    {
      const umb = kit.batch(mergeColored([
        [new THREE.CylinderGeometry(0.06, 0.06, 3, 5), '#eeeeee', M.t(0, 1.5, 0)],
        [new THREE.ConeGeometry(1.9, 0.8, 8), '#ffffff', M.t(0, 3.1, 0)],
      ]), kit.tintMat, { name: 'umbrellas' });
      const towels = kit.batch(new THREE.PlaneGeometry(1.2, 2.2).rotateX(-Math.PI / 2).translate(0, 0.17, 0), bag.add(new THREE.MeshStandardMaterial({ roughness: 1 })), { cast: false, name: 'towels' });
      const cols = ['#ff4d6d', '#ffd23f', '#3aa8ff', '#3ccf6e', '#ff8a3d', '#b26bff', '#41B6E6', '#E4002B'];
      for (let z = b.minZ - 220; z < b.maxZ + 220; z += rng.range(9, 15)) {
        const x = shoreX - rng.range(10, beachW - 6);
        if (!placer.ok(x, z, 2.2, 4)) continue;
        placer.reserve(x, z, 2.2);
        const y = field.height(x, z);
        umb.add(x, y, z, rng.next() * 6, 1, 1, 1, rng.pick(cols));
        towels.add(x + 1.6, y, z + rng.range(-1, 1), rng.range(-0.3, 0.3), 1, 1, 1, rng.pick(cols));
        if (!lo && rng.chance(0.55)) kit.person(x + rng.range(-2.5, 2.5), y, z + rng.range(-2, 2), rng.range(-1, 1) - Math.PI / 2, rng.pick(shirt), rng.range(0.8, 1));
      }
      const guards = kit.batch(lifeguardGeo(), kit.solidMat, { name: 'lifeguards' });
      for (const z of [b.minZ + 60, (b.minZ + b.maxZ) / 2 + 20, b.maxZ + 40]) {
        const x = shoreX - 12;
        const p = findSpot(placer, x, z, 2.5, 4, 20);
        if (!p) continue;
        placer.reserve(p.x, p.z, 2.5);
        guards.add(p.x, field.height(p.x, p.z), p.z, -Math.PI / 2 + Math.PI, 1.3);
        flags.add(p.x - 3, field.height(p.x - 3, p.z + 3), p.z + 3);
      }
      // dog-park regulars waving from the water's edge
      if (!lo) for (let i = 0; i < (hi ? 22 : 10); i++) {
        const x = shoreX - rng.range(1, 8), z = rng.range(b.minZ - 100, b.maxZ + 100);
        kit.person(x, field.height(x, z), z, -Math.PI / 2 + rng.range(-0.8, 0.8), rng.pick(shirt), rng.range(0.85, 1));
      }
    }

    /* ---------- the hot dog stand + DOG BEACH sign at the beach entrance */
    {
      const p = findSpot(placer, shoreX - beachW + 4, (b.minZ + b.maxZ) / 2 + 30, 7, 6, 80);
      if (p) {
        placer.reserve(p.x, p.z, 7);
        hotDogStand(kit, p.x, field.height(p.x, p.z), p.z, faceRoad(placer, p.x, p.z), 1.1);
        if (!lo) for (let i = 0; i < 5; i++) {
          const yaw = faceRoad(placer, p.x, p.z);
          const px = p.x + Math.sin(yaw) * 5 + rng.range(-3, 3), pz = p.z + Math.cos(yaw) * 5 + rng.range(-2, 2);
          kit.person(px, field.height(px, pz), pz, yaw + Math.PI, rng.pick(shirt), rng.range(0.85, 1));
        }
      }
      const q = findSpot(placer, sandX + 2, b.maxZ - 60, 6, 5, 80);
      if (q) {
        placer.reserve(q.x, q.z, 6);
        parkDistrictSign(kit, q.x, field.height(q.x, q.z), q.z, faceRoad(placer, q.x, q.z), ['MONTROSE DOG BEACH', 'CHICAGO PARK DISTRICT'], 11);
      }
      const r = findSpot(placer, sandX + 2, b.minZ + 40, 6, 5, 80);
      if (r) {
        placer.reserve(r.x, r.z, 6);
        parkDistrictSign(kit, r.x, field.height(r.x, r.z), r.z, faceRoad(placer, r.x, r.z), ['DOG BEACH', 'DOGS OFF LEASH - LAKE MICHIGAN'], 10);
      }
    }

    /* ---------- kites over the beach */
    if (!lo) kites(kit, [0, 1, 2, 3].map((i) => ({ x: shoreX - rng.range(5, 25), z: b.minZ + (i + 0.5) * ((b.maxZ - b.minZ) / 4), h: rng.range(22, 34) })));

    /* ---------- the downtown skyline across the water (hazy, own kit) */
    {
      const skyGroup = new THREE.Group();
      skyGroup.name = 'skylineAcrossTheLake';
      group.add(skyGroup);
      const tod = timeOfDay(group);
      const sky = new Kit(bag, skyGroup, { lit: tod === 'night' ? 1.1 : tod === 'sunset' ? 0.45 : 0, snow: false, quality });
      const ax = shoreX + 380, az = b.maxZ + 900, bx = shoreX + 980, bz = b.maxZ + 260;
      const at = (f: number) => [ax + (bx - ax) * f, az + (bz - az) * f] as const;
      const len = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bx - ax, bz - az);
      const [mx, mz] = at(0.5);
      sky.solid.push([new THREE.BoxGeometry(150, 3, len + 260), '#6f8a5a', M.trs(mx + 40, -1.2, mz + 20, 0, ang, 0)]);
      sky.solid.push([new THREE.BoxGeometry(6, 2.4, len + 260), '#d9d2c2', M.trs(mx - 34, -1.2, mz - 26, 0, ang, 0)]);
      const face = Math.atan2(-(bz - az), bx - ax) - Math.PI / 2;
      const icons: Array<[(k: Kit, x: number, y: number, z: number, rot?: number, s?: number) => void, number, number]> = [
        [aonCenter, 0.08, 0.85], [glassSpireTower, 0.24, 0.85], [marinaCity, 0.36, 0.8], [tribuneTower, 0.44, 0.8], [willisTower, 0.56, 0.9],
        [wavyTower, 0.68, 0.8], [hancockCenter, 0.84, 0.9],
      ];
      for (const [fn, f, sc] of icons) {
        const [x, z] = at(f);
        fn(sky, x + 30, -0.5, z + 30, face, sc);
      }
      const kinds = ['glass', 'stone', 'dark', 'white', 'blue', 'tan'] as const;
      for (let i = 0; i < (lo ? 14 : 30); i++) {
        const f = rng.next();
        const [x, z] = at(f);
        const w = rng.range(18, 34), d = rng.range(18, 34), h = rng.range(40, 150) * (rng.chance(0.15) ? 1.6 : 1);
        sky.facade(kinds[i % kinds.length], boxUV(w, h, d), M.trs(x + rng.range(-10, 110), -0.5, z + rng.range(-10, 110), 0, face + rng.range(-0.2, 0.2), 0));
      }
      sky.flush();
      hazeObject(skyGroup, 0.5);
      updaters.push((dt, t) => sky.update(dt, t));
    }
  }

  return {
    update(dt: number, time: number) {
      for (const u of updaters) u(dt, time);
      kit.update(dt, time);
    },
    dispose() {
      disposeGroup(group);
      bag.dispose();
    },
  };
}

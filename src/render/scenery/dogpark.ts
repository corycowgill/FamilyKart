import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { TrackSample } from '../../sim/track/Track';
import type { SceneryContext, SceneryHandle } from './types';
import { Batch, M, PROPS, addClouds, ctxBits, mergeColored, setInstance, vcMat } from './common';
import { getField } from './field';
import { canvasTexture, textTexture } from './textures';

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

/** A simple cartoon dog (+Z forward), body tinted by instance color. */
function dogGeometry(): THREE.BufferGeometry {
  return mergeColored([
    [new THREE.CapsuleGeometry(0.55, 1.3, 4, 8).rotateX(Math.PI / 2), '#ffffff', M.t(0, 1.1, 0)],
    [new THREE.SphereGeometry(0.55, 10, 8), '#ffffff', M.t(0, 1.75, 1.05)],
    [new THREE.SphereGeometry(0.28, 8, 6), '#ffffff', M.t(0, 1.6, 1.55)],
    [new THREE.SphereGeometry(0.12, 6, 4), '#222', M.t(0, 1.66, 1.82)],
    [new THREE.SphereGeometry(0.28, 8, 6), '#ffffff', M.trs(0.42, 1.8, 0.95, 0, 0, 0.6, 0.6, 1.2, 0.5)],
    [new THREE.SphereGeometry(0.28, 8, 6), '#ffffff', M.trs(-0.42, 1.8, 0.95, 0, 0, -0.6, 0.6, 1.2, 0.5)],
    [new THREE.SphereGeometry(0.08, 6, 4), '#111', M.t(0.2, 1.9, 1.48)],
    [new THREE.SphereGeometry(0.08, 6, 4), '#111', M.t(-0.2, 1.9, 1.48)],
    ...[[-0.3, 0.55], [0.3, 0.55], [-0.3, -0.55], [0.3, -0.55]].map(([x, z]) => [new THREE.CylinderGeometry(0.15, 0.13, 0.8, 6), '#ffffff', M.t(x, 0.4, z)] as [THREE.BufferGeometry, string, THREE.Matrix4]),
    [new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6), '#ffffff', M.trs(0, 1.5, -1.0, -0.8, 0, 0)],
    [new THREE.TorusGeometry(0.42, 0.08, 6, 12).rotateX(Math.PI / 2), '#e8443a', M.trs(0, 1.45, 0.75, 0.5, 0, 0)],
  ]);
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
    for (const s of placer.scatter(Math.round(6 * density), { minX: b.minX - 60, maxX: b.maxX + 60, minZ: b.minZ - 60, maxZ: b.maxZ + 60 }, 5, 6)) houses.add(s.x, s.y, s.z, s.yaw, 1.1, 1.1, 1.1, rng.pick(cols));
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
      const r = rng.next();
      (r < 0.4 ? treeA : r < 0.75 ? treeB : pines).add(s.x, s.y - 0.2, s.z, s.yaw, rng.range(0.9, 1.6));
    }
    treeA.build(group);
    treeB.build(group);
    pines.build(group);
    const bushes = new Batch(bag.add(PROPS.bush('#4c9c3c', '#77c257')), vc, { cast: false });
    for (const s of placer.scatter(Math.round(200 * density), rect, 1.4, 1.5)) bushes.add(s.x, s.y - 0.1, s.z, s.yaw, rng.range(0.7, 1.5));
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
      if (field.channelAt(s.x, s.z)) continue;
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

  /* ------------------------------------------------ dogs playing in the meadows */
  {
    const dogGeo = bag.add(dogGeometry());
    const N = Math.round(10 * density + 2);
    const dogs = new THREE.InstancedMesh(dogGeo, vc, N);
    dogs.castShadow = true;
    const cols = ['#f3e3c3', '#6b4424', '#222222', '#d9a066', '#ffffff', '#9a7b5a', '#c96f4a'];
    const dd: Array<{ cx: number; cz: number; r: number; w: number; ph: number }> = [];
    const rect = { minX: b.minX - 30, maxX: b.maxX + 30, minZ: b.minZ - 30, maxZ: b.maxZ + 30 };
    for (const s of placer.scatter(N, rect, 9, 6)) dd.push({ cx: s.x, cz: s.z, r: rng.range(4, 8), w: rng.range(0.6, 1.2) * (rng.chance(0.5) ? 1 : -1), ph: rng.next() * 6 });
    dd.forEach((_, i) => dogs.setColorAt(i, new THREE.Color(cols[i % cols.length])));
    dogs.count = dd.length;
    dogs.frustumCulled = false;
    group.add(dogs);
    updaters.push((_dt, t) => {
      dd.forEach((d, i) => {
        const a = t * d.w + d.ph;
        const x = d.cx + Math.cos(a) * d.r, z = d.cz + Math.sin(a) * d.r;
        const hop = Math.abs(Math.sin(t * 9 + d.ph)) * 0.5;
        const yaw = Math.atan2(-Math.sin(a) * Math.sign(d.w), Math.cos(a) * Math.sign(d.w));
        setInstance(dogs, i, x, field.height(x, z) + hop, z, 0, yaw, 0, 1.6);
      });
      dogs.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ park fence + sign at the entrance */
  {
    const t = bag.add(textTexture("LUPIN'S DOG PARK", { w: 1024, h: 192, bg: '#2fa84f', fg: '#ffffff', border: '#ffd23f' }));
    const s0 = track.sampleAt(0, 60);
    const lat = s0.halfWidth + def.shoulder + 4;
    const x = s0.x + s0.nx * lat, z = s0.z + s0.nz * lat;
    const y = field.height(x, z);
    const sign = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(14, 2.6)), bag.add(new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide })));
    const yaw = Math.atan2(-s0.nx, -s0.nz);
    sign.position.set(x, y + 5, z);
    sign.rotation.y = yaw;
    group.add(sign);
    parts.push([new THREE.BoxGeometry(0.5, 6.2, 0.5), '#6b4424', M.trs(x + Math.cos(yaw) * 6.6, y + 3.1, z - Math.sin(yaw) * 6.6, 0, yaw, 0)]);
    parts.push([new THREE.BoxGeometry(0.5, 6.2, 0.5), '#6b4424', M.trs(x - Math.cos(yaw) * 6.6, y + 3.1, z + Math.sin(yaw) * 6.6, 0, yaw, 0)]);
    placer.reserve(x, z, 8);
  }

  if (parts.length) {
    const m = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  updaters.push(addClouds(ctx, bag, quality === 'low' ? 10 : 24, [120, 220], 1200, '#ffffff', 77));

  return {
    update(dt: number, time: number) {
      for (const u of updaters) u(dt, time);
    },
    dispose() {
      bag.dispose();
    },
  };
}

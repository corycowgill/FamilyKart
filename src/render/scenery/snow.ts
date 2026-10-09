import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { TrackSample } from '../../sim/track/Track';
import type { SceneryContext, SceneryHandle } from './types';
import { Batch, boxUV, ctxBits, disposeGroup, elevatedTrain, M, mergeColored, PROPS, setInstance, unitBox, vcMat, windowedMaterial } from './common';
import { getField } from './field';
import { canvasTexture, dotTexture, textTexture, windowLitTexture, windowTexture } from './textures';

type P = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;

/**
 * Chicago Snowpocalypse: downtown at dusk under heavy snow. Lit windows, holiday light strings,
 * a giant Christmas tree, the Bean, an ice rink with skaters, the theatre marquee, an L line,
 * the frozen lake with a lighthouse, snowmen and falling snow that follows the camera.
 */
export function buildSnow(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const rng = new Rng(2024);
  const def = track.def;
  const lm = (kind: string) => def.landmarks.filter((l) => l.kind === kind);
  const updaters: Array<(dt: number, t: number) => void> = [];
  const vc = vcMat(bag, { roughness: 0.8 });
  const glowMat = (color: string) => bag.add(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
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

  /* ------------------------------------------------ frozen lake */
  {
    const iceTex = bag.add(canvasTexture(256, 256, (g, w, h, r) => {
      g.fillStyle = '#cfe6f5';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 26; i++) {
        g.lineWidth = r.range(0.5, 2);
        let x = r.next() * w, y = r.next() * h;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          x += r.range(-30, 30);
          y += r.range(-30, 30);
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 30; i++) {
        g.beginPath();
        g.ellipse(r.next() * w, r.next() * h, r.range(10, 40), r.range(4, 14), r.next() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }));
    iceTex.repeat.set(60, 60);
    const lake = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(4000, 4000)), bag.add(new THREE.MeshStandardMaterial({ map: iceTex, roughness: 0.18, metalness: 0.1 })));
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(field.shoreX + 2000 - 3, -0.5, 0);
    lake.receiveShadow = true;
    group.add(lake);
  }

  /* ------------------------------------------------ L line crossing the course */
  for (const l of lm('ltrain')) updaters.push(elevatedTrain(group, bag, placer, { x0: -260, x1: 272, z: l.z, snow: true, lit: true }));

  /* ------------------------------------------------ landmarks */
  // giant Christmas tree with ornaments + star
  const ornaments: Array<{ x: number; y: number; z: number; c: string }> = [];
  for (const c of lm('christmasTree')) {
    const y0 = field.height(c.x, c.z);
    const s = 4.2;
    parts.push([new THREE.CylinderGeometry(1.2 * s * 0.5, 1.6 * s * 0.5, 3 * s, 8), '#5a3a26', M.t(c.x, y0 + 1.5 * s, c.z)]);
    for (const [r, h, y] of [[2.8, 4.4, 3.8], [2.2, 3.8, 6.0], [1.6, 3.2, 8.0], [1.0, 2.6, 9.8]]) {
      parts.push([new THREE.ConeGeometry(r * s, h * s, 12), '#1f7a45', M.t(c.x, y0 + y * s, c.z)]);
      for (let k = 0; k < 14; k++) {
        const a = rng.next() * Math.PI * 2, yy = rng.range(-0.4, 0.2) * h * s;
        const rr = (r * s) * (0.5 - yy / (h * s)) * 0.98;
        ornaments.push({ x: c.x + Math.cos(a) * rr, y: y0 + y * s + yy, z: c.z + Math.sin(a) * rr, c: rng.pick(['#ff3b3b', '#ffd23f', '#3aa8ff', '#ff7ad9', '#ffffff']) });
      }
    }
    const star = new THREE.Mesh(bag.add(new THREE.OctahedronGeometry(2.6, 0)), glowMat('#ffe066'));
    star.position.set(c.x, y0 + 11.6 * s, c.z);
    group.add(star);
    updaters.push((_dt, t) => (star.rotation.y = t * 1.2));
    placer.reserve(c.x, c.z, 14);
  }
  // the Bean
  for (const c of lm('bean')) {
    const y0 = field.height(c.x, c.z);
    const bean = new THREE.Mesh(bag.add(new THREE.SphereGeometry(1, 40, 24)), bag.add(new THREE.MeshStandardMaterial({ color: '#d9e3ef', metalness: 0.55, roughness: 0.08, emissive: '#2a3550', emissiveIntensity: 0.3 })));
    bean.scale.set(11, 5.2, 7);
    bean.position.set(c.x, y0 + 4.6, c.z);
    bean.castShadow = true;
    group.add(bean);
    parts.push([new THREE.CylinderGeometry(20, 20, 0.4, 32), '#d8dde6', M.t(c.x, y0 + 0.2, c.z)]);
    placer.reserve(c.x, c.z, 20);
  }
  // ice rink with skaters
  const skaters: Array<{ cx: number; cz: number; r: number; w: number; ph: number; y: number }> = [];
  for (const c of lm('iceRink')) {
    const y0 = field.height(c.x, c.z);
    parts.push([new THREE.CylinderGeometry(19, 19, 0.3, 40), '#e8f6ff', M.trs(c.x, y0 + 0.15, c.z, 0, 0, 0, 1, 1, 0.7)]);
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      parts.push([new THREE.BoxGeometry(3.2, 1.1, 0.3), k % 2 ? '#d7263d' : '#ffffff', M.trs(c.x + Math.cos(a) * 19.2, y0 + 0.55, c.z + Math.sin(a) * 19.2 * 0.7, 0, -a + Math.PI / 2, 0)]);
    }
    for (let i = 0; i < 9; i++) skaters.push({ cx: c.x, cz: c.z, r: rng.range(5, 14), w: rng.range(0.4, 0.9), ph: rng.next() * 6, y: y0 + 0.3 });
    placer.reserve(c.x, c.z, 21);
  }
  if (skaters.length) {
    const sk = mergeColored([
      [new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), '#ffffff', M.t(0, 1.1, 0)],
      [new THREE.SphereGeometry(0.3, 8, 6), '#f1c8a5', M.t(0, 2.05, 0)],
      [new THREE.ConeGeometry(0.3, 0.5, 8), '#ffffff', M.t(0, 2.4, 0)],
      [new THREE.BoxGeometry(0.9, 0.12, 0.25), '#ffffff', M.trs(0, 1.6, 0, 0, 0, 0)],
    ]);
    const im = new THREE.InstancedMesh(bag.add(sk), vc, skaters.length);
    const cols = ['#d7263d', '#2f7de1', '#3ccf6e', '#ffd23f', '#b26bff'];
    skaters.forEach((_, i) => im.setColorAt(i, new THREE.Color(cols[i % cols.length])));
    im.frustumCulled = false;
    group.add(im);
    updaters.push((_dt, t) => {
      skaters.forEach((s, i) => {
        const a = t * s.w + s.ph;
        setInstance(im, i, s.cx + Math.cos(a) * s.r, s.y, s.cz + Math.sin(a) * s.r * 0.7, 0, -a, Math.sin(t * 3 + s.ph) * 0.12, 1.4);
      });
      im.instanceMatrix.needsUpdate = true;
    });
  }
  // Chicago Theatre marquee
  for (const c of lm('marquee')) {
    const smp = nearestMain(c.x, c.z);
    const side = Math.sign((c.x - smp.x) * smp.nx + (c.z - smp.z) * smp.nz) || 1;
    const lat = side * (smp.halfWidth + def.shoulder + 14);
    const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
    const y0 = field.height(x, z);
    const yaw = Math.atan2(-smp.nx * side, -smp.nz * side);
    const m = M.trs(x, y0, z, 0, yaw, 0);
    const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => parts.push([g, col, m.clone().multiply(local)]);
    p(new THREE.BoxGeometry(34, 26, 16), '#c9b38f', M.t(0, 13, -6));
    p(new THREE.BoxGeometry(34.6, 1.2, 16.6), '#ffffff', M.t(0, 26.4, -6));
    p(new THREE.BoxGeometry(22, 4, 4), '#b8141f', M.t(0, 7, 3.6));
    p(new THREE.BoxGeometry(5, 26, 2), '#b8141f', M.t(0, 20, 4));
    const signTex = bag.add(canvasTexture(64, 512, (g, w, h) => {
      g.fillStyle = '#b8141f';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff6d6';
      g.font = '900 52px "Arial Black", Impact, sans-serif';
      g.textAlign = 'center';
      'CHICAGO'.split('').forEach((ch, i) => g.fillText(ch, w / 2, 60 + i * 66));
    }, { repeat: false }));
    const sign = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(4.2, 24)), bag.add(new THREE.MeshBasicMaterial({ map: signTex, toneMapped: false })));
    sign.position.set(x + Math.sin(yaw) * 5.05, y0 + 20, z + Math.cos(yaw) * 5.05);
    sign.rotation.y = yaw;
    group.add(sign);
    const mq = bag.add(textTexture('HAPPY HOLIDAYS', { w: 1024, h: 160, bg: '#1b1b1b', fg: '#ffe7a3', border: '#ffcc33' }));
    const board = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(21, 3.4)), bag.add(new THREE.MeshBasicMaterial({ map: mq, toneMapped: false })));
    board.position.set(x + Math.sin(yaw) * 5.65, y0 + 7, z + Math.cos(yaw) * 5.65);
    board.rotation.y = yaw;
    group.add(board);
    placer.reserve(x, z - 4, 20);
  }
  // lighthouse on the frozen lake
  for (const c of lm('lighthouse')) {
    const y0 = -0.5;
    parts.push([new THREE.CylinderGeometry(3.2, 4.2, 26, 16), '#f4f4f4', M.t(c.x, y0 + 13, c.z)]);
    parts.push([new THREE.CylinderGeometry(3.25, 3.6, 5, 16), '#d7263d', M.t(c.x, y0 + 10, c.z)]);
    parts.push([new THREE.CylinderGeometry(3.6, 3.6, 1, 16), '#333', M.t(c.x, y0 + 26.5, c.z)]);
    parts.push([new THREE.ConeGeometry(3.4, 3.4, 16), '#d7263d', M.t(c.x, y0 + 31.4, c.z)]);
    const lamp = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(2.2, 2.2, 2.6, 12)), glowMat('#fff2b0'));
    lamp.position.set(c.x, y0 + 28.4, c.z);
    group.add(lamp);
    const beamMat = bag.add(new THREE.MeshBasicMaterial({ color: '#fff4c0', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    const beam = new THREE.Mesh(bag.add(new THREE.ConeGeometry(10, 120, 16, 1, true).rotateZ(Math.PI / 2).translate(60, 0, 0)), beamMat);
    beam.position.set(c.x, y0 + 28.4, c.z);
    group.add(beam);
    updaters.push((_dt, t) => (beam.rotation.y = t * 0.7));
  }

  /* ------------------------------------------------ downtown buildings with lit windows + snowy roofs */
  {
    const walls = [
      windowTexture({ wall: '#cdbfae', glass: '#2b3346', glass2: '#3b4660', seed: 71 }),
      windowTexture({ wall: '#8c8f99', glass: '#273047', glass2: '#36425f', bands: true, seed: 72 }),
      windowTexture({ wall: '#b06c55', glass: '#2a2f3d', glass2: '#3d4357', frame: 0.3, seed: 73 }),
    ].map((t) => bag.add(t));
    const lits = [windowLitTexture('#ffd27a', 0.5, 81), windowLitTexture('#ffe9b0', 0.4, 82, true), windowLitTexture('#ffc56a', 0.45, 83)].map((t) => bag.add(t));
    const mats = walls.map((w, i) => windowedMaterial(bag, w, i === 1 ? 13 : 11, 13, { emissiveMap: lits[i], emissive: '#ffffff', emissiveIntensity: 1.1, roughness: 0.7, metalness: 0.05 }));
    const box = bag.add(unitBox());
    const batches = mats.map((m) => new Batch(box, m, { name: 'buildings' }));
    const roofs = new Batch(box, bag.add(new THREE.MeshStandardMaterial({ color: '#f4f8ff', roughness: 0.9 })), { cast: false });
    const tints = ['#ffffff', '#f2e8dc', '#e3e9f2', '#ffe9dc', '#e9e2f5'];
    const add = (x: number, y: number, z: number, w: number, h: number, d: number, yaw: number) => {
      batches[rng.int(3)].add(x, y, z, yaw, w, h, d, rng.pick(tints));
      roofs.add(x, y + h, z, yaw, w + 0.4, 0.9, d + 0.4);
    };
    for (let p = 0; p < track.paths.length; p++) {
      for (const s of placer.along(p, 22, 9, 10, { jitter: 3 })) if (s.x < field.shoreX - 50) add(s.x, s.y - 0.2, s.z, rng.range(16, 22), rng.range(18, 70), rng.range(16, 22), s.yaw);
    }
    const rect = { minX: b.minX - 220, maxX: b.maxX - 40, minZ: b.minZ - 200, maxZ: b.maxZ + 200 };
    for (const s of placer.scatter(Math.round(200 * density), rect, 11, 10)) {
      const far = Math.min(1, Math.max(0, (b.minX - s.x) / 200));
      add(s.x, s.y - 0.2, s.z, rng.range(16, 26), rng.range(25, 80) * (1 + far * 1.6), rng.range(16, 26), Math.round(rng.next() * 4) * (Math.PI / 2));
    }
    batches.forEach((bb) => bb.build(group));
    roofs.build(group);
    // a dark Willis-like tower in the west skyline with blinking red antenna lights
    const sk = lm('skyline')[0];
    if (sk) {
      const tx = b.minX - 260, tz = sk.z;
      const dark = windowedMaterial(bag, bag.add(windowTexture({ wall: '#24262c', glass: '#3a4252', glass2: '#4a556a', seed: 74 })), 9, 14, { emissiveMap: lits[0], emissive: '#ffffff', emissiveIntensity: 0.9 });
      for (const [i, j, h] of [[-1, -1, 160], [0, -1, 205], [1, -1, 160], [-1, 0, 230], [0, 0, 270], [1, 0, 205], [-1, 1, 160], [0, 1, 230], [1, 1, 270]] as const) {
        const m = new THREE.Mesh(bag.add(boxUV(13, h, 13, tx + i * 13, 0, tz + j * 13)), dark);
        group.add(m);
      }
      const blink = glowMat('#ff2a2a');
      for (const [dx, dz, h] of [[4, 6, 340], [11, 19, 332]]) {
        parts.push([new THREE.CylinderGeometry(0.8, 1.2, 66, 6), '#dddddd', M.t(tx + dx, 270 + 33, tz + dz)]);
        const l = new THREE.Mesh(bag.add(new THREE.SphereGeometry(1.4, 8, 6)), blink);
        l.position.set(tx + dx, h, tz + dz);
        group.add(l);
      }
      updaters.push((_dt, t) => blink.color.setRGB(Math.sin(t * 3) > 0 ? 1 : 0.15, 0.05, 0.05));
    }
  }

  /* ------------------------------------------------ street lamps + holiday light strings */
  {
    const lamps = new Batch(bag.add(PROPS.lamp('#1d2430', '#fff1c4')), vc, { name: 'lamps' });
    const halos: number[] = [];
    const bulbsA: Array<[number, number, number, string]> = [];
    const bulbsB: Array<[number, number, number, string]> = [];
    const cols = ['#ff3b3b', '#3ccf6e', '#ffd23f', '#3aa8ff', '#ff7ad9'];
    for (let p = 0; p < track.paths.length; p++) {
      const path = track.paths[p];
      for (const side of [-1, 1]) {
        let prev: { x: number; y: number; z: number } | null = null;
        for (let s = 0; s < path.length; s += 18) {
          const smp = track.sampleAt(p, s);
          if (smp.gap) {
            prev = null;
            continue;
          }
          const lat = side * (smp.halfWidth + def.shoulder + 1.0);
          const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
          if (field.clearance(x, z) < 0.3 || field.insideOther(x, z, p)) {
            prev = null;
            continue;
          }
          const y = field.height(x, z);
          lamps.add(x, y, z, Math.atan2(-smp.nx * side, -smp.nz * side));
          halos.push(x - smp.nx * side * 1.4, y + 6.5, z - smp.nz * side * 1.4);
          const top = { x, y: y + 5.6, z };
          if (prev && Math.hypot(prev.x - top.x, prev.z - top.z) < 26) {
            const n = 12;
            for (let k = 1; k < n; k++) {
              const f = k / n;
              const sag = Math.sin(f * Math.PI) * 1.4;
              const pt: [number, number, number, string] = [prev.x + (top.x - prev.x) * f, prev.y + (top.y - prev.y) * f - sag, prev.z + (top.z - prev.z) * f, cols[(k + Math.round(s)) % cols.length]];
              (k % 2 ? bulbsA : bulbsB).push(pt);
            }
          }
          prev = top;
        }
      }
    }
    lamps.build(group);
    const bulbGeo = bag.add(new THREE.OctahedronGeometry(0.22, 0));
    const mA = glowMat('#ffffff'), mB = glowMat('#ffffff');
    for (const [arr, mat] of [[bulbsA, mA], [bulbsB, mB]] as const) {
      const bt = new Batch(bulbGeo, mat, { cast: false, receive: false, name: 'holidayLights' });
      for (const [x, y, z, c] of arr) bt.add(x, y, z, 0, 1, 1, 1, c);
      bt.build(group);
    }
    updaters.push((_dt, t) => {
      const a = 0.6 + 0.4 * Math.max(0, Math.sin(t * 2.4));
      const bb = 0.6 + 0.4 * Math.max(0, Math.sin(t * 2.4 + Math.PI));
      mA.color.setScalar(a * 1.6);
      mB.color.setScalar(bb * 1.6);
    });
    // lamp halos (one draw call)
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(halos, 3));
    bag.add(hg);
    const halo = new THREE.Points(hg, bag.add(new THREE.PointsMaterial({ map: bag.add(dotTexture('rgba(255,220,150,0.9)', 'rgba(255,200,120,0)')), size: 7, transparent: true, depthWrite: false, color: '#ffd9a0', toneMapped: false })));
    group.add(halo);
  }

  /* ------------------------------------------------ snowy trees, snowmen, buried cars, ornaments */
  {
    const rect = { minX: b.minX - 60, maxX: b.maxX + 60, minZ: b.minZ - 60, maxZ: b.maxZ + 60 };
    const pines = new Batch(bag.add(PROPS.coneTree('#2c6e4f', '#5a3a26', '#ffffff')), vc, { name: 'snowPines' });
    for (const s of placer.scatter(Math.round(150 * density), rect, 3, 3)) pines.add(s.x, s.y, s.z, s.yaw, rng.range(0.9, 1.5));
    for (const s of placer.along(0, 40, 4, 2.5)) pines.add(s.x, s.y, s.z, s.yaw, rng.range(0.8, 1.1));
    pines.build(group);
    const snowman = mergeColored([
      [new THREE.SphereGeometry(1.2, 12, 10), '#ffffff', M.t(0, 1.1, 0)],
      [new THREE.SphereGeometry(0.85, 12, 10), '#ffffff', M.t(0, 2.65, 0)],
      [new THREE.SphereGeometry(0.6, 12, 10), '#ffffff', M.t(0, 3.75, 0)],
      [new THREE.ConeGeometry(0.12, 0.6, 6).rotateX(Math.PI / 2), '#ff8a1a', M.t(0, 3.75, 0.8)],
      [new THREE.CylinderGeometry(0.45, 0.45, 0.6, 10), '#222222', M.t(0, 4.5, 0)],
      [new THREE.CylinderGeometry(0.7, 0.7, 0.08, 12), '#222222', M.t(0, 4.2, 0)],
      [new THREE.TorusGeometry(0.62, 0.15, 6, 14).rotateX(Math.PI / 2), '#d7263d', M.t(0, 3.25, 0)],
      [new THREE.BoxGeometry(0.3, 0.9, 0.12), '#d7263d', M.trs(0.4, 2.9, 0.55, 0.2, 0, 0.2)],
      [new THREE.SphereGeometry(0.08, 6, 4), '#111', M.t(0.2, 3.9, 0.55)],
      [new THREE.SphereGeometry(0.08, 6, 4), '#111', M.t(-0.2, 3.9, 0.55)],
      [new THREE.CylinderGeometry(0.04, 0.04, 1.6, 4), '#5a3a26', M.trs(1.2, 2.8, 0, 0, 0, 1.0)],
      [new THREE.CylinderGeometry(0.04, 0.04, 1.6, 4), '#5a3a26', M.trs(-1.2, 2.8, 0, 0, 0, -1.0)],
    ]);
    const snowmen = new Batch(bag.add(snowman), vc, { name: 'snowmen' });
    for (const s of placer.along(0, 75, 2.5, 1.5)) snowmen.add(s.x, s.y, s.z, s.yaw, 1.3);
    for (let i = 0; i < 10; i++) snowmen.add(field.shoreX + rng.range(30, 200), -0.5, rng.range(-300, 400), rng.next() * 6, rng.range(1.2, 2));
    snowmen.build(group);
    const carCols = ['#d7263d', '#2f7de1', '#3ccf6e', '#ffd23f', '#222831', '#9aa5b1'];
    const cars = new Batch(bag.add(PROPS.car()), vcMat(bag, { roughness: 0.4, metalness: 0.2 }), { name: 'cars' });
    const lumps = new Batch(bag.add(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)), bag.add(new THREE.MeshStandardMaterial({ color: '#f6f9ff', roughness: 0.95 })), { cast: false });
    for (const s of placer.along(0, 16, 4.6, 2.4)) {
      if (rng.chance(0.4)) continue;
      const yaw = s.yaw + Math.PI / 2;
      cars.add(s.x, s.y, s.z, yaw, 1, 1, 1, rng.pick(carCols));
      lumps.add(s.x, s.y + 1.7, s.z, yaw, 1.0, 0.7, 2.4);
    }
    cars.build(group);
    lumps.build(group);
    // ice fishing huts on the lake
    for (let i = 0; i < 8; i++) {
      const x = field.shoreX + rng.range(40, 260), z = rng.range(-250, 450);
      parts.push([new THREE.BoxGeometry(4, 3.2, 4), rng.pick(['#d7263d', '#2f7de1', '#ffd23f', '#3ccf6e']), M.trs(x, 1.1, z, 0, rng.next() * 3, 0)]);
      parts.push([new THREE.ConeGeometry(3.2, 1.6, 4).rotateY(Math.PI / 4), '#ffffff', M.trs(x, 3.5, z, 0, rng.next() * 3, 0)]);
    }
    if (ornaments.length) {
      const og = bag.add(new THREE.SphereGeometry(0.75, 8, 6));
      const ob = new Batch(og, glowMat('#ffffff'), { cast: false });
      for (const o of ornaments) ob.add(o.x, o.y, o.z, 0, 1, 1, 1, o.c);
      ob.build(group);
    }
  }

  /* ------------------------------------------------ falling snow (follows the camera) */
  {
    const N = quality === 'high' ? 6000 : quality === 'medium' ? 3500 : 1800;
    const BOX = 120;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) pos.set([rng.next() * BOX, rng.next() * BOX * 0.5, rng.next() * BOX], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    bag.add(g);
    const uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uMap: { value: bag.add(dotTexture()) } };
    const mat = bag.add(new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms,
      vertexShader: `uniform float uTime; uniform vec3 uCam; varying float vA;
        void main(){
          vec3 p = position;
          p.y -= uTime * (3.0 + fract(position.x * 7.13) * 2.5);
          p.x += sin(uTime * 0.7 + position.z) * 2.0 + uTime * 1.5;
          p.z += cos(uTime * 0.5 + position.x) * 1.5;
          vec3 box = vec3(${BOX.toFixed(1)}, ${(BOX * 0.5).toFixed(1)}, ${BOX.toFixed(1)});
          vec3 rel = mod(p - uCam + box * 0.5, box) - box * 0.5;
          vec3 wp = uCam + rel + vec3(0.0, 10.0, 0.0);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          vA = smoothstep(${(BOX * 0.5).toFixed(1)}, 20.0, d) * smoothstep(0.5, 3.0, d);
          gl_PointSize = 0.45 * (300.0 / max(d, 0.5));
        }`,
      fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(1.0, 1.0, 1.0, a * vA); }`,
    }));
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    pts.onBeforeRender = (_r, _s, cam) => uniforms.uCam.value.copy(cam.position);
    group.add(pts);
    updaters.push((_dt, t) => (uniforms.uTime.value = t));
  }

  if (parts.length) {
    const m = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  return {
    update(dt: number, time: number) {
      for (const u of updaters) u(dt, time);
    },
    dispose() {
      disposeGroup(group);
      bag.dispose();
    },
  };
}

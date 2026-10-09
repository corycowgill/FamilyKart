import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { TrackSample } from '../../sim/track/Track';
import type { SceneryContext, SceneryHandle } from './types';
import { Batch, trimShadows, ctxBits, disposeGroup, flagGeometry, flagMaterial, M, mergeColored, PROPS, setInstance, unitBox, vcMat, windowedMaterial } from './common';
import { getField } from './field';
import { canvasTexture, dotTexture, flagTexture, windowLitTexture, windowTexture } from './textures';
import {
  aonCenter, bannerBatch, beefStand, bluesClub, pizzeria, chicagoTheatre, cloudGate, CTA, dibsGeo, elevatedL, glassSpireTower, hancockCenter, hotDogStand, Kit, marinaCity,
  rooftopTankGeo, tribuneTower, willisTower, wrigleyBuilding,
} from './chicagoLandmarks';

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
  const kit = new Kit(bag, group, { lit: 1.1, snow: true, quality });
  const lo = quality === 'low', hi = quality === 'high';
  const shirt = ['#d7263d', '#2f7de1', '#3ccf6e', '#ffd23f', '#b26bff', '#ff8a3d', '#ffffff', '#41B6E6'];
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
  /* ------------------------------------------------ signature skyline to the west (lit windows) */
  {
    const land = (x: number, z: number, r: number) => {
      placer.reserve(x, z, r);
      return field.height(x, z);
    };
    willisTower(kit, -265, land(-265, 40, 32), 40);
    hancockCenter(kit, -205, land(-205, 300, 30), 300, 0.2);
    glassSpireTower(kit, -250, land(-250, 175, 26), 175, 0.1);
    aonCenter(kit, -225, land(-225, -205, 26), -205);
    marinaCity(kit, -130, land(-130, 335, 30), 335, 0.3);
    if (!lo) {
      tribuneTower(kit, -170, land(-170, -90, 18), -90);
      wrigleyBuilding(kit, -120, land(-110, -300, 32), -300, 0);
    }
  }
  for (const l of lm('ltrain')) {
    elevatedL(kit, placer, {
      a: [-260, l.z], b: [272, l.z], snow: true, lit: true,
      lines: lo ? [CTA.red] : [CTA.red, CTA.brown],
      cars: lo ? 4 : 5,
      stations: [{ at: 0.42, name: 'WASHINGTON/WABASH', color: CTA.brown }],
      period: 26,
    });
  }

  /* ------------------------------------------------ blues clubs (before the street walls are filled in) */
  for (const sp of placer.along(0, lo ? 1600 : 640, 14, 9, { side: 0 })) bluesClub(kit, sp.x, sp.y, sp.z, sp.yaw);

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
    // spiral of warm light strings around the tree
    for (let i = 0; i < 160; i++) {
      const f = i / 160;
      const a = f * Math.PI * 2 * 7;
      const yy = 3.0 * s + f * 8.4 * s;
      const rr = (1 - f) * 2.75 * s + 0.4;
      kit.glow.push([new THREE.OctahedronGeometry(0.32, 0), ['#fff1b0', '#ffd27a', '#ff6b5a', '#8fd8ff'][i % 4], M.t(c.x + Math.cos(a) * rr, y0 + yy, c.z + Math.sin(a) * rr)]);
    }
    // Christkindlmarket: wooden stalls with striped roofs + string lights in a ring around the tree
    const stall = mergeColored([
      [new THREE.BoxGeometry(4.4, 2.6, 3.2), '#8a5a36', M.t(0, 1.3, 0)],
      [new THREE.BoxGeometry(3.6, 1.2, 0.2), '#2a1a10', M.t(0, 1.75, 1.62)],
      [new THREE.BoxGeometry(4.0, 0.2, 0.7), '#b07a4a', M.t(0, 1.1, 1.9)],
      [new THREE.BoxGeometry(5.0, 0.18, 2.3), '#ffffff', M.trs(0, 3.2, 0.95, 0.55, 0, 0)],
      [new THREE.BoxGeometry(5.0, 0.18, 2.3), '#ffffff', M.trs(0, 3.2, -0.95, -0.55, 0, 0)],
      [new THREE.BoxGeometry(5.0, 0.2, 2.0), '#f4f8ff', M.trs(0, 3.35, 0.85, 0.55, 0, 0)],
      [new THREE.BoxGeometry(5.0, 0.2, 2.0), '#f4f8ff', M.trs(0, 3.35, -0.85, -0.55, 0, 0)],
      [new THREE.BoxGeometry(3.0, 0.7, 0.12), '#1f6b3a', M.t(0, 2.9, 1.95)],
      [new THREE.BoxGeometry(5.1, 0.25, 0.25), '#2f7a3a', M.t(0, 2.55, 2.0)],
    ]);
    const bulbs: P = [];
    for (let i = 0; i < 11; i++) bulbs.push([new THREE.OctahedronGeometry(0.13, 0), ['#ffe08a', '#ff5a5a', '#7fe08a', '#8fd8ff'][i % 4], M.t(-2.4 + i * 0.48, 2.42 - Math.sin((i / 10) * Math.PI) * 0.25, 2.15)]);
    const stalls = kit.batch(stall, kit.tintMat, { name: 'marketStalls' });
    const lights = kit.batch(mergeColored(bulbs), kit.glowMat, { name: 'marketLights', cast: false });
    const nStall = lo ? 6 : hi ? 16 : 11;
    let placed = 0;
    for (let i = 0; i < 40 && placed < nStall; i++) {
      const ring = i < 14 ? 24 : 36;
      const a = (i / (i < 14 ? 14 : 26)) * Math.PI * 2 + (ring > 30 ? 0.12 : 0);
      const x = c.x + Math.cos(a) * ring, z = c.z + Math.sin(a) * ring;
      if (!placer.ok(x, z, 3.2, 3)) continue;
      placer.reserve(x, z, 3.2);
      const yaw = Math.atan2(c.x - x, c.z - z);
      const yy = field.height(x, z);
      stalls.add(x, yy, z, yaw, 1, 1, 1, rng.pick(['#d7263d', '#1f8f4a', '#d7263d', '#ffd23f']));
      lights.add(x, yy, z, yaw);
      placed++;
      if (!lo) for (let p = 0; p < (hi ? 3 : 2); p++) {
        const d = ring - rng.range(4, 9), aa = a + rng.range(-0.12, 0.12);
        const px = c.x + Math.cos(aa) * d, pz = c.z + Math.sin(aa) * d;
        kit.person(px, field.height(px, pz), pz, yaw + Math.PI + rng.range(-0.6, 0.6), rng.pick(shirt));
      }
    }
    const sign = kit.paint.text('CHRISTKINDLMARKET', 512, 96, { bg: '#7a1420', fg: '#ffe9b0', border: '#ffd23f' });
    const gx = c.x + 18, gz = c.z - 46;
    if (placer.ok(gx, gz, 4, 2)) {
      kit.solid.push([new THREE.BoxGeometry(0.5, 6, 0.5), '#5a3a26', M.t(gx - 6, 3, gz)]);
      kit.solid.push([new THREE.BoxGeometry(0.5, 6, 0.5), '#5a3a26', M.t(gx + 6, 3, gz)]);
      kit.paint.quad(sign, 12.5, 2.3, M.trs(gx, 6.2, gz, 0, 0, 0), true);
    }
  }
  // the Bean, dusted with snow, with a few admirers
  for (const c of lm('bean')) {
    cloudGate(kit, c.x, field.height(c.x, c.z), c.z, 0.2);
    placer.reserve(c.x, c.z, 27);
    if (!lo) for (let i = 0; i < (hi ? 16 : 8); i++) {
      const a = rng.next() * Math.PI * 2, d = rng.range(13, 21);
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      kit.person(x, field.height(x, z) + 0.4, z, Math.atan2(c.x - x, c.z - z), rng.pick(shirt), rng.range(0.7, 1));
    }
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
    const lat = side * (smp.halfWidth + def.shoulder + 12);
    const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
    const yaw = Math.atan2(-smp.nx * side, -smp.nz * side);
    chicagoTheatre(kit, x, field.height(x, z), z, yaw, ['HAPPY HOLIDAYS', 'SNOWPOCALYPSE TONIGHT!']);
    placer.reserve(x - Math.sin(yaw) * 9, z - Math.cos(yaw) * 9, 20);
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
    const tanks = new Batch(bag.add(rooftopTankGeo(true)), vc, { name: 'rooftopTanks' });
    const add = (x: number, y: number, z: number, w: number, h: number, d: number, yaw: number) => {
      batches[rng.int(3)].add(x, y, z, yaw, w, h, d, rng.pick(tints));
      roofs.add(x, y + h, z, yaw, w + 0.4, 0.9, d + 0.4);
      if (h < 50 && rng.chance(0.45)) tanks.add(x + rng.range(-w, w) * 0.25, y + h + 0.9, z + rng.range(-d, d) * 0.25, rng.next() * 6, 1.1);
    };
    // street-level shops: glowing windows + colorful awnings on the buildings facing the road
    const shopGeo = mergeColored([
      [new THREE.BoxGeometry(13, 0.16, 1.8), '#ffffff', M.trs(0, 3.7, 0.8, 0.35, 0, 0)],
      [new THREE.BoxGeometry(13.4, 1.0, 0.25), '#ffffff', M.t(0, 4.6, 0.1)],
      [new THREE.BoxGeometry(0.3, 3.3, 0.3), '#2a2a2a', M.t(-6.4, 1.65, 0.15)],
      [new THREE.BoxGeometry(0.3, 3.3, 0.3), '#2a2a2a', M.t(6.4, 1.65, 0.15)],
    ]);
    const shops = kit.batch(shopGeo, kit.tintMat, { name: 'shops', cast: false });
    const shopGlow = kit.batch(mergeColored([[new THREE.BoxGeometry(12, 2.6, 0.12), '#ffffff', M.t(0, 1.7, 0.08)]]), kit.glowMat, { name: 'shopWindows', cast: false });
    const awn = ['#d7263d', '#1f8f4a', '#2f6fd1', '#ffb02e', '#7a2fb0', '#d7263d', '#13806f'];
    const glowC = ['#ffd9a0', '#ffe8c4', '#ffc98a', '#fff1d6'];
    for (let p = 0; p < track.paths.length; p++) {
      for (const s of placer.along(p, 22, 17, 10, { jitter: 2 })) {
        if (s.x >= field.shoreX - 50) continue;
        const w = rng.range(16, 22), d = rng.range(16, 20);
        add(s.x, s.y - 0.2, s.z, w, rng.range(18, 70), d, s.yaw);
        const fx = s.x + Math.sin(s.yaw) * (d / 2 + 0.05), fz = s.z + Math.cos(s.yaw) * (d / 2 + 0.05);
        shops.add(fx, s.y - 0.2, fz, s.yaw, w / 14, 1, 1, rng.pick(awn));
        shopGlow.add(fx, s.y - 0.2, fz, s.yaw, w / 14, 1, 1, rng.pick(glowC));
      }
    }
    const rect = { minX: b.minX - 220, maxX: b.maxX - 40, minZ: b.minZ - 200, maxZ: b.maxZ + 200 };
    for (const s of placer.scatter(Math.round(200 * density), rect, 11, 10)) {
      const far = Math.min(1, Math.max(0, (b.minX - s.x) / 200));
      add(s.x, s.y - 0.2, s.z, rng.range(16, 26), rng.range(25, 80) * (1 + far * 1.6), rng.range(16, 26), Math.round(rng.next() * 4) * (Math.PI / 2));
    }
    batches.forEach((bb) => bb.build(group));
    roofs.build(group);
    tanks.build(group);
  }

  /* ------------------------------------------------ street lamps + holiday light strings */
  {
    const lamps = new Batch(bag.add(PROPS.lamp('#1d2430', '#fff1c4')), vc, { name: 'lamps' });
    const halos: number[] = [];
    const banners = lo ? null : bannerBatch(kit);
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
          const lyaw = Math.atan2(-smp.nx * side, -smp.nz * side);
          lamps.add(x, y, z, lyaw);
          if (banners && Math.round(s / 18) % 2 === 0) banners.add(x, y + 3.9, z, lyaw - Math.PI / 2);
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
    const dibs = kit.batch(dibsGeo(), kit.tintMat, { name: 'dibs', cast: false });
    for (const s of placer.along(0, 16, 4.6, 2.4)) {
      if (rng.chance(0.4)) {
        // a shoveled-out parking spot saved with a lawn chair: classic Chicago "dibs"
        if (rng.chance(0.55)) dibs.add(s.x, s.y, s.z, s.yaw + rng.range(-0.4, 0.4), 1.25, 1.25, 1.25, rng.pick(['#3aa8ff', '#ff5a5a', '#3ccf6e', '#ffd23f', '#ff8ad8']));
        continue;
      }
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

  /* ------------------------------------------------ Michigan Avenue trees wrapped in warm lights */
  {
    const trunk = kit.batch(mergeColored([
      [new THREE.CylinderGeometry(0.22, 0.32, 4.2, 6), '#3a2a20', M.t(0, 2.1, 0)],
      [new THREE.CylinderGeometry(0.08, 0.14, 2.6, 5), '#3a2a20', M.trs(0.6, 4.6, 0, 0, 0, -0.6)],
      [new THREE.CylinderGeometry(0.08, 0.14, 2.6, 5), '#3a2a20', M.trs(-0.6, 4.6, 0.2, 0, 0, 0.6)],
      [new THREE.CylinderGeometry(0.08, 0.14, 2.4, 5), '#3a2a20', M.trs(0, 4.7, 0.6, 0.6, 0, 0)],
      [new THREE.CylinderGeometry(0.08, 0.14, 2.4, 5), '#3a2a20', M.trs(0, 4.7, -0.6, -0.6, 0, 0)],
      [new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, 1.2), '#f4f8ff', M.trs(0, 0, 0, 0, 0, 0, 1.0, 0.25, 1.0)],
    ]), vc, { name: 'lightTrees' });
    const pts: number[] = [];
    const cols: number[] = [];
    const warm = [new THREE.Color('#ffd27a'), new THREE.Color('#fff1c4'), new THREE.Color('#ffb85a')];
    for (let p = 0; p < track.paths.length; p++) {
      for (const sp of placer.along(p, lo ? 60 : 30, 3.2, 2, { jitter: 0.3 })) {
        trunk.add(sp.x, sp.y, sp.z, rng.next() * 6, 1.45);
        const n = lo ? 40 : hi ? 110 : 70;
        for (let i = 0; i < n; i++) {
          const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * 3.4, yy = rng.range(4.6, 10.2);
          pts.push(sp.x + Math.cos(a) * r * (1.25 - (yy - 4.6) / 8), sp.y + yy, sp.z + Math.sin(a) * r * (1.25 - (yy - 4.6) / 8));
          const c = rng.pick(warm);
          cols.push(c.r, c.g, c.b);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    bag.add(g);
    const tm = bag.add(new THREE.PointsMaterial({ size: 0.8, map: bag.add(dotTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)')), vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, color: new THREE.Color(1.6, 1.5, 1.3) }));
    const tp = new THREE.Points(g, tm);
    tp.name = 'treeLights';
    group.add(tp);
  }

  /* ------------------------------------------------ steaming manholes + hot dog stands + flags */
  {
    const vents: number[] = [];
    for (const sp of placer.along(0, lo ? 200 : 110, 1.2, 1.2)) vents.push(sp.x, sp.y, sp.z);
    for (let i = 0; i < vents.length; i += 3) parts.push([new THREE.CylinderGeometry(0.7, 0.7, 0.1, 12), '#3a3f47', M.t(vents[i], vents[i + 1] + 0.06, vents[i + 2])]);
    const PER = 14;
    const n = (vents.length / 3) * PER;
    const g = new THREE.BufferGeometry();
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.floor(i / PER) * 3;
      seeds.set([vents[v], vents[v + 1], vents[v + 2], rng.next()], i * 4);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    bag.add(g);
    const steamU = { uTime: { value: 0 }, uMap: { value: bag.add(dotTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)')) } };
    const steamMat = bag.add(new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: steamU,
      vertexShader: `attribute vec4 aSeed; uniform float uTime; varying float vA;
        void main(){
          float life = fract(uTime * 0.22 + aSeed.w);
          vec3 p = aSeed.xyz;
          p.y += 0.2 + life * 6.0;
          p.x += sin(aSeed.w * 40.0 + uTime) * life * 1.2 + life * 1.5;
          p.z += cos(aSeed.w * 23.0 + uTime * 0.7) * life * 1.2;
          vA = smoothstep(0.0, 0.15, life) * (1.0 - life) * 0.55;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1.2 + life * 3.5) * (300.0 / -mv.z);
        }`,
      fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(0.92, 0.94, 1.0, a * vA); }`,
    }));
    const steam = new THREE.Points(g, steamMat);
    steam.frustumCulled = false;
    steam.name = 'manholeSteam';
    group.add(steam);
    updaters.push((_dt, t) => (steamU.uTime.value = t));

    const standSpots = placer.along(0, lo ? 500 : 230, 7, 6.5, { side: 0 });
    standSpots.forEach((sp, i) => {
      [hotDogStand, pizzeria, hotDogStand, beefStand][i % 4](kit, sp.x, sp.y, sp.z, sp.yaw);
      if (!lo) for (let k = 0; k < (hi ? 3 : 2); k++) {
        const lx = -1.6 + k * 1.6, lz = 4.2;
        const cx = sp.x + Math.cos(sp.yaw) * lx + Math.sin(sp.yaw) * lz, cz = sp.z - Math.sin(sp.yaw) * lx + Math.cos(sp.yaw) * lz;
        kit.person(cx, field.height(cx, cz), cz, sp.yaw + Math.PI, rng.pick(shirt));
      }
    });
    const fp = kit.batch(PROPS.flagpole(), vc, { name: 'flagpoles' });
    const fl = kit.batch(flagGeometry(2.6, 1.7), flagMaterial(bag, bag.add(flagTexture('chicago')), kit.time), { cast: false, name: 'flags' });
    for (const sp of placer.along(0, lo ? 160 : 80, 2.2, 1)) {
      fp.add(sp.x, sp.y, sp.z, 0);
      fl.add(sp.x, sp.y + 7.9, sp.z, Math.PI / 2 + 0.6);
    }
  }

  /* ------------------------------------------------ frozen lake ice floes */
  {
    const floe = kit.batch(new THREE.IcosahedronGeometry(1, 0), bag.add(new THREE.MeshStandardMaterial({ color: '#e6f4ff', roughness: 0.25, metalness: 0.05, flatShading: true })), { name: 'iceFloes', cast: false });
    const N = lo ? 30 : hi ? 120 : 70;
    for (let i = 0; i < N; i++) {
      const x = field.shoreX + rng.range(4, 90) * (rng.chance(0.7) ? 1 : 3), z = rng.range(b.minZ - 300, b.maxZ + 300);
      floe.add(x, -0.6, z, rng.next() * 6, rng.range(2, 6), rng.range(0.4, 1.2), rng.range(2, 5), rng.pick(['#ffffff', '#dff1ff', '#cfe8fb']));
    }
  }

  kit.flush();

  if (parts.length) {
    const m = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  trimShadows(group, quality);

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

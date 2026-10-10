import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SceneryContext, SceneryHandle } from './types';
import { addClouds, Batch, trimShadows, ctxBits, disposeGroup, flagGeometry, flagMaterial, M, mergeColored, PROPS, setInstance, type Spot, vcMat } from './common';
import { getField } from './field';
import { flagTexture } from './textures';
import {
  aonCenter, ballpark, beefStand, bluesClub, bungalow, pizzeria, popcornShop, windGusts, buildChicagoFlag, CTA, frameHouse, twoFlat, cornerTavern, dibsGeo, elevatedL, faceRoad, findSpot, glassSpireTower, hancockCenter, hotDogStand, Kit, marinaCity, willisTower,
  runningDogs,
} from './chicagoLandmarks';

type P = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;

export function buildNeighborhood(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const rng = new Rng(777);
  const def = track.def;
  const lm = (kind: string) => def.landmarks.filter((l) => l.kind === kind);
  const updaters: Array<(dt: number, t: number) => void> = [];
  const timeU = { value: 0 };
  const vc = vcMat(bag);
  const vcBody = vcMat(bag, { roughness: 0.85 });
  const b = field.bounds;
  const kit = new Kit(bag, group, { lit: 0, snow: false, quality });
  const lo = quality === 'low', hi = quality === 'high';
  const shirt = ['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#41B6E6'];

  /* ------------------------------------------------ the L behind the houses, the ballpark, the skyline */
  for (const l of lm('ltrain')) {
    elevatedL(kit, placer, {
      a: [l.x, b.minZ - 110], b: [l.x, b.maxZ + 80],
      lines: lo ? [CTA.red] : [CTA.red, CTA.purple],
      cars: lo ? 4 : 6,
      stations: [{ at: (-150 - (b.minZ - 110)) / (b.maxZ + 80 - (b.minZ - 110)), name: 'ADDISON', color: CTA.red }],
      period: 22,
    });
  }
  for (const c of lm('ballpark')) {
    ballpark(kit, c.x, field.height(c.x, c.z), c.z, c.rot ?? 0);
    placer.reserve(c.x, c.z, 64);
    // fans streaming toward the marquee
    if (!lo) for (let i = 0; i < (hi ? 30 : 14); i++) {
      const a = (c.rot ?? 0) + rng.range(-0.5, 0.5), d = rng.range(60, 74);
      const x = c.x + Math.sin(a) * d, z = c.z + Math.cos(a) * d;
      kit.person(x, field.height(x, z), z, a + Math.PI, rng.pick(['#1d3f8f', '#c8102e', '#ffffff', '#1d3f8f']));
    }
  }
  for (const c of lm('skyline')) {
    // the downtown skyline on the horizon
    const y0 = -2;
    willisTower(kit, c.x - 120, y0, c.z + 60, 0.2, 0.95);
    hancockCenter(kit, c.x + 160, y0, c.z - 40, 0.1, 0.95);
    glassSpireTower(kit, c.x + 40, y0, c.z + 10, -0.2, 0.9);
    aonCenter(kit, c.x - 260, y0, c.z + 120, 0, 0.9);
    marinaCity(kit, c.x + 10, y0, c.z - 120, 0.4, 0.9);
  }
  {
    const p = findSpot(placer, 270, 150, 9, 3, 40);
    if (p) {
      bluesClub(kit, p.x, field.height(p.x, p.z), p.z, faceRoad(placer, p.x, p.z));
      placer.reserve(p.x, p.z, 9);
    }
  }
  for (const c of lm('tavern')) {
    const p = findSpot(placer, c.x, c.z, 9, 2) ?? c;
    cornerTavern(kit, p.x, field.height(p.x, p.z), p.z, faceRoad(placer, p.x, p.z));
    placer.reserve(p.x, p.z, 9);
  }
  {
    const spots = placer.along(0, lo ? 600 : 260, 6, 6.5, { side: 0 });
    for (const [i, sp] of spots.entries()) {
      [hotDogStand, pizzeria, hotDogStand, beefStand, popcornShop][i % 5](kit, sp.x, sp.y, sp.z, sp.yaw);
      if (!lo) for (let k = 0; k < (hi ? 3 : 2); k++) {
        const lx = -1.6 + k * 1.6, lz = 4.2;
        const cx = sp.x + Math.cos(sp.yaw) * lx + Math.sin(sp.yaw) * lz, cz = sp.z - Math.sin(sp.yaw) * lx + Math.cos(sp.yaw) * lz;
        kit.person(cx, field.height(cx, cz), cz, sp.yaw + Math.PI, rng.pick(shirt));
      }
    }
  }

  /* ------------------------------------------------ landmarks first (reserve space) */
  const lmParts: P = [];
  // church
  for (const c of lm('church')) {
    const m = M.trs(c.x, field.height(c.x, c.z), c.z, 0, c.rot ?? 0, 0);
    const part = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => lmParts.push([g, col, m.clone().multiply(local)]);
    part(new THREE.BoxGeometry(18, 12, 34), '#9c4a35', M.t(0, 6, 0));
    const roof = new THREE.CylinderGeometry(0.01, 12.5, 7, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 2.0);
    part(roof, '#3f4a5a', M.t(0, 15.5, 0));
    part(new THREE.BoxGeometry(7, 26, 7), '#a8553d', M.t(0, 13, 19));
    part(new THREE.ConeGeometry(4.6, 14, 4).rotateY(Math.PI / 4), '#3f4a5a', M.t(0, 33, 19));
    part(new THREE.BoxGeometry(0.4, 3, 0.4), '#ffd23f', M.t(0, 41.5, 19));
    part(new THREE.BoxGeometry(2, 0.4, 0.4), '#ffd23f', M.t(0, 41.8, 19));
    part(new THREE.CylinderGeometry(2, 2, 0.4, 16).rotateX(Math.PI / 2), '#ffcf6b', M.t(0, 20, 22.6));
    part(new THREE.BoxGeometry(3, 5, 0.3), '#5a2f1c', M.t(0, 2.5, 22.6));
    for (const z of [-12, -6, 0, 6, 12]) {
      part(new THREE.BoxGeometry(0.3, 5, 2), '#6fb3e0', M.t(9.05, 6.5, z));
      part(new THREE.BoxGeometry(0.3, 5, 2), '#e07a6f', M.t(-9.05, 6.5, z));
    }
    placer.reserve(c.x, c.z, 24);
  }
  // school
  for (const c of lm('school')) {
    const m = M.trs(c.x, field.height(c.x, c.z), c.z, 0, c.rot ?? 0, 0);
    const part = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => lmParts.push([g, col, m.clone().multiply(local)]);
    part(new THREE.BoxGeometry(50, 13, 20), '#b5654a', M.t(0, 6.5, 0));
    part(new THREE.BoxGeometry(51, 1, 21), '#e8dcc0', M.t(0, 13.3, 0));
    part(new THREE.BoxGeometry(10, 16, 21), '#c17a5c', M.t(0, 8, 0));
    part(new THREE.CylinderGeometry(0.15, 0.15, 12, 6), '#ddd', M.t(14, 6, 14));
    for (let x = -22; x <= 22; x += 4) for (const y of [3.5, 8.5]) part(new THREE.BoxGeometry(2.2, 2.6, 0.3), '#2e4a6b', M.t(x, y, 10.05));
    placer.reserve(c.x, c.z, 30);
  }
  // corner store with an awning
  for (const c of lm('cornerStore')) {
    const m = M.trs(c.x, field.height(c.x, c.z), c.z, 0, c.rot ?? 0, 0);
    const part = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => lmParts.push([g, col, m.clone().multiply(local)]);
    part(new THREE.BoxGeometry(14, 9, 12), '#c96f4a', M.t(0, 4.5, 0));
    part(new THREE.BoxGeometry(14.4, 0.6, 12.4), '#e9dcc4', M.t(0, 9.2, 0));
    part(new THREE.BoxGeometry(12, 3, 0.3), '#cfe8ff', M.t(0, 2.2, 6.05));
    for (let i = 0; i < 6; i++) part(new THREE.BoxGeometry(2, 0.2, 2.4), i % 2 ? '#ffffff' : '#2fa84f', M.trs(-5 + i * 2, 4.2, 7.0, 0.35, 0, 0));
    placer.reserve(c.x, c.z, 12);
  }
  // water tower
  for (const c of lm('watertower')) {
    const y0 = field.height(c.x, c.z);
    for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) lmParts.push([new THREE.CylinderGeometry(0.4, 0.5, 22, 6), '#6b4a33', M.t(c.x + dx, y0 + 11, c.z + dz)]);
    lmParts.push([new THREE.CylinderGeometry(6, 6, 9, 16), '#8a5a3a', M.t(c.x, y0 + 26.5, c.z)]);
    lmParts.push([new THREE.ConeGeometry(6.6, 4, 16), '#5a3a26', M.t(c.x, y0 + 33, c.z)]);
    placer.reserve(c.x, c.z, 9);
  }
  // playground park
  for (const c of lm('park')) {
    const y0 = field.height(c.x, c.z);
    const m = M.t(c.x, y0, c.z);
    const part = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => lmParts.push([g, col, m.clone().multiply(local)]);
    part(new THREE.CylinderGeometry(16, 16, 0.2, 24), '#d9b77a', M.t(0, 0.1, 0));
    // swing set
    part(new THREE.BoxGeometry(10, 0.3, 0.3), '#e23d3d', M.t(-6, 4, 0));
    for (const x of [-11, -1]) {
      part(new THREE.BoxGeometry(0.3, 4.4, 0.3), '#e23d3d', M.trs(-6 + (x + 6), 2, 1, 0.35, 0, 0));
      part(new THREE.BoxGeometry(0.3, 4.4, 0.3), '#e23d3d', M.trs(-6 + (x + 6), 2, -1, -0.35, 0, 0));
    }
    for (const x of [-8, -4]) part(new THREE.BoxGeometry(1, 0.15, 0.5), '#ffd23f', M.t(x, 1.2, 0));
    // slide tower
    part(new THREE.BoxGeometry(3, 3, 3), '#2f7de1', M.t(6, 1.5, 0));
    part(new THREE.ConeGeometry(2.4, 2, 4).rotateY(Math.PI / 4), '#ffd23f', M.t(6, 4, 0));
    part(new THREE.BoxGeometry(1.4, 0.2, 6), '#3ccf6e', M.trs(6, 1.6, 4.2, 0.5, 0, 0));
    // sandbox + bench
    part(new THREE.BoxGeometry(5, 0.5, 5), '#c49a5a', M.t(0, 0.25, -9));
    placer.reserve(c.x, c.z, 18);
  }
  // garages lining the alley shortcut
  {
    const sc = track.paths[1];
    if (sc) {
      const gparts: P = [];
      for (let s = 10; s < sc.length - 30; s += 9) {
        const smp = track.sampleAt(1, s);
        for (const side of [-1, 1]) {
          const lat = side * (smp.halfWidth + def.shoulder + 4.5);
          const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
          if (!placer.ok(x, z, 3.5, 0.5)) continue;
          placer.reserve(x, z, 3.5);
          const yaw = Math.atan2(-smp.nx * side, -smp.nz * side);
          const m = M.trs(x, field.height(x, z), z, 0, yaw, 0);
          const col = rng.pick(['#b8b0a2', '#c96f4a', '#e6d8b8', '#9fb7c9', '#d9a5a5']);
          gparts.push([new THREE.BoxGeometry(7, 3.4, 7), col, m.clone().multiply(M.t(0, 1.7, 0))]);
          gparts.push([new THREE.BoxGeometry(7.4, 0.4, 7.4), '#4a4f5a', m.clone().multiply(M.t(0, 3.6, 0))]);
          gparts.push([new THREE.BoxGeometry(5, 2.6, 0.15), rng.pick(['#f2f2f2', '#d0d6dd', '#7aa3c7']), m.clone().multiply(M.t(0, 1.4, 3.53))]);
          if (rng.chance(0.25)) {
            gparts.push([new THREE.BoxGeometry(0.15, 1.6, 1.2), '#ffffff', m.clone().multiply(M.t(0, 4.6, 3.3))]);
            gparts.push([new THREE.TorusGeometry(0.35, 0.05, 4, 10).rotateX(Math.PI / 2), '#ff6a00', m.clone().multiply(M.t(0, 4.2, 4.0))]);
          }
        }
      }
      const gm = new THREE.Mesh(bag.add(mergeColored(gparts)), vc);
      gm.castShadow = gm.receiveShadow = true;
      group.add(gm);
    }
  }
  // kiddie pool after the alley ramp
  for (const c of lm('pool')) {
    const sc = track.paths[1];
    const r = track.ramps.find((rr) => rr.pathId === 1);
    const smp = sc && r ? track.sampleAt(1, r.s1 + 6) : null;
    const x = smp ? smp.x : c.x, z = smp ? smp.z : c.z;
    const y0 = smp ? smp.y : field.height(x, z);
    lmParts.push([new THREE.TorusGeometry(3.2, 0.5, 8, 24).rotateX(Math.PI / 2), '#3aa8ff', M.t(x, y0 + 0.4, z)]);
    lmParts.push([new THREE.CylinderGeometry(3.2, 3.2, 0.3, 24), '#8fe3ff', M.t(x, y0 + 0.3, z)]);
    lmParts.push([new THREE.SphereGeometry(0.5, 10, 8), '#ff5a5a', M.t(x + 1, y0 + 0.7, z - 0.5)]);
  }
  if (lmParts.length) {
    const m = new THREE.Mesh(bag.add(mergeColored(lmParts)), vc);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  /* ------------------------------------------------ houses along the streets */
  const types = [twoFlat(), bungalow(), frameHouse()];
  const bodyB = types.map((t) => new Batch(bag.add(t.body), vcBody, { name: 'houseBody' }));
  const detB = types.map((t) => new Batch(bag.add(t.detail), vc, { name: 'houseDetail' }));
  // far houses: same silhouette, fewer window boxes
  const farTF = twoFlat(true);
  bag.add(farTF.body);
  detB.push(new Batch(bag.add(farTF.detail), vc, { name: 'houseDetailFar' }));
  const brick = ['#b5523b', '#a8452f', '#c96f4a', '#d9a36a', '#9c3f2c', '#e0b98a', '#b86a50'];
  const greystone = ['#bdb7aa', '#cfc8b8', '#a9a397', '#d8d2c2'];
  const siding = ['#8fc1e3', '#f7d774', '#a8e0c2', '#f4a7a0', '#ffffff', '#c3b1e1'];
  // porch flags: Chicago (mostly) and US flags on little angled poles
  const porchPole = kit.batch(mergeColored([[new THREE.CylinderGeometry(0.04, 0.04, 2.2, 5), '#e0e0e0', M.trs(0, 0.8, 0.75, 0.75, 0, 0)]]), vc, { cast: false, name: 'porchPoles' });
  const chiTex = bag.add(flagTexture('chicago')), usaTex = bag.add(flagTexture('usa'));
  const porchChi = kit.batch(flagGeometry(1.5, 1.0), flagMaterial(bag, chiTex, timeU), { cast: false, name: 'porchFlagsChi' });
  const porchUsa = kit.batch(flagGeometry(1.5, 1.0), flagMaterial(bag, usaTex, timeU), { cast: false, name: 'porchFlagsUsa' });
  const front: Array<[number, number, number]> = [[3.7, 4.6, 7.2], [4.2, 3.3, 9.6], [3.5, 4.6, 6.2]];
  const addHouse = (s: Spot, near: boolean) => {
    const t = rng.int(3);
    const col = t === 2 ? rng.pick(siding) : t === 0 && rng.chance(0.4) ? rng.pick(greystone) : rng.pick(brick);
    bodyB[t].add(s.x, s.y, s.z, s.yaw, 1, 1, 1, col);
    detB[t === 0 && !near ? 3 : t].add(s.x, s.y, s.z, s.yaw, 1, 1, 1);
    if (near && !lo && rng.chance(0.4)) {
      const [lx, ly, lz] = front[t];
      const cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      const wx = s.x + cs * lx + sn * lz, wz = s.z - sn * lx + cs * lz;
      porchPole.add(wx, s.y + ly, wz, s.yaw);
      // tip of the angled pole
      const tx = wx + sn * 1.5, tz = wz + cs * 1.5;
      (rng.chance(0.75) ? porchChi : porchUsa).add(tx, s.y + ly + 1.6, tz, s.yaw + Math.PI / 2, 1, 1, 1);
    }
  };
  for (let p = 0; p < track.paths.length; p++) {
    const off = p === 0 ? 14 : 13;
    for (const s of placer.along(p, 15, off, 7.5, { jitter: 1.5 })) addHouse(s, true);
  }
  // fill the blocks beyond with more houses on a loose grid
  const fillRect = { minX: b.minX - 125, maxX: b.maxX + 125, minZ: b.minZ - 125, maxZ: b.maxZ + 125 };
  const step = quality === 'high' ? 19 : quality === 'medium' ? 23 : 30;
  for (let x = fillRect.minX; x < fillRect.maxX; x += step) {
    for (let z = fillRect.minZ; z < fillRect.maxZ; z += 26) {
      const jx = x + rng.range(-2, 2), jz = z + rng.range(-2, 2);
      if (!placer.ok(jx, jz, 8, 22)) continue;
      placer.reserve(jx, jz, 8);
      addHouse({ x: jx, y: field.height(jx, jz), z: jz, yaw: (Math.floor(z / 26) % 2 ? 0 : Math.PI) + rng.range(-0.03, 0.03) }, false);
    }
  }
  bodyB.forEach((bb) => bb.build(group));
  detB.forEach((bb) => bb.build(group));

  /* ------------------------------------------------ parkway trees, lamps, parked cars, props */
  {
    const elm = new Batch(bag.add(PROPS.roundTree('#3f9d3f', '#64bf4f', '#6b4a2b')), vc, { name: 'elms' });
    const maple = new Batch(bag.add(PROPS.roundTree('#e0882c', '#f2b13c', '#6b4a2b')), vc, { name: 'maples' });
    for (let p = 0; p < track.paths.length; p++) {
      for (const s of placer.along(p, 19, 2.6, 2.2, { jitter: 1 })) (rng.chance(0.82) ? elm : maple).add(s.x, s.y, s.z, rng.next() * 6, rng.range(1.0, 1.35));
    }
    for (const s of placer.scatter(Math.round(320 * density), fillRect, 3, 6)) (rng.chance(0.85) ? elm : maple).add(s.x, s.y, s.z, s.yaw, rng.range(0.9, 1.4));
    elm.build(group);
    maple.build(group);

    const lamps = new Batch(bag.add(PROPS.lamp('#1f3b2d', '#fff1c4')), vc, { name: 'lamps' });
    for (const s of placer.along(0, 55, 0.8, 0.6)) lamps.add(s.x, s.y, s.z, s.yaw);
    lamps.build(group);

    const cars = new Batch(bag.add(PROPS.car()), vcMat(bag, { roughness: 0.35, metalness: 0.25 }), { name: 'parkedCars' });
    const carCols = ['#e8443a', '#2f7de1', '#f5f5f5', '#222831', '#ffd23f', '#3ccf6e', '#9aa5b1', '#ff8a3d', '#6b4cd6'];
    const dibs = kit.batch(dibsGeo(), kit.tintMat, { name: 'dibs', cast: false });
    for (const s of placer.along(0, 13, 6.2, 2.4, { jitter: 0.3 })) {
      if (rng.chance(0.35)) {
        if (rng.chance(0.4)) dibs.add(s.x, s.y, s.z, s.yaw + rng.range(-0.5, 0.5), 1.2, 1.2, 1.2, rng.pick(['#3aa8ff', '#ff5a5a', '#3ccf6e', '#ffd23f', '#ff8ad8']));
        continue;
      }
      cars.add(s.x, s.y, s.z, s.yaw + Math.PI / 2 + (rng.chance(0.5) ? Math.PI : 0), 1, 1, 1, rng.pick(carCols));
    }
    cars.build(group);

    const small = (geo: THREE.BufferGeometry, spacing: number, off: number) => {
      const bt = new Batch(bag.add(geo), vc, { cast: false });
      for (const s of placer.along(0, spacing, off, 0.6)) bt.add(s.x, s.y, s.z, s.yaw);
      bt.build(group);
    };
    // fire hydrants
    small(mergeColored([
      [new THREE.CylinderGeometry(0.28, 0.32, 0.9, 8), '#ffcc00', M.t(0, 0.45, 0)],
      [new THREE.SphereGeometry(0.3, 8, 6), '#ffcc00', M.t(0, 0.95, 0)],
      [new THREE.CylinderGeometry(0.1, 0.1, 0.7, 6).rotateZ(Math.PI / 2), '#e23d3d', M.t(0, 0.6, 0)],
    ]), 110, 0.6);
    // blue recycling carts + black garbage carts
    small(mergeColored([
      [new THREE.BoxGeometry(0.75, 1.1, 0.8), '#1f5fbf', M.t(-0.5, 0.55, 0)],
      [new THREE.BoxGeometry(0.8, 0.1, 0.85), '#1a4fa0', M.t(-0.5, 1.15, 0)],
      [new THREE.BoxGeometry(0.75, 1.1, 0.8), '#2b2b2b', M.t(0.5, 0.55, 0)],
      [new THREE.BoxGeometry(0.8, 0.1, 0.85), '#222', M.t(0.5, 1.15, 0)],
    ]), 70, 4.5);
    // mailboxes
    small(mergeColored([
      [new THREE.BoxGeometry(0.1, 1.0, 0.1), '#555', M.t(0, 0.5, 0)],
      [new THREE.BoxGeometry(0.45, 0.45, 0.7), '#2f4f8f', M.t(0, 1.2, 0)],
    ]), 85, 9);
  }

  /* ------------------------------------------------ hedges / bushes + flower beds in front yards */
  {
    const bushes = new Batch(bag.add(PROPS.bush('#3f8f3a', '#5fae4a')), vc, { name: 'bushes', cast: false });
    for (const s of placer.along(0, 9, 9, 1.2, { jitter: 2 })) bushes.add(s.x, s.y, s.z, s.yaw, rng.range(0.7, 1.2));
    bushes.build(group);
  }

  /* ------------------------------------------------ flags on porches + distant downtown */
  {
    const usa = bag.add(flagTexture('usa'));
    const chi = bag.add(flagTexture('chicago'));
    const poles = new Batch(bag.add(PROPS.flagpole()), vc);
    const fa = new Batch(bag.add(flagGeometry(2.4, 1.5)), flagMaterial(bag, usa, timeU), { cast: false });
    const fb = new Batch(bag.add(flagGeometry(2.4, 1.5)), flagMaterial(bag, chi, timeU), { cast: false });
    placer.along(0, 120, 4, 1).forEach((s, i) => {
      poles.add(s.x, s.y, s.z, 0, 0.8);
      (i % 2 ? fa : fb).add(s.x, s.y + 6.4, s.z, 1.2);
    });
    poles.build(group);
    fa.build(group);
    fb.build(group);

  }

  /* ------------------------------------------------ street name signs at the corners */
  {
    const names = ['ADDISON', 'BELMONT', 'DAMEN', 'MILWAUKEE', 'HALSTED', 'LAWRENCE', 'ROSCOE', 'IRVING PARK'];
    const L = track.length;
    let k = 0;
    for (let s = 0; s < L; s += 4) {
      const smp = track.sampleAt(0, s);
      if (Math.abs(smp.curvature) < 0.02) continue;
      const lat = Math.sign(smp.curvature) * (smp.halfWidth + def.shoulder + 1.5);
      const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
      if (!placer.ok(x, z, 1, 0.5)) {
        s += 40;
        continue;
      }
      placer.reserve(x, z, 1);
      const y = field.height(x, z);
      const r = kit.paint.text(names[k++ % names.length], 384, 72, { bg: '#1d6b3a', fg: '#ffffff', border: '#ffffff' });
      const yaw = Math.atan2(smp.tx, smp.tz) + Math.PI / 2;
      kit.paint.quad(r, 3.2, 0.6, M.trs(x, y + 4.2, z, 0, yaw, 0), true);
      kit.solid.push([new THREE.CylinderGeometry(0.07, 0.07, 4.6, 6), '#5a5f66', M.t(x, y + 2.3, z)]);
      s += 60;
    }
  }

  /* ------------------------------------------------ birds + clouds */
  {
    const birdGeo = bag.add((() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.3, -0.8, 0.3, -0.1, 0, 0, -0.3, 0, 0, 0.3, 0, 0, -0.3, 0.8, 0.3, -0.1], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
      g.computeVertexNormals();
      return mergeColored([[g, '#333a44']]);
    })());
    const N = 18;
    const birds = new THREE.InstancedMesh(birdGeo, bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide })), N);
    birds.frustumCulled = false;
    const bd = Array.from({ length: N }, () => ({ cx: rng.range(b.minX, b.maxX), cz: rng.range(b.minZ, b.maxZ), r: rng.range(20, 50), h: rng.range(25, 45), w: rng.range(0.3, 0.6), ph: rng.next() * 6 }));
    group.add(birds);
    updaters.push((_dt, t) => {
      bd.forEach((g, i) => {
        const a = t * g.w + g.ph;
        setInstance(birds, i, g.cx + Math.cos(a) * g.r, g.h, g.cz + Math.sin(a) * g.r, 0, -a + Math.PI, 0, 1.5, 1.5 * (1 + Math.sin(t * 10 + g.ph) * 0.7), 1.5);
      });
      birds.instanceMatrix.needsUpdate = true;
    });
  }
  updaters.push(addClouds(ctx, bag, quality === 'low' ? 10 : 20, [140, 230], 1200, '#fff8ee', 9));

  {
    const flags = buildChicagoFlag(kit, 0.9);
    for (const sp of placer.along(0, lo ? 300 : 150, 3, 1)) flags.add(sp.x, sp.y, sp.z);
  }
  if (!lo) windGusts(kit, ['#e0882c', '#f2b13c', '#c94a2a', '#7cc65a', '#d9a63a'], hi ? 380 : 180, { speed: 8 });
  /* ------------------------------------------------ MOAR Chicago life: neighborhood dogs out for a run */
  if (!lo) runningDogs(kit, (x, z) => field.height(x, z), placer.scatter(hi ? 9 : 5, { minX: b.minX - 30, maxX: b.maxX + 30, minZ: b.minZ - 30, maxZ: b.maxZ + 30 }, 8, 3), { seed: 773 });

  kit.flush();

  trimShadows(group, quality);

  return {
    update(dt: number, time: number) {
      timeU.value = time;
      for (const u of updaters) u(dt, time);
      kit.update(dt, time);
    },
    dispose() {
      disposeGroup(group);
      bag.dispose();
    },
  };
}

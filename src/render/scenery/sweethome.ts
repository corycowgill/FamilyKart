import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SceneryContext, SceneryHandle } from './types';
import { Batch, boxUV, ctxBits, disposeGroup, M, mergeColored, PROPS, setInstance, trimShadows, unitBox, vcMat, windowedMaterial } from './common';
import { getField } from './field';
import { dotTexture, windowTexture } from './textures';
import {
  aonCenter, ballpark, basculeLeaf, beam, beefStand, bluesClub, buildChicagoFlag, buildGreenRiver, buildLakeMichigan, bannerBatch, chicagoTheatre, cloudGate,
  cornerTavern, CTA, dibsGeo, elevatedL, faceRoad, findSpot, glassSpireTower, hancockCenter, hotDogStand, Kit, lifeguardGeo, marinaCity, pizzeria, popcornShop,
  rooftopTankGeo, sweetHomeBillboard, tribuneTower, twoFlat, bungalow, waterTowerCastle, wavyTower, willisTower, windGusts, wrigleyBuilding, type P,
  kites, runningDogs,
} from './chicagoLandmarks';

/**
 * Sweet Home Chicago, the grand tour: the Magnificent Mile (Water Tower, Hancock, shops, the
 * welcome billboard and the theatre marquee), Oak Street Beach and Lake Shore Drive along Lake
 * Michigan, Wrigleyville (ivy ballpark, rooftop bleachers, taverns, the Brown Line), the yellow-lit
 * tunnel of Lower Wacker Drive under a concrete deck, and the jump over the raised bascule bridge
 * on the green Chicago River with Marina City and the Wrigley Building on the banks.
 */
export function buildSweetHome(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const def = track.def;
  const rng = new Rng(6060);
  const lm = (kind: string) => def.landmarks.find((l) => l.kind === kind);
  const kit = new Kit(bag, group, { lit: 0, snow: false, quality, atlas: 2048 }); // 1024 overflowed ("sign atlas full")
  const hi = quality === 'high', lo = quality === 'low';
  const vc = kit.solidMat;
  const updaters = kit.updaters;
  const shirt = ['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#41B6E6', '#14315e', '#ff5fa2'];
  const shoreX = field.shoreX;
  const L = track.length;
  const land = (x: number, z: number, r: number) => {
    placer.reserve(x, z, r);
    return field.height(x, z);
  };
  const people = (x: number, z: number, yaw: number, n: number, spread = 3) => {
    if (lo) return;
    for (let i = 0; i < n; i++) {
      const px = x + rng.range(-spread, spread), pz = z + rng.range(-spread, spread);
      kit.person(px, field.height(px, pz), pz, yaw + rng.range(-0.6, 0.6), rng.pick(shirt), rng.range(0.85, 1));
    }
  };

  /* ------------------------------------------------ the river channel stays clear */
  for (const c of field.channels) for (let k = -c.halfLen; k <= c.halfLen; k += 6) placer.reserve(c.cx + c.ax * k, c.cz + c.az * k, c.halfWidth + 4);

  /* ------------------------------------------------ LOWER WACKER DRIVE: deck, pillars, sodium lights */
  {
    const DECK = 1.5, THICK = 0.65, HALF = 44;
    const covered: number[] = [];
    for (let s = 0; s < L; s += 3) {
      const smp = track.sampleAt(0, s);
      if (smp.y <= -5.0) covered.push(s);
      // keep the whole trench (ramps included) free of street props
      if (smp.y < -0.2) for (let k = -30; k <= 30; k += 10) placer.reserve(smp.x + smp.nx * k, smp.z + smp.nz * k, 9);
    }
    if (covered.length) {
      const s0 = covered[0], s1 = covered[covered.length - 1];
      const shafts = [s0 + (s1 - s0) * 0.38, s0 + (s1 - s0) * 0.72];
      const concrete = '#a9a59c', dark = '#7f7c75';
      const lightPos: number[] = [];
      const beams: P = [];
      const tunnel: P = [];
      for (let s = s0; s < s1; s += 6) {
        const smp = track.sampleAt(0, s + 3);
        const yaw = Math.atan2(smp.tx, smp.tz);
        const b = M.trs(smp.x, 0, smp.z, 0, yaw, 0);
        const open = shafts.some((sh) => Math.abs(s + 3 - sh) < 3.5);
        if (!open) {
          kit.solid.push([new THREE.BoxGeometry(HALF * 2, 0.1, 6.4), concrete, b.clone().multiply(M.t(0, DECK - 0.05, 0))]);
          tunnel.push([new THREE.BoxGeometry(HALF * 2, THICK - 0.1, 6.4), '#8a8679', b.clone().multiply(M.t(0, DECK - THICK / 2 - 0.05, 0))]);
          kit.solid.push([new THREE.BoxGeometry(17, 0.06, 6.4), '#56595f', b.clone().multiply(M.t(0, DECK + 0.03, 0))]);
          if (Math.round(s / 6) % 2) kit.solid.push([new THREE.BoxGeometry(0.3, 0.07, 3), '#ffd23f', b.clone().multiply(M.t(0, DECK + 0.05, 0))]);
        } else {
          // light shaft: open slot in the deck with a soft beam of daylight
          for (const side of [-1, 1]) tunnel.push([new THREE.BoxGeometry(HALF - 10, THICK, 6.4), '#8a8679', b.clone().multiply(M.t(side * (HALF / 2 + 5), DECK - THICK / 2, 0))]);
          beams.push([new THREE.BoxGeometry(18, DECK - smp.y, 4.5), '#fff6d8', b.clone().multiply(M.trs(0, (DECK + smp.y) / 2, 0, 0, 0, 0.12))]);
        }
        for (const side of [-1, 1]) {
          kit.solid.push([new THREE.BoxGeometry(0.25, 1.1, 6.4), '#6b6f76', b.clone().multiply(M.t(side * (HALF - 0.2), DECK + 0.55, 0))]);
          // slope down to the street level outside
          kit.solid.push([new THREE.BoxGeometry(9, 0.5, 6.4), concrete, b.clone().multiply(M.trs(side * (HALF + 4.3), DECK / 2 - 0.1, 0, 0, 0, side * -0.17))]);
          // tunnel side walls just outside the pillar row (hide the embankment)
          const wl = side * (smp.halfWidth + def.shoulder + 4.6);
          tunnel.push([new THREE.BoxGeometry(1.2, DECK - smp.y + 0.5, 6.4), dark, b.clone().multiply(M.t(wl, (DECK + smp.y) / 2 - 0.25, 0))]);
        }
        // pillars outside the corridor (wall at halfWidth + shoulder)
        if (Math.round(s / 6) % 2 === 0) {
          const edge = smp.halfWidth + def.shoulder;
          for (const lat of [-(edge + 2.5), edge + 2.5]) {
            const px = smp.x + smp.nx * lat, pz = smp.z + smp.nz * lat;
            if (field.clearance(px, pz) < 1.5) continue;
            const gy = Math.min(field.height(px, pz), smp.y + 0.5);
            const h = DECK - THICK - gy;
            tunnel.push([new THREE.BoxGeometry(1.2, h, 1.2), '#9a968c', M.trs(px, gy + h / 2, pz, 0, yaw, 0)]);
            tunnel.push([new THREE.BoxGeometry(2.2, 0.6, 1.6), '#9a968c', M.trs(px, DECK - THICK - 0.3, pz, 0, yaw, 0)]);
          }
        }
        // the famous yellow-green sodium lights on the ceiling
        if (Math.round(s / 6) % 2 === 1 && !open) {
          for (const lat of [-6.5, 6.5]) {
            kit.glow.push([new THREE.BoxGeometry(0.7, 0.2, 1.8), '#e2e86a', b.clone().multiply(M.t(lat, DECK - THICK - 0.12, 0))]);
            kit.solid.push([new THREE.BoxGeometry(0.9, 0.12, 2.0), '#3a3c40', b.clone().multiply(M.t(lat, DECK - THICK - 0.02, 0))]);
            lightPos.push(smp.x + smp.nx * lat, smp.y + 0.07, smp.z + smp.nz * lat);
          }
        }
        for (let k = -40; k <= 40; k += 10) placer.reserve(smp.x + smp.nx * k, smp.z + smp.nz * k, 9);
      }
      // tunnel concrete: mostly self-lit warm grey, so the hemisphere light's green ground bounce can't tint the ceiling
      {
        const m = new THREE.Mesh(bag.add(mergeColored(tunnel)), bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, color: '#3c3a36', roughness: 0.95, emissive: '#8f8572', emissiveIntensity: 0.85 })));
        m.castShadow = m.receiveShadow = true;
        m.name = 'lowerWacker';
        group.add(m);
      }
      // pools of sodium light on the road (one additive mesh)
      {
        const geos: THREE.BufferGeometry[] = [];
        for (let i = 0; i < lightPos.length; i += 3) geos.push(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2).translate(lightPos[i], lightPos[i + 1], lightPos[i + 2]));
        if (geos.length) {
          const m = new THREE.Mesh(bag.add(mergeGeos(geos)), bag.add(new THREE.MeshBasicMaterial({
            map: bag.add(dotTexture('rgba(240,214,120,0.6)', 'rgba(240,214,120,0)')), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          })));
          m.renderOrder = 2;
          m.name = 'sodiumPools';
          group.add(m);
        }
        if (beams.length) {
          const m = new THREE.Mesh(bag.add(mergeColored(beams)), bag.add(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
          m.name = 'lightShafts';
          group.add(m);
        }
      }
      // portal signs on the deck edge + wall graphics inside
      const ent = track.sampleAt(0, s0), ex = track.sampleAt(0, s1);
      const lw = kit.paint.text('LOWER WACKER DR', 512, 96, { bg: '#1d6b3a', fg: '#ffffff', border: '#ffffff' });
      const up = kit.paint.text('MICHIGAN AVE ⟶', 512, 96, { bg: '#1d6b3a', fg: '#ffffff', border: '#ffffff' });
      const yawE = Math.atan2(-ent.tx, -ent.tz), yawX = Math.atan2(ex.tx, ex.tz);
      kit.solid.push([new THREE.BoxGeometry(20, 0.4, 0.4), '#555', M.trs(ent.x, DECK + 1.2, ent.z, 0, yawE, 0)]);
      kit.paint.quad(lw, 16, 3, M.trs(ent.x - ent.tx * 0.4, DECK + 2.6, ent.z - ent.tz * 0.4, 0, yawE, 0));
      kit.paint.quad(lw, 16, 3, M.trs(ent.x - ent.tx * 0.4, DECK - THICK - 1.0, ent.z - ent.tz * 0.4, 0, yawE, 0).multiply(M.trs(0, 0, 0, 0, 0, 0, 0.6, 0.45, 1)));
      kit.paint.quad(up, 16, 3, M.trs(ex.x - ex.tx * 0.4, DECK + 2.6, ex.z - ex.tz * 0.4, 0, yawX + Math.PI, 0), true);
      const wallSign = kit.paint.text('LOWER WACKER', 512, 96, { bg: '#e8d84a', fg: '#1a1a1a' });
      for (const fr of [0.2, 0.55, 0.85]) {
        const smp = track.sampleAt(0, s0 + (s1 - s0) * fr);
        for (const side of [-1, 1]) {
          const lat = side * (smp.halfWidth + def.shoulder + 3.9);
          kit.paint.quad(wallSign, 12, 2.2, M.trs(smp.x + smp.nx * lat, smp.y + 3.0, smp.z + smp.nz * lat, 0, Math.atan2(-smp.nx * side, -smp.nz * side), 0));
        }
      }
    }
  }

  /* ------------------------------------------------ river bridge jump: raised bascule leaves + green river */
  {
    let sa = -1, sb = -1;
    for (let s = 0; s < L; s += 0.5) if (track.sampleAt(0, s).gap) {
      if (sa < 0) sa = s;
      sb = s;
    }
    if (sa >= 0) {
      for (const [s, dir] of [[sa - 0.5, 1], [sb + 0.5, -1]] as const) {
        const smp = track.sampleAt(0, s);
        const yaw = Math.atan2(smp.tx * dir, smp.tz * dir);
        for (const side of [-1, 1]) {
          const lat = side * (smp.halfWidth + def.shoulder + 1.8);
          const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
          basculeLeaf(kit, x, smp.y + 0.2, z, yaw, 0.85, 10, 1.4);
          placer.reserve(x - smp.tx * dir * 6, z - smp.tz * dir * 6, 7);
        }
        // approach girders on both sides
        const a = track.sampleAt(0, s - dir * 26);
        for (const side of [-1, 1]) {
          const lat = side * (smp.halfWidth + def.shoulder + 1.8);
          const ax = a.x + a.nx * lat, az = a.z + a.nz * lat, bx = smp.x + smp.nx * lat, bz = smp.z + smp.nz * lat;
          beam(kit.gloss, [ax, a.y + 0.6, az], [bx, smp.y + 0.6, bz], 0.7, '#b3202a');
          beam(kit.gloss, [ax, a.y + 4.2, az], [bx, smp.y + 4.2, bz], 0.7, '#b3202a');
          for (let k = 0; k <= 8; k++) {
            const t = k / 8;
            const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
            kit.gloss.push([new THREE.BoxGeometry(0.4, 3.8, 0.4), '#b3202a', M.t(x, a.y + 2.4, z)]);
          }
        }
      }
    }
    for (const c of field.channels) {
      const g = sa >= 0 ? track.sampleAt(0, (sa + sb) / 2) : null;
      const clearAt = g ? (g.x - c.cx) * c.ax + (g.z - c.cz) * c.az : 0;
      buildGreenRiver(kit, c, { waterY: -2.05, tourBoats: lo ? 1 : 2, clearAt });
    }
  }

  /* ------------------------------------------------ Lake Michigan + Oak Street Beach */
  const b = field.bounds;
  buildLakeMichigan(kit, shoreX, [b.minZ - 200, b.maxZ + 200], Math.round(18 * density));
  {
    const bc = lm('beach') ?? { x: 186, z: 70 };
    const z0 = bc.z - 75, z1 = bc.z + 85;
    const sandMat = bag.add(new THREE.MeshStandardMaterial({ color: '#f3dca4', roughness: 1 }));
    for (const [x0, x1, y] of [[shoreX - 34, shoreX, 0.06], [shoreX, shoreX + 22, -0.75]] as const) {
      const sand = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2)), sandMat);
      sand.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      sand.receiveShadow = true;
      group.add(sand);
    }
    for (let z = z0; z < z1; z += 8) placer.reserve(shoreX - 17, z, 15);
    const umb = kit.batch(mergeColored([
      [new THREE.CylinderGeometry(0.06, 0.06, 3, 5), '#eeeeee', M.t(0, 1.5, 0)],
      [new THREE.ConeGeometry(1.8, 0.8, 8), '#ffffff', M.t(0, 3.1, 0)],
    ]), kit.tintMat, { name: 'umbrellas' });
    const towels = kit.batch(mergeColored([[new THREE.PlaneGeometry(1.2, 2.2).rotateX(-Math.PI / 2), '#ffffff', M.t(0, 0.03, 0)]]), kit.tintMat, { cast: false, name: 'towels' });
    const cols = ['#ff4d6d', '#ffd23f', '#3aa8ff', '#3ccf6e', '#ff8a3d', '#b26bff', '#41B6E6'];
    for (let z = z0 + 6; z < z1 - 6; z += rng.range(8, 13)) {
      const x = shoreX - rng.range(4, 28);
      umb.add(x, 0.06, z, rng.next() * 6, 1, 1, 1, rng.pick(cols));
      towels.add(x + 1.6, 0.06, z + rng.range(-1, 1), rng.range(-0.3, 0.3), 1, 1, 1, rng.pick(cols));
      if (rng.chance(0.5)) people(x + 2.5, z, rng.next() * 6, 1, 1);
    }
    const guard = kit.batch(lifeguardGeo(), vc, { name: 'lifeguard' });
    guard.add(shoreX - 6, 0.06, bc.z - 20, -Math.PI / 2);
    guard.add(shoreX - 6, 0.06, bc.z + 45, -Math.PI / 2);
    // volleyball net
    kit.solid.push([new THREE.CylinderGeometry(0.07, 0.07, 2.6, 5), '#dddddd', M.t(shoreX - 24, 1.3, bc.z + 15)]);
    kit.solid.push([new THREE.CylinderGeometry(0.07, 0.07, 2.6, 5), '#dddddd', M.t(shoreX - 24, 1.3, bc.z + 25)]);
    kit.solid.push([new THREE.BoxGeometry(0.05, 0.9, 10), '#f4f4f4', M.t(shoreX - 24, 2.1, bc.z + 20)]);
    const sign = kit.paint.text('OAK STREET BEACH', 512, 96, { bg: '#ffd23f', fg: '#1d4f9c', border: '#1d4f9c' });
    const sx = shoreX - 32, sz = bc.z - 60;
    kit.solid.push([new THREE.BoxGeometry(0.3, 3.4, 0.3), '#555', M.t(sx, 1.7, sz - 4.5)]);
    kit.solid.push([new THREE.BoxGeometry(0.3, 3.4, 0.3), '#555', M.t(sx, 1.7, sz + 4.5)]);
    kit.paint.quad(sign, 10, 1.9, M.trs(sx, 3.6, sz, 0, -Math.PI / 2, 0), true);
  }

  /* ------------------------------------------------ icons (reserve before filling the city) */
  {
    const wt = lm('waterTower') ?? { x: -40, z: 5 };
    const p = findSpot(placer, wt.x, wt.z, 12, 6, 30) ?? wt;
    waterTowerCastle(kit, p.x, land(p.x, p.z, 14), p.z, faceRoad(placer, p.x, p.z));
    people(p.x + 12, p.z, -Math.PI / 2, hi ? 8 : 4, 5);
  }
  {
    const h = lm('hancock') ?? { x: 70, z: -25 };
    hancockCenter(kit, h.x, land(h.x, h.z, 30), h.z, 0.1);
  }
  {
    const bp = lm('ballpark') ?? { x: -10, z: 448, rot: Math.PI };
    ballpark(kit, bp.x, land(bp.x, bp.z, 66), bp.z, bp.rot ?? Math.PI);
    if (!lo) for (let i = 0; i < (hi ? 36 : 16); i++) {
      const a = (bp.rot ?? Math.PI) + rng.range(-0.55, 0.55), d = rng.range(66, 76);
      const x = bp.x + Math.sin(a) * d, z = bp.z + Math.cos(a) * d;
      if (field.clearance(x, z) < 1) continue;
      kit.person(x, field.height(x, z), z, a + Math.PI, rng.pick(['#1d3f8f', '#c8102e', '#ffffff', '#1d3f8f', '#41B6E6']));
    }
  }
  {
    const mc = lm('marinaCity') ?? { x: -100, z: -292 };
    marinaCity(kit, mc.x, land(mc.x, mc.z, 30), mc.z, 0.4);
    const wb = lm('wrigleyBuilding') ?? { x: 12, z: -300 };
    wrigleyBuilding(kit, wb.x, land(wb.x + 17, wb.z, 34), wb.z, 0);
    tribuneTower(kit, 78, land(78, -305, 18), -305, 0.1);
    glassSpireTower(kit, -150, land(-150, -330, 26), -330, 0.3);
    willisTower(kit, -300, land(-300, -60, 32), -60);
    aonCenter(kit, 150, land(150, -340, 26), -340);
    wavyTower(kit, -40, land(-40, -390, 30), -390, 0.2);
    if (!lo) cloudGate(kit, 120, land(120, -250, 27), -250, 0.3);
  }
  // Michigan Avenue: welcome billboard, theatre marquee
  {
    const sh = findSpot(placer, 34, -78, 6, 10, 30);
    if (sh) sweetHomeBillboard(kit, sh.x, land(sh.x, sh.z, 11), sh.z, faceRoad(placer, sh.x, sh.z) - 0.5);
    const smp = track.sampleAt(0, 62);
    const side = smp.nx < 0 ? 1 : -1; // west side of the avenue
    const lat = side * (smp.halfWidth + def.shoulder + 9);
    const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
    const yaw = Math.atan2(-smp.nx * side, -smp.nz * side);
    chicagoTheatre(kit, x, field.height(x, z), z, yaw, ['SWEET HOME CHICAGO', 'THE GRAND TOUR · ALL FAMILIES WELCOME']);
    placer.reserve(x - Math.sin(yaw) * 9, z - Math.cos(yaw) * 9, 21);
  }
  // the Brown Line through Wrigleyville
  {
    const l = lm('ltrain') ?? { x: 97, z: 350 };
    const a: [number, number] = [l.x, 150], bb: [number, number] = [l.x, 600];
    elevatedL(kit, placer, {
      a, b: bb,
      lines: lo ? [CTA.brown] : quality === 'medium' ? [CTA.brown, CTA.purple] : [CTA.brown, CTA.purple, CTA.red],
      cars: lo ? 4 : 5,
      stations: [{ at: (440 - a[1]) / (bb[1] - a[1]), name: 'ADDISON', color: CTA.brown }, { at: (240 - a[1]) / (bb[1] - a[1]), name: 'BELMONT', color: CTA.brown }],
      period: 20,
    });
  }
  // blues clubs, corner taps, food stands (not inside the Lower Wacker trench)
  {
    const okY = (sp: { y: number }) => sp.y > -0.8;
    const clubs = placer.along(0, lo ? 1500 : 520, 9, 9, { side: 0 }).filter(okY);
    clubs.forEach((sp, i) => (i % 2 ? cornerTavern : bluesClub)(kit, sp.x, sp.y, sp.z, sp.yaw));
    const stands = [hotDogStand, pizzeria, hotDogStand, beefStand, popcornShop];
    placer.along(0, lo ? 420 : 200, 6.5, 6.5, { side: 0 }).filter(okY).forEach((sp, i) => {
      stands[i % stands.length](kit, sp.x, sp.y, sp.z, sp.yaw);
      if (!lo) for (let k = 0; k < (hi ? 3 : 2); k++) {
        const lx = -1.6 + k * 1.6, lz = 4.2;
        const cx = sp.x + Math.cos(sp.yaw) * lx + Math.sin(sp.yaw) * lz, cz = sp.z - Math.sin(sp.yaw) * lx + Math.cos(sp.yaw) * lz;
        kit.person(cx, field.height(cx, cz), cz, sp.yaw + Math.PI, rng.pick(shirt));
      }
    });
  }

  /* ------------------------------------------------ the Magnificent Mile: glossy shops with awnings + planters */
  {
    const kinds = ['glass', 'cream', 'stone', 'blue', 'white', 'tan'] as const;
    const shopGeo = mergeColored([
      [new THREE.BoxGeometry(13, 0.16, 1.8), '#ffffff', M.trs(0, 3.7, 0.8, 0.35, 0, 0)],
      [new THREE.BoxGeometry(13.4, 1.0, 0.25), '#ffffff', M.t(0, 4.6, 0.1)],
      [new THREE.BoxGeometry(12.2, 2.8, 0.1), '#cfe8ff', M.t(0, 1.75, 0.06)],
      [new THREE.BoxGeometry(0.3, 3.3, 0.3), '#2a2a2a', M.t(-6.4, 1.65, 0.15)],
      [new THREE.BoxGeometry(0.3, 3.3, 0.3), '#2a2a2a', M.t(6.4, 1.65, 0.15)],
    ]);
    const shops = kit.batch(shopGeo, kit.tintMat, { name: 'shops', cast: false });
    const awn = ['#c8102e', '#1f8f4a', '#2f6fd1', '#111111', '#ffb02e', '#7a2fb0', '#41B6E6', '#13806f'];
    const planter = kit.batch(mergeColored([
      [new THREE.BoxGeometry(2.4, 0.8, 1.2), '#5b5f66', M.t(0, 0.4, 0)],
      [new THREE.IcosahedronGeometry(0.55, 0), '#ffffff', M.t(-0.7, 1.0, 0)],
      [new THREE.IcosahedronGeometry(0.6, 0), '#ffffff', M.t(0.1, 1.05, 0.1)],
      [new THREE.IcosahedronGeometry(0.5, 0), '#ffffff', M.t(0.8, 0.95, -0.1)],
      [new THREE.BoxGeometry(2.2, 0.2, 1.0), '#3f8f3a', M.t(0, 0.85, 0)],
    ]), kit.tintMat, { cast: false, name: 'planters' });
    const flowerCols = ['#ff5fa2', '#ffd23f', '#ff7a3d', '#b48cff', '#ff3b5a'];
    for (const [from, to] of [[0, 160], [L - 95, L]] as const) {
      for (const sp of placer.along(0, 20, 17, 10, { jitter: 1.5, from, to })) {
        const w = rng.range(16, 22), d = rng.range(16, 22), h = rng.range(26, 70);
        const kind = rng.pick(kinds);
        kit.facade(kind, boxUV(w, h, d), M.trs(sp.x, sp.y - 0.2, sp.z, 0, sp.yaw, 0));
        if (h < 55 && rng.chance(0.4)) kit.solid.push([new THREE.BoxGeometry(w * 0.6, 4, d * 0.6), '#e6e2d8', M.trs(sp.x, sp.y + h, sp.z, 0, sp.yaw, 0)]);
        const fx = sp.x + Math.sin(sp.yaw) * (d / 2 + 0.05), fz = sp.z + Math.cos(sp.yaw) * (d / 2 + 0.05);
        shops.add(fx, sp.y - 0.2, fz, sp.yaw, w / 14, 1, 1, rng.pick(awn));
        if (!lo && rng.chance(0.6)) people(fx + Math.sin(sp.yaw) * 2.5, fz + Math.cos(sp.yaw) * 2.5, sp.yaw + Math.PI / 2, hi ? 2 : 1, 3);
      }
      for (const sp of placer.along(0, 14, 2.5, 1.4, { from, to })) planter.add(sp.x, sp.y, sp.z, sp.yaw + Math.PI / 2, 1, 1, 1, rng.pick(flowerCols));
    }
  }

  /* ------------------------------------------------ Wrigleyville: two-flats with rooftop bleachers, the alley */
  {
    const tf = twoFlat(), tfFar = twoFlat(true), bg = bungalow();
    const body = new Batch(bag.add(tf.body), vcMat(bag, { roughness: 0.85 }), { name: 'twoFlats' });
    const det = new Batch(bag.add(tf.detail), vc, { name: 'twoFlatDetail' });
    bag.add(tfFar.body);
    const detFar = new Batch(bag.add(tfFar.detail), vc, { name: 'twoFlatDetailFar' });
    const bBody = new Batch(bag.add(bg.body), vcMat(bag, { roughness: 0.85 }), { name: 'bungalows' });
    const bDet = new Batch(bag.add(bg.detail), vc, { name: 'bungalowDetail' });
    const brick = ['#b5523b', '#a8452f', '#c96f4a', '#d9a36a', '#9c3f2c', '#bdb7aa', '#cfc8b8', '#b86a50'];
    // rooftop bleachers facing the ballpark
    const bleach: P = [];
    for (let r = 0; r < 4; r++) bleach.push([new THREE.BoxGeometry(7.6, 0.5 + r * 0.6, 1.6), r % 2 ? '#2f5f3a' : '#3b7048', M.t(0, 0.25 + r * 0.3, 2.6 - r * 1.6)]);
    bleach.push([new THREE.BoxGeometry(7.8, 2.6, 0.2), '#5a5f66', M.t(0, 1.3, -4.0)]);
    for (const x of [-3.8, 3.8]) bleach.push([new THREE.BoxGeometry(0.15, 3.4, 0.15), '#dddddd', M.t(x, 1.7, 3.3)]);
    bleach.push([new THREE.BoxGeometry(7.8, 0.15, 0.15), '#dddddd', M.t(0, 3.3, 3.3)]);
    const bleachers = kit.batch(mergeColored(bleach), vc, { name: 'rooftopBleachers' });
    const banner = kit.batch(mergeColored([[new THREE.BoxGeometry(7, 1.0, 0.1), '#ffffff', M.t(0, 3.6, 3.3)]]), kit.tintMat, { name: 'bleacherBanners', cast: false });
    const bp = lm('ballpark') ?? { x: -10, z: 448 };
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const x = bp.x + Math.cos(a) * 80, z = bp.z + Math.sin(a) * 80;
      if (!placer.ok(x, z, 8, 6)) continue;
      placer.reserve(x, z, 8);
      const yaw = Math.atan2(bp.x - x, bp.z - z);
      const y = field.height(x, z);
      body.add(x, y, z, yaw, 1, 1, 1, rng.pick(brick));
      det.add(x, y, z, yaw);
      bleachers.add(x, y + 8.8, z, yaw);
      banner.add(x, y + 8.8, z, yaw, 1, 1, 1, rng.pick(['#c8102e', '#1d3f8f', '#41B6E6', '#ffffff']));
      if (!lo) for (let p = 0; p < (hi ? 6 : 3); p++) {
        const lx = rng.range(-3, 3), lz = 2.6 - rng.int(4) * 1.6;
        const cs = Math.cos(yaw), sn = Math.sin(yaw);
        kit.person(x + cs * lx + sn * lz, y + 8.8 + 0.5 + (2.6 - lz) * 0.19 + 0.3, z - sn * lx + cs * lz, yaw, rng.pick(['#1d3f8f', '#c8102e', '#ffffff']));
      }
    }
    // houses along the Wrigleyville streets + fill blocks
    for (const p of [0, 1]) {
      if (!track.paths[p]) continue;
      for (const sp of placer.along(p, 15, 14, 7.5, { jitter: 1.5, ...(p === 0 ? { from: 540, to: 930 } : {}) })) {
        if (rng.chance(0.65)) {
          body.add(sp.x, sp.y, sp.z, sp.yaw, 1, 1, 1, rng.pick(brick));
          det.add(sp.x, sp.y, sp.z, sp.yaw);
        } else {
          bBody.add(sp.x, sp.y, sp.z, sp.yaw, 1, 1, 1, rng.pick(brick));
          bDet.add(sp.x, sp.y, sp.z, sp.yaw);
        }
      }
    }
    const step = hi ? 21 : quality === 'medium' ? 26 : 34;
    for (let x = -300; x < 120; x += step) for (let z = 250; z < 640; z += 26) {
      const jx = x + rng.range(-2, 2), jz = z + rng.range(-2, 2);
      if (!placer.ok(jx, jz, 8, 18)) continue;
      placer.reserve(jx, jz, 8);
      const yaw = (Math.floor(z / 26) % 2 ? 0 : Math.PI) + rng.range(-0.03, 0.03);
      body.add(jx, field.height(jx, jz), jz, yaw, 1, 1, 1, rng.pick(brick));
      detFar.add(jx, field.height(jx, jz), jz, yaw);
    }
    for (const bt of [body, det, detFar, bBody, bDet]) bt.build(group);
    // garages + carts along the alley shortcut
    const sc = track.paths[1];
    if (sc) {
      const gp: P = [];
      for (let s = 10; s < sc.length - 20; s += 9) {
        const smp = track.sampleAt(1, s);
        for (const side of [-1, 1]) {
          const lat = side * (smp.halfWidth + def.shoulder + 4.5);
          const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
          if (!placer.ok(x, z, 3.5, 0.5)) continue;
          placer.reserve(x, z, 3.5);
          const m = M.trs(x, field.height(x, z), z, 0, Math.atan2(-smp.nx * side, -smp.nz * side), 0);
          gp.push([new THREE.BoxGeometry(7, 3.4, 7), rng.pick(['#b8b0a2', '#c96f4a', '#e6d8b8', '#9fb7c9']), m.clone().multiply(M.t(0, 1.7, 0))]);
          gp.push([new THREE.BoxGeometry(7.4, 0.4, 7.4), '#4a4f5a', m.clone().multiply(M.t(0, 3.6, 0))]);
          gp.push([new THREE.BoxGeometry(5, 2.6, 0.15), rng.pick(['#f2f2f2', '#d0d6dd', '#7aa3c7']), m.clone().multiply(M.t(0, 1.4, 3.53))]);
          if (rng.chance(0.5)) {
            gp.push([new THREE.BoxGeometry(0.75, 1.1, 0.8), '#1f5fbf', m.clone().multiply(M.t(-2.6, 0.55, 4.2))]);
            gp.push([new THREE.BoxGeometry(0.75, 1.1, 0.8), '#2b2b2b', m.clone().multiply(M.t(-1.7, 0.55, 4.2))]);
          }
        }
      }
      if (gp.length) kit.solid.push(...gp);
    }
  }

  /* ------------------------------------------------ the skyline */
  {
    const facades = [
      windowTexture({ wall: '#f4f1ea', glass: '#4f86c0', glass2: '#86b2d9', seed: 3 }),
      windowTexture({ wall: '#dfe9f5', glass: '#3a74b4', glass2: '#77b0e8', bands: true, seed: 4 }),
      windowTexture({ wall: '#efe0c6', glass: '#2c3e57', glass2: '#4b6a8f', frame: 0.3, seed: 5 }),
    ].map((t) => bag.add(t));
    const mats = [windowedMaterial(bag, facades[0], 12, 14), windowedMaterial(bag, facades[1], 13, 14, { roughness: 0.22, metalness: 0.45 }), windowedMaterial(bag, facades[2], 10, 13)];
    const box = bag.add(unitBox());
    const bt = mats.map((m) => new Batch(box, m, { name: 'towers' }));
    const crowns = new Batch(bag.add(new THREE.ConeGeometry(0.71, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0)), bag.add(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 })), { name: 'crowns' });
    const tanks = new Batch(bag.add(rooftopTankGeo()), vc, { name: 'tanks' });
    const palette = ['#f2e3c6', '#cfe3f2', '#ffe2d2', '#e3ecff', '#d8f0e4', '#fff1c4', '#c9d6ea', '#ffffff', '#bfe0ff', '#9fc6ee', '#d6c4a8'];
    const nT = hi ? 1 : quality === 'medium' ? 0.7 : 0.45;
    const towers = (n: number, rect: [number, number, number, number], hr: [number, number], margin: number) => {
      for (let i = 0; i < Math.round(n * nT); i++) for (let t = 0; t < 15; t++) {
        const x = rng.range(rect[0], rect[1]), z = rng.range(rect[2], rect[3]);
        const w = rng.range(16, 28), d = rng.range(16, 28), r = Math.max(w, d) * 0.6;
        if (!placer.ok(x, z, r, margin)) continue;
        placer.reserve(x, z, r);
        const h = rng.range(hr[0], hr[1]);
        const tint = rng.pick(palette);
        bt[rng.int(3)].add(x, field.height(x, z), z, 0, w, h, d, tint);
        if (h > 100 && rng.chance(0.4)) crowns.add(x, h, z, 0, w, Math.min(w, d) * 0.9, d, rng.pick(['#2f7f6f', '#c9a24a', '#e8e8e8', '#9a2b2b']));
        else if (h < 70 && rng.chance(0.5)) tanks.add(x, h, z, rng.next() * 6, 1.1);
        break;
      }
    };
    towers(90, [-360, 200, -620, -330], [70, 190], 10); // the Loop beyond the river
    towers(60, [-520, -220, -380, 260], [50, 160], 10); // west of Wacker
    towers(30, [-130, -25, -95, 215], [25, 70], 12); // River North, between Michigan Ave and Wacker
    towers(22, [20, 120, -95, 300], [25, 60], 14); // Streeterville
    for (const x of [...bt, crowns, tanks]) x.build(group);
  }

  /* ------------------------------------------------ lamps with banners, flags, trees, gulls, wind */
  {
    const okY = (sp: { y: number }) => sp.y > -0.8;
    const lamps = kit.batch(PROPS.lamp('#2b3445', '#fff6d0'), vc, { name: 'lamps' });
    const banners = lo ? null : bannerBatch(kit);
    for (const sp of placer.along(0, 40, 1.2, 0.6).filter(okY)) {
      lamps.add(sp.x, sp.y, sp.z, sp.yaw);
      banners?.add(sp.x, sp.y + 4.4, sp.z, sp.yaw - Math.PI / 2);
    }
    const flags = buildChicagoFlag(kit);
    for (const sp of placer.along(0, lo ? 160 : 70, 3, 1).filter(okY)) flags.add(sp.x, sp.y, sp.z);
    const dibs = kit.batch(dibsGeo(), kit.tintMat, { name: 'dibs', cast: false });
    for (const sp of placer.along(0, 90, 4.5, 1.5, { from: 560, to: 920 })) dibs.add(sp.x, sp.y, sp.z, sp.yaw + rng.range(-0.5, 0.5), 1.2, 1.2, 1.2, rng.pick(['#3aa8ff', '#ff5a5a', '#3ccf6e', '#ffd23f']));
    const treeA = kit.batch(PROPS.roundTree('#3fa34d', '#5cc25e'), vc, { name: 'trees' });
    const treeB = kit.batch(PROPS.roundTree('#2f8f45', '#7ccf5a', '#6b4425'), vc, { name: 'trees2' });
    // Lincoln Park along Lake Shore Drive + Streeterville
    for (const sp of placer.scatter(Math.round(150 * density), { minX: 100, maxX: shoreX - 6, minZ: -120, maxZ: 560 }, 3.5, 3)) (rng.chance(0.5) ? treeA : treeB).add(sp.x, sp.y, sp.z, sp.yaw, rng.range(0.9, 1.35));
    for (const sp of placer.scatter(Math.round(90 * density), { minX: b.minX - 160, maxX: b.maxX, minZ: b.minZ - 100, maxZ: b.maxZ + 150 }, 3.5, 4)) if (sp.y > -0.5) (rng.chance(0.5) ? treeA : treeB).add(sp.x, sp.y, sp.z, sp.yaw, rng.range(0.9, 1.3));
    for (const sp of placer.along(0, 22, 3.4, 2.4, { from: 160, to: 560 })) treeA.add(sp.x, sp.y, sp.z, sp.yaw, rng.range(1, 1.3));
    if (!lo) windGusts(kit, ['#7cc65a', '#c9e265', '#f2b13c', '#e0882c', '#ffffff'], hi ? 380 : 180, { speed: 10 });
  }
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.5, -1.4, 0.45, -0.1, 0, 0, -0.4, 0, 0, 0.5, 0, 0, -0.4, 1.4, 0.45, -0.1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
    g.computeVertexNormals();
    const gullGeo = bag.add(mergeColored([[g, '#ffffff'], [new THREE.ConeGeometry(0.18, 1.2, 5).rotateX(Math.PI / 2), '#f0f0f0', M.t(0, 0, 0.1)]]));
    const N = lo ? 8 : 22;
    const gulls = new THREE.InstancedMesh(gullGeo, bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide })), N);
    gulls.frustumCulled = false;
    const gd = Array.from({ length: N }, () => ({ cx: shoreX + rng.range(-60, 120), cz: rng.range(-150, 450), r: rng.range(15, 45), h: rng.range(14, 34), w: rng.range(0.25, 0.5) * (rng.chance(0.5) ? 1 : -1), ph: rng.next() * 6 }));
    group.add(gulls);
    updaters.push((_dt, t) => {
      gd.forEach((q, i) => {
        const a = t * q.w + q.ph;
        setInstance(gulls, i, q.cx + Math.cos(a) * q.r, q.h, q.cz + Math.sin(a) * q.r, 0, -a + (q.w > 0 ? Math.PI : 0), -Math.sign(q.w) * 0.35, 1.6, 1.6 * (1 + Math.sin(t * 9 + q.ph * 3) * 0.7), 1.6);
      });
      gulls.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ MOAR Chicago life: dogs + kites on Oak Street Beach */
  if (!lo) {
    const bc = lm('beach') ?? { x: 186, z: 70 };
    runningDogs(kit, () => 0.06, [[-10, -40], [-14, 10], [-8, 58], [-20, 35]].slice(0, hi ? 4 : 2).map(([dx, dz]) => ({ x: shoreX + dx, z: bc.z + dz })), { r: [2, 4], seed: 61 });
    kites(kit, [-50, 0, 50].map((dz) => ({ x: shoreX - rng.range(4, 16), z: bc.z + dz, h: rng.range(24, 34) })), 62);
  }

  kit.flush();
  trimShadows(group, quality);

  return {
    update(dt: number, time: number) {
      kit.update(dt, time);
    },
    dispose() {
      disposeGroup(group);
      bag.dispose();
    },
  };
}

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeColored(geos.map((g) => [g, '#ffffff'] as [THREE.BufferGeometry, string]));
}

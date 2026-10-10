import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SceneryContext, SceneryHandle } from './types';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addClouds, Batch, trimShadows, ctxBits, disposeGroup, flagGeometry, flagMaterial, M, mergeColored, PROPS, setInstance, tintMaskMat, unitBox, vcMat, windowedMaterial } from './common';
import { getField } from './field';
import { canvasTexture, crowdTexture, drawChicagoFlag, flagTexture, textTexture, waterTexture, windowTexture } from './textures';
import {
  adlerPlanetarium, aonCenter, beam, bluesClub, sweetHomeBillboard, windGusts, buildBuckingham, buildNavyPier, artMuseum, bannerBatch, beefStand, chicagoTheatre, cloudGate, CTA, crownFountain, elevatedL, faceRoad,
  findSpot, glassSpireTower, hancockCenter, hotDogStand, Kit, lifeguardGeo, marinaCity, merchMart, museumHall, picasso, pizzeria, popcornShop, pritzkerPavilion,
  rooftopTankGeo, sheddAquarium, tribuneTower, waterTowerCastle, wavyTower, willisTower, wrigleyBuilding,
  kites, runningDogs, streetLife, tireWalls, edgeGrass, dressBlock,
} from './chicagoLandmarks';
import { flowerBed, grassTuft, canopy } from './props';

/**
 * Chicago Grand Prix: Lake Michigan to the east with Navy Pier, the Ferris wheel and sailboats,
 * Grant Park + Buckingham Fountain in the infield, the downtown skyline to the west, an elevated L
 * line crossing the course, the river bridge jump and the red CHICAGO arch over the start.
 */
export function buildChicago(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const rng = new Rng(4242);
  const def = track.def;
  const lm = (kind: string) => def.landmarks.find((l) => l.kind === kind);
  const updaters: Array<(dt: number, t: number) => void> = [];
  const timeU = { value: 0 };
  const vc = vcMat(bag);
  const vcGloss = vcMat(bag, { roughness: 0.35, metalness: 0.3 });
  const shoreX = field.shoreX;
  const kit = new Kit(bag, group, { lit: 0, snow: false, quality, atlas: 2048 }); // 1024 overflowed ("sign atlas full")
  const hi = quality === 'high', lo = quality === 'low';

  /* ------------------------------------------------ Lake Michigan */
  const waterTex = bag.add(waterTexture('#2b8be0', '#bfe9ff', 77));
  waterTex.repeat.set(220, 220);
  const lakeMat = bag.add(new THREE.MeshStandardMaterial({ color: '#4aa6f0', map: waterTex, roughness: 0.12, metalness: 0.25 }));
  const lake = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(5000, 5000)), lakeMat);
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(shoreX + 2500 - 4, -0.9, 0);
  lake.receiveShadow = true;
  group.add(lake);
  updaters.push((dt) => {
    waterTex.offset.x += dt * 0.004;
    waterTex.offset.y += dt * 0.0025;
  });
  // seawall + lakefront promenade
  {
    const b = field.bounds;
    const z0 = b.minZ - 400, z1 = b.maxZ + 400;
    const wall = mergeColored([
      [new THREE.BoxGeometry(3, 2.2, z1 - z0), '#d8d2c4', M.t(shoreX - 1.5, -0.9, (z0 + z1) / 2)],
      [new THREE.BoxGeometry(0.3, 0.9, z1 - z0), '#5a6470', M.t(shoreX - 0.2, 0.6, (z0 + z1) / 2)],
    ]);
    const m = new THREE.Mesh(bag.add(wall), vc);
    m.receiveShadow = true;
    group.add(m);
  }

  /* ------------------------------------------------ sailboats */
  const boatGeo = bag.add(
    (() => {
      const sail = new THREE.BufferGeometry();
      sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.2, 0.2, 0, 9, 0.2, 0, 1.2, -3.4, 0, 1.2, 0.2, 0, 1.2, -3.4, 0, 9, 0.2], 3));
      sail.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
      sail.computeVertexNormals();
      const jib = new THREE.BufferGeometry();
      jib.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.2, 0.6, 0, 7.5, 0.4, 0, 1.2, 3.2, 0, 1.2, 0.6, 0, 1.2, 3.2, 0, 7.5, 0.4], 3));
      jib.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
      jib.computeVertexNormals();
      return mergeColored([
        [new THREE.BoxGeometry(1.8, 0.9, 6.5), '#ffffff', M.t(0, 0.3, 0)],
        [new THREE.ConeGeometry(0.9, 1.6, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4), '#ffffff', M.trs(0, 0.3, 3.9, 0, 0, 0, 1, 0.5, 1)],
        [new THREE.BoxGeometry(1.9, 0.18, 6.6), '#1d3f73', M.t(0, 0.62, 0)],
        [new THREE.CylinderGeometry(0.07, 0.09, 9.5, 5), '#dddddd', M.t(0, 5, 0.3)],
        [sail, '#fdfdf8'],
        [jib, '#ff6b6b'],
      ]);
    })(),
  );
  const boatMat = bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }));
  const boats: Array<{ x: number; z: number; yaw: number; v: number; ph: number }> = [];
  for (let i = 0; i < Math.round(16 * density + 4); i++) {
    boats.push({ x: shoreX + rng.range(90, 700), z: rng.range(-600, 700), yaw: rng.range(-0.6, 0.6) + (rng.chance(0.5) ? Math.PI : 0), v: rng.range(1.5, 4), ph: rng.next() * 6 });
  }
  const boatIM = new THREE.InstancedMesh(boatGeo, boatMat, boats.length);
  boatIM.castShadow = true;
  const sailColors = ['#ffffff', '#ffe066', '#ff8fab', '#9be7ff', '#ffffff', '#c3f584'];
  boats.forEach((_, i) => boatIM.setColorAt(i, new THREE.Color(sailColors[i % sailColors.length])));
  group.add(boatIM);
  boatIM.frustumCulled = false;
  updaters.push((dt, t) => {
    boats.forEach((b, i) => {
      b.z += Math.cos(b.yaw) * b.v * dt;
      b.x += Math.sin(b.yaw) * b.v * dt;
      if (b.z > 750) b.z = -650;
      if (b.z < -650) b.z = 750;
      setInstance(boatIM, i, b.x, -0.75 + Math.sin(t * 1.3 + b.ph) * 0.15, b.z, Math.sin(t * 1.1 + b.ph) * 0.05, b.yaw, Math.sin(t * 0.9 + b.ph) * 0.08 + 0.12, 1.6);
    });
    boatIM.instanceMatrix.needsUpdate = true;
  });

  /* ------------------------------------------------ Navy Pier + Ferris wheel */
  {
    const pier = lm('pier') ?? { x: 110, z: 40 };
    const fw = lm('ferrisWheel') ?? { x: 140, z: 40 };
    updaters.push(buildNavyPier(kit, placer, { shoreX, pierZ: pier.z, wheelX: fw.x, wheelZ: fw.z }));
  }

  /* ------------------------------------------------ signature skyline (reserve space first) */
  for (const c of field.channels) for (let k = -c.halfLen; k < c.halfLen; k += 6) placer.reserve(c.cx + c.ax * k, c.cz + c.az * k, c.halfWidth + 4);
  const land = (x: number, z: number, r: number) => {
    placer.reserve(x, z, r);
    return field.height(x, z);
  };
  willisTower(kit, -520, land(-520, 100, 32), 100);
  hancockCenter(kit, -165, land(-165, 455, 30), 455, 0.12);
  glassSpireTower(kit, -330, land(-330, 425, 26), 425, -0.25);
  aonCenter(kit, -455, land(-455, -150, 26), -150);
  wavyTower(kit, -440, land(-440, 330, 30), 330, 0.4);
  tribuneTower(kit, -250, land(-250, 382, 18), 382, 0.15);
  wrigleyBuilding(kit, -190, land(-173, 372, 32), 372, 0);
  waterTowerCastle(kit, -110, land(-110, 300, 14), 300, 0.3);
  merchMart(kit, -545, land(-545, 222, 62), 222);
  marinaCity(kit, -276, land(-276, 192, 30), 192);
  /* ------------------------------------------------ Millennium Park, Grant Park, the Loop */
  cloudGate(kit, -95, land(-95, 95, 27), 95, 0.1);
  crownFountain(kit, -48, land(-48, 10, 27), 10, 0);
  pritzkerPavilion(kit, -160, land(-160, 55, 46), 20, 0);
  artMuseum(kit, -40, land(-40, -112, 36), -112, Math.PI / 2);
  {
    const p = findSpot(placer, -215, -50, 15, 4) ?? { x: -215, z: -50 };
    const yaw = faceRoad(placer, p.x, p.z);
    picasso(kit, p.x, land(p.x, p.z, 15), p.z, yaw);
  }
  chicagoTheatre(kit, -30, land(-30, 200, 20), 192, Math.PI, ['CHICAGO GRAND PRIX', 'TODAY! ALL FAMILIES WELCOME']);
  {
    // SWEET HOME CHICAGO welcome billboard beside the grid, a blues club on the top straight and one downtown
    const sh = findSpot(placer, 63, -80, 6, 10, 30);
    if (sh) sweetHomeBillboard(kit, sh.x, land(sh.x, sh.z, 11), sh.z, faceRoad(placer, sh.x, sh.z) - 0.5);
    else console.warn('no spot for the welcome billboard');
    for (const [bx, bz] of [[-300, 352], [-378, 40]] as const) {
      const p = findSpot(placer, bx, bz, 9, 6, 40);
      if (p) bluesClub(kit, p.x, land(p.x, p.z, 10), p.z, faceRoad(placer, p.x, p.z));
    }
  }
  /* ------------------------------------------------ Museum Campus on the lake */
  museumHall(kit, -70, land(-70, -305, 52), -305, 0);
  sheddAquarium(kit, 40, land(40, -312, 38), -312, 0);
  {
    const ax = 150, az = -262;
    kit.solid.push([new THREE.BoxGeometry(70, 4, 56), '#cfc6b2', M.t(ax - 5, -1.6, az)]);
    kit.solid.push([new THREE.BoxGeometry(70, 0.3, 50), '#79b85a', M.t(ax - 5, 0.5, az)]);
    kit.solid.push([new THREE.BoxGeometry(12, 3.6, 120), '#cfc6b2', M.t(shoreX + 12, -1.4, az - 20)]);
    adlerPlanetarium(kit, ax, 0.5, az, 0);
  }

  /* ------------------------------------------------ elevated L (before generic towers so they keep clear) */
  {
    const l = lm('ltrain') ?? { x: -172, z: 230 };
    elevatedL(kit, placer, {
      a: [-430, l.z],
      b: [62, l.z],
      lines: lo ? [CTA.green] : quality === 'medium' ? [CTA.green, CTA.pink] : [CTA.green, CTA.pink, CTA.brown],
      cars: lo ? 4 : 5,
      stations: [{ at: 0.62, name: 'STATE/LAKE', color: CTA.green }, { at: 0.13, name: 'CLARK/LAKE', color: CTA.brown }],
      period: 24,
    });
  }

  /* ------------------------------------------------ downtown streets under the skyline */
  {
    const cityTex = bag.add(canvasTexture(256, 256, (g, w, h, r) => {
      g.fillStyle = '#5b5e64';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#c9c4ba';
      g.fillRect(14, 14, w - 28, h - 28);
      g.fillStyle = '#d9d4ca';
      g.fillRect(22, 22, w - 44, h - 44);
      g.fillStyle = '#e8e4da';
      for (let i = 0; i < 4; i++) g.fillRect(2 + i * 4, 120, 2, 16);
      g.fillStyle = '#f2f2f2';
      for (let y = 0; y < h; y += 24) g.fillRect(5, y, 3, 12);
      for (let x = 0; x < w; x += 24) g.fillRect(x, 5, 12, 3);
      g.fillStyle = '#5fae4a';
      for (let i = 0; i < 18; i++) {
        g.beginPath();
        g.arc(r.pick([18, w - 18]), r.range(30, h - 30), 5, 0, Math.PI * 2);
        g.fill();
      }
    }, { seed: 12 }));
    cityTex.repeat.set(1, 1);
    const cityMat = bag.add(new THREE.MeshStandardMaterial({ map: cityTex, roughness: 0.95 }));
    const rects: Array<[number, number, number, number]> = [[-960, -395, -540, 135], [-960, -395, 171, 740], [-395, -20, 352, 740], [-340, -110, -540, -276]];
    const geos: THREE.BufferGeometry[] = [];
    for (const [x0, x1, z0, z1] of rects) {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0.07, (z0 + z1) / 2);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (x0 + uv.getX(i) * (x1 - x0)) / 64, (z0 + uv.getY(i) * (z1 - z0)) / 64);
      geos.push(g);
    }
    const cm = new THREE.Mesh(bag.add(mergeGeometries(geos)!), cityMat);
    cm.receiveShadow = true;
    cm.name = 'downtownStreets';
    group.add(cm);
  }

  /* ------------------------------------------------ generic downtown towers */
  const facadeA = bag.add(windowTexture({ wall: '#f4f1ea', glass: '#4f86c0', glass2: '#86b2d9', seed: 3 }));
  const facadeB = bag.add(windowTexture({ wall: '#dfe9f5', glass: '#3a74b4', glass2: '#77b0e8', bands: true, seed: 4 }));
  const facadeC = bag.add(windowTexture({ wall: '#efe0c6', glass: '#2c3e57', glass2: '#4b6a8f', frame: 0.3, seed: 5 }));
  const matA = windowedMaterial(bag, facadeA, 12, 14);
  const matB = windowedMaterial(bag, facadeB, 13, 14, { roughness: 0.22, metalness: 0.45 });
  const matC = windowedMaterial(bag, facadeC, 10, 13);
  const box = bag.add(unitBox());
  const bA = new Batch(box, matA, { name: 'towersA' });
  const bB = new Batch(box, matB, { name: 'towersB' });
  const bC = new Batch(box, matC, { name: 'towersC' });
  const crownMat = bag.add(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 }));
  const crowns = new Batch(bag.add(new THREE.ConeGeometry(0.71, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0)), crownMat, { name: 'crowns' });
  const spires = new Batch(bag.add(new THREE.CylinderGeometry(0.15, 0.6, 1, 6).translate(0, 0.5, 0)), crownMat, { name: 'spires', cast: false });
  const tanks = new Batch(bag.add(rooftopTankGeo()), vc, { name: 'rooftopTanks' });
  const palette = ['#f2e3c6', '#cfe3f2', '#ffe2d2', '#e3ecff', '#d8f0e4', '#fff1c4', '#c9d6ea', '#f5d2c4', '#ffffff', '#bfe0ff', '#9fc6ee', '#d6c4a8'];
  const addTower = (x: number, z: number, w: number, d: number, h: number) => {
    const r = rng.next();
    const batch = r < 0.36 ? bA : r < 0.74 ? bB : bC;
    const tint = rng.pick(palette);
    batch.add(x, 0, z, 0, w, h, d, tint);
    if (!lo) dressBlock(kit, M.t(x, 0, z), w, h, d, { cornice: rng.pick(['#d9d2c3', '#c9ced6', '#e8e2d4', '#9aa3ad']), ledge: h < 90 && rng.chance(0.5) ? 24 : undefined, roof: h < 70 ? 'mixed' : 'none', dentils: false, seed: Math.round(x * 3 + z) });
    const k = rng.next();
    if (h > 105 && k < 0.4) crowns.add(x, h, z, 0, w * 0.98, Math.min(w, d) * 0.9, d * 0.98, rng.pick(['#2f7f6f', '#c9a24a', '#e8e8e8', '#9a2b2b', '#2b3f6b']));
    else if (h > 70 && k < 0.75) {
      batch.add(x, h, z, 0, w * 0.7, h * 0.13, d * 0.7, tint);
      if (rng.chance(0.6)) spires.add(x, h * 1.13, z, 0, 1.4, rng.range(14, 30), 1.4, '#e8eef5');
    } else if (h < 80 && k < 0.9) tanks.add(x + w * rng.range(-0.25, 0.25), h, z + d * rng.range(-0.25, 0.25), rng.next() * 6, 1.1);
  };
  const towers = (n: number, rect: { minX: number; maxX: number; minZ: number; maxZ: number }, hRange: [number, number], wRange: [number, number], margin: number) => {
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < 15; t++) {
        const x = rng.range(rect.minX, rect.maxX), z = rng.range(rect.minZ, rect.maxZ);
        const w = rng.range(wRange[0], wRange[1]), d = rng.range(wRange[0], wRange[1]);
        const r = Math.max(w, d) * 0.6;
        if (!placer.ok(x, z, r, margin)) continue;
        placer.reserve(x, z, r);
        // taller toward the center of downtown
        const core = Math.max(0, 1 - Math.hypot(x + 560, z - 120) / 420);
        addTower(x, z, w, d, rng.range(hRange[0], hRange[1]) * (0.55 + core));
        break;
      }
    }
  };
  const nT = quality === 'high' ? 1 : quality === 'medium' ? 0.7 : 0.45;
  towers(Math.round(140 * nT), { minX: -820, maxX: -390, minZ: -420, maxZ: 560 }, [60, 150], [16, 30], 10);
  towers(Math.round(60 * nT), { minX: -420, maxX: -40, minZ: 360, maxZ: 640 }, [40, 120], [16, 28], 10);
  towers(Math.round(25 * nT), { minX: -420, maxX: -360, minZ: -300, maxZ: 340 }, [30, 80], [14, 22], 10);
  towers(Math.round(30 * nT), { minX: -300, maxX: -40, minZ: -420, maxZ: -290 }, [25, 70], [16, 26], 10);
  bA.build(group);
  bB.build(group);
  bC.build(group);
  crowns.build(group);
  spires.build(group);
  tanks.build(group);


  /* ------------------------------------------------ CHICAGO start arch */
  {
    const s0 = track.sampleAt(0, 0);
    const wd = s0.halfWidth + def.shoulder + 2.5;
    const arch = new THREE.Group();
    const red = '#d7262e';
    const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [];
    for (const side of [-1, 1]) {
      // lattice towers
      if (lo) parts.push([new THREE.BoxGeometry(2.4, 18, 2.4), red, M.t(side * wd, 9, 0)]);
      else {
        // open lattice tower: four chords, cross bracing on every face, bolted base plates
        for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push([new THREE.BoxGeometry(0.34, 18, 0.34), red, M.t(side * wd + cx * 1.05, 9, cz * 1.05)]);
        for (let y = 0.6; y < 17.5; y += 1.6) {
          for (const f of [-1, 1]) {
            beam(parts, [side * wd - 1.05, y, f * 1.05], [side * wd + 1.05, y + 1.6, f * 1.05], 0.12, '#b81f27');
            beam(parts, [side * wd + f * 1.05, y, -1.05], [side * wd + f * 1.05, y + 1.6, 1.05], 0.12, '#b81f27');
          }
        }
        parts.push([new THREE.BoxGeometry(1.4, 18, 1.4), '#9e1b22', M.t(side * wd, 9, 0)]);
      }
      parts.push([new THREE.BoxGeometry(3.4, 1.2, 3.4), '#9e1b22', M.t(side * wd, 18.4, 0)]);
      parts.push([new THREE.ConeGeometry(2.0, 3.2, 4).rotateY(Math.PI / 4), red, M.t(side * wd, 20.6, 0)]);
      parts.push([new THREE.BoxGeometry(3.2, 1.2, 3.2), '#bfbfbf', M.t(side * wd, 0.6, 0)]);
      for (let y = 2; y < 17; y += 3) parts.push([new THREE.BoxGeometry(2.7, 0.35, 2.7), '#9e1b22', M.t(side * wd, y, 0)]);
    }
    // the arch: a curved truss between the towers
    const N = 24;
    for (let i = 0; i < N; i++) {
      const a0 = Math.PI * (i / N), a1 = Math.PI * ((i + 1) / N);
      const x0 = -Math.cos(a0) * wd, y0 = 15 + Math.sin(a0) * 7, x1 = -Math.cos(a1) * wd, y1 = 15 + Math.sin(a1) * 7;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      parts.push([new THREE.BoxGeometry(len + 0.1, 0.8, 1.2), red, M.trs((x0 + x1) / 2, (y0 + y1) / 2, 0, 0, 0, ang)]);
      parts.push([new THREE.BoxGeometry(len + 0.1, 0.5, 0.9), red, M.trs((x0 + x1) / 2, (y0 + y1) / 2 - 3, 0, 0, 0, ang * 0.9)]);
      parts.push([new THREE.BoxGeometry(0.35, 3, 0.35), '#9e1b22', M.trs((x0 + x1) / 2, (y0 + y1) / 2 - 1.5, 0, 0, 0, i % 2 ? 0.5 : -0.5)]);
    }
    const am = new THREE.Mesh(bag.add(mergeColored(parts)), vcGloss);
    am.castShadow = true;
    arch.add(am);
    const signTex = bag.add(textTexture('CHICAGO', { w: 1024, h: 256, bg: red, fg: '#ffffff', stroke: '#7a0f14', border: '#ffffff' }));
    const sign = new THREE.Mesh(bag.add(new THREE.BoxGeometry(22, 5.2, 0.8)), [
      bag.add(new THREE.MeshStandardMaterial({ color: red })),
      bag.add(new THREE.MeshStandardMaterial({ color: red })),
      bag.add(new THREE.MeshStandardMaterial({ color: red })),
      bag.add(new THREE.MeshStandardMaterial({ color: red })),
      bag.add(new THREE.MeshStandardMaterial({ map: signTex, emissive: '#ffffff', emissiveMap: signTex, emissiveIntensity: 0.25 })),
      bag.add(new THREE.MeshStandardMaterial({ map: signTex, emissive: '#ffffff', emissiveMap: signTex, emissiveIntensity: 0.25 })),
    ]);
    sign.position.y = 18.5;
    sign.castShadow = true;
    arch.add(sign);
    // checkered banner under the sign
    const chk = canvasTexture(256, 32, (g, w, h) => {
      for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
        g.fillRect((x * w) / 16, (y * h) / 2, w / 16 + 1, h / 2 + 1);
      }
    }, { repeat: false });
    bag.add(chk);
    const banner = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(wd * 2 - 3, 1.4)), bag.add(new THREE.MeshStandardMaterial({ map: chk, side: THREE.DoubleSide })));
    banner.position.y = 12.6;
    arch.add(banner);
    arch.position.set(s0.x, s0.y, s0.z);
    arch.rotation.y = Math.atan2(s0.tx, s0.tz);
    group.add(arch);
    placer.reserve(s0.x + s0.nx * wd, s0.z + s0.nz * wd, 4);
    placer.reserve(s0.x - s0.nx * wd, s0.z - s0.nz * wd, 4);
  }

  /* ------------------------------------------------ grandstands near the start */
  {
    const crowd = bag.add(crowdTexture(17));
    crowd.repeat.set(3, 1);
    const crowdMat = bag.add(new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 }));
    const standGeo = bag.add(
      (() => {
        // stepped seating 24 m long, 4 rows, rising away from the road (+Z faces road)
        const g = new THREE.BufferGeometry();
        const pos: number[] = [], uv: number[] = [], idx: number[] = [];
        const L = 24, rows = 6;
        let vi = 0;
        for (let r = 0; r < rows; r++) {
          const z = -r * 1.4, y = 1 + r * 1.1;
          // riser (vertical face) then tread
          for (const [ya, yb, za, zb, v0, v1] of [[y - 1.1, y, z, z, r / rows, (r + 0.6) / rows], [y, y, z, z - 1.4, (r + 0.6) / rows, (r + 1) / rows]] as const) {
            pos.push(-L / 2, ya, za, L / 2, ya, za, -L / 2, yb, zb, L / 2, yb, zb);
            uv.push(0, v0, 1, v0, 0, v1, 1, v1);
            idx.push(vi, vi + 1, vi + 2, vi + 2, vi + 1, vi + 3);
            vi += 4;
          }
        }
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        return g;
      })(),
    );
    const frameGeo = bag.add(
      mergeColored([
        [new THREE.BoxGeometry(24.4, 7.6, 0.4), '#d7262e', M.t(0, 3.8, -8.6)],
        [new THREE.BoxGeometry(0.4, 7.6, 8.6), '#f2f2f2', M.t(-12.2, 3.8, -4.3)],
        [new THREE.BoxGeometry(0.4, 7.6, 8.6), '#f2f2f2', M.t(12.2, 3.8, -4.3)],
        [new THREE.BoxGeometry(25, 0.4, 10), '#e8e8e8', M.trs(0, 10.5, -4, -0.12, 0, 0)],
        [new THREE.CylinderGeometry(0.2, 0.2, 10, 6), '#e8e8e8', M.t(-11.8, 5.5, 0.4)],
        [new THREE.CylinderGeometry(0.2, 0.2, 10, 6), '#e8e8e8', M.t(11.8, 5.5, 0.4)],
        [new THREE.CylinderGeometry(0.2, 0.2, 10, 6), '#e8e8e8', M.t(0, 5.5, 0.4)],
        [new THREE.BoxGeometry(24.4, 1.0, 0.3), '#d7262e', M.t(0, 0.5, 0.3)],
      ]),
    );
    const seats = new Batch(standGeo, crowdMat, { name: 'grandstands' });
    const frames = new Batch(frameGeo, vc);
    const L = track.length;
    const spots = placer.along(0, 30, 5, 13, { side: 1, from: L - 150, to: L - 20 }).concat(placer.along(0, 30, 5, 13, { side: 1, from: 30, to: 110 }));
    const fanCols = ['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#41B6E6', '#ff5fa2', '#E4002B'];
    const rowsStep = hi ? 1 : 2;
    for (const s of spots) {
      seats.add(s.x, s.y, s.z, s.yaw);
      frames.add(s.x, s.y, s.z, s.yaw);
      if (lo) continue;
      const cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      for (let r = 0; r < 6; r += rowsStep) {
        for (let lx = -11; lx <= 11; lx += hi ? 1.25 : 1.9) {
          if (rng.chance(0.15)) continue;
          const lz = -r * 1.4 - 0.75, ly = 1 + r * 1.1;
          kit.person(s.x + cs * lx + sn * lz, s.y + ly, s.z - sn * lx + cs * lz, s.yaw, rng.pick(fanCols), 0.9);
        }
      }
    }
    seats.build(group);
    frames.build(group);
  }

  /* ------------------------------------------------ Buckingham Fountain */
  {
    const fo = lm('fountain') ?? { x: -250, z: 80 };
    buildBuckingham(kit, placer, fo.x, fo.z, lakeMat);
  }

  /* ------------------------------------------------ river bridge at the gap */
  {
    const gap = def.gaps[0];
    if (gap) {
      const L = track.length;
      const sa = gap.from * L, sb = gap.to * L;
      const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [];
      const red = '#c62828';
      for (const [s0, s1] of [[sa - 30, sa], [sb, sb + 30]]) {
        for (const side of [-1, 1]) {
          const a = track.sampleAt(0, s0), b = track.sampleAt(0, s1);
          const lat = side * (a.halfWidth + def.shoulder + 1.6);
          const ax = a.x + a.nx * lat, az = a.z + a.nz * lat, bx = b.x + b.nx * lat, bz = b.z + b.nz * lat;
          const len = Math.hypot(bx - ax, bz - az);
          const yaw = Math.atan2(bx - ax, bz - az);
          const cx = (ax + bx) / 2, cz = (az + bz) / 2, y = (a.y + b.y) / 2;
          parts.push([new THREE.BoxGeometry(0.8, 0.8, len), red, M.trs(cx, y + 5.5, cz, 0, yaw, 0)]);
          parts.push([new THREE.BoxGeometry(0.8, 0.8, len), red, M.trs(cx, y + 0.6, cz, 0, yaw, 0)]);
          const n = Math.round(len / 3);
          for (let k = 0; k <= n; k++) {
            const t = k / n;
            const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
            parts.push([new THREE.BoxGeometry(0.4, 5, 0.4), red, M.trs(x, y + 3, z, 0, yaw, 0)]);
            if (k < n) parts.push([new THREE.BoxGeometry(0.3, 5.8, 0.3), red, M.trs(x + ((bx - ax) / n) * 0.5, y + 3, z + ((bz - az) / n) * 0.5, k % 2 ? 0.55 : -0.55, yaw, 0)]);
          }
          // bridge tender house at the river end
          const ex = s1 === sa ? bx : ax, ez = s1 === sa ? bz : az;
          const ox = side * a.nx * 6, oz = side * a.nz * 6;
          parts.push([new THREE.BoxGeometry(7, 9, 7), '#e5d5b5', M.trs(ex + ox, y + 4.5 - 3, ez + oz, 0, yaw, 0)]);
          parts.push([new THREE.ConeGeometry(5.6, 4, 4), '#3f8f7a', M.trs(ex + ox, y + 8.5, ez + oz, 0, yaw + Math.PI / 4, 0)]);
          placer.reserve(ex + ox, ez + oz, 6);
        }
      }
      // river walls along the channel
      for (const c of field.channels) {
        for (const side of [-1, 1]) {
          const ox = -c.az * side * (c.halfWidth + 1), oz = c.ax * side * (c.halfWidth + 1);
          parts.push([new THREE.BoxGeometry(c.halfLen * 2, 7.2, 1.2), '#bdb6a6', M.trs(c.cx + ox, -3.3, c.cz + oz, 0, -Math.atan2(c.az, c.ax), 0)]);
        }
      }
      const bm = new THREE.Mesh(bag.add(mergeColored(parts)), vcGloss);
      bm.castShadow = bm.receiveShadow = true;
      group.add(bm);
    }
  }

  /* ------------------------------------------------ the river: dyed St. Patrick's green, bascule bridges, Riverwalk, tour boats */
  for (const c of field.channels) {
    const ang = -Math.atan2(c.az, c.ax);
    const base = M.trs(c.cx, 0, c.cz, 0, ang, 0); // local x along the river, z across
    const at = (lx: number, ly: number, lz: number, ry = 0, rx = 0, rz = 0) => base.clone().multiply(M.trs(lx, ly, lz, rx, ry, rz));
    const greenTex = bag.add(waterTexture('#13b24a', '#9dffb5', 91));
    greenTex.repeat.set((c.halfLen * 2) / 14, (c.halfWidth * 2) / 14);
    const greenMat = bag.add(new THREE.MeshStandardMaterial({ color: '#2fe06a', map: greenTex, roughness: 0.12, metalness: 0.15, emissive: '#0b5a26', emissiveIntensity: 0.35 }));
    const river = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(c.halfLen * 2 + 4, c.halfWidth * 2 + 2).rotateX(-Math.PI / 2)), greenMat);
    river.applyMatrix4(at(0, -2.05, 0));
    river.receiveShadow = true;
    river.name = 'greenRiver';
    group.add(river);
    updaters.push((dt) => {
      greenTex.offset.x -= dt * 0.03;
    });
    // Riverwalk ledges with planters and umbrellas
    for (const side of [-1, 1]) {
      kit.solid.push([new THREE.BoxGeometry(c.halfLen * 2, 0.5, 2.4), '#d8cfbd', at(0, -0.95, side * (c.halfWidth - 0.4))]);
      for (let lx = -c.halfLen + 8; lx < c.halfLen - 8; lx += 16) {
        if (Math.abs(lx - 5) < 18) continue; // keep clear under the jump
        kit.solid.push([new THREE.CylinderGeometry(0.05, 0.05, 2.2, 4), '#dddddd', at(lx, 0.4, side * (c.halfWidth - 0.6))]);
        kit.solid.push([new THREE.ConeGeometry(1.3, 0.6, 8), rng.pick(['#e8392b', '#ffd23f', '#1f8f3a', '#2f7de1']), at(lx, 1.6, side * (c.halfWidth - 0.6))]);
      }
    }
    // decorative bascule bridges (leaves raised) up and down the river
    for (const bx of [-c.halfLen + 30, c.halfLen - 34]) {
      for (const side of [-1, 1]) {
        const leaf = at(bx, 0.2, side * (c.halfWidth + 1), 0, side * 1.0, 0);
        kit.gloss.push([new THREE.BoxGeometry(10, 0.7, 9.5), '#6b6f76', leaf.clone().multiply(M.t(0, 0, -side * 4.75))]);
        for (const tx of [-4.6, 4.6]) {
          if (lo) kit.gloss.push([new THREE.BoxGeometry(0.6, 2.2, 9.5), '#b3202a', leaf.clone().multiply(M.t(tx, 1.1, -side * 4.75))]);
          else {
            // riveted Pratt truss: chords, verticals, diagonals and gusset plates
            for (const cy of [0.25, 2.3]) kit.gloss.push([new THREE.BoxGeometry(0.5, 0.35, 9.6), '#b3202a', leaf.clone().multiply(M.t(tx, cy, -side * 4.75))]);
            for (let k = 0; k <= 6; k++) {
              const z = -side * (k * 1.58 + 0.05);
              kit.gloss.push([new THREE.BoxGeometry(0.4, 2.1, 0.3), '#b3202a', leaf.clone().multiply(M.t(tx, 1.27, z))]);
              kit.near('gloss', new THREE.BoxGeometry(0.62, 0.7, 0.7), '#8f1820', leaf.clone().multiply(M.t(tx, 2.2, z)));
              if (hi) for (const ry of [2.05, 2.35]) for (const rz of [-0.18, 0.18]) kit.near('gloss', new THREE.CylinderGeometry(0.05, 0.05, 0.7, 5).rotateZ(Math.PI / 2), '#d6d6d6', leaf.clone().multiply(M.t(tx, ry, z + rz)));
            }
          }
          for (let k = 0; k < 4; k++) beam(kit.gloss, [tx, 0.2, -side * (k * 2.3 + 0.2)], [tx, 2.1, -side * (k * 2.3 + 1.3)], 0.25, '#b3202a', leaf);
        }
        // tender house
        kit.solid.push([new THREE.BoxGeometry(5, 6, 5), '#e8dcc0', at(bx + 9, 3, side * (c.halfWidth + 5))]);
        kit.solid.push([new THREE.ConeGeometry(4, 3, 4).rotateY(Math.PI / 4), '#3f8f7a', at(bx + 9, 7.5, side * (c.halfWidth + 5))]);
        kit.solid.push([new THREE.BoxGeometry(1.6, 1.6, 0.2), '#1d2b3f', at(bx + 9, 3.6, side * (c.halfWidth + 5) - side * 2.55)]);
      }
    }
    // tour boats cruising under the jump
    const boatGeo2 = bag.add(mergeColored([
      [new THREE.BoxGeometry(11, 1.4, 3.8), '#ffffff', M.t(0, 0.4, 0)],
      [new THREE.ConeGeometry(1.9, 2.4, 4).rotateZ(-Math.PI / 2).rotateX(Math.PI / 4), '#ffffff', M.trs(6.6, 0.4, 0, 0, 0, 0, 1, 0.52, 1.4)],
      [new THREE.BoxGeometry(11.1, 0.3, 3.9), '#1b2f5c', M.t(0, 1.0, 0)],
      [new THREE.BoxGeometry(6, 1.3, 3.2), '#eef3f8', M.t(-1.5, 1.8, 0)],
      [new THREE.BoxGeometry(5.6, 0.7, 3.25), '#33506e', M.t(-1.5, 1.9, 0)],
      [new THREE.BoxGeometry(6.4, 0.15, 3.6), '#ffd23f', M.t(-1.5, 2.5, 0)],
    ]));
    const NB = lo ? 1 : 2;
    const boatsIM = new THREE.InstancedMesh(boatGeo2, tintMaskMat(bag, { roughness: 0.4 }), NB);
    boatsIM.setColorAt(0, new THREE.Color('#e8f4ff'));
    if (NB > 1) boatsIM.setColorAt(1, new THREE.Color('#fff4d6'));
    boatsIM.frustumCulled = false;
    boatsIM.castShadow = true;
    group.add(boatsIM);
    const tmpM = new THREE.Matrix4();
    updaters.push((_dt, t) => {
      for (let i = 0; i < NB; i++) {
        const span = c.halfLen * 2 - 24;
        const ph = ((t / 40 + i * 0.5) % 2);
        const f = ph < 1 ? ph : 2 - ph;
        const lx = -span / 2 + f * span;
        const yaw = ph < 1 ? 0 : Math.PI;
        tmpM.copy(base).multiply(M.trs(lx, -1.85 + Math.sin(t * 1.4 + i) * 0.06, (i ? 1 : -1) * 2.6, 0, yaw, Math.sin(t + i) * 0.02));
        boatsIM.setMatrixAt(i, tmpM);
      }
      boatsIM.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ flags */
  {
    const chiTex = bag.add(flagTexture('chicago'));
    const chkTex = bag.add(flagTexture('checker'));
    const poleGeo = bag.add(PROPS.flagpole());
    const clothGeo = bag.add(flagGeometry(3, 2));
    const poles = new Batch(poleGeo, vc, { name: 'flagpoles' });
    const chi = new Batch(clothGeo, flagMaterial(bag, chiTex, timeU), { cast: false });
    const chk = new Batch(clothGeo, flagMaterial(bag, chkTex, timeU), { cast: false });
    const L = track.length;
    const spots = placer.along(0, 22, 3, 1, { from: 0, to: 360, side: -1 })
      .concat(placer.along(0, 22, 3, 1, { from: L - 330, to: L, side: -1 }))
      .concat(placer.along(0, 40, 2.5, 1, { from: 200, to: L - 200 }));
    spots.forEach((s, i) => {
      poles.add(s.x, s.y, s.z, 0);
      const nearStart = i % 3 === 0;
      (nearStart ? chk : chi).add(s.x, s.y + 7.9, s.z, Math.PI / 2 + 0.6);
    });
    poles.build(group);
    chi.build(group);
    chk.build(group);
  }

  /* ------------------------------------------------ billboards (one atlas, one draw call) */
  {
    const boards = [
      kit.paint.text('DEEP DISH PIZZA', 512, 128, { bg: '#ffd23f', fg: '#c62828', border: '#c62828' }),
      kit.paint.text('GO TEAM FAMILY!', 512, 128, { bg: '#1f4fbf', fg: '#ffffff', border: '#ffd23f' }),
      kit.paint.text('CHICAGO-STYLE HOT DOGS', 512, 128, { bg: '#3ccf6e', fg: '#ffffff', border: '#ffd23f', stroke: '#1f6b3a' }),
      kit.paint.text('WINDY CITY GP', 512, 128, { bg: '#d7262e', fg: '#ffffff', border: '#ffffff' }),
      kit.paint.draw(512, 128, (g, w, h) => {
        drawChicagoFlag(g, 0, 0, w, h);
      }, 'bbFlag'),
      kit.paint.text('THE WINDY CITY\nWELCOMES RACERS', 512, 128, { bg: '#41B6E6', fg: '#ffffff', stroke: '#1d5f86' }),
      kit.paint.text('ITALIAN BEEF\nDIPPED + HOT', 512, 128, { bg: '#ffffff', fg: '#c8102e', border: '#1f8f3a' }),
      kit.paint.text('LAKE SHORE DRIVE', 512, 128, { bg: '#1d6b3a', fg: '#ffffff', border: '#ffffff' }),
    ];
    const frameGeo = mergeColored([
      [new THREE.BoxGeometry(0.4, 5, 0.4), '#555', M.t(-5.5, 2.5, -0.3)],
      [new THREE.BoxGeometry(0.4, 5, 0.4), '#555', M.t(5.5, 2.5, -0.3)],
      [new THREE.BoxGeometry(12.6, 3.6, 0.3), '#222', M.t(0, 5.6, -0.2)],
    ]);
    const frames = kit.batch(frameGeo, vc, { name: 'billboardFrames' });
    const spots = placer.along(0, lo ? 220 : 140, 2, 7, { side: 0 });
    spots.forEach((s, i) => {
      frames.add(s.x, s.y, s.z, s.yaw);
      kit.paint.quad(boards[i % boards.length], 12, 3, M.trs(s.x, s.y + 5.6, s.z, 0, s.yaw, 0));
    });
  }

  /* ------------------------------------------------ lamps with Chicago banners */
  {
    const lamps = new Batch(bag.add(PROPS.lamp('#2b3445', '#fff6d0')), vc, { name: 'lamps' });
    const banners = lo ? null : bannerBatch(kit);
    for (const s of placer.along(0, 48, 1.2, 0.6, { jitter: 0 })) {
      lamps.add(s.x, s.y, s.z, s.yaw);
      banners?.add(s.x, s.y + 4.4, s.z, s.yaw - Math.PI / 2);
    }
    lamps.build(group);
  }
  tireWalls(kit, placer);
  streetLife(kit, placer, { sparse: 1.1 });

  /* ------------------------------------------------ street food, bus shelters, bikes + fans */
  {
    const shirt = ['#e8443a', '#2f7de1', '#ffd23f', '#3ccf6e', '#ffffff', '#ff8a3d', '#b05cf0', '#41B6E6', '#14315e', '#ff5fa2'];
    const stands = [hotDogStand, pizzeria, hotDogStand, beefStand, popcornShop];
    const spots = placer.along(0, lo ? 320 : 170, 6.5, 6.5, { side: 0 });
    spots.forEach((s, i) => {
      stands[i % stands.length](kit, s.x, s.y, s.z, s.yaw);
      if (!lo) {
        const n = hi ? 4 : 2;
        for (let p = 0; p < n; p++) {
          const lx = -2.5 + p * 1.6 + rng.range(-0.3, 0.3), lz = 4.2 + rng.range(-0.4, 0.6);
          const cx = s.x + Math.cos(s.yaw) * lx + Math.sin(s.yaw) * lz, cz = s.z - Math.sin(s.yaw) * lx + Math.cos(s.yaw) * lz;
          kit.person(cx, field.height(cx, cz), cz, s.yaw + Math.PI + rng.range(-0.5, 0.5), rng.pick(shirt));
        }
      }
    });
    if (lo) {
      // (finer street furniture comes from streetLife below on medium / high)
    }
    if (!lo) {
      // fans around the Bean and at the Crown Fountain pool
      const bean = { x: -95, z: 95 };
      for (let i = 0; i < (hi ? 26 : 12); i++) {
        const a = rng.next() * Math.PI * 2, d = rng.range(13, 22);
        const x = bean.x + Math.cos(a) * d, z = bean.z + Math.sin(a) * d;
        kit.person(x, field.height(x, z) + 0.4, z, Math.atan2(bean.x - x, bean.z - z), rng.pick(shirt), rng.range(0.7, 1));
      }
      for (let i = 0; i < (hi ? 14 : 6); i++) {
        const x = -48 + rng.range(-14, 14), z = 10 + rng.range(-3, 3);
        kit.person(x, field.height(x, z) + 0.3, z, rng.next() * 6, rng.pick(shirt), rng.range(0.55, 0.8));
      }
    }
  }

  /* ------------------------------------------------ trees, bushes, benches (Grant Park + lakefront) */
  {
    const b = field.bounds;
    const treeA = new Batch(bag.add(PROPS.roundTree('#3fa34d', '#5cc25e')), vc, { name: 'treesA' });
    const treeB = new Batch(bag.add(PROPS.roundTree('#2f8f45', '#7ccf5a', '#6b4425')), vc, { name: 'treesB' });
    const bushes = new Batch(bag.add(PROPS.bush('#3f9a3a', '#6cc04f')), vc, { name: 'bushes', cast: false });
    const flowers = new Batch(bag.add(lo ? mergeColored([
      [new THREE.CylinderGeometry(2.2, 2.4, 0.5, 12), '#7a5230', M.t(0, 0.25, 0)],
      [new THREE.IcosahedronGeometry(1.9, 1), '#ff5fa2', M.trs(0, 0.7, 0, 0, 0, 0, 1, 0.35, 1)],
    ]) : flowerBed(quality, 2.3, 21)), lo ? vc : kit.tintMat, { cast: false });
    const n = density;
    const park = { minX: b.minX - 20, maxX: b.maxX + 10, minZ: b.minZ - 10, maxZ: b.maxZ + 10 };
    for (const s of placer.scatter(Math.round(260 * n), park, 3.5, 3)) (rng.chance(0.5) ? treeA : treeB).add(s.x, s.y, s.z, s.yaw, rng.range(0.9, 1.4));
    for (const s of placer.scatter(Math.round(120 * n), park, 1.6, 1.5)) bushes.add(s.x, s.y, s.z, s.yaw, rng.range(0.8, 1.5));
    for (const s of placer.scatter(Math.round(30 * n), park, 2.6, 4)) flowers.add(s.x, s.y, s.z, 0, 1, 1, 1, rng.pick(['#ff5fa2', '#ffd23f', '#ff7a3d', '#b48cff', '#ffffff']));
    // lakefront row
    for (let z = b.minZ - 200; z < b.maxZ + 200; z += 14) {
      const x = shoreX - 7 - rng.range(0, 6);
      if (placer.ok(x, z, 3, 2)) {
        placer.reserve(x, z, 3);
        treeA.add(x, field.height(x, z), z, rng.next() * 6, rng.range(1, 1.3));
      }
    }
    const benches = new Batch(bag.add(PROPS.bench()), vc, { cast: false });
    for (const s of placer.along(0, 60, 4, 1.5, { side: 0 })) benches.add(s.x, s.y, s.z, s.yaw + Math.PI);
    treeA.build(group);
    treeB.build(group);
    bushes.build(group);
    if (!lo) flowers.build(group);
    if (hi) benches.build(group);
    edgeGrass(kit, placer, { base: '#3f8a34', tip: '#9fd66a', flowers: ['#ffffff', '#ffd23f', '#ff8fc0', '#b48cff'] });
  }

  /* ------------------------------------------------ beach with umbrellas north of the pier */
  {
    const bz0 = 110, bz1 = 420;
    const sand = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(26, bz1 - bz0)), bag.add(new THREE.MeshStandardMaterial({ color: '#f3dca4', roughness: 1 })));
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(shoreX + 10, -0.75, (bz0 + bz1) / 2);
    sand.receiveShadow = true;
    group.add(sand);
    const umb = bag.add(mergeColored([
      [new THREE.CylinderGeometry(0.06, 0.06, 3, 5), '#eeeeee', M.t(0, 1.5, 0)],
      [new THREE.ConeGeometry(1.8, 0.8, 8), '#ffffff', M.t(0, 3.1, 0)],
    ]));
    const umbrellas = new Batch(umb, vc, { name: 'umbrellas' });
    const towels = new Batch(bag.add(new THREE.PlaneGeometry(1.2, 2.2).rotateX(-Math.PI / 2).translate(0, 0.03, 0)), bag.add(new THREE.MeshStandardMaterial({ roughness: 1 })), { cast: false });
    const cols = ['#ff4d6d', '#ffd23f', '#3aa8ff', '#3ccf6e', '#ff8a3d', '#b26bff'];
    for (let z = bz0 + 8; z < bz1 - 8; z += rng.range(9, 16)) {
      const x = shoreX + rng.range(3, 18);
      umbrellas.add(x, -0.75, z, rng.next() * 6, 1, 1, 1, rng.pick(cols));
      towels.add(x + 1.6, -0.75, z + rng.range(-1, 1), rng.range(-0.3, 0.3), 1, 1, 1, rng.pick(cols));
    }
    umbrellas.build(group);
    if (!lo) towels.build(group);
    if (!lo) {
      // soft dunes with marram grass along the back of the beach
      const duneGeo = canopy([{ x: 0, y: -0.6, z: 0, r: 3.2, sy: 0.35 }, { x: 2.4, y: -0.7, z: 0.6, r: 2.4, sy: 0.32 }, { x: -2.2, y: -0.75, z: -0.5, r: 2.2, sy: 0.3 }], '#d9bf86', '#fbe9bc', 1, 77, { center: new THREE.Vector3(0, -3, 0), bumpy: 0.2, soft: 0.8 });
      const dunes = kit.batch(duneGeo, kit.solidMat, { cast: false, name: 'dunes' });
      const marram = kit.batch(grassTuft('#8a9a4a', '#d8d79a', quality, { h: 0.9, blades: hi ? 9 : 6, seed: 3, spread: 0.3 }), kit.solidMat, { cast: false, name: 'marram' });
      for (let z = bz0 + 4; z < bz1 - 4; z += rng.range(10, 18)) {
        const x = shoreX + rng.range(0.5, 2.2);
        dunes.add(x, -0.75, z, rng.next() * 6, rng.range(0.8, 1.3), rng.range(0.8, 1.4), rng.range(0.8, 1.2));
        for (let m = 0; m < (hi ? 9 : 5); m++) marram.add(x + rng.range(-1.5, 3), -0.75 + rng.range(0.1, 0.4), z + rng.range(-3, 3), rng.next() * 6, rng.range(0.8, 1.3));
      }
    }
    if (hi) {
      const guards = kit.batch(lifeguardGeo(), vc, { name: 'lifeguards' });
      for (let z = bz0 + 30; z < bz1 - 20; z += 95) guards.add(shoreX + 13, -0.75, z, -Math.PI / 2);
    }
    const beachSign = kit.paint.text('OAK STREET BEACH', 512, 96, { bg: '#ffd23f', fg: '#1d4f9c', border: '#1d4f9c' });
    kit.paint.quad(beachSign, 10, 1.9, M.trs(shoreX - 2, 3.2, bz0 + 14, 0, -Math.PI / 2, 0), true);
    kit.solid.push([new THREE.BoxGeometry(0.3, 3, 0.3), '#555', M.t(shoreX - 2, 1.0, bz0 + 9.5)]);
    kit.solid.push([new THREE.BoxGeometry(0.3, 3, 0.3), '#555', M.t(shoreX - 2, 1.0, bz0 + 18.5)]);
  }

  /* ------------------------------------------------ seagulls */
  {
    const gullGeo = bag.add(
      (() => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.5, -1.4, 0.45, -0.1, 0, 0, -0.4, 0, 0, 0.5, 0, 0, -0.4, 1.4, 0.45, -0.1], 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
        g.computeVertexNormals();
        return mergeColored([
          [g, '#ffffff'],
          [new THREE.ConeGeometry(0.18, 1.2, 5).rotateX(Math.PI / 2), '#f0f0f0', M.t(0, 0, 0.1)],
          [new THREE.ConeGeometry(0.07, 0.25, 4).rotateX(Math.PI / 2), '#ffb300', M.t(0, 0, 0.8)],
        ]);
      })(),
    );
    const gm = bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }));
    const NGull = 26;
    const gulls = new THREE.InstancedMesh(gullGeo, gm, NGull);
    gulls.frustumCulled = false;
    const gd = Array.from({ length: NGull }, () => ({ cx: shoreX + rng.range(-60, 160), cz: rng.range(-250, 330), r: rng.range(15, 45), h: rng.range(14, 34), w: rng.range(0.25, 0.5) * (rng.chance(0.5) ? 1 : -1), ph: rng.next() * 6 }));
    group.add(gulls);
    updaters.push((_dt, t) => {
      gd.forEach((g, i) => {
        const a = t * g.w + g.ph;
        const flap = 1 + Math.sin(t * 9 + g.ph * 3) * 0.7;
        setInstance(gulls, i, g.cx + Math.cos(a) * g.r, g.h + Math.sin(t * 0.7 + g.ph) * 2, g.cz + Math.sin(a) * g.r, 0, -a + (g.w > 0 ? Math.PI : 0), -Math.sign(g.w) * 0.35, 1.6, 1.6 * flap, 1.6);
      });
      gulls.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ clouds */
  const cloudUpdate = addClouds(ctx, bag, quality === 'low' ? 10 : 22, [150, 260], 1400, '#ffffff', 31);
  updaters.push(cloudUpdate);

  if (!lo) windGusts(kit, ['#7cc65a', '#c9e265', '#f2b13c', '#e0882c', '#ffffff'], hi ? 420 : 200, { speed: 10 });
  /* ------------------------------------------------ MOAR Chicago life: dogs in Grant Park, kites over the beach */
  if (!lo) {
    const fb = field.bounds;
    runningDogs(kit, (x, z) => field.height(x, z), placer.scatter(hi ? 10 : 5, { minX: fb.minX - 20, maxX: Math.min(fb.maxX, shoreX - 20), minZ: fb.minZ, maxZ: fb.maxZ }, 8, 3), { seed: 312 });
    kites(kit, [0, 1, 2].map((i) => ({ x: shoreX + rng.range(6, 16), z: 150 + i * 110, h: rng.range(24, 36) })), 41);
  }

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

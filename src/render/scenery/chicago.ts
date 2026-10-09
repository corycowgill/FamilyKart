import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SceneryContext, SceneryHandle } from './types';
import { addClouds, Batch, boxUV, ctxBits, disposeGroup, elevatedTrain, flagGeometry, flagMaterial, M, mergeColored, PROPS, setInstance, unitBox, vcMat, windowedMaterial } from './common';
import { getField } from './field';
import { canvasTexture, crowdTexture, dotTexture, flagTexture, textTexture, waterTexture, windowTexture } from './textures';

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
    const px0 = shoreX - 2, px1 = shoreX + 230, pz = pier.z;
    const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.BoxGeometry(px1 - px0, 1.2, 44), '#cdbfa6', M.t((px0 + px1) / 2, 0.6, pz)],
      [new THREE.BoxGeometry(px1 - px0, 2.5, 46), '#8b7d6b', M.t((px0 + px1) / 2, -1.2, pz)],
      // exhibition halls
      [new THREE.BoxGeometry(150, 9, 16), '#e9dcc4', M.t(px0 + 140, 5.7, pz + 12)],
      [new THREE.BoxGeometry(152, 1.2, 18), '#2f6f6a', M.t(px0 + 140, 10.8, pz + 12)],
      [new THREE.BoxGeometry(40, 16, 30), '#d9c19b', M.t(px1 - 22, 9.2, pz)],
      [new THREE.CylinderGeometry(9, 12, 6, 8), '#2f6f6a', M.t(px1 - 22, 20, pz)],
      [new THREE.BoxGeometry(14, 22, 14), '#c9a77c', M.t(px0 + 18, 12.2, pz + 10)],
      [new THREE.ConeGeometry(10.5, 6, 4).rotateY(Math.PI / 4), '#2f6f6a', M.t(px0 + 18, 26.2, pz + 10)],
    ];
    // railing posts along the pier edge
    for (let x = px0 + 4; x < px1; x += 8) {
      parts.push([new THREE.BoxGeometry(0.3, 1.1, 0.3), '#3c3c3c', M.t(x, 1.75, pz - 21.5)]);
    }
    parts.push([new THREE.BoxGeometry(px1 - px0, 0.2, 0.2), '#3c3c3c', M.t((px0 + px1) / 2, 2.2, pz - 21.5)]);
    const pm = new THREE.Mesh(bag.add(mergeColored(parts)), vc);
    pm.castShadow = pm.receiveShadow = true;
    group.add(pm);
    placer.reserve((px0 + px1) / 2, pz, 120);

    const fw = lm('ferrisWheel') ?? { x: 140, z: 40 };
    const R = 28;
    const hubY = 1.2 + R + 4;
    const wheelRoot = new THREE.Group();
    wheelRoot.position.set(fw.x, 0, fw.z - 6);
    wheelRoot.rotation.y = Math.PI / 2; // wheel plane faces the track (west)
    group.add(wheelRoot);
    // static A-frame supports
    const sup = mergeColored([
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(-9, hubY / 2, 3.5, 0, 0, -0.28)],
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(9, hubY / 2, 3.5, 0, 0, 0.28)],
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(-9, hubY / 2, -3.5, 0, 0, -0.28)],
      [new THREE.CylinderGeometry(0.6, 0.8, hubY * 1.12, 8), '#e8e8e8', M.trs(9, hubY / 2, -3.5, 0, 0, 0.28)],
      [new THREE.CylinderGeometry(1.4, 1.4, 9, 12).rotateX(Math.PI / 2), '#cfcfcf', M.t(0, hubY, 0)],
    ]);
    const supM = new THREE.Mesh(bag.add(sup), vcGloss);
    supM.castShadow = true;
    wheelRoot.add(supM);
    const wheel = new THREE.Group();
    wheel.position.y = hubY;
    wheelRoot.add(wheel);
    const wparts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.TorusGeometry(R, 0.45, 6, 64), '#ffffff', M.t(0, 0, 1.6)],
      [new THREE.TorusGeometry(R, 0.45, 6, 64), '#ffffff', M.t(0, 0, -1.6)],
      [new THREE.TorusGeometry(R * 0.55, 0.3, 6, 48), '#ff4d4d', M.t(0, 0, 0)],
    ];
    const NS = 20;
    for (let i = 0; i < NS; i++) {
      const a = (i / NS) * Math.PI * 2;
      for (const zz of [1.6, -1.6]) {
        wparts.push([new THREE.BoxGeometry(0.22, R, 0.22), i % 2 ? '#ff4d4d' : '#ffffff', M.trs(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, zz, 0, 0, a - Math.PI / 2)]);
      }
    }
    // rim lights
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      wparts.push([new THREE.SphereGeometry(0.42, 6, 4), i % 2 ? '#fff27a' : '#ff7ad9', M.t(Math.cos(a) * R, Math.sin(a) * R, 2.1)]);
    }
    const wheelMesh = new THREE.Mesh(bag.add(mergeColored(wparts)), bag.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2, emissive: '#331a22', emissiveIntensity: 0.4 })));
    wheelMesh.castShadow = true;
    wheel.add(wheelMesh);
    const NG = 24;
    const gondGeo = bag.add(
      mergeColored([
        [new THREE.CylinderGeometry(1.5, 1.3, 2.6, 8), '#ffffff', M.t(0, -2.2, 0)],
        [new THREE.CylinderGeometry(1.7, 1.7, 0.4, 8), '#ffffff', M.t(0, -0.8, 0)],
        [new THREE.CylinderGeometry(1.52, 1.52, 1.0, 8), '#3b5f8a', M.t(0, -1.7, 0)],
        [new THREE.BoxGeometry(0.2, 1.0, 0.2), '#888', M.t(0, -0.3, 0)],
      ]),
    );
    const gond = new THREE.InstancedMesh(gondGeo, vc, NG);
    gond.castShadow = true;
    const gcol = ['#ff5a5a', '#ffb02e', '#ffe14d', '#4cd97b', '#3aa8ff', '#b26bff'];
    for (let i = 0; i < NG; i++) gond.setColorAt(i, new THREE.Color(gcol[i % gcol.length]));
    gond.position.y = hubY;
    wheelRoot.add(gond);
    gond.frustumCulled = false;
    updaters.push((_dt, t) => {
      const rot = t * 0.12;
      wheel.rotation.z = rot;
      for (let i = 0; i < NG; i++) {
        const a = rot + (i / NG) * Math.PI * 2;
        setInstance(gond, i, Math.cos(a) * R, Math.sin(a) * R, 0, 0, 0, Math.sin(t * 1.5 + i) * 0.05, 1);
      }
      gond.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ skyline */
  const facadeA = bag.add(windowTexture({ wall: '#f4f1ea', glass: '#5b84ad', glass2: '#86b2d9', seed: 3 }));
  const facadeB = bag.add(windowTexture({ wall: '#e9e9ef', glass: '#3f6d9c', glass2: '#77a8d8', bands: true, seed: 4 }));
  const facadeC = bag.add(windowTexture({ wall: '#efe4d2', glass: '#2c3e57', glass2: '#4b6a8f', frame: 0.3, seed: 5 }));
  const matA = windowedMaterial(bag, facadeA, 12, 14);
  const matB = windowedMaterial(bag, facadeB, 13, 14, { roughness: 0.3, metalness: 0.35 });
  const matC = windowedMaterial(bag, facadeC, 10, 13);
  const box = bag.add(unitBox());
  const bA = new Batch(box, matA, { name: 'towersA' });
  const bB = new Batch(box, matB, { name: 'towersB' });
  const bC = new Batch(box, matC, { name: 'towersC' });
  const palette = ['#f2e3c6', '#cfe3f2', '#ffd6c9', '#e8d2f5', '#d8f0dc', '#ffe9a8', '#c9d6ea', '#f5c6b8', '#ffffff', '#bfe0ff'];
  const addTower = (x: number, z: number, w: number, d: number, h: number) => {
    const r = rng.next();
    const batch = r < 0.4 ? bA : r < 0.75 ? bB : bC;
    batch.add(x, 0, z, 0, w, h, d, rng.pick(palette));
    // occasional setback crown
    if (h > 70 && rng.chance(0.5)) batch.add(x, h, z, 0, w * 0.7, h * 0.12, d * 0.7, rng.pick(palette));
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
  // signature towers
  const sig = new THREE.Group();
  group.add(sig);
  {
    const dark = windowedMaterial(bag, bag.add(windowTexture({ wall: '#2c2f36', glass: '#4b5c74', glass2: '#6f86a6', frame: 0.18, seed: 8 })), 9, 14, { roughness: 0.35, metalness: 0.4 });
    const white = windowedMaterial(bag, bag.add(windowTexture({ wall: '#f2f2ee', glass: '#9fb6cc', glass2: '#c5d6e6', frame: 0.35, seed: 9 })), 7, 14, { roughness: 0.5 });
    const glass = windowedMaterial(bag, bag.add(windowTexture({ wall: '#b9cbe0', glass: '#6f97c3', glass2: '#9cc0e6', bands: true, seed: 10 })), 12, 14, { roughness: 0.15, metalness: 0.6 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.Mesh(bag.add(geo), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      sig.add(m);
    };
    // Willis (Sears) Tower: bundled tubes stepping back, twin white antennas
    const willis = { x: -520, z: 100 };
    const u = 13;
    const tubes: Array<[number, number, number]> = [
      [-1, -1, 160], [0, -1, 205], [1, -1, 160],
      [-1, 0, 230], [0, 0, 270], [1, 0, 205],
      [-1, 1, 160], [0, 1, 230], [1, 1, 270],
    ];
    for (const [i, j, h] of tubes) add(boxUV(u, h, u, willis.x + i * u, 0, willis.z + j * u), dark);
    add(mergeColored([
      [new THREE.CylinderGeometry(0.8, 1.2, 70, 6), '#f4f4f4', M.t(willis.x + 4, 270 + 35, willis.z + 6)],
      [new THREE.CylinderGeometry(0.8, 1.2, 62, 6), '#f4f4f4', M.t(willis.x + u - 2, 270 + 31, willis.z + u + 6)],
      [new THREE.CylinderGeometry(0.4, 0.4, 3, 6), '#ff3b3b', M.t(willis.x + 4, 270 + 71, willis.z + 6)],
    ]), vc);
    placer.reserve(willis.x, willis.z, 30);
    // John Hancock: tapered black tower with X-bracing and two antennas
    const hk = { x: -330, z: 520 };
    {
      const g = new THREE.CylinderGeometry(15, 24, 240, 4, 1).rotateY(Math.PI / 4).translate(0, 120, 0);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 4 * 30, uv.getY(i) * 240);
      g.translate(hk.x, 0, hk.z);
      add(g, dark);
      const xs: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [];
      for (let k = 0; k < 5; k++) {
        const y0 = k * 48 + 24;
        const halfW = 24 - (y0 / 240) * 9 + 0.6;
        for (const side of [-1, 1]) {
          xs.push([new THREE.BoxGeometry(1.0, 66, 0.8), '#15171b', M.trs(hk.x, y0, hk.z + side * halfW, 0.62, 0, 0)]);
          xs.push([new THREE.BoxGeometry(1.0, 66, 0.8), '#15171b', M.trs(hk.x, y0, hk.z + side * halfW, -0.62, 0, 0)]);
          xs.push([new THREE.BoxGeometry(0.8, 66, 1.0), '#15171b', M.trs(hk.x + side * halfW, y0, hk.z, 0, 0, 0.62)]);
          xs.push([new THREE.BoxGeometry(0.8, 66, 1.0), '#15171b', M.trs(hk.x + side * halfW, y0, hk.z, 0, 0, -0.62)]);
        }
      }
      xs.push([new THREE.CylinderGeometry(0.7, 1.0, 70, 6), '#e8e8e8', M.t(hk.x - 5, 275, hk.z)]);
      xs.push([new THREE.CylinderGeometry(0.7, 1.0, 70, 6), '#e8e8e8', M.t(hk.x + 5, 275, hk.z)]);
      add(mergeColored(xs), vc);
      placer.reserve(hk.x, hk.z, 30);
    }
    // Aon Center: tall white slab
    const aon = { x: -455, z: -150 };
    add(boxUV(26, 230, 26, aon.x, 0, aon.z), white);
    placer.reserve(aon.x, aon.z, 25);
    // Trump-ish tower: stepped glass with a spire
    const tr = { x: -430, z: 360 };
    add(boxUV(30, 140, 22, tr.x, 0, tr.z), glass);
    add(boxUV(24, 70, 18, tr.x + 2, 140, tr.z), glass);
    add(boxUV(17, 50, 14, tr.x + 3, 210, tr.z), glass);
    add(mergeColored([[new THREE.CylinderGeometry(0.4, 1.4, 50, 6), '#dfe6ee', M.t(tr.x + 3, 285, tr.z)]]), vcGloss);
    placer.reserve(tr.x, tr.z, 26);
    // Wrigley-ish clock tower near the river
    add(boxUV(18, 70, 18, -260, 0, 420), white);
    add(mergeColored([
      [new THREE.BoxGeometry(14, 22, 14), '#f7f3e8', M.t(-260, 81, 420)],
      [new THREE.CylinderGeometry(4, 7, 16, 8), '#f7f3e8', M.t(-260, 100, 420)],
      [new THREE.ConeGeometry(4, 12, 8), '#f7f3e8', M.t(-260, 114, 420)],
      [new THREE.CylinderGeometry(4, 4, 0.5, 16).rotateX(Math.PI / 2), '#20324f', M.t(-260, 84, 427.2)],
    ]), vc);
    placer.reserve(-260, 420, 16);
  }
  const nT = quality === 'high' ? 1 : quality === 'medium' ? 0.75 : 0.5;
  towers(Math.round(140 * nT), { minX: -820, maxX: -390, minZ: -420, maxZ: 560 }, [60, 150], [16, 30], 10);
  towers(Math.round(60 * nT), { minX: -420, maxX: -40, minZ: 360, maxZ: 640 }, [40, 120], [16, 28], 10);
  towers(Math.round(25 * nT), { minX: -420, maxX: -360, minZ: -300, maxZ: 340 }, [30, 80], [14, 22], 10);
  towers(Math.round(30 * nT), { minX: -300, maxX: -40, minZ: -420, maxZ: -290 }, [25, 70], [16, 26], 10);
  bA.build(group);
  bB.build(group);
  bC.build(group);

  /* ------------------------------------------------ CHICAGO start arch */
  {
    const s0 = track.sampleAt(0, 0);
    const wd = s0.halfWidth + def.shoulder + 2.5;
    const arch = new THREE.Group();
    const red = '#d7262e';
    const parts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [];
    for (const side of [-1, 1]) {
      // lattice towers
      parts.push([new THREE.BoxGeometry(2.4, 18, 2.4), red, M.t(side * wd, 9, 0)]);
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
    for (const s of spots) {
      seats.add(s.x, s.y, s.z, s.yaw);
      frames.add(s.x, s.y, s.z, s.yaw);
    }
    seats.build(group);
    frames.build(group);
  }

  /* ------------------------------------------------ Buckingham Fountain */
  {
    const fo = lm('fountain') ?? { x: -250, z: 80 };
    placer.reserve(fo.x, fo.z, 34);
    const pink = '#f1c6b5';
    const fparts: Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]> = [
      [new THREE.CylinderGeometry(26, 26.5, 1.2, 48), pink, M.t(fo.x, 0.6, fo.z)],
      [new THREE.CylinderGeometry(9, 11, 3, 24), pink, M.t(fo.x, 1.5, fo.z)],
      [new THREE.CylinderGeometry(10, 8, 1.2, 24), pink, M.t(fo.x, 3.6, fo.z)],
      [new THREE.CylinderGeometry(4, 5, 3, 16), pink, M.t(fo.x, 5.5, fo.z)],
      [new THREE.CylinderGeometry(6, 4.5, 1, 20), pink, M.t(fo.x, 7.4, fo.z)],
      [new THREE.CylinderGeometry(1.6, 2.4, 3, 12), pink, M.t(fo.x, 9.2, fo.z)],
      [new THREE.CylinderGeometry(3, 2, 0.8, 16), pink, M.t(fo.x, 10.9, fo.z)],
    ];
    // sea horses
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      fparts.push([new THREE.CylinderGeometry(0.9, 1.3, 3, 8), '#5f8f7a', M.trs(fo.x + Math.cos(a) * 17, 2.2, fo.z + Math.sin(a) * 17, 0.3 * Math.sin(a), 0, -0.3 * Math.cos(a))]);
    }
    // plaza ring + flower beds
    fparts.push([new THREE.CylinderGeometry(36, 36, 0.3, 48), '#e9dcc3', M.t(fo.x, 0.05, fo.z)]);
    const fm = new THREE.Mesh(bag.add(mergeColored(fparts)), vc);
    fm.castShadow = fm.receiveShadow = true;
    group.add(fm);
    const basinWater = new THREE.Mesh(bag.add(new THREE.CircleGeometry(25.6, 48)), lakeMat);
    basinWater.rotation.x = -Math.PI / 2;
    basinWater.position.set(fo.x, 1.05, fo.z);
    group.add(basinWater);
    const tier = new THREE.Mesh(bag.add(new THREE.CircleGeometry(9.5, 24)), lakeMat);
    tier.rotation.x = -Math.PI / 2;
    tier.position.set(fo.x, 4.25, fo.z);
    group.add(tier);
    // central jet: animated translucent column
    const jetMat = bag.add(new THREE.MeshStandardMaterial({ color: '#e6f6ff', transparent: true, opacity: 0.7, roughness: 0.1, emissive: '#9fd8ff', emissiveIntensity: 0.3, depthWrite: false }));
    const jet = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(0.4, 1.0, 1, 10, 1, true).translate(0, 0.5, 0)), jetMat);
    jet.position.set(fo.x, 11.2, fo.z);
    group.add(jet);
    // spray particles (GPU animated)
    const N = quality === 'low' ? 300 : 900;
    const pg = new THREE.BufferGeometry();
    const seeds = new Float32Array(N * 4);
    const velArr: number[] = [];
    for (let i = 0; i < N; i++) {
      const kind = i < N * 0.35 ? 0 : i < N * 0.75 ? 1 : 2; // 0 central, 1 rim ring, 2 seahorses
      let ox = 0, oz = 0, ang = rng.next() * Math.PI * 2, vy = 0, vh = 0;
      if (kind === 0) {
        vy = rng.range(17, 21);
        vh = rng.range(0.4, 1.8);
      } else if (kind === 1) {
        const a = rng.next() * Math.PI * 2;
        ox = Math.cos(a) * 9.5;
        oz = Math.sin(a) * 9.5;
        ang = a + Math.PI;
        vy = rng.range(6, 8);
        vh = rng.range(2.5, 3.5);
      } else {
        const a = (rng.int(4) / 4) * Math.PI * 2 + Math.PI / 4;
        ox = Math.cos(a) * 17;
        oz = Math.sin(a) * 17;
        ang = a + Math.PI + rng.range(-0.08, 0.08);
        vy = rng.range(7, 8.5);
        vh = rng.range(4.5, 5.5);
      }
      seeds[i * 4] = ox + Math.cos(ang) * 0.001;
      seeds[i * 4 + 1] = oz;
      seeds[i * 4 + 2] = ang;
      seeds[i * 4 + 3] = rng.next();
      velArr.push(vy, vh, kind === 0 ? 11.4 : kind === 1 ? 4.6 : 3.4);
    }
    const vel = new Float32Array(velArr);
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    pg.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), 40);
    bag.add(pg);
    const sprite = bag.add(dotTexture('rgba(255,255,255,1)', 'rgba(200,235,255,0)'));
    const pm = bag.add(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: timeU, uMap: { value: sprite } },
        vertexShader: `attribute vec4 aSeed; attribute vec3 aVel; uniform float uTime; varying float vA;
          void main(){
            float life = fract(uTime * 0.55 + aSeed.w);
            float t = life * 2.2;
            vec3 p = vec3(aSeed.x, aVel.z, aSeed.y);
            p.x += cos(aSeed.z) * aVel.y * t;
            p.z += sin(aSeed.z) * aVel.y * t;
            p.y += aVel.x * t - 0.5 * 18.0 * t * t;
            vA = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.75, 1.0, life)) * step(1.0, p.y);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = (2.4 + life * 2.6) * (300.0 / -mv.z);
          }`,
        fragmentShader: `uniform sampler2D uMap; varying float vA;
          void main(){ vec4 c = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vec3(0.92,0.97,1.0), c.a * vA * 0.85); }`,
      }),
    );
    const pts = new THREE.Points(pg, pm);
    pts.position.set(fo.x, 0, fo.z);
    group.add(pts);
    updaters.push((_dt, t) => {
      jet.scale.set(1, 9 + Math.sin(t * 2.1) * 1.6, 1);
    });
  }

  /* ------------------------------------------------ elevated L train */
  {
    const l = lm('ltrain') ?? { x: -172, z: 230 };
    updaters.push(elevatedTrain(group, bag, placer, { x0: -480, x1: 60, z: l.z }));
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
        for (let k = -c.halfLen; k < c.halfLen; k += 6) placer.reserve(c.cx + c.ax * k, c.cz + c.az * k, c.halfWidth + 4);
      }
      const bm = new THREE.Mesh(bag.add(mergeColored(parts)), vcGloss);
      bm.castShadow = bm.receiveShadow = true;
      group.add(bm);
    }
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

  /* ------------------------------------------------ billboards */
  {
    const boards = [
      textTexture('DEEP DISH PIZZA', { w: 1024, h: 256, bg: '#ffd23f', fg: '#c62828', border: '#c62828' }),
      textTexture('GO COWGILLS!', { w: 1024, h: 256, bg: '#1f4fbf', fg: '#ffffff', border: '#ffd23f' }),
      textTexture('CHICAGO-STYLE HOT DOGS', { w: 1024, h: 256, bg: '#3ccf6e', fg: '#ffffff', border: '#ffd23f', font: '900 104px "Arial Black", Impact, sans-serif' }),
      textTexture('WINDY CITY GP', { w: 1024, h: 256, bg: '#d7262e', fg: '#ffffff', border: '#ffffff' }),
    ].map((t) => bag.add(t));
    const frameGeo = bag.add(mergeColored([
      [new THREE.BoxGeometry(0.4, 5, 0.4), '#555', M.t(-5.5, 2.5, -0.3)],
      [new THREE.BoxGeometry(0.4, 5, 0.4), '#555', M.t(5.5, 2.5, -0.3)],
      [new THREE.BoxGeometry(12.6, 3.6, 0.3), '#222', M.t(0, 5.6, -0.2)],
    ]));
    const frames = new Batch(frameGeo, vc);
    const panelGeo = bag.add(new THREE.PlaneGeometry(12, 3).translate(0, 5.6, 0));
    const spots = placer.along(0, 140, 2, 7, { side: 0 });
    spots.forEach((s, i) => {
      frames.add(s.x, s.y, s.z, s.yaw);
      const m = new THREE.Mesh(panelGeo, bag.add(new THREE.MeshStandardMaterial({ map: boards[i % boards.length], emissive: '#ffffff', emissiveMap: boards[i % boards.length], emissiveIntensity: 0.15 })));
      m.position.set(s.x, s.y, s.z);
      m.rotation.y = s.yaw;
      group.add(m);
    });
    frames.build(group);
  }

  /* ------------------------------------------------ lamps */
  {
    const lamps = new Batch(bag.add(PROPS.lamp('#2b3445', '#fff6d0')), vc, { name: 'lamps' });
    for (const s of placer.along(0, 48, 1.2, 0.6, { jitter: 0 })) lamps.add(s.x, s.y, s.z, s.yaw);
    lamps.build(group);
  }

  /* ------------------------------------------------ trees, bushes, benches (Grant Park + lakefront) */
  {
    const b = field.bounds;
    const treeA = new Batch(bag.add(PROPS.roundTree('#3fa34d', '#5cc25e')), vc, { name: 'treesA' });
    const treeB = new Batch(bag.add(PROPS.roundTree('#2f8f45', '#7ccf5a', '#6b4425')), vc, { name: 'treesB' });
    const bushes = new Batch(bag.add(PROPS.bush('#3f9a3a', '#6cc04f')), vc, { name: 'bushes', cast: false });
    const flowers = new Batch(bag.add(mergeColored([
      [new THREE.CylinderGeometry(2.2, 2.4, 0.5, 12), '#7a5230', M.t(0, 0.25, 0)],
      [new THREE.IcosahedronGeometry(1.9, 1), '#ff5fa2', M.trs(0, 0.7, 0, 0, 0, 0, 1, 0.35, 1)],
    ])), vc, { cast: false });
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
    flowers.build(group);
    benches.build(group);
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
    towels.build(group);
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

  return {
    update(dt: number, time: number) {
      timeU.value = time;
      for (const u of updaters) u(dt, time);
    },
    dispose() {
      disposeGroup(group);
      bag.dispose();
    },
  };
}

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SceneryContext, SceneryHandle } from './types';
import { Batch, M, ctxBits, mergeColored, setInstance, vcMat } from './common';
import { getField } from './field';
import { canvasTexture, dotTexture, tileTexture } from './textures';

type P = Array<[THREE.BufferGeometry, THREE.ColorRepresentation, THREE.Matrix4?]>;

const FLOOR_Y = -60;

/** Cereal box face texture. */
function cerealTexture(name: string, bg: string, fg: string, seed: number): THREE.CanvasTexture {
  return canvasTexture(256, 384, (g, w, h, rng) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < 8; i++) {
      g.beginPath();
      g.arc(rng.next() * w, rng.next() * h, rng.range(20, 60), 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(w / 2, h * 0.68, w * 0.38, h * 0.13, 0, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = rng.pick(['#ff5fa2', '#ffd23f', '#3ccf6e', '#ff8a3d', '#8a5cf0']);
      g.lineWidth = 7;
      g.beginPath();
      g.arc(w / 2 + rng.range(-80, 80), h * 0.64 + rng.range(-24, 18), 9, 0, Math.PI * 2);
      g.stroke();
    }
    g.font = '900 54px "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 8;
    g.strokeStyle = '#00000066';
    const words = name.split(' ');
    words.forEach((word, i) => {
      g.strokeText(word, w / 2, 80 + i * 62);
      g.fillStyle = fg;
      g.fillText(word, w / 2, 80 + i * 62);
    });
  }, { repeat: false, seed });
}

function labelTexture(text: string, bg: string, fg: string, w = 256, h = 256): THREE.CanvasTexture {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.font = `900 ${Math.floor(h * 0.24)}px "Arial Black", Impact, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2);
  }, { repeat: false });
}

export function buildKitchen(ctx: SceneryContext): SceneryHandle {
  const { track, group, quality } = ctx;
  const { bag, density, placer } = ctxBits(ctx);
  const field = getField(track);
  const rng = new Rng(1717);
  const def = track.def;
  const lm = (kind: string) => def.landmarks.filter((l) => l.kind === kind);
  const updaters: Array<(dt: number, t: number) => void> = [];
  const vc = vcMat(bag, { roughness: 0.55 });
  const vcShiny = vcMat(bag, { roughness: 0.22, metalness: 0.2 });
  const b = field.bounds;
  const sx0 = b.minX - 60, sx1 = b.maxX + 60, sz0 = b.minZ - 60, sz1 = b.maxZ + 60; // counter slab extents
  const cx = (sx0 + sx1) / 2, cz = (sz0 + sz1) / 2;
  const parts: P = [];
  const shiny: P = [];
  const addMesh = (p: P, mat: THREE.Material, cast = true) => {
    if (!p.length) return;
    const m = new THREE.Mesh(bag.add(mergeColored(p)), mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    group.add(m);
  };

  /* ------------------------------------------------ floor + room */
  {
    const ft = bag.add(tileTexture('#f2efe6', '#c9c2b4', 2, 0.03, 4));
    ft.repeat.set(160, 160);
    // checkerboard floor tiles
    const floorTex = bag.add(canvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = '#f4efe3';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#2f3d5c';
      g.fillRect(0, 0, w / 2, h / 2);
      g.fillRect(w / 2, h / 2, w / 2, h / 2);
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(0, 0, w, 2);
      g.fillRect(0, 0, 2, h);
    }));
    floorTex.repeat.set(70, 70);
    const floor = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(4000, 4000)), bag.add(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.4 })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, FLOOR_Y, cz);
    floor.receiveShadow = true;
    group.add(floor);
    void ft;
    // walls of the room with a tiled backsplash, a window and upper cabinets
    const R = 520;
    const wallTex = bag.add(canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#fbe7b5';
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 12, h);
    }));
    wallTex.repeat.set(30, 6);
    const wallMat = bag.add(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 }));
    const tiles = bag.add(tileTexture('#9fd3e6', '#ffffff', 4, 0.05, 6));
    tiles.repeat.set(40, 6);
    const tileMat = bag.add(new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.3 }));
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const wall = new THREE.Group();
      const w = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(R * 2.4, 900)), wallMat);
      w.position.set(0, 390, 0);
      wall.add(w);
      const sp = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(R * 2.4, 110)), tileMat);
      sp.position.set(0, 55, 0.5);
      wall.add(sp);
      wall.position.set(cx + Math.sin(a) * -R, 0, cz + Math.cos(a) * -R);
      wall.rotation.y = a;
      group.add(wall);
    }
    // window on the north wall with bright daylight
    const win = new THREE.Mesh(bag.add(new THREE.PlaneGeometry(320, 200)), bag.add(new THREE.MeshBasicMaterial({ color: '#cfeeff', toneMapped: false, fog: false })));
    win.position.set(cx + 60, 230, cz + R - 1);
    win.rotation.y = Math.PI;
    group.add(win);
    const wparts: P = [
      [new THREE.BoxGeometry(340, 14, 12), '#ffffff', M.t(cx + 60, 125, cz + R - 4)],
      [new THREE.BoxGeometry(340, 14, 12), '#ffffff', M.t(cx + 60, 335, cz + R - 4)],
      [new THREE.BoxGeometry(14, 220, 12), '#ffffff', M.t(cx - 103, 230, cz + R - 4)],
      [new THREE.BoxGeometry(14, 220, 12), '#ffffff', M.t(cx + 223, 230, cz + R - 4)],
      [new THREE.BoxGeometry(10, 200, 8), '#ffffff', M.t(cx + 60, 230, cz + R - 4)],
      // upper cabinets on the west wall
      [new THREE.BoxGeometry(70, 140, 500), '#7fb3d9', M.t(cx - R + 35, 330, cz)],
      [new THREE.BoxGeometry(72, 6, 502), '#5d8fb8', M.t(cx - R + 35, 258, cz)],
    ];
    for (let z = -220; z <= 220; z += 110) wparts.push([new THREE.BoxGeometry(4, 120, 96), '#9cc7e6', M.t(cx - R + 71, 330, cz + z)]);
    for (let z = -220; z <= 220; z += 110) wparts.push([new THREE.BoxGeometry(6, 26, 6), '#c9a227', M.t(cx - R + 75, 290, cz + z + 30)]);
    // curtains
    wparts.push([new THREE.BoxGeometry(70, 240, 6), '#ff8fab', M.t(cx - 130, 230, cz + R - 12)]);
    wparts.push([new THREE.BoxGeometry(70, 240, 6), '#ff8fab', M.t(cx + 250, 230, cz + R - 12)]);
    addMesh(wparts, vc, false);
  }

  /* ------------------------------------------------ table legs + counter base */
  {
    const ch = field.channels[0];
    const legs: P = [];
    if (ch) {
      // table occupies x > channel; legs at its corners
      const tx0 = ch.cx + ch.halfWidth + 30, tx1 = sx1 - 25;
      for (const x of [tx0, tx1]) for (const z of [sz0 + 25, sz1 - 25]) {
        legs.push([new THREE.CylinderGeometry(9, 6, -FLOOR_Y, 12), '#b9773f', M.t(x, FLOOR_Y / 2, z)]);
      }
    }
    addMesh(legs, vc);
  }

  /* ------------------------------------------------ cereal boxes */
  const cereal = [
    ['CRUNCHY OS', '#e8443a', '#ffd23f'],
    ['CHOCO BLAST', '#5a2f1c', '#ff9fd0'],
    ['HONEY BEES', '#ffb302', '#3a2a10'],
    ['FROSTY FLAKES', '#2f7de1', '#ffffff'],
  ] as const;
  lm('cerealBox').forEach((c, i) => {
    const [name, bg, fg] = cereal[i % cereal.length];
    const front = bag.add(cerealTexture(name, bg, fg, 50 + i));
    const side = bag.add(new THREE.MeshStandardMaterial({ color: bg, roughness: 0.6 }));
    const face = bag.add(new THREE.MeshStandardMaterial({ map: front, roughness: 0.5 }));
    const m = new THREE.Mesh(bag.add(new THREE.BoxGeometry(30, 46, 10)), [side, side, side, side, face, face]);
    m.position.set(c.x, field.height(c.x, c.z) + 23, c.z);
    m.rotation.y = c.rot ?? 0;
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    placer.reserve(c.x, c.z, 18);
  });

  /* ------------------------------------------------ toaster with popping toast */
  for (const c of lm('toaster')) {
    const y = field.height(c.x, c.z);
    shiny.push([new THREE.BoxGeometry(34, 22, 20), '#dfe5ec', M.t(c.x, y + 11, c.z)]);
    shiny.push([new THREE.CylinderGeometry(10, 10, 34, 16, 1).rotateZ(Math.PI / 2), '#dfe5ec', M.trs(c.x, y + 22, c.z, 0, 0, 0, 1, 0.25, 1)]);
    parts.push([new THREE.BoxGeometry(26, 0.6, 3), '#222', M.t(c.x, y + 24.6, c.z - 4)]);
    parts.push([new THREE.BoxGeometry(26, 0.6, 3), '#222', M.t(c.x, y + 24.6, c.z + 4)]);
    parts.push([new THREE.BoxGeometry(3, 6, 2), '#222', M.t(c.x + 18, y + 14, c.z)]);
    placer.reserve(c.x, c.z, 22);
    const toastGeo = bag.add(mergeColored([
      [new THREE.BoxGeometry(22, 18, 2), '#e3a05a', M.t(0, 0, 0)],
      [new THREE.BoxGeometry(18, 15, 2.2), '#f7d6a0', M.t(0, -1, 0)],
    ]));
    const toast = new THREE.InstancedMesh(toastGeo, vc, 2);
    toast.castShadow = true;
    group.add(toast);
    updaters.push((_dt, t) => {
      for (let i = 0; i < 2; i++) {
        const ph = (t * 0.5 + i * 0.13) % 3;
        const pop = ph < 0.6 ? Math.sin((ph / 0.6) * Math.PI) * 26 : 0;
        setInstance(toast, i, c.x, y + 22 + pop, c.z + (i ? 4 : -4), 0, 0, 0, 1);
      }
      toast.instanceMatrix.needsUpdate = true;
    });
  }

  /* ------------------------------------------------ fridge (stands on the floor) */
  for (const c of lm('fridge')) {
    const h = 260;
    shiny.push([new THREE.BoxGeometry(80, h, 70), '#e9eef3', M.t(c.x, FLOOR_Y + h / 2, c.z)]);
    parts.push([new THREE.BoxGeometry(80.5, 2, 70.5), '#9aa5b1', M.t(c.x, FLOOR_Y + h * 0.62, c.z)]);
    parts.push([new THREE.BoxGeometry(4, 50, 4), '#9aa5b1', M.t(c.x + 30, FLOOR_Y + h * 0.75, c.z - 37)]);
    parts.push([new THREE.BoxGeometry(4, 70, 4), '#9aa5b1', M.t(c.x + 30, FLOOR_Y + h * 0.35, c.z - 37)]);
    // magnets / kid drawings
    for (let i = 0; i < 7; i++) parts.push([new THREE.BoxGeometry(rng.range(8, 16), rng.range(8, 14), 0.6), rng.pick(['#ff5fa2', '#ffd23f', '#3ccf6e', '#2f7de1', '#ffffff']), M.trs(c.x + rng.range(-30, 20), FLOOR_Y + rng.range(140, 230), c.z - 35.3, 0, 0, rng.range(-0.2, 0.2))]);
    placer.reserve(c.x, c.z, 55);
  }

  /* ------------------------------------------------ stove top with glowing burners + frying pan & egg */
  const burnerMat = bag.add(new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff4a1a', emissiveIntensity: 1.2, roughness: 0.5 }));
  for (const c of lm('stove')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.BoxGeometry(70, 1.2, 54), '#1c1d22', M.t(c.x, y + 0.6, c.z)]);
    const rings = new THREE.Mesh(bag.add(mergeColored([
      ...[[-17, -13], [17, -13], [-17, 13], [17, 13]].flatMap(([dx, dz]) => [
        [new THREE.TorusGeometry(9, 0.9, 6, 32).rotateX(Math.PI / 2), '#ffffff', M.t(c.x + dx, y + 1.3, c.z + dz)] as [THREE.BufferGeometry, string, THREE.Matrix4],
        [new THREE.TorusGeometry(5, 0.8, 6, 24).rotateX(Math.PI / 2), '#ffffff', M.t(c.x + dx, y + 1.3, c.z + dz)] as [THREE.BufferGeometry, string, THREE.Matrix4],
      ]),
    ])), burnerMat);
    group.add(rings);
    updaters.push((_dt, t) => {
      burnerMat.emissiveIntensity = 1.0 + Math.sin(t * 3) * 0.35;
    });
    // pan with an egg on the front-left burner
    shiny.push([new THREE.CylinderGeometry(12, 10, 3, 24), '#3b3f47', M.t(c.x - 17, y + 2.8, c.z + 13)]);
    shiny.push([new THREE.BoxGeometry(24, 1.6, 3), '#3b3f47', M.trs(c.x - 38, y + 4, c.z + 13, 0, 0, 0.12)]);
    parts.push([new THREE.CylinderGeometry(7, 7, 0.6, 20), '#ffffff', M.trs(c.x - 16, y + 4.4, c.z + 12, 0, 0, 0, 1, 1, 0.8)]);
    parts.push([new THREE.SphereGeometry(3, 12, 8), '#ffb000', M.trs(c.x - 15, y + 4.8, c.z + 12, 0, 0, 0, 1, 0.5, 1)]);
    placer.reserve(c.x, c.z, 40);
  }

  /* ------------------------------------------------ plates with pancakes, mug, milk carton */
  for (const c of lm('plate')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.CylinderGeometry(18, 14, 2, 32), '#ffffff', M.t(c.x, y + 1, c.z)]);
    parts.push([new THREE.TorusGeometry(16.5, 0.6, 6, 40).rotateX(Math.PI / 2), '#2f7de1', M.t(c.x, y + 2, c.z)]);
    for (let k = 0; k < 4; k++) parts.push([new THREE.CylinderGeometry(10 - k * 0.3, 10 - k * 0.3, 1.6, 24), k % 2 ? '#d9934a' : '#e7a75e', M.t(c.x + rng.range(-0.6, 0.6), y + 2.8 + k * 1.6, c.z + rng.range(-0.6, 0.6))]);
    parts.push([new THREE.BoxGeometry(4, 1.6, 4), '#fff2a8', M.t(c.x, y + 9.5, c.z)]);
    parts.push([new THREE.CylinderGeometry(10.2, 10.2, 0.3, 24), '#8a4a10', M.t(c.x, y + 9.0, c.z)]);
    placer.reserve(c.x, c.z, 20);
  }
  for (const c of lm('mug')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.CylinderGeometry(8, 7.5, 16, 24), '#ff7a3d', M.t(c.x, y + 8, c.z)]);
    parts.push([new THREE.CylinderGeometry(7.2, 7.2, 0.5, 24), '#4a2a14', M.t(c.x, y + 14.5, c.z)]);
    parts.push([new THREE.TorusGeometry(4.5, 1.3, 8, 16), '#ff7a3d', M.t(c.x + 9, y + 8, c.z)]);
    placer.reserve(c.x, c.z, 14);
  }
  for (const c of lm('milkCarton')) {
    const y = field.height(c.x, c.z);
    const tex = bag.add(labelTexture('MILK', '#ffffff', '#2f7de1'));
    const mat = bag.add(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    const box = new THREE.Mesh(bag.add(new THREE.BoxGeometry(14, 30, 14)), mat);
    box.position.set(c.x, y + 15, c.z);
    box.rotation.y = 0.4;
    box.castShadow = true;
    group.add(box);
    parts.push([new THREE.ConeGeometry(10, 8, 4).rotateY(Math.PI / 4), '#e8f2ff', M.trs(c.x, y + 34, c.z, 0, 0.4, 0, 1, 1, 1)]);
    placer.reserve(c.x, c.z, 12);
  }

  /* ------------------------------------------------ fruit bowl */
  for (const c of lm('fruitBowl')) {
    const y = field.height(c.x, c.z);
    parts.push([new THREE.SphereGeometry(13, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), '#2fb5a8', M.trs(c.x, y + 11, c.z, 0, 0, 0, 1, 0.85, 1)]);
    parts.push([new THREE.CylinderGeometry(6, 7, 1.5, 20), '#2fb5a8', M.t(c.x, y + 0.75, c.z)]);
    const fruit = ['#ff8a1a', '#e8443a', '#ffb000', '#7ccf3a', '#ff8a1a', '#e8443a'];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      parts.push([new THREE.SphereGeometry(5, 14, 10), fruit[i % fruit.length], M.t(c.x + Math.cos(a) * 6, y + 13 + (i % 3), c.z + Math.sin(a) * 6)]);
    }
    parts.push([new THREE.TorusGeometry(10, 2.2, 8, 20, Math.PI * 0.8), '#ffe14d', M.trs(c.x, y + 17, c.z, 0.4, 0.3, 0.3)]);
    placer.reserve(c.x, c.z, 15);
  }

  /* ------------------------------------------------ chairs around the table */
  for (const c of lm('chair')) {
    const seatY = FLOOR_Y + 36;
    const face = Math.atan2(cx - c.x, cz - c.z);
    const m = M.trs(c.x, 0, c.z, 0, face, 0);
    const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => parts.push([g, col, m.clone().multiply(local)]);
    p(new THREE.BoxGeometry(40, 4, 40), '#c0392b', M.t(0, seatY, 0));
    for (const [dx, dz] of [[-17, -17], [17, -17], [-17, 17], [17, 17]]) p(new THREE.BoxGeometry(3, 36, 3), '#8a5a2b', M.t(dx, FLOOR_Y + 18, dz));
    p(new THREE.BoxGeometry(40, 50, 3), '#8a5a2b', M.t(0, seatY + 27, -19));
    p(new THREE.BoxGeometry(34, 8, 3.4), '#c0392b', M.t(0, seatY + 40, -19));
  }

  /* ------------------------------------------------ cutting-board bridge + giant wooden spoon */
  for (const c of lm('spoonBridge')) {
    const smp = (() => {
      let best = track.sampleAt(0, 0), bd = Infinity;
      for (const s of track.paths[0].samples) {
        const d = (s.x - c.x) ** 2 + (s.z - c.z) ** 2;
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      return best;
    })();
    const yaw = Math.atan2(smp.tx, smp.tz);
    const wd = smp.halfWidth + def.shoulder + 2;
    parts.push([new THREE.BoxGeometry(wd * 2, 3, 70), '#c98a4b', M.trs(smp.x, smp.y - 1.8, smp.z, 0, yaw, 0)]);
    parts.push([new THREE.BoxGeometry(wd * 2 + 0.2, 0.6, 70.2), '#a86c35', M.trs(smp.x, smp.y - 2.6, smp.z, 0, yaw, 0)]);
    // a wooden spoon lying across the aisle beside the board
    const sx = smp.x + smp.nx * (wd + 30), sz = smp.z + smp.nz * (wd + 30);
    parts.push([new THREE.BoxGeometry(7, 2, 110), '#d79a5a', M.trs(sx, smp.y + 0.2, sz, 0, yaw, 0)]);
    parts.push([new THREE.SphereGeometry(13, 18, 10), '#d79a5a', M.trs(sx + smp.tx * 60, smp.y + 1.5, sz + smp.tz * 60, 0, yaw, 0, 1, 0.25, 1.4)]);
  }

  /* ------------------------------------------------ napkin tunnel over the shortcut */
  {
    const sc = track.paths[1];
    if (sc) {
      const mid = track.sampleAt(1, sc.length * 0.5);
      const r = mid.halfWidth + def.shoulder + 1.5;
      const tunnelTex = bag.add(canvasTexture(128, 128, (g, w, h) => {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#ff9fc4';
        for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 14, h);
        g.fillStyle = 'rgba(0,0,0,0.06)';
        for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 1);
      }));
      tunnelTex.repeat.set(6, 2);
      const tun = new THREE.Mesh(bag.add(new THREE.CylinderGeometry(r, r, 40, 32, 1, true, 0, Math.PI).rotateZ(Math.PI / 2)), bag.add(new THREE.MeshStandardMaterial({ map: tunnelTex, side: THREE.DoubleSide, roughness: 0.9 })));
      tun.position.set(mid.x, mid.y, mid.z);
      tun.rotation.y = Math.atan2(mid.tx, mid.tz) + Math.PI / 2;
      tun.castShadow = true;
      group.add(tun);
      placer.reserve(mid.x, mid.z, 24);
    }
  }

  /* ------------------------------------------------ utensils, salt & pepper, sugar bowl */
  {
    const spots = placer.scatter(Math.round(8 * density + 2), { minX: sx0 + 30, maxX: sx1 - 30, minZ: sz0 + 30, maxZ: sz1 - 30 }, 14, 6);
    spots.forEach((s, i) => {
      const m = M.trs(s.x, s.y, s.z, 0, s.yaw, 0);
      const p = (g: THREE.BufferGeometry, col: string, local: THREE.Matrix4) => shiny.push([g, col, m.clone().multiply(local)]);
      const kind = i % 4;
      if (kind === 0) {
        // fork
        p(new THREE.BoxGeometry(4, 1.2, 50), '#d7dde5', M.t(0, 0.6, -10));
        p(new THREE.BoxGeometry(9, 1.2, 8), '#d7dde5', M.t(0, 0.6, 18));
        for (let k = -1.5; k <= 1.5; k++) p(new THREE.BoxGeometry(1.2, 1.2, 12), '#d7dde5', M.t(k * 2.6, 0.6, 28));
      } else if (kind === 1) {
        // spoon
        p(new THREE.BoxGeometry(4, 1.2, 50), '#d7dde5', M.t(0, 0.6, -10));
        p(new THREE.SphereGeometry(8, 16, 8), '#d7dde5', M.trs(0, 1.2, 22, 0, 0, 0, 0.8, 0.2, 1.2));
      } else if (kind === 2) {
        // butter knife
        p(new THREE.BoxGeometry(4, 1.6, 30), '#5a3a26', M.t(0, 0.8, -15));
        p(new THREE.BoxGeometry(6, 0.8, 34), '#d7dde5', M.t(0, 0.4, 16));
      } else {
        // salt & pepper
        p(new THREE.CylinderGeometry(4, 4.5, 14, 16), '#ffffff', M.t(-5, 7, 0));
        p(new THREE.SphereGeometry(4, 12, 8), '#c0c6ce', M.t(-5, 14, 0));
        p(new THREE.CylinderGeometry(4, 4.5, 14, 16), '#3b3f47', M.t(5, 7, 0));
        p(new THREE.SphereGeometry(4, 12, 8), '#c0c6ce', M.t(5, 14, 0));
      }
    });
  }

  /* ------------------------------------------------ hanging pendant lamp above the table */
  {
    const lx = (field.channels[0]?.cx ?? 0) + 160, lz = 0;
    shiny.push([new THREE.CylinderGeometry(0.6, 0.6, 300, 6), '#333', M.t(lx, 330, lz)]);
    shiny.push([new THREE.ConeGeometry(30, 26, 24, 1, true), '#ffcc33', M.t(lx, 170, lz)]);
    const bulb = new THREE.Mesh(bag.add(new THREE.SphereGeometry(8, 16, 12)), bag.add(new THREE.MeshBasicMaterial({ color: '#fff4c2', toneMapped: false })));
    bulb.position.set(lx, 158, lz);
    group.add(bulb);
  }

  /* ------------------------------------------------ cereal loops + blueberries scattered */
  {
    const loopGeo = bag.add(new THREE.TorusGeometry(1.2, 0.55, 6, 12).rotateX(Math.PI / 2).translate(0, 0.55, 0));
    const loops = new Batch(loopGeo, bag.add(new THREE.MeshStandardMaterial({ roughness: 0.7 })), { cast: false, name: 'cerealLoops' });
    const cols = ['#ff5fa2', '#ffd23f', '#3ccf6e', '#ff8a3d', '#8a5cf0', '#e8443a'];
    const rect = { minX: sx0 + 5, maxX: sx1 - 5, minZ: sz0 + 5, maxZ: sz1 - 5 };
    for (const s of placer.scatter(Math.round(420 * density), rect, 1.3, 1.5, Infinity, 6, false)) {
      if (field.channelAt(s.x, s.z)) continue;
      loops.add(s.x, s.y, s.z, s.yaw, 1, 1, 1, rng.pick(cols), rng.range(-0.15, 0.15));
    }
    loops.build(group);
    const berries = new Batch(bag.add(new THREE.SphereGeometry(1.25, 10, 8).translate(0, 1.1, 0)), bag.add(new THREE.MeshStandardMaterial({ color: '#5566c4', roughness: 0.35 })), { cast: false });
    for (const s of placer.scatter(Math.round(80 * density), rect, 1.7, 1.5, Infinity, 6, false)) if (!field.channelAt(s.x, s.z)) berries.add(s.x, s.y, s.z, 0);
    berries.build(group);
    // sugar cubes
    const sugar = new Batch(bag.add(new THREE.BoxGeometry(3, 3, 3).translate(0, 1.5, 0)), bag.add(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 })), {});
    for (const s of placer.scatter(Math.round(40 * density), rect, 2.2, 2, Infinity, 6, false)) if (!field.channelAt(s.x, s.z)) sugar.add(s.x, s.y, s.z, s.yaw);
    sugar.build(group);
  }

  /* ------------------------------------------------ steam from the pan (particles) */
  {
    const st = lm('stove')[0];
    if (st) {
      const N = quality === 'low' ? 40 : 90;
      const g = new THREE.BufferGeometry();
      const seeds = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) seeds.set([rng.range(-6, 6), rng.next(), rng.range(-6, 6)], i * 3);
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 60);
      bag.add(g);
      const timeU = { value: 0 };
      const mat = bag.add(new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uTime: timeU, uMap: { value: bag.add(dotTexture()) } },
        vertexShader: `attribute vec3 aSeed; uniform float uTime; varying float vA;
          void main(){ float l = fract(uTime*0.25 + aSeed.y); vec3 p = vec3(aSeed.x + sin(l*6.0+aSeed.z)*3.0, l*45.0, aSeed.z);
          vA = sin(l*3.14159); vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = (14.0 + l*30.0) * (300.0 / -mv.z); }`,
        fragmentShader: `uniform sampler2D uMap; varying float vA; void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(1.0,1.0,1.0, a*vA*0.35); }`,
      }));
      const pts = new THREE.Points(g, mat);
      pts.position.set(st.x - 17, field.height(st.x, st.z) + 5, st.z + 13);
      group.add(pts);
      updaters.push((_dt, t) => (timeU.value = t));
    }
  }

  addMesh(parts, vc);
  addMesh(shiny, vcShiny);

  return {
    update(dt: number, time: number) {
      for (const u of updaters) u(dt, time);
    },
    dispose() {
      bag.dispose();
    },
  };
}

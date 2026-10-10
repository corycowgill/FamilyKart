import * as THREE from 'three';
import type { LiveryId } from './liveries';
import { liveryGlow, liverySolid } from './liveryPaint';
import { miniFlagTexture } from './liveryTextures';
import { cachedGeo, cachedMat, capsuleGeo, chrome, cylinderGeo, mesh, plastic, roundedBox, sphereGeo } from './materials';

/**
 * One small, static accessory per livery, mounted on top of the kart's spoiler (or on a little post
 * where a kart has no wing). Everything is built from shared geometry/materials so KartView's
 * static-mesh merge folds it into a handful of draw calls.
 */

export interface PropAnchor {
  x: number;
  y: number;
  z: number;
  /** Height of a support post to add under the prop (0 = sits directly on the spoiler). */
  post: number;
}

export function addLiveryProp(liv: LiveryId, body: THREE.Object3D, a: PropAnchor): void {
  const g = new THREE.Group();
  g.position.set(a.x, a.y, a.z);
  body.add(g);
  if (a.post > 0) {
    const post = mesh(cylinderGeo(0.018, 0.022, a.post, 8), plastic('#2a2c33', 0.5));
    post.position.y = a.post / 2 - 0.01;
    g.add(post);
  }
  const top = new THREE.Group();
  top.position.y = a.post;
  g.add(top);
  switch (liv) {
    case 'chicagoFlag': {
      const pole = mesh(cylinderGeo(0.01, 0.01, 0.42, 6), chrome());
      pole.position.y = 0.21;
      top.add(pole);
      const knob = mesh(sphereGeo(8, 6), liverySolid(liv, '#e4002b'), false);
      knob.scale.setScalar(0.022);
      knob.position.y = 0.43;
      top.add(knob);
      const tex = miniFlagTexture();
      const flagMat = cachedMat('livprop:flag', () => new THREE.MeshStandardMaterial({ map: tex, color: tex ? '#ffffff' : '#f4f6f8', side: THREE.DoubleSide, roughness: 0.7 }));
      const flag = mesh(cachedGeo('livprop:flaggeo', () => {
        const geo = new THREE.PlaneGeometry(0.27, 0.18, 6, 1);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) + 0.135) * 14) * 0.018); // a little wave
        geo.computeVertexNormals();
        geo.translate(0.135, 0, 0);
        return geo;
      }), flagMat);
      flag.rotation.y = Math.PI / 2; // flies backwards (-z)
      flag.position.y = 0.32;
      top.add(flag);
      break;
    }
    case 'windyCity': {
      // pinwheel on a stick
      const stick = mesh(cylinderGeo(0.01, 0.01, 0.3, 6), plastic('#ffffff', 0.4));
      stick.position.y = 0.15;
      top.add(stick);
      const wheel = new THREE.Group();
      wheel.position.set(0, 0.32, 0.03);
      top.add(wheel);
      const cols = ['#ffffff', '#2a7fd0', '#ffffff', '#59b8f0'];
      const blade = cachedGeo('livprop:blade', () => {
        const s = new THREE.Shape();
        s.moveTo(0, 0);
        s.lineTo(0.11, 0.02);
        s.quadraticCurveTo(0.12, 0.09, 0.02, 0.1);
        s.closePath();
        return new THREE.ShapeGeometry(s);
      });
      cols.forEach((c, i) => {
        const b = mesh(blade, cachedMat(`livprop:blade:${c}`, () => new THREE.MeshStandardMaterial({ color: c, side: THREE.DoubleSide, roughness: 0.5 })), false);
        b.rotation.z = (i * Math.PI) / 2;
        wheel.add(b);
      });
      const hub = mesh(sphereGeo(8, 6), plastic('#ffd23f', 0.4), false);
      hub.scale.setScalar(0.022);
      wheel.add(hub);
      break;
    }
    case 'lowerWacker': {
      // amber sodium beacon
      const base = mesh(cylinderGeo(0.07, 0.08, 0.04, 14), plastic('#15161a', 0.5));
      base.position.y = 0.02;
      top.add(base);
      const dome = mesh(sphereGeo(14, 8), liveryGlow('#ffb020', 1.6), false);
      dome.scale.set(0.06, 0.07, 0.06);
      dome.position.y = 0.05;
      top.add(dome);
      break;
    }
    case 'chicagoDog': {
      // tiny Chicago dog riding on the wing
      const dog = new THREE.Group();
      dog.position.y = 0.05;
      top.add(dog);
      const bunMat = plastic('#e3b16a', 0.6);
      for (const s of [-1, 1]) {
        const bun = mesh(capsuleGeo(0.04, 0.24, 8), bunMat);
        bun.rotation.z = Math.PI / 2;
        bun.position.set(0.12, 0, s * 0.035);
        dog.add(bun);
      }
      const sausage = mesh(capsuleGeo(0.032, 0.3, 8), plastic('#b8402c', 0.45));
      sausage.rotation.z = Math.PI / 2;
      sausage.position.set(0.15, 0.03, 0);
      dog.add(sausage);
      const mustard = mesh(roundedBox(0.3, 0.012, 0.02, 0.005, 1), plastic('#ffd21f', 0.4), false);
      mustard.position.set(0, 0.064, 0);
      mustard.rotation.y = 0.12;
      dog.add(mustard);
      for (let i = 0; i < 4; i++) {
        const relish = mesh(sphereGeo(6, 4), plastic('#3fbf2a', 0.5), false);
        relish.scale.setScalar(0.016);
        relish.position.set(-0.1 + i * 0.065, 0.058, (i % 2 ? 1 : -1) * 0.018);
        dog.add(relish);
      }
      const pickle = mesh(capsuleGeo(0.013, 0.14, 6), plastic('#2f8a2a', 0.5), false);
      pickle.rotation.z = Math.PI / 2;
      pickle.position.set(0.05, 0.06, 0.03);
      dog.add(pickle);
      break;
    }
    case 'bluesClub': {
      // neon music note
      const note = new THREE.Group();
      note.position.y = 0.02;
      top.add(note);
      const pink = liveryGlow('#ff3fa4', 2.2);
      const cyan = liveryGlow('#3fd8ff', 2.2);
      for (const [x, m] of [[-0.06, pink], [0.08, cyan]] as Array<[number, THREE.Material]>) {
        const head = mesh(sphereGeo(10, 8), m, false);
        head.scale.set(0.045, 0.034, 0.03);
        head.position.set(x, 0.04, 0);
        note.add(head);
        const stem = mesh(cylinderGeo(0.008, 0.008, 0.22, 6), m, false);
        stem.position.set(x + 0.04, 0.15, 0);
        note.add(stem);
      }
      const beam = mesh(roundedBox(0.16, 0.03, 0.016, 0.006, 1), pink, false);
      beam.position.set(0.05, 0.255, 0);
      beam.rotation.z = 0.1;
      note.add(beam);
      break;
    }
    case 'lTrain': {
      // pantograph: a folding diamond frame with a contact bar
      const rod = plastic('#2a2c33', 0.4, 0.6);
      const base = mesh(roundedBox(0.2, 0.03, 0.12, 0.01, 1), rod);
      base.position.y = 0.015;
      top.add(base);
      const arm = cachedGeo('livprop:panto', () => new THREE.CylinderGeometry(0.008, 0.008, 0.2, 5));
      for (const s of [-1, 1]) {
        const lower = mesh(arm, rod, false);
        lower.position.set(0, 0.1, s * 0.04);
        lower.rotation.x = s * 0.55;
        top.add(lower);
        const upper = mesh(arm, rod, false);
        upper.position.set(0, 0.25, s * 0.04);
        upper.rotation.x = -s * 0.55;
        top.add(upper);
      }
      const bar = mesh(capsuleGeo(0.012, 0.3, 6), chrome(), false);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0.15, 0.345, 0);
      top.add(bar);
      const shoe = mesh(roundedBox(0.03, 0.02, 0.05, 0.008, 1), liveryGlow('#c60c30', 0.4), false);
      shoe.position.set(0, 0.34, 0);
      top.add(shoe);
      break;
    }
    case 'deepDish': {
      // a slice of deep dish, tilted up like a trophy
      const slice = new THREE.Group();
      slice.position.y = 0.08;
      slice.rotation.x = -1.1;
      top.add(slice);
      const geo = cachedGeo('livprop:slice', () => {
        const s = new THREE.Shape();
        s.moveTo(0, -0.12);
        s.lineTo(-0.09, 0.08);
        s.quadraticCurveTo(0, 0.12, 0.09, 0.08);
        s.closePath();
        const g = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1 });
        g.translate(0, 0, -0.02);
        return g;
      });
      const crustMat = plastic('#a8652e', 0.7);
      slice.add(mesh(geo, crustMat));
      const cheese = mesh(cachedGeo('livprop:cheese', () => new THREE.CircleGeometry(0.085, 3, Math.PI / 2 + 0.0, Math.PI * 2)), plastic('#ffd35a', 0.5), false);
      cheese.scale.set(0.85, 0.95, 1);
      cheese.rotation.z = Math.PI;
      cheese.position.set(0, -0.005, 0.03);
      slice.add(cheese);
      for (const [x, y] of [[0, 0.03], [-0.03, -0.03], [0.025, -0.06]]) {
        const pep = mesh(cylinderGeo(0.016, 0.016, 0.006, 10), plastic('#b3261e', 0.5), false);
        pep.rotation.x = Math.PI / 2;
        pep.position.set(x, y, 0.034);
        slice.add(pep);
      }
      break;
    }
    case 'lakeMichigan': {
      // little sailboat
      const hull = mesh(roundedBox(0.06, 0.05, 0.22, 0.02, 1), plastic('#e4002b', 0.4));
      hull.position.y = 0.03;
      top.add(hull);
      const mast = mesh(cylinderGeo(0.006, 0.006, 0.26, 5), plastic('#ffffff', 0.4), false);
      mast.position.set(0, 0.18, 0.02);
      top.add(mast);
      const sail = mesh(cachedGeo('livprop:sail', () => {
        const s = new THREE.Shape();
        s.moveTo(0, 0);
        s.lineTo(0, 0.22);
        s.lineTo(-0.13, 0);
        s.closePath();
        return new THREE.ShapeGeometry(s);
      }), cachedMat('livprop:sailmat', () => new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 0.6 })), false);
      sail.rotation.y = -Math.PI / 2;
      sail.position.set(0, 0.07, 0.02);
      top.add(sail);
      break;
    }
    case 'bean': {
      // a tiny Cloud Gate
      const bean = mesh(sphereGeo(20, 12), liverySolid('bean', '#e9edf2'));
      bean.scale.set(0.15, 0.07, 0.08);
      bean.position.y = 0.07;
      top.add(bean);
      break;
    }
  }
}

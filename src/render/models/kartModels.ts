import * as THREE from 'three';
import type { CharacterDef } from '../../data/characters';
import type { KartRig } from './types';

/** PLACEHOLDER kart builder - replaced by the art workstream. */
export function buildKart(def: CharacterDef): KartRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const mat = new THREE.MeshStandardMaterial({ color: def.colors.primary, roughness: 0.4 });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 2.2), mat);
  shell.position.y = 0.55;
  shell.castShadow = true;
  body.add(shell);
  const seat = new THREE.Object3D();
  seat.position.set(0, 0.75, -0.2);
  body.add(seat);
  const wheels: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  const wmat = new THREE.MeshStandardMaterial({ color: '#222' });
  for (const [x, z] of [[-0.8, 0.75], [0.8, 0.75], [-0.8, -0.75], [0.8, -0.75]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.35, z);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 16).rotateZ(Math.PI / 2), wmat);
    pivot.add(w);
    root.add(pivot);
    wheels.push(w);
    if (z > 0) frontPivots.push(pivot);
  }
  const exhausts = [new THREE.Object3D(), new THREE.Object3D()];
  exhausts[0].position.set(-0.35, 0.5, -1.15);
  exhausts[1].position.set(0.35, 0.5, -1.15);
  exhausts.forEach((e) => body.add(e));
  const rearContacts = [new THREE.Object3D(), new THREE.Object3D()];
  rearContacts[0].position.set(-0.8, 0.05, -0.8);
  rearContacts[1].position.set(0.8, 0.05, -0.8);
  rearContacts.forEach((e) => root.add(e));
  return {
    root, body, seat, wheels, frontPivots, exhausts, rearContacts,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    },
  };
}

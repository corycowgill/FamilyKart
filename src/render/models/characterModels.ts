import * as THREE from 'three';
import { characterById } from '../../data/characters';
import type { CharacterId } from '../../sim/types';
import type { CharacterAnimState, CharacterRig } from './types';

/** PLACEHOLDER character builder - replaced by the art workstream. */
export function buildCharacter(id: CharacterId): CharacterRig {
  const def = characterById(id);
  const root = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.4, 4, 12), new THREE.MeshStandardMaterial({ color: def.colors.suit }));
  torso.position.y = 0.45;
  root.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), new THREE.MeshStandardMaterial({ color: id === 'lupin' ? '#e8d3a8' : '#f2c6a0' }));
  head.position.y = 1.15;
  root.add(head);
  return {
    id, root,
    update(_dt: number, s: CharacterAnimState) {
      root.rotation.z = -s.steer * 0.15;
      head.rotation.y = -s.steer * 0.3;
    },
    dispose() {},
  };
}

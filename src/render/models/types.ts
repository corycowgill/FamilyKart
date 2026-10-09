import type * as THREE from 'three';
import type { CharacterId } from '../../sim/types';

/** Animation inputs a character rig responds to every frame. */
export interface CharacterAnimState {
  steer: number; // -1..1
  speed: number; // m/s forward
  drifting: boolean;
  driftDir: number;
  airborne: boolean;
  boosting: boolean;
  reaction: 'none' | 'hit' | 'item' | 'overtake' | 'jump' | 'win' | 'lose';
  reactionTime: number;
  time: number;
}

/** A character model seated in a kart. Origin = seat position, facing +Z. */
export interface CharacterRig {
  id: CharacterId;
  root: THREE.Group;
  update(dt: number, s: CharacterAnimState): void;
  dispose(): void;
}

/** A kart body. Origin = ground contact center, facing +Z, ~2.2m long. */
export interface KartRig {
  root: THREE.Group;
  /** Rotates with suspension / lean (child of root). */
  body: THREE.Group;
  /** Where the character sits (child of body). */
  seat: THREE.Object3D;
  /** Wheel meshes (spin around local X). Front wheels are also steering pivots. */
  wheels: THREE.Object3D[];
  frontPivots: THREE.Object3D[];
  /** Exhaust attachment points for boost flames (child of body). */
  exhausts: THREE.Object3D[];
  /** Rear tire contact points for drift sparks/smoke (child of root). */
  rearContacts: THREE.Object3D[];
  dispose(): void;
}

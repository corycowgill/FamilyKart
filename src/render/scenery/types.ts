import type * as THREE from 'three';
import type { Track } from '../../sim/track/Track';

export interface SceneryContext {
  track: Track;
  /** Add objects here; it is disposed when the race ends. */
  group: THREE.Group;
  quality: 'low' | 'medium' | 'high';
}

export interface SceneryHandle {
  /** Called every rendered frame with race time (s). */
  update(dt: number, time: number): void;
  dispose?(): void;
}

export type SceneryBuilder = (ctx: SceneryContext) => SceneryHandle;

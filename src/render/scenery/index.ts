import type { SceneryId, TrackDef } from '../../sim/types';
import type { SceneryBuilder } from './types';

/** Lazily loaded per-theme scenery so only the selected track's environment code is downloaded. */
export const SCENERY: Record<SceneryId, () => Promise<SceneryBuilder>> = {
  chicago: () => import('./chicago').then((m) => m.buildChicago),
  neighborhood: () => import('./neighborhood').then((m) => m.buildNeighborhood),
  kitchen: () => import('./kitchen').then((m) => m.buildKitchen),
  dogpark: () => import('./dogpark').then((m) => m.buildDogPark),
  snow: () => import('./snow').then((m) => m.buildSnow),
  sweethome: () => import('./sweethome').then((m) => m.buildSweetHome),
};

/** Scenery loader for a track: its own scenery set if it names one, else its theme's. */
export const sceneryFor = (def: TrackDef): (() => Promise<SceneryBuilder>) => SCENERY[def.scenery ?? def.theme];

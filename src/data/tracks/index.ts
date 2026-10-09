import type { TrackDef } from '../../sim/types';
import { CHICAGO } from './chicago';
import { DOGPARK } from './dogpark';
import { KITCHEN } from './kitchen';
import { NEIGHBORHOOD } from './neighborhood';
import { SNOW } from './snow';

/** All playable tracks in menu order. */
export const TRACKS: TrackDef[] = [CHICAGO, NEIGHBORHOOD, KITCHEN, DOGPARK, SNOW];

export const trackById = (id: string): TrackDef => {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown track ${id}`);
  return t;
};

/** Grand Prix cups (four tracks each). */
export const CUPS: Array<{ id: string; name: string; tracks: string[] }> = [
  { id: 'windy', name: 'Windy City Cup', tracks: ['chicago', 'neighborhood', 'kitchen', 'dogpark'] },
  { id: 'frosty', name: 'Frosty Family Cup', tracks: ['snow', 'dogpark', 'kitchen', 'chicago'] },
];

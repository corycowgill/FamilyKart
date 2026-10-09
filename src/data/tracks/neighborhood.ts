import type { TrackDef } from '../../sim/types';
import { fractionNear } from './helpers';
import { roundedLoop, roundedOpen, shortcutExitFraction, trimShortcutStart } from './layout';

/**
 * Chicago residential grid: brick two-flats and bungalows, a Milwaukee-Avenue style diagonal,
 * sprinklers on the parkways, speed bumps, and an alley + backyard shortcut through the middle block.
 */
const points = roundedLoop(
  [
    [0, -60], // start/finish on the long avenue heading north
    [0, 140, 40],
    [150, 140, 30],
    [250, 40, 30], // diagonal avenue
    [250, -30, 24],
    [100, -30, 26],
    [100, -190, 28],
    [260, -190, 28],
    [260, -330, 36],
    [0, -330, 40],
  ],
  30,
);

const f = (x: number, z: number) => fractionNear(points, x, z);

const alley = trimShortcutStart(points, roundedOpen(
  [
    [212, -30],
    [176, -30, 14],
    [176, -160, 16],
    [214, -190],
  ],
  16,
  8,
), 14, 3, 16);

export const NEIGHBORHOOD: TrackDef = {
  id: 'neighborhood',
  name: 'Neighborhood Mayhem',
  theme: 'neighborhood',
  description: 'Tear through the two-flats, dodge the sprinklers and cut through the alley behind the garages.',
  difficulty: 1,
  laps: 3,
  points,
  width: 16,
  shoulder: 6,
  shortcuts: [
    {
      id: 'alley',
      points: alley,
      width: 9,
      from: shortcutExitFraction(points, alley, 14, 16),
      to: f(214, -190),
      surface: 'road',
      aiAppeal: 0.55,
    },
  ],
  surfaces: [
    { from: f(100, -95), to: f(100, -125), type: 'mud', side: 'left' },
    { from: f(140, -330), to: f(110, -330), type: 'mud', side: 'right' },
  ],
  boostPads: [
    { t: f(0, 60), lateral: 0.35 },
    { t: f(200, -190), lateral: -0.3 },
    { t: f(170, -330), lateral: 0 },
  ],
  ramps: [
    // speed bumps (little kickers)
    { t: f(0, -10), impulse: 3, length: 5 },
    { t: f(175, -30), impulse: 3, length: 5 },
    { t: f(80, -330), impulse: 3.5, length: 5 },
    // backyard kiddie-pool jump on the alley shortcut
    { t: 0.58, impulse: 7, length: 7, shortcut: 'alley' },
  ],
  gaps: [],
  itemRows: [f(0, 90), f(205, 85), f(100, -150), f(260, -260), f(60, -330)],
  hazards: [
    { kind: 'sprinkler', t: f(80, 140), sweep: 5, period: 5, radius: 2.2 },
    { kind: 'sprinkler', t: f(250, 5), sweep: 5, period: 4.5, radius: 2.2 },
    { kind: 'sprinkler', t: f(260, -240), sweep: 5, period: 5.5, radius: 2.2 },
    { kind: 'sprinkler', t: f(0, -250), sweep: 4, period: 4, radius: 2.2 },
  ],
  landmarks: [
    { kind: 'church', x: -70, z: 40, rot: Math.PI / 2 },
    { kind: 'park', x: 175, z: -250 },
    { kind: 'watertower', x: 330, z: 120 },
    { kind: 'cornerStore', x: 44, z: 178, rot: Math.PI },
    { kind: 'school', x: 130, z: 50, rot: 0 },
    { kind: 'pool', x: 176, z: -112 },
    { kind: 'garages', x: 176, z: -70 },
    { kind: 'hydrant', x: 22, z: -100 },
  ],
  lighting: {
    skyTop: '#4f9be8', skyBottom: '#ffe7c4', fog: '#e8dcc8', fogNear: 220, fogFar: 1100,
    sun: '#ffd9a0', sunIntensity: 2.4, ambient: '#c7d9ff', ground: '#6ab84f',
  },
  music: { tempo: 132, root: 62, scale: 'mixolydian', style: 'surf' },
};

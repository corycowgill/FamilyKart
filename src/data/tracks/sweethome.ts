import type { TrackDef } from '../../sim/types';
import { fractionNear } from './helpers';
import { roundedLoop, roundedOpen, shortcutExitFraction, trimShortcutStart, type Corner } from './layout';

/**
 * Sweet Home Chicago: a grand tour of the city. North up the Magnificent Mile past the Water Tower,
 * out to Oak Street Beach and up Lake Shore Drive, a lap of Wrigleyville around the ivy-covered ballpark
 * (with an alley shortcut behind the rooftop bleachers), down into the yellow-lit tunnels of Lower Wacker
 * Drive, then a leap over the raised bascule bridge on the green Chicago River back to the finish.
 */
const S = 0.75; // layout authored on a 4/3 grid, scaled to race length
const c = (x: number, z: number, r?: number, y?: number, w?: number): Corner => [x * S, z * S, r, y, w];
const points = roundedLoop(
  [
    c(0, -150), // start / finish on Michigan Avenue heading north
    c(0, 60, 40), // top of the Mag Mile, swing east toward the lake
    c(170, 60, 36), // Oak Street Beach
    c(215, 260, 70), // Lake Shore Drive sweepers
    c(180, 430, 55),
    c(60, 475, 34), // into Wrigleyville
    c(-90, 475, 28),
    c(-90, 330, 26), // around the ballpark block
    c(-205, 330, 30),
    c(-205, 40, 44, -6), // down into Lower Wacker Drive
    c(-205, -150, 44, -6),
    c(-120, -300, 46, 0), // up and onto the river bridge
    c(0, -300, 40),
  ],
  30,
);

const f = (x: number, z: number) => fractionNear(points, x * S, z * S);

// Wrigleyville alley behind the rooftop bleachers
const alley = trimShortcutStart(points, roundedOpen(
  [
    [-90 * S, 440 * S],
    [-130 * S, 420 * S, 14],
    [-170 * S, 380 * S, 14],
    [-205 * S, 300 * S],
  ],
  14,
  8,
), 14, 3, 18);

const gapStart = f(-75, -300);
const gapEnd = f(-60, -300);

export const SWEETHOME: TrackDef = {
  id: 'sweethome',
  name: 'Sweet Home Chicago',
  theme: 'chicago',
  description: 'The grand tour: the Mag Mile, Lake Shore Drive, Wrigleyville, Lower Wacker and a leap over the river.',
  difficulty: 2,
  laps: 3,
  points,
  width: 18,
  shoulder: 6,
  shortcuts: [
    {
      id: 'wrigley-alley',
      points: alley,
      width: 8,
      from: shortcutExitFraction(points, alley, 14, 18),
      to: f(-205, 300),
      surface: 'road',
      aiAppeal: 0.5,
    },
  ],
  surfaces: [],
  boostPads: [
    { t: f(0, -40), lateral: -0.35 },
    { t: f(205, 200), lateral: 0.3 },
    { t: f(-205, -60), lateral: 0 },
  ],
  ramps: [{ t: gapStart - 0.002, impulse: 9, length: 9 }],
  gaps: [{ from: gapStart, to: gapEnd }],
  itemRows: [f(0, 20), f(200, 160), f(-30, 475), f(-205, 160), f(-160, -250)],
  hazards: [{ kind: 'train', t: f(130, 470), period: 9, sweep: 0 }],
  landmarks: [],
  lighting: {
    skyTop: '#3b86de', skyBottom: '#ffd7a8', fog: '#d6e6f5', fogNear: 260, fogFar: 1400,
    sun: '#ffe2b8', sunIntensity: 2.6, ambient: '#bcd7ff', ground: '#5fae4a',
  },
  music: { tempo: 124, root: 64, scale: 'mixolydian', style: 'blues' },
};

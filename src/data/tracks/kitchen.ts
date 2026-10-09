import type { TrackDef } from '../../sim/types';
import { fractionNear } from './helpers';
import { roundedLoop, roundedOpen, shortcutExitFraction, trimShortcutStart } from './layout';

/**
 * The racers are tiny: a placemat road loops over a giant marble counter (x < 0) and the breakfast
 * table (x > 0). Jump the aisle between counter and table, return over a wooden-spoon bridge.
 */
const points = roundedLoop(
  [
    [-180, 0],
    [-180, 190, 46],
    [190, 190, 42],
    [190, 70, 30],
    [300, 70, 30],
    [300, -190, 44],
    [230, -190, 26], // bump around the fruit bowl
    [190, -128, 26],
    [110, -128, 26],
    [70, -190, 26],
    [-90, -190, 34],
    [-90, -90, 28],
    [-180, -90, 28],
  ],
  30,
);

const f = (x: number, z: number) => fractionNear(points, x, z);
const gapStart = f(-7, 190);
const gapEnd = f(7, 190);

const napkin = trimShortcutStart(points, roundedOpen(
  [
    [262, -190],
    [40, -190],
  ],
  20,
  8,
), 16, 3, 22);

export const KITCHEN: TrackDef = {
  id: 'kitchen',
  name: 'Kitchen Chaos',
  theme: 'kitchen',
  description: 'Shrunk to breakfast size! Race the countertop, leap to the table and dodge the rolling fruit.',
  difficulty: 2,
  laps: 3,
  points,
  width: 22,
  shoulder: 5,
  shortcuts: [
    {
      id: 'napkin',
      points: napkin,
      width: 10,
      from: shortcutExitFraction(points, napkin, 16, 22),
      to: f(40, -190),
      surface: 'road',
      aiAppeal: 0.6,
    },
  ],
  surfaces: [
    { from: f(190, 110), to: f(225, 70), type: 'milk', side: 'both' },
    { from: f(-90, -170), to: f(-90, -120), type: 'milk', side: 'left' },
    { from: f(-180, 120), to: f(-180, 150), type: 'milk', side: 'right' },
  ],
  boostPads: [
    { t: f(-180, 60), lateral: 0 },
    { t: f(300, -40), lateral: -0.35 },
    { t: f(150, -128), lateral: 0.3 },
  ],
  ramps: [{ t: gapStart - 0.0015, impulse: 9, length: 10 }],
  gaps: [{ from: gapStart, to: gapEnd }],
  itemRows: [f(-180, 60), f(45, 190), f(190, 125), f(300, 10), f(-20, -190)],
  hazards: [
    { kind: 'rollingFruit', t: f(300, 30), sweep: 9, period: 5, radius: 2.6 },
    { kind: 'rollingFruit', t: f(-120, -190), sweep: 8, period: 4.2, radius: 2.4 },
    { kind: 'rollingFruit', t: f(260, 70), sweep: 8, period: 4.8, radius: 2.4 },
  ],
  landmarks: [
    { kind: 'channel', x: 0, z: 0, rot: Math.PI / 2, scale: 330, y: -60 },
    { kind: 'cerealBox', x: -222, z: 120, rot: 0.3 },
    { kind: 'cerealBox', x: -222, z: -30, rot: -0.2 },
    { kind: 'cerealBox', x: 60, z: 228, rot: 0.1 },
    { kind: 'cerealBox', x: 345, z: -100, rot: 1.5 },
    { kind: 'toaster', x: -110, z: 228, rot: 0 },
    { kind: 'fridge', x: -330, z: 250 },
    { kind: 'stove', x: -95, z: 50 },
    { kind: 'fruitBowl', x: 150, z: -165 },
    { kind: 'plate', x: 245, z: 140 },
    { kind: 'plate', x: 245, z: -60 },
    { kind: 'mug', x: 110, z: 110 },
    { kind: 'spoonBridge', x: 0, z: -190 },
    { kind: 'chair', x: 380, z: 60 },
    { kind: 'chair', x: 380, z: -120 },
    { kind: 'chair', x: 150, z: 290 },
    { kind: 'milkCarton', x: -60, z: 120 },
  ],
  lighting: {
    skyTop: '#f7e6c8', skyBottom: '#fff6e6', fog: '#f3e3c8', fogNear: 300, fogFar: 1300,
    sun: '#fff1d8', sunIntensity: 2.3, ambient: '#ffe8cc', ground: '#e9e4dc',
  },
  music: { tempo: 140, root: 65, scale: 'major', style: 'bouncy' },
};

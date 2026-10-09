import type { TrackDef } from '../../sim/types';
import { fractionNear } from './helpers';
import { roundedLoop, roundedOpen, shortcutExitFraction, trimShortcutStart } from './layout';

/**
 * Downtown Chicago buried in snow at dusk: holiday lights on State Street, icy corners, snowplows
 * sweeping the avenues and a lakefront path shortcut beside the frozen lake.
 */
const points = roundedLoop(
  [
    [0, -100],
    [0, 140, 36],
    [150, 140, 30],
    [150, 300, 40],
    [300, 300, 46],
    [300, 150, 24], // inland bump around the park
    [238, 108, 24],
    [238, 12, 24],
    [300, -30, 24],
    [300, -140, 40],
    [150, -290, 40],
    [0, -290, 36],
  ],
  30,
);

const f = (x: number, z: number) => fractionNear(points, x, z);

const lakefront = trimShortcutStart(points, roundedOpen(
  [
    [300, 176],
    [300, -56],
  ],
  20,
  8,
), 15, 3, 18);

export const SNOW: TrackDef = {
  id: 'snow',
  name: 'Chicago Snowpocalypse',
  theme: 'snow',
  description: 'Lake-effect blizzard downtown! Slide the icy corners, dodge the snowplows and take the frozen lakefront path.',
  difficulty: 3,
  laps: 3,
  points,
  width: 18,
  shoulder: 6,
  shortcuts: [
    {
      id: 'lakefront',
      points: lakefront,
      width: 9,
      from: shortcutExitFraction(points, lakefront, 15, 18),
      to: f(300, -56),
      surface: 'ice',
      aiAppeal: 0.5,
    },
  ],
  surfaces: [
    { from: f(126, 140), to: f(150, 170), type: 'ice', side: 'both' },
    { from: f(270, 300), to: f(300, 268), type: 'ice', side: 'both' },
    { from: f(280, -160), to: f(240, -200), type: 'ice', side: 'left' },
    { from: f(20, -290), to: f(0, -262), type: 'ice', side: 'both' },
  ],
  boostPads: [
    { t: f(0, -20), lateral: -0.3 },
    { t: f(150, 240), lateral: 0.3 },
    { t: f(300, -90), lateral: 0 },
  ],
  ramps: [
    { t: f(0, 60), impulse: 7, length: 8 },
    { t: f(200, -240), impulse: 6.5, length: 8 },
  ],
  gaps: [],
  itemRows: [f(0, 20), f(150, 200), f(250, 300), f(238, 60), f(80, -290)],
  hazards: [
    { kind: 'snowplow', t: f(220, 300), sweep: 6, period: 6, radius: 2.8 },
    { kind: 'snowplow', t: f(60, -290), sweep: 6, period: 7, radius: 2.8 },
    { kind: 'snowplow', t: f(0, 100), sweep: 5, period: 6.5, radius: 2.8 },
  ],
  landmarks: [
    { kind: 'shore', x: 345, z: 0 },
    { kind: 'skyline', x: -150, z: 0 },
    { kind: 'christmasTree', x: 75, z: 220 },
    { kind: 'bean', x: 75, z: 60 },
    { kind: 'iceRink', x: 190, z: 60 },
    { kind: 'ltrain', x: 0, z: 200, rot: Math.PI / 2 },
    { kind: 'marquee', x: -32, z: -40, rot: Math.PI / 2 },
    { kind: 'lighthouse', x: 420, z: 120 },
  ],
  lighting: {
    skyTop: '#26305e', skyBottom: '#e89a7a', fog: '#8f8fae', fogNear: 120, fogFar: 750,
    sun: '#ffb38a', sunIntensity: 1.5, ambient: '#9fb4e6', ground: '#e6edf6',
  },
  music: { tempo: 136, root: 57, scale: 'minor', style: 'sleigh' },
};

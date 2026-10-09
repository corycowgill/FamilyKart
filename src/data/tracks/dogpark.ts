import type { TrackDef } from '../../sim/types';
import { fractionNear } from './helpers';
import { roundedLoop, roundedOpen, shortcutExitFraction, trimShortcutStart } from './layout';

/**
 * Lupin's dog park: a dirt path over rolling grassy hills. Jump the creek right after the start,
 * climb the ridge, cross back on the wooden bridge and dive through the hollow-log shortcut.
 */
const points = roundedLoop(
  [
    [0, -95, 0, 0],
    [0, 70, 46, 1.5],
    [-40, 160, 40, 3.5],
    [40, 250, 44, 6.5],
    [170, 230, 50, 8],
    [260, 290, 46, 9],
    [400, 250, 50, 7],
    [400, 110, 40, 4],
    [340, 60, 34, 3],
    [340, -170, 40, 0.5],
    [250, -170, 24, 0],
    [215, -246, 24, 1.5], // bump around the dog houses
    [155, -246, 24, 1.5],
    [120, -170, 24, 0],
    [0, -170, 40, 0],
  ],
  30,
);

const f = (x: number, z: number) => fractionNear(points, x, z);
const gapStart = f(0, -17);
const gapEnd = f(0, -3);

const hollowLog = trimShortcutStart(points, roundedOpen(
  [
    [272, -170],
    [96, -170],
  ],
  20,
  8,
), 15, 3, 18);

export const DOGPARK: TrackDef = {
  id: 'dogpark',
  name: "Lupin's Dog Park",
  theme: 'dogpark',
  description: 'Fetch! Jump the creek, splash through mud and dash through the hollow log.',
  difficulty: 2,
  laps: 3,
  points,
  width: 18,
  shoulder: 6,
  shortcuts: [
    {
      id: 'log',
      points: hollowLog,
      width: 9,
      from: shortcutExitFraction(points, hollowLog, 15, 18),
      to: f(96, -170),
      surface: 'mud',
      aiAppeal: 0.55,
    },
  ],
  surfaces: [
    { from: f(-30, 130), to: f(-40, 170), type: 'mud', side: 'left' },
    { from: f(340, 40), to: f(340, 10), type: 'mud', side: 'right' },
    { from: f(185, -246), to: f(165, -246), type: 'mud', side: 'both' },
  ],
  boostPads: [
    { t: f(0, 30), lateral: 0.3 },
    { t: f(110, 240), lateral: -0.3 },
    { t: f(340, -90), lateral: 0 },
  ],
  ramps: [
    { t: gapStart - 0.0015, impulse: 9, length: 9 },
    { t: f(400, 180), impulse: 6, length: 7 },
  ],
  gaps: [{ from: gapStart, to: gapEnd }],
  itemRows: [f(-14, 112), f(100, 240), f(330, 280), f(340, -10), f(340, -130), f(60, -170)],
  hazards: [
    { kind: 'tennisBallCannon', t: f(340, -60), sweep: 6, period: 4.5, radius: 2.3 },
    { kind: 'tennisBallCannon', t: f(40, -170), sweep: 6, period: 5, radius: 2.3 },
    { kind: 'sprinklerMud', t: f(215, 260), sweep: 5, period: 5, radius: 2.2 },
  ],
  landmarks: [
    { kind: 'river', x: 170, z: -10, rot: 0, scale: 300, y: -6 },
    { kind: 'woodBridge', x: 340, z: -10 },
    { kind: 'dogHouse', x: 185, z: -205, rot: 0 },
    { kind: 'dogHouse', x: 60, z: -240, rot: 0.6 },
    { kind: 'dogHouse', x: -60, z: 90, rot: -1.2 },
    { kind: 'tennisBall', x: 130, z: 90, scale: 7 },
    { kind: 'tennisBall', x: 260, z: 60, scale: 5 },
    { kind: 'tennisBall', x: -70, z: -80, scale: 4 },
    { kind: 'bone', x: 170, z: 40, rot: 0.4, scale: 1.4 },
    { kind: 'bone', x: 420, z: -60, rot: -0.8, scale: 1 },
    { kind: 'tunnel', x: 125, z: 237 },
    { kind: 'tunnel', x: 0, z: 38 },
    { kind: 'agility', x: 200, z: 120 },
    { kind: 'agility', x: 80, z: -100 },
    { kind: 'fireHydrant', x: 120, z: -110 },
    { kind: 'hollowLog', x: 184, z: -170 },
  ],
  lighting: {
    skyTop: '#46a2f0', skyBottom: '#dff3ff', fog: '#d3ecf7', fogNear: 220, fogFar: 1100,
    sun: '#fff4dc', sunIntensity: 2.7, ambient: '#cfe6ff', ground: '#6fbf4c',
  },
  music: { tempo: 150, root: 67, scale: 'major', style: 'bouncy' },
};

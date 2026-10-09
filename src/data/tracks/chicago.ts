import type { TrackDef, TrackPoint } from '../../sim/types';
import { fractionNear } from './helpers';

// Lake Michigan lies east (+x). Downtown skyline to the west. Start/finish on the lakefront heading north.
const points: TrackPoint[] = [
  [25, -150, 0, 22],
  [22, -40, 0, 22],
  [18, 70, 0, 20],
  [8, 125],
  [-40, 150],
  [-110, 152],
  [-152, 160],
  [-172, 200],
  [-172, 262],
  [-188, 305],
  [-228, 322],
  [-290, 318],
  [-330, 298],
  [-345, 255],
  [-342, 190, 3],
  [-336, 120, 3],
  [-326, 50],
  [-306, -20],
  [-266, -70],
  [-200, -105],
  [-130, -140],
  [-70, -195],
  [-10, -232],
  [38, -222],
  [48, -190],
];

const f = (x: number, z: number) => fractionNear(points, x, z);
const gapStart = f(-340, 160);
const gapEnd = f(-339, 146);

export const CHICAGO: TrackDef = {
  id: 'chicago',
  name: 'Chicago Grand Prix',
  theme: 'chicago',
  description: 'Blast along the lakefront, carve through downtown and leap the river bridge.',
  difficulty: 1,
  laps: 3,
  points,
  width: 18,
  shoulder: 7,
  shortcuts: [
    {
      id: 'alley',
      points: [
        [-96, 153],
        [-110, 170],
        [-128, 200],
        [-150, 232],
        [-170, 252],
      ],
      width: 8,
      from: f(-96, 152),
      to: f(-172, 252),
      surface: 'road',
      aiAppeal: 0.6,
    },
  ],
  surfaces: [],
  boostPads: [
    { t: f(22, -60), lateral: -0.4 },
    { t: f(-230, -88), lateral: 0.3 },
    { t: f(-336, 225), lateral: 0 },
  ],
  ramps: [{ t: gapStart - 0.002, impulse: 9, length: 9 }],
  gaps: [{ from: gapStart, to: gapEnd }],
  itemRows: [f(20, 20), f(-80, 151), f(-260, 320), f(-325, 60), f(-100, -168)],
  hazards: [{ kind: 'train', t: f(-172, 230), period: 9, sweep: 0 }],
  landmarks: [
    { kind: 'startArch', x: 23, z: -150 },
    { kind: 'ferrisWheel', x: 140, z: 40 },
    { kind: 'pier', x: 110, z: 40 },
    { kind: 'fountain', x: -250, z: 80 },
    { kind: 'ltrain', x: -172, z: 230, rot: Math.PI / 2 },
    { kind: 'bridge', x: -340, z: 153 },
    { kind: 'river', x: -340, z: 153, rot: Math.PI / 2 },
    { kind: 'skyline', x: -260, z: 200 },
    { kind: 'lake', x: 300, z: 0 },
  ],
  lighting: {
    skyTop: '#3d8fe0', skyBottom: '#ffe1b8', fog: '#cfe4f5', fogNear: 250, fogFar: 1300,
    sun: '#fff1d6', sunIntensity: 2.6, ambient: '#bcd7ff', ground: '#5fae4a',
  },
  music: { tempo: 148, root: 60, scale: 'major', style: 'rock' },
};

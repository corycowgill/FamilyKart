/**
 * Chicago paint jobs ("liveries") for the karts: pure data + unlock rules (no three.js here, so the
 * save system and unit tests can use it). The 3D side lives in kartModels.ts / liveryPaint.ts.
 *
 * Every livery works on all six karts: it repaints the body/pods with a procedural pattern, swaps the
 * hood + side decals and adds one small accessory on top of the spoiler.
 */

export type LiveryId = 'chicagoFlag' | 'windyCity' | 'lowerWacker' | 'chicagoDog' | 'bluesClub' | 'lTrain' | 'deepDish' | 'lakeMichigan' | 'bean';

export type RaceKind = 'quick' | 'versus' | 'grandprix' | 'timetrial';
export type LiveryTimeOfDay = 'day' | 'sunset' | 'night';

/** What a finished race tells the unlock rules (one call per human racer). */
export interface RaceUnlockContext {
  trackId: string;
  mode: RaceKind;
  place: number;
  finished: boolean;
  timeOfDay: LiveryTimeOfDay;
  /** Set a new track record (time trial or race). */
  newRecord: boolean;
}

export interface CupUnlockContext {
  cupId: string;
  place: number;
}

/** The parts of an existing save the retroactive rules look at (saves made before liveries existed). */
export interface UnlockHistory {
  totals: { races: number; wins: number };
  records: Record<string, { wins: number; races: number; bestRace?: number }>;
  cups: Record<string, { bestPlace: number }>;
  ghosts: Record<string, unknown>;
}

export interface LiveryColors {
  /** Main body base colour (also the swatch background). */
  body: string;
  /** Cowl, round bumpers, spoiler end plates. */
  pod: string;
  /** Trim strips, blade plates. */
  trim: string;
  /** Spoiler wing / fins. */
  wing: string;
  /** Wheel spokes. */
  hub: string;
  /** Mudguards. */
  fender: string;
}

export interface LiveryDef {
  id: LiveryId;
  name: string;
  description: string;
  /** Three colours for the swatch chip (CSS). */
  swatch: [string, string, string];
  colors: LiveryColors;
  /** Short "how to unlock" text for kids. */
  hint: string;
  icon: string;
  start?: boolean;
  race?: (c: RaceUnlockContext) => boolean;
  cup?: (c: CupUnlockContext) => boolean;
  /** Retroactive unlock from an older save's progress. */
  history?: (h: UnlockHistory) => boolean;
}

export const LIVERIES: LiveryDef[] = [
  {
    id: 'chicagoFlag', name: 'Chicago Flag', icon: '⭐',
    description: 'White as lake-effect snow, two Lake Michigan-blue stripes and four red six-point stars.',
    swatch: ['#ffffff', '#41B6E6', '#E4002B'],
    colors: { body: '#f4f6f8', pod: '#41b6e6', trim: '#e4002b', wing: '#41b6e6', hub: '#e4002b', fender: '#41b6e6' },
    hint: 'Ready to go!', start: true,
  },
  {
    id: 'windyCity', name: 'Windy City', icon: '🌬️',
    description: 'Sky blue with swooshing white gusts. Hold on to your hat!',
    swatch: ['#59b8f0', '#ffffff', '#2a7fd0'],
    colors: { body: '#59b8f0', pod: '#ffffff', trim: '#ffffff', wing: '#2a7fd0', hub: '#ffffff', fender: '#ffffff' },
    hint: 'Finish any race',
    race: (c) => c.finished,
    history: (h) => h.totals.races > 0,
  },
  {
    id: 'lowerWacker', name: 'Lower Wacker', icon: '🌃',
    description: 'Midnight black with glowing sodium-lamp stripes, straight from the city’s secret underground street.',
    swatch: ['#15161a', '#ffb020', '#3a3c44'],
    colors: { body: '#15161a', pod: '#2a2c33', trim: '#ffb020', wing: '#15161a', hub: '#ffb020', fender: '#2a2c33' },
    hint: 'Finish a race at night',
    race: (c) => c.finished && c.timeOfDay === 'night',
  },
  {
    id: 'chicagoDog', name: 'Chicago Dog', icon: '🌭',
    description: 'Poppy-seed bun, mustard zigzag and neon relish. Never, ever ketchup.',
    swatch: ['#e3b16a', '#f5c518', '#3fae2a'],
    colors: { body: '#e3b16a', pod: '#3fae2a', trim: '#f5c518', wing: '#c8333a', hub: '#f5c518', fender: '#3fae2a' },
    hint: 'Finish on the podium (top 3)',
    race: (c) => c.finished && c.mode !== 'timetrial' && c.place <= 3,
    history: (h) => h.totals.wins > 0,
  },
  {
    id: 'bluesClub', name: 'Blues Club', icon: '🎷',
    description: 'Deep midnight blue with neon pink and blue trim that glows when the sun goes down.',
    swatch: ['#12206b', '#ff3fa4', '#3fd8ff'],
    colors: { body: '#12206b', pod: '#0c1650', trim: '#ff3fa4', wing: '#0c1650', hub: '#3fd8ff', fender: '#0c1650' },
    hint: 'Finish a race on Sweet Home Chicago',
    race: (c) => c.finished && c.trackId === 'sweethome' && c.mode !== 'timetrial',
    history: (h) => (h.records.sweethome?.races ?? 0) > 0,
  },
  {
    id: 'lTrain', name: 'L Train', icon: '🚇',
    description: 'Brushed stainless steel with a CTA line stripe, an "L" roundel and a little pantograph on top. Ding-dong!',
    swatch: ['#c9ced6', '#c60c30', '#00a1de'],
    colors: { body: '#c9ced6', pod: '#3a3f48', trim: '#c60c30', wing: '#3a3f48', hub: '#00a1de', fender: '#9aa1ab' },
    hint: 'Win a race on Chicago Grand Prix',
    race: (c) => c.finished && c.place === 1 && c.trackId === 'chicago' && c.mode !== 'timetrial',
  },
  {
    id: 'deepDish', name: 'Deep Dish', icon: '🍕',
    description: 'Tomato-sauce red, melty cheese drips and a golden crust. Takes 45 minutes to bake.',
    swatch: ['#c8281e', '#ffd35a', '#a8652e'],
    colors: { body: '#c8281e', pod: '#a8652e', trim: '#ffd35a', wing: '#a8652e', hub: '#ffd35a', fender: '#a8652e' },
    hint: 'Win a race on Kitchen Chaos',
    race: (c) => c.finished && c.place === 1 && c.trackId === 'kitchen' && c.mode !== 'timetrial',
  },
  {
    id: 'lakeMichigan', name: 'Lake Michigan', icon: '⛵',
    description: 'Deep lake blue fading to teal, rolling waves and a sailboat badge.',
    swatch: ['#0b2d6b', '#1fb5b0', '#ffffff'],
    colors: { body: '#0b2d6b', pod: '#0e3f80', trim: '#ffffff', wing: '#1fb5b0', hub: '#ffffff', fender: '#0e3f80' },
    hint: 'Set a Time Trial record',
    race: (c) => c.finished && c.mode === 'timetrial' && c.newRecord,
    history: (h) => Object.keys(h.ghosts).length > 0,
  },
  {
    id: 'bean', name: 'The Bean', icon: '🫘',
    description: 'Polished mirror chrome. See the whole city (and the kart behind you) in it.',
    swatch: ['#f2f5f8', '#9aa3ad', '#dfe6ee'],
    colors: { body: '#e9edf2', pod: '#e9edf2', trim: '#9aa3ad', wing: '#e9edf2', hub: '#e9edf2', fender: '#e9edf2' },
    hint: 'Finish a Grand Prix in the top 3',
    cup: (c) => c.place <= 3,
    history: (h) => Object.values(h.cups).some((c) => c.bestPlace <= 3),
  },
];

const BY_ID = new Map<LiveryId, LiveryDef>(LIVERIES.map((l) => [l.id, l]));

export const isLiveryId = (v: unknown): v is LiveryId => typeof v === 'string' && BY_ID.has(v as LiveryId);

export function liveryById(id: LiveryId): LiveryDef {
  const l = BY_ID.get(id);
  if (!l) throw new Error(`Unknown livery ${id}`);
  return l;
}

/** Liveries every player owns from the start. */
export const STARTER_LIVERIES: LiveryId[] = LIVERIES.filter((l) => l.start).map((l) => l.id);

/** Liveries a finished race earns (already-owned ones included; the caller filters). */
export function unlocksForRace(c: RaceUnlockContext): LiveryId[] {
  return LIVERIES.filter((l) => l.race?.(c)).map((l) => l.id);
}

export function unlocksForCup(c: CupUnlockContext): LiveryId[] {
  return LIVERIES.filter((l) => l.cup?.(c)).map((l) => l.id);
}

export function unlocksFromHistory(h: UnlockHistory): LiveryId[] {
  return LIVERIES.filter((l) => l.history?.(h)).map((l) => l.id);
}

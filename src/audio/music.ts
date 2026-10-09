/**
 * Generative procedural music: a seeded 16-bar arrangement (A A B A sections) of drums,
 * bass, chords and lead melody built from a track's tempo/root/scale/style. The player
 * is driven by a lookahead scheduler (`scheduleUntil`) on AudioContext time, so it works
 * both live and inside an OfflineAudioContext.
 *
 * Chicago flavour: four styles get their own arrangers in the city's home-grown genres —
 *   menu, blues (the "Sweet Home Chicago" track) -> "Sweet Home" blues ANTHEM: an original 12-bar shuffle in A with a composed harmonica
 *              head, boogie bass, triplet piano + organ, a stop-time break and a horn-section out-chorus
 *   rock    -> fast Chicago BLUES shuffle for the Chicago Grand Prix (12-bar form, boogie bass,
 *              harmonica call-and-response, organ chops, horn stabs on the final lap)
 *   results -> Chicago HOUSE party (four-on-the-floor, offbeat open hats, piano stabs, deep bass)
 *   snow    -> holiday SWING jazz (walking bass, ride + brushes + sleigh bells, vibes, piano comp)
 */
import type { TrackDef } from '../sim/types';
import { Rng } from '../core/rng';
import { type Ctx, fm, midiToHz, noise, tone } from './synth';

export type ScaleName = TrackDef['music']['scale'];
export type MusicStyle = 'rock' | 'funk' | 'bouncy' | 'kitchen' | 'dogpark' | 'snow' | 'menu' | 'results' | 'blues';
export const MUSIC_STYLES: MusicStyle[] = ['rock', 'funk', 'bouncy', 'kitchen', 'dogpark', 'snow', 'menu', 'results', 'blues'];

export interface MusicSpec {
  style: MusicStyle;
  tempo: number;
  root: number;
  scale: ScaleName;
}

const SCALES: Record<ScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

type DrumKind = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'rim' | 'shaker' | 'sleigh' | 'crash' | 'tom' | 'ride' | 'brush' | 'riser';
type BassInst = 'saw' | 'square' | 'tri' | 'sine' | 'house' | 'upright';
type ChordInst = 'power' | 'stab' | 'pizz' | 'uke' | 'pad' | 'bellpad' | 'brass' | 'piano' | 'organ' | 'jazzpiano';
type LeadInst = 'sawlead' | 'square' | 'xylo' | 'whistle' | 'glock' | 'brass' | 'harp' | 'vibes' | 'organlead';
/** Which arranger builds the song. 'pop' is the original generic A-A-B-A arranger. */
type Form = 'pop' | 'house' | 'blues' | 'swing' | 'anthem';
type BassPat = 'eighths' | 'funk' | 'bouncy' | 'pluck' | 'walk' | 'boomchick';

interface Preset {
  defaults: { tempo: number; root: number; scale: ScaleName };
  kick: string;
  snare: string;
  hat: string;
  snareInst: 'snare' | 'clap' | 'rim';
  hatInst: 'hat' | 'shaker' | 'sleigh';
  swing: number;
  bass: BassInst;
  bassPat: BassPat;
  chord: ChordInst;
  chordSteps: number[]; // onset steps within a bar for rhythmic chord instruments
  lead: LeadInst;
  leadMaxLen: number; // max steps per lead note (staccato styles small)
  rhythms: string[]; // lead rhythm templates (16 chars)
  progA: number[][];
  progB: number[][];
  extraPerc?: DrumKind; // layer added at higher intensity
  form?: Form;
  /** delay (in 16th steps) of the off-beat 8ths (steps 2, 6, 10, 14): ~0.67 = triplet shuffle/swing */
  shuffle?: number;
  /** output trim so the busier Chicago grooves sit at the same loudness as the other styles */
  level?: number;
}

const P: Record<MusicStyle, Preset> = {
  // Chicago Grand Prix: a driving Chicago blues shuffle (see Arranger.buildBlues)
  rock: {
    defaults: { tempo: 148, root: 60, scale: 'major' },
    kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'hat', swing: 0, shuffle: 0.62, form: 'blues',
    bass: 'upright', bassPat: 'walk', chord: 'organ', chordSteps: [4, 12], lead: 'harp', leadMaxLen: 8,
    rhythms: ['x.x.x...x.x.x...'],
    progA: [[0, 3, 0, 0]], progB: [[4, 3, 0, 4]], extraPerc: 'ohat',
  },
  funk: {
    defaults: { tempo: 112, root: 57, scale: 'dorian' },
    kick: 'x..x..x...x..x..', snare: '....x..x.x..x...', hat: 'xxxxxxxxxxxxxxxx',
    snareInst: 'snare', hatInst: 'hat', swing: 0.12,
    bass: 'square', bassPat: 'funk', chord: 'stab', chordSteps: [2, 7, 10, 14], lead: 'square', leadMaxLen: 3,
    rhythms: ['x..x..x...x.x...', '.x.x..x.x..x..x.', 'x.x..x.x..x.....', 'x..x.x...xx.x...'],
    progA: [[0, 0, 3, 3], [0, 3, 0, 4]], progB: [[3, 4, 0, 0], [1, 4, 0, 6]], extraPerc: 'clap',
  },
  bouncy: {
    defaults: { tempo: 132, root: 62, scale: 'major' },
    kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.',
    snareInst: 'clap', hatInst: 'hat', swing: 0.08,
    bass: 'tri', bassPat: 'bouncy', chord: 'stab', chordSteps: [2, 6, 10, 14], lead: 'square', leadMaxLen: 4,
    rhythms: ['x.x.x.x.x...x...', 'x..x..x.x.x.x...', 'x.x...x.x.x.x.x.', 'x...x.x...x.x...'],
    progA: [[0, 5, 3, 4], [0, 3, 4, 0]], progB: [[3, 0, 4, 5], [3, 4, 5, 4]], extraPerc: 'shaker',
  },
  kitchen: {
    defaults: { tempo: 126, root: 65, scale: 'mixolydian' },
    kick: 'x.....x...x.....', snare: '....x.......x..x', hat: 'xxxxxxxxxxxxxxxx',
    snareInst: 'rim', hatInst: 'shaker', swing: 0.1,
    bass: 'tri', bassPat: 'pluck', chord: 'pizz', chordSteps: [0, 2, 4, 6, 8, 10, 12, 14], lead: 'xylo', leadMaxLen: 2,
    rhythms: ['x.x.xx..x.x.x...', 'x.xx.x..x.x.xx..', 'xx.x.x.xx.x.x...', 'x..xx.x.x..xx.x.'],
    progA: [[0, 3, 4, 0], [0, 1, 4, 0]], progB: [[5, 3, 4, 4], [3, 3, 0, 4]], extraPerc: 'tom',
  },
  dogpark: {
    defaults: { tempo: 120, root: 64, scale: 'major' },
    kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.',
    snareInst: 'clap', hatInst: 'shaker', swing: 0.18,
    bass: 'tri', bassPat: 'walk', chord: 'uke', chordSteps: [0, 4, 6, 10, 12, 14], lead: 'whistle', leadMaxLen: 6,
    rhythms: ['x...x.x.x.......', 'x.x.x...x..x....', 'x..x..x.x.x.....', '..x.x.x.x...x...'],
    progA: [[0, 3, 0, 4], [0, 5, 1, 4]], progB: [[3, 3, 0, 0], [3, 4, 0, 5]], extraPerc: 'hat',
  },
  // Chicago Snowpocalypse: holiday swing — walking bass, ride + brushes + sleigh bells, vibes (Arranger.buildSwing)
  snow: {
    defaults: { tempo: 138, root: 62, scale: 'major' },
    kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'sleigh', swing: 0, shuffle: 0.6, form: 'swing',
    bass: 'upright', bassPat: 'walk', chord: 'jazzpiano', chordSteps: [0, 6], lead: 'vibes', leadMaxLen: 4,
    rhythms: ['x.x.x...x.x.x...', 'x.x.x.x.x...x...', 'x...x.x.x.x.x...', 'x.xxx.x.x.......'],
    progA: [[0, 5, 3, 4], [0, 3, 1, 4]], progB: [[3, 4, 2, 5], [3, 0, 1, 4]], extraPerc: 'ohat',
  },
  // Main menu: the "Sweet Home Chicago!" blues anthem (Arranger.buildAnthem) — original melody
  menu: {
    defaults: { tempo: 112, root: 57, scale: 'major' },
    kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'hat', swing: 0, shuffle: 0.64, form: 'anthem', level: 0.9,
    bass: 'upright', bassPat: 'walk', chord: 'piano', chordSteps: [2, 6, 10, 14], lead: 'harp', leadMaxLen: 8,
    rhythms: ['x.x.x...x.x.x...'],
    progA: [[0, 3, 0, 0]], progB: [[4, 3, 0, 4]], extraPerc: 'ohat',
  },
  // "Sweet Home Chicago" track: the same original anthem, played in the track's key/tempo (E, 124 by data)
  blues: {
    defaults: { tempo: 120, root: 64, scale: 'mixolydian' },
    kick: 'x.....x.x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'hat', swing: 0, shuffle: 0.62, form: 'anthem', level: 0.9,
    bass: 'upright', bassPat: 'walk', chord: 'piano', chordSteps: [2, 6, 10, 14], lead: 'harp', leadMaxLen: 8,
    rhythms: ['x.x.x...x.x.x...'],
    progA: [[0, 3, 0, 0]], progB: [[4, 3, 0, 4]], extraPerc: 'ohat',
  },
  // Results / podium: a Chicago HOUSE party (Arranger.buildHouse)
  results: {
    defaults: { tempo: 124, root: 60, scale: 'major' },
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.',
    snareInst: 'clap', hatInst: 'hat', swing: 0.1, form: 'house', level: 0.78,
    bass: 'house', bassPat: 'bouncy', chord: 'piano', chordSteps: [3, 6, 10, 13], lead: 'organlead', leadMaxLen: 3,
    rhythms: ['x..x..x...x.....', '..x..x..x.......', 'x..x..x.x.......', '....x..x..x.x...'],
    progA: [[0, 5, 1, 4], [5, 3, 0, 4]], progB: [[3, 4, 2, 5], [1, 4, 0, 5]], extraPerc: 'shaker',
  },
};

/** Map anything the game passes to startMusic onto a concrete spec. */
export function resolveMusic(arg: unknown): MusicSpec {
  let style: MusicStyle = 'bouncy';
  let tempo: number | undefined;
  let root: number | undefined;
  let scale: ScaleName | undefined;
  let raw = '';
  if (typeof arg === 'string') raw = arg;
  else if (arg && typeof arg === 'object') {
    const a = arg as Partial<TrackDef['music']>;
    raw = typeof a.style === 'string' ? a.style : '';
    if (typeof a.tempo === 'number' && a.tempo > 40 && a.tempo < 260) tempo = a.tempo;
    if (typeof a.root === 'number' && isFinite(a.root)) root = a.root;
    if (a.scale && a.scale in SCALES) scale = a.scale;
  }
  style = styleFromString(raw);
  const d = P[style].defaults;
  return { style, tempo: tempo ?? d.tempo, root: root ?? d.root, scale: scale ?? d.scale };
}

function styleFromString(s: string): MusicStyle {
  const k = s.toLowerCase();
  if ((MUSIC_STYLES as string[]).includes(k)) return k as MusicStyle;
  if (/blues|boogie|shuffle|sweet ?home|anthem|harmonica/.test(k)) return 'blues';
  if (/rock|chicago|city|metal|punk/.test(k)) return 'rock';
  if (/funk|suburb|groove|disco/.test(k)) return 'funk';
  if (/kitchen|pizz|xylo|quirk|cook/.test(k)) return 'kitchen';
  if (/dog|park|uke|whistle|picnic/.test(k)) return 'dogpark';
  if (/snow|winter|holiday|sleigh|xmas|christmas|ice/.test(k)) return 'snow';
  if (/result|victory|win|podium|award/.test(k)) return 'results';
  if (/menu|title|lobby/.test(k)) return 'menu';
  return 'bouncy';
}

// ---------------------------------------------------------------------------------------
// Arrangement generation

interface Ev {
  k: DrumKind | 'bass' | 'chord' | 'lead' | 'arp';
  m?: number[]; // midi note(s)
  len: number; // steps
  v: number; // velocity 0..1
  minI: number; // minimum intensity to play
  i?: string; // instrument override (else the preset's bass/chord/lead instrument)
  bend?: boolean; // lead: scoop up into the note from a semitone below (harmonica / blue note)
}

const BARS = 16;
const STEPS = BARS * 16;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface MotifNote { step: number; deg: number; len: number }

class Arranger {
  readonly scale: number[];
  readonly root: number; // normalized root ~57..68
  readonly pre: Preset;
  readonly rng: Rng;
  constructor(public spec: MusicSpec) {
    this.scale = SCALES[spec.scale];
    let r = Math.round(spec.root);
    r = ((r % 12) + 12) % 12;
    this.root = r < 9 ? 60 + r : 48 + r; // keep root within 57..68
    this.pre = P[spec.style];
    this.rng = new Rng(hashStr(`${spec.style}|${spec.root}|${spec.tempo}|${spec.scale}`));
  }

  deg2midi(deg: number): number {
    const o = Math.floor(deg / 7);
    return this.root + o * 12 + this.scale[((deg % 7) + 7) % 7];
  }

  chordTones(chordDeg: number): number[] {
    return [chordDeg, chordDeg + 2, chordDeg + 4];
  }

  snapToChord(deg: number, chordDeg: number): number {
    let best = deg;
    let bd = 99;
    for (let d = deg - 3; d <= deg + 3; d++) {
      const rel = (((d - chordDeg) % 7) + 7) % 7;
      if (rel === 0 || rel === 2 || rel === 4) {
        const dist = Math.abs(d - deg);
        if (dist < bd) { bd = dist; best = d; }
      }
    }
    return best;
  }

  genMotif(rng: Rng, chords: number[], baseDeg: number, rhythms: string[]): MotifNote[] {
    const notes: MotifNote[] = [];
    let deg = baseDeg + chords[0];
    for (let bar = 0; bar < 2; bar++) {
      const rh = rhythms[bar];
      const onsets: number[] = [];
      for (let s = 0; s < 16; s++) if (rh[s] === 'x') onsets.push(s);
      if (onsets.length === 0) onsets.push(0);
      onsets.forEach((s, i) => {
        const steps = [-2, -1, -1, 1, 1, 2, 0, 3, -3];
        deg += rng.pick(steps);
        deg = Math.max(baseDeg - 2, Math.min(baseDeg + 9, deg));
        const chord = chords[bar];
        if (s % 4 === 0 || (bar === 1 && i === onsets.length - 1)) deg = this.snapToChord(deg, chord);
        const next = i + 1 < onsets.length ? onsets[i + 1] : 16;
        let len = Math.min(next - s, this.pre.leadMaxLen);
        if (bar === 1 && i === onsets.length - 1) len = Math.max(len, Math.min(4, this.pre.leadMaxLen));
        notes.push({ step: bar * 16 + s, deg, len });
      });
    }
    return notes;
  }

  build(): Ev[][] {
    if (this.pre.form === 'house') return this.buildHouse();
    if (this.pre.form === 'blues') return this.buildBlues();
    if (this.pre.form === 'swing') return this.buildSwing();
    if (this.pre.form === 'anthem') return this.buildAnthem();
    return this.buildPop();
  }

  /** Voice a chord (semitone intervals over a root) into roughly 58..74. */
  private voice(rootMidi: number, ivs: number[]): number[] {
    return ivs.map((iv) => {
      let m = rootMidi + iv;
      while (m > 74) m -= 12;
      while (m < 58) m += 12;
      return m;
    }).sort((a, b) => a - b);
  }

  /** Chicago house: kick on every beat, clap on 2 & 4, offbeat open hats, 7th-chord piano stabs, deep offbeat bass. */
  private buildHouse(): Ev[][] {
    const rng = this.rng;
    const pre = this.pre;
    const steps: Ev[][] = Array.from({ length: STEPS }, () => []);
    const progA = rng.pick(pre.progA);
    const progB = rng.pick(pre.progB);
    const sections = [progA, progA, progB, progA];
    const chordOfBar = (bar: number) => sections[Math.floor(bar / 4)][bar % 4];
    const stabA = rng.pick(['...x..x...x..x..', '..x..x...x..x...', 'x..x..x...x..x..']);
    const stabB = rng.pick(['...x..x...x.x...', '..x..x..x..x..x.', '...x..x..x....x.']);
    // organ hook: a 2-bar motif, played in the B section and (at higher intensity) everywhere
    const hookR = [rng.pick(pre.rhythms), rng.pick(pre.rhythms)];
    const hook = this.genMotif(new Rng(rng.int(1e9)), [progB[0], progB[1]], 7, hookR);
    const hookA = this.genMotif(new Rng(rng.int(1e9)), [progA[0], progA[1]], 7, hookR);
    for (let bar = 0; bar < BARS; bar++) {
      const base = bar * 16;
      const chord = chordOfBar(bar);
      const add = (s: number, e: Ev) => steps[base + s].push(e);
      const breakdown = bar === 7 || bar === 15; // drop the kick for the last two beats before a new section
      for (let s = 0; s < 16; s++) {
        if (s % 4 === 0 && !(breakdown && s >= 8)) add(s, { k: 'kick', len: 1, v: s === 0 ? 1 : 0.92, minI: 0 });
        if (s === 4 || s === 12) add(s, { k: 'clap', len: 1, v: 0.9, minI: 0 });
        if (s % 4 === 2) add(s, { k: 'ohat', len: 1, v: 0.9, minI: 0 });
        if (s % 2 === 1) add(s, { k: 'hat', len: 1, v: s % 4 === 3 ? 0.55 : 0.4, minI: 0 });
        else if (s % 4 === 0) add(s, { k: 'hat', len: 1, v: 0.35, minI: 0.4 });
      }
      if (bar % 4 === 1 || bar % 4 === 3) for (const s of [6, 14]) add(s, { k: 'shaker', len: 1, v: 0.8, minI: 0 });
      if (bar % 8 === 0) add(0, { k: 'crash', len: 1, v: 0.8, minI: 0 });
      if (bar % 8 === 7) add(0, { k: 'riser', len: 16, v: 1, minI: 0 });
      if (breakdown) for (const s of [12, 13, 14, 15]) add(s, { k: 'clap', len: 1, v: 0.45 + (s - 12) * 0.15, minI: 0 });
      // deep house bass: offbeat-heavy with an octave jump
      const r = this.deg2midi(chord) - 24;
      const fifth = this.deg2midi(chord + 4) - 24;
      const bass: Array<[number, number, number, number]> = [[2, r, 2, 1], [5, r, 1, 0.75], [6, r + 12, 1, 0.85], [10, r, 2, 1], [13, r, 1, 0.75], [14, fifth, 2, 0.9]];
      for (const [s, m, len, v] of bass) add(s, { k: 'bass', m: [m], len, v, minI: 0 });
      // classic house piano: 7th chords stabbed on the off-beats
      const ivs = [0, 2, 4, 6].map((d) => this.deg2midi(chord + d) - this.deg2midi(chord));
      const voiced = this.voice(this.deg2midi(chord), ivs);
      const stab = bar % 2 === 0 ? stabA : stabB;
      for (let s = 0; s < 16; s++) if (stab[s] === 'x') add(s, { k: 'chord', m: voiced, len: 2, v: s % 4 === 0 ? 0.95 : 0.85, minI: 0 });
      // arp sparkle at higher intensity
      for (let s = 0; s < 16; s += 2) add(s, { k: 'arp', m: [voiced[(s / 2) % voiced.length] + 12], len: 1, v: 0.45, minI: 0.45 });
    }
    const placeHook = (motif: MotifNote[], startBar: number, minI: number, vel: number) => {
      for (const n of motif) {
        const bar = startBar + Math.floor(n.step / 16);
        const deg = n.step % 4 === 0 ? this.snapToChord(n.deg, chordOfBar(bar)) : n.deg;
        steps[startBar * 16 + n.step].push({ k: 'lead', m: [this.deg2midi(deg)], len: n.len, v: vel, minI });
      }
    };
    placeHook(hook, 8, 0, 0.9);
    placeHook(hook, 10, 0, 0.9);
    placeHook(hookA, 12, 0.3, 0.8);
    placeHook(hookA, 14, 0.3, 0.8);
    placeHook(hookA, 4, 0.6, 0.75);
    placeHook(hookA, 6, 0.6, 0.75);
    return steps;
  }

  /**
   * Chicago blues shuffle: two 12-bar choruses (I-IV-I-I / IV-IV-I-I / V-IV-I-V) with a boogie-woogie
   * walking bass, organ "chops" on 2 & 4, and a harmonica playing call-and-response riffs.
   * Off-beat 8ths are pushed late by the preset's `shuffle` for the triplet feel.
   */
  private buildBlues(): Ev[][] {
    const rng = this.rng;
    const bars = 24;
    const steps: Ev[][] = Array.from({ length: bars * 16 }, () => []);
    const form = [0, 5, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7]; // chord roots in semitones (quick-change 12-bar)
    const key = this.root; // ~57..68: harmonica riffs sit right here
    // harmonica riffs over the I chord: [step, semitones above key, length, bend]
    type Riff = Array<[number, number, number, number?]>;
    const calls: Riff[] = [
      [[0, 7, 2], [2, 10, 2], [4, 12, 6, 1], [12, 10, 2], [14, 7, 2], [16, 3, 2, 1], [18, 0, 6]],
      [[0, 12, 2], [2, 12, 2], [4, 10, 2], [6, 12, 4, 1], [12, 15, 2], [14, 12, 2], [16, 10, 2], [18, 7, 2], [20, 10, 2], [22, 7, 2], [24, 3, 4, 1], [28, 0, 4]],
      [[2, 7, 2], [4, 7, 2], [6, 10, 2], [8, 7, 4], [14, 3, 2, 1], [16, 0, 8]],
      [[0, 0, 2], [2, 3, 2, 1], [4, 5, 2], [6, 6, 2], [8, 7, 6], [16, 10, 2], [18, 7, 2], [20, 5, 2], [22, 3, 2, 1], [24, 0, 6]],
    ];
    const answers: Riff[] = [
      [[4, 12, 2], [6, 10, 2], [8, 7, 6]],
      [[2, 3, 2, 1], [4, 0, 6]],
      [[0, 15, 2, 1], [2, 12, 8]],
      [[6, 7, 2], [8, 10, 2], [10, 12, 4, 1]],
    ];
    // turnaround line over V-IV-I-V
    const turn: Riff = [[0, 14, 4, 1], [4, 12, 2], [6, 10, 2], [8, 7, 8], [16, 12, 4], [20, 10, 2], [22, 9, 2], [24, 5, 8],
      [32, 12, 2], [34, 11, 2], [36, 10, 2], [38, 9, 2], [40, 7, 8], [48, 7, 2], [50, 7, 2], [52, 11, 2], [54, 14, 8]];
    const putRiff = (riff: Riff, startBar: number, vel: number, oct = 0, minI = 0) => {
      for (const [st, semi, len, bend] of riff) {
        const at = startBar * 16 + st;
        if (at >= steps.length) continue;
        steps[at].push({ k: 'lead', m: [key + semi + oct], len, v: vel * (st % 4 === 0 ? 1 : 0.88), minI, bend: !!bend });
        // final lap: an organ doubles the harp an octave down
        steps[at].push({ k: 'lead', m: [key + semi + oct - 12], len, v: vel * 0.55, minI: 0.75, i: 'organlead' });
      }
    };
    for (let chorus = 0; chorus < 2; chorus++) {
      const b0 = chorus * 12;
      const call = calls[(rng.int(calls.length) + chorus) % calls.length];
      // AAB: the same riff over the I and the IV, then the turnaround
      putRiff(call, b0, 0.95, chorus === 1 ? 12 : 0);
      putRiff(rng.pick(answers), b0 + 2, 0.8, chorus === 1 ? 12 : 0);
      putRiff(call, b0 + 4, 0.95, chorus === 1 ? 12 : 0);
      putRiff(rng.pick(answers), b0 + 6, 0.8, chorus === 1 ? 12 : 0);
      putRiff(turn, b0 + 8, 0.95);
    }
    for (let bar = 0; bar < bars; bar++) {
      const base = bar * 16;
      const add = (s: number, e: Ev) => steps[base + s].push(e);
      const formBar = bar % 12;
      const croot = key + form[formBar];
      const nextRoot = key + form[(formBar + 1) % 12];
      const lastOfChorus = formBar === 11;
      // ---- shuffle drums: ride on every 8th, backbeat on 2 & 4, kick on 1 & 3 (+ the swung "and" of 2)
      for (let s = 0; s < 16; s += 2) add(s, { k: 'hat', len: 1, v: s % 4 === 0 ? 0.95 : 0.6, minI: 0 });
      add(0, { k: 'kick', len: 1, v: 1, minI: 0 });
      add(8, { k: 'kick', len: 1, v: 0.9, minI: 0 });
      add(6, { k: 'kick', len: 1, v: 0.55, minI: 0 });
      add(14, { k: 'kick', len: 1, v: 0.6, minI: 0.6 });
      if (!(lastOfChorus && bar === bars - 1)) {
        add(4, { k: 'snare', len: 1, v: 1, minI: 0 });
        add(12, { k: 'snare', len: 1, v: 1, minI: 0 });
      }
      add(10, { k: 'rim', len: 1, v: 0.5, minI: 0.4 });
      if (formBar === 0) add(0, { k: 'crash', len: 1, v: 0.85, minI: 0 });
      if (lastOfChorus) {
        // turnaround fill: snare/tom triplet-ish pickup
        for (const [s, k, v] of [[10, 'snare', 0.6], [12, 'tom', 0.75], [14, 'tom', 0.85]] as Array<[number, DrumKind, number]>) add(s, { k, m: [s], len: 1, v, minI: 0 });
      }
      // ---- boogie-woogie bass: root 3 5 6 b7 6 5 3 in shuffled 8ths
      const walk = [0, 4, 7, 9, 10, 9, 7, 4];
      walk.forEach((iv, j) => {
        let m = croot + iv - 24;
        if (j === 7 && nextRoot !== croot) m = nextRoot - 24 + (nextRoot > croot ? -1 : 1); // lead into the change
        add(j * 2, { k: 'bass', m: [m], len: 2, v: j % 2 === 0 ? 1 : 0.8, minI: 0 });
      });
      // ---- organ chops on 2 & 4 (dominant 7ths)
      const v7 = this.voice(croot, [0, 4, 7, 10]);
      add(4, { k: 'chord', m: v7, len: 2, v: 0.85, minI: 0 });
      add(12, { k: 'chord', m: v7, len: 2, v: 0.85, minI: 0 });
      add(14, { k: 'chord', m: v7, len: 1, v: 0.5, minI: 0.4 });
      // ---- horn section stabs at higher intensity (final lap)
      if (formBar % 2 === 0) add(0, { k: 'chord', m: v7.map((m) => m + 12), len: 3, v: 0.75, minI: 0.6, i: 'brass' });
      if (formBar % 4 === 3) add(14, { k: 'chord', m: v7.map((m) => m + 12), len: 2, v: 0.7, minI: 0.6, i: 'brass' });
    }
    return steps;
  }

  /**
   * "Sweet Home Chicago!" menu anthem — an ORIGINAL 12-bar blues shuffle in the track key (A by default).
   * Three choruses (36 bars): 1) the harmonica head over the full band, 2) a stop-time break (band hits on
   * beat one only) with harp fills, then the band kicks back in, 3) the head again with the horn section.
   */
  private buildAnthem(): Ev[][] {
    const rng = this.rng;
    const choruses = 3;
    const steps: Ev[][] = Array.from({ length: choruses * 12 * 16 }, () => []);
    const form = [0, 5, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7];
    const key = this.root;
    const harp = key + 12 > 72 ? key : key + 12; // keep the harmonica head in a bright-but-friendly register
    type Riff = Array<[number, number, number, number?]>; // [step from chorus start, semitones, len, bend]
    const call: Riff = [[0, 7, 2], [2, 10, 2], [4, 12, 4, 1], [10, 10, 2], [12, 12, 2], [14, 15, 2, 1], [16, 12, 6], [24, 10, 2], [26, 7, 2], [28, 10, 4]];
    const head: Riff = [
      ...call,
      [36, 7, 2], [38, 5, 2], [40, 3, 4, 1], [44, 0, 10],
      ...call.map(([st, n, l, b]) => [st + 64, n, l, b] as [number, number, number, number?]),
      [96, 15, 2, 1], [98, 12, 2], [100, 10, 2], [102, 12, 6], [112, 7, 10],
    ];
    const line3: Riff = [[128, 14, 4], [132, 12, 2], [134, 11, 2], [136, 14, 6], [144, 12, 4], [148, 9, 2], [150, 10, 2], [152, 12, 8],
      [160, 7, 2], [162, 9, 2], [164, 12, 4, 1], [170, 10, 2], [172, 7, 4], [176, 4, 2], [178, 7, 2], [180, 11, 2], [182, 14, 8]];
    // stop-time fills (each fits in the three beats after a band hit): [step in bar, semitones, len, bend]
    const fills: Riff[] = [
      [[4, 12, 2], [6, 15, 2, 1], [8, 12, 2], [10, 10, 2], [12, 7, 4]],
      [[4, 7, 2], [6, 10, 2], [8, 12, 6, 1]],
      [[4, 15, 2, 1], [6, 12, 2], [8, 10, 2], [10, 9, 2], [12, 7, 4]],
      [[4, 3, 2, 1], [6, 5, 2], [8, 6, 2], [10, 7, 6]],
    ];
    const lead = (at: number, semi: number, len: number, v: number, bend: boolean, minI = 0) => {
      if (at >= steps.length) return;
      steps[at].push({ k: 'lead', m: [harp + semi], len, v: v * (at % 4 === 0 ? 1 : 0.88), minI, bend });
    };
    const putRiff = (riff: Riff, base: number, v: number, organ = false) => {
      for (const [st, n, l, b] of riff) {
        lead(base + st, n, l, v, !!b);
        if (organ) steps[base + st]?.push({ k: 'lead', m: [harp + n - 12], len: l, v: v * 0.5, minI: 0, i: 'organlead' });
      }
    };
    for (let c = 0; c < choruses; c++) {
      const cb = c * 192;
      if (c === 1) {
        // stop-time: four bars of fills, then improvised answers and the composed turnaround
        for (let b = 0; b < 4; b++) putRiff(fills[(b + rng.int(fills.length)) % fills.length].map(([st, n, l, bd]) => [st + b * 16, n, l, bd] as [number, number, number, number?]), cb, 0.95);
        putRiff(call.map(([st, n, l, b]) => [st + 64, n + 12 > 15 ? n : n + 12, l, b] as [number, number, number, number?]), cb, 0.9);
        putRiff([[100, 15, 2, 1], [102, 12, 2], [104, 10, 2], [106, 7, 2], [108, 10, 4], [112, 12, 10]], cb, 0.9);
        putRiff(line3, cb, 0.95);
      } else {
        putRiff(head, cb, 0.95, c === 2);
        putRiff(line3, cb, 0.95, c === 2);
      }
    }
    for (let bar = 0; bar < choruses * 12; bar++) {
      const base = bar * 16;
      const add = (s: number, e: Ev) => steps[base + s].push(e);
      const chorus = Math.floor(bar / 12);
      const fb = bar % 12;
      const croot = key + form[fb];
      const nextRoot = key + form[(fb + 1) % 12];
      const v7 = this.voice(croot, [0, 4, 7, 10]);
      const stop = chorus === 1 && fb < 4;
      const horns = chorus === 2;
      if (stop) {
        // band hit on beat one; ticking hi-hat keeps time; pickup on the "and" of four into bar 5
        add(0, { k: 'kick', len: 1, v: 1, minI: 0 });
        add(0, { k: 'snare', len: 1, v: 0.9, minI: 0 });
        add(0, { k: 'crash', len: 1, v: 0.6, minI: 0 });
        add(0, { k: 'bass', m: [croot - 24], len: 3, v: 1, minI: 0 });
        add(0, { k: 'chord', m: v7, len: 3, v: 1, minI: 0 });
        add(0, { k: 'chord', m: v7.map((m) => m + 12), len: 3, v: 0.8, minI: 0, i: 'brass' });
        for (const s of [4, 8, 12]) add(s, { k: 'hat', len: 1, v: 0.5, minI: 0 });
        if (fb === 3) for (const s of [12, 14]) { add(s, { k: 'snare', len: 1, v: 0.6 + (s - 12) * 0.15, minI: 0 }); add(s, { k: 'chord', m: v7, len: 1, v: 0.8, minI: 0 }); }
        continue;
      }
      // ---- shuffle drums
      for (let s = 0; s < 16; s += 2) add(s, { k: 'hat', len: 1, v: s % 4 === 0 ? 0.9 : 0.55, minI: 0 });
      add(0, { k: 'kick', len: 1, v: 1, minI: 0 });
      add(6, { k: 'kick', len: 1, v: 0.5, minI: 0 });
      add(8, { k: 'kick', len: 1, v: 0.9, minI: 0 });
      add(4, { k: 'snare', len: 1, v: 0.95, minI: 0 });
      add(12, { k: 'snare', len: 1, v: 0.95, minI: 0 });
      if (fb === 0) add(0, { k: 'crash', len: 1, v: chorus === 0 ? 0.6 : 0.85, minI: 0 });
      if (fb === 11) for (const [s, k, v] of [[10, 'snare', 0.6], [12, 'tom', 0.75], [14, 'tom', 0.85]] as Array<[number, DrumKind, number]>) add(s, { k, m: [s], len: 1, v, minI: 0 });
      // ---- boogie bass (root 3 5 6 b7 6 5 3), leading into each chord change
      [0, 4, 7, 9, 10, 9, 7, 4].forEach((iv, j) => {
        let m = croot + iv - 24;
        if (j === 7 && nextRoot !== croot) m = nextRoot - 24 + (nextRoot > croot ? -1 : 1);
        add(j * 2, { k: 'bass', m: [m], len: 2, v: j % 2 === 0 ? 1 : 0.8, minI: 0 });
      });
      // ---- triplet piano on the swung off-beats + a soft held organ chord
      for (const s of [2, 6, 10, 14]) add(s, { k: 'chord', m: v7, len: 1, v: s === 6 || s === 14 ? 0.7 : 0.55, minI: 0 });
      add(0, { k: 'chord', m: this.voice(croot, [4, 10, 7]), len: 15, v: 0.35, minI: 0, i: 'organ' });
      // ---- horn section: out-chorus always, otherwise at higher intensity
      const hornMin = horns ? 0 : 0.6;
      if (fb % 2 === 0) add(0, { k: 'chord', m: v7.map((m) => m + 12), len: 3, v: 0.7, minI: hornMin, i: 'brass' });
      if (fb % 4 === 3) add(14, { k: 'chord', m: v7.map((m) => m + 12), len: 2, v: 0.65, minI: hornMin, i: 'brass' });
    }
    return steps;
  }

  /**
   * Holiday swing: 16 bars of 7th-chord changes with a walking bass, ride cymbal + brushes + sleigh bells,
   * Charleston piano comping and a vibraphone melody built from chord tones and chromatic approaches.
   */
  private buildSwing(): Ev[][] {
    const rng = this.rng;
    const steps: Ev[][] = Array.from({ length: STEPS }, () => []);
    const Q: Record<string, number[]> = { M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], m6: [0, 3, 7, 9], '6': [0, 4, 7, 9], m7b5: [0, 3, 6, 10] };
    const minor = this.spec.scale === 'minor' || this.spec.scale === 'dorian';
    const prog: Array<[number, string]> = minor
      ? [[0, 'm7'], [5, 'm7'], [10, '7'], [3, 'M7'], [8, 'M7'], [2, 'm7b5'], [7, '7'], [0, 'm6'],
        [0, 'm7'], [5, 'm7'], [10, '7'], [3, 'M7'], [8, 'M7'], [2, 'm7b5'], [7, '7'], [7, '7']]
      : [[0, 'M7'], [9, 'm7'], [2, 'm7'], [7, '7'], [4, 'm7'], [9, '7'], [2, 'm7'], [7, '7'],
        [5, 'M7'], [5, 'm6'], [4, 'm7'], [9, '7'], [2, 'm7'], [7, '7'], [0, '6'], [7, '7']];
    const key = this.root;
    const rhythms = ['x.x.x...x.x.....', 'x...x.x.x...x...', '..x.x.x.x.......', 'x.x...x.x.x.x...', 'x...x...x.x.x.x.', '..x...x.x...x...'];
    let prev = key + 12 + (minor ? 3 : 4);
    let phraseR = rng.pick(rhythms);
    for (let bar = 0; bar < BARS; bar++) {
      const base = bar * 16;
      const add = (s: number, e: Ev) => steps[base + s].push(e);
      const [off, q] = prog[bar];
      const croot = key + off;
      const tones = Q[q].map((iv) => croot + iv);
      const [nOff] = prog[(bar + 1) % BARS];
      const nextRoot = key + nOff;
      // ---- drums: spang-a-lang ride, hat foot on 2 & 4, brushes, feathered kick, sleigh bells
      for (const [s, v] of [[0, 0.75], [4, 1], [6, 0.6], [8, 0.75], [12, 1], [14, 0.6]] as Array<[number, number]>) add(s, { k: 'ride', len: 1, v, minI: 0 });
      for (const s of [4, 12]) {
        add(s, { k: 'hat', len: 1, v: 0.7, minI: 0 });
        add(s, { k: 'brush', len: 1, v: 0.9, minI: 0 });
      }
      for (const s of [0, 4, 8, 12]) {
        add(s, { k: 'kick', len: 1, v: 0.38, minI: 0 });
        add(s, { k: 'sleigh', len: 1, v: s % 8 === 0 ? 0.9 : 0.7, minI: 0 });
      }
      for (const s of [2, 6, 10, 14]) add(s, { k: 'sleigh', len: 1, v: 0.45, minI: 0.4 });
      if (bar % 4 === 3) for (const [s, v] of [[10, 0.5], [14, 0.8]] as Array<[number, number]>) add(s, { k: 'snare', len: 1, v, minI: 0 });
      else if (rng.chance(0.4)) add(14, { k: 'rim', len: 1, v: 0.6, minI: 0 });
      if (bar % 8 === 0) add(0, { k: 'crash', len: 1, v: 0.55, minI: 0 });
      // ---- walking bass: root, chord tone, chord tone, chromatic approach to the next root
      const lo = (m: number) => { let x = m - 24; while (x < 36) x += 12; while (x > 52) x -= 12; return x; };
      const r = lo(croot);
      const b2 = lo(tones[rng.pick([1, 2])]);
      const b3 = lo(tones[rng.pick([2, 3, 1])]);
      const nr = lo(nextRoot);
      const b4 = nr + (rng.chance(0.5) ? -1 : 1);
      [r, b2, b3, b4].forEach((m, j) => add(j * 4, { k: 'bass', m: [m], len: 4, v: j === 0 ? 1 : 0.85, minI: 0 }));
      // ---- Charleston piano comp: rootless voicing (3, 7, 9, 5)
      const comp = this.voice(croot, [Q[q][1], Q[q][3], 14, Q[q][2]]);
      add(0, { k: 'chord', m: comp, len: 3, v: 0.8, minI: 0 });
      add(6, { k: 'chord', m: comp, len: 2, v: 0.7, minI: 0 });
      if (bar % 2 === 1) add(14, { k: 'chord', m: comp, len: 2, v: 0.55, minI: 0.3 });
      // ---- vibes melody: chord tones on the beat, chromatic approach notes on swung offbeats
      if (bar % 4 === 0 || (bar % 2 === 0 && rng.chance(0.5))) phraseR = rng.pick(rhythms);
      const rh = bar % 4 === 3 ? 'x...x...x.......' : phraseR;
      const pool: number[] = [];
      for (const t of tones) for (const o of [0, 12, 24]) { const m = t + o; if (m >= key + 7 && m <= key + 26) pool.push(m); }
      pool.sort((a, b) => a - b);
      for (let s = 0; s < 16; s++) {
        if (rh[s] !== 'x') continue;
        let note: number;
        if (s % 4 === 2 && rng.chance(0.35)) {
          note = prev + (rng.chance(0.5) ? 1 : -1); // chromatic neighbour
        } else {
          const dir = rng.chance(0.5) ? 1 : -1;
          const cands = pool.filter((m) => (dir > 0 ? m > prev : m < prev) && Math.abs(m - prev) <= 7);
          note = cands.length ? (dir > 0 ? cands[0] : cands[cands.length - 1]) : pool.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a), pool[0]);
        }
        let next = 16;
        for (let s2 = s + 1; s2 < 16; s2++) if (rh[s2] === 'x') { next = s2; break; }
        add(s, { k: 'lead', m: [note], len: Math.min(next - s, 4), v: s % 4 === 0 ? 0.95 : 0.8, minI: 0 });
        add(s, { k: 'lead', m: [note + 12], len: Math.min(next - s, 4), v: 0.35, minI: 0.75, i: 'glock' });
        prev = note;
      }
      // celesta sparkle at intensity
      for (let s = 0; s < 16; s += 4) add(s + 2, { k: 'arp', m: [comp[(s / 4) % comp.length] + 12], len: 1, v: 0.5, minI: 0.45 });
    }
    return steps;
  }

  private buildPop(): Ev[][] {
    const rng = this.rng;
    const pre = this.pre;
    const steps: Ev[][] = Array.from({ length: STEPS }, () => []);
    const progA = rng.pick(pre.progA);
    const progB = rng.pick(pre.progB);
    const sections = [progA, progA, progB, progA];
    const chordOfBar = (bar: number) => sections[Math.floor(bar / 4)][bar % 4];

    // Lead rhythms: A motif and B motif
    const rA = [rng.pick(pre.rhythms), rng.pick(pre.rhythms)];
    const rB = [rng.pick(pre.rhythms), rng.pick(pre.rhythms)];
    const motifA = this.genMotif(new Rng(rng.int(1e9)), [progA[0], progA[1]], 7, rA);
    const motifA2 = this.genMotif(new Rng(rng.int(1e9)), [progA[2], progA[3]], 7, [rA[0], rng.pick(pre.rhythms)]);
    const motifB = this.genMotif(new Rng(rng.int(1e9)), [progB[0], progB[1]], 9, rB);
    const motifB2 = this.genMotif(new Rng(rng.int(1e9)), [progB[2], progB[3]], 8, [rB[0], rng.pick(pre.rhythms)]);
    // A'' : like A2 but last note resolves to the tonic
    const placeMotif = (motif: MotifNote[], startBar: number, vel: number, resolve = false) => {
      motif.forEach((n, i) => {
        const bar = startBar + Math.floor(n.step / 16);
        let deg = n.deg;
        if (n.step % 4 === 0) deg = this.snapToChord(deg, chordOfBar(bar));
        if (resolve && i === motif.length - 1) deg = this.snapToChord(7, 0);
        const midi = this.deg2midi(deg);
        const at = startBar * 16 + n.step;
        steps[at].push({ k: 'lead', m: [midi], len: n.len, v: vel * (n.step % 4 === 0 ? 1 : 0.85), minI: 0 });
        // octave doubling at high intensity
        steps[at].push({ k: 'lead', m: [midi + 12], len: n.len, v: vel * 0.35, minI: 0.75 });
      });
    };
    placeMotif(motifA, 0, 0.9);
    placeMotif(motifA2, 2, 0.9);
    placeMotif(motifA, 4, 1);
    placeMotif(motifA2, 6, 1);
    placeMotif(motifB, 8, 1);
    placeMotif(motifB2, 10, 1);
    placeMotif(motifA, 12, 1);
    placeMotif(motifA2, 14, 1, true);

    for (let bar = 0; bar < BARS; bar++) {
      const base = bar * 16;
      const chord = chordOfBar(bar);
      const nextChord = chordOfBar((bar + 1) % BARS);
      const sectionEnd = bar % 4 === 3;
      // ---- drums
      for (let s = 0; s < 16; s++) {
        const at = base + s;
        const fill = sectionEnd && s >= 12;
        if (pre.kick[s] === 'x' && !(fill && s > 12)) steps[at].push({ k: 'kick', len: 1, v: s % 8 === 0 ? 1 : 0.85, minI: 0 });
        if (pre.snare[s] === 'x' && !fill) steps[at].push({ k: pre.snareInst, len: 1, v: 1, minI: 0 });
        if (pre.hat[s] === 'x') steps[at].push({ k: pre.hatInst, len: 1, v: s % 4 === 0 ? 1 : 0.7, minI: 0 });
        else if (s % 2 === 1 || pre.hatInst !== 'hat') {
          // fill in 16ths at higher intensity
          steps[at].push({ k: pre.hatInst === 'hat' ? 'hat' : pre.hatInst, len: 1, v: 0.45, minI: 0.5 });
        }
        if (fill) {
          const kind: DrumKind = pre.extraPerc === 'tom' || rng.chance(0.4) ? 'tom' : 'snare';
          if (s === 12 || s === 14 || rng.chance(0.6)) steps[at].push({ k: kind, m: [s], len: 1, v: 0.55 + (s - 12) * 0.15, minI: 0 });
        }
      }
      if (bar % 8 === 0) steps[base].push({ k: 'crash', len: 1, v: 1, minI: 0 });
      if (pre.extraPerc && pre.extraPerc !== 'tom') {
        for (let s = 2; s < 16; s += 4) steps[base + s].push({ k: pre.extraPerc, len: 1, v: 0.6, minI: 0.4 });
      }
      if (bar % 2 === 1) steps[base + 14].push({ k: 'kick', len: 1, v: 0.7, minI: 0.7 });

      // ---- bass
      const r = this.deg2midi(chord) - 24;
      const fifth = this.deg2midi(chord + 4) - 24;
      const third = this.deg2midi(chord + 2) - 24;
      const nextR = this.deg2midi(nextChord) - 24;
      const bassAdd = (s: number, m: number, len: number, v = 1) => steps[base + s].push({ k: 'bass', m: [m], len, v, minI: 0 });
      switch (pre.bassPat) {
        case 'eighths':
          for (let s = 0; s < 16; s += 2) bassAdd(s, s === 14 ? fifth : s === 12 ? r + 12 : r, 2, s % 4 === 0 ? 1 : 0.8);
          break;
        case 'funk': {
          const pat: [number, number, number][] = [[0, r, 2], [3, r + 12, 1], [6, r, 1], [8, fifth, 2], [10, r, 1], [11, r + 10, 1], [14, r + 12, 1], [15, nextR - 1, 1]];
          for (const [s, m, l] of pat) bassAdd(s, m, l, s === 0 ? 1 : 0.8);
          break;
        }
        case 'bouncy':
          bassAdd(0, r, 3); bassAdd(4, fifth, 2); bassAdd(6, r, 1); bassAdd(8, r + 12, 2); bassAdd(12, fifth, 2); bassAdd(14, third, 2, 0.8);
          break;
        case 'pluck':
          bassAdd(0, r, 1); bassAdd(4, fifth, 1); bassAdd(8, r + 12, 1); bassAdd(12, fifth, 1); bassAdd(14, r, 1, 0.7);
          break;
        case 'walk':
          bassAdd(0, r, 3); bassAdd(4, third, 3); bassAdd(8, fifth, 3); bassAdd(12, nextR + (nextR > r ? -1 : 1), 3, 0.8);
          break;
        case 'boomchick':
          bassAdd(0, r, 4); bassAdd(8, fifth - 12 >= 28 ? fifth - 12 : fifth, 4);
          bassAdd(6, r, 1, 0.6); bassAdd(14, fifth, 1, 0.6);
          break;
      }

      // ---- chords
      const tones = this.chordTones(chord).map((d) => this.deg2midi(d));
      // voice-lead: keep chord tones around 60..72
      const voiced = tones.map((m) => (m > 71 ? m - 12 : m));
      switch (pre.chord) {
        case 'power':
          for (const s of pre.chordSteps) steps[base + s].push({ k: 'chord', m: [r + 24, r + 31, r + 36], len: s === 0 || s === 8 ? 6 : 2, v: 0.9, minI: 0 });
          for (let s = 2; s < 16; s += 4) steps[base + s].push({ k: 'chord', m: [r + 24, r + 31], len: 1, v: 0.5, minI: 0.5 });
          break;
        case 'pizz': {
          const arp = [voiced[0], voiced[1], voiced[2], voiced[1] + 12 > 79 ? voiced[1] : voiced[0] + 12];
          pre.chordSteps.forEach((s, i) => steps[base + s].push({ k: 'chord', m: [arp[i % 4]], len: 1, v: 0.8, minI: 0 }));
          break;
        }
        case 'pad':
        case 'bellpad':
          steps[base].push({ k: 'chord', m: voiced, len: 16, v: 0.8, minI: 0 });
          if (pre.chord === 'pad') for (const s of [6, 14]) steps[base + s].push({ k: 'arp', m: voiced.map((x) => x + 12), len: 1, v: 0.5, minI: 0 });
          break;
        default:
          for (const s of pre.chordSteps) steps[base + s].push({ k: 'chord', m: voiced, len: pre.chord === 'brass' ? 3 : 1, v: 0.85, minI: 0 });
      }
      // ---- arp layer (intensity)
      const arpNotes = [voiced[0] + 12, voiced[1] + 12, voiced[2] + 12, voiced[1] + 12];
      for (let s = 0; s < 16; s += 2) steps[base + s].push({ k: 'arp', m: [arpNotes[(s / 2) % 4]], len: 1, v: 0.5, minI: 0.45 });
    }
    return steps;
  }
}

// ---------------------------------------------------------------------------------------
// Instruments

function drum(ctx: Ctx, out: AudioNode, k: DrumKind, t: number, v: number, extra = 0, dur = 1): void {
  switch (k) {
    case 'kick':
      tone(ctx, out, { type: 'sine', freq: 150, to: 42, glideTime: 0.12, t, dur: 0.32, vol: 0.55 * v });
      noise(ctx, out, { t, dur: 0.015, vol: 0.08 * v, filter: 'lowpass', cutoff: 3000 });
      break;
    case 'snare':
      noise(ctx, out, { t, dur: 0.17, vol: 0.24 * v, filter: 'bandpass', cutoff: 2200, q: 0.7 });
      tone(ctx, out, { type: 'triangle', freq: 200, to: 150, t, dur: 0.09, vol: 0.2 * v });
      break;
    case 'clap':
      for (let i = 0; i < 3; i++) noise(ctx, out, { t: t + i * 0.011, dur: i === 2 ? 0.14 : 0.02, vol: 0.2 * v, filter: 'bandpass', cutoff: 1500, q: 1.2 });
      break;
    case 'rim':
      tone(ctx, out, { type: 'square', freq: 820, t, dur: 0.03, vol: 0.1 * v, filter: 'bandpass', cutoff: 1700, q: 3 });
      noise(ctx, out, { t, dur: 0.02, vol: 0.1 * v, filter: 'bandpass', cutoff: 2500, q: 2 });
      break;
    case 'hat':
      noise(ctx, out, { t, dur: 0.04, vol: 0.07 * v, filter: 'highpass', cutoff: 7500 });
      break;
    case 'ohat':
      noise(ctx, out, { t, dur: 0.2, vol: 0.06 * v, filter: 'highpass', cutoff: 6500 });
      break;
    case 'shaker':
      noise(ctx, out, { t, dur: 0.06, vol: 0.05 * v, filter: 'highpass', cutoff: 5000, attack: 0.02 });
      break;
    case 'sleigh':
      noise(ctx, out, { t, dur: 0.14, vol: 0.06 * v, filter: 'bandpass', cutoff: 5600, q: 5 });
      noise(ctx, out, { t: t + 0.01, dur: 0.1, vol: 0.05 * v, filter: 'bandpass', cutoff: 8200, q: 6 });
      break;
    case 'crash':
      noise(ctx, out, { t, dur: 1.3, vol: 0.1 * v, filter: 'highpass', cutoff: 4500, q: 0.5 });
      break;
    case 'tom': {
      const f = 110 + (15 - extra) * 25;
      tone(ctx, out, { type: 'sine', freq: f * 1.5, to: f, glideTime: 0.08, t, dur: 0.22, vol: 0.35 * v });
      break;
    }
    case 'ride':
      noise(ctx, out, { t, dur: 0.42, vol: 0.045 * v, filter: 'bandpass', cutoff: 6800, q: 1.2 });
      fm(ctx, out, { freq: 610, ratio: 2.76, index: 1.2, indexTo: 0.3, t, dur: 0.35, vol: 0.012 * v });
      break;
    case 'brush':
      noise(ctx, out, { t, dur: 0.2, vol: 0.075 * v, filter: 'bandpass', cutoff: 2800, q: 0.6, attack: 0.025 });
      break;
    case 'riser':
      noise(ctx, out, { t, dur: Math.max(0.3, dur), vol: 0.06 * v, filter: 'bandpass', cutoff: 400, cutoffTo: 7000, q: 2.5, attack: Math.max(0.2, dur * 0.85), shape: 'asr', release: 0.05 });
      break;
  }
}

function bassNote(ctx: Ctx, out: AudioNode, inst: BassInst, t: number, m: number, dur: number, v: number): void {
  const f = midiToHz(m);
  switch (inst) {
    case 'saw':
      tone(ctx, out, { type: 'sawtooth', freq: f, t, dur, vol: 0.2 * v, shape: 'asr', release: 0.05, filter: 'lowpass', cutoff: 1100, cutoffTo: 350, q: 3 });
      tone(ctx, out, { type: 'sine', freq: f, t, dur, vol: 0.2 * v, shape: 'asr', release: 0.05 });
      break;
    case 'square':
      tone(ctx, out, { type: 'square', freq: f, t, dur, vol: 0.17 * v, shape: 'asr', release: 0.04, filter: 'lowpass', cutoff: 1800, cutoffTo: 260, q: 7 });
      break;
    case 'tri':
      tone(ctx, out, { type: 'triangle', freq: f, t, dur: Math.max(0.12, dur * 0.9), vol: 0.32 * v });
      break;
    case 'sine':
      tone(ctx, out, { type: 'sine', freq: f, t, dur, vol: 0.32 * v, shape: 'asr', release: 0.1 });
      tone(ctx, out, { type: 'triangle', freq: f * 2, t, dur: 0.12, vol: 0.06 * v });
      break;
    case 'house': // deep sine with a short filtered "organ bass" bite
      tone(ctx, out, { type: 'sine', freq: f, t, dur, vol: 0.34 * v, shape: 'asr', release: 0.04 });
      tone(ctx, out, { type: 'square', freq: f, t, dur: Math.min(dur, 0.16), vol: 0.06 * v, filter: 'lowpass', cutoff: 1100, cutoffTo: 220, q: 4 });
      break;
    case 'upright': // plucked upright / boogie bass
      tone(ctx, out, { type: 'triangle', freq: f, t, dur: Math.max(0.2, dur * 1.1), vol: 0.3 * v, attack: 0.004, filter: 'lowpass', cutoff: 1500, cutoffTo: 320, q: 1.2 });
      tone(ctx, out, { type: 'sine', freq: f, t, dur, vol: 0.18 * v, shape: 'asr', release: 0.05 });
      break;
  }
}

function chordNotes(ctx: Ctx, out: AudioNode, inst: ChordInst, t: number, ms: number[], dur: number, v: number): void {
  const n = ms.length;
  ms.forEach((m, i) => {
    const f = midiToHz(m);
    switch (inst) {
      case 'power':
        tone(ctx, out, { type: 'sawtooth', freq: f, t, dur, vol: (0.12 * v) / n * 2, shape: 'asr', release: 0.05, filter: 'lowpass', cutoff: 1600, cutoffTo: 900, q: 1.5, detune: i * 4 - 4 });
        break;
      case 'stab':
        tone(ctx, out, { type: 'sawtooth', freq: f, t, dur: Math.min(dur, 0.14), vol: (0.09 * v) / n * 2, filter: 'lowpass', cutoff: 3000, cutoffTo: 700, q: 2, detune: i * 6 - 6 });
        break;
      case 'pizz':
        tone(ctx, out, { type: 'triangle', freq: f, t, dur: 0.16, vol: 0.14 * v });
        tone(ctx, out, { type: 'sawtooth', freq: f, t, dur: 0.06, vol: 0.03 * v, filter: 'lowpass', cutoff: 2500 });
        break;
      case 'uke':
        tone(ctx, out, { type: 'sawtooth', freq: f, t: t + i * 0.014, dur: 0.38, vol: (0.08 * v) / n * 3, filter: 'lowpass', cutoff: 3200, cutoffTo: 500, q: 2 });
        break;
      case 'pad':
        tone(ctx, out, { type: 'triangle', freq: f, t, dur, vol: (0.1 * v) / n * 3, shape: 'asr', attack: 0.15, release: 0.3 });
        tone(ctx, out, { type: 'sawtooth', freq: f, t, dur, vol: (0.025 * v) / n * 3, shape: 'asr', attack: 0.2, release: 0.3, filter: 'lowpass', cutoff: 1200, detune: 8 });
        break;
      case 'bellpad':
        tone(ctx, out, { type: 'sine', freq: f, t, dur, vol: (0.1 * v) / n * 3, shape: 'asr', attack: 0.2, release: 0.4, vibRate: 4, vibDepth: 6 });
        fm(ctx, out, { freq: f * 2, ratio: 3.5, index: 1, t: t + i * 0.03, dur: 0.9, vol: 0.04 * v });
        break;
      case 'brass':
        tone(ctx, out, { type: 'sawtooth', freq: f, t, dur, vol: (0.1 * v) / n * 2, shape: 'asr', attack: 0.03, release: 0.1, filter: 'lowpass', cutoff: 2400, cutoffTo: 900, q: 1, detune: i * 5 - 5 });
        break;
      case 'piano': // classic house piano stab: bright hammer, quick decay
        fm(ctx, out, { freq: f, ratio: 1, index: 1.3, indexTo: 0.08, t, dur: 0.5, vol: (0.075 * v) / n * 3 });
        tone(ctx, out, { type: 'triangle', freq: f * 2, t, dur: 0.14, vol: (0.025 * v) / n * 3 });
        break;
      case 'organ': // drawbar organ chop
        tone(ctx, out, { type: 'square', freq: f, t, dur, vol: (0.032 * v) / n * 3, shape: 'asr', attack: 0.006, release: 0.05, filter: 'lowpass', cutoff: 2200, q: 0.8 });
        tone(ctx, out, { type: 'sine', freq: f * 2, t, dur, vol: (0.03 * v) / n * 3, shape: 'asr', attack: 0.006, release: 0.05 });
        break;
      case 'jazzpiano':
        fm(ctx, out, { freq: f, ratio: 1, index: 0.7, indexTo: 0.04, t: t + i * 0.008, dur: Math.max(0.35, dur * 1.2), vol: (0.07 * v) / n * 3 });
        break;
    }
  });
}

function leadNote(ctx: Ctx, out: AudioNode, inst: LeadInst, t: number, m: number, dur: number, v: number, bend = false): void {
  const f = midiToHz(m);
  switch (inst) {
    case 'harp': { // blues harmonica: reedy, breathy, scooping up into bent notes
      const f0 = bend ? f * 0.944 : f * 0.99;
      const vib = dur > 0.3 ? 22 : 6;
      tone(ctx, out, { type: 'sawtooth', freq: f0, to: f, glideTime: bend ? 0.11 : 0.03, t, dur, vol: 0.075 * v, shape: 'asr', attack: 0.025, release: 0.07, filter: 'bandpass', cutoff: 1500, q: 0.8, vibRate: 5.8, vibDepth: vib });
      tone(ctx, out, { type: 'square', freq: f0, to: f, glideTime: bend ? 0.11 : 0.03, t, dur, vol: 0.026 * v, shape: 'asr', attack: 0.02, release: 0.06, filter: 'lowpass', cutoff: 2800 });
      noise(ctx, out, { t, dur: Math.min(dur, 0.1), vol: 0.012 * v, filter: 'bandpass', cutoff: f * 2.5, q: 3 });
      break;
    }
    case 'vibes': // vibraphone: soft mallet bell with a long ring
      fm(ctx, out, { freq: f, ratio: 4, index: 0.45, indexTo: 0.02, t, dur: Math.max(0.6, dur * 2), vol: 0.1 * v });
      tone(ctx, out, { type: 'sine', freq: f, t, dur: Math.max(0.5, dur * 1.5), vol: 0.07 * v, vibRate: 5.5, vibDepth: 5 });
      break;
    case 'organlead':
      tone(ctx, out, { type: 'square', freq: f, t, dur, vol: 0.045 * v, shape: 'asr', attack: 0.008, release: 0.06, filter: 'lowpass', cutoff: 2600, vibRate: 6, vibDepth: dur > 0.3 ? 10 : 0 });
      tone(ctx, out, { type: 'sine', freq: f * 2, t, dur, vol: 0.04 * v, shape: 'asr', attack: 0.008, release: 0.06 });
      break;
    case 'sawlead':
      tone(ctx, out, { type: 'sawtooth', freq: f, t, dur, vol: 0.1 * v, shape: 'asr', release: 0.06, filter: 'lowpass', cutoff: 3200, q: 1, vibRate: 5.5, vibDepth: dur > 0.25 ? 14 : 0 });
      tone(ctx, out, { type: 'square', freq: f, t, dur, vol: 0.04 * v, shape: 'asr', release: 0.06, detune: 7 });
      break;
    case 'square':
      tone(ctx, out, { type: 'square', freq: f, t, dur, vol: 0.085 * v, shape: 'asr', release: 0.05, filter: 'lowpass', cutoff: 2800, vibRate: 6, vibDepth: dur > 0.25 ? 12 : 0 });
      break;
    case 'xylo':
      fm(ctx, out, { freq: f, ratio: 4, index: 1.4, indexTo: 0.05, t, dur: 0.35, vol: 0.2 * v });
      tone(ctx, out, { type: 'sine', freq: f * 2, t, dur: 0.08, vol: 0.05 * v });
      break;
    case 'whistle':
      tone(ctx, out, { type: 'sine', freq: f * 0.96, to: f, glideTime: 0.04, t, dur, vol: 0.17 * v, shape: 'asr', attack: 0.02, release: 0.07, vibRate: 6, vibDepth: 20 });
      noise(ctx, out, { t, dur: Math.min(dur, 0.15), vol: 0.012 * v, filter: 'bandpass', cutoff: f * 2, q: 6 });
      break;
    case 'glock':
      fm(ctx, out, { freq: f * 2, ratio: 3.5, index: 0.8, indexTo: 0.02, t, dur: 0.7, vol: 0.13 * v });
      tone(ctx, out, { type: 'triangle', freq: f, t, dur, vol: 0.05 * v, shape: 'asr', release: 0.1 });
      break;
    case 'brass':
      for (const d of [-6, 6]) {
        tone(ctx, out, { type: 'sawtooth', freq: f, t, dur, vol: 0.06 * v, shape: 'asr', attack: 0.025, release: 0.08, filter: 'lowpass', cutoff: 3000, cutoffTo: 1400, detune: d, vibRate: 5.5, vibDepth: dur > 0.3 ? 12 : 0 });
      }
      break;
  }
}

// ---------------------------------------------------------------------------------------
// Player

export class MusicPlayer {
  readonly out: GainNode;
  readonly spec: MusicSpec;
  private readonly steps: Ev[][];
  private readonly pre: Preset;
  private step = 0;
  private nextTime = 0;
  intensity = 0;
  stopped = false;

  constructor(private ctx: Ctx, dest: AudioNode, spec: MusicSpec) {
    this.spec = spec;
    this.pre = P[spec.style];
    this.steps = new Arranger(spec).build();
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
  }

  start(t: number, fadeIn = 0.4): void {
    this.nextTime = t + 0.05;
    this.step = 0;
    this.out.gain.setValueAtTime(0.0001, t);
    this.out.gain.linearRampToValueAtTime(0.55 * (this.pre.level ?? 1), t + Math.max(0.01, fadeIn));
  }

  get stepDur(): number {
    return 60 / this.spec.tempo / 4 / (1 + 0.06 * this.intensity);
  }

  /** Schedule all steps whose start time is before tEnd. */
  scheduleUntil(tEnd: number): void {
    if (this.stopped) return;
    // fell behind (tab throttled / suspended): resync rather than bursting
    if (this.nextTime < this.ctx.currentTime - 0.05) this.nextTime = this.ctx.currentTime + 0.05;
    while (this.nextTime < tEnd) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step = (this.step + 1) % this.steps.length;
    }
  }

  private playStep(i: number, t0: number): void {
    const sd = this.stepDur;
    // 16th swing on odd steps; shuffle pushes the off-beat 8ths late (triplet feel)
    const t = t0 + (i % 2 === 1 ? this.pre.swing * sd : 0) + (i % 4 === 2 ? (this.pre.shuffle ?? 0) * sd : 0);
    const I = this.intensity;
    for (const e of this.steps[i]) {
      if (e.minI > I + 1e-6) continue;
      const dur = e.len * sd * 0.95;
      switch (e.k) {
        case 'bass': bassNote(this.ctx, this.out, (e.i as BassInst) ?? this.pre.bass, t, e.m![0], dur, e.v); break;
        case 'chord': chordNotes(this.ctx, this.out, (e.i as ChordInst) ?? this.pre.chord, t, e.m!, dur, e.v); break;
        case 'lead': leadNote(this.ctx, this.out, (e.i as LeadInst) ?? this.pre.lead, t, e.m![0], dur, e.v, e.bend); break;
        case 'arp': {
          const inst: LeadInst = this.pre.lead === 'xylo' || this.pre.lead === 'glock' || this.pre.lead === 'vibes' ? 'glock' : 'xylo';
          for (const m of e.m!) leadNote(this.ctx, this.out, inst, t, m, dur, e.v * 0.45);
          break;
        }
        default: drum(this.ctx, this.out, e.k, t, e.v, e.m?.[0] ?? 0, dur);
      }
    }
  }

  /** Fade out and stop scheduling. Returns the time the fade completes. */
  stop(t: number, fade = 0.8): number {
    if (this.stopped) return t;
    this.stopped = true;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    return t + fade;
  }

  disconnect(): void {
    try {
      this.out.disconnect();
    } catch {
      /* ignore */
    }
  }
}

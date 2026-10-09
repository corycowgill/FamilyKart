/**
 * Generative procedural music: a seeded 16-bar arrangement (A A B A sections) of drums,
 * bass, chords and lead melody built from a track's tempo/root/scale/style. The player
 * is driven by a lookahead scheduler (`scheduleUntil`) on AudioContext time, so it works
 * both live and inside an OfflineAudioContext.
 */
import type { TrackDef } from '../sim/types';
import { Rng } from '../core/rng';
import { type Ctx, fm, midiToHz, noise, tone } from './synth';

export type ScaleName = TrackDef['music']['scale'];
export type MusicStyle = 'rock' | 'funk' | 'bouncy' | 'kitchen' | 'dogpark' | 'snow' | 'menu' | 'results';
export const MUSIC_STYLES: MusicStyle[] = ['rock', 'funk', 'bouncy', 'kitchen', 'dogpark', 'snow', 'menu', 'results'];

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

type DrumKind = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'rim' | 'shaker' | 'sleigh' | 'crash' | 'tom';
type BassInst = 'saw' | 'square' | 'tri' | 'sine';
type ChordInst = 'power' | 'stab' | 'pizz' | 'uke' | 'pad' | 'bellpad' | 'brass';
type LeadInst = 'sawlead' | 'square' | 'xylo' | 'whistle' | 'glock' | 'brass';
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
}

const P: Record<MusicStyle, Preset> = {
  rock: {
    defaults: { tempo: 148, root: 60, scale: 'major' },
    kick: 'x.....x.x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'hat', swing: 0,
    bass: 'saw', bassPat: 'eighths', chord: 'power', chordSteps: [0, 6, 8, 14], lead: 'sawlead', leadMaxLen: 6,
    rhythms: ['x.x.x...x.x.x...', 'x..x..x.x...x.x.', 'x.xxx...x...x.x.', 'x...x.x.x..x....'],
    progA: [[0, 4, 5, 3], [0, 3, 0, 4], [0, 5, 3, 4]], progB: [[3, 4, 0, 5], [5, 3, 0, 4]], extraPerc: 'ohat',
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
  snow: {
    defaults: { tempo: 138, root: 62, scale: 'major' },
    kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'sleigh', swing: 0.06,
    bass: 'sine', bassPat: 'boomchick', chord: 'bellpad', chordSteps: [0], lead: 'glock', leadMaxLen: 4,
    rhythms: ['x.x.x...x.x.x...', 'x.x.x.x.x...x...', 'x...x.x.x.x.x...', 'x.xxx.x.x.......'],
    progA: [[0, 5, 3, 4], [0, 3, 1, 4]], progB: [[3, 4, 2, 5], [3, 0, 1, 4]], extraPerc: 'ohat',
  },
  menu: {
    defaults: { tempo: 124, root: 62, scale: 'major' },
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.',
    snareInst: 'clap', hatInst: 'hat', swing: 0.05,
    bass: 'tri', bassPat: 'bouncy', chord: 'pad', chordSteps: [0], lead: 'square', leadMaxLen: 4,
    rhythms: ['x.x.x...x...x...', 'x..x..x.x.......', 'x.x.x.x.x...x...', 'x...x.x.x.x.....'],
    progA: [[0, 4, 5, 3]], progB: [[3, 0, 4, 4], [5, 3, 1, 4]], extraPerc: 'shaker',
  },
  results: {
    defaults: { tempo: 110, root: 60, scale: 'major' },
    kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    snareInst: 'snare', hatInst: 'hat', swing: 0,
    bass: 'saw', bassPat: 'bouncy', chord: 'brass', chordSteps: [0, 6, 10], lead: 'brass', leadMaxLen: 6,
    rhythms: ['x.x.x...x.......', 'x..x..x.x...x...', 'x.x.x.x.x.......', 'x...x.x.x.x.....'],
    progA: [[0, 3, 4, 0], [0, 4, 3, 4]], progB: [[5, 3, 0, 4], [3, 4, 5, 4]], extraPerc: 'ohat',
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

function drum(ctx: Ctx, out: AudioNode, k: DrumKind, t: number, v: number, extra = 0): void {
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
    }
  });
}

function leadNote(ctx: Ctx, out: AudioNode, inst: LeadInst, t: number, m: number, dur: number, v: number): void {
  const f = midiToHz(m);
  switch (inst) {
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
    this.out.gain.linearRampToValueAtTime(0.55, t + Math.max(0.01, fadeIn));
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
      this.step = (this.step + 1) % STEPS;
    }
  }

  private playStep(i: number, t0: number): void {
    const sd = this.stepDur;
    const t = t0 + (i % 2 === 1 ? this.pre.swing * sd : 0);
    const I = this.intensity;
    for (const e of this.steps[i]) {
      if (e.minI > I + 1e-6) continue;
      const dur = e.len * sd * 0.95;
      switch (e.k) {
        case 'bass': bassNote(this.ctx, this.out, this.pre.bass, t, e.m![0], dur, e.v); break;
        case 'chord': chordNotes(this.ctx, this.out, this.pre.chord, t, e.m!, dur, e.v); break;
        case 'lead': leadNote(this.ctx, this.out, this.pre.lead, t, e.m![0], dur, e.v); break;
        case 'arp': {
          const inst: LeadInst = this.pre.lead === 'xylo' || this.pre.lead === 'glock' ? 'glock' : 'xylo';
          for (const m of e.m!) leadNote(this.ctx, this.out, inst, t, m, dur, e.v * 0.45);
          break;
        }
        default: drum(this.ctx, this.out, e.k, t, e.v, e.m?.[0] ?? 0);
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

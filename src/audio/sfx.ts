/**
 * Procedural one-shot sound effects. Each recipe schedules nodes on `ctx` into `out`
 * starting at time `t`, scaled by pitch multiplier `p`, and returns its duration (s).
 * All sounds are original and synthesized at runtime.
 */
import type { SfxName } from './AudioEngine';
import { type Ctx, fm, formantVoice, midiToHz, noise, tone } from './synth';

export interface SfxCtx {
  ctx: Ctx;
  out: AudioNode;
  t: number;
  p: number;
  /** recipe-specific variant (e.g. countdown step 0,1,2) */
  variant: number;
}

type Recipe = (c: SfxCtx) => number;

const N = (m: number, p: number) => midiToHz(m) * p;

/** Sparkly arpeggio of short sine pings. */
function sparkle(c: SfxCtx, start: number, notes: number[], step: number, vol: number): number {
  notes.forEach((m, i) => {
    const t = c.t + start + i * step;
    fm(c.ctx, c.out, { freq: N(m, c.p), ratio: 3.5, index: 0.6, t, dur: 0.18, vol });
  });
  return start + notes.length * step + 0.18;
}

/** Brassy chord stab: detuned saws through a lowpass that opens and closes. */
function brass(c: SfxCtx, start: number, notes: number[], dur: number, vol: number): void {
  for (const m of notes) {
    for (const det of [-7, 7]) {
      tone(c.ctx, c.out, {
        type: 'sawtooth', freq: N(m, c.p), t: c.t + start, dur, vol: vol / notes.length,
        shape: 'asr', attack: 0.02, release: 0.12, detune: det,
        filter: 'lowpass', cutoff: 2600, cutoffTo: 900, q: 1.2,
        vibRate: 5.5, vibDepth: dur > 0.3 ? 12 : 0,
      });
    }
  }
}

/** Two-tone "ding-dong" like the chime on a Chicago L train before the doors close. */
function doorChime(c: SfxCtx, start: number, hi: number, lo: number, vol: number, gap = 0.32): number {
  for (const [m, s, d] of [[hi, 0, 0.7], [lo, gap, 1.1]] as Array<[number, number, number]>) {
    const t = c.t + start + s;
    fm(c.ctx, c.out, { freq: N(m, c.p), ratio: 2, index: 0.7, indexTo: 0.05, t, dur: d, vol });
    tone(c.ctx, c.out, { type: 'sine', freq: N(m, c.p), t, dur: d, vol: vol * 0.7 });
    tone(c.ctx, c.out, { type: 'sine', freq: N(m + 12, c.p), t, dur: d * 0.4, vol: vol * 0.15 });
  }
  return start + gap + 1.1;
}

/** Cartoon car horn: two detuned reedy tones a major third apart through a "horn" band-pass. */
function horn(c: SfxCtx, start: number, dur: number, vol: number): void {
  for (const f of [392, 494]) {
    tone(c.ctx, c.out, { type: 'sawtooth', freq: f * c.p, t: c.t + start, dur, vol, shape: 'asr', attack: 0.008, release: 0.03, filter: 'bandpass', cutoff: 1300, q: 1.4 });
    tone(c.ctx, c.out, { type: 'square', freq: f * c.p * 1.004, t: c.t + start, dur, vol: vol * 0.4, shape: 'asr', attack: 0.008, release: 0.03, filter: 'lowpass', cutoff: 1800 });
  }
}

function crash(c: SfxCtx, start: number, vol: number, dur = 1.2): void {
  noise(c.ctx, c.out, { t: c.t + start, dur, vol, filter: 'highpass', cutoff: 5000, q: 0.5 });
}

const recipes: Record<SfxName, Recipe> = {
  menuMove: (c) => {
    tone(c.ctx, c.out, { type: 'square', freq: N(84, c.p), to: N(88, c.p), glideTime: 0.03, t: c.t, dur: 0.06, vol: 0.24 });
    return 0.07;
  },
  menuSelect: (c) => {
    tone(c.ctx, c.out, { type: 'square', freq: N(79, c.p), t: c.t, dur: 0.07, vol: 0.13 });
    tone(c.ctx, c.out, { type: 'square', freq: N(86, c.p), t: c.t + 0.06, dur: 0.14, vol: 0.13 });
    tone(c.ctx, c.out, { type: 'triangle', freq: N(91, c.p), t: c.t + 0.06, dur: 0.18, vol: 0.12 });
    return 0.25;
  },
  menuBack: (c) => {
    tone(c.ctx, c.out, { type: 'square', freq: N(81, c.p), to: N(72, c.p), t: c.t, dur: 0.12, vol: 0.22 });
    return 0.13;
  },
  countdown: (c) => {
    const m = 69 + [0, 2, 4][Math.min(2, c.variant)] ;
    tone(c.ctx, c.out, { type: 'square', freq: N(m, c.p), t: c.t, dur: 0.2, vol: 0.16, shape: 'asr', release: 0.06 });
    tone(c.ctx, c.out, { type: 'triangle', freq: N(m + 12, c.p), t: c.t, dur: 0.2, vol: 0.1, shape: 'asr', release: 0.06 });
    return 0.3;
  },
  go: (c) => {
    for (const m of [81, 88, 93]) {
      tone(c.ctx, c.out, { type: 'square', freq: N(m, c.p), t: c.t, dur: 0.55, vol: 0.08, shape: 'asr', release: 0.25, vibRate: 7, vibDepth: 15 });
    }
    tone(c.ctx, c.out, { type: 'sawtooth', freq: N(57, c.p), t: c.t, dur: 0.5, vol: 0.12, filter: 'lowpass', cutoff: 1800, cutoffTo: 400 });
    crash(c, 0, 0.12, 0.8);
    return 0.85;
  },
  lap: (c) => {
    // L-train door chime "ding-dong" + a little sparkle
    const end = doorChime(c, 0, 88, 84, 0.13, 0.26);
    sparkle(c, 0.02, [96, 100], 0.05, 0.035);
    return end;
  },
  finalLap: (c) => {
    // platform announcement two-tone (twice), then the brass "last stop!" hit
    doorChime(c, 0, 81, 76, 0.1, 0.16);
    brass(c, 0.42, [67, 72, 76], 0.1, 0.3);
    brass(c, 0.55, [67, 72, 76], 0.1, 0.3);
    brass(c, 0.68, [72, 76, 79, 84], 0.65, 0.34);
    tone(c.ctx, c.out, { type: 'triangle', freq: N(48, c.p), t: c.t + 0.68, dur: 0.6, vol: 0.2 });
    crash(c, 0.68, 0.1);
    return 1.6;
  },
  finish: (c) => {
    [72, 76, 79].forEach((m, i) => brass(c, i * 0.12, [m, m + 12], 0.1, 0.25));
    brass(c, 0.36, [72, 76, 79, 84], 1.2, 0.38);
    tone(c.ctx, c.out, { type: 'triangle', freq: N(48, c.p), t: c.t + 0.36, dur: 1.2, vol: 0.25 });
    sparkle(c, 0.4, [96, 100, 103, 108, 103, 108], 0.06, 0.06);
    crash(c, 0.36, 0.14, 1.6);
    return 2.0;
  },
  victory: (c) => {
    const mel: [number, number, number][] = [
      [72, 0, 0.14], [76, 0.15, 0.14], [79, 0.3, 0.14], [84, 0.45, 0.3],
      [83, 0.8, 0.14], [81, 0.95, 0.14], [79, 1.1, 0.14], [81, 1.25, 0.14], [84, 1.45, 0.9],
    ];
    for (const [m, s, d] of mel) {
      tone(c.ctx, c.out, { type: 'square', freq: N(m, c.p), t: c.t + s, dur: d, vol: 0.1, shape: 'asr', release: 0.08, vibRate: 6, vibDepth: d > 0.3 ? 18 : 0 });
      tone(c.ctx, c.out, { type: 'triangle', freq: N(m + 12, c.p), t: c.t + s, dur: d, vol: 0.06, shape: 'asr', release: 0.08 });
    }
    const bass: [number, number][] = [[48, 0], [55, 0.3], [53, 0.8], [55, 1.1], [48, 1.45]];
    for (const [m, s] of bass) tone(c.ctx, c.out, { type: 'triangle', freq: N(m, c.p), t: c.t + s, dur: 0.28, vol: 0.22 });
    brass(c, 1.45, [64, 67, 72], 0.9, 0.24);
    for (let i = 0; i < 8; i++) noise(c.ctx, c.out, { t: c.t + i * 0.15, dur: 0.05, vol: 0.05, filter: 'highpass', cutoff: 7000 });
    crash(c, 1.45, 0.12);
    return 2.6;
  },
  lose: (c) => {
    // sad trombone: wah-wah-wah-waaah
    const notes: [number, number, number][] = [[55, 0, 0.3], [54, 0.36, 0.3], [53, 0.72, 0.3], [52, 1.08, 1.0]];
    for (const [m, s, d] of notes) {
      const t = c.t + s;
      const osc = c.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(N(m, c.p) * 1.02, t);
      osc.frequency.exponentialRampToValueAtTime(N(m, c.p), t + 0.08);
      const f = c.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 6;
      // the "wah": filter opens then closes
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(1400, t + 0.12);
      f.frequency.exponentialRampToValueAtTime(350, t + d);
      const g = c.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.04);
      g.gain.setValueAtTime(0.22, t + d - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(f).connect(g).connect(c.out);
      const nodes: AudioNode[] = [osc, f, g];
      if (d > 0.5) {
        const lfo = c.ctx.createOscillator();
        lfo.frequency.value = 5;
        const lg = c.ctx.createGain();
        lg.gain.setValueAtTime(0, t);
        lg.gain.linearRampToValueAtTime(40, t + 0.4);
        lfo.connect(lg).connect(osc.detune);
        lfo.start(t);
        lfo.stop(t + d + 0.05);
        nodes.push(lfo, lg);
      }
      osc.start(t);
      osc.stop(t + d + 0.05);
      osc.onended = () => nodes.forEach((n) => n.disconnect());
    }
    return 2.2;
  },
  itemPickup: (c) => {
    noise(c.ctx, c.out, { t: c.t, dur: 0.3, vol: 0.06, filter: 'highpass', cutoff: 6000, cutoffTo: 9000 });
    return sparkle(c, 0, [84, 88, 91, 96, 100], 0.045, 0.08);
  },
  itemRoulette: (c) => {
    // decelerating ticks (~1.2 s); repeated calls while it plays are ignored by the engine
    let s = 0;
    let gap = 0.05;
    let i = 0;
    while (s < 1.15) {
      const m = i % 2 === 0 ? 88 : 93;
      tone(c.ctx, c.out, { type: 'square', freq: N(m, c.p), t: c.t + s, dur: 0.03, vol: 0.07 });
      noise(c.ctx, c.out, { t: c.t + s, dur: 0.015, vol: 0.05, filter: 'highpass', cutoff: 4000 });
      s += gap;
      gap *= 1.09;
      i++;
    }
    return 1.2;
  },
  itemGranted: (c) => {
    fm(c.ctx, c.out, { freq: N(88, c.p), ratio: 2, index: 1.5, t: c.t, dur: 0.7, vol: 0.14 });
    fm(c.ctx, c.out, { freq: N(95, c.p), ratio: 2, index: 1, t: c.t + 0.07, dur: 0.6, vol: 0.1 });
    return 0.8;
  },
  launch: (c) => {
    noise(c.ctx, c.out, { t: c.t, dur: 0.35, vol: 0.6, filter: 'bandpass', cutoff: 500, cutoffTo: 3500, q: 2, attack: 0.03 });
    tone(c.ctx, c.out, { type: 'sawtooth', freq: 600 * c.p, to: 200 * c.p, t: c.t, dur: 0.25, vol: 0.14, filter: 'lowpass', cutoff: 2000 });
    return 0.4;
  },
  drop: (c) => {
    tone(c.ctx, c.out, { type: 'sine', freq: 700 * c.p, to: 160 * c.p, glideTime: 0.1, t: c.t, dur: 0.16, vol: 0.35 });
    noise(c.ctx, c.out, { t: c.t + 0.04, dur: 0.06, vol: 0.06, filter: 'lowpass', cutoff: 1200 });
    return 0.2;
  },
  shield: (c) => {
    for (let i = 0; i < 4; i++) {
      tone(c.ctx, c.out, {
        type: 'sine', freq: N(76 + i * 5, c.p), to: N(88 + i * 5, c.p), t: c.t + i * 0.05, dur: 0.6, vol: 0.07,
        attack: 0.05, vibRate: 14 + i * 3, vibDepth: 40,
      });
    }
    noise(c.ctx, c.out, { t: c.t, dur: 0.5, vol: 0.04, filter: 'bandpass', cutoff: 4000, cutoffTo: 8000, q: 3, attack: 0.1 });
    return 0.8;
  },
  shieldBlock: (c) => {
    tone(c.ctx, c.out, { type: 'sine', freq: 300 * c.p, to: 1400 * c.p, glideTime: 0.04, t: c.t, dur: 0.08, vol: 0.4 });
    noise(c.ctx, c.out, { t: c.t + 0.03, dur: 0.08, vol: 0.2, filter: 'highpass', cutoff: 2500 });
    sparkle(c, 0.06, [91, 96, 103], 0.04, 0.06);
    return 0.4;
  },
  boost: (c) => {
    noise(c.ctx, c.out, { t: c.t, dur: 0.6, vol: 0.3, filter: 'bandpass', cutoff: 300, cutoffTo: 2600, q: 1.5, attack: 0.04 });
    tone(c.ctx, c.out, { type: 'sawtooth', freq: 70 * c.p, to: 180 * c.p, t: c.t, dur: 0.7, vol: 0.18, filter: 'lowpass', cutoff: 500, cutoffTo: 2000, q: 4 });
    tone(c.ctx, c.out, { type: 'square', freq: 140 * c.p, to: 360 * c.p, t: c.t, dur: 0.5, vol: 0.06, filter: 'lowpass', cutoff: 1500 });
    return 0.75;
  },
  driftStart: (c) => {
    noise(c.ctx, c.out, { t: c.t, dur: 0.14, vol: 0.7, filter: 'bandpass', cutoff: 2600 * c.p, cutoffTo: 2000 * c.p, q: 8 });
    tone(c.ctx, c.out, { type: 'triangle', freq: 1900 * c.p, to: 1400 * c.p, t: c.t, dur: 0.12, vol: 0.1 });
    return 0.15;
  },
  driftTier1: (c) => zing(c, 1),
  driftTier2: (c) => zing(c, 2),
  driftTier3: (c) => zing(c, 3),
  jump: (c) => {
    const osc = c.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180 * c.p, c.t);
    osc.frequency.exponentialRampToValueAtTime(560 * c.p, c.t + 0.25);
    const lfo = c.ctx.createOscillator();
    lfo.frequency.value = 22;
    const lg = c.ctx.createGain();
    lg.gain.setValueAtTime(260, c.t);
    lg.gain.exponentialRampToValueAtTime(5, c.t + 0.35);
    lfo.connect(lg).connect(osc.detune);
    const g = c.ctx.createGain();
    g.gain.setValueAtTime(0.0001, c.t);
    g.gain.linearRampToValueAtTime(0.3, c.t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.t + 0.38);
    osc.connect(g).connect(c.out);
    osc.start(c.t);
    lfo.start(c.t);
    osc.stop(c.t + 0.4);
    lfo.stop(c.t + 0.4);
    osc.onended = () => [osc, lfo, lg, g].forEach((n) => n.disconnect());
    return 0.4;
  },
  land: (c) => {
    tone(c.ctx, c.out, { type: 'sine', freq: 130 * c.p, to: 45 * c.p, glideTime: 0.12, t: c.t, dur: 0.18, vol: 0.55 });
    noise(c.ctx, c.out, { t: c.t, dur: 0.1, vol: 0.15, filter: 'lowpass', cutoff: 700 });
    return 0.2;
  },
  bump: (c) => {
    // a soft thunk and a quick "meep-meep" city car horn
    tone(c.ctx, c.out, { type: 'sine', freq: 160 * c.p, to: 80 * c.p, t: c.t, dur: 0.1, vol: 0.25 });
    fm(c.ctx, c.out, { freq: 520 * c.p, to: 330 * c.p, ratio: 1.4, index: 1.5, t: c.t, dur: 0.1, vol: 0.12 });
    horn(c, 0.03, 0.07, 0.07);
    horn(c, 0.13, 0.09, 0.07);
    return 0.26;
  },
  wall: (c) => {
    tone(c.ctx, c.out, { type: 'sine', freq: 95 * c.p, to: 38 * c.p, glideTime: 0.15, t: c.t, dur: 0.22, vol: 0.6 });
    tone(c.ctx, c.out, { type: 'square', freq: 170 * c.p, to: 90 * c.p, t: c.t, dur: 0.07, vol: 0.12, filter: 'lowpass', cutoff: 900 });
    noise(c.ctx, c.out, { t: c.t, dur: 0.15, vol: 0.25, filter: 'lowpass', cutoff: 900, cutoffTo: 200 });
    return 0.25;
  },
  hit: (c) => {
    // zap + descending wobble (spin-out)
    noise(c.ctx, c.out, { t: c.t, dur: 0.12, vol: 0.2, filter: 'bandpass', cutoff: 3000, q: 2 });
    fm(c.ctx, c.out, { freq: 1200 * c.p, to: 300 * c.p, ratio: 0.51, index: 4, indexTo: 1, t: c.t, dur: 0.18, vol: 0.12, type: 'square' });
    tone(c.ctx, c.out, {
      type: 'triangle', freq: 800 * c.p, to: 160 * c.p, t: c.t + 0.08, dur: 0.75, vol: 0.22, vibRate: 11, vibDepth: 250,
    });
    return 0.85;
  },
  respawn: (c) => {
    noise(c.ctx, c.out, { t: c.t, dur: 0.7, vol: 0.12, filter: 'bandpass', cutoff: 800, cutoffTo: 6000, q: 2, attack: 0.15 });
    return sparkle(c, 0.05, [72, 74, 76, 79, 81, 84, 86, 88, 91, 96], 0.06, 0.06);
  },
  special: (c) => {
    const chord = [60, 64, 67, 72];
    for (const m of chord) {
      tone(c.ctx, c.out, {
        type: 'sawtooth', freq: N(m, c.p), t: c.t, dur: 0.9, vol: 0.06, shape: 'asr', attack: 0.04, release: 0.3,
        filter: 'lowpass', cutoff: 400, cutoffTo: 5000, q: 5, detune: (m % 3) * 6 - 6,
      });
    }
    tone(c.ctx, c.out, { type: 'sine', freq: N(36, c.p), to: N(48, c.p), t: c.t, dur: 0.9, vol: 0.25 });
    sparkle(c, 0.15, [84, 88, 91, 96, 100, 103, 108], 0.05, 0.05);
    return 1.3;
  },
  bark: (c) => {
    // small dog "yap-yap"
    for (let i = 0; i < 2; i++) {
      const t = c.t + i * 0.17;
      const f0 = (650 + i * 60) * c.p;
      formantVoice(c.ctx, c.out, {
        t, dur: 0.11, vol: 0.8, f0, f0To: f0 * 0.75, f1: 1100, f1To: 800, f2: 2700, f2To: 2200, breath: 0.08, attack: 0.006,
      });
    }
    return 0.32;
  },
  laugh: (c) => {
    // cartoon "ha-ha-ha-ha"
    for (let i = 0; i < 4; i++) {
      const t = c.t + i * 0.15;
      const f0 = (300 - i * 18) * c.p;
      noise(c.ctx, c.out, { t, dur: 0.04, vol: 0.06, filter: 'bandpass', cutoff: 1600, q: 1 }); // "h"
      formantVoice(c.ctx, c.out, { t: t + 0.02, dur: 0.1, vol: 0.4, f0: f0 * 1.05, f0To: f0 * 0.92, f1: 780, f2: 1250 });
    }
    return 0.7;
  },
  cheer: (c) => {
    // crowd swell: several band-passed noise layers + scattered "woo" whistles
    const layers = [700, 1200, 2100, 3200];
    for (const f of layers) {
      noise(c.ctx, c.out, { t: c.t, dur: 1.9, vol: 0.09, filter: 'bandpass', cutoff: f, cutoffTo: f * 1.15, q: 1.5, attack: 0.5, shape: 'asr', release: 0.6 });
    }
    for (let i = 0; i < 6; i++) {
      const s = 0.2 + i * 0.22 + (i % 3) * 0.05;
      const f = 700 + ((i * 337) % 500);
      tone(c.ctx, c.out, { type: 'sine', freq: f * c.p, to: f * 1.5 * c.p, t: c.t + s, dur: 0.35, vol: 0.025, attack: 0.05, vibRate: 7, vibDepth: 30 });
    }
    for (let i = 0; i < 12; i++) {
      noise(c.ctx, c.out, { t: c.t + 0.3 + i * 0.11 + (i % 2) * 0.04, dur: 0.03, vol: 0.06, filter: 'bandpass', cutoff: 2500, q: 2 }); // claps
    }
    // a few rising crowd "woo!"s
    for (let i = 0; i < 4; i++) {
      const f0 = (260 + i * 70) * c.p;
      formantVoice(c.ctx, c.out, { t: c.t + 0.15 + i * 0.27, dur: 0.5, vol: 0.12, f0, f0To: f0 * 1.45, f1: 320, f1To: 420, f2: 800, f2To: 950, breath: 0.02, attack: 0.05 });
    }
    return 2.6;
  },
  ouch: (c) => {
    formantVoice(c.ctx, c.out, {
      t: c.t, dur: 0.32, vol: 0.45, f0: 420 * c.p, f0To: 250 * c.p, f1: 850, f1To: 380, f2: 1300, f2To: 800, breath: 0.05,
    });
    return 0.35;
  },
};

function zing(c: SfxCtx, tier: number): number {
  const top = [0, 1300, 1800, 2500][tier] * c.p;
  fm(c.ctx, c.out, { freq: top * 0.5, to: top, ratio: 1.5 + tier * 0.5, index: 2, indexTo: 0.4, t: c.t, dur: 0.18 + tier * 0.05, vol: 0.1, type: 'square' });
  noise(c.ctx, c.out, { t: c.t, dur: 0.15 + tier * 0.05, vol: 0.06 + tier * 0.02, filter: 'highpass', cutoff: 3000 + tier * 1500 });
  if (tier >= 2) sparkle(c, 0.05, tier === 3 ? [96, 100, 103, 108] : [96, 103], 0.035, 0.04);
  return 0.25 + tier * 0.1;
}

export const SFX_NAMES = Object.keys(recipes) as SfxName[];

/** Render an SFX recipe into `out` at time `t`. Returns duration in seconds. */
export function renderSfx(ctx: Ctx, out: AudioNode, name: SfxName, t: number, pitch = 1, variant = 0): number {
  const r = recipes[name];
  if (!r) return 0;
  return r({ ctx, out, t, p: pitch, variant });
}

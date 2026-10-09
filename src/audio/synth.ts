/**
 * Low-level procedural synthesis helpers shared by SFX, music and engine voices.
 * Everything works on any BaseAudioContext (realtime or OfflineAudioContext) so sounds
 * can be rendered offline for testing. All nodes created here disconnect themselves
 * once their sources end.
 */

export type Ctx = BaseAudioContext;

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** 2 s of white noise, cached per context. */
export function noiseBuffer(ctx: Ctx): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    const len = Math.floor(ctx.sampleRate * 2);
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    // deterministic LCG so offline renders are reproducible
    let s = 0x12345678;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, b);
  }
  return b;
}

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

const EPS = 0.0001;

/** Disconnect a list of nodes when `src` ends. */
export function cleanup(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  };
}

/** Percussive/AD envelope on a gain param: attack -> peak -> exponential decay to silence at t+dur. */
export function adEnv(p: AudioParam, t: number, attack: number, peak: number, dur: number): void {
  p.setValueAtTime(EPS, t);
  p.linearRampToValueAtTime(Math.max(EPS, peak), t + Math.max(0.001, attack));
  p.exponentialRampToValueAtTime(EPS, t + Math.max(attack + 0.005, dur));
}

/** Attack, hold at sustain, release envelope. */
export function asrEnv(p: AudioParam, t: number, attack: number, peak: number, hold: number, release: number): void {
  p.setValueAtTime(EPS, t);
  p.linearRampToValueAtTime(Math.max(EPS, peak), t + Math.max(0.001, attack));
  p.setValueAtTime(Math.max(EPS, peak), t + attack + Math.max(0, hold));
  p.exponentialRampToValueAtTime(EPS, t + attack + Math.max(0, hold) + Math.max(0.01, release));
}

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** glide target frequency (exponential) reached at t + (glideTime ?? dur) */
  to?: number;
  glideTime?: number;
  t: number;
  dur: number;
  vol: number;
  attack?: number;
  /** 'ad' (default) percussive; 'asr' sustains then releases over `release` */
  shape?: 'ad' | 'asr';
  release?: number;
  detune?: number;
  /** vibrato */
  vibRate?: number;
  vibDepth?: number; // in cents
  /** optional filter */
  filter?: BiquadFilterType;
  cutoff?: number;
  cutoffTo?: number;
  q?: number;
}

/** A single oscillator note with envelope (and optional filter/vibrato). Returns the oscillator. */
export function tone(ctx: Ctx, dest: AudioNode, o: ToneOpts): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(1, o.freq), o.t);
  if (o.to !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), o.t + (o.glideTime ?? o.dur));
  }
  if (o.detune) osc.detune.setValueAtTime(o.detune, o.t);
  const g = ctx.createGain();
  const attack = o.attack ?? 0.005;
  if (o.shape === 'asr') asrEnv(g.gain, o.t, attack, o.vol, o.dur - attack, o.release ?? 0.08);
  else adEnv(g.gain, o.t, attack, o.vol, o.dur);
  const nodes: AudioNode[] = [osc, g];
  let head: AudioNode = osc;
  if (o.filter) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.setValueAtTime(o.cutoff ?? 2000, o.t);
    if (o.cutoffTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.cutoffTo), o.t + o.dur);
    f.Q.value = o.q ?? 1;
    head.connect(f);
    head = f;
    nodes.push(f);
  }
  head.connect(g);
  g.connect(dest);
  let lfo: OscillatorNode | null = null;
  if (o.vibRate && o.vibDepth) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibRate;
    const lg = ctx.createGain();
    lg.gain.value = o.vibDepth;
    lfo.connect(lg);
    lg.connect(osc.detune);
    nodes.push(lfo, lg);
    lfo.start(o.t);
  }
  const end = o.t + o.dur + (o.shape === 'asr' ? (o.release ?? 0.08) : 0) + 0.05;
  osc.start(o.t);
  osc.stop(end);
  lfo?.stop(end);
  cleanup(osc, nodes);
  return osc;
}

export interface NoiseOpts {
  t: number;
  dur: number;
  vol: number;
  attack?: number;
  filter?: BiquadFilterType;
  cutoff?: number;
  cutoffTo?: number;
  q?: number;
  shape?: 'ad' | 'asr';
  release?: number;
  /** playback rate (lower = darker/grainier) */
  rate?: number;
}

/** Filtered noise burst. */
export function noise(ctx: Ctx, dest: AudioNode, o: NoiseOpts): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  if (o.rate) src.playbackRate.value = o.rate;
  const f = ctx.createBiquadFilter();
  f.type = o.filter ?? 'bandpass';
  f.frequency.setValueAtTime(o.cutoff ?? 2000, o.t);
  if (o.cutoffTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.cutoffTo), o.t + o.dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  const attack = o.attack ?? 0.002;
  if (o.shape === 'asr') asrEnv(g.gain, o.t, attack, o.vol, o.dur - attack, o.release ?? 0.1);
  else adEnv(g.gain, o.t, attack, o.vol, o.dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  // random offset in the noise buffer so repeated bursts differ
  const offset = (o.t * 7.31) % 1.5;
  src.start(o.t, offset);
  src.stop(o.t + o.dur + (o.shape === 'asr' ? (o.release ?? 0.1) : 0) + 0.05);
  cleanup(src, [src, f, g]);
  return src;
}

export interface FmOpts {
  freq: number;
  ratio: number;
  index: number; // modulation depth as multiple of carrier freq
  indexTo?: number;
  t: number;
  dur: number;
  vol: number;
  attack?: number;
  type?: OscillatorType;
  to?: number;
}

/** Simple 2-op FM voice (bells, zaps, xylophones). */
export function fm(ctx: Ctx, dest: AudioNode, o: FmOpts): OscillatorNode {
  const car = ctx.createOscillator();
  car.type = o.type ?? 'sine';
  const mod = ctx.createOscillator();
  const mg = ctx.createGain();
  car.frequency.setValueAtTime(o.freq, o.t);
  mod.frequency.setValueAtTime(o.freq * o.ratio, o.t);
  if (o.to !== undefined) {
    car.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), o.t + o.dur);
    mod.frequency.exponentialRampToValueAtTime(Math.max(1, o.to * o.ratio), o.t + o.dur);
  }
  mg.gain.setValueAtTime(o.index * o.freq, o.t);
  mg.gain.exponentialRampToValueAtTime(Math.max(0.01, (o.indexTo ?? o.index * 0.1) * o.freq), o.t + o.dur);
  mod.connect(mg);
  mg.connect(car.frequency);
  const g = ctx.createGain();
  adEnv(g.gain, o.t, o.attack ?? 0.002, o.vol, o.dur);
  car.connect(g);
  g.connect(dest);
  car.start(o.t);
  mod.start(o.t);
  const end = o.t + o.dur + 0.05;
  car.stop(end);
  mod.stop(end);
  cleanup(car, [car, mod, mg, g]);
  return car;
}

/**
 * Vowel-ish voice: a sawtooth glottal source through 2 parallel formant band-passes.
 * Used for the dog yap, laugh and "ouch".
 */
export function formantVoice(
  ctx: Ctx,
  dest: AudioNode,
  o: {
    t: number;
    dur: number;
    vol: number;
    f0: number;
    f0To?: number;
    f1: number;
    f2: number;
    f1To?: number;
    f2To?: number;
    breath?: number;
    attack?: number;
  },
): void {
  const src = ctx.createOscillator();
  src.type = 'sawtooth';
  src.frequency.setValueAtTime(o.f0, o.t);
  if (o.f0To) src.frequency.exponentialRampToValueAtTime(o.f0To, o.t + o.dur);
  const g = ctx.createGain();
  adEnv(g.gain, o.t, o.attack ?? 0.012, o.vol, o.dur);
  const nodes: AudioNode[] = [src, g];
  const mkF = (f: number, fTo: number | undefined, q: number, lvl: number) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f, o.t);
    if (fTo) bp.frequency.exponentialRampToValueAtTime(fTo, o.t + o.dur);
    bp.Q.value = q;
    const lg = ctx.createGain();
    lg.gain.value = lvl;
    src.connect(bp);
    bp.connect(lg);
    lg.connect(g);
    nodes.push(bp, lg);
  };
  mkF(o.f1, o.f1To, 6, 1.6);
  mkF(o.f2, o.f2To, 9, 0.9);
  g.connect(dest);
  src.start(o.t);
  src.stop(o.t + o.dur + 0.05);
  cleanup(src, nodes);
  if (o.breath) {
    noise(ctx, dest, { t: o.t, dur: Math.min(0.06, o.dur), vol: o.breath, filter: 'bandpass', cutoff: o.f2, q: 1.5 });
  }
}

/** Soft-knee clip curve: linear to 0.7, smoothly saturating toward 0.98. */
export function softClipCurve(n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const knee = 0.7;
  const ceil = 0.98;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    let y = a;
    if (a > knee) y = knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export interface MasterChain {
  input: GainNode; // master volume
  music: GainNode;
  sfx: GainNode;
  compressor: DynamicsCompressorNode;
}

/** master gain -> compressor -> soft clipper -> destination; music & sfx buses feed master. */
export function buildMasterChain(ctx: Ctx, dest: AudioNode = ctx.destination): MasterChain {
  const input = ctx.createGain();
  const music = ctx.createGain();
  const sfx = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 8;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = 'none';
  music.connect(input);
  sfx.connect(input);
  input.connect(comp);
  comp.connect(clip);
  clip.connect(dest);
  return { input, music, sfx, compressor: comp };
}

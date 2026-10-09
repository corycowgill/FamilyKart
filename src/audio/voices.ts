/**
 * Continuous voices: kart engine and drift squeal.
 */
import { type Ctx, noiseBuffer } from './synth';

const TAU = 0.06; // smoothing time constant for parameter changes

/**
 * Kart engine: two detuned oscillators (saw + square sub) -> lowpass, amplitude
 * modulated by a "putter" LFO tied to RPM, plus a little band-passed noise.
 * 3 oscillators + 1 noise source + 2 filters per voice.
 */
export class EngineSynth {
  private oscA: OscillatorNode;
  private oscB: OscillatorNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private noiseSrc: AudioBufferSourceNode;
  private noiseGain: GainNode;
  private noiseBp: BiquadFilterNode;
  private filter: BiquadFilterNode;
  private amp: GainNode;
  private out: GainNode;
  private nodes: AudioNode[];
  private dead = false;
  private last = { f: -1, cut: -1, g: -1 };

  constructor(private ctx: Ctx, dest: AudioNode, private pitch: number) {
    const t = ctx.currentTime;
    const base = 52 * pitch;
    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscA.frequency.value = base;
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscB.frequency.value = base * 0.5;
    this.oscB.detune.value = 9;
    const mixB = ctx.createGain();
    mixB.gain.value = 0.6;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 500;
    this.filter.Q.value = 2.5;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0.7;
    // putter LFO adds +-depth around amp gain
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'triangle';
    this.lfo.frequency.value = 14;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0.3;
    this.lfo.connect(this.lfoGain).connect(this.amp.gain);
    // noise
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = noiseBuffer(ctx);
    this.noiseSrc.loop = true;
    this.noiseBp = ctx.createBiquadFilter();
    this.noiseBp.type = 'bandpass';
    this.noiseBp.frequency.value = 400;
    this.noiseBp.Q.value = 1.2;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.15;
    this.out = ctx.createGain();
    this.out.gain.value = 0;

    this.oscA.connect(this.filter);
    this.oscB.connect(mixB).connect(this.filter);
    this.noiseSrc.connect(this.noiseBp).connect(this.noiseGain).connect(this.filter);
    this.filter.connect(this.amp).connect(this.out).connect(dest);
    this.nodes = [this.oscA, this.oscB, mixB, this.filter, this.amp, this.lfo, this.lfoGain, this.noiseSrc, this.noiseBp, this.noiseGain, this.out];
    this.oscA.start(t);
    this.oscB.start(t);
    this.lfo.start(t);
    this.noiseSrc.start(t, Math.random());
  }

  update(speed01: number, throttle: number, boosting: boolean, volume: number): void {
    if (this.dead) return;
    const t = this.ctx.currentTime;
    const sp = Math.max(0, Math.min(1.4, isFinite(speed01) ? speed01 : 0));
    const th = Math.max(-1, Math.min(1, isFinite(throttle) ? throttle : 0));
    const vol = Math.max(0, Math.min(1, isFinite(volume) ? volume : 0));
    // "rpm" 0..~1.3
    const rpm = 0.12 + sp * 0.75 + Math.max(0, th) * 0.18 + (boosting ? 0.2 : 0);
    const f = 52 * this.pitch * (1 + rpm * 2.3);
    const cut = 350 + rpm * 1700 + Math.max(0, th) * 400 + (boosting ? 2200 : 0);
    const g = vol * (0.1 + Math.max(0, th) * 0.035 + sp * 0.03 + (boosting ? 0.05 : 0));
    // skip tiny changes to avoid flooding the automation timeline
    if (Math.abs(f - this.last.f) > 0.5) {
      this.oscA.frequency.setTargetAtTime(f, t, TAU);
      this.oscB.frequency.setTargetAtTime(f * 0.5, t, TAU);
      // putter: slower lumpy idle, fast buzz at speed
      this.lfo.frequency.setTargetAtTime(9 + rpm * 26, t, TAU);
      this.lfoGain.gain.setTargetAtTime(0.38 - Math.min(0.3, rpm * 0.25), t, TAU * 2);
      this.noiseBp.frequency.setTargetAtTime(300 + rpm * 900, t, TAU);
      this.last.f = f;
    }
    if (Math.abs(cut - this.last.cut) > 10) {
      this.filter.frequency.setTargetAtTime(cut, t, TAU);
      this.noiseGain.gain.setTargetAtTime(boosting ? 0.45 : 0.12 + sp * 0.1, t, TAU);
      this.last.cut = cut;
    }
    if (Math.abs(g - this.last.g) > 0.002) {
      this.out.gain.setTargetAtTime(g, t, TAU);
      this.last.g = g;
    }
  }

  stop(): void {
    if (this.dead) return;
    this.dead = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.08);
    const end = t + 0.5;
    for (const s of [this.oscA, this.oscB, this.lfo, this.noiseSrc]) {
      try {
        s.stop(end);
      } catch {
        /* ignore */
      }
    }
    this.oscA.onended = () => this.nodes.forEach((n) => n.disconnect());
  }
}

/**
 * Drift: squeal (resonant band-passed noise + faint warbling tone) plus spark crackle
 * (high-passed noise chopped by a fast square LFO) whose level/brightness rise with tier.
 */
export class DriftSynth {
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private squealGain: GainNode;
  private crackleGain: GainNode;
  private crackleHp: BiquadFilterNode;
  private squealBp: BiquadFilterNode;
  private chopper: OscillatorNode;
  private out: GainNode;
  dead = false;

  constructor(private ctx: Ctx, dest: AudioNode) {
    const t = ctx.currentTime;
    const n1 = ctx.createBufferSource();
    n1.buffer = noiseBuffer(ctx);
    n1.loop = true;
    this.squealBp = ctx.createBiquadFilter();
    this.squealBp.type = 'bandpass';
    this.squealBp.frequency.value = 1900;
    this.squealBp.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0.5;
    const tone = ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.value = 1450;
    const wob = ctx.createOscillator();
    wob.frequency.value = 7;
    const wobG = ctx.createGain();
    wobG.gain.value = 40;
    wob.connect(wobG).connect(tone.frequency);
    const toneG = ctx.createGain();
    toneG.gain.value = 0.025;
    // crackle
    const n2 = ctx.createBufferSource();
    n2.buffer = noiseBuffer(ctx);
    n2.loop = true;
    this.crackleHp = ctx.createBiquadFilter();
    this.crackleHp.type = 'highpass';
    this.crackleHp.frequency.value = 3000;
    const chopAmp = ctx.createGain();
    chopAmp.gain.value = 0;
    this.chopper = ctx.createOscillator();
    this.chopper.type = 'square';
    this.chopper.frequency.value = 23;
    const chopDepth = ctx.createGain();
    chopDepth.gain.value = 0.5;
    const chopBias = ctx.createConstantSource();
    chopBias.offset.value = 0.5;
    this.chopper.connect(chopDepth).connect(chopAmp.gain);
    chopBias.connect(chopAmp.gain);
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;

    n1.connect(this.squealBp).connect(this.squealGain).connect(this.out);
    tone.connect(toneG).connect(this.out);
    n2.connect(this.crackleHp).connect(chopAmp).connect(this.crackleGain).connect(this.out);
    this.out.connect(dest);

    this.sources = [n1, n2, tone, wob, this.chopper, chopBias];
    this.nodes = [n1, this.squealBp, this.squealGain, tone, wob, wobG, toneG, n2, this.crackleHp, chopAmp, this.chopper, chopDepth, chopBias, this.crackleGain, this.out];
    n1.start(t, 0.3);
    n2.start(t, 1.1);
    for (const s of [tone, wob, this.chopper, chopBias]) s.start(t);
  }

  set(on: boolean, tier: number, volume = 1): void {
    if (this.dead) return;
    const t = this.ctx.currentTime;
    const tr = Math.max(0, Math.min(3, Math.floor(tier || 0)));
    this.out.gain.setTargetAtTime(on ? 0.22 * volume : 0, t, on ? 0.03 : 0.08);
    this.squealBp.frequency.setTargetAtTime(1800 + tr * 250, t, 0.1);
    this.crackleGain.gain.setTargetAtTime(on ? [0, 0.35, 0.55, 0.8][tr] : 0, t, 0.05);
    this.crackleHp.frequency.setTargetAtTime([3000, 3500, 5000, 7000][tr], t, 0.05);
    this.chopper.frequency.setTargetAtTime([18, 22, 30, 40][tr], t, 0.05);
  }

  stop(): void {
    if (this.dead) return;
    this.dead = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.05);
    for (const s of this.sources) {
      try {
        s.stop(t + 0.3);
      } catch {
        /* ignore */
      }
    }
    this.sources[0].onended = () => this.nodes.forEach((n) => n.disconnect());
  }
}

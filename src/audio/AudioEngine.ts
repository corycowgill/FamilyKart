/**
 * Procedural Web Audio engine for Cowgill Kart Racing.
 *
 * Every sound is synthesized at runtime (oscillators, noise, filters, envelopes, FM);
 * there are no audio files. The engine is a safe no-op until `init()` succeeds (which
 * must happen from a user gesture), and never throws when Web Audio is unavailable
 * (e.g. Node tests).
 *
 * Graph: [sfx voices] -> sfx bus ┐
 *        [music players] -> music bus ┼-> master gain -> compressor -> soft clipper -> out
 *        [engine/drift voices] -> sfx bus ┘
 */
import type { TrackDef } from '../sim/types';
import { MusicPlayer, resolveMusic } from './music';
import { renderSfx } from './sfx';
import { buildMasterChain, type MasterChain } from './synth';
import { DriftSynth, EngineSynth } from './voices';

export type SfxName =
  | 'menuMove' | 'menuSelect' | 'menuBack'
  | 'countdown' | 'go' | 'lap' | 'finalLap' | 'finish' | 'victory' | 'lose'
  | 'itemPickup' | 'itemRoulette' | 'itemGranted' | 'launch' | 'drop' | 'shield' | 'shieldBlock'
  | 'boost' | 'driftStart' | 'driftTier1' | 'driftTier2' | 'driftTier3' | 'jump' | 'land'
  | 'bump' | 'wall' | 'hit' | 'respawn' | 'special' | 'bark' | 'laugh' | 'cheer' | 'ouch';

export interface EngineVoice {
  /** speed01: 0..1+ of max speed, throttle -1..1 */
  update(speed01: number, throttle: number, boosting: boolean, volume: number): void;
  stop(): void;
}

export interface SfxOptions {
  volume?: number;
  pitch?: number;
  pan?: number;
}

export { SFX_NAMES } from './sfx';
export { MUSIC_STYLES } from './music';

/** Minimum gap between two plays of the same SFX (seconds). */
const THROTTLE_S = 0.05;
/** Maximum simultaneously sounding one-shot SFX; the oldest are cut when exceeded. */
const MAX_SFX_VOICES = 20;
const MUSIC_LOOKAHEAD = 0.18;
const MUSIC_TICK_MS = 25;

interface ActiveSfx {
  name: SfxName;
  gain: GainNode;
  nodes: AudioNode[];
  end: number;
}

const clamp01 = (v: number) => (isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

export class AudioEngine {
  master = 0.8;
  music = 0.6;
  sfx = 0.8;

  private ctx: AudioContext | null = null;
  private chain: MasterChain | null = null;
  private initPromise: Promise<void> | null = null;
  private lastPlay = new Map<SfxName, number>();
  private active: ActiveSfx[] = [];
  private countdownStep = 0;
  private lastCountdown = -10;

  private musicPlayer: MusicPlayer | null = null;
  private fading: MusicPlayer[] = [];
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private pendingMusic: unknown = null;
  private intensity = 0;

  private drift: DriftSynth | null = null;
  private driftOn = false;
  private driftTimer: ReturnType<typeof setTimeout> | null = null;

  /** True once an AudioContext exists and is running. */
  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** The underlying AudioContext (null before init / when unsupported). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Must be called from a user gesture (browser autoplay policy). Never throws. */
  async init(): Promise<void> {
    if (this.ctx) {
      await this.tryResume();
      return;
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (typeof window === 'undefined') return;
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = w.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.chain = buildMasterChain(this.ctx);
        this.applyVolumes(true);
      } catch {
        this.ctx = null;
        this.chain = null;
        return;
      }
      this.installUnlock();
      await this.tryResume();
      if (this.pendingMusic !== null) {
        const m = this.pendingMusic;
        this.pendingMusic = null;
        this.startMusic(m as TrackDef['music']);
      }
    })();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /** resume() can stay pending forever without a gesture; never wait more than 300 ms. */
  private async tryResume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running') return;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    } catch {
      /* ignore */
    }
  }

  /** Resume on the next user interaction if the context got suspended (autoplay / iOS). */
  private installUnlock(): void {
    if (typeof document === 'undefined') return;
    const unlock = () => {
      if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) {
      document.addEventListener(ev, unlock, { capture: true, passive: true });
    }
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.master = clamp01(master);
    this.music = clamp01(music);
    this.sfx = clamp01(sfx);
    this.applyVolumes(false);
  }

  private applyVolumes(immediate: boolean): void {
    if (!this.ctx || !this.chain) return;
    const t = this.ctx.currentTime;
    // perceptual-ish curve
    const set = (g: GainNode, v: number) => {
      const target = v * v;
      if (immediate) g.gain.setValueAtTime(target, t);
      else g.gain.setTargetAtTime(target, t, 0.03);
    };
    set(this.chain.input, this.master);
    set(this.chain.music, this.music);
    set(this.chain.sfx, this.sfx);
  }

  /** Pause/resume all audio (e.g. pause menu). Safe before init. */
  setPaused(paused: boolean): void {
    if (!this.ctx) return;
    if (paused) void this.ctx.suspend().catch(() => {});
    else void this.ctx.resume().catch(() => {});
  }

  play(name: SfxName, opts: SfxOptions = {}): void {
    const ctx = this.ctx;
    const chain = this.chain;
    if (!ctx || !chain || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      const last = this.lastPlay.get(name);
      if (last !== undefined && now - last < THROTTLE_S) return;
      this.pruneActive(now);
      if (name === 'itemRoulette' && this.active.some((a) => a.name === 'itemRoulette' && a.end > now)) return;
      if (name === 'itemGranted') this.cut('itemRoulette', now);
      this.lastPlay.set(name, now);

      let variant = 0;
      if (name === 'countdown') {
        this.countdownStep = now - this.lastCountdown < 1.6 ? Math.min(2, this.countdownStep + 1) : 0;
        this.lastCountdown = now;
        variant = this.countdownStep;
      }

      while (this.active.length >= MAX_SFX_VOICES) this.cutVoice(this.active.shift()!, now);

      const vol = opts.volume === undefined ? 1 : Math.max(0, Math.min(2, opts.volume || 0));
      if (vol <= 0.001) return;
      const pitch = opts.pitch && isFinite(opts.pitch) && opts.pitch > 0 ? Math.max(0.25, Math.min(4, opts.pitch)) : 1;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      const nodes: AudioNode[] = [gain];
      const pan = opts.pan && isFinite(opts.pan) ? Math.max(-1, Math.min(1, opts.pan)) : 0;
      if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        gain.connect(p).connect(chain.sfx);
        nodes.push(p);
      } else {
        gain.connect(chain.sfx);
      }
      const t = now + 0.005;
      const dur = renderSfx(ctx, gain, name, t, pitch, variant);
      const voice: ActiveSfx = { name, gain, nodes, end: t + dur + 0.1 };
      this.active.push(voice);
    } catch {
      /* never let audio break the game */
    }
  }

  private pruneActive(now: number): void {
    if (!this.active.length) return;
    const keep: ActiveSfx[] = [];
    for (const a of this.active) {
      if (a.end > now) keep.push(a);
      else this.disconnectVoice(a);
    }
    this.active = keep;
  }

  private cut(name: SfxName, now: number): void {
    this.active = this.active.filter((a) => {
      if (a.name !== name) return true;
      this.cutVoice(a, now);
      return false;
    });
  }

  private cutVoice(a: ActiveSfx, now: number): void {
    a.gain.gain.cancelScheduledValues(now);
    a.gain.gain.setTargetAtTime(0, now, 0.015);
    setTimeout(() => this.disconnectVoice(a), 120);
  }

  private disconnectVoice(a: ActiveSfx): void {
    for (const n of a.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------ music

  startMusic(style: TrackDef['music'] | 'menu' | 'results'): void {
    const ctx = this.ctx;
    if (!ctx || !this.chain) {
      this.pendingMusic = style; // start once init() succeeds
      return;
    }
    try {
      const spec = resolveMusic(style);
      const cur = this.musicPlayer;
      if (cur && !cur.stopped && sameSpec(cur.spec, spec)) return; // already playing this
      const now = ctx.currentTime;
      if (cur) this.fadeOutPlayer(cur, now, 1.0);
      const p = new MusicPlayer(ctx, this.chain.music, spec);
      p.intensity = this.intensity;
      p.start(now, cur ? 0.8 : 0.3);
      this.musicPlayer = p;
      this.ensureMusicTimer();
      this.tickMusic();
    } catch {
      /* ignore */
    }
  }

  stopMusic(): void {
    this.pendingMusic = null;
    const ctx = this.ctx;
    if (!ctx || !this.musicPlayer) return;
    this.fadeOutPlayer(this.musicPlayer, ctx.currentTime, 1.0);
    this.musicPlayer = null;
  }

  /** Intensify music on the final lap (0..1): extra layers and a slight speed-up. */
  setMusicIntensity(v: number): void {
    this.intensity = clamp01(v);
    if (this.musicPlayer) this.musicPlayer.intensity = this.intensity;
  }

  private fadeOutPlayer(p: MusicPlayer, now: number, fade: number): void {
    const end = p.stop(now, fade);
    this.fading.push(p);
    const ms = Math.max(0, (end - now) * 1000) + 600; // let already-scheduled notes finish
    setTimeout(() => {
      p.disconnect();
      this.fading = this.fading.filter((x) => x !== p);
    }, ms);
  }

  private ensureMusicTimer(): void {
    if (this.musicTimer !== null) return;
    this.musicTimer = setInterval(() => this.tickMusic(), MUSIC_TICK_MS);
  }

  private tickMusic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.musicPlayer) {
      if (this.musicTimer !== null && this.fading.length === 0) {
        clearInterval(this.musicTimer);
        this.musicTimer = null;
      }
      return;
    }
    if (ctx.state !== 'running') return;
    try {
      this.musicPlayer.scheduleUntil(ctx.currentTime + MUSIC_LOOKAHEAD);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ continuous voices

  createEngine(pitch: number): EngineVoice {
    const p = isFinite(pitch) && pitch > 0 ? Math.max(0.3, Math.min(3, pitch)) : 1;
    // Lazy: nodes are built on the first update after the context is running, so a voice
    // created before init() starts working once audio is unlocked.
    let synth: EngineSynth | null = null;
    let stopped = false;
    return {
      update: (speed01, throttle, boosting, volume) => {
        if (stopped) return;
        const ctx = this.ctx;
        if (!ctx || !this.chain || ctx.state !== 'running') return;
        try {
          if (!synth) synth = new EngineSynth(ctx, this.chain.sfx, p);
          synth.update(speed01, throttle, boosting, volume);
        } catch {
          /* ignore */
        }
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          synth?.stop();
        } catch {
          /* ignore */
        }
        synth = null;
      },
    };
  }

  /** Continuous drift squeal for the local player (tier 0 = no sparks yet). */
  setDrift(on: boolean, tier: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.chain || ctx.state !== 'running') return;
    try {
      if (on) {
        if (this.driftTimer !== null) {
          clearTimeout(this.driftTimer);
          this.driftTimer = null;
        }
        if (!this.drift || this.drift.dead) this.drift = new DriftSynth(ctx, this.chain.sfx);
        this.drift.set(true, tier);
        this.driftOn = true;
      } else if (this.driftOn) {
        this.driftOn = false;
        this.drift?.set(false, 0);
        // tear down after a while to save CPU
        this.driftTimer = setTimeout(() => {
          this.driftTimer = null;
          if (!this.driftOn && this.drift) {
            this.drift.stop();
            this.drift = null;
          }
        }, 1500);
      }
    } catch {
      /* ignore */
    }
  }
}

function sameSpec(a: { style: string; tempo: number; root: number; scale: string }, b: typeof a): boolean {
  return a.style === b.style && a.tempo === b.tempo && a.root === b.root && a.scale === b.scale;
}

export const audio = new AudioEngine();

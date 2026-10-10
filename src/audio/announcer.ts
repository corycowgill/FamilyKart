/**
 * Chicago race announcer: a friendly, kid-appropriate, enthusiastic play-by-play voice using the Web Speech
 * API (`window.speechSynthesis`). All lines are original.
 *
 * Wiring (one call per sim event, plus one at race start):
 *   announce(e, ctx)        - from RaceSession.handleEvent for every SimEvent
 *   announceIntro(trackName) - when a race (not the attract demo) starts
 *   setAnnouncerEnabled(on)  - from the settings screen (default ON)
 *
 * Behaviour:
 *  - never more than one line speaking + one queued; a newer/more important line replaces the queued one,
 *    queued lines go stale after a few seconds, and big moments (GO, final lap, finish) cut off small talk
 *  - per-category throttles (overtakes at most one line per ~8 s, hits ~4 s)
 *  - volume = audio.master x audio.sfx (read at speak time); the music is ducked while talking
 *  - stops talking on audio.setPaused(true) and ignores lines while paused
 *  - complete no-op where speechSynthesis is missing (Node, tests, some headless browsers); never throws
 *
 * `announce()` also plays the Windy City Gust whoosh SFX on a `gust` event (independent of the announcer
 * toggle) so the new item needs no extra audio wiring.
 */
import type { SimEvent } from '../sim/types';
import { audio } from './AudioEngine';

export interface AnnounceContext {
  /** true for karts driven by a local human player */
  isLocal(kart: number): boolean;
  /** display name of a kart's driver */
  name(kart: number): string;
  /** current race place (1-based) */
  place(kart: number): number;
  /** track display name */
  track: string;
  /** total laps in this race */
  laps: number;
}

export type LineKind = 'intro' | 'go' | 'lap' | 'finalLap' | 'overtake' | 'hit' | 'gust' | 'finish';

export interface AnnouncerLine {
  kind: LineKind;
  text: string;
  /** higher = more important; >= INTERRUPT_PRIORITY cuts off a less important line that is speaking */
  priority: number;
}

const PRIORITY: Record<LineKind, number> = { intro: 1, overtake: 1, hit: 1, lap: 2, gust: 2, go: 3, finalLap: 3, finish: 4 };
const INTERRUPT_PRIORITY = 3;
/** minimum seconds between two lines of the same kind */
const THROTTLE: Partial<Record<LineKind, number>> = { overtake: 8, hit: 4, gust: 4, lap: 2 };
/** a queued line that has not started after this many seconds is dropped */
const STALE_S = 3;

const LAP_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

type Rand = () => number;
const pick = <T>(xs: readonly T[], rand: Rand): T => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];

/** Intro lines for a track (original text). */
export function introLines(track: string): string[] {
  return [
    `Welcome to ${track}, right here in the Windy City!`,
    "Grab your deep dish, folks, it's race time in Chicago!",
    `Hello, Chicago! Racers are lined up at ${track}. Let's have some fun!`,
  ];
}

/**
 * Pure line selection: which line (if any) the announcer would say for a sim event. Exported for tests;
 * throttling/queueing happens in the Announcer.
 */
export function lineFor(e: SimEvent, ctx: AnnounceContext, rand: Rand = Math.random): AnnouncerLine | null {
  const line = (kind: LineKind, text: string): AnnouncerLine => ({ kind, text, priority: PRIORITY[kind] });
  switch (e.type) {
    case 'go':
      return line('go', pick(['Go go go!', "Let's ride, Chicago!", 'And they are off! Go go go!'], rand));
    case 'lap': {
      // the final lap gets its own event (emitted right after this one)
      if (!ctx.isLocal(e.kart) || e.lap >= ctx.laps) return null;
      const w = LAP_WORDS[e.lap] ?? String(e.lap);
      return line('lap', pick([`Lap ${w}! Keep it moving!`, `Lap ${w}! Looking good out there!`], rand));
    }
    case 'finalLap':
      if (!ctx.isLocal(e.kart)) return null;
      return line('finalLap', pick(['Final lap! Bring it home, Chicago!', 'Last lap, everybody! Bring it home!'], rand));
    case 'overtake': {
      if (!ctx.isLocal(e.kart)) return null;
      const n = ctx.name(e.kart);
      if (ctx.place(e.kart) === 1) return line('overtake', pick([`${n} takes the lead! What a move!`, `Ooh, what a pass by ${n}! Into first place!`], rand));
      return line('overtake', pick([`Ooh, what a pass by ${n}!`, `${n} zooms on by!`, `Look at ${n} go!`], rand));
    }
    case 'hit':
      if (!ctx.isLocal(e.kart)) return null;
      if (e.cause === 'pothole') return line('hit', pick(['Watch out for those Chicago potholes!', 'Bump! Another Chicago pothole!'], rand));
      if (e.cause === 'wind') return line('hit', pick(['Whoa! Hold on to your hat!', 'Blown away by that lake breeze!'], rand));
      return line('hit', pick(['Ouch! Dibs on that spot!', 'Oof! Shake it off and keep going!', "Uh oh! That's gonna leave a mark!"], rand));
    case 'gust':
      return line('gust', pick(['Here comes the Windy City wind!', 'Whoosh! The Windy City wind is blowing!'], rand));
    case 'finish': {
      if (!ctx.isLocal(e.kart)) return null;
      const n = ctx.name(e.kart);
      if (e.place === 1) return line('finish', pick([`${n} wins it! Sweet win, Chicago!`, `${n} takes the checkered flag! Sweet win, Chicago!`], rand));
      if (e.place <= 3) return line('finish', pick(['On the podium! Chicago proud!', `${n} makes the podium! Chicago proud!`], rand));
      return line('finish', pick(['What a race! Next stop: rematch!', 'Great driving! Next stop: rematch!'], rand));
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ speech backend */

export interface SpeakOptions {
  volume: number;
  rate: number;
  pitch: number;
}

/** Minimal speech backend so the queue logic is testable without a browser. */
export interface Speaker {
  /** Speak `text`; call `done` exactly when it finishes or fails. */
  speak(text: string, opts: SpeakOptions, done: () => void): void;
  cancel(): void;
}

type SpeechWindow = {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
};

/** Web Speech backend; null when unavailable. */
export function createWebSpeaker(): Speaker | null {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as SpeechWindow;
    const synth = w.speechSynthesis;
    const Utt = w.SpeechSynthesisUtterance;
    if (!synth || typeof Utt !== 'function') return null;
    let voice: SpeechSynthesisVoice | null = null;
    const chooseVoice = () => {
      try {
        voice = chooseEnglishVoice(synth.getVoices());
      } catch {
        voice = null;
      }
    };
    chooseVoice();
    try {
      synth.addEventListener?.('voiceschanged', chooseVoice);
    } catch {
      /* ignore */
    }
    return {
      speak(text, opts, done) {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          done();
        };
        // some engines never fire onend: give up after a generous estimate of the line's length
        const watchdog = setTimeout(finish, 2500 + text.length * 110);
        try {
          if (!voice) chooseVoice();
          const u = new Utt(text);
          if (voice) {
            u.voice = voice;
            u.lang = voice.lang;
          } else u.lang = 'en-US';
          u.rate = opts.rate;
          u.pitch = opts.pitch;
          u.volume = opts.volume;
          u.onend = finish;
          u.onerror = finish;
          synth.speak(u);
        } catch {
          finish();
        }
      },
      cancel() {
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

/** Prefer a natural-sounding US English voice, then any English voice. */
export function chooseEnglishVoice(voices: readonly SpeechSynthesisVoice[] | null | undefined): SpeechSynthesisVoice | null {
  if (!voices || !voices.length) return null;
  const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang ?? ''));
  if (!en.length) return null;
  const us = en.filter((v) => /^en[-_]us/i.test(v.lang));
  const nice = /natural|neural|online|google us english|samantha|aria|jenny|guy|alex|zira|david/i;
  return us.find((v) => nice.test(v.name)) ?? us.find((v) => v.localService) ?? us[0] ?? en.find((v) => nice.test(v.name)) ?? en[0];
}

/* ------------------------------------------------------------------ announcer */

interface Pending {
  line: AnnouncerLine;
  at: number;
}

export class Announcer {
  enabled = true;
  rate = 1.05;
  pitch = 1.0;
  private speaking: AnnouncerLine | null = null;
  private queued: Pending | null = null;
  private token = 0;
  private lastByKind = new Map<LineKind, number>();
  private paused = false;

  constructor(
    private speaker: Speaker | null,
    private now: () => number = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000),
    private rand: Rand = Math.random,
    private volume: () => number = () => Math.max(0, Math.min(1, audio.master * audio.sfx)),
    private duck: (on: boolean) => void = (on) => audio.duckMusic(on),
  ) {}

  /** True when speech is available at all. */
  get available(): boolean {
    return !!this.speaker;
  }

  /** The line currently being spoken (null when quiet). */
  get current(): AnnouncerLine | null {
    return this.speaking;
  }

  /** The line waiting to be spoken next (null when none). */
  get next(): AnnouncerLine | null {
    return this.queued?.line ?? null;
  }

  onEvent(e: SimEvent, ctx: AnnounceContext): void {
    try {
      if (!this.enabled || this.paused || !this.speaker) return;
      const line = lineFor(e, ctx, this.rand);
      if (line) this.say(line);
    } catch {
      /* the announcer must never break the race */
    }
  }

  intro(trackName: string): void {
    try {
      if (!this.enabled || this.paused || !this.speaker) return;
      this.say({ kind: 'intro', text: pick(introLines(trackName || 'the track'), this.rand), priority: PRIORITY.intro });
    } catch {
      /* ignore */
    }
  }

  /** Queue or speak a line, respecting throttles, priorities and the 1-queued limit. */
  say(line: AnnouncerLine): void {
    if (!this.speaker || !this.enabled || this.paused) return;
    const t = this.now();
    const gap = THROTTLE[line.kind];
    const last = this.lastByKind.get(line.kind);
    if (gap !== undefined && last !== undefined && t - last < gap) return;
    this.lastByKind.set(line.kind, t);
    if (this.queued && t - this.queued.at > STALE_S) this.queued = null;
    if (!this.speaking) {
      this.start(line);
      return;
    }
    if (line.priority >= INTERRUPT_PRIORITY && line.priority > this.speaking.priority) {
      // big moment: cut off the small talk (and whatever small talk was waiting)
      this.queued = null;
      this.token++;
      this.speaker.cancel();
      this.start(line);
      return;
    }
    if (!this.queued || line.priority >= this.queued.line.priority) this.queued = { line, at: t };
  }

  private start(line: AnnouncerLine): void {
    const speaker = this.speaker;
    if (!speaker) return;
    const my = ++this.token;
    this.speaking = line;
    this.duck(true);
    const vol = this.volume();
    speaker.speak(line.text, { volume: Number.isFinite(vol) ? vol : 0.6, rate: this.rate, pitch: this.pitch }, () => {
      audio.ensureRunning(); // Safari interrupts Web Audio while speech plays
      if (my !== this.token) return; // a cancelled line finishing late
      this.speaking = null;
      this.advance();
    });
  }

  private advance(): void {
    const q = this.queued;
    this.queued = null;
    if (q && !this.paused && this.enabled && this.now() - q.at <= STALE_S) {
      this.start(q.line);
      return;
    }
    this.duck(false);
  }

  /** Stop talking now and forget anything queued. */
  stop(): void {
    this.queued = null;
    const wasSpeaking = !!this.speaking;
    this.speaking = null;
    this.token++;
    try {
      this.speaker?.cancel();
    } catch {
      /* ignore */
    }
    if (wasSpeaking) this.duck(false);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) this.stop();
  }

  setEnabled(on: boolean): void {
    this.enabled = !!on;
    if (!this.enabled) this.stop();
  }

  /** Forget throttles (e.g. a new race). */
  reset(): void {
    this.stop();
    this.lastByKind.clear();
  }
}

/* ------------------------------------------------------------------ singleton API */

let instance: Announcer | null = null;
let enabledSetting = true;

function get(): Announcer {
  if (!instance) {
    instance = new Announcer(createWebSpeaker());
    instance.enabled = enabledSetting;
    try {
      audio.onPauseChange((p) => instance?.setPaused(p));
      if (audio.isPaused) instance.setPaused(true);
    } catch {
      /* ignore */
    }
  }
  return instance;
}

/** Feed every sim event here (RaceSession.handleEvent). Never throws. */
export function announce(e: SimEvent, ctx: AnnounceContext): void {
  try {
    if (e.type === 'gust') {
      // the gust whoosh: full volume when the local player is involved, softer otherwise
      const involved = ctx.isLocal(e.kart) || e.victims.some((v) => ctx.isLocal(v));
      audio.play('gust', { volume: involved ? 1 : 0.5 });
    }
    get().onEvent(e, ctx);
  } catch {
    /* ignore */
  }
}

/** Welcome line at the start of a race. Never throws. */
export function announceIntro(trackName: string): void {
  try {
    const a = get();
    a.reset();
    a.intro(trackName);
  } catch {
    /* ignore */
  }
}

/** Settings toggle (default ON). Turning it off stops any line in progress. */
export function setAnnouncerEnabled(on: boolean): void {
  enabledSetting = !!on;
  try {
    instance?.setEnabled(enabledSetting);
  } catch {
    /* ignore */
  }
}

export function isAnnouncerEnabled(): boolean {
  return enabledSetting;
}

/** Stop talking immediately (e.g. quitting to the menu). */
export function stopAnnouncer(): void {
  try {
    instance?.stop();
  } catch {
    /* ignore */
  }
}

/** Say an arbitrary line (audio preview / debugging). */
export function announcerSay(text: string, priority = 2): void {
  try {
    get().say({ kind: 'intro', text, priority });
  } catch {
    /* ignore */
  }
}

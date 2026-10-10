import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/AudioEngine';
import {
  Announcer, announce, announceIntro, chooseEnglishVoice, createWebSpeaker, introLines, isAnnouncerEnabled, lineFor,
  setAnnouncerEnabled, stopAnnouncer, type AnnounceContext, type Speaker,
} from '../../src/audio/announcer';
import type { SimEvent } from '../../src/sim/types';

const ctx = (local = [0], places: Record<number, number> = {}): AnnounceContext => ({
  isLocal: (k) => local.includes(k),
  name: (k) => ['Dad', 'Mom', 'Bro'][k] ?? `Racer ${k}`,
  place: (k) => places[k] ?? 3,
  track: 'Chicago Grand Prix',
  laps: 3,
});

/** Fake speech backend: lines finish only when the test says so. */
class FakeSpeaker implements Speaker {
  spoken: string[] = [];
  volumes: number[] = [];
  cancels = 0;
  private pending: Array<() => void> = [];
  speak(text: string, opts: { volume: number }, done: () => void): void {
    this.spoken.push(text);
    this.volumes.push(opts.volume);
    this.pending.push(done);
  }
  cancel(): void {
    this.cancels++;
    const p = this.pending;
    this.pending = [];
    p.forEach((d) => d()); // like the browser: cancelled utterances still report "end"
  }
  finish(): void {
    this.pending.shift()?.();
  }
}

function make() {
  let t = 100;
  const sp = new FakeSpeaker();
  const ducks: boolean[] = [];
  const a = new Announcer(sp, () => t, () => 0, () => 0.64, (on) => ducks.push(on));
  return { a, sp, ducks, advance: (s: number) => (t += s) };
}

describe('announcer line selection', () => {
  it('only talks about the local player for laps, overtakes, hits and finishes', () => {
    const c = ctx([0]);
    const evs: SimEvent[] = [
      { type: 'lap', kart: 1, lap: 2, time: 30 },
      { type: 'finalLap', kart: 1 },
      { type: 'overtake', kart: 1, passed: 0 },
      { type: 'hit', kart: 1, by: 0, cause: 'pizza' },
      { type: 'finish', kart: 1, place: 1, time: 90 },
    ];
    for (const e of evs) expect(lineFor(e, c)).toBeNull();
  });

  it('has the Chicago lines', () => {
    const c = ctx([0], { 0: 2 });
    const r = () => 0;
    expect(lineFor({ type: 'go' }, c, r)!.text).toBe('Go go go!');
    expect(lineFor({ type: 'lap', kart: 0, lap: 2, time: 30 }, c, r)!.text).toBe('Lap two! Keep it moving!');
    // the final lap is announced by its own event, not the lap event
    expect(lineFor({ type: 'lap', kart: 0, lap: 3, time: 30 }, c, r)).toBeNull();
    expect(lineFor({ type: 'finalLap', kart: 0 }, c, r)!.text).toBe('Final lap! Bring it home, Chicago!');
    expect(lineFor({ type: 'overtake', kart: 0, passed: 1 }, c, r)!.text).toBe('Ooh, what a pass by Dad!');
    expect(lineFor({ type: 'hit', kart: 0, by: 1, cause: 'pizza' }, c, r)!.text).toBe('Ouch! Dibs on that spot!');
    expect(lineFor({ type: 'hit', kart: 0, by: 1, cause: 'pothole' }, c, r)!.text).toBe('Watch out for those Chicago potholes!');
    expect(lineFor({ type: 'gust', kart: 1, victims: [0] }, c, r)!.text).toBe('Here comes the Windy City wind!');
    expect(lineFor({ type: 'finish', kart: 0, place: 1, time: 1 }, c, r)!.text).toBe('Dad wins it! Sweet win, Chicago!');
    expect(lineFor({ type: 'finish', kart: 0, place: 3, time: 1 }, c, r)!.text).toBe('On the podium! Chicago proud!');
    expect(lineFor({ type: 'finish', kart: 0, place: 5, time: 1 }, c, r)!.text).toBe('What a race! Next stop: rematch!');
    expect(introLines('Sweet Home Chicago')[0]).toBe('Welcome to Sweet Home Chicago, right here in the Windy City!');
    expect(lineFor({ type: 'countdown', n: 3 }, c, r)).toBeNull(); // the countdown stays beeps
  });
});

describe('announcer queue', () => {
  it('never overlaps: one speaking, at most one queued, newest/most important wins the queue', () => {
    const { a, sp, ducks } = make();
    a.onEvent({ type: 'gust', kart: 1, victims: [0] }, ctx());
    expect(sp.spoken).toHaveLength(1);
    expect(ducks).toEqual([true]);
    a.onEvent({ type: 'lap', kart: 0, lap: 2, time: 30 }, ctx());
    a.onEvent({ type: 'hit', kart: 0, by: 1, cause: 'pizza' }, ctx()); // lower priority than the queued lap
    expect(sp.spoken).toHaveLength(1);
    expect(a.next?.kind).toBe('lap');
    sp.finish();
    expect(sp.spoken).toEqual(['Here comes the Windy City wind!', 'Lap two! Keep it moving!']);
    sp.finish();
    expect(a.current).toBeNull();
    expect(ducks[ducks.length - 1]).toBe(false);
    expect(sp.volumes.every((v) => v === 0.64)).toBe(true);
  });

  it('big moments cut off small talk; stale queued lines are dropped', () => {
    const { a, sp, advance } = make();
    a.intro('Chicago Grand Prix');
    a.onEvent({ type: 'overtake', kart: 0, passed: 1 }, ctx());
    expect(a.next?.kind).toBe('overtake');
    a.onEvent({ type: 'go' }, ctx());
    expect(sp.cancels).toBe(1);
    expect(a.current?.kind).toBe('go');
    expect(a.next).toBeNull();
    // a queued line that waits too long goes stale
    advance(1);
    a.onEvent({ type: 'hit', kart: 0, by: 1, cause: 'banana' }, ctx());
    expect(a.next?.kind).toBe('hit');
    advance(5);
    sp.finish();
    expect(a.current).toBeNull();
    expect(sp.spoken).toHaveLength(2);
  });

  it('throttles overtakes to one line per ~8 s', () => {
    const { a, sp, advance } = make();
    a.onEvent({ type: 'overtake', kart: 0, passed: 1 }, ctx());
    sp.finish();
    advance(3);
    a.onEvent({ type: 'overtake', kart: 0, passed: 2 }, ctx());
    expect(sp.spoken).toHaveLength(1);
    advance(6);
    a.onEvent({ type: 'overtake', kart: 0, passed: 2 }, ctx());
    expect(sp.spoken).toHaveLength(2);
  });

  it('stops on pause and when disabled', () => {
    const { a, sp, ducks } = make();
    a.onEvent({ type: 'go' }, ctx());
    a.onEvent({ type: 'gust', kart: 1, victims: [] }, ctx());
    a.setPaused(true);
    expect(sp.cancels).toBe(1);
    expect(a.current).toBeNull();
    expect(a.next).toBeNull();
    expect(ducks[ducks.length - 1]).toBe(false);
    a.onEvent({ type: 'finalLap', kart: 0 }, ctx());
    expect(sp.spoken).toHaveLength(1);
    a.setPaused(false);
    a.setEnabled(false);
    a.onEvent({ type: 'finalLap', kart: 0 }, ctx());
    expect(sp.spoken).toHaveLength(1);
    a.setEnabled(true);
    a.onEvent({ type: 'finalLap', kart: 0 }, ctx());
    expect(sp.spoken).toHaveLength(2);
  });

  it('chooses an English voice', () => {
    const v = (name: string, lang: string, localService = true) => ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;
    expect(chooseEnglishVoice([])).toBeNull();
    expect(chooseEnglishVoice([v('Amelie', 'fr-FR')])).toBeNull();
    expect(chooseEnglishVoice([v('Amelie', 'fr-FR'), v('Daniel', 'en-GB')])!.name).toBe('Daniel');
    expect(chooseEnglishVoice([v('Daniel', 'en-GB'), v('Fred', 'en-US'), v('Samantha', 'en-US')])!.name).toBe('Samantha');
  });
});

describe('announcer in Node (no speechSynthesis)', () => {
  it('is a safe no-op and never throws', () => {
    expect(createWebSpeaker()).toBeNull();
    expect(() => {
      announceIntro('Chicago Grand Prix');
      const evs: SimEvent[] = [
        { type: 'go' }, { type: 'gust', kart: 1, victims: [0] }, { type: 'finish', kart: 0, place: 1, time: 1 },
        { type: 'hit', kart: 0, by: 1, cause: 'wind' }, { type: 'raceOver' },
      ];
      for (const e of evs) announce(e, ctx());
      setAnnouncerEnabled(false);
      expect(isAnnouncerEnabled()).toBe(false);
      announce({ type: 'go' }, ctx());
      setAnnouncerEnabled(true);
      expect(isAnnouncerEnabled()).toBe(true);
      stopAnnouncer();
    }).not.toThrow();
  });

  it('AudioEngine duck/pause hooks are safe before init', () => {
    const a = new AudioEngine();
    const seen: boolean[] = [];
    const off = a.onPauseChange((p) => seen.push(p));
    expect(() => {
      a.duckMusic(true);
      a.duckMusic(false);
      a.setPaused(true);
      a.setPaused(false);
    }).not.toThrow();
    expect(seen).toEqual([true, false]);
    off();
    a.setPaused(true);
    expect(seen).toEqual([true, false]);
    expect(a.isPaused).toBe(true);
  });
});

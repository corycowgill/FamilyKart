import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Save, formatTime, type StorageLike } from '../../src/persist/Save';

class FakeStorage implements StorageLike {
  m = new Map<string, string>();
  writes = 0;
  failNext = 0;
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('QuotaExceededError');
    }
    this.writes++;
    this.m.set(k, v);
  }
}

describe('Save persistence', () => {
  it('starts with defaults when storage is empty', () => {
    const s = new Save(new FakeStorage());
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(s.data.totals).toEqual({ races: 0, wins: 0 });
    expect(s.data.records).toEqual({});
  });

  it('settings round-trip through storage', () => {
    const store = new FakeStorage();
    const a = new Save(store);
    a.updateSettings({ music: 0.1, difficulty: 'hard', lastCharacter: 'lupin', keys: { up: ['KeyW'] } });
    const b = new Save(store);
    expect(b.settings.music).toBe(0.1);
    expect(b.settings.difficulty).toBe('hard');
    expect(b.settings.lastCharacter).toBe('lupin');
    expect(b.settings.keys).toEqual({ up: ['KeyW'] });
    // untouched fields keep defaults
    expect(b.settings.sfx).toBe(DEFAULT_SETTINGS.sfx);
  });

  it('default settings object is not mutated by updates', () => {
    const s = new Save(new FakeStorage());
    s.updateSettings({ master: 0.01 });
    expect(DEFAULT_SETTINGS.master).not.toBe(0.01);
  });

  it('records best lap / race and counts wins', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    expect(s.submitRace('chicago', 'dad', 2, 170, 55)).toEqual({ newBestLap: true, newBestRace: true });
    expect(s.submitRace('chicago', 'mom', 1, 180, 54)).toEqual({ newBestLap: true, newBestRace: false });
    expect(s.submitRace('chicago', 'mom', 1, 160, 58)).toEqual({ newBestLap: false, newBestRace: true });
    const r = new Save(store).record('chicago');
    expect(r).toMatchObject({ races: 3, wins: 2, bestLap: 54, bestLapBy: 'mom', bestRace: 160, bestRaceBy: 'mom' });
    expect(new Save(store).data.totals).toEqual({ races: 3, wins: 2 });
  });

  it('ignores non-finite times and races that do not count for records', () => {
    const s = new Save(new FakeStorage());
    expect(s.submitRace('kitchen', 'dad', 6, NaN, Infinity)).toEqual({ newBestLap: false, newBestRace: false });
    expect(s.submitRace('kitchen', 'dad', 1, 100, 30, false)).toEqual({ newBestLap: false, newBestRace: false });
    expect(s.record('kitchen').bestLap).toBeUndefined();
    expect(s.record('kitchen').races).toBe(2);
  });

  it('keeps only the best cup result', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    s.submitCup('windy', 3, 'easy');
    s.submitCup('windy', 1, 'hard');
    s.submitCup('windy', 2, 'normal');
    expect(new Save(store).data.cups.windy).toEqual({ bestPlace: 1, difficulty: 'hard' });
  });

  it('keeps only the faster ghost', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    s.saveGhost('snow', { character: 'dad', time: 60, frames: [1, 2, 3, 4] });
    s.saveGhost('snow', { character: 'mom', time: 70, frames: [5, 6, 7, 8] });
    expect(new Save(store).ghost('snow')?.character).toBe('dad');
    s.saveGhost('snow', { character: 'lupin', time: 50, frames: [] });
    expect(new Save(store).ghost('snow')?.character).toBe('lupin');
  });

  it('recovers from corrupt JSON', () => {
    const store = new FakeStorage();
    store.m.set('cowgill-kart-save-v1', '{not json');
    const s = new Save(store);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('merges partial / older saves with defaults', () => {
    const store = new FakeStorage();
    store.m.set('cowgill-kart-save-v1', JSON.stringify({ settings: { music: 0.2 }, totals: { races: 4 } }));
    const s = new Save(store);
    expect(s.settings.music).toBe(0.2);
    expect(s.settings.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.data.totals).toEqual({ races: 4, wins: 0 });
    expect(s.data.records).toEqual({});
    expect(s.data.version).toBe(1);
  });

  it('drops ghosts and retries when storage is full', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    s.saveGhost('chicago', { character: 'dad', time: 60, frames: new Array(100).fill(1) });
    store.failNext = 1;
    s.updateSettings({ sfx: 0.3 });
    const reloaded = new Save(store);
    expect(reloaded.settings.sfx).toBe(0.3);
    expect(reloaded.ghost('chicago')).toBeUndefined();
  });

  it('survives storage that always throws', () => {
    const store = new FakeStorage();
    store.failNext = 1e9;
    const s = new Save(store);
    expect(() => s.updateSettings({ sfx: 0.5 })).not.toThrow();
    expect(s.settings.sfx).toBe(0.5);
  });

  it('falls back to memory storage without localStorage', () => {
    const s = new Save();
    s.updateSettings({ music: 0.33 });
    expect(s.settings.music).toBe(0.33);
  });

  it('reset clears everything', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    s.submitRace('chicago', 'dad', 1, 100, 30);
    s.reset();
    expect(new Save(store).data.totals.races).toBe(0);
    expect(new Save(store).data.records).toEqual({});
  });

  it('formats times', () => {
    expect(formatTime(undefined)).toBe('--:--.---');
    expect(formatTime(Infinity)).toBe('--:--.---');
    expect(formatTime(65.4321)).toBe('1:05.432');
    expect(formatTime(5)).toBe('0:05.000');
  });
});

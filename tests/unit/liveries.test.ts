import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Save, type StorageLike } from '../../src/persist/Save';
import { LIVERIES, STARTER_LIVERIES, unlocksForCup, unlocksForRace, type RaceUnlockContext } from '../../src/render/models/liveries';
import { buildKart, clearLiveries, getLivery, setLivery } from '../../src/render/models/kartModels';
import { characterById } from '../../src/data/characters';
import * as THREE from 'three';

class FakeStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

const KEY = 'family-kart-save-v1';
const race = (c: Partial<RaceUnlockContext>): RaceUnlockContext => ({
  trackId: 'neighborhood', mode: 'quick', place: 5, finished: true, timeOfDay: 'day', newRecord: false, ...c,
});

describe('livery definitions', () => {
  it('has unique ids, a hint and a 3-colour swatch for every paint job', () => {
    const ids = LIVERIES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LIVERIES.length).toBeGreaterThanOrEqual(8);
    for (const l of LIVERIES) {
      expect(l.hint.length).toBeGreaterThan(3);
      expect(l.swatch).toHaveLength(3);
      expect(l.start || l.race || l.cup).toBeTruthy();
    }
    expect(STARTER_LIVERIES).toEqual(['chicagoFlag']);
  });
});

describe('livery unlock rules', () => {
  it('finishing any race unlocks Windy City; a DNF unlocks nothing', () => {
    expect(unlocksForRace(race({}))).toEqual(['windyCity']);
    expect(unlocksForRace(race({ finished: false, place: 1 }))).toEqual([]);
  });

  it('racing at night unlocks Lower Wacker', () => {
    expect(unlocksForRace(race({ timeOfDay: 'night' }))).toContain('lowerWacker');
    expect(unlocksForRace(race({ timeOfDay: 'sunset' }))).not.toContain('lowerWacker');
  });

  it('a podium finish unlocks Chicago Dog (not in time trial)', () => {
    expect(unlocksForRace(race({ place: 3 }))).toContain('chicagoDog');
    expect(unlocksForRace(race({ place: 4 }))).not.toContain('chicagoDog');
    expect(unlocksForRace(race({ place: 1, mode: 'timetrial' }))).not.toContain('chicagoDog');
  });

  it('track wins unlock L Train (Chicago GP) and Deep Dish (Kitchen Chaos)', () => {
    expect(unlocksForRace(race({ trackId: 'chicago', place: 1 }))).toContain('lTrain');
    expect(unlocksForRace(race({ trackId: 'chicago', place: 2 }))).not.toContain('lTrain');
    expect(unlocksForRace(race({ trackId: 'kitchen', place: 1, mode: 'grandprix' }))).toContain('deepDish');
    // a time trial "win" is not a race win
    expect(unlocksForRace(race({ trackId: 'kitchen', place: 1, mode: 'timetrial' }))).not.toContain('deepDish');
  });

  it('finishing on Sweet Home Chicago unlocks Blues Club; a time trial record unlocks Lake Michigan', () => {
    expect(unlocksForRace(race({ trackId: 'sweethome', place: 6 }))).toContain('bluesClub');
    expect(unlocksForRace(race({ mode: 'timetrial', place: 1, newRecord: true }))).toContain('lakeMichigan');
    expect(unlocksForRace(race({ mode: 'timetrial', place: 1, newRecord: false }))).not.toContain('lakeMichigan');
  });

  it('a Grand Prix podium unlocks The Bean', () => {
    expect(unlocksForCup({ cupId: 'windy', place: 2 })).toEqual(['bean']);
    expect(unlocksForCup({ cupId: 'windy', place: 4 })).toEqual([]);
  });
});

describe('Save: paint jobs', () => {
  it('fresh save owns only the starter livery and uses factory paint', () => {
    const s = new Save(new FakeStorage());
    expect(s.data.liveries.unlocked).toEqual(['chicagoFlag']);
    expect(s.liveryFor('dad')).toBeNull();
    expect(s.settings.timeOfDay).toBe('day');
  });

  it('loads an old save without livery / time-of-day fields and keeps its progress', () => {
    const store = new FakeStorage();
    // a v1 save written before paint jobs existed
    store.m.set(KEY, JSON.stringify({
      version: 1,
      settings: { ...DEFAULT_SETTINGS, timeOfDay: undefined, music: 0.3 },
      records: { chicago: { wins: 0, races: 2, bestLap: 50 }, sweethome: { wins: 0, races: 1 } },
      cups: { windy: { bestPlace: 2, difficulty: 'easy' } },
      ghosts: {},
      totals: { races: 3, wins: 0 },
    }));
    const s = new Save(store);
    expect(s.settings.music).toBe(0.3);
    expect(s.settings.timeOfDay).toBe('day');
    expect(s.data.records.chicago.bestLap).toBe(50);
    // earned before paint jobs existed -> granted retroactively
    expect(s.isUnlocked('chicagoFlag')).toBe(true);
    expect(s.isUnlocked('windyCity')).toBe(true);
    expect(s.isUnlocked('bluesClub')).toBe(true);
    expect(s.isUnlocked('bean')).toBe(true);
    expect(s.isUnlocked('lTrain')).toBe(false);
    expect(s.data.liveries.chosen).toEqual({});
  });

  it('sanitizes garbage livery data instead of dropping the save', () => {
    const store = new FakeStorage();
    store.m.set(KEY, JSON.stringify({ totals: { races: 0, wins: 0 }, liveries: { unlocked: ['nope', 'lTrain', 5], seen: 'x', chosen: { dad: 'lTrain', mom: 'bean', zed: 'lTrain' } } }));
    const s = new Save(store);
    expect(s.data.liveries.unlocked.sort()).toEqual(['chicagoFlag', 'lTrain']);
    expect(s.data.liveries.seen).toEqual([]);
    expect(s.data.liveries.chosen).toEqual({ dad: 'lTrain' }); // mom's bean is not unlocked
  });

  it('unlocks persist, are reported once, and show as NEW until seen', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    expect(s.unlockFromRace(race({ timeOfDay: 'night', place: 2 })).sort()).toEqual(['chicagoDog', 'lowerWacker', 'windyCity']);
    expect(s.unlockFromRace(race({ timeOfDay: 'night', place: 2 }))).toEqual([]);
    const b = new Save(store);
    expect(b.isUnlocked('lowerWacker')).toBe(true);
    expect(b.isNew('lowerWacker')).toBe(true);
    expect(b.isNew('chicagoFlag')).toBe(false);
    b.markSeen(['lowerWacker']);
    expect(new Save(store).isNew('lowerWacker')).toBe(false);
    expect(b.unlockFromCup({ cupId: 'frosty', place: 1 })).toEqual(['bean']);
  });

  it('equips liveries per racer, refuses locked ones and can go back to factory paint', () => {
    const store = new FakeStorage();
    const s = new Save(store);
    expect(s.chooseLivery('mom', 'lTrain')).toBe(false);
    expect(s.chooseLivery('mom', 'chicagoFlag')).toBe(true);
    expect(new Save(store).liveryFor('mom')).toBe('chicagoFlag');
    expect(new Save(store).liveryFor('dad')).toBeNull();
    s.chooseLivery('mom', null);
    expect(new Save(store).liveryFor('mom')).toBeNull();
  });

  it('time of day persists in settings', () => {
    const store = new FakeStorage();
    new Save(store).updateSettings({ timeOfDay: 'night' });
    expect(new Save(store).settings.timeOfDay).toBe('night');
  });
});

describe('kart livery registry', () => {
  it('buildKart applies the registered livery to every kart shape', () => {
    for (const id of ['dad', 'mom', 'bro1', 'bro2', 'lupin', 'grandma'] as const) {
      for (const l of LIVERIES) {
        setLivery(id, l.id);
        expect(getLivery(id)).toBe(l.id);
        const rig = buildKart(characterById(id));
        const names = new Set<string>();
        rig.root.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (m && 'name' in m) names.add(m.name);
        });
        if (l.id !== 'bean') expect([...names].some((n) => n === `livery-${l.id}-tub`)).toBe(true);
        rig.dispose();
      }
    }
    clearLiveries();
    expect(getLivery('dad')).toBeNull();
    const plain = buildKart(characterById('dad'));
    let hasLivery = false;
    plain.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m?.name?.startsWith('livery-')) hasLivery = true;
    });
    expect(hasLivery).toBe(false);
  });
});

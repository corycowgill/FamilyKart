import type { CharacterId, Difficulty } from '../sim/types';
import type { TouchOptions } from '../input/TouchControls';
import {
  isLiveryId, STARTER_LIVERIES, unlocksForCup, unlocksForRace, unlocksFromHistory,
  type CupUnlockContext, type LiveryId, type RaceUnlockContext,
} from '../render/models/liveries';

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  quality: 'low' | 'medium' | 'high';
  steeringAssist: boolean;
  showFps: boolean;
  /** Chicago race announcer voice (default on) */
  announcer?: boolean;
  difficulty: Difficulty;
  lastCharacter: CharacterId;
  lastCharacterP2: CharacterId;
  lastTrack: string;
  keys?: Record<string, string[]>;
  /** true once the player picked a graphics quality themselves */
  qualityChosen?: boolean;
  /** on-screen touch control preferences */
  touch?: TouchOptions;
  /** lighting for races (track select picker); missing in older saves = day */
  timeOfDay?: 'day' | 'sunset' | 'night';
}

export interface TrackRecord {
  bestLap?: number;
  bestRace?: number;
  bestLapBy?: CharacterId;
  bestRaceBy?: CharacterId;
  wins: number;
  races: number;
}

export interface GhostData {
  character: CharacterId;
  time: number;
  /** Packed samples at 10 Hz: x, y, z, yaw. */
  frames: number[];
}

/** Unlockable paint jobs: what the player owns, has looked at, and has equipped per racer. */
export interface LiveryState {
  unlocked: LiveryId[];
  /** Unlocked liveries the player has already seen in the Garage (others show a NEW badge). */
  seen: LiveryId[];
  /** Equipped paint job per racer; missing = factory paint. */
  chosen: Partial<Record<CharacterId, LiveryId>>;
}

export interface SaveData {
  version: 1;
  settings: Settings;
  records: Record<string, TrackRecord>;
  cups: Record<string, { bestPlace: number; difficulty: Difficulty }>;
  ghosts: Record<string, GhostData>;
  totals: { races: number; wins: number };
  liveries: LiveryState;
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.8, music: 0.55, sfx: 0.8, quality: 'high', steeringAssist: false, showFps: false, difficulty: 'normal',
  lastCharacter: 'dad', lastCharacterP2: 'mom', lastTrack: 'chicago', timeOfDay: 'day',
};

const CHARACTER_IDS: CharacterId[] = ['dad', 'mom', 'bro1', 'bro2', 'lupin', 'grandma'];

const KEY = 'family-kart-save-v1';

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const memoryStore = (): StorageLike => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/** Persistent progress & settings in localStorage (falls back to memory when unavailable). */
export class Save {
  data: SaveData;
  private store: StorageLike;

  constructor(store?: StorageLike) {
    let s = store;
    if (!s) {
      try {
        s = typeof localStorage !== 'undefined' ? localStorage : memoryStore();
        s.getItem(KEY);
      } catch {
        s = memoryStore();
      }
    }
    this.store = s;
    this.data = this.load();
  }

  private fresh(): SaveData {
    return {
      version: 1, settings: { ...DEFAULT_SETTINGS }, records: {}, cups: {}, ghosts: {}, totals: { races: 0, wins: 0 },
      liveries: { unlocked: [...STARTER_LIVERIES], seen: [], chosen: {} },
    };
  }

  /** Sanitize stored livery state (older saves have none) and grant anything earned before liveries existed. */
  private loadLiveries(raw: unknown, d: SaveData): LiveryState {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LiveryState, unknown>>;
    const ids = (v: unknown): LiveryId[] => (Array.isArray(v) ? [...new Set(v.filter(isLiveryId))] : []);
    const unlocked = ids(r.unlocked);
    for (const id of [...STARTER_LIVERIES, ...unlocksFromHistory(d)]) if (!unlocked.includes(id)) unlocked.push(id);
    const chosen: LiveryState['chosen'] = {};
    const rc = (r.chosen && typeof r.chosen === 'object' ? r.chosen : {}) as Record<string, unknown>;
    for (const c of CHARACTER_IDS) {
      const v = rc[c];
      if (isLiveryId(v) && unlocked.includes(v)) chosen[c] = v;
    }
    return { unlocked, seen: ids(r.seen).filter((id) => unlocked.includes(id)), chosen };
  }

  private load(): SaveData {
    try {
      const raw = this.store.getItem(KEY);
      if (!raw) return this.fresh();
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      const base = this.fresh();
      const d: SaveData = {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings ?? {}) },
        records: parsed.records ?? {},
        cups: parsed.cups ?? {},
        ghosts: parsed.ghosts ?? {},
        totals: { ...base.totals, ...(parsed.totals ?? {}) },
        version: 1,
      };
      try {
        d.liveries = this.loadLiveries(parsed.liveries, d);
      } catch {
        d.liveries = base.liveries; // never lose race progress over a bad livery block
      }
      return d;
    } catch {
      return this.fresh();
    }
  }

  persist(): void {
    try {
      this.store.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // storage full or unavailable - drop ghosts and retry once
      this.data.ghosts = {};
      try {
        this.store.setItem(KEY, JSON.stringify(this.data));
      } catch {
        /* ignore */
      }
    }
  }

  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.data.settings, patch);
    this.persist();
  }

  record(trackId: string): TrackRecord {
    return (this.data.records[trackId] ??= { wins: 0, races: 0 });
  }

  /** Register a finished race. Returns which records were broken. */
  submitRace(trackId: string, character: CharacterId, place: number, raceTime: number, bestLap: number, countsForRecords = true): { newBestLap: boolean; newBestRace: boolean } {
    const r = this.record(trackId);
    r.races++;
    this.data.totals.races++;
    if (place === 1) {
      r.wins++;
      this.data.totals.wins++;
    }
    let newBestLap = false;
    let newBestRace = false;
    if (countsForRecords) {
      if (isFinite(bestLap) && bestLap > 0 && (r.bestLap === undefined || bestLap < r.bestLap)) {
        r.bestLap = bestLap;
        r.bestLapBy = character;
        newBestLap = true;
      }
      if (isFinite(raceTime) && raceTime > 0 && (r.bestRace === undefined || raceTime < r.bestRace)) {
        r.bestRace = raceTime;
        r.bestRaceBy = character;
        newBestRace = true;
      }
    }
    this.persist();
    return { newBestLap, newBestRace };
  }

  submitCup(cupId: string, place: number, difficulty: Difficulty): void {
    const prev = this.data.cups[cupId];
    if (!prev || place < prev.bestPlace) this.data.cups[cupId] = { bestPlace: place, difficulty };
    this.persist();
  }

  /* ---------------------------------------------------------------- paint jobs */

  isUnlocked(id: LiveryId): boolean {
    return this.data.liveries.unlocked.includes(id);
  }

  /** Equipped livery for a racer (null = factory paint). */
  liveryFor(character: CharacterId): LiveryId | null {
    const id = this.data.liveries.chosen[character];
    return id && this.isUnlocked(id) ? id : null;
  }

  /** Equip a livery (null = factory paint). Locked liveries are refused. */
  chooseLivery(character: CharacterId, id: LiveryId | null): boolean {
    if (id && !this.isUnlocked(id)) return false;
    if (id) this.data.liveries.chosen[character] = id;
    else delete this.data.liveries.chosen[character];
    this.persist();
    return true;
  }

  /** Unlocked but not yet looked at in the Garage. */
  isNew(id: LiveryId): boolean {
    return this.isUnlocked(id) && !this.data.liveries.seen.includes(id) && !STARTER_LIVERIES.includes(id);
  }

  markSeen(ids: LiveryId[]): void {
    const seen = this.data.liveries.seen;
    let changed = false;
    for (const id of ids) {
      if (this.isUnlocked(id) && !seen.includes(id)) {
        seen.push(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private grant(ids: LiveryId[]): LiveryId[] {
    const fresh = ids.filter((id) => !this.isUnlocked(id));
    if (fresh.length) {
      this.data.liveries.unlocked.push(...fresh);
      this.persist();
    }
    return fresh;
  }

  /** Check a finished race against the unlock rules. Returns the liveries unlocked just now. */
  unlockFromRace(c: RaceUnlockContext): LiveryId[] {
    return this.grant(unlocksForRace(c));
  }

  /** Check a completed Grand Prix. Returns the liveries unlocked just now. */
  unlockFromCup(c: CupUnlockContext): LiveryId[] {
    return this.grant(unlocksForCup(c));
  }

  ghost(trackId: string): GhostData | undefined {
    return this.data.ghosts[trackId];
  }

  saveGhost(trackId: string, ghost: GhostData): void {
    const prev = this.data.ghosts[trackId];
    if (!prev || ghost.time < prev.time) {
      this.data.ghosts[trackId] = ghost;
      this.persist();
    }
  }

  reset(): void {
    this.data = this.fresh();
    this.persist();
  }
}

export const formatTime = (t: number | undefined): string => {
  if (t === undefined || !isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};

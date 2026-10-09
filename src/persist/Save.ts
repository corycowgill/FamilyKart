import type { CharacterId, Difficulty } from '../sim/types';

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  quality: 'low' | 'medium' | 'high';
  steeringAssist: boolean;
  showFps: boolean;
  difficulty: Difficulty;
  lastCharacter: CharacterId;
  lastCharacterP2: CharacterId;
  lastTrack: string;
  keys?: Record<string, string[]>;
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

export interface SaveData {
  version: 1;
  settings: Settings;
  records: Record<string, TrackRecord>;
  cups: Record<string, { bestPlace: number; difficulty: Difficulty }>;
  ghosts: Record<string, GhostData>;
  totals: { races: number; wins: number };
}

export const DEFAULT_SETTINGS: Settings = {
  master: 0.8, music: 0.55, sfx: 0.8, quality: 'high', steeringAssist: false, showFps: false, difficulty: 'normal',
  lastCharacter: 'dad', lastCharacterP2: 'mom', lastTrack: 'chicago',
};

const KEY = 'cowgill-kart-save-v1';

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
    return { version: 1, settings: { ...DEFAULT_SETTINGS }, records: {}, cups: {}, ghosts: {}, totals: { races: 0, wins: 0 } };
  }

  private load(): SaveData {
    try {
      const raw = this.store.getItem(KEY);
      if (!raw) return this.fresh();
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      const base = this.fresh();
      return {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings ?? {}) },
        records: parsed.records ?? {},
        cups: parsed.cups ?? {},
        ghosts: parsed.ghosts ?? {},
        totals: { ...base.totals, ...(parsed.totals ?? {}) },
        version: 1,
      };
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

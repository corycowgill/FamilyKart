import type { TrackDef } from '../sim/types';

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

/** PLACEHOLDER audio engine API - implemented by the audio workstream (procedural Web Audio). */
export class AudioEngine {
  master = 0.8;
  music = 0.6;
  sfx = 0.8;
  /** Must be called from a user gesture (browser autoplay policy). */
  async init(): Promise<void> {}
  setVolumes(master: number, music: number, sfx: number): void {
    this.master = master;
    this.music = music;
    this.sfx = sfx;
  }
  play(_name: SfxName, _opts: SfxOptions = {}): void {}
  startMusic(_style: TrackDef['music'] | 'menu' | 'results'): void {}
  stopMusic(): void {}
  /** Intensify music on the final lap. */
  setMusicIntensity(_v: number): void {}
  createEngine(_pitch: number): EngineVoice {
    return { update() {}, stop() {} };
  }
  /** Continuous drift squeal for the local player (tier 0 = no sparks yet). */
  setDrift(_on: boolean, _tier: number): void {}
}

export const audio = new AudioEngine();

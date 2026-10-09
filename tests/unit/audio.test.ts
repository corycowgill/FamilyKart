import { describe, expect, it } from 'vitest';
import { AudioEngine, audio, SFX_NAMES, MUSIC_STYLES, type SfxName } from '../../src/audio/AudioEngine';
import { resolveMusic } from '../../src/audio/music';

describe('AudioEngine in Node (no Web Audio)', () => {
  it('init resolves and engine stays a safe no-op', async () => {
    const a = new AudioEngine();
    expect(a.ready).toBe(false);
    await expect(a.init()).resolves.toBeUndefined();
    expect(a.ready).toBe(false);
    expect(a.context).toBeNull();
    expect(() => {
      a.setVolumes(0.5, 0.5, 0.5);
      for (const n of SFX_NAMES) a.play(n as SfxName, { volume: 0.5, pitch: 1.2, pan: -0.3 });
      for (const s of MUSIC_STYLES) a.startMusic(s as 'menu');
      a.startMusic({ tempo: 148, root: 60, scale: 'major', style: 'rock' });
      a.setMusicIntensity(1);
      a.stopMusic();
      const e = a.createEngine(1.4);
      e.update(0.5, 1, true, 0.8);
      e.stop();
      e.stop();
      a.setDrift(true, 2);
      a.setDrift(false, 0);
      a.setPaused(true);
    }).not.toThrow();
  });

  it('covers every SfxName and exports a singleton', () => {
    expect(SFX_NAMES.length).toBe(33);
    expect(audio).toBeInstanceOf(AudioEngine);
  });

  it('maps unknown music styles to a sensible default', () => {
    expect(resolveMusic('menu').style).toBe('menu');
    expect(resolveMusic({ tempo: 100, root: 50, scale: 'minor', style: 'whatever' }).style).toBe('bouncy');
    expect(resolveMusic({ tempo: 100, root: 50, scale: 'minor', style: 'Snowy Holiday' }).style).toBe('snow');
    const r = resolveMusic({ tempo: 148, root: 60, scale: 'major', style: 'rock' });
    expect(r).toEqual({ style: 'rock', tempo: 148, root: 60, scale: 'major' });
  });
});

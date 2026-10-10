/** Dev page for auditioning every procedural sound (audio-preview.html). */
import { audio, type EngineVoice, type SfxName } from '../audio/AudioEngine';
import { announce, announceIntro, isAnnouncerEnabled, setAnnouncerEnabled, type AnnounceContext } from '../audio/announcer';
import { MUSIC_STYLES, MusicPlayer, resolveMusic } from '../audio/music';
import type { SimEvent } from '../sim/types';
import { renderSfx, SFX_NAMES } from '../audio/sfx';
import { buildMasterChain } from '../audio/synth';
import { EngineSynth } from '../audio/voices';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function button(parent: HTMLElement, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', async () => {
    await audio.init();
    refreshStatus();
    onClick(b);
  });
  parent.appendChild(b);
  return b;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const l = document.createElement('label');
  l.textContent = `${label} `;
  const i = document.createElement('input');
  i.type = 'range';
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  i.addEventListener('input', () => onInput(Number(i.value)));
  l.appendChild(i);
  parent.appendChild(l);
  return i;
}

function refreshStatus(): void {
  const ctx = audio.context;
  $('status').textContent = ctx ? `state: ${ctx.state}, sampleRate ${ctx.sampleRate}` : 'Web Audio unavailable / not initialised';
}

$('init').addEventListener('click', async () => {
  await audio.init();
  refreshStatus();
});

// volumes
const vols = $('vols');
const v = { master: audio.master, music: audio.music, sfx: audio.sfx };
const applyVols = () => audio.setVolumes(v.master, v.music, v.sfx);
slider(vols, 'master', 0, 1, 0.01, v.master, (x) => ((v.master = x), applyVols()));
slider(vols, 'music', 0, 1, 0.01, v.music, (x) => ((v.music = x), applyVols()));
slider(vols, 'sfx', 0, 1, 0.01, v.sfx, (x) => ((v.sfx = x), applyVols()));

// sfx
const sfxDiv = $('sfx');
for (const name of SFX_NAMES) {
  button(sfxDiv, name, () => {
    audio.play(name, { pitch: Number($<HTMLInputElement>('sfxPitch').value), pan: Number($<HTMLInputElement>('sfxPan').value) });
  });
}
button(sfxDiv, 'countdown 3-2-1-GO', () => {
  audio.play('countdown');
  setTimeout(() => audio.play('countdown'), 1000);
  setTimeout(() => audio.play('countdown'), 2000);
  setTimeout(() => audio.play('go'), 3000);
});

// music
const musicDiv = $('music');
const sampleTracks: Record<string, Parameters<typeof audio.startMusic>[0]> = {
  'chicago (rock 148 C major)': { tempo: 148, root: 60, scale: 'major', style: 'rock' },
  'suburbs (funk 112 A dorian)': { tempo: 112, root: 57, scale: 'dorian', style: 'funk' },
  'bouncy 132 D major': { tempo: 132, root: 62, scale: 'major', style: 'bouncy' },
  'kitchen 126 F mixolydian': { tempo: 126, root: 65, scale: 'mixolydian', style: 'kitchen' },
  'dogpark 120 E major': { tempo: 120, root: 64, scale: 'major', style: 'dogpark' },
  'snow 138 D major': { tempo: 138, root: 62, scale: 'major', style: 'snow' },
  'minor rock 150 E minor': { tempo: 150, root: 64, scale: 'minor', style: 'rock' },
  'unknown style "zzz"': { tempo: 128, root: 60, scale: 'major', style: 'zzz' },
  menu: 'menu',
  results: 'results',
};
for (const [label, spec] of Object.entries(sampleTracks)) button(musicDiv, label, () => audio.startMusic(spec));
button(musicDiv, 'stop music', () => audio.stopMusic());
$<HTMLInputElement>('intensity').addEventListener('input', (e) => audio.setMusicIntensity(Number((e.target as HTMLInputElement).value)));

// engine
const engDiv = $('engine');
let voice: EngineVoice | null = null;
const eng = { pitch: 1, speed: 0, throttle: 0, boost: false, volume: 0.8 };
const pushEngine = () => voice?.update(eng.speed, eng.throttle, eng.boost, eng.volume);
button(engDiv, 'start engine', () => {
  voice?.stop();
  voice = audio.createEngine(eng.pitch);
  pushEngine();
});
button(engDiv, 'stop engine', () => {
  voice?.stop();
  voice = null;
});
const boostBtn = button(engDiv, 'boost', (b) => {
  eng.boost = !eng.boost;
  b.classList.toggle('on', eng.boost);
  pushEngine();
});
void boostBtn;
engDiv.appendChild(document.createElement('br'));
slider(engDiv, 'pitch (Lupin 1.6 / Dad 0.75)', 0.5, 2, 0.05, 1, (x) => (eng.pitch = x));
slider(engDiv, 'speed', 0, 1.2, 0.01, 0, (x) => ((eng.speed = x), pushEngine()));
slider(engDiv, 'throttle', -1, 1, 0.05, 0, (x) => ((eng.throttle = x), pushEngine()));
slider(engDiv, 'volume', 0, 1, 0.01, 0.8, (x) => ((eng.volume = x), pushEngine()));
setInterval(pushEngine, 50);

// drift
const driftDiv = $('drift');
for (const tier of [0, 1, 2, 3]) button(driftDiv, `drift tier ${tier}`, () => audio.setDrift(true, tier));
button(driftDiv, 'drift off', () => audio.setDrift(false, 0));

// announcer (Web Speech; silently unavailable in some browsers / headless)
const annDiv = $('announcer');
const annCtx: AnnounceContext = { isLocal: (k) => k === 0, name: (k) => ['Dad', 'Mom', 'Lupin'][k] ?? 'Racer', place: () => 2, track: 'the Chicago Grand Prix', laps: 3 };
const annEvents: Array<[string, SimEvent]> = [
  ['GO', { type: 'go' }],
  ['lap 2', { type: 'lap', kart: 0, lap: 2, time: 41.2 }],
  ['final lap', { type: 'finalLap', kart: 0 }],
  ['overtake', { type: 'overtake', kart: 0, passed: 1 }],
  ['hit (pizza)', { type: 'hit', kart: 0, by: 1, cause: 'pizza' }],
  ['hit (pothole)', { type: 'hit', kart: 0, by: 1, cause: 'pothole' }],
  ['gust (+ whoosh)', { type: 'gust', kart: 0, victims: [1, 2] }],
  ['finish 1st', { type: 'finish', kart: 0, place: 1, time: 95 }],
  ['finish 3rd', { type: 'finish', kart: 0, place: 3, time: 99 }],
  ['finish 5th', { type: 'finish', kart: 0, place: 5, time: 110 }],
];
button(annDiv, 'intro', () => announceIntro('the Chicago Grand Prix'));
for (const [label, e] of annEvents) button(annDiv, label, () => announce(e, annCtx));
button(annDiv, 'spam 10 events', () => annEvents.forEach(([, e]) => announce(e, annCtx)));
const annToggle = button(annDiv, 'announcer ON', (b) => {
  setAnnouncerEnabled(!isAnnouncerEnabled());
  b.textContent = `announcer ${isAnnouncerEnabled() ? 'ON' : 'OFF'}`;
});
void annToggle;
let pausedPreview = false;
button(annDiv, 'pause / resume', () => audio.setPaused((pausedPreview = !pausedPreview)));
$('annStatus').textContent = typeof speechSynthesis !== 'undefined' ? 'speechSynthesis available' : 'speechSynthesis unavailable (announcer is a no-op)';

// ------------------------------------------------------------------ offline measurement

export interface RenderStats {
  name: string;
  seconds: number;
  peak: number;
  rms: number;
}

function stats(name: string, buf: AudioBuffer): RenderStats {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      n++;
    }
  }
  return { name, seconds: buf.duration, peak, rms: Math.sqrt(sum / Math.max(1, n)) };
}

async function renderOffline(kind: 'sfx' | 'music' | 'engine', name: string, seconds: number): Promise<RenderStats> {
  const sr = 44100;
  const octx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  const chain = buildMasterChain(octx);
  if (kind === 'sfx') {
    renderSfx(octx, chain.sfx, name as SfxName, 0.01);
  } else if (kind === 'music') {
    const p = new MusicPlayer(octx, chain.music, resolveMusic(name));
    p.intensity = name.endsWith('!') ? 1 : 0;
    p.start(0, 0.05);
    p.scheduleUntil(seconds);
  } else {
    const e = new EngineSynth(octx, chain.sfx, Number(name) || 1);
    e.update(0.9, 1, true, 1);
  }
  const buf = await octx.startRendering();
  return stats(`${kind}:${name}`, buf);
}

async function renderAll(): Promise<RenderStats[]> {
  const out: RenderStats[] = [];
  for (const n of SFX_NAMES) out.push(await renderOffline('sfx', n, 2.8));
  for (const s of MUSIC_STYLES) out.push(await renderOffline('music', s, 8));
  out.push(await renderOffline('music', 'rock!', 8));
  // long renders that reach the section changes ("L train" fills) and the results crowd chant
  out.push({ ...(await renderOffline('music', 'rock', 40)), name: 'music:rock (40 s, L train)' });
  out.push({ ...(await renderOffline('music', 'blues', 30)), name: 'music:blues (30 s, L train)' });
  out.push({ ...(await renderOffline('music', 'snow', 30)), name: 'music:snow (30 s, L train)' });
  out.push({ ...(await renderOffline('music', 'results', 16)), name: 'music:results (16 s, chant)' });
  // victory tag over the results music (what the results screen plays)
  {
    const sr = 44100;
    const octx = new OfflineAudioContext(2, sr * 5, sr);
    const chain = buildMasterChain(octx);
    renderSfx(octx, chain.sfx, 'victory', 0.01);
    const p = new MusicPlayer(octx, chain.music, resolveMusic('results'));
    p.start(0, 0.3);
    p.scheduleUntil(5);
    out.push(stats('stack:victory + results music', await octx.startRendering()));
  }
  // worst case: many SFX stacked at once
  {
    const sr = 44100;
    const octx = new OfflineAudioContext(2, sr * 2, sr);
    const chain = buildMasterChain(octx);
    for (const n of ['boost', 'hit', 'wall', 'land', 'finish', 'special', 'cheer', 'go'] as SfxName[]) renderSfx(octx, chain.sfx, n, 0.01);
    const p = new MusicPlayer(octx, chain.music, resolveMusic('rock'));
    p.start(0, 0.01);
    p.scheduleUntil(2);
    out.push(stats('stack:8 sfx + rock music', await octx.startRendering()));
  }
  for (const pitch of ['0.75', '1', '1.6']) out.push(await renderOffline('engine', pitch, 1));
  return out;
}

$('offline').addEventListener('click', async () => {
  const res = await renderAll();
  $('report').textContent = res.map((r) => `${r.name.padEnd(28)} peak ${r.peak.toFixed(3)}  rms ${r.rms.toFixed(4)}`).join('\n');
});

// test hook for Playwright
(window as unknown as Record<string, unknown>).__audioPreview = { audio, SFX_NAMES, MUSIC_STYLES, renderOffline, renderAll };
refreshStatus();

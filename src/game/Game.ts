import { audio } from '../audio/AudioEngine';
import { CHARACTERS, characterById } from '../data/characters';
import { CUPS, TRACKS, trackById } from '../data/tracks/index';
import { DEFAULT_KEYS_P1, Input, type Action, type KeyMap } from '../input/Input';
import { DEFAULT_TOUCH_OPTIONS, isTouchDevice, requestTiltPermission, TouchControls, type TouchOptions } from '../input/TouchControls';
import { formatTime, Save } from '../persist/Save';
import { Podium } from '../render/Podium';
import { Renderer } from '../render/Renderer';
import { Showroom } from '../render/Showroom';
import { AIDriver, AI_DIFFICULTY } from '../sim/ai/AIDriver';
import type { ItemId } from '../sim/types';
import type { RacerConfig, RaceResult } from '../sim/race/RaceSim';
import type { CharacterId, Difficulty, KartInput, SimEvent, TrackDef } from '../sim/types';
import { h, ordinal } from '../ui/dom';
import { FastTap } from '../ui/FastTap';
import { HUD } from '../ui/HUD';
import { Portraits } from '../ui/Portraits';
import { drawTrackPreview } from '../ui/trackPreview';
import { RaceSession } from './RaceSession';

type Mode = 'quick' | 'versus' | 'grandprix' | 'timetrial';
type Stage = { frame(dt: number): void; dispose(): void } | null;

const GP_POINTS = [15, 12, 10, 8, 6, 4];
const TIPS = [
  'Hold DRIFT while steering through corners — release when the sparks turn purple for an Ultra Mini-Turbo!',
  'Grandma looks sweet. She is not.',
  'Lupin drops tennis balls behind him. Do not chase the tennis balls.',
  'Racers further back get stronger items — never give up!',
  'Each family member has a signature special — press F when the meter is READY.',
  'Look for hidden shortcuts. Bro 2 always does.',
  'A Bubble Shield blocks one attack. Mom never leaves home without one.',
  'Drive through boost pads for a free burst of speed.',
];

interface GPState {
  cup: { id: string; name: string; tracks: string[] };
  race: number;
  points: Map<CharacterId, number>;
  lastResults: RaceResult[];
}

/** Top-level game: owns the renderer, the active 3D stage, the DOM screens and the mode flow. */
export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly save = new Save();
  readonly portraits = new Portraits();
  private ui: HTMLElement;
  private stage: Stage = null;
  private session: RaceSession | null = null;
  private attract: RaceSession | null = null;
  private hud: HUD | null = null;
  private last = performance.now();
  private mode: Mode = 'quick';
  private players: CharacterId[] = ['dad'];
  private trackId = 'chicago';
  private difficulty: Difficulty;
  private gp: GPState | null = null;
  private pauseEl: HTMLElement | null = null;
  private debugEl: HTMLElement | null = null;
  private fpsEl: HTMLElement | null = null;
  private fps = { frames: 0, time: 0, value: 60 };
  private debug = false;
  private screenName = 'boot';
  private resultsShown = false;
  private autopilot: AIDriver[] = [];
  /** Test hooks */
  readonly testFlags = { laps: 0, autopilot: false };

  constructor(viewport: HTMLElement, ui: HTMLElement) {
    this.ui = ui;
    this.renderer = new Renderer(viewport);
    this.input = new Input(window);
    const s = this.save.settings;
    this.difficulty = s.difficulty;
    this.players = [CHARACTERS.some((c) => c.id === s.lastCharacter) ? s.lastCharacter : 'dad'];
    this.trackId = TRACKS.some((t) => t.id === s.lastTrack) ? s.lastTrack : TRACKS[0].id;
    // phones and tablets start on medium graphics unless the player picked a quality themselves
    if (isTouchDevice() && !s.qualityChosen && s.quality === 'high' && !window.matchMedia?.('(any-pointer: fine)').matches) this.save.updateSettings({ quality: 'medium' });
    this.renderer.setQuality(this.save.settings.quality);
    audio.setVolumes(s.master, s.music, s.sfx);
    if (s.keys) this.input.setKeyMap(0, { ...DEFAULT_KEYS_P1, ...(s.keys as Partial<KeyMap>) } as KeyMap);
    const params = new URLSearchParams(location.search);
    this.testFlags.laps = Number(params.get('laps') ?? 0);
    this.testFlags.autopilot = params.has('autopilot');
    window.addEventListener('keydown', (e) => this.onKey(e));
    new FastTap(ui);
    // phones: pause when the app is backgrounded / the screen locks, silence audio while hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.session && this.screenName === 'race' && !this.pauseEl && !this.resultsShown) this.togglePause();
        audio.setPaused(true);
      } else if (!this.pauseEl) {
        audio.setPaused(false);
      }
    });
    // iOS Safari: block pinch / double-tap zoom gestures that fight the touch controls
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    this.input.pads.onConnectionChange = (n) => {
      const t = h('div', { class: 'toast-pad' }, n > 0 ? `🎮 Controller connected${n > 1 ? ` (${n})` : ''}` : '🎮 Controller disconnected');
      document.body.append(t);
      setTimeout(() => t.remove(), 2500);
      if (n === 0 && this.session && this.screenName === 'race' && !this.pauseEl) this.togglePause();
    };
    // unlock audio on the first interaction
    const unlock = () => {
      audio.init().then(() => {
        if (this.screenName === 'title' || this.screenName === 'menu') audio.startMusic('menu');
      });
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // iOS only counts touchend/click as a user activation for starting audio
    const iosUnlock = () => void audio.init();
    window.addEventListener('touchend', iosUnlock, { passive: true });
    window.addEventListener('click', iosUnlock);
  }

  async start(onProgress: (p: number) => void): Promise<void> {
    onProgress(0.2);
    this.portraits.generate(this.renderer.gl);
    onProgress(0.5);
    await this.startAttract();
    onProgress(1);
    this.loop();
    this.showTitle();
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const real = (now - this.last) / 1000;
    const dt = Math.min(0.1, real);
    this.last = now;
    this.input.poll(dt);
    this.updateDeviceMode();
    this.handleMenuInput();
    if (this.session) {
      this.session.frame(dt);
      this.hud?.update(this.session.sim.time);
    } else if (this.stage) {
      this.stage.frame(dt);
    } else if (this.attract) {
      this.attract.frame(dt);
    }
    this.fps.frames++;
    this.fps.time += real;
    if (this.fps.time >= 0.5) {
      this.fps.value = this.fps.frames / this.fps.time;
      this.fps.frames = 0;
      this.fps.time = 0;
      if (this.fpsEl) this.fpsEl.textContent = `${this.fps.value.toFixed(0)} FPS`;
      this.autoQuality();
    }
    if (this.debug) this.updateDebugOverlay();
  };

  private slowTime = 0;
  /** Graceful degradation: drop one quality level if a race runs well below 60 FPS for a while. */
  private autoQuality(): void {
    if (!this.session || this.session.paused || this.screenName !== 'race') return;
    this.slowTime = this.fps.value < 32 ? this.slowTime + 0.5 : Math.max(0, this.slowTime - 0.5);
    const q = this.renderer.quality;
    if (this.slowTime >= 6 && q !== 'low' && this.fps.value > 3) {
      this.slowTime = 0;
      const next = q === 'high' ? 'medium' : 'low';
      this.renderer.setQuality(next);
      this.save.updateSettings({ quality: next });
      console.info(`[quality] low frame rate detected, switching graphics quality to ${next}`);
    }
  }

  /* ------------------------------------------------------------------ attract / background */

  private async startAttract(): Promise<void> {
    if (this.attract) return;
    const racers: RacerConfig[] = CHARACTERS.map((c) => ({ character: c.id, playerIndex: -1 }));
    const s = new RaceSession(this.renderer, null, { track: TRACKS[0], racers, difficulty: 'hard', mode: 'attract', seed: 99 });
    await s.load(() => {});
    s.sim.time = 0.01; // skip countdown
    this.attract = s;
  }

  private stopAttract(): void {
    this.attract?.dispose();
    this.attract = null;
  }

  private setStage(stage: Stage): void {
    this.stage?.dispose();
    this.stage = stage;
  }

  /* ------------------------------------------------------------------ screens */

  private show(name: string, el: HTMLElement): void {
    this.screenName = name;
    this.ui.querySelectorAll('.screen').forEach((s) => s.remove());
    el.classList.add('screen');
    el.dataset.screen = name;
    this.ui.append(el);
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('button');
    first?.focus({ preventScroll: true });
  }

  private btn(label: string, cls: string, onClick: () => void, testid?: string): HTMLButtonElement {
    const b = h('button', { class: `btn ${cls}`, 'data-testid': testid, 'data-nav': true }, label);
    b.addEventListener('click', () => {
      audio.play('menuSelect');
      onClick();
    });
    b.addEventListener('mouseenter', () => audio.play('menuMove', { volume: 0.4 }));
    return b;
  }

  showTitle(): void {
    this.setStage(null);
    const el = h('div', { class: 'title-screen' },
      h('div', { class: 'vignette' }),
      h('div', { class: 'logo', html: '<span class="l1">FAMILY</span><span class="l2"><span class="flag">🏁</span> KART RACING <span class="flag">🏁</span></span>' }),
      h('div', { class: 'press-start' }, '', h('span', { class: 'kb-only' }, 'Press any key or click to start'), h('span', { class: 'pad-only' }, 'Press Ⓐ to start'), h('span', { class: 'touch-only' }, 'Tap to start')),
      h('div', { class: 'footer-hint' }, 'Dad · Mom · Bro 1 · Bro 2 · Lupin · Grandma'),
    );
    const go = (e?: Event) => {
      this.titleGo = null;
      if (this.input.lastDevice === 'touch') this.enterFullscreen();
      e?.preventDefault();
      window.removeEventListener('keydown', go);
      el.removeEventListener('click', go);
      audio.play('menuSelect');
      this.showMainMenu();
    };
    window.addEventListener('keydown', go);
    el.addEventListener('click', go); // click, not pointerdown: the rest of the tap must not land on the menu
    this.titleGo = go;
    this.show('title', el);
  }

  showMainMenu(): void {
    this.setStage(null);
    if (!this.attract) void this.startAttract();
    audio.startMusic('menu');
    const t = this.save.data.totals;
    const el = h('div', { class: 'title-screen' },
      h('div', { class: 'vignette' }),
      h('div', { class: 'logo', html: '<span class="l1">FAMILY</span><span class="l2"><span class="flag">🏁</span> KART RACING <span class="flag">🏁</span></span>' }),
      h('div', { class: 'menu-list' },
        this.btn('Quick Race', '', () => this.beginMode('quick'), 'btn-quick-race'),
        this.btn('Grand Prix', 'yellow', () => this.beginMode('grandprix'), 'btn-grand-prix'),
        this.btn('Time Trial', 'blue', () => this.beginMode('timetrial'), 'btn-time-trial'),
        this.btn('2-Player Versus', 'purple', () => this.beginMode('versus'), 'btn-versus'),
        h('div', { class: 'btn-row' },
          this.btn('Garage', 'green small', () => this.showGarage(), 'btn-garage'),
          this.btn('Settings', 'gray small', () => this.showSettings(), 'btn-settings')),
      ),
      h('div', { class: 'corner-stats' }, `Races: ${t.races} · Wins: ${t.wins}`),
      h('div', { class: 'footer-hint' }, h('span', { class: 'kb-only' }, 'Mouse, keyboard (arrows + Enter) or Xbox controller'), h('span', { class: 'pad-only' }, '🎮 Controller connected · D-pad / stick to move · Ⓐ select · Ⓑ back'), h('span', { class: 'touch-only' }, 'Race with on-screen controls: slide to steer, hold DRIFT in corners')),
    );
    el.querySelector<HTMLElement>('.menu-list .btn')?.setAttribute('data-autofocus', '');
    this.show('menu', el);
  }

  private beginMode(mode: Mode): void {
    this.mode = mode;
    this.gp = null;
    if (mode === 'grandprix') this.showCupSelect();
    else this.showCharacterSelect(0);
  }

  /* ------------------------------------------------------------------ character select */

  private showCharacterSelect(playerSlot: number): void {
    if (playerSlot === 0) this.players = [this.players[0] ?? this.save.settings.lastCharacter];
    const room = new Showroom(this.renderer);
    this.stopAttract();
    this.setStage(room);
    const p2 = this.save.settings.lastCharacterP2;
    let current: CharacterId = playerSlot === 0 ? this.players[0] : (p2 !== this.players[0] && CHARACTERS.some((c) => c.id === p2) ? p2 : CHARACTERS.find((c) => c.id !== this.players[0])!.id);
    const info = h('div', { class: 'char-info panel' });
    const cards = h('div', { class: 'char-cards' });
    const refresh = () => {
      room.select(current, playerSlot === 1 ? this.players[0] : null);
      const d = characterById(current);
      const stat = (label: string, v: number) => `<div class="stat"><span>${label}</span><div class="bar">${[1, 2, 3, 4, 5].map((i) => `<div class="pip${i <= v ? ' on' : ''}"></div>`).join('')}</div></div>`;
      info.innerHTML = `<h2 style="color:${d.colors.primary}">${d.name}</h2><div class="title">${d.title}</div><div class="tag">${d.tagline}</div>
        ${stat('Speed', d.stats.speed)}${stat('Acceleration', d.stats.acceleration)}${stat('Handling', d.stats.handling)}${stat('Weight', d.stats.weight)}
        <div class="special-box"><b>⚡ ${d.special.name}</b>${d.special.description}</div>`;
      cards.querySelectorAll('.char-card').forEach((c) => c.classList.toggle('selected', (c as HTMLElement).dataset.id === current));
    };
    const confirm = () => {
      audio.play(current === 'lupin' ? 'bark' : 'menuSelect');
      this.players[playerSlot] = current;
      if (playerSlot === 0) this.save.updateSettings({ lastCharacter: current });
      else this.save.updateSettings({ lastCharacterP2: current });
      if (this.mode === 'versus' && playerSlot === 0) this.showCharacterSelect(1);
      else if (this.mode === 'grandprix') this.startGrandPrix();
      else this.showTrackSelect();
    };
    for (const c of CHARACTERS) {
      const taken = playerSlot === 1 && c.id === this.players[0];
      const card = h('button', { class: 'char-card', 'data-id': c.id, 'data-nav': true, 'data-testid': `char-${c.id}`, disabled: taken },
        h('img', { src: this.portraits.get(c.id), alt: c.name }), c.name);
      if (taken) card.append(h('span', { class: 'p-tag' }, 'P1'));
      card.addEventListener('click', (ev) => {
        // keyboard / gamepad activation (detail === 0) on the highlighted card confirms; mouse clicks select
        if (current === c.id && ev.detail === 0) return confirm();
        current = c.id;
        audio.play('menuMove');
        refresh();
      });
      card.addEventListener('focus', () => {
        if (current !== c.id) {
          current = c.id;
          refresh();
        }
      });
      card.addEventListener('dblclick', confirm);
      cards.append(card);
    }
    const el = h('div', { class: 'char-screen' },
      h('div', { class: 'char-top' },
        h('div', { class: 'screen-title' }, this.mode === 'versus' ? `Player ${playerSlot + 1}: Choose Your Racer` : 'Choose Your Racer'),
        h('div', { class: 'screen-sub' }, h('span', { class: 'kb-only' }, 'Drag the kart to spin it around'), h('span', { class: 'pad-only' }, 'Left stick to choose · Right stick to spin · Ⓐ to pick · Ⓑ back'), h('span', { class: 'touch-only' }, 'Tap a racer · drag the kart to spin it'))),
      info,
      h('div', {},
        cards,
        h('div', { class: 'btn-row' },
          this.btn('Back', 'gray small', () => (playerSlot === 1 ? this.showCharacterSelect(0) : this.backToMenu()), 'btn-back'),
          this.btn('Let\'s Race!', 'green', confirm, 'btn-confirm-character'))),
    );
    this.show('character', el);
    refresh();
    (cards.querySelector(`[data-id="${current}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private backToMenu(): void {
    this.setStage(null);
    void this.startAttract().then(() => this.showMainMenu());
    if (this.attract) this.showMainMenu();
  }

  /* ------------------------------------------------------------------ track select */

  private showTrackSelect(): void {
    const el = h('div', {});
    const grid = h('div', { class: 'track-grid' });
    const tt = this.mode === 'timetrial';
    for (const t of TRACKS) {
      const rec = this.save.data.records[t.id];
      const canvas = h('canvas', { width: 320, height: 200 });
      drawTrackPreview(canvas, t);
      const card = h('button', { class: `track-card${t.id === this.trackId ? ' selected' : ''}`, 'data-nav': true, 'data-testid': `track-${t.id}` },
        canvas,
        h('div', { class: 'tc-body' },
          h('h3', {}, t.name),
          h('div', { class: 'meta' }, h('span', { class: 'stars' }, '★'.repeat(t.difficulty) + '☆'.repeat(3 - t.difficulty)), h('span', {}, `${t.laps} laps`)),
          h('div', { class: 'meta' }, h('span', {}, `Best lap ${formatTime(rec?.bestLap)}`), h('span', {}, `Race ${formatTime(rec?.bestRace)}`))));
      card.addEventListener('click', () => {
        this.trackId = t.id;
        this.save.updateSettings({ lastTrack: t.id });
        this.startRace();
      });
      card.addEventListener('focus', () => {
        grid.querySelectorAll('.track-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      });
      grid.append(card);
    }
    el.append(
      h('div', { class: 'screen-title' }, tt ? 'Time Trial: Pick a Track' : 'Pick a Track'),
      h('div', { class: 'screen-sub' }, tt ? 'Race alone against the clock (and your ghost!)' : `${characterById(this.players[0]).name}${this.players[1] ? ' vs ' + characterById(this.players[1]).name : ''} — choose where to race`),
    );
    if (!tt) el.append(this.difficultyPicker());
    el.append(grid, h('div', { class: 'options-row' }, this.btn('Back', 'gray small', () => this.showCharacterSelect(this.mode === 'versus' ? 1 : 0), 'btn-back')));
    this.show('track', el);
    (grid.querySelector('.selected') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private difficultyPicker(): HTMLElement {
    const seg = h('div', { class: 'seg' });
    const labels: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
    (['easy', 'normal', 'hard'] as Difficulty[]).forEach((d) => {
      const b = h('button', { class: d === this.difficulty ? 'on' : '', 'data-testid': `diff-${d}` }, labels[d]);
      b.addEventListener('click', () => {
        this.difficulty = d;
        this.save.updateSettings({ difficulty: d });
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        audio.play('menuMove');
      });
      seg.append(b);
    });
    const assist = h('label', { class: 'label', style: 'display:flex;gap:8px;align-items:center;cursor:pointer' },
      h('input', { type: 'checkbox', checked: this.save.settings.steeringAssist, 'data-testid': 'assist' }), 'Steering assist');
    assist.querySelector('input')!.addEventListener('change', (e) => this.save.updateSettings({ steeringAssist: (e.target as HTMLInputElement).checked }));
    return h('div', { class: 'options-row' }, h('span', { class: 'label' }, 'Difficulty'), seg, assist);
  }

  /* ------------------------------------------------------------------ grand prix */

  private showCupSelect(): void {
    const el = h('div', {});
    const list = h('div', { class: 'menu-list' });
    for (const cup of CUPS) {
      const best = this.save.data.cups[cup.id];
      const names = cup.tracks.map((id) => TRACKS.find((t) => t.id === id)?.name ?? id).join(' · ');
      const b = this.btn(`${cup.name}${best ? `  ${best.bestPlace === 1 ? '🏆' : best.bestPlace <= 3 ? '🥈' : ''}` : ''}`, 'yellow', () => {
        this.gp = { cup, race: 0, points: new Map(), lastResults: [] };
        this.showCharacterSelect(0);
      }, `cup-${cup.id}`);
      list.append(b, h('div', { class: 'screen-sub', style: 'margin:-6px 0 8px' }, names));
    }
    el.append(h('div', { class: 'screen-title' }, 'Grand Prix'), h('div', { class: 'screen-sub' }, 'Four races. Points for every finish. One family champion.'), this.difficultyPicker(), list,
      h('div', { class: 'options-row' }, this.btn('Back', 'gray small', () => this.showMainMenu(), 'btn-back')));
    this.show('cup', el);
  }

  private startGrandPrix(): void {
    if (!this.gp) return;
    this.trackId = this.gp.cup.tracks[this.gp.race];
    this.startRace();
  }

  /* ------------------------------------------------------------------ race lifecycle */

  private async startRace(): Promise<void> {
    const def = trackById(this.trackId);
    const tt = this.mode === 'timetrial';
    const racers: RacerConfig[] = [];
    this.players.slice(0, this.mode === 'versus' ? 2 : 1).forEach((c, i) => racers.push({ character: c, playerIndex: i }));
    if (!tt) {
      // fill the grid with the rest of the family
      for (const c of CHARACTERS) if (!racers.some((r) => r.character === c.id)) racers.push({ character: c.id, playerIndex: -1 });
    }
    const raceDef: TrackDef = this.testFlags.laps ? { ...def, laps: this.testFlags.laps } : def;
    // loading screen
    const bar = h('div');
    const label = h('div', { class: 'tip' }, TIPS[Math.floor(Math.random() * TIPS.length)]);
    const loading = h('div', { class: 'loading-screen', style: 'background-image:url(poster.jpg)' },
      h('div', { class: 'loading-box' }, h('h2', {}, def.name), label, h('div', { class: 'boot-bar' }, bar)));
    this.show('loading', loading);
    this.setStage(null);
    this.stopAttract();
    this.disposeSession();
    await new Promise((r) => setTimeout(r, 30));
    const ghost = tt ? this.save.ghost(def.id) : undefined;
    const session = new RaceSession(this.renderer, this.input, {
      track: raceDef, racers, difficulty: this.difficulty, mode: tt ? 'timeTrial' : 'race', ghost,
      steeringAssist: [this.save.settings.steeringAssist, false],
    });
    this.input.setSplitScreen(this.mode === 'versus');
    await session.load((p) => (bar.style.width = `${p * 100}%`));
    this.session = session;
    this.resultsShown = false;
    this.autopilot = this.testFlags.autopilot ? session.players.map((k) => new AIDriver(k, session.sim, AI_DIFFICULTY.hard, 0.3)) : [];
    if (this.autopilot.length) this.installAutopilot(session);
    this.hud = new HUD(session.sim, session.players, this.portraits, tt, !!ghost);
    session.on((e) => {
      this.hud?.event(e);
      this.rumbleFor(e);
      if (e.type === 'go') this.touch?.recalibrate();
      if (e.type === 'raceOver') setTimeout(() => this.onRaceOver(), 2500);
    });
    session.setDebug(this.debug);
    this.ui.querySelectorAll('.screen').forEach((s) => s.remove());
    this.screenName = 'race';
    this.ui.append(this.hud.root);
    if (isTouchDevice() && this.mode !== 'versus') {
      this.touch = new TouchControls(this.ui, this.touchOptions);
      this.touch.onPause = () => this.togglePause();
      this.input.touch = this.touch;
    }
    session.startAudio();
  }

  /** Test/demo hook: drive the human karts with the AI. */
  private installAutopilot(session: RaceSession): void {
    const orig = this.input.kartInput.bind(this.input);
    this.input.kartInput = (player: number, dt?: number): KartInput => {
      const ap = this.autopilot[player];
      return ap && this.session === session ? ap.update(dt ?? 1 / 60) : orig(player, dt);
    };
  }

  private disposeSession(): void {
    this.touch?.dispose();
    this.touch = null;
    this.input.touch = null;
    this.session?.dispose();
    this.session = null;
    this.hud?.dispose();
    this.hud = null;
    this.pauseEl?.remove();
    this.pauseEl = null;
    if (this.autopilot.length) {
      this.input.kartInput = Input.prototype.kartInput.bind(this.input);
      this.autopilot = [];
    }
  }

  private onRaceOver(): void {
    const s = this.session;
    if (!s || this.resultsShown) return;
    this.resultsShown = true;
    const results = s.sim.results();
    const def = s.opts.track;
    const tt = this.mode === 'timetrial';
    const records: string[] = [];
    for (const r of results.filter((x) => x.isHuman)) {
      const counts = !this.testFlags.laps && r.finished;
      const res = this.save.submitRace(def.id, r.character, tt ? 1 : r.place, r.time, r.bestLap, counts);
      if (res.newBestLap) records.push(`New best lap ${formatTime(r.bestLap)}!`);
      if (res.newBestRace) records.push(`New track record ${formatTime(r.time)}!`);
    }
    if (tt && s.players[0]?.finished && !this.testFlags.laps) {
      const k = s.players[0];
      this.save.saveGhost(def.id, { character: k.character, time: k.finishTime, frames: s.ghostFrames });
    }
    if (this.gp) {
      results.forEach((r) => this.gp!.points.set(r.character, (this.gp!.points.get(r.character) ?? 0) + (GP_POINTS[r.place - 1] ?? 0)));
      this.gp.lastResults = results;
    }
    const sessionDef = s.opts.track;
    this.disposeSession();
    audio.startMusic('results');
    const top = results.slice(0, 3).map((r) => r.character);
    const human = results.find((r) => r.isHuman);
    if (human) audio.play(human.place <= 3 ? 'victory' : 'lose');
    this.setStage(new Podium(this.renderer, tt ? [human!.character] : top));
    this.showResults(results, sessionDef, records);
  }

  private showResults(results: RaceResult[], def: TrackDef, records: string[]): void {
    const tt = this.mode === 'timetrial';
    const table = h('table', { 'data-testid': 'results-table' });
    const best = Math.min(...results.map((r) => r.bestLap));
    results.forEach((r, i) => {
      const d = characterById(r.character);
      const row = h('tr', { class: r.isHuman ? 'me' : '', style: `animation-delay:${i * 0.12}s` },
        h('td', {}, `${r.place}${ordinal(r.place)}`),
        h('td', { html: `<img src="${this.portraits.get(r.character)}" alt="">${d.name}${r.isHuman && this.mode === 'versus' ? ` (P${r.playerIndex + 1})` : ''}` }),
        h('td', {}, r.finished ? formatTime(r.time) : 'DNF'),
        h('td', {}, `${r.bestLap === best ? '⚡' : ''}${formatTime(r.bestLap)}`));
      table.append(row);
    });
    const winner = results[0];
    const panel = h('div', { class: 'results panel', 'data-testid': 'results' },
      h('h2', {}, tt ? 'Time Trial' : this.gp ? `${this.gp.cup.name} — Race ${this.gp.race + 1}/4` : 'Race Results'),
      h('div', { class: 'screen-sub', style: 'margin:0 0 6px' }, def.name),
      h('div', { class: 'records' }, records.join(' ')),
      table);
    const row = h('div', { class: 'btn-row' });
    if (this.gp) {
      const last = this.gp.race >= this.gp.cup.tracks.length - 1;
      row.append(this.btn(last ? 'Final Standings' : 'Standings', 'yellow', () => this.showStandings(), 'btn-standings'));
    } else {
      row.append(
        this.btn('Race Again', 'green', () => this.startRace(), 'btn-replay'),
        this.btn('Change Track', 'blue', () => this.showTrackSelect(), 'btn-change-track'),
        this.btn('Main Menu', 'gray', () => this.backToMenu(), 'btn-main-menu'));
    }
    panel.append(row);
    const el = h('div', { class: 'pass-through' }, panel,
      h('div', { class: 'winner-banner' }, tt ? `${formatTime(winner.time)}` : `${characterById(winner.character).name} wins!`));
    this.show('results', el);
  }

  private showStandings(): void {
    const gp = this.gp!;
    const standings = [...CHARACTERS.map((c) => c.id)].sort((a, b) => (gp.points.get(b) ?? 0) - (gp.points.get(a) ?? 0));
    const last = gp.race >= gp.cup.tracks.length - 1;
    const table = h('table', { class: 'standings', 'data-testid': 'standings' });
    standings.forEach((id, i) => {
      const isMe = id === this.players[0];
      table.append(h('tr', { class: isMe ? 'me' : '' },
        h('td', {}, `${i + 1}${ordinal(i + 1)}`),
        h('td', { html: `<img src="${this.portraits.get(id)}" alt="">${characterById(id).name}` }),
        h('td', {}, `${gp.points.get(id) ?? 0} pts`)));
    });
    const panel = h('div', { class: 'results panel' },
      h('h2', {}, last ? `${gp.cup.name} Champion!` : `Standings after ${gp.race + 1}/4`), table);
    const row = h('div', { class: 'btn-row' });
    if (last) {
      const place = standings.indexOf(this.players[0]) + 1;
      this.save.submitCup(gp.cup.id, place, this.difficulty);
      this.setStage(new Podium(this.renderer, standings.slice(0, 3), standings.slice(3)));
      audio.play(place <= 3 ? 'victory' : 'lose');
      row.append(this.btn('Main Menu', 'green', () => {
        this.gp = null;
        this.backToMenu();
      }, 'btn-main-menu'));
      panel.append(h('div', { class: 'records' }, `You finished ${place}${ordinal(place)} overall!`));
    } else {
      row.append(this.btn(`Next: ${trackById(gp.cup.tracks[gp.race + 1]).name}`, 'green', () => {
        gp.race++;
        this.startGrandPrix();
      }, 'btn-next-race'), this.btn('Quit Cup', 'gray', () => {
        this.gp = null;
        this.backToMenu();
      }));
    }
    panel.append(row);
    this.show('standings', h('div', { class: 'pass-through' }, panel, last ? h('div', { class: 'winner-banner' }, `🏆 ${characterById(standings[0]).name}`) : null));
  }

  /* ------------------------------------------------------------------ pause */

  private togglePause(): void {
    const s = this.session;
    if (!s || this.resultsShown || s.sim.phase === 'finished') return;
    if (this.pauseEl) {
      this.pauseEl.remove();
      this.pauseEl = null;
      s.setPaused(false);
      return;
    }
    s.setPaused(true);
    this.touch?.reset();
    audio.play('menuBack');
    const list = h('div', { class: 'menu-list' },
      this.btn('Resume', 'green', () => this.togglePause(), 'btn-resume'),
      this.btn('Restart', 'blue', () => this.startRace(), 'btn-restart'),
      this.btn('Settings', 'gray', () => this.showSettings(), 'btn-pause-settings'),
      this.btn('Quit to Menu', '', () => {
        this.disposeSession();
        this.gp = null;
        this.input.setSplitScreen(false);
        this.backToMenu();
      }, 'btn-quit'));
    this.pauseEl = h('div', { class: 'modal-bg', 'data-testid': 'pause-menu' }, h('div', { class: 'modal panel' }, h('h2', {}, 'Paused'), list));
    this.ui.append(this.pauseEl);
    list.querySelector('button')?.focus();
  }

  /* ------------------------------------------------------------------ garage */

  private showGarage(): void {
    const room = new Showroom(this.renderer);
    this.stopAttract();
    this.setStage(room);
    let current: CharacterId = this.players[0];
    const info = h('div', { class: 'char-info panel' });
    const cards = h('div', { class: 'char-cards' });
    const recs = h('div', { class: 'panel garage-recs', style: 'position:fixed;right:3vw;top:18vh;width:min(340px,30vw);font-weight:700' });
    const refresh = () => {
      room.select(current);
      const d = characterById(current);
      info.innerHTML = `<h2 style="color:${d.colors.primary}">${d.name}</h2><div class="title">${d.title}</div><div class="tag">${d.tagline}</div>
        <div class="special-box"><b>⚡ ${d.special.name}</b>${d.special.description}<br><small>Cooldown ${d.special.cooldown}s</small></div>`;
      cards.querySelectorAll('.char-card').forEach((c) => c.classList.toggle('selected', (c as HTMLElement).dataset.id === current));
    };
    recs.innerHTML = `<div class="label" style="margin-bottom:6px">🏆 Records</div>` + TRACKS.map((t) => {
      const r = this.save.data.records[t.id];
      return `<div style="margin:6px 0"><div>${t.name}</div><small>Lap ${formatTime(r?.bestLap)} ${r?.bestLapBy ? '(' + characterById(r.bestLapBy).name + ')' : ''} · Race ${formatTime(r?.bestRace)} · Wins ${r?.wins ?? 0}</small></div>`;
    }).join('') + CUPS.map((c) => `<div><small>${c.name}: ${this.save.data.cups[c.id] ? 'Best ' + this.save.data.cups[c.id].bestPlace + ordinal(this.save.data.cups[c.id].bestPlace) : '—'}</small></div>`).join('');
    for (const c of CHARACTERS) {
      const card = h('button', { class: 'char-card', 'data-id': c.id, 'data-nav': true }, h('img', { src: this.portraits.get(c.id), alt: c.name }), c.name);
      card.addEventListener('click', () => {
        current = c.id;
        audio.play(c.id === 'lupin' ? 'bark' : 'menuMove');
        refresh();
      });
      cards.append(card);
    }
    this.show('garage', h('div', { class: 'char-screen' },
      h('div', { class: 'char-top' }, h('div', { class: 'screen-title' }, 'The Family Garage'), h('div', { class: 'screen-sub' }, 'Drag to spin the karts')),
      info, recs,
      h('div', {}, cards, h('div', { class: 'btn-row' }, this.btn('Back', 'gray small', () => this.backToMenu(), 'btn-back')))));
    refresh();
  }

  /* ------------------------------------------------------------------ settings */

  private showSettings(): void {
    const s = this.save.settings;
    const slider = (label: string, key: 'master' | 'music' | 'sfx') => {
      const input = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s[key], 'data-testid': `vol-${key}` });
      input.addEventListener('input', () => {
        this.save.updateSettings({ [key]: Number(input.value) });
        audio.setVolumes(this.save.settings.master, this.save.settings.music, this.save.settings.sfx);
      });
      return h('div', { class: 'row' }, h('span', {}, label), input);
    };
    const quality = h('select', {}, ...(['low', 'medium', 'high'] as const).map((q) => h('option', { value: q, selected: s.quality === q }, q[0].toUpperCase() + q.slice(1))));
    quality.addEventListener('change', () => {
      this.save.updateSettings({ quality: quality.value as 'low' | 'medium' | 'high', qualityChosen: true });
      this.renderer.setQuality(this.save.settings.quality);
    });
    const check = (label: string, key: 'steeringAssist' | 'showFps', after?: () => void) => {
      const c = h('input', { type: 'checkbox', checked: s[key] });
      c.addEventListener('change', () => {
        this.save.updateSettings({ [key]: c.checked });
        after?.();
      });
      return h('div', { class: 'row' }, h('span', {}, label), c);
    };
    const keys = h('div', { class: 'keys' });
    const map = this.input.keyMaps[0];
    const actions: Array<[Action, string]> = [['up', 'Accelerate'], ['down', 'Brake'], ['left', 'Left'], ['right', 'Right'], ['drift', 'Drift'], ['item', 'Item'], ['special', 'Special'], ['rear', 'Look back'], ['pause', 'Pause']];
    for (const [a, label] of actions) {
      const b = h('button', {}, `${label}: ${map[a][0]?.replace('Key', '') ?? '-'}`);
      b.addEventListener('click', () => {
        b.classList.add('listening');
        b.textContent = `${label}: press a key…`;
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          window.removeEventListener('keydown', onKey, true);
          const next = { ...this.input.keyMaps[0], [a]: [e.code, ...map[a].filter((c) => c !== e.code).slice(0, 1)] } as KeyMap;
          this.input.setKeyMap(0, next);
          this.save.updateSettings({ keys: next as unknown as Record<string, string[]> });
          b.classList.remove('listening');
          b.textContent = `${label}: ${e.code.replace('Key', '')}`;
        };
        window.addEventListener('keydown', onKey, true);
      });
      keys.append(b);
    }
    const resetKeys = h('button', { class: 'btn gray small', style: 'margin-top:8px' }, 'Reset controls');
    resetKeys.addEventListener('click', () => {
      this.input.setKeyMap(0, DEFAULT_KEYS_P1);
      this.save.updateSettings({ keys: undefined });
      close();
      this.showSettings();
    });
    const modal = h('div', { class: 'modal-bg', 'data-testid': 'settings' },
      h('div', { class: 'modal panel settings' },
        h('h2', {}, 'Settings'),
        slider('Master volume', 'master'), slider('Music', 'music'), slider('Sound effects', 'sfx'),
        h('div', { class: 'row' }, h('span', {}, 'Graphics quality'), quality),
        check('Steering assist (younger racers)', 'steeringAssist'),
        check('Show FPS', 'showFps', () => this.updateFpsVisibility()),
        isTouchDevice() ? this.touchSettings() : null,
        h('div', { class: 'kb-section' }, h('h3', {}, 'Controls (Player 1)'), keys, resetKeys),
        h('div', { style: 'font-size:13px;opacity:0.8;margin-top:8px' }, 'Xbox controller: RT gas · LT brake · Left stick / D-pad steer · RB or LB drift · Ⓐ item · Ⓧ special · Ⓨ look back · ☰ Menu pause · Ⓑ back. In 2-player, one controller goes to Player 2 (Player 1 uses the keyboard); with two controllers each player gets one. Press ` (backquote) for debug mode.'),
        h('div', { class: 'btn-row', style: 'margin-top:14px' }, this.btn('Done', 'green', () => close(), 'btn-settings-done'))));
    const close = () => {
      modal.remove();
      (this.pauseEl?.querySelector('button') as HTMLElement | null)?.focus();
    };
    this.ui.append(modal);
    modal.querySelector<HTMLElement>('input')?.focus();
  }

  /** Settings rows for the on-screen touch controls (only shown on touch devices). */
  private touchSettings(): HTMLElement {
    const o = this.touchOptions;
    const set = (patch: Partial<TouchOptions>) => this.save.updateSettings({ touch: { ...this.touchOptions, ...patch } });
    const check = (label: string, key: 'autoGas' | 'tilt' | 'leftHanded', testid: string) => {
      const c = h('input', { type: 'checkbox', checked: o[key], 'data-testid': testid });
      c.addEventListener('change', async () => {
        if (key === 'tilt' && c.checked && !(await requestTiltPermission())) {
          c.checked = false;
          return;
        }
        set({ [key]: c.checked });
      });
      return h('div', { class: 'row' }, h('span', {}, label), c);
    };
    const size = h('select', { 'data-testid': 'touch-size' }, ...(['s', 'm', 'l'] as const).map((v) => h('option', { value: v, selected: o.size === v }, { s: 'Small', m: 'Medium', l: 'Large' }[v])));
    size.addEventListener('change', () => set({ size: size.value as TouchOptions['size'] }));
    return h('div', {},
      h('h3', {}, 'Touch controls'),
      check('Automatic gas', 'autoGas', 'touch-autogas'),
      check('Tilt to steer (turn the device like a wheel)', 'tilt', 'touch-tilt'),
      check('Left-handed layout', 'leftHanded', 'touch-lefty'),
      h('div', { class: 'row' }, h('span', {}, 'Button size'), size),
      h('div', { style: 'font-size:13px;opacity:0.8' }, 'Tip: add the game to your home screen (Share → Add to Home Screen) to play fullscreen. Changes apply from the next race.'));
  }

  updateFpsVisibility(): void {
    if (this.save.settings.showFps && !this.fpsEl) {
      this.fpsEl = h('div', { class: 'fps' }, '');
      document.body.append(this.fpsEl);
    } else if (!this.save.settings.showFps && this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
    }
  }

  /* ------------------------------------------------------------------ input & debug */

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Backquote') {
      this.debug = !this.debug;
      this.session?.setDebug(this.debug);
      if (!this.debug) {
        this.debugEl?.remove();
        this.debugEl = null;
      }
      return;
    }
    if (this.session && this.screenName === 'race') {
      if ((e.code === 'Escape' || e.code === 'KeyP') && !document.querySelector('[data-testid=settings]')) this.togglePause();
      if (this.mode === 'versus' && e.code === 'Backspace') this.togglePause();
      if (this.debug) this.debugKey(e);
      return;
    }
    if (e.code === 'Escape') {
      const settings = document.querySelector('[data-testid=settings]');
      if (settings) return void settings.remove();
      const back = this.ui.querySelector<HTMLButtonElement>('[data-testid=btn-back]');
      back?.click();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !(document.activeElement instanceof HTMLInputElement)) {
      e.preventDefault();
      this.moveFocus(e.code === 'ArrowUp' || e.code === 'ArrowLeft' ? -1 : 1);
    }
  }

  /** Developer shortcuts while debug mode is on: 1-8 grant items, R restart, N next character, K autopilot. */
  private debugKey(e: KeyboardEvent): void {
    const s = this.session!;
    const items: ItemId[] = ['turboSoda', 'flyingPizza', 'bananaPeel', 'bubbleShield', 'giantDogBone', 'chicagoPothole', 'rocketKart', 'mysteryBox'];
    const n = Number(e.key);
    if (n >= 1 && n <= 8 && s.players[0]) {
      s.players[0].item = items[n - 1];
      s.players[0].itemRoulette = 0;
    }
    if (e.code === 'KeyR') this.startRace();
    if (e.code === 'KeyN') {
      const idx = CHARACTERS.findIndex((c) => c.id === this.players[0]);
      this.players[0] = CHARACTERS[(idx + 1) % CHARACTERS.length].id;
      this.startRace();
    }
    if (e.code === 'KeyO' && s.players[0]) s.players[0].specialCooldown = 0;
    if (e.code === 'KeyK') {
      this.testFlags.autopilot = !this.testFlags.autopilot;
      if (this.testFlags.autopilot) {
        this.autopilot = s.players.map((k) => new AIDriver(k, s.sim, AI_DIFFICULTY.hard, 0.3));
        this.installAutopilot(s);
      } else {
        this.input.kartInput = Input.prototype.kartInput.bind(this.input);
        this.autopilot = [];
      }
    }
  }

  private moveFocus(dir: number): void {
    const modals = this.ui.querySelectorAll('.modal-bg');
    const modal = modals[modals.length - 1];
    const scope = modal ? Array.from(modal.querySelectorAll<HTMLElement>('button, input, select')) : Array.from(this.ui.querySelectorAll<HTMLElement>('.screen [data-nav]:not([disabled])'));
    const items = scope.filter((x) => x.offsetParent !== null && !(x as HTMLButtonElement).disabled);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(idx + dir + items.length) % items.length];
    next.focus();
    audio.play('menuMove', { volume: 0.5 });
  }

  private titleGo: ((e?: Event) => void) | null = null;

  /** Android/desktop Chrome: fullscreen + landscape lock (iOS Safari has no fullscreen API; use Add to Home Screen). */
  private enterFullscreen(): void {
    const el = document.documentElement;
    if (!el.requestFullscreen || document.fullscreenElement) return;
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
    }).catch(() => {});
  }
  private touch: TouchControls | null = null;
  private get touchOptions(): TouchOptions {
    return { ...DEFAULT_TOUCH_OPTIONS, ...(this.save.settings.touch ?? {}) };
  }
  private touchMode = false;
  private padMode = false;

  /** Switch on-screen prompts between keyboard and Xbox controller glyphs. */
  private updateDeviceMode(): void {
    const touch = this.input.lastDevice === 'touch';
    if (touch !== this.touchMode) {
      this.touchMode = touch;
      document.body.classList.toggle('touch-mode', touch);
    }
    if (this.touch && this.session) {
      const k = this.session.players[0];
      if (k) this.touch.setAvailability(!!k.item, k.specialCooldown <= 0);
      this.touch.root.style.display = this.pauseEl || this.resultsShown ? 'none' : '';
    }
    const pad = this.input.lastDevice === 'gamepad';
    if (pad !== this.padMode) {
      this.padMode = pad;
      document.body.classList.toggle('pad-mode', pad);
    }
    // right stick spins the kart on the character showroom turntable
    if (this.stage instanceof Showroom) {
      const p = this.input.padFor(0);
      if (p && p.rx !== 0) this.stage.spinBy(p.rx * 0.06);
    }
  }

  /** Controller navigation for menus, pause and results (keyboard is handled in onKey). */
  private handleMenuInput(): void {
    const actions = this.input.consumeMenuActions();
    if (!actions.length) return;
    for (const { action: a } of actions) {
      if (this.screenName === 'title' && this.titleGo) {
        if (a === 'confirm' || a === 'pause') this.titleGo();
        return;
      }
      const settings = document.querySelector<HTMLElement>('[data-testid=settings]');
      if (this.session && this.screenName === 'race' && !settings) {
        if (a === 'pause') this.togglePause();
        else if (a === 'back' && this.pauseEl) this.togglePause();
        if (!this.pauseEl) continue; // racing: face buttons drive the kart, not the menu
      }
      const active = document.activeElement;
      if ((a === 'left' || a === 'right') && active instanceof HTMLInputElement && active.type === 'range') {
        if (a === 'right') active.stepUp();
        else active.stepDown();
        active.dispatchEvent(new Event('input', { bubbles: true }));
        continue;
      }
      if (a === 'up' || a === 'left') this.moveFocus(-1);
      else if (a === 'down' || a === 'right') this.moveFocus(1);
      else if (a === 'confirm') {
        const active = document.activeElement as HTMLElement | null;
        if (active && active !== document.body && this.ui.contains(active)) active.click();
        else this.moveFocus(1);
      } else if (a === 'back') {
        if (settings) settings.querySelector<HTMLButtonElement>('[data-testid=btn-settings-done]')?.click();
        else this.ui.querySelector<HTMLButtonElement>('[data-testid=btn-back]')?.click();
      } else if (a === 'pause' && this.screenName === 'menu') {
        (this.ui.querySelector('[data-testid=btn-quick-race]') as HTMLElement | null)?.click();
      }
    }
  }

  /** Controller rumble for the local players' big moments. */
  private rumbleFor(e: SimEvent): void {
    const s = this.session;
    if (!s) return;
    const player = (id: number) => s.sim.karts[id]?.playerIndex ?? -1;
    const buzz = (id: number, strong: number, weak: number, ms: number) => {
      const p = player(id);
      if (p >= 0) this.input.rumble(p, strong, weak, ms);
    };
    switch (e.type) {
      case 'hit': buzz(e.kart, 0.9, 0.6, 350); break;
      case 'wall': if (e.impact > 6) buzz(e.kart, 0.5, 0.3, 120); break;
      case 'bump': buzz(e.a, 0.3, 0.4, 90); buzz(e.b, 0.3, 0.4, 90); break;
      case 'land': if (e.impact > 8) buzz(e.kart, 0.4, 0.2, 100); break;
      case 'boost': buzz(e.kart, 0.15, 0.6, e.kind === 'drift3' || e.kind === 'rocket' ? 450 : 220); break;
      case 'driftTier': buzz(e.kart, 0, 0.25 + e.tier * 0.15, 80); break;
      case 'itemGranted': buzz(e.kart, 0, 0.3, 60); break;
      case 'finish': buzz(e.kart, 0.6, 0.8, 600); break;
      case 'go': for (const k of s.players) this.input.rumble(k.playerIndex, 0.3, 0.5, 200); break;
    }
  }

  private updateDebugOverlay(): void {
    const s = this.session;
    if (!s) return;
    if (!this.debugEl) {
      this.debugEl = h('div', { class: 'debug-overlay' });
      document.body.append(this.debugEl);
    }
    const k = s.players[0] ?? s.sim.karts[0];
    const ai = s.sim.ais.find((a) => a);
    this.debugEl.textContent = [
      `FPS ${this.fps.value.toFixed(0)}  sim t=${s.sim.time.toFixed(2)} step=${s.sim.stepCount}`,
      `speed ${k.forwardSpeed.toFixed(2)} m/s  vy ${k.vy.toFixed(2)}  grounded ${k.grounded}  surface ${k.surface}`,
      `pos ${k.pos.x.toFixed(1)}, ${k.pos.y.toFixed(1)}, ${k.pos.z.toFixed(1)}  yaw ${k.yaw.toFixed(2)}  path ${k.pathId}`,
      `mainS ${k.mainS.toFixed(1)} / ${s.track.length.toFixed(0)}  lateral ${k.lateral.toFixed(2)}  raceDist ${k.raceDistance.toFixed(1)}`,
      `lap ${k.lapsCompleted + 1}/${s.sim.laps}  checkpoint ${k.nextCheckpoint}/${s.track.checkpoints.length}  place ${k.place}`,
      `drift ${k.drift.active ? 'ON dir ' + k.drift.dir : 'off'} charge ${k.drift.charge.toFixed(2)} tier ${k.drift.tier}`,
      `boost ${k.boostTime.toFixed(2)}s (${k.boostKind}) power ${k.boostPower.toFixed(2)}  shield ${k.shieldTime.toFixed(1)}  invuln ${k.invulnTime.toFixed(1)}`,
      `item ${k.item ?? '-'}  special cd ${k.specialCooldown.toFixed(1)}  collisions ${k.stats.collisions}  respawns ${k.stats.respawns}`,
      ai ? `AI#1 target ${ai.target.x.toFixed(1)}, ${ai.target.z.toFixed(1)} idx ${ai.targetIndex()}` : '',
      `[1-8] give item  [O] special ready  [R] restart  [N] next character  [K] autopilot`,
    ].join('\n');
  }

  /** Test hook: fast-forward the current race simulation. */
  fastForward(seconds: number): void {
    this.session?.advance(seconds);
  }

  /** Exposed for automated browser tests. */
  get state(): { screen: string; phase?: string; time?: number; lap?: number; place?: number; speed?: number; fps: number } {
    const k = this.session?.players[0];
    return {
      screen: this.screenName, phase: this.session?.sim.phase, time: this.session?.sim.time, fps: this.fps.value,
      lap: k ? this.session!.sim.displayLap(k) : undefined, place: k?.place, speed: k?.forwardSpeed,
    };
  }
}

import * as THREE from 'three';
import { clamp, wrapAngle } from '../core/math';
import { audio, type EngineVoice } from '../audio/AudioEngine';
import { characterById } from '../data/characters';
import type { Input } from '../input/Input';
import type { GhostData } from '../persist/Save';
import { RaceSim, type RacerConfig } from '../sim/race/RaceSim';
import { Track } from '../sim/track/Track';
import type { CharacterId, Difficulty, KartInput, KartState, SimEvent, TrackDef } from '../sim/types';
import { ChaseCamera } from '../render/ChaseCamera';
import { Environment } from '../render/Environment';
import { ItemsView } from '../render/ItemsView';
import { KartView } from '../render/KartView';
import { Effects } from '../render/Particles';
import type { Renderer, Viewport } from '../render/Renderer';
import { SCENERY } from '../render/scenery';
import type { SceneryHandle } from '../render/scenery/types';
import { buildTrackView } from '../render/track/TrackView';
import { GhostView } from '../render/GhostView';

export interface SessionOptions {
  track: TrackDef;
  racers: RacerConfig[];
  difficulty: Difficulty;
  mode: 'race' | 'timeTrial' | 'attract';
  seed?: number;
  ghost?: GhostData;
  steeringAssist?: boolean[];
}

type SessionListener = (e: SimEvent) => void;

/**
 * One loaded race: simulation + 3D scene + cameras. Runs the fixed-timestep loop, converts input,
 * forwards sim events to audio / effects / UI, records ghost data in time trials.
 */
export class RaceSession {
  readonly sim: RaceSim;
  readonly scene = new THREE.Scene();
  readonly track: Track;
  readonly cameras: ChaseCamera[] = [];
  readonly kartViews: KartView[] = [];
  readonly players: KartState[];
  private env!: Environment;
  private trackView!: ReturnType<typeof buildTrackView>;
  private scenery: SceneryHandle | null = null;
  private sceneryGroup = new THREE.Group();
  private items!: ItemsView;
  private fx!: Effects;
  private acc = 0;
  private renderTime = 0;
  paused = false;
  private listeners: SessionListener[] = [];
  private engines: EngineVoice[] = [];
  private aiEngines: Array<{ voice: EngineVoice; kart: number }> = [];
  private ghostView: GhostView | null = null;
  ghostFrames: number[] = [];
  private ghostAcc = 0;
  private spectatorCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 4000);
  private spectatorTarget = 0;
  private spectatorTime = 0;
  private debugGroup: THREE.Group | null = null;
  debug = false;
  private lastInputs: KartInput[] = [];

  constructor(private renderer: Renderer, private input: Input | null, readonly opts: SessionOptions) {
    this.track = new Track(opts.track);
    this.sim = new RaceSim({
      track: this.track,
      racers: opts.racers,
      difficulty: opts.difficulty,
      seed: opts.seed ?? Math.floor(Math.random() * 1e9),
      mode: opts.mode === 'timeTrial' ? 'timeTrial' : 'race',
      timeLimit: opts.mode === 'attract' ? 1e9 : 900,
    });
    this.players = this.sim.karts.filter((k) => k.isHuman).sort((a, b) => a.playerIndex - b.playerIndex);
  }

  on(fn: SessionListener): void {
    this.listeners.push(fn);
  }

  async load(onProgress: (p: number, label: string) => void): Promise<void> {
    const q = this.renderer.quality;
    onProgress(0.1, 'Paving the track…');
    this.env = new Environment(this.scene, this.opts.track.lighting, q);
    this.trackView = buildTrackView(this.track, q);
    this.scene.add(this.trackView.group);
    await tick();
    onProgress(0.35, 'Building the neighborhood…');
    const builder = await SCENERY[this.opts.track.theme]();
    this.scene.add(this.sceneryGroup);
    this.scenery = builder({ track: this.track, group: this.sceneryGroup, quality: q });
    await tick();
    onProgress(0.65, 'Fueling the karts…');
    for (const k of this.sim.karts) {
      const v = new KartView(k, !k.isHuman && this.opts.mode !== 'attract');
      this.kartViews.push(v);
      this.scene.add(v.root);
    }
    this.items = new ItemsView(this.sim);
    this.scene.add(this.items.group);
    this.fx = new Effects(this.scene, q);
    if (this.opts.ghost && this.opts.mode === 'timeTrial') {
      this.ghostView = new GhostView(this.opts.ghost);
      this.scene.add(this.ghostView.root);
    }
    await tick();
    onProgress(0.85, 'Warming up the engines…');
    for (const p of this.players) {
      const cam = new ChaseCamera(this.track);
      this.cameras.push(cam);
      cam.snap(this.cameraTarget(p, 0));
    }
    // compile shaders up front to avoid hitches when racing starts
    this.updateViews(0, 1);
    this.renderer.gl.compile(this.scene, this.cameras[0]?.camera ?? this.spectatorCam);
    onProgress(1, 'Ready!');
  }

  startAudio(): void {
    if (this.opts.mode === 'attract') return;
    for (const p of this.players) this.engines.push(audio.createEngine(characterById(p.character).enginePitch));
    if (this.players.length === 1) {
      // two nearest AI voices, quiet
      for (let i = 0; i < 2; i++) this.aiEngines.push({ voice: audio.createEngine(1), kart: -1 });
    }
    audio.startMusic(this.opts.track.music);
  }

  private cameraTarget(k: KartState, viewIndex: number) {
    const v = this.kartViews[k.id];
    const pos = v ? v.interpPos.clone() : new THREE.Vector3(k.pos.x, k.pos.y, k.pos.z);
    return {
      pos, yaw: v ? v.interpYaw : k.yaw, speed: Math.max(0, k.forwardSpeed), maxSpeed: k.tuning.maxSpeed,
      boosting: k.boostTime > 0, drifting: k.drift.active, driftDir: k.drift.dir, airborne: !k.grounded,
      rearView: !!this.lastInputs[viewIndex]?.rearView,
    };
  }

  /** Called every animation frame with real elapsed seconds. */
  frame(dt: number): void {
    dt = Math.min(dt, 0.1);
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= this.sim.dt && steps < 6) {
        this.stepSim();
        this.acc -= this.sim.dt;
        steps++;
      }
      if (steps >= 6) this.acc = 0;
      this.renderTime += dt;
    }
    const alpha = this.paused ? 1 : clamp(this.acc / this.sim.dt, 0, 1);
    this.updateViews(this.paused ? 0 : dt, alpha);
    this.render(this.paused ? 0 : dt);
  }

  /** Test hook: advance the simulation quickly without rendering. */
  advance(seconds: number): void {
    const n = Math.round(seconds / this.sim.dt);
    for (let i = 0; i < n && this.sim.phase !== 'finished'; i++) this.stepSim();
  }

  private stepSim(): void {
    const inputs: KartInput[] = [];
    for (const p of this.players) {
      let inp = this.input ? this.input.kartInput(p.playerIndex, this.sim.dt) : { throttle: 0, steer: 0, drift: false, useItem: false, useSpecial: false };
      if (this.opts.steeringAssist?.[p.playerIndex]) inp = this.assist(p, inp);
      inputs[p.playerIndex] = inp;
    }
    this.lastInputs = inputs;
    this.sim.step(inputs);
    for (const e of this.sim.drainEvents()) {
      this.handleEvent(e);
      for (const l of this.listeners) l(e);
    }
    if (this.opts.mode === 'timeTrial' && this.sim.phase === 'racing' && this.players[0] && !this.players[0].finished) {
      this.ghostAcc += this.sim.dt;
      if (this.ghostAcc >= 0.1) {
        this.ghostAcc -= 0.1;
        const k = this.players[0];
        this.ghostFrames.push(round2(k.pos.x), round2(k.pos.y), round2(k.pos.z), round2(k.yaw));
      }
    }
  }

  /** Gentle steering assistance for younger players: blend toward the road ahead and away from walls. */
  private assist(k: KartState, inp: KartInput): KartInput {
    if (k.pathId !== 0 || k.drift.active) return inp;
    const look = 8 + Math.max(0, k.forwardSpeed) * 0.5;
    const target = this.track.pointAt(0, k.mainS + look, this.track.racingLineAt(k.mainS + look) * 0.5);
    const desired = Math.atan2(target.x - k.pos.x, target.z - k.pos.z);
    const err = wrapAngle(desired - k.yaw);
    const auto = clamp(-err * 2.2, -1, 1);
    const userWeight = Math.abs(inp.steer) > 0.1 ? 0.55 : 0;
    return { ...inp, steer: clamp(inp.steer * userWeight + auto * (1 - userWeight), -1, 1), throttle: inp.throttle === 0 ? 0.85 : inp.throttle };
  }

  private handleEvent(e: SimEvent): void {
    const isLocal = (id: number) => this.sim.karts[id]?.isHuman;
    const kpos = (id: number) => this.kartViews[id]?.interpPos;
    switch (e.type) {
      case 'countdown':
        audio.play('countdown');
        break;
      case 'go':
        audio.play('go');
        break;
      case 'lap':
        if (isLocal(e.kart)) audio.play('lap');
        break;
      case 'finalLap':
        if (isLocal(e.kart)) {
          audio.play('finalLap');
          audio.setMusicIntensity(1);
        }
        break;
      case 'finish':
        if (isLocal(e.kart)) {
          audio.play('finish');
          audio.play(e.place <= 3 ? 'cheer' : 'lose');
          const p = kpos(e.kart);
          if (p) this.fx.burst(p.x, p.y + 2, p.z, ['#ff4d6d', '#ffd23f', '#3ec1ff', '#7cff6a', '#ffffff'], 80, 10);
        }
        break;
      case 'itemPickup':
        if (isLocal(e.kart)) audio.play('itemPickup');
        break;
      case 'itemGranted':
        if (isLocal(e.kart)) audio.play('itemGranted');
        break;
      case 'itemUse': {
        const vol = this.volFor(e.kart);
        if (e.item === 'bubbleShield') audio.play('shield', { volume: vol });
        break;
      }
      case 'special': {
        const vol = this.volFor(e.kart);
        audio.play('special', { volume: vol });
        const ch = this.sim.karts[e.kart].character;
        if (ch === 'lupin') audio.play('bark', { volume: vol });
        if (ch === 'grandma') audio.play('laugh', { volume: vol, pitch: 1.3 });
        if (ch === 'dad') audio.play('laugh', { volume: vol, pitch: 0.75 });
        if (e.special === 'momShield') audio.play('shield', { volume: vol });
        const p = kpos(e.kart);
        if (p) this.fx.burst(p.x, p.y + 1.5, p.z, [characterById(ch).colors.primary, '#ffffff'], 30, 6);
        break;
      }
      case 'hit': {
        const vol = this.volFor(e.kart);
        audio.play('hit', { volume: vol });
        if (isLocal(e.kart)) {
          this.cameraFor(e.kart)?.addShake(0.8);
          audio.play(this.sim.karts[e.kart].character === 'lupin' ? 'bark' : 'ouch', { volume: 0.8 });
        }
        if (e.by >= 0 && this.sim.karts[e.by]?.character === 'grandma' && isLocal(e.by)) audio.play('laugh', { pitch: 1.3 });
        const p = kpos(e.kart);
        if (p) this.fx.burst(p.x, p.y + 1, p.z, ['#ffd23f', '#ffffff', '#ff7b2e'], 30, 7);
        break;
      }
      case 'shieldBlock':
        audio.play('shieldBlock', { volume: this.volFor(e.kart) });
        break;
      case 'boost':
        if (isLocal(e.kart)) audio.play('boost', { pitch: e.kind === 'drift3' ? 1.2 : 1 });
        else audio.play('boost', { volume: this.volFor(e.kart) * 0.5 });
        if (isLocal(e.kart)) this.cameraFor(e.kart)?.addShake(0.15);
        break;
      case 'driftStart':
        if (isLocal(e.kart)) audio.play('driftStart');
        break;
      case 'driftTier':
        if (isLocal(e.kart)) audio.play((`driftTier${e.tier}` as 'driftTier1'));
        break;
      case 'jump':
        if (isLocal(e.kart)) audio.play('jump', { volume: 0.6 });
        break;
      case 'land':
        if (isLocal(e.kart)) {
          audio.play('land', { volume: Math.min(1, e.impact / 10) });
          if (e.impact > 8) this.cameraFor(e.kart)?.addShake(0.25);
        }
        break;
      case 'bump': {
        const vol = Math.max(this.volFor(e.a), this.volFor(e.b));
        audio.play('bump', { volume: vol * Math.min(1, e.impact / 8) });
        const a = kpos(e.a), b = kpos(e.b);
        if (a && b) this.fx.glow.emit({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 0.8, z: (a.z + b.z) / 2, spread: 4, color: '#fff6a0', size: 0.4, life: 0.35, count: 10, gravity: 8 });
        if (isLocal(e.a) || isLocal(e.b)) this.cameraFor(isLocal(e.a) ? e.a : e.b)?.addShake(0.3);
        break;
      }
      case 'wall':
        if (isLocal(e.kart)) {
          audio.play('wall', { volume: Math.min(1, e.impact / 10) });
          this.cameraFor(e.kart)?.addShake(Math.min(0.5, e.impact / 20));
          const p = kpos(e.kart);
          if (p) this.fx.glow.emit({ x: p.x, y: p.y + 0.6, z: p.z, spread: 4, color: '#ffe08a', size: 0.3, life: 0.3, count: 12, gravity: 10 });
        }
        break;
      case 'respawn':
        if (isLocal(e.kart)) audio.play('respawn');
        break;
      case 'projectile':
        audio.play('launch', { volume: this.volFor(e.owner) });
        break;
      case 'drop':
        audio.play(e.kind === 'tennisBall' ? 'bark' : 'drop', { volume: this.volFor(e.owner) * (e.kind === 'tennisBall' ? 0.5 : 1) });
        break;
      case 'overtake':
        if (isLocal(e.kart) && this.sim.karts[e.kart].character === 'lupin') audio.play('bark', { volume: 0.5 });
        break;
      case 'raceOver':
        break;
    }
  }

  private volFor(kartId: number): number {
    const k = this.sim.karts[kartId];
    if (!k) return 0;
    if (k.isHuman) return 1;
    let best = Infinity;
    for (const p of this.players) best = Math.min(best, Math.hypot(p.pos.x - k.pos.x, p.pos.z - k.pos.z));
    if (!this.players.length) return 0.3;
    return clamp(1 - best / 60, 0, 1) * 0.8;
  }

  private cameraFor(kartId: number): ChaseCamera | undefined {
    const idx = this.players.findIndex((p) => p.id === kartId);
    return idx >= 0 ? this.cameras[idx] : undefined;
  }

  private updateViews(dt: number, alpha: number): void {
    const t = this.renderTime;
    for (const v of this.kartViews) v.update(dt, alpha, t, dt > 0 ? this.fx : null);
    this.items?.update(dt, t, alpha, dt > 0 ? this.fx : null);
    this.scenery?.update(dt, this.sim.time > 0 ? this.sim.time : t);
    this.trackView?.update(dt, t);
    this.ghostView?.update(this.sim.time);
    if (dt > 0) this.fx?.update(dt);
    // engines
    this.players.forEach((p, i) => {
      const e = this.engines[i];
      if (!e) return;
      const inp = this.lastInputs[p.playerIndex];
      e.update(Math.abs(p.forwardSpeed) / p.tuning.maxSpeed, inp?.throttle ?? 0, p.boostTime > 0, this.paused ? 0 : this.players.length > 1 ? 0.6 : 1);
    });
    if (this.aiEngines.length && this.players[0]) {
      const me = this.players[0];
      const others = this.sim.karts.filter((k) => !k.isHuman).sort((a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) - Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z));
      this.aiEngines.forEach((ae, i) => {
        const k = others[i];
        if (!k) return;
        const d = Math.hypot(k.pos.x - me.pos.x, k.pos.z - me.pos.z);
        ae.voice.update(Math.abs(k.forwardSpeed) / k.tuning.maxSpeed, 1, k.boostTime > 0, this.paused ? 0 : clamp(1 - d / 40, 0, 1) * 0.35);
      });
    }
    if (this.players[0]) audio.setDrift(!this.paused && this.players[0].drift.active && this.players[0].grounded, this.players[0].drift.tier);
    if (this.debug) this.updateDebug();
  }

  private render(dt: number): void {
    const viewports: Viewport[] = [];
    if (this.players.length === 0) {
      this.updateSpectator(dt);
      this.env.follow(this.kartViews[this.spectatorTarget]?.interpPos ?? new THREE.Vector3());
      this.fx.setViewportHeight(this.renderer.height);
      viewports.push({ camera: this.spectatorCam, rect: [0, 0, 1, 1] });
    } else {
      this.players.forEach((p, i) => {
        const cam = this.cameras[i];
        if (dt > 0) cam.update(this.cameraTarget(p, p.playerIndex), dt);
        const rect: [number, number, number, number] = this.players.length === 1 ? [0, 0, 1, 1] : i === 0 ? [0, 0.5, 1, 0.5] : [0, 0, 1, 0.5];
        viewports.push({ camera: cam.camera, rect });
      });
      this.env.follow(this.kartViews[this.players[0].id].interpPos);
      this.fx.setViewportHeight(this.renderer.height / this.players.length);
    }
    this.renderer.render(this.scene, viewports);
  }

  /** Cinematic TV-style camera used by the attract mode / menu background. */
  private updateSpectator(dt: number): void {
    this.spectatorTime -= dt;
    if (this.spectatorTime <= 0) {
      this.spectatorTime = 6 + Math.random() * 3;
      this.spectatorTarget = Math.floor(Math.random() * this.sim.karts.length);
    }
    const v = this.kartViews[this.spectatorTarget];
    if (!v) return;
    const phase = (this.renderTime * 0.15) % (Math.PI * 2);
    const yaw = v.interpYaw + Math.PI + Math.sin(phase) * 1.2;
    const d = 9 + Math.sin(phase * 0.5) * 2;
    const desired = new THREE.Vector3(v.interpPos.x + Math.sin(yaw) * d, v.interpPos.y + 3.2, v.interpPos.z + Math.cos(yaw) * d);
    const k = dt > 0 ? 1 - Math.exp(-3 * dt) : 1;
    if (this.spectatorCam.position.distanceTo(desired) > 60) this.spectatorCam.position.copy(desired);
    else this.spectatorCam.position.lerp(desired, k);
    this.spectatorCam.lookAt(v.interpPos.x, v.interpPos.y + 1, v.interpPos.z);
  }

  /** Debug visualisation: racing line, checkpoints and AI targets. */
  private updateDebug(): void {
    if (!this.debugGroup) {
      this.debugGroup = new THREE.Group();
      const pts: THREE.Vector3[] = [];
      const n = this.track.racingLine.length;
      const main = this.track.paths[0];
      for (let i = 0; i < n; i += 2) {
        const s = main.samples[i];
        const lat = this.track.racingLine[i];
        pts.push(new THREE.Vector3(s.x + s.nx * lat, s.y + 0.3, s.z + s.nz * lat));
      }
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#00ffcc' }));
      this.debugGroup.add(line);
      for (const cp of this.track.checkpoints) {
        const s = this.track.sampleAt(0, cp);
        const g = new THREE.Mesh(new THREE.BoxGeometry(s.halfWidth * 2, 3, 0.3), new THREE.MeshBasicMaterial({ color: '#ff00aa', transparent: true, opacity: 0.25 }));
        g.position.set(s.x, s.y + 1.5, s.z);
        g.rotation.y = Math.atan2(s.tx, s.tz);
        this.debugGroup.add(g);
      }
      for (let i = 0; i < this.sim.karts.length; i++) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ color: characterById(this.sim.karts[i].character).colors.primary }));
        m.name = `ai-target-${i}`;
        this.debugGroup.add(m);
      }
      this.scene.add(this.debugGroup);
    }
    this.debugGroup.visible = true;
    this.sim.ais.forEach((ai, i) => {
      const m = this.debugGroup!.getObjectByName(`ai-target-${i}`);
      if (!m) return;
      m.visible = !!ai;
      if (ai) m.position.set(ai.target.x, ai.target.y + 1, ai.target.z);
    });
    (this.trackView as { showDebug?: (on: boolean) => void }).showDebug?.(true);
  }

  setDebug(on: boolean): void {
    this.debug = on;
    if (!on && this.debugGroup) this.debugGroup.visible = false;
    (this.trackView as { showDebug?: (on: boolean) => void }).showDebug?.(on);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) audio.setDrift(false, 0);
    audio.setPaused(p);
  }

  dispose(): void {
    this.engines.forEach((e) => e.stop());
    this.aiEngines.forEach((e) => e.voice.stop());
    audio.setDrift(false, 0);
    this.kartViews.forEach((v) => v.dispose());
    this.items?.dispose();
    this.fx?.dispose();
    this.scenery?.dispose?.();
    this.trackView?.dispose();
    this.env?.dispose();
    this.ghostView?.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh || o instanceof THREE.Points || o instanceof THREE.Line) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.scene.clear();
    this.renderer.gl.renderLists.dispose();
  }

  get characterIds(): CharacterId[] {
    return this.sim.karts.map((k) => k.character);
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const round2 = (v: number) => Math.round(v * 100) / 100;

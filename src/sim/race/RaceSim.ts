import { Rng } from '../../core/rng';
import { characterById } from '../../data/characters';
import { AIDriver, AI_DIFFICULTY } from '../ai/AIDriver';
import { ItemSystem } from '../items/ItemSystem';
import { createKart, stepKart } from '../kart/KartPhysics';
import { PHYSICS, tuningFromStats } from '../kart/kartConfig';
import { Track } from '../track/Track';
import type { CharacterId, Difficulty, KartInput, KartState, MovingHazard, RacePhase, SimEvent, TrackDef } from '../types';
import { NO_INPUT } from '../types';
import { hitKart } from '../kart/KartPhysics';

export interface RacerConfig {
  character: CharacterId;
  /** Human player slot (0 or 1) or -1 for AI. */
  playerIndex: number;
}

export interface RaceConfig {
  track: TrackDef | Track;
  racers: RacerConfig[];
  difficulty: Difficulty;
  seed?: number;
  laps?: number;
  mode?: 'race' | 'timeTrial';
  countdown?: number;
  /** Seconds to keep racing after all humans finish before the race is called. */
  finishGrace?: number;
  /** Absolute time limit for headless runs. */
  timeLimit?: number;
}

export interface RaceResult {
  kart: number;
  character: CharacterId;
  place: number;
  time: number;
  bestLap: number;
  finished: boolean;
  isHuman: boolean;
  playerIndex: number;
}

/**
 * Authoritative race simulation. Fixed timestep, deterministic for a given seed and input stream.
 * Rendering, audio and UI only read from it (and consume `events`).
 */
export class RaceSim {
  readonly track: Track;
  readonly karts: KartState[] = [];
  readonly ais: Array<AIDriver | null> = [];
  readonly items: ItemSystem;
  readonly rng: Rng;
  readonly difficulty: Difficulty;
  readonly laps: number;
  readonly mode: 'race' | 'timeTrial';
  readonly movingHazards: MovingHazard[] = [];
  events: SimEvent[] = [];
  phase: RacePhase = 'countdown';
  /** Race clock: negative during countdown. */
  time: number;
  private prevDrift: boolean[] = [];
  private finishCount = 0;
  private firstHumanFinish = -1;
  private aiDoneAt = -1;
  private lastCountdown = 4;
  private readonly finishGrace: number;
  private readonly timeLimit: number;
  readonly dt = PHYSICS.dt;
  stepCount = 0;
  private placeOrder: number[] = [];
  /** Per kart: furthest raceDistance reached, and whether it was respawning last step. */
  private bestDistance: number[] = [];
  private respawned: boolean[] = [];

  constructor(cfg: RaceConfig) {
    this.track = cfg.track instanceof Track ? cfg.track : new Track(cfg.track);
    this.rng = new Rng(cfg.seed ?? 12345);
    this.difficulty = cfg.difficulty;
    this.mode = cfg.mode ?? 'race';
    this.laps = cfg.laps ?? this.track.def.laps;
    this.time = -(cfg.countdown ?? 3.5);
    this.finishGrace = cfg.finishGrace ?? 12;
    this.timeLimit = cfg.timeLimit ?? 600;
    const grid = this.track.startGrid(cfg.racers.length);
    // humans start at the back of the grid like a proper kart game
    const order = cfg.racers.map((r, i) => ({ r, i })).sort((a, b) => (a.r.playerIndex >= 0 ? 1 : 0) - (b.r.playerIndex >= 0 ? 1 : 0));
    order.forEach(({ r }, slot) => {
      const g = grid[slot];
      const def = characterById(r.character);
      const k = createKart(this.karts.length, r.character, tuningFromStats(def.stats), g.pos, g.yaw, g.s, r.playerIndex);
      k.raceDistance = g.s - this.track.length;
      k.specialCooldown = def.special.cooldown * 0.5;
      k.specialMax = def.special.cooldown;
      this.karts.push(k);
      this.ais.push(r.playerIndex >= 0 ? null : new AIDriver(k, this, AI_DIFFICULTY[this.difficulty], this.rng.next()));
      this.prevDrift.push(false);
    });
    this.items = new ItemSystem(this);
    this.track.def.hazards.forEach((h, i) => {
      const p = this.track.pointAt(0, h.t * this.track.length, 0);
      this.movingHazards.push({ id: i, def: h, pos: p, yaw: 0, radius: h.radius ?? 2, phase: i * 1.7 });
    });
    this.updatePlaces();
  }

  get humanKarts(): KartState[] {
    return this.karts.filter((k) => k.isHuman);
  }

  /** Advance one fixed step. `inputs[playerIndex]` supplies human input. */
  step(inputs: KartInput[] = []): void {
    const dt = this.dt;
    this.stepCount++;
    this.time += dt;
    if (this.phase === 'countdown') {
      const n = Math.ceil(-this.time);
      if (n < this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.events.push({ type: 'countdown', n });
      }
      if (this.time >= 0) {
        this.phase = 'racing';
        this.time = 0;
        this.events.push({ type: 'go' });
        for (const k of this.karts) k.lapStartTime = 0;
      } else {
        // during countdown karts are held still (AI and humans may "rev")
        for (const k of this.karts) {
          k.prevPos = { ...k.pos };
          k.prevYaw = k.yaw;
        }
        return;
      }
    }

    this.stepMovingHazards(dt);

    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      let input: KartInput;
      const ai = this.ais[i];
      if (k.finished) {
        // finished racers cruise on autopilot
        input = ai ? ai.update(dt) : this.autopilot(k, dt);
        input = { ...input, useItem: false, useSpecial: false };
      } else if (ai) {
        input = ai.update(dt);
      } else {
        input = inputs[k.playerIndex] ?? NO_INPUT;
      }
      const speedScale = ai ? ai.speedScale() : 1;
      stepKart(k, input, dt, this.track, this.time, this.events, this.prevDrift[i], speedScale);
      this.prevDrift[i] = input.drift;
      if (this.phase === 'racing' && !k.finished) {
        if (input.useItem) this.items.useItem(k);
        if (input.useSpecial) this.items.useSpecial(k);
      }
    }
    this.collideKarts();
    this.items.step(dt);
    this.updateProgress();
    this.updatePlaces();
    this.checkRaceOver();
  }

  private autopilotDrivers = new Map<number, AIDriver>();
  private autopilot(k: KartState, dt: number): KartInput {
    let d = this.autopilotDrivers.get(k.id);
    if (!d) {
      d = new AIDriver(k, this, AI_DIFFICULTY.easy, 0.5);
      this.autopilotDrivers.set(k.id, d);
    }
    return d.update(dt);
  }

  private stepMovingHazards(_dt: number): void {
    for (const h of this.movingHazards) {
      const period = h.def.period ?? 4;
      const sweep = h.def.sweep ?? 0;
      const L = this.track.length;
      const s = h.def.t * L;
      const lat = Math.sin(((this.time + h.phase) / period) * Math.PI * 2) * sweep;
      const p = this.track.pointAt(0, s, lat);
      h.pos = { x: p.x, y: p.y, z: p.z };
      const smp = this.track.sampleAt(0, s);
      h.yaw = Math.atan2(smp.tx, smp.tz);
      if (h.def.kind === 'train') continue; // decorative overhead train
      for (const k of this.karts) {
        const dx = k.pos.x - h.pos.x, dz = k.pos.z - h.pos.z;
        const r = h.radius + k.tuning.radius;
        if (dx * dx + dz * dz < r * r && k.pos.y - h.pos.y < 2.5) {
          if (h.def.kind === 'sprinkler') {
            // sprinklers just slow and wiggle you
            k.vel.x *= 0.985;
            k.vel.z *= 0.985;
            continue;
          }
          const d = Math.hypot(dx, dz) || 1;
          k.pos.x = h.pos.x + (dx / d) * r;
          k.pos.z = h.pos.z + (dz / d) * r;
          hitKart(k, -1, h.def.kind, this.events, 0.7);
        }
      }
    }
  }

  private collideKarts(): void {
    const ks = this.karts;
    for (let i = 0; i < ks.length; i++) {
      const a = ks[i];
      if (a.respawnTime > 0) continue;
      for (let j = i + 1; j < ks.length; j++) {
        const b = ks[j];
        if (b.respawnTime > 0) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const r = a.tuning.radius + b.tuning.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r || Math.abs(a.pos.y - b.pos.y) > 1.6) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, nz = dz / d;
        const overlap = r - d;
        const ma = a.tuning.mass * (a.rocketTime > 0 ? 4 : 1), mb = b.tuning.mass * (b.rocketTime > 0 ? 4 : 1);
        const wa = mb / (ma + mb), wb = ma / (ma + mb);
        a.pos.x -= nx * overlap * wa;
        a.pos.z -= nz * overlap * wa;
        b.pos.x += nx * overlap * wb;
        b.pos.z += nz * overlap * wb;
        const rv = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rv < 0) {
          const e = 0.6;
          const jimp = (-(1 + e) * rv) / (1 / ma + 1 / mb);
          const extra = 3; // playful bounce
          a.vel.x -= (nx * (jimp + extra)) / ma;
          a.vel.z -= (nz * (jimp + extra)) / ma;
          b.vel.x += (nx * (jimp + extra)) / mb;
          b.vel.z += (nz * (jimp + extra)) / mb;
          if (-rv > 2) {
            this.events.push({ type: 'bump', a: a.id, b: b.id, impact: -rv });
            a.stats.collisions++;
            b.stats.collisions++;
          }
          if (a.rocketTime > 0) hitKart(b, a.id, 'rocket', this.events, 0.7);
          if (b.rocketTime > 0) hitKart(a, b.id, 'rocket', this.events, 0.7);
        }
      }
    }
  }

  private updateProgress(): void {
    const L = this.track.length;
    const cpSpacing = L / this.track.checkpoints.length;
    for (const k of this.karts) {
      if (k.respawnTime > 0) {
        this.respawned[k.id] = true;
        continue;
      }
      let delta = k.mainS - (((k.raceDistance % L) + L) % L);
      if (delta > L / 2) delta -= L;
      if (delta < -L / 2) delta += L;
      if (this.respawned[k.id]) {
        // a respawn legitimately teleports the kart to its last safe spot (a place it has already driven):
        // resync progress, but never beyond the furthest point it has actually reached
        this.respawned[k.id] = false;
        delta = Math.min(delta, (this.bestDistance[k.id] ?? k.raceDistance) - k.raceDistance);
      } else if (Math.abs(delta) > 60) {
        // ignore implausible jumps (e.g. projection glitch)
        delta = 0;
      }
      k.raceDistance += delta;
      this.bestDistance[k.id] = Math.max(this.bestDistance[k.id] ?? -Infinity, k.raceDistance);
      if (this.phase !== 'racing' || k.finished) continue;
      // checkpoints: must be passed in order; a lap is completed only after all of them
      const nextCpDist = k.lapsCompleted * L + (k.nextCheckpoint + 1) * cpSpacing;
      if (k.raceDistance >= nextCpDist) {
        k.nextCheckpoint++;
        if (k.nextCheckpoint >= this.track.checkpoints.length) {
          k.nextCheckpoint = 0;
          k.lapsCompleted++;
          const lapTime = this.time - k.lapStartTime;
          k.lapTimes.push(lapTime);
          k.lastLapTime = lapTime;
          k.bestLapTime = Math.min(k.bestLapTime, lapTime);
          k.lapStartTime = this.time;
          if (k.lapsCompleted >= this.laps) {
            this.finishKart(k);
          } else {
            this.events.push({ type: 'lap', kart: k.id, lap: k.lapsCompleted + 1, time: lapTime });
            if (k.lapsCompleted === this.laps - 1) this.events.push({ type: 'finalLap', kart: k.id });
          }
        }
      }
      // wrong-way detection
      if (delta < -0.05 && Math.abs(k.forwardSpeed) > 3) k.wrongWayTime += this.dt;
      else k.wrongWayTime = Math.max(0, k.wrongWayTime - this.dt * 2);
    }
  }

  private finishKart(k: KartState): void {
    k.finished = true;
    k.finishTime = this.time;
    k.finishPlace = ++this.finishCount;
    k.reaction = k.finishPlace <= 3 ? 'win' : 'lose';
    k.reactionTime = 9999;
    k.item = null;
    this.events.push({ type: 'finish', kart: k.id, place: k.finishPlace, time: this.time });
    if (k.isHuman && this.firstHumanFinish < 0) this.firstHumanFinish = this.time;
  }

  private updatePlaces(): void {
    const prev = this.placeOrder;
    const order = [...this.karts].sort((a, b) => {
      if (a.finished && b.finished) return a.finishPlace - b.finishPlace;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.raceDistance - a.raceDistance;
    });
    order.forEach((k, i) => (k.place = i + 1));
    const ids = order.map((k) => k.id);
    if (prev.length && this.phase === 'racing') {
      // overtake detection: kart moved ahead of someone it was behind
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const was = prev.indexOf(id);
        if (was > i) {
          const passed = prev[i];
          const kk = this.karts[id];
          if (!kk.finished && passed !== undefined && passed !== id) {
            kk.stats.overtakes++;
            if (kk.reaction === 'none') {
              kk.reaction = 'overtake';
              kk.reactionTime = 0.9;
            }
            this.events.push({ type: 'overtake', kart: id, passed });
          }
        }
      }
    }
    this.placeOrder = ids;
  }

  private checkRaceOver(): void {
    if (this.phase !== 'racing') return;
    const humans = this.humanKarts;
    const allFinished = this.karts.every((k) => k.finished);
    const humansDone = humans.length > 0 && humans.every((k) => k.finished);
    const graceOver = humansDone && this.firstHumanFinish >= 0 && this.time - this.firstHumanFinish > this.finishGrace;
    // everyone else is home: give stragglers a short grace period, then call the race
    const ais = this.karts.filter((k) => !k.isHuman);
    if (ais.length && ais.every((k) => k.finished) && !humansDone) {
      if (this.aiDoneAt < 0) this.aiDoneAt = this.time;
    }
    const stragglerOver = this.aiDoneAt >= 0 && this.time - this.aiDoneAt > 20;
    if (allFinished || graceOver || stragglerOver || this.time > this.timeLimit || (this.mode === 'timeTrial' && humansDone)) {
      this.phase = 'finished';
      // award remaining places by progress
      const rest = this.karts.filter((k) => !k.finished).sort((a, b) => b.raceDistance - a.raceDistance);
      for (const k of rest) {
        k.finishPlace = ++this.finishCount;
        k.reaction = 'lose';
        k.reactionTime = 9999;
      }
      this.events.push({ type: 'raceOver' });
    }
  }

  results(): RaceResult[] {
    return [...this.karts]
      .sort((a, b) => (a.finishPlace || a.place) - (b.finishPlace || b.place))
      .map((k) => ({
        kart: k.id, character: k.character, place: k.finishPlace || k.place, time: k.finished ? k.finishTime : NaN,
        bestLap: k.bestLapTime, finished: k.finished, isHuman: k.isHuman, playerIndex: k.playerIndex,
      }));
  }

  /** Take and clear events produced since the last call. */
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Lap number to display (1-based, clamped). */
  displayLap(k: KartState): number {
    return Math.min(this.laps, Math.max(1, k.lapsCompleted + 1));
  }
}

import { clamp, forwardOf, mod, rightOf, wrapAngle, wrapDelta } from '../../core/math';
import { Rng } from '../../core/rng';
import { characterById } from '../../data/characters';
import type { RaceSim } from '../race/RaceSim';
import type { KartInput, KartState } from '../types';

export interface AIDifficultyConfig {
  speedScale: number;
  cornerGrip: number; // lateral accel budget used for target speed (m/s^2)
  lookahead: number;
  steerNoise: number;
  mistakeRate: number; // chance per second of a brief mistake
  itemDelay: [number, number];
  itemSkill: number; // 0..1 how smart item usage is
  driftSkill: number;
  shortcutBias: number;
  rubberBandAhead: number; // max slowdown fraction when far ahead of humans
  rubberBandBehind: number; // max speedup fraction when far behind
  specialRate: number;
}

export const AI_DIFFICULTY: Record<'easy' | 'normal' | 'hard', AIDifficultyConfig> = {
  easy: {
    speedScale: 0.84, cornerGrip: 22, lookahead: 1.0, steerNoise: 0.12, mistakeRate: 0.06, itemDelay: [2, 6], itemSkill: 0.3,
    driftSkill: 0.2, shortcutBias: 0.1, rubberBandAhead: 0.12, rubberBandBehind: 0.05, specialRate: 0.3,
  },
  normal: {
    speedScale: 0.94, cornerGrip: 30, lookahead: 1.0, steerNoise: 0.05, mistakeRate: 0.025, itemDelay: [0.8, 3], itemSkill: 0.65,
    driftSkill: 0.6, shortcutBias: 0.45, rubberBandAhead: 0.06, rubberBandBehind: 0.08, specialRate: 0.6,
  },
  hard: {
    speedScale: 1.0, cornerGrip: 38, lookahead: 1.05, steerNoise: 0.02, mistakeRate: 0.008, itemDelay: [0.3, 1.5], itemSkill: 0.95,
    driftSkill: 1, shortcutBias: 0.85, rubberBandAhead: 0.03, rubberBandBehind: 0.1, specialRate: 1,
  },
};

type AIState = 'race' | 'recover' | 'mistake';

/**
 * AI racer. Produces KartInput for the shared kart controller (no cheating, no teleporting).
 * Behaviour: racing-line following with curvature-based speed planning, drifting in long corners,
 * overtaking/avoidance via lane offsets, shortcut choice, item strategy and stuck recovery.
 */
export class AIDriver {
  private rng: Rng;
  private state: AIState = 'race';
  private stateTime = 0;
  private laneBias: number;
  private laneOffset = 0;
  private itemTimer = 0;
  private specialTimer = 0;
  private takingShortcut = -1;
  private shortcutDecided = new Set<number>();
  private holdDrift = false;
  private driftTime = 0;
  private personality;
  private reverseSteer = 0;
  /** Debug: last target point */
  target = { x: 0, y: 0, z: 0 };

  constructor(private k: KartState, private sim: RaceSim, private cfg: AIDifficultyConfig, seed: number) {
    this.rng = new Rng(Math.floor(seed * 1e9) + k.id * 7919);
    this.laneBias = this.rng.range(-0.25, 0.25);
    this.personality = characterById(k.character).ai;
    this.itemTimer = this.rng.range(cfg.itemDelay[0], cfg.itemDelay[1]);
    this.specialTimer = this.rng.range(3, 8);
  }

  /** Mild, configurable rubber-banding relative to the best human. */
  speedScale(): number {
    const humans = this.sim.humanKarts;
    let scale = this.cfg.speedScale;
    if (humans.length && !this.k.finished) {
      const best = Math.max(...humans.map((h) => h.raceDistance));
      const gap = this.k.raceDistance - best; // + = AI ahead
      if (gap > 0) scale *= 1 - this.cfg.rubberBandAhead * clamp(gap / 150, 0, 1);
      else scale *= 1 + this.cfg.rubberBandBehind * clamp(-gap / 200, 0, 1);
    }
    return scale;
  }

  update(dt: number): KartInput {
    const k = this.k;
    const sim = this.sim;
    const track = sim.track;
    const input: KartInput = { throttle: 1, steer: 0, drift: false, useItem: false, useSpecial: false };
    if (sim.phase !== 'racing') return { ...input, throttle: 0 };
    this.stateTime += dt;

    // --- recovery
    if (this.state === 'race' && Math.abs(k.forwardSpeed) < 1.5 && k.respawnTime <= 0 && k.spinTime <= 0) {
      if (this.stateTime > 1.2) {
        this.state = 'recover';
        this.stateTime = 0;
        this.reverseSteer = this.rng.chance(0.5) ? 1 : -1;
      }
    } else if (this.state === 'race' && Math.abs(k.forwardSpeed) >= 1.5) {
      this.stateTime = 0;
    }
    if (this.state === 'recover') {
      if (this.stateTime > 1.0) {
        this.state = 'race';
        this.stateTime = 0;
      }
      return { throttle: -1, steer: -this.reverseSteer, drift: false, useItem: false, useSpecial: false };
    }
    if (this.state === 'mistake') {
      if (this.stateTime > 0.5) {
        this.state = 'race';
        this.stateTime = 0;
      }
    } else if (this.rng.chance(this.cfg.mistakeRate * dt)) {
      this.state = 'mistake';
      this.stateTime = 0;
    }

    // --- choose path (shortcuts)
    const L = track.length;
    if (this.takingShortcut < 0 && k.pathId === 0) {
      for (let i = 1; i < track.paths.length; i++) {
        const sc = track.paths[i].shortcut!;
        const entry = sc.from * L;
        const ahead = wrapDelta(entry - k.mainS, L);
        if (ahead > 0 && ahead < 45 && !this.shortcutDecided.has(i)) {
          this.shortcutDecided.add(i);
          const appeal = sc.aiAppeal * this.cfg.shortcutBias * (0.6 + this.personality.risk * 0.6);
          if (this.rng.chance(appeal)) this.takingShortcut = i;
        }
        if (ahead < -60) this.shortcutDecided.delete(i);
      }
    }
    if (k.pathId > 0) this.takingShortcut = k.pathId;

    const speed = Math.max(0, k.forwardSpeed);
    const look = (7 + speed * 0.45) * this.cfg.lookahead;
    let tx: number, tz: number;
    let pathCurv = 0;
    let onShortcut = false;
    if (this.takingShortcut > 0) {
      const p = track.paths[this.takingShortcut];
      // project onto shortcut to find our s
      const startS = 0;
      let sOn = startS;
      if (k.pathId === this.takingShortcut) {
        const q = track.query(k.pos, this.takingShortcut);
        sOn = q && q.pathId === this.takingShortcut ? q.s : 0;
      } else {
        // approach the shortcut entrance; abandon it if we've already passed the junction
        const aheadMain = wrapDelta(p.shortcut!.from * L - k.mainS, L);
        if (aheadMain < -4) {
          this.takingShortcut = -1;
          return this.update(dt);
        }
        sOn = -aheadMain;
      }
      if (sOn + look >= p.length - 2) {
        // exit shortcut onto main
        const exitMain = p.shortcut!.to * L;
        const over = sOn + look - p.length;
        const pt = track.pointAt(0, exitMain + over, 0);
        tx = pt.x;
        tz = pt.z;
        if (k.pathId === 0 && sOn >= p.length - 4) this.takingShortcut = -1;
      } else {
        const pt = track.pointAt(this.takingShortcut, Math.max(0, sOn + look), 0);
        tx = pt.x;
        tz = pt.z;
        onShortcut = true;
        for (let s = Math.max(0, sOn); s < sOn + look * 2 && s < p.length; s += 4) {
          const c = Math.abs(track.sampleAt(this.takingShortcut, s).curvature);
          if (c > pathCurv) pathCurv = c;
        }
      }
    } else {
      const s = k.mainS + look;
      const racing = track.racingLineAt(s);
      const smp = track.sampleAt(0, s);
      this.updateLane(dt, smp.halfWidth);
      const lat = clamp(racing + this.laneOffset + this.laneBias * smp.halfWidth, -smp.halfWidth * 0.8, smp.halfWidth * 0.8);
      tx = smp.x + smp.nx * lat;
      tz = smp.z + smp.nz * lat;
    }
    this.target = { x: tx, y: k.pos.y, z: tz };

    // --- steering
    const desired = Math.atan2(tx - k.pos.x, tz - k.pos.z);
    const err = wrapAngle(desired - k.yaw);
    // yaw decreasing = right; steer + = right
    let steer = clamp(-err * 2.6, -1, 1);
    steer += this.rng.range(-1, 1) * this.cfg.steerNoise;
    if (this.state === 'mistake') steer = clamp(steer + (k.id % 2 ? 0.6 : -0.6), -1, 1);

    // --- speed planning from upcoming curvature
    let maxCurv = pathCurv;
    if (!onShortcut) {
      const horizon = 10 + speed * 1.4;
      for (let d = 4; d < horizon; d += 4) {
        const c = Math.abs(track.sampleAt(0, k.mainS + d).curvature);
        if (c > maxCurv) maxCurv = c;
      }
    }
    const grip = this.cfg.cornerGrip * (k.surface === 'ice' ? 0.45 : 1);
    const targetSpeed = maxCurv > 1e-4 ? Math.sqrt(grip / maxCurv) : 99;
    let throttle = 1;
    if (speed > targetSpeed + 3) throttle = -0.6;
    else if (speed > targetSpeed) throttle = 0.2;
    if (Math.abs(err) > 1.4 && speed > 8) throttle = Math.min(throttle, 0.1);

    // --- drifting through long corners
    const driftWanted = this.cfg.driftSkill * this.personality.drift > 0.25 && maxCurv > 0.018 && speed > 16 && !onShortcut && k.surface !== 'ice';
    if (k.drift.active) {
      this.driftTime += dt;
      const sameDir = Math.sign(-err) === k.drift.dir || Math.abs(err) < 0.05;
      const targetTier = this.cfg.driftSkill > 0.8 ? 3 : this.cfg.driftSkill > 0.4 ? 2 : 1;
      const keep = sameDir && maxCurv > 0.008 && !(k.drift.tier >= targetTier && maxCurv < 0.012) && this.driftTime < 4;
      this.holdDrift = keep;
      // in a drift, steering modulates tightness
      steer = clamp(-err * 3, -1, 1);
    } else {
      this.driftTime = 0;
      if (driftWanted && Math.abs(steer) > 0.45 && k.grounded) this.holdDrift = !this.holdDrift ? true : this.holdDrift;
      else if (!k.drift.hopPending) this.holdDrift = false;
    }
    if (this.holdDrift && maxCurv > 0.018) throttle = Math.max(throttle, 0.6);

    input.throttle = throttle;
    input.steer = steer;
    input.drift = this.holdDrift;

    // --- items
    this.thinkItems(dt, input);
    return input;
  }

  private updateLane(dt: number, halfWidth: number): void {
    const k = this.k;
    // avoid / overtake karts directly ahead
    let want = 0;
    const f = forwardOf(k.yaw);
    const r = rightOf(k.yaw);
    for (const o of this.sim.karts) {
      if (o === k) continue;
      const dx = o.pos.x - k.pos.x, dz = o.pos.z - k.pos.z;
      const ahead = dx * f.x + dz * f.z;
      const side = dx * r.x + dz * r.z;
      if (ahead > 0 && ahead < 14 && Math.abs(side) < 2.6 && o.forwardSpeed < k.forwardSpeed + 2) {
        want += (side > 0 ? -1 : 1) * halfWidth * 0.45 * this.personality.aggression;
      }
    }
    // dodge dropped hazards
    for (const h of this.sim.items.hazards) {
      if (h.owner === k.id && h.age < 1) continue;
      const dx = h.pos.x - k.pos.x, dz = h.pos.z - k.pos.z;
      const ahead = dx * f.x + dz * f.z;
      const side = dx * r.x + dz * r.z;
      if (ahead > 0 && ahead < 22 && Math.abs(side) < 2.5) want += (side > 0 ? -1 : 1) * halfWidth * 0.5 * this.cfg.itemSkill;
    }
    want = clamp(want, -halfWidth * 0.7, halfWidth * 0.7);
    this.laneOffset += (want - this.laneOffset) * Math.min(1, dt * 2.5);
  }

  private thinkItems(dt: number, input: KartInput): void {
    const k = this.k;
    const sim = this.sim;
    this.specialTimer -= dt;
    if (k.specialCooldown <= 0 && this.specialTimer <= 0) {
      this.specialTimer = this.rng.range(1, 4) / Math.max(0.2, this.cfg.specialRate);
      if (this.shouldUseSpecial()) input.useSpecial = true;
    }
    if (!k.item) {
      this.itemTimer = this.rng.range(this.cfg.itemDelay[0], this.cfg.itemDelay[1]);
      return;
    }
    this.itemTimer -= dt;
    if (this.itemTimer > 0) return;
    const skill = this.cfg.itemSkill;
    const ahead = sim.items.targetAhead(k);
    const aheadGap = ahead >= 0 ? sim.karts[ahead].raceDistance - k.raceDistance : Infinity;
    const behindClose = sim.karts.some((o) => o !== k && k.raceDistance - o.raceDistance > 0 && k.raceDistance - o.raceDistance < 25);
    const straight = Math.abs(sim.track.sampleAt(0, k.mainS + 30).curvature) < 0.01;
    let use = false;
    switch (k.item) {
      case 'flyingPizza':
        use = aheadGap < 120 || this.rng.chance(1 - skill);
        break;
      case 'giantDogBone': {
        const f = forwardOf(k.yaw);
        use = sim.karts.some((o) => {
          if (o === k) return false;
          const dx = o.pos.x - k.pos.x, dz = o.pos.z - k.pos.z;
          const a = dx * f.x + dz * f.z;
          return a > 4 && a < 50 && Math.abs(dx * -f.z + dz * f.x) < 3;
        }) || this.rng.chance((1 - skill) * 0.5);
        break;
      }
      case 'bananaPeel':
      case 'chicagoPothole':
        use = behindClose || this.rng.chance(0.2 * (1 - skill));
        break;
      case 'bubbleShield':
        // defensive: hold it until a projectile is incoming or we are leading with someone close
        use = sim.items.projectiles.some((p) => p.target === k.id) || (k.place === 1 && behindClose && this.rng.chance(0.3)) || this.rng.chance(0.05 * (1 - skill));
        break;
      case 'turboSoda':
      case 'rocketKart':
        use = straight || k.offroad || this.rng.chance(1 - skill);
        break;
      case 'mysteryBox':
        use = true;
        break;
    }
    if (use) {
      input.useItem = true;
      this.itemTimer = this.rng.range(this.cfg.itemDelay[0], this.cfg.itemDelay[1]);
    } else {
      this.itemTimer = 0.4;
    }
  }

  private shouldUseSpecial(): boolean {
    const k = this.k;
    const sim = this.sim;
    const id = characterById(k.character).special.id;
    const straight = Math.abs(sim.track.sampleAt(0, k.mainS + 35).curvature) < 0.01;
    switch (id) {
      case 'dadBoost':
        return straight || k.offroad;
      case 'momShield':
        return sim.items.projectiles.some((p) => p.target === k.id) || k.place <= 2;
      case 'turboDrift':
        return Math.abs(sim.track.sampleAt(0, k.mainS + 25).curvature) > 0.015;
      case 'lightningDash':
        return sim.karts.some((o) => o !== k && Math.hypot(o.pos.x - k.pos.x, o.pos.z - k.pos.z) < 6) || straight;
      case 'puppyPanic':
        return sim.karts.some((o) => o !== k && k.raceDistance - o.raceDistance > 0 && k.raceDistance - o.raceDistance < 30);
      case 'grandmasRevenge': {
        const a = sim.items.targetAhead(k);
        return a >= 0 && sim.karts[a].raceDistance - k.raceDistance < 150;
      }
    }
    return false;
  }

  /** Debug helper: index of racing-line sample targeted. */
  targetIndex(): number {
    const n = this.sim.track.racingLine.length;
    return mod(Math.floor((this.k.mainS / this.sim.track.length) * n), n);
  }
}

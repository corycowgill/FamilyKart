import { clamp, forwardOf, rightOf, sign, type Vec3 } from '../../core/math';
import type { Track } from '../track/Track';
import type { CharacterId, KartInput, KartState, KartTuning, SimEvent, SurfaceType } from '../types';
import { DRIFT_TIERS, PHYSICS } from './kartConfig';

export function createKart(id: number, character: CharacterId, tuning: KartTuning, pos: Vec3, yaw: number, mainS: number, playerIndex = -1): KartState {
  return {
    id, character, isHuman: playerIndex >= 0, playerIndex, tuning,
    pos: { ...pos }, prevPos: { ...pos }, yaw, prevYaw: yaw, vel: { x: 0, y: 0, z: 0 }, vy: 0,
    grounded: true, airTime: 0, forwardSpeed: 0, steerVisual: 0, suspension: 0, suspensionVel: 0,
    drift: { active: false, dir: 0, charge: 0, tier: 0, hopPending: false },
    boostTime: 0, boostPower: 0, boostKind: 'none', spinTime: 0, spinDir: 1, invulnTime: 0, shieldTime: 0, rocketTime: 0, turboDriftTime: 0,
    offroad: false, surface: 'road', groundY: pos.y, pathId: 0, sampleHint: 0, mainS, lateral: 0,
    raceDistance: mainS, lapsCompleted: 0, nextCheckpoint: 0, lastLapTime: 0, bestLapTime: Infinity, lapStartTime: 0, lapTimes: [],
    finished: false, finishTime: 0, finishPlace: 0, place: id + 1,
    item: null, itemRoulette: 0, specialCooldown: 0, specialMax: 20,
    stuckTime: 0, respawnTime: 0, lastSafe: { pos: { ...pos }, yaw, mainS, pathId: 0 }, wrongWayTime: 0,
    stats: { overtakes: 0, collisions: 0, itemsUsed: 0, hitsTaken: 0, respawns: 0, driftBoosts: 0, offTrack: 0 },
    reaction: 'none', reactionTime: 0,
  };
}

export function applyBoost(k: KartState, duration: number, power: number, kind: KartState['boostKind']): void {
  k.boostTime = Math.max(k.boostTime, duration);
  k.boostPower = Math.max(k.boostTime > duration ? k.boostPower : 0, power);
  k.boostKind = kind;
}

const surfaceGrip: Record<SurfaceType, number> = { road: 1, offroad: 0.85, ice: 0.22, mud: 0.7, milk: 0.35 };
const surfaceDrag: Record<SurfaceType, number> = { road: 0, offroad: 1, ice: 0, mud: 1.2, milk: 0.2 };

/**
 * Advance one kart by one fixed timestep. Shared by human and AI racers.
 * Pure arcade model: velocity is decomposed into forward/lateral components relative to heading,
 * lateral velocity is bled off by grip (low grip while drifting => slide).
 */
export function stepKart(k: KartState, input: KartInput, dt: number, track: Track, time: number, events: SimEvent[], prevDrift: boolean, speedScale = 1): void {
  const t = k.tuning;
  k.prevPos.x = k.pos.x;
  k.prevPos.y = k.pos.y;
  k.prevPos.z = k.pos.z;
  k.prevYaw = k.yaw;

  if (k.respawnTime > 0) {
    k.respawnTime -= dt;
    k.vel.x = k.vel.z = 0;
    k.vy = 0;
    if (k.respawnTime <= 0) {
      k.pos = { ...k.lastSafe.pos };
      k.prevPos = { ...k.pos };
      k.yaw = k.prevYaw = k.lastSafe.yaw;
      k.pathId = k.lastSafe.pathId;
      k.invulnTime = Math.max(k.invulnTime, 1.5);
      k.forwardSpeed = 0;
    }
    return;
  }

  const spinning = k.spinTime > 0;
  const throttle = spinning ? 0 : input.throttle;
  let steer = spinning ? 0 : clamp(input.steer, -1, 1);
  if (k.rocketTime > 0) steer *= 0.5;

  const fwd = forwardOf(k.yaw);
  const right = rightOf(k.yaw);
  let fs = k.vel.x * fwd.x + k.vel.z * fwd.z;
  let ls = k.vel.x * right.x + k.vel.z * right.z;

  const grip = surfaceGrip[k.surface];
  const boosting = k.boostTime > 0;
  let maxSpeed = t.maxSpeed * speedScale;
  if (k.offroad && !boosting && k.rocketTime <= 0) maxSpeed *= t.offroadPenalty;
  if (k.surface === 'mud' && !boosting) maxSpeed *= 0.6;
  if (boosting) maxSpeed *= 1 + k.boostPower;

  // --- longitudinal
  if (k.grounded) {
    if (boosting) {
      if (fs < maxSpeed) fs = Math.min(maxSpeed, fs + t.acceleration * 3 * dt);
    } else if (throttle > 0) {
      const headroom = Math.max(0.12, 1 - fs / maxSpeed);
      fs += t.acceleration * throttle * headroom * 1.6 * dt;
    } else if (throttle < 0) {
      if (fs > 0.5) fs -= t.brake * -throttle * dt;
      else fs = Math.max(-t.reverseSpeed, fs - t.acceleration * 0.8 * -throttle * dt);
    } else {
      fs -= sign(fs) * Math.min(Math.abs(fs), 4 * dt);
    }
    if (fs > maxSpeed) fs = Math.max(maxSpeed, fs - (14 + surfaceDrag[k.surface] * 10) * dt);
    fs -= fs * surfaceDrag[k.surface] * 0.3 * dt;
  }

  // --- drift state machine
  const driftPressed = input.drift && !prevDrift;
  const d = k.drift;
  if (driftPressed && k.grounded && !spinning && fs > 4) {
    k.vy = PHYSICS.hopVelocity;
    k.grounded = false;
    d.hopPending = true;
    events.push({ type: 'jump', kart: k.id });
  }
  if (d.active) {
    const charging = k.turboDriftTime > 0 ? 2.1 : 1;
    const k01 = (steer * d.dir + 1) / 2;
    if (k.grounded) d.charge += dt * (0.55 + 0.9 * k01) * charging;
    const newTier = (d.charge >= DRIFT_TIERS[2].charge ? 3 : d.charge >= DRIFT_TIERS[1].charge ? 2 : d.charge >= DRIFT_TIERS[0].charge ? 1 : 0) as 0 | 1 | 2 | 3;
    if (newTier > d.tier) {
      d.tier = newTier;
      events.push({ type: 'driftTier', kart: k.id, tier: newTier });
    }
    const cancel = !input.drift || fs < PHYSICS.minDriftSpeed * 0.7 || spinning || k.offroad && k.surface === 'offroad' && fs < 12;
    if (cancel) {
      if (d.tier > 0 && input.drift === false && !spinning) {
        const tier = DRIFT_TIERS[d.tier - 1];
        const mult = k.turboDriftTime > 0 ? 1.35 : 1;
        applyBoost(k, tier.duration * mult, tier.power * mult, (`drift${d.tier}` as KartState['boostKind']));
        k.stats.driftBoosts++;
        events.push({ type: 'boost', kart: k.id, kind: k.boostKind });
      }
      d.active = false;
      d.charge = 0;
      d.tier = 0;
      d.dir = 0;
    }
  }

  // --- steering / yaw
  const speedFactor = clamp(Math.abs(fs) / 7, 0, 1) * (1 - 0.42 * clamp(fs / t.maxSpeed, 0, 1));
  let yawRate: number;
  if (d.active) {
    const k01 = (steer * d.dir + 1) / 2; // 0 = counter-steer, 1 = into drift
    yawRate = -d.dir * t.driftSteer * (0.45 + 0.75 * k01) * clamp(fs / 10, 0.4, 1);
  } else {
    yawRate = -steer * t.steer * speedFactor * sign(fs || 1);
    if (!k.grounded) yawRate *= 0.6;
  }
  if (spinning) {
    yawRate = k.spinDir * 11;
    k.spinTime -= dt;
  }
  const dyaw = yawRate * dt;
  k.yaw += dyaw;
  if (k.yaw > Math.PI) k.yaw -= Math.PI * 2;
  if (k.yaw < -Math.PI) k.yaw += Math.PI * 2;


  // rotate velocity partially with the heading (traction); the remainder becomes lateral slip
  const nf = forwardOf(k.yaw), nr = rightOf(k.yaw);
  let vx = fwd.x * fs + right.x * ls;
  let vz = fwd.z * fs + right.z * ls;
  if (spinning) {
    const decay = Math.exp(-2.5 * dt);
    vx *= decay;
    vz *= decay;
  } else if (k.grounded) {
    const a = dyaw * (d.active ? 0.6 : t.traction) * Math.min(1, grip * 1.6);
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = vx * ca + vz * sa;
    const rz = vz * ca - vx * sa;
    fs = rx * nf.x + rz * nf.z;
    ls = rx * nr.x + rz * nr.z;
    ls *= Math.exp(-(d.active ? t.driftGrip : t.lateralGrip) * grip * dt);
    vx = nf.x * fs + nr.x * ls;
    vz = nf.z * fs + nr.z * ls;
  }
  k.vel.x = vx;
  k.vel.z = vz;
  k.forwardSpeed = k.vel.x * nf.x + k.vel.z * nf.z;

  // --- integrate
  k.pos.x += k.vel.x * dt;
  k.pos.z += k.vel.z * dt;
  k.vy -= PHYSICS.gravity * dt;
  k.pos.y += k.vy * dt;

  // --- track contact
  const q = track.query(k.pos, k.pathId);
  if (!q) {
    beginRespawn(k, events);
    return;
  }
  k.pathId = q.contained ? q.pathId : k.pathId;
  k.mainS = q.mainS;
  k.lateral = q.lateral;
  k.surface = q.surface;
  k.offroad = q.surface === 'offroad';

  // walls
  const limit = q.wallDist - t.radius * 0.6;
  if (!q.contained && Math.abs(q.lateral) > limit && !q.inGap) {
    const side = sign(q.lateral);
    const push = Math.abs(q.lateral) - limit;
    k.pos.x -= q.nx * side * push;
    k.pos.z -= q.nz * side * push;
    const vn = (k.vel.x * q.nx + k.vel.z * q.nz) * side;
    if (vn > 0) {
      k.vel.x -= q.nx * side * vn * (1 + PHYSICS.wallBounce);
      k.vel.z -= q.nz * side * vn * (1 + PHYSICS.wallBounce);
      // steer the kart gently along the wall so it never gets wedged
      const along = k.vel.x * q.tx + k.vel.z * q.tz;
      const ty = Math.atan2(q.tx * sign(along || 1), q.tz * sign(along || 1));
      let dy = ty - k.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      if (Math.abs(dy) < Math.PI / 2) k.yaw += dy * clamp(vn / 20, 0.05, 0.3);
      const keep = clamp(1 - vn / 40, 0.7, 0.98);
      k.vel.x *= keep;
      k.vel.z *= keep;
      if (vn > 4) {
        events.push({ type: 'wall', kart: k.id, impact: vn });
        k.stats.collisions++;
      }
    }
  }

  const ground = q.groundY;
  k.groundY = q.inGap ? -6 : ground;
  if (k.pos.y <= ground) {
    if (!k.grounded) {
      const impact = -k.vy;
      if (impact > 3) {
        k.suspensionVel -= impact * 0.25;
        events.push({ type: 'land', kart: k.id, impact });
      }
      if (d.hopPending) {
        d.hopPending = false;
        if (input.drift && Math.abs(steer) > 0.25 && fs > PHYSICS.minDriftSpeed) {
          d.active = true;
          d.dir = sign(steer);
          d.charge = 0;
          d.tier = 0;
          events.push({ type: 'driftStart', kart: k.id });
        }
      }
    }
    k.pos.y = ground;
    // follow slope upward
    k.vy = 0;
    k.grounded = true;
    k.airTime = 0;
  } else if (k.grounded && k.pos.y - ground < 0.6 && k.vy <= 0 && !q.inGap) {
    // stick to the road when cresting gentle slopes
    k.pos.y = ground;
    k.vy = 0;
  } else {
    k.grounded = false;
    k.airTime += dt;
  }

  // ramps
  if (k.grounded) {
    for (const r of track.ramps) {
      if (r.pathId !== q.pathId) continue;
      if (q.s >= r.s1 - 2.5 && q.s <= r.s1 + 0.6 && Math.abs(q.lateral) <= q.halfWidth + 1 && k.forwardSpeed > 2) {
        k.vy = r.impulse;
        k.grounded = false;
        k.pos.y += 0.05;
        // guarantee enough speed to clear gaps
        const f = forwardOf(k.yaw);
        const sp = Math.max(k.forwardSpeed, 22);
        k.vel.x = f.x * sp;
        k.vel.z = f.z * sp;
        events.push({ type: 'jump', kart: k.id });
        k.reaction = 'jump';
        k.reactionTime = 0.8;
        break;
      }
    }
    // boost pads
    for (const p of track.boostPads) {
      const dx = k.pos.x - p.pos.x, dz = k.pos.z - p.pos.z;
      if (dx * dx + dz * dz < 2.6 * 2.6) {
        if (k.boostKind !== 'pad' || k.boostTime < 0.6) events.push({ type: 'boost', kart: k.id, kind: 'pad' });
        applyBoost(k, PHYSICS.padBoost.duration, PHYSICS.padBoost.power, 'pad');
      }
    }
  }

  // timers
  if (k.boostTime > 0) {
    k.boostTime -= dt;
    if (k.boostTime <= 0) {
      k.boostTime = 0;
      k.boostPower = 0;
      k.boostKind = 'none';
    }
  }
  if (k.rocketTime > 0) k.rocketTime -= dt;
  if (k.invulnTime > 0) k.invulnTime -= dt;
  if (k.shieldTime > 0) k.shieldTime -= dt;
  if (k.turboDriftTime > 0) k.turboDriftTime -= dt;
  if (k.reactionTime > 0) {
    k.reactionTime -= dt;
    if (k.reactionTime <= 0) k.reaction = k.finished ? k.reaction : 'none';
  }

  // visuals: suspension spring & steering
  const spring = -k.suspension * t.suspension * 10 - k.suspensionVel * 6;
  k.suspensionVel += spring * dt;
  k.suspension += k.suspensionVel * dt;
  k.suspension = clamp(k.suspension, -0.4, 0.4);
  k.steerVisual += (steer - k.steerVisual) * Math.min(1, dt * 12);

  // --- safety: falling / stuck
  if (k.pos.y < PHYSICS.killY || (q.inGap && k.pos.y < -3)) {
    beginRespawn(k, events);
    return;
  }
  if (k.grounded && q.contained && !q.inGap && Math.abs(q.lateral) < q.halfWidth * 0.8 && q.pathId === 0) {
    const ty = Math.atan2(q.tx, q.tz);
    let dy = ty - k.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    if (Math.abs(dy) < 1.2 && !k.offroad) {
      const back = track.sampleAt(0, q.s - 4);
      if (!back.gap) k.lastSafe = { pos: { x: back.x + back.nx * q.lateral * 0.5, y: back.y + 0.2, z: back.z + back.nz * q.lateral * 0.5 }, yaw: ty, mainS: q.s - 4, pathId: 0 };
    }
  }
  const trying = Math.abs(input.throttle) > 0.3 && !spinning;
  if (trying && Math.abs(k.forwardSpeed) < 1.2) k.stuckTime += dt;
  else k.stuckTime = Math.max(0, k.stuckTime - dt * 2);
  if (k.stuckTime > PHYSICS.stuckTime) {
    k.stuckTime = 0;
    beginRespawn(k, events);
  }
  void time;
}

export function beginRespawn(k: KartState, events: SimEvent[]): void {
  if (k.respawnTime > 0) return;
  k.respawnTime = PHYSICS.respawnDelay;
  k.stats.respawns++;
  k.drift.active = false;
  k.drift.charge = 0;
  k.drift.tier = 0;
  k.boostTime = 0;
  k.spinTime = 0;
  events.push({ type: 'respawn', kart: k.id });
}

/** Spin a kart out (item hit). Returns false if the hit was blocked or ignored. */
export function hitKart(k: KartState, by: number, cause: string, events: SimEvent[], severity = 1): boolean {
  if (k.respawnTime > 0 || k.finished) return false;
  if (k.shieldTime > 0) {
    k.shieldTime = 0;
    k.invulnTime = 0.8;
    events.push({ type: 'shieldBlock', kart: k.id });
    return false;
  }
  if (k.invulnTime > 0 || k.rocketTime > 0) return false;
  k.spinTime = 0.9 * severity;
  k.spinDir = k.id % 2 === 0 ? 1 : -1;
  k.invulnTime = 2.2;
  k.vel.x *= 0.35;
  k.vel.z *= 0.35;
  k.drift.active = false;
  k.drift.charge = 0;
  k.drift.tier = 0;
  k.boostTime = 0;
  k.vy = Math.max(k.vy, 3);
  k.grounded = false;
  k.stats.hitsTaken++;
  k.reaction = 'hit';
  k.reactionTime = 1.2;
  events.push({ type: 'hit', kart: k.id, by, cause });
  return true;
}

import { describe, expect, it } from 'vitest';
import { forwardOf, rightOf } from '../../src/core/math';
import { applyBoost, stepKart } from '../../src/sim/kart/KartPhysics';
import { DRIFT_TIERS, PHYSICS } from '../../src/sim/kart/kartConfig';
import { Track } from '../../src/sim/track/Track';
import type { KartInput, KartState, SimEvent } from '../../src/sim/types';
import { GAP_STADIUM, JUMP_STADIUM, STADIUM, flatPlane, input, makeKart, placeKart } from './fixtures';

const dt = PHYSICS.dt;

/** Drive a kart for `seconds` with a fixed or computed input; returns emitted events. */
function drive(k: KartState, track: Track, seconds: number, inp: KartInput | ((k: KartState, t: number) => KartInput), onStep?: (k: KartState, t: number) => void): SimEvent[] {
  const events: SimEvent[] = [];
  let prevDrift = false;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const cur = typeof inp === 'function' ? inp(k, t) : inp;
    stepKart(k, cur, dt, track, t, events, prevDrift);
    prevDrift = cur.drift;
    onStep?.(k, t);
  }
  return events;
}

const speedOf = (k: KartState) => Math.hypot(k.vel.x, k.vel.z);

describe('math conventions', () => {
  it('rightOf is 90 degrees clockwise (seen from above) of forwardOf', () => {
    // yaw 0 faces +z, right is -x
    expect(forwardOf(0).z).toBeCloseTo(1);
    expect(rightOf(0).x).toBeCloseTo(-1);
    for (const yaw of [0.3, -1.2, 2.5]) {
      const f = forwardOf(yaw), r = rightOf(yaw);
      expect(f.x * r.x + f.z * r.z).toBeCloseTo(0);
    }
  });
});

describe('longitudinal dynamics', () => {
  it('accelerates to near max speed on a straight within a reasonable time', () => {
    const track = flatPlane();
    const k = makeKart('dad');
    let t95 = -1;
    drive(k, track, 10, input({ throttle: 1 }), (kk, t) => {
      if (t95 < 0 && kk.forwardSpeed >= kk.tuning.maxSpeed * 0.95) t95 = t;
    });
    expect(t95).toBeGreaterThan(0.5);
    expect(t95).toBeLessThan(6);
    expect(k.forwardSpeed).toBeGreaterThan(k.tuning.maxSpeed * 0.97);
    expect(k.forwardSpeed).toBeLessThanOrEqual(k.tuning.maxSpeed + 1e-6);
  });

  it('acceleration stat makes a kart quicker off the line', () => {
    const track = flatPlane();
    const slow = makeKart('grandma'); // accel 3
    const quick = makeKart('lupin'); // accel 5
    drive(slow, track, 1.5, input({ throttle: 1 }));
    drive(quick, track, 1.5, input({ throttle: 1 }));
    expect(quick.forwardSpeed).toBeGreaterThan(slow.forwardSpeed);
  });

  it('brakes to a stop', () => {
    const track = flatPlane();
    const k = makeKart('mom');
    drive(k, track, 6, input({ throttle: 1 }));
    expect(k.forwardSpeed).toBeGreaterThan(20);
    let stopT = -1;
    drive(k, track, 3, input({ throttle: -1 }), (kk, t) => {
      if (stopT < 0 && kk.forwardSpeed <= 0.5) stopT = t;
    });
    expect(stopT).toBeGreaterThan(0);
    expect(stopT).toBeLessThan(2);
  });

  it('coasts down without throttle', () => {
    const track = flatPlane();
    const k = makeKart('mom');
    drive(k, track, 4, input({ throttle: 1 }));
    const v = k.forwardSpeed;
    drive(k, track, 2, input());
    expect(k.forwardSpeed).toBeLessThan(v);
    expect(k.forwardSpeed).toBeGreaterThan(0);
  });

  it('reverses up to reverseSpeed', () => {
    const track = flatPlane();
    const k = makeKart('parker');
    drive(k, track, 5, input({ throttle: -1 }));
    expect(k.forwardSpeed).toBeLessThan(-k.tuning.reverseSpeed * 0.95);
    expect(k.forwardSpeed).toBeGreaterThanOrEqual(-k.tuning.reverseSpeed - 1e-6);
    expect(k.pos.z).toBeLessThan(-5); // moved backwards
  });
});

describe('steering', () => {
  it('steer +1 turns right, steer -1 turns left', () => {
    const track = flatPlane();
    for (const steer of [1, -1]) {
      const k = makeKart('brennan');
      drive(k, track, 2, input({ throttle: 1 }));
      const x0 = k.pos.x;
      const yaw0 = k.yaw;
      drive(k, track, 0.5, input({ throttle: 1, steer }));
      // the kart's position moved toward its initial right-hand side for steer +1
      const r = rightOf(yaw0);
      const lateralMove = (k.pos.x - x0) * r.x;
      expect(Math.sign(lateralMove)).toBe(steer);
      // and yaw decreases when turning right
      expect(Math.sign(yaw0 - k.yaw)).toBe(steer);
    }
  });

  it('does not rotate when stationary', () => {
    const k = makeKart('brennan');
    drive(k, flatPlane(), 1, input({ steer: 1 }));
    expect(k.yaw).toBeCloseTo(0, 5);
  });

  it('steering is mirrored when reversing', () => {
    const k = makeKart('dad');
    const track = flatPlane();
    drive(k, track, 3, input({ throttle: -1 }));
    drive(k, track, 0.5, input({ throttle: -1, steer: 1 }));
    expect(k.yaw).toBeGreaterThan(0.05);
  });
});

describe('drifting', () => {
  it('hop -> drift -> charge -> tiers -> release boost (drift1/2/3)', () => {
    for (const [holdSeconds, expectedTier] of [[0.9, 1], [1.6, 2], [3.0, 3]] as const) {
      const track = flatPlane();
      const k = makeKart('brennan');
      drive(k, track, 3, input({ throttle: 1 }));
      const events: SimEvent[] = [];
      let prev = false;
      let t = 0;
      const step = (inp: KartInput) => {
        stepKart(k, inp, dt, track, t, events, prev);
        prev = inp.drift;
        t += dt;
      };
      // press drift + steer right
      step(input({ throttle: 1, steer: 1, drift: true }));
      expect(events.some((e) => e.type === 'jump')).toBe(true);
      // hold until landing + charge for holdSeconds
      for (let i = 0; i < 60 && !k.drift.active; i++) step(input({ throttle: 1, steer: 1, drift: true }));
      expect(k.drift.active).toBe(true);
      expect(k.drift.dir).toBe(1);
      expect(events.some((e) => e.type === 'driftStart')).toBe(true);
      const chargeStart = k.drift.charge;
      for (let i = 0; i < Math.round(holdSeconds / dt); i++) step(input({ throttle: 1, steer: 1, drift: true }));
      expect(k.drift.charge).toBeGreaterThan(chargeStart);
      expect(k.drift.tier).toBe(expectedTier);
      const tierEvents = events.filter((e) => e.type === 'driftTier').map((e) => (e as { tier: number }).tier);
      expect(tierEvents).toEqual([1, 2, 3].slice(0, expectedTier));
      // release
      step(input({ throttle: 1, steer: 0, drift: false }));
      expect(k.drift.active).toBe(false);
      expect(k.boostKind).toBe(`drift${expectedTier}`);
      expect(k.boostPower).toBeCloseTo(DRIFT_TIERS[expectedTier - 1].power);
      expect(k.stats.driftBoosts).toBe(1);
      expect(events.some((e) => e.type === 'boost' && e.kind === `drift${expectedTier}`)).toBe(true);
    }
  });

  it('releasing a drift before tier 1 gives no boost', () => {
    const track = flatPlane();
    const k = makeKart('brennan');
    drive(k, track, 3, input({ throttle: 1 }));
    drive(k, track, 0.5, input({ throttle: 1, steer: 1, drift: true }));
    expect(k.drift.active).toBe(true);
    expect(k.drift.tier).toBe(0);
    drive(k, track, dt, input({ throttle: 1 }));
    expect(k.drift.active).toBe(false);
    expect(k.boostTime).toBe(0);
  });

  it('hop without steering does not start a drift', () => {
    const track = flatPlane();
    const k = makeKart('brennan');
    drive(k, track, 3, input({ throttle: 1 }));
    drive(k, track, 0.6, input({ throttle: 1, drift: true }));
    expect(k.drift.active).toBe(false);
  });

  it('drifting left turns left', () => {
    const track = flatPlane();
    const k = makeKart('mom');
    drive(k, track, 3, input({ throttle: 1 }));
    drive(k, track, 1, input({ throttle: 1, steer: -1, drift: true }));
    expect(k.drift.dir).toBe(-1);
    expect(k.yaw).toBeGreaterThan(0.3);
  });
});

describe('boost', () => {
  it('boost raises speed above max speed', () => {
    const track = flatPlane();
    const k = makeKart('dad');
    drive(k, track, 6, input({ throttle: 1 }));
    applyBoost(k, 1.5, 0.4, 'item');
    drive(k, track, 1.2, input({ throttle: 1 }));
    expect(k.forwardSpeed).toBeGreaterThan(k.tuning.maxSpeed * 1.2);
  });

  it('continuous boost never runs away', () => {
    for (const power of [0.32, 0.4, 0.55, 0.6]) {
      const track = flatPlane();
      const k = makeKart('dad');
      let maxSeen = 0;
      drive(k, track, 20, (kk) => {
        applyBoost(kk, 0.5, power, 'item');
        return input({ throttle: 1 });
      }, (kk) => {
        maxSeen = Math.max(maxSeen, speedOf(kk));
      });
      expect(maxSeen).toBeLessThanOrEqual(k.tuning.maxSpeed * (1 + power) + 1e-6);
      expect(maxSeen).toBeGreaterThan(k.tuning.maxSpeed * (1 + power) * 0.95);
    }
  });

  it('stacked boosts do not compound power', () => {
    const k = makeKart('dad');
    applyBoost(k, 2, 0.4, 'pad');
    applyBoost(k, 1, 0.3, 'item');
    applyBoost(k, 3, 0.2, 'item');
    expect(k.boostPower).toBeLessThanOrEqual(0.4);
    expect(k.boostTime).toBe(3);
  });

  it('speed bleeds back to max after a boost ends', () => {
    const track = flatPlane();
    const k = makeKart('dad');
    drive(k, track, 6, input({ throttle: 1 }));
    applyBoost(k, 1, 0.5, 'item');
    drive(k, track, 1.1, input({ throttle: 1 }));
    expect(k.boostTime).toBe(0);
    drive(k, track, 2, input({ throttle: 1 }));
    expect(k.forwardSpeed).toBeLessThanOrEqual(k.tuning.maxSpeed + 1e-6);
  });
});

describe('track contact', () => {
  it('wall collision keeps the kart inside wallDist and slows but does not stop it', () => {
    const track = new Track(STADIUM);
    const k = makeKart('dad');
    placeKart(track, k, 40, 0, 26);
    k.yaw -= 0.5; // aim ~29 degrees to the right, towards the right wall
    k.vel = { x: forwardOf(k.yaw).x * 26, y: 0, z: forwardOf(k.yaw).z * 26 };
    let worst = 0;
    let minSpeedAfterHit = Infinity;
    let hit = false;
    const events = drive(k, track, 3, input({ throttle: 1 }), (kk) => {
      const q = track.query(kk.pos, 0)!;
      worst = Math.max(worst, Math.abs(q.lateral) - q.wallDist);
      if (hit) minSpeedAfterHit = Math.min(minSpeedAfterHit, speedOf(kk));
      if (!hit && Math.abs(q.lateral) > q.wallDist - 1.5) hit = true;
    });
    expect(events.some((e) => e.type === 'wall')).toBe(true);
    expect(worst).toBeLessThanOrEqual(0.01);
    expect(minSpeedAfterHit).toBeLessThan(26);
    expect(minSpeedAfterHit).toBeGreaterThan(5);
    expect(k.stats.collisions).toBeGreaterThan(0);
  });

  it('off-road lowers top speed', () => {
    const track = new Track(STADIUM);
    const on = makeKart('dad');
    const off = makeKart('dad');
    const hw = track.sampleAt(0, 20).halfWidth;
    placeKart(track, on, 20, 0);
    placeKart(track, off, 20, hw + STADIUM.shoulder / 2);
    drive(on, track, 8, input({ throttle: 1 }));
    drive(off, track, 8, input({ throttle: 1 }));
    expect(off.offroad).toBe(true);
    expect(off.surface).toBe('offroad');
    expect(on.offroad).toBe(false);
    expect(on.forwardSpeed).toBeGreaterThan(on.tuning.maxSpeed * 0.95);
    expect(off.forwardSpeed).toBeLessThanOrEqual(off.tuning.maxSpeed * off.tuning.offroadPenalty + 0.5);
    expect(off.forwardSpeed).toBeGreaterThan(5);
  });

  it('ramp launches the kart over a gap and it lands', () => {
    const track = new Track(JUMP_STADIUM);
    const k = makeKart('dad');
    placeKart(track, k, 160, 0, 25);
    let airborne = 0;
    let maxY = 0;
    const events = drive(k, track, 4, input({ throttle: 1 }), (kk) => {
      if (!kk.grounded) airborne += dt;
      maxY = Math.max(maxY, kk.pos.y);
    });
    expect(events.some((e) => e.type === 'jump')).toBe(true);
    expect(events.some((e) => e.type === 'land')).toBe(true);
    expect(events.some((e) => e.type === 'respawn')).toBe(false);
    expect(airborne).toBeGreaterThan(0.4);
    expect(maxY).toBeGreaterThan(2);
    expect(k.grounded).toBe(true);
    expect(k.mainS).toBeGreaterThan(215);
    expect(k.pos.y).toBeCloseTo(0, 1);
  });

  it('falling into a gap respawns the kart back on the track', () => {
    const track = new Track(GAP_STADIUM);
    const k = makeKart('mom');
    placeKart(track, k, 150, 0, 15);
    const events: SimEvent[] = [];
    let lowest = 0;
    let wasRespawning = false;
    let restored = false;
    for (let i = 0; i < 6 / dt && !restored; i++) {
      stepKart(k, input({ throttle: 0.4 }), dt, track, i * dt, events, false);
      lowest = Math.min(lowest, k.pos.y);
      if (k.respawnTime > 0) wasRespawning = true;
      else if (wasRespawning) restored = true;
    }
    expect(restored).toBe(true);
    expect(events.filter((e) => e.type === 'respawn').length).toBe(1);
    expect(k.stats.respawns).toBe(1);
    expect(lowest).toBeLessThan(-2);
    expect(lowest).toBeGreaterThan(PHYSICS.killY - 2);
    // restored to a safe spot before the gap, on the road, at rest and briefly invulnerable
    const q = track.query(k.pos, 0)!;
    expect(q.inGap).toBe(false);
    expect(q.contained).toBe(true);
    expect(Math.abs(q.lateral)).toBeLessThan(q.halfWidth);
    expect(k.pos.y).toBeGreaterThan(-1);
    expect(q.s).toBeLessThan(200);
    expect(q.s).toBeGreaterThan(150);
    expect(k.forwardSpeed).toBe(0);
    expect(k.invulnTime).toBeGreaterThan(1);
  });

  it('a wedged kart holding throttle is automatically recovered after stuckTime', () => {
    const track = new Track(STADIUM);
    const k = makeKart('lupin');
    placeKart(track, k, 60, 0);
    const pinned = { ...k.pos };
    let respawnT = -1;
    drive(k, track, PHYSICS.stuckTime + 1, input({ throttle: 1 }), (kk, t) => {
      if (kk.respawnTime > 0) {
        if (respawnT < 0) respawnT = t;
        return;
      }
      // something immovable in front of the kart
      kk.pos = { ...pinned };
      kk.vel.x = kk.vel.z = 0;
    });
    expect(respawnT).toBeGreaterThan(PHYSICS.stuckTime - 0.1);
    expect(respawnT).toBeLessThan(PHYSICS.stuckTime + 0.5);
    expect(k.stats.respawns).toBe(1);
  });

});

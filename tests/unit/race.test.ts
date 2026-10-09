import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { TRACKS } from '../../src/data/tracks/index';
import { CHICAGO } from '../../src/data/tracks/chicago';
import { AI_NO_PROGRESS_RESPAWN } from '../../src/sim/ai/AIDriver';
import { PHYSICS } from '../../src/sim/kart/kartConfig';
import { RaceSim } from '../../src/sim/race/RaceSim';
import { Track } from '../../src/sim/track/Track';
import type { CharacterId, KartInput, KartState, SimEvent } from '../../src/sim/types';
import { beginRespawn } from '../../src/sim/kart/KartPhysics';
import { ALL_CHARACTERS, OVAL, STADIUM, aiSim, followTrack, humanSim, placeInSim, placeKart, runToEnd } from './fixtures';

/** Step a sim with player 0 driven by a function; returns events. */
function drivePlayer(sim: RaceSim, k: KartState, seconds: number, fn: (k: KartState) => KartInput): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds / sim.dt; i++) {
    sim.step([fn(k)]);
    events.push(...sim.drainEvents());
  }
  return events;
}

describe('lap detection & checkpoints', () => {
  it('a kart completing one loop gets exactly one lap', () => {
    const sim = humanSim(OVAL, 1, { laps: 3 });
    const k = sim.karts[0];
    const L = sim.track.length;
    expect(k.raceDistance).toBeLessThan(0); // starts behind the line
    const events: SimEvent[] = [];
    // drive until just past one full loop beyond the line
    for (let i = 0; i < 60 * 120 && k.raceDistance < L + 20; i++) {
      sim.step([followTrack(sim.track, k)]);
      events.push(...sim.drainEvents());
    }
    expect(k.lapsCompleted).toBe(1);
    expect(events.filter((e) => e.type === 'lap')).toHaveLength(1);
    expect(k.lapTimes).toHaveLength(1);
    expect(k.lapTimes[0]).toBeGreaterThan(10);
    expect(sim.displayLap(k)).toBe(2);
  });

  it('driving backwards across the line does not gain a lap', () => {
    const sim = humanSim(STADIUM, 1, { laps: 3 });
    const k = sim.karts[0];
    const L = sim.track.length;
    // forward over the line
    drivePlayer(sim, k, 3, (kk) => followTrack(sim.track, kk));
    expect(k.raceDistance).toBeGreaterThan(10);
    const peak = k.raceDistance;
    // turn around and drive the wrong way, back across the line and well past it
    k.yaw += Math.PI;
    k.vel.x = k.vel.z = 0;
    const ev = drivePlayer(sim, k, 8, (kk) => followTrack(sim.track, kk, 0, -1));
    expect(k.raceDistance).toBeLessThan(-30);
    expect(k.lapsCompleted).toBe(0);
    expect(ev.some((e) => e.type === 'lap')).toBe(false);
    expect(k.wrongWayTime).toBeGreaterThan(0);
    // raceDistance follows the kart backwards; it never exceeds actual progress
    expect(k.raceDistance).toBeLessThan(peak);
    expect(k.raceDistance).toBeGreaterThan(-L);
  });

  it('shuttling back and forth across the line cannot farm laps or distance', () => {
    const sim = humanSim(STADIUM, 1, { laps: 3 });
    const k = sim.karts[0];
    let maxDist = -Infinity;
    for (let rep = 0; rep < 4; rep++) {
      drivePlayer(sim, k, 1.5, (kk) => ({ ...followTrack(sim.track, kk), throttle: 1 }));
      maxDist = Math.max(maxDist, k.raceDistance);
      drivePlayer(sim, k, 2.5, (kk) => ({ ...followTrack(sim.track, kk), throttle: -1 }));
    }
    expect(k.lapsCompleted).toBe(0);
    expect(k.nextCheckpoint).toBeLessThanOrEqual(1);
    expect(maxDist).toBeLessThan(sim.track.length / 4);
  });

  it('teleporting across the map awards no progress', () => {
    const sim = humanSim(STADIUM, 1, { laps: 3 });
    const k = sim.karts[0];
    const L = sim.track.length;
    placeInSim(sim, k, 5);
    sim.step([]);
    const before = k.raceDistance;
    // jump the kart forwards ~1/3 of a lap without updating raceDistance
    const smp = sim.track.sampleAt(0, L / 3);
    k.pos = { x: smp.x, y: smp.y, z: smp.z };
    sim.step([]);
    expect(Math.abs(k.raceDistance - before)).toBeLessThan(1);
    expect(k.nextCheckpoint).toBe(0);
  });

  it('respawning forward to the last safe spot resyncs progress (no frozen raceDistance)', () => {
    const sim = humanSim(STADIUM, 1, { laps: 3 });
    const k = sim.karts[0];
    placeInSim(sim, k, 300, 0);
    sim.step([]);
    const safe = { ...k.lastSafe, pos: { ...k.lastSafe.pos } };
    // the kart then drives ~100 m the wrong way (progress follows it back) and gets stuck there
    for (let s = 296; s >= 200; s -= 4) {
      placeKart(sim.track, k, s, 0);
      sim.step([]);
    }
    expect(k.raceDistance).toBeLessThan(210);
    k.lastSafe = safe; // e.g. it was facing backwards / off-road, so lastSafe was never refreshed
    beginRespawn(k, sim.events);
    for (let i = 0; i < 120 && k.respawnTime > 0; i++) sim.step([]);
    sim.step([]);
    expect(k.mainS).toBeGreaterThan(280);
    expect(Math.abs(k.raceDistance - k.mainS)).toBeLessThan(2);
    expect(k.raceDistance).toBeLessThanOrEqual(300 + 1e-6);
    // and progress keeps counting from there
    drivePlayer(sim, k, 2, (kk) => followTrack(sim.track, kk));
    expect(k.raceDistance).toBeGreaterThan(310);
  });

  it('checkpoints are passed in order', () => {
    const sim = humanSim(OVAL, 1, { laps: 1 });
    const k = sim.karts[0];
    const seen: number[] = [];
    let last = k.nextCheckpoint;
    for (let i = 0; i < 60 * 60 && !k.finished; i++) {
      sim.step([followTrack(sim.track, k)]);
      sim.drainEvents();
      if (k.nextCheckpoint !== last) {
        seen.push(k.nextCheckpoint);
        last = k.nextCheckpoint;
      }
    }
    expect(k.finished).toBe(true);
    const n = sim.track.checkpoints.length;
    expect(seen).toEqual([...Array.from({ length: n - 1 }, (_, i) => i + 1), 0]);
  });
});

describe('finish & results', () => {
  it('detects finishes, assigns unique places and orders results', () => {
    const sim = aiSim(OVAL, { laps: 1, seed: 5 });
    const events = runToEnd(sim);
    const finishes = events.filter((e): e is Extract<SimEvent, { type: 'finish' }> => e.type === 'finish');
    expect(finishes).toHaveLength(6);
    expect(finishes.map((f) => f.place)).toEqual([1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < finishes.length; i++) expect(finishes[i].time).toBeGreaterThanOrEqual(finishes[i - 1].time);
    expect(events.filter((e) => e.type === 'raceOver')).toHaveLength(1);
    const res = sim.results();
    expect(res.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.every((r) => r.finished && Number.isFinite(r.time) && Number.isFinite(r.bestLap))).toBe(true);
    expect(sim.phase).toBe('finished');
  });

  it('time limit ends a race and ranks unfinished karts by progress', () => {
    const sim = humanSim(OVAL, 3, { laps: 3, timeLimit: 6 });
    // only player 1 drives; others idle
    while (sim.phase !== 'finished') sim.step([undefined as unknown as KartInput, followTrack(sim.track, sim.karts[1])]);
    const res = sim.results();
    expect(res.every((r) => !r.finished)).toBe(true);
    expect(res[0].kart).toBe(1);
    expect(new Set(res.map((r) => r.place)).size).toBe(3);
  });

  it('a human finishing ends the race after the grace period', () => {
    const sim = new RaceSim({
      track: OVAL, laps: 1, difficulty: 'easy', seed: 4, finishGrace: 2,
      racers: [{ character: 'dad', playerIndex: 0 }, ...ALL_CHARACTERS.slice(1).map((c) => ({ character: c, playerIndex: -1 }))],
    });
    const human = sim.karts.find((k) => k.isHuman)!;
    // give the human a big head start so they finish first
    while (sim.phase === 'countdown') sim.step([]);
    let finishT = -1;
    for (let i = 0; i < 60 * 200 && sim.phase !== 'finished'; i++) {
      sim.step([followTrack(sim.track, human)]);
      if (human.finished && finishT < 0) finishT = sim.time;
    }
    expect(human.finished).toBe(true);
    expect(sim.phase).toBe('finished');
    expect(sim.time - finishT).toBeLessThan(2.2 + 1e-6);
  });
});

describe('kart-kart collision', () => {
  it('separates overlapping karts, exchanges momentum and emits a bump', () => {
    const sim = humanSim(STADIUM, 2);
    const [a, b] = sim.karts;
    placeInSim(sim, a, 50, 0, 20);
    placeInSim(sim, b, 51.5, 0, 0);
    sim.step([]);
    const ev = sim.drainEvents();
    const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
    expect(d).toBeGreaterThanOrEqual(a.tuning.radius + b.tuning.radius - 0.05);
    // forwardSpeed is refreshed by the next physics step; compare velocities along the road (+z here)
    const fwd = sim.track.sampleAt(0, 50);
    const along = (k: KartState) => k.vel.x * fwd.tx + k.vel.z * fwd.tz;
    expect(along(b)).toBeGreaterThan(3);
    expect(along(a)).toBeLessThan(18);
    expect(along(a) * a.tuning.mass + along(b) * b.tuning.mass).toBeGreaterThan(0);
    expect(ev.some((e) => e.type === 'bump')).toBe(true);
    expect(a.stats.collisions).toBe(1);
    expect(b.stats.collisions).toBe(1);
  });

  it('heavier karts are pushed less', () => {
    const sim = new RaceSim({ track: STADIUM, difficulty: 'normal', countdown: 0.02, racers: [{ character: 'dad', playerIndex: 0 }, { character: 'lupin', playerIndex: 1 }] });
    while (sim.phase === 'countdown') sim.step([]);
    const [heavy, light] = sim.karts; // dad weight 4, lupin weight 1
    placeInSim(sim, heavy, 50, -1.0, 0);
    placeInSim(sim, light, 50, 1.0, 0);
    const h0 = { ...heavy.pos }, l0 = { ...light.pos };
    sim.step([]);
    const dh = Math.hypot(heavy.pos.x - h0.x, heavy.pos.z - h0.z);
    const dl = Math.hypot(light.pos.x - l0.x, light.pos.z - l0.z);
    expect(dl).toBeGreaterThan(dh);
  });

  it('karts at different heights (one airborne) do not collide', () => {
    const sim = humanSim(STADIUM, 2);
    const [a, b] = sim.karts;
    placeInSim(sim, a, 50, 0, 0);
    placeInSim(sim, b, 50.5, 0, 0);
    b.pos.y = 3;
    b.grounded = false;
    const ax = a.pos.x, az = a.pos.z;
    sim.step([]);
    expect(Math.hypot(a.pos.x - ax, a.pos.z - az)).toBeLessThan(0.05);
  });
});

describe('AI', () => {
  const finishAll = (track: ConstructorParameters<typeof RaceSim>[0]['track'], difficulty: 'easy' | 'normal' | 'hard', seed: number, limit: number) => {
    const sim = aiSim(track, { difficulty, seed, timeLimit: limit });
    const events = runToEnd(sim);
    return { sim, events };
  };

  it.each(['easy', 'normal', 'hard'] as const)('AI-only race on the test oval finishes (%s)', (difficulty) => {
    const { sim, events } = finishAll(OVAL, difficulty, 11, 240);
    expect(sim.karts.every((k) => k.finished)).toBe(true);
    expect(sim.time).toBeLessThan(240);
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(6);
  });

  it('AI-only race on the stadium finishes', () => {
    const { sim } = finishAll(STADIUM, 'normal', 12, 240);
    expect(sim.karts.every((k) => k.finished)).toBe(true);
  });

  it.each(['easy', 'hard'] as const)('AI-only race on Chicago finishes (%s)', (difficulty) => {
    const { sim } = finishAll(CHICAGO, difficulty, 21, 420);
    expect(sim.karts.every((k) => k.finished)).toBe(true);
    expect(sim.time).toBeLessThan(420);
  });

  it.each(TRACKS.map((t) => [t.id, t] as const))('AI-only race on registered track %s finishes', (_id, def) => {
    const { sim } = finishAll(def, 'normal', 31, 600);
    for (const k of sim.karts) {
      expect(k.finished, `${k.character} on ${def.id} (lap ${k.lapsCompleted}, s ${k.mainS.toFixed(0)})`).toBe(true);
      expect(Number.isFinite(k.pos.x) && Number.isFinite(k.pos.y) && Number.isFinite(k.pos.z)).toBe(true);
    }
  });

  it('AI karts overtake each other during a race', () => {
    const { sim, events } = finishAll(CHICAGO, 'normal', 8, 420);
    const overtakes = events.filter((e) => e.type === 'overtake');
    expect(overtakes.length).toBeGreaterThan(5);
    expect(sim.karts.reduce((a, k) => a + k.stats.overtakes, 0)).toBe(overtakes.length);
  });

  it('AI uses drifts, items and specials', () => {
    const { events } = finishAll(CHICAGO, 'hard', 9, 420);
    const count = (t: SimEvent['type']) => events.filter((e) => e.type === t).length;
    expect(count('driftStart')).toBeGreaterThan(0);
    expect(count('itemUse')).toBeGreaterThan(0);
    expect(count('special')).toBeGreaterThan(0);
  });

  it('hard AI is faster than easy AI', () => {
    const easy = finishAll(OVAL, 'easy', 2, 240).sim;
    const hard = finishAll(OVAL, 'hard', 2, 240).sim;
    const avg = (s: RaceSim) => s.karts.reduce((a, k) => a + k.finishTime, 0) / s.karts.length;
    expect(avg(hard)).toBeLessThan(avg(easy));
  });

  it('an AI racer that makes no progress for a long time is respawned (watchdog)', () => {
    const sim = aiSim(STADIUM, { seed: 3, countdown: 0.05 });
    while (sim.phase === 'countdown') sim.step();
    const k = sim.karts[0];
    placeInSim(sim, k, 300, 0);
    const pinned = { ...k.pos };
    let respawnAt = -1;
    for (let i = 0; i < 60 * (AI_NO_PROGRESS_RESPAWN + 2) && respawnAt < 0; i++) {
      sim.step();
      if (sim.drainEvents().some((e) => e.type === 'respawn' && e.kart === k.id)) respawnAt = sim.time;
      // hold the kart in place but keep it "moving" so the physics stuck timer never fires
      k.pos = { ...pinned };
      k.stuckTime = 0;
    }
    expect(respawnAt).toBeGreaterThan(AI_NO_PROGRESS_RESPAWN - 0.5);
    expect(respawnAt).toBeLessThan(AI_NO_PROGRESS_RESPAWN + 1);
  });

  it('AI rubber-banding is mild and bounded', () => {
    const sim = new RaceSim({
      track: OVAL, difficulty: 'normal', seed: 1,
      racers: [{ character: 'dad', playerIndex: 0 }, { character: 'mom', playerIndex: -1 }],
    });
    const ai = sim.ais.find((a) => a)!;
    const human = sim.humanKarts[0];
    const aiKart = sim.karts.find((k) => !k.isHuman)!;
    aiKart.raceDistance = human.raceDistance + 1000;
    expect(ai.speedScale()).toBeGreaterThan(0.94 * 0.9);
    aiKart.raceDistance = human.raceDistance - 1000;
    expect(ai.speedScale()).toBeLessThan(0.94 * 1.1);
  });
});

describe('determinism', () => {
  it('same seed => identical race', () => {
    const run = () => {
      const sim = aiSim(CHICAGO, { seed: 777, difficulty: 'hard' });
      runToEnd(sim);
      return sim.karts.map((k) => [k.character, k.finishPlace, k.finishTime, k.pos.x, k.pos.z, k.stats.itemsUsed]);
    };
    expect(run()).toEqual(run());
  });

  it('different seeds diverge', () => {
    const run = (seed: number) => {
      const sim = aiSim(OVAL, { seed, difficulty: 'normal' });
      runToEnd(sim);
      return sim.karts.map((k) => k.finishTime);
    };
    expect(run(1)).not.toEqual(run(2));
  });
});

describe('stability', () => {
  it('no NaN / runaway speed / falling through the world during AI races', () => {
    for (const def of [OVAL, CHICAGO]) {
      const sim = aiSim(def, { seed: 4242, difficulty: 'hard' });
      let maxSpeed = 0;
      while (sim.phase !== 'finished') {
        sim.step();
        sim.drainEvents();
        for (const k of sim.karts) {
          expect(Number.isFinite(k.pos.x + k.pos.y + k.pos.z + k.vel.x + k.vel.z + k.yaw)).toBe(true);
          maxSpeed = Math.max(maxSpeed, Math.hypot(k.vel.x, k.vel.z));
          if (k.respawnTime <= 0) expect(k.pos.y).toBeGreaterThan(PHYSICS.killY - 1);
        }
      }
      expect(maxSpeed).toBeLessThan(70);
    }
  });
});

describe('character balance smoke test', () => {
  it('every character can win and none dominates over a small sample', () => {
    const track = new Track(OVAL);
    const wins: Record<string, number> = {};
    const placeSum: Record<string, number> = {};
    const N = 18;
    for (let r = 0; r < N; r++) {
      const rng = new Rng(1000 + r);
      const order = [...ALL_CHARACTERS];
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const sim = aiSim(track, { seed: 500 + r, difficulty: 'normal', laps: 2 }, order as CharacterId[]);
      runToEnd(sim);
      for (const k of sim.karts) {
        placeSum[k.character] = (placeSum[k.character] ?? 0) + k.finishPlace;
        if (k.finishPlace === 1) wins[k.character] = (wins[k.character] ?? 0) + 1;
      }
    }
    for (const c of ALL_CHARACTERS) {
      const avg = placeSum[c] / N;
      expect(avg, `${c} avg place`).toBeGreaterThan(1.8);
      expect(avg, `${c} avg place`).toBeLessThan(5.2);
      expect(wins[c] ?? 0, `${c} wins`).toBeLessThanOrEqual(N * 0.6);
    }
  });
});

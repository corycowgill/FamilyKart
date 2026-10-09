import { describe, expect, it } from 'vitest';
import { CHARACTERS, characterById } from '../../src/data/characters';
import { ITEMS, itemWeights } from '../../src/sim/items/itemDefs';
import { ITEM_TUNING } from '../../src/sim/items/ItemSystem';
import { hitKart } from '../../src/sim/kart/KartPhysics';
import { RaceSim } from '../../src/sim/race/RaceSim';
import type { CharacterId, ItemId, KartState, SimEvent } from '../../src/sim/types';
import { ALL_CHARACTERS, OVAL, STADIUM, humanSim, placeInSim } from './fixtures';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;

function stepFor(sim: RaceSim, seconds: number, until?: (ev: SimEvent[]) => boolean): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < seconds / sim.dt; i++) {
    sim.step([]);
    all.push(...sim.drainEvents());
    if (until?.(all)) break;
  }
  return all;
}

/** Sim with human karts (they idle) of the given characters on the stadium straight. */
function setup(chars: CharacterId[] = ['dad', 'mom']): RaceSim {
  return humanSim(STADIUM, chars.length, {
    racers: chars.map((c, i) => ({ character: c, playerIndex: i })),
  });
}

const ALL_ITEMS: ItemId[] = ['turboSoda', 'flyingPizza', 'bananaPeel', 'bubbleShield', 'giantDogBone', 'chicagoPothole', 'rocketKart', 'mysteryBox'];

describe('item boxes', () => {
  it('driving through a box starts the roulette, grants an item, and the box respawns', () => {
    const sim = setup(['dad']);
    const k = sim.karts[0];
    const box = sim.items.boxes[0];
    const q = sim.track.query(box.pos, 0)!;
    placeInSim(sim, k, q.s, q.lateral);
    const ev = stepFor(sim, 0.05);
    expect(ev.some((e) => e.type === 'itemPickup' && e.kart === k.id)).toBe(true);
    expect(box.respawn).toBeGreaterThan(0);
    expect(k.itemRoulette).toBeGreaterThan(0);
    expect(k.item).toBeNull();
    // move off the box row
    placeInSim(sim, k, q.s + 30, 0);
    const ev2 = stepFor(sim, ITEM_TUNING.roulette + 0.1);
    const granted = ev2.find((e): e is Ev<'itemGranted'> => e.type === 'itemGranted');
    expect(granted?.kart).toBe(k.id);
    expect(k.item).toBe(granted?.item);
    expect(ALL_ITEMS).toContain(k.item);
    stepFor(sim, ITEM_TUNING.boxRespawn);
    expect(box.respawn).toBeLessThanOrEqual(0);
  });

  it('a kart holding an item does not get a second roll', () => {
    const sim = setup(['dad']);
    const k = sim.karts[0];
    k.item = 'bananaPeel';
    const box = sim.items.boxes[0];
    const q = sim.track.query(box.pos, 0)!;
    placeInSim(sim, k, q.s, q.lateral);
    stepFor(sim, 0.05);
    expect(k.itemRoulette).toBe(0);
    expect(k.item).toBe('bananaPeel');
  });

  it('every box row is reachable on the road', () => {
    const sim = setup(['dad']);
    for (const b of sim.items.boxes) {
      const q = sim.track.query(b.pos, 0)!;
      expect(q.onRoad).toBe(true);
    }
  });
});

describe('item activation', () => {
  it('every item id has a definition', () => {
    for (const id of ALL_ITEMS) expect(ITEMS[id].id).toBe(id);
  });

  it('turboSoda boosts', () => {
    const sim = setup();
    const k = sim.karts[0];
    placeInSim(sim, k, 40, 0, 20);
    k.item = 'turboSoda';
    sim.items.useItem(k);
    expect(k.item).toBeNull();
    expect(k.boostKind).toBe('item');
    expect(k.boostTime).toBeCloseTo(ITEM_TUNING.sodaBoost.duration);
    expect(k.stats.itemsUsed).toBe(1);
    const ev = sim.drainEvents();
    expect(ev.some((e) => e.type === 'itemUse' && e.item === 'turboSoda')).toBe(true);
    stepFor(sim, 1);
    expect(k.forwardSpeed).toBeGreaterThan(k.tuning.maxSpeed);
  });

  it('flyingPizza homes in on the kart ahead and spins it out', () => {
    const sim = setup();
    const [a, b] = sim.karts;
    placeInSim(sim, a, 40, -3);
    placeInSim(sim, b, 100, 4);
    a.item = 'flyingPizza';
    sim.items.useItem(a);
    expect(sim.items.projectiles).toHaveLength(1);
    expect(sim.items.projectiles[0].target).toBe(b.id);
    const ev = stepFor(sim, 4, (e) => e.some((x) => x.type === 'hit'));
    const hit = ev.find((e): e is Ev<'hit'> => e.type === 'hit');
    expect(hit).toMatchObject({ kart: b.id, by: a.id, cause: 'pizza' });
    expect(b.spinTime).toBeGreaterThan(0);
    expect(b.stats.hitsTaken).toBe(1);
    expect(a.stats.hitsTaken).toBe(0);
    expect(sim.items.projectiles).toHaveLength(0);
  });

  it('bananaPeel drops behind and spins out a kart that drives over it', () => {
    const sim = setup();
    const [a, b] = sim.karts;
    placeInSim(sim, a, 80, 0);
    a.item = 'bananaPeel';
    sim.items.useItem(a);
    expect(sim.items.hazards).toHaveLength(1);
    const h = sim.items.hazards[0];
    expect(h.kind).toBe('banana');
    const q = sim.track.query(h.pos, 0)!;
    expect(q.s).toBeLessThan(80);
    placeInSim(sim, b, q.s - 15, q.lateral, 18);
    const ev = stepFor(sim, 2, (e) => e.some((x) => x.type === 'hit'));
    expect(ev.find((e) => e.type === 'hit')).toMatchObject({ kart: b.id, cause: 'banana' });
    expect(sim.items.hazards).toHaveLength(0);
  });

  it('bubbleShield protects', () => {
    const sim = setup();
    const k = sim.karts[0];
    k.item = 'bubbleShield';
    sim.items.useItem(k);
    expect(k.shieldTime).toBe(ITEM_TUNING.shield);
    const ev: SimEvent[] = [];
    expect(hitKart(k, 1, 'test', ev)).toBe(false);
    expect(ev.some((e) => e.type === 'shieldBlock')).toBe(true);
    expect(k.shieldTime).toBe(0);
    expect(k.spinTime).toBe(0);
  });

  it('giantDogBone rolls forward and knocks a kart in its lane aside', () => {
    const sim = setup();
    const [a, b] = sim.karts;
    placeInSim(sim, a, 40, 2);
    placeInSim(sim, b, 110, 2);
    a.item = 'giantDogBone';
    sim.items.useItem(a);
    expect(sim.items.projectiles[0].kind).toBe('bone');
    const ev = stepFor(sim, 4, (e) => e.some((x) => x.type === 'hit'));
    expect(ev.find((e) => e.type === 'hit')).toMatchObject({ kart: b.id, cause: 'bone' });
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeGreaterThan(1);
  });

  it('giantDogBone expires if it hits nothing', () => {
    const sim = setup(['dad']);
    const a = sim.karts[0];
    placeInSim(sim, a, 40, 0);
    a.item = 'giantDogBone';
    sim.items.useItem(a);
    stepFor(sim, 7);
    expect(sim.items.projectiles).toHaveLength(0);
  });

  it('chicagoPothole slows (but does not spin) a kart that hits it', () => {
    const sim = setup();
    const [a, b] = sim.karts;
    placeInSim(sim, a, 80, 0);
    a.item = 'chicagoPothole';
    sim.items.useItem(a);
    const h = sim.items.hazards[0];
    expect(h.kind).toBe('pothole');
    const q = sim.track.query(h.pos, 0)!;
    placeInSim(sim, b, q.s - 8, q.lateral, 20);
    let minSpeed = Infinity;
    const ev: SimEvent[] = [];
    for (let i = 0; i < 60; i++) {
      sim.step([]);
      ev.push(...sim.drainEvents());
      minSpeed = Math.min(minSpeed, Math.hypot(b.vel.x, b.vel.z));
    }
    expect(ev.find((e) => e.type === 'hit')).toMatchObject({ kart: b.id, cause: 'pothole' });
    expect(minSpeed).toBeLessThan(13);
    expect(b.spinTime).toBe(0);
    // potholes persist for others but expire eventually
    expect(sim.items.hazards).toHaveLength(1);
    stepFor(sim, ITEM_TUNING.potholeLife);
    expect(sim.items.hazards).toHaveLength(0);
  });

  it('rocketKart gives a big boost, immunity, and plows other karts', () => {
    const sim = setup();
    const [a, b] = sim.karts;
    placeInSim(sim, a, 40, 0, 25);
    a.item = 'rocketKart';
    sim.items.useItem(a);
    expect(a.rocketTime).toBeCloseTo(ITEM_TUNING.rocket.duration);
    expect(a.boostKind).toBe('rocket');
    const ev: SimEvent[] = [];
    expect(hitKart(a, b.id, 'test', ev)).toBe(false);
    placeInSim(sim, b, 60, 0, 0);
    const ev2 = stepFor(sim, 1.5, (e) => e.some((x) => x.type === 'hit'));
    expect(ev2.find((e) => e.type === 'hit')).toMatchObject({ kart: b.id, by: a.id, cause: 'rocket' });
    expect(a.spinTime).toBe(0);
  });

  it('mysteryBox turns into a different item and activates it', () => {
    const seen = new Set<ItemId>();
    for (let seed = 1; seed < 30; seed++) {
      const sim = humanSim(STADIUM, 2, { seed });
      const k = sim.karts[0];
      placeInSim(sim, k, 40, 0, 20);
      k.item = 'mysteryBox';
      sim.items.useItem(k);
      const ev = sim.drainEvents();
      const granted = ev.find((e): e is Ev<'itemGranted'> => e.type === 'itemGranted');
      expect(granted).toBeDefined();
      expect(granted!.item).not.toBe('mysteryBox');
      seen.add(granted!.item);
      expect(k.item).toBeNull();
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('items cannot be used while spinning or respawning', () => {
    const sim = setup();
    const k = sim.karts[0];
    k.item = 'turboSoda';
    k.spinTime = 0.5;
    sim.items.useItem(k);
    expect(k.item).toBe('turboSoda');
    k.spinTime = 0;
    k.respawnTime = 0.5;
    sim.items.useItem(k);
    expect(k.item).toBe('turboSoda');
  });
});

describe('defense & fairness', () => {
  it('shield blocks a pizza hit', () => {
    const sim = setup();
    const [a, b] = sim.karts;
    placeInSim(sim, a, 40, 0);
    placeInSim(sim, b, 90, 0);
    b.shieldTime = 5;
    a.item = 'flyingPizza';
    sim.items.useItem(a);
    const ev = stepFor(sim, 4, (e) => e.some((x) => x.type === 'shieldBlock' || x.type === 'hit'));
    expect(ev.some((e) => e.type === 'shieldBlock' && e.kart === b.id)).toBe(true);
    expect(ev.some((e) => e.type === 'hit')).toBe(false);
    expect(b.spinTime).toBe(0);
    expect(b.shieldTime).toBe(0);
  });

  it('invulnerability window prevents stun-lock', () => {
    const sim = setup();
    const k = sim.karts[0];
    const ev: SimEvent[] = [];
    expect(hitKart(k, 1, 'a', ev)).toBe(true);
    expect(hitKart(k, 1, 'b', ev)).toBe(false);
    expect(ev.filter((e) => e.type === 'hit')).toHaveLength(1);
    // a second banana right after the first is ignored
    const spin = k.spinTime;
    stepFor(sim, 1.0);
    expect(hitKart(k, 1, 'c', ev)).toBe(false);
    // spin is shorter than invulnerability: the kart regains control before it can be hit again
    expect(spin).toBeLessThan(k.invulnTime + 1.0);
    stepFor(sim, 1.5);
    expect(k.invulnTime).toBeLessThanOrEqual(0);
    expect(hitKart(k, 1, 'd', ev)).toBe(true);
  });

  it('back-to-back bananas only hit once', () => {
    const sim = setup(['dad', 'mom', 'parker']);
    const [a, b, c] = sim.karts;
    placeInSim(sim, a, 80, 0);
    placeInSim(sim, c, 85, 0);
    a.item = 'bananaPeel';
    sim.items.useItem(a);
    c.item = 'bananaPeel';
    sim.items.useItem(c);
    placeInSim(sim, a, 200, 0);
    placeInSim(sim, c, 220, 0);
    const q = sim.track.query(sim.items.hazards[0].pos, 0)!;
    placeInSim(sim, b, q.s - 10, q.lateral, 18);
    const ev = stepFor(sim, 1.5);
    expect(ev.filter((e) => e.type === 'hit' && e.kart === b.id)).toHaveLength(1);
  });

  it('own projectile does not hit the thrower right after launch', () => {
    const sim = setup();
    const [a] = sim.karts;
    placeInSim(sim, a, 40, 0, 20);
    a.item = 'giantDogBone';
    sim.items.useItem(a);
    const ev = stepFor(sim, 0.5);
    expect(ev.some((e) => e.type === 'hit' && e.kart === a.id)).toBe(false);
  });
});

describe('specials', () => {
  const special = (char: CharacterId, others: CharacterId[] = ['dad']) => {
    const sim = setup([char, ...others]);
    const k = sim.karts[0];
    k.specialCooldown = 0;
    return { sim, k };
  };

  it('every character has a special with a sane cooldown', () => {
    expect(CHARACTERS.map((c) => c.id).sort()).toEqual([...ALL_CHARACTERS].sort());
    for (const c of CHARACTERS) {
      expect(c.special.cooldown).toBeGreaterThanOrEqual(10);
      expect(c.special.cooldown).toBeLessThanOrEqual(40);
    }
  });

  it('specials respect cooldown', () => {
    const { sim, k } = special('dad');
    sim.items.useSpecial(k);
    expect(k.specialCooldown).toBe(characterById('dad').special.cooldown);
    sim.drainEvents();
    sim.items.useSpecial(k);
    expect(sim.drainEvents().some((e) => e.type === 'special')).toBe(false);
  });

  it('dadBoost: big straight-line burst', () => {
    const { sim, k } = special('dad');
    placeInSim(sim, k, 40, 0, 25);
    sim.items.useSpecial(k);
    expect(k.boostKind).toBe('special');
    expect(k.boostTime).toBeGreaterThanOrEqual(1.5);
    expect(sim.drainEvents().some((e) => e.type === 'special' && e.special === 'dadBoost')).toBe(true);
  });

  it('momShield: blocks the next hit', () => {
    const { sim, k } = special('mom');
    sim.items.useSpecial(k);
    expect(k.shieldTime).toBeGreaterThan(0);
    const ev: SimEvent[] = [];
    expect(hitKart(k, 1, 'x', ev)).toBe(false);
    expect(ev[0].type).toBe('shieldBlock');
  });

  it('turboDrift: drift charges faster and boosts harder', () => {
    const charge = (useIt: boolean) => {
      const { sim, k } = special('brennan');
      placeInSim(sim, k, 20, 0, 25);
      if (useIt) sim.items.useSpecial(k);
      let maxCharge = 0;
      let boost = 0;
      // short drift (~1 s) so the kart stays clear of the walls
      for (let i = 0; i < 60; i++) {
        sim.step([{ throttle: 1, steer: k.drift.active ? -0.2 : 0.5, drift: true, useItem: false, useSpecial: false }]);
        maxCharge = Math.max(maxCharge, k.drift.charge);
      }
      sim.step([{ throttle: 1, steer: 0, drift: false, useItem: false, useSpecial: false }]);
      boost = k.boostKind.startsWith('drift') ? k.boostTime : 0;
      return { maxCharge, boost, turbo: k.turboDriftTime };
    };
    const plain = charge(false);
    const turbo = charge(true);
    expect(turbo.turbo).toBeGreaterThan(0);
    expect(turbo.maxCharge).toBeGreaterThan(plain.maxCharge * 1.5);
    expect(turbo.boost).toBeGreaterThan(plain.boost);
  });

  it('lightningDash: boost and pushes nearby racers aside', () => {
    const { sim, k } = special('parker');
    const o = sim.karts[1];
    placeInSim(sim, k, 40, 0, 10);
    placeInSim(sim, o, 40, 3.5, 10);
    const before = { ...o.vel };
    sim.items.useSpecial(k);
    expect(k.boostKind).toBe('special');
    const ev = sim.drainEvents();
    expect(ev.some((e) => e.type === 'bump')).toBe(true);
    const dv = Math.hypot(o.vel.x - before.x, o.vel.z - before.z);
    expect(dv).toBeGreaterThan(3);
    // shields block the shove
    placeInSim(sim, o, 40, 3.5, 10);
    o.shieldTime = 3;
    k.specialCooldown = 0;
    sim.items.useSpecial(k);
    expect(sim.drainEvents().some((e) => e.type === 'shieldBlock')).toBe(true);
  });

  it('puppyPanic: drops tennis balls that spin out a racer behind', () => {
    const { sim, k } = special('lupin');
    const o = sim.karts[1];
    placeInSim(sim, k, 80, 0, 10);
    sim.items.useSpecial(k);
    const balls = sim.items.hazards.filter((h) => h.kind === 'tennisBall');
    expect(balls).toHaveLength(3);
    placeInSim(sim, k, 300, 0);
    placeInSim(sim, o, 55, 0, 18);
    const ev = stepFor(sim, 3, (e) => e.some((x) => x.type === 'hit'));
    expect(ev.find((e) => e.type === 'hit')).toMatchObject({ kart: o.id, cause: 'tennisBall' });
    // balls stay on the road and above ground while bouncing
    for (const b of sim.items.hazards) {
      const q = sim.track.query(b.pos, 0)!;
      expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.wallDist + 1);
      expect(b.pos.y).toBeGreaterThan(-1);
    }
  });

  it("grandmasRevenge: homing pie hits the racer ahead", () => {
    const { sim, k } = special('grandma');
    const o = sim.karts[1];
    placeInSim(sim, k, 40, 0);
    placeInSim(sim, o, 110, -3);
    sim.items.useSpecial(k);
    expect(sim.items.projectiles[0]).toMatchObject({ kind: 'pie', target: o.id });
    const ev = stepFor(sim, 4, (e) => e.some((x) => x.type === 'hit'));
    expect(ev.find((e) => e.type === 'hit')).toMatchObject({ kart: o.id, by: k.id, cause: 'pie' });
  });
});

describe('position-weighted item odds', () => {
  const comeback: ItemId[] = ['rocketKart', 'flyingPizza', 'turboSoda'];
  const share = (w: Partial<Record<ItemId, number>>, ids: ItemId[]) => {
    const total = Object.values(w).reduce((a, b) => a + (b ?? 0), 0);
    return ids.reduce((a, id) => a + (w[id] ?? 0), 0) / total;
  };

  it('leader never gets rocketKart', () => {
    expect(itemWeights(0).rocketKart ?? 0).toBe(0);
    expect(itemWeights(0.2).rocketKart ?? 0).toBe(0);
    expect(itemWeights(1).rocketKart).toBeGreaterThan(0);
  });

  it('all weights are non-negative at every position', () => {
    for (let p = 0; p <= 1.0001; p += 0.1) for (const v of Object.values(itemWeights(p))) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('comeback share grows monotonically from first to last', () => {
    let prev = -1;
    for (let i = 0; i <= 5; i++) {
      const s = share(itemWeights(i / 5), comeback);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
    expect(share(itemWeights(1), comeback)).toBeGreaterThan(share(itemWeights(0), comeback) * 2);
  });

  it('rollItem in a race respects position (sampled)', () => {
    const sim = humanSim(OVAL, 6);
    const leader = sim.karts.find((k) => k.place === 1)!;
    const last = sim.karts.find((k) => k.place === 6)!;
    const counts = (k: KartState) => {
      const c: Partial<Record<ItemId, number>> = {};
      for (let i = 0; i < 3000; i++) {
        const it = sim.items.rollItem(k);
        c[it] = (c[it] ?? 0) + 1;
      }
      return c;
    };
    const lc = counts(leader);
    const tc = counts(last);
    expect(lc.rocketKart ?? 0).toBe(0);
    expect(tc.rocketKart ?? 0).toBeGreaterThan(100);
    expect((tc.flyingPizza ?? 0)).toBeGreaterThan(lc.flyingPizza ?? 0);
    expect((lc.bananaPeel ?? 0)).toBeGreaterThan(tc.bananaPeel ?? 0);
  });

  it('time trial always gives turboSoda', () => {
    const sim = humanSim(OVAL, 1, { mode: 'timeTrial' });
    for (let i = 0; i < 20; i++) expect(sim.items.rollItem(sim.karts[0])).toBe('turboSoda');
  });
});

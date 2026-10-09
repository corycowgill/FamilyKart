import { forwardOf, wrapDelta, type Vec3 } from '../../core/math';
import { characterById } from '../../data/characters';
import { applyBoost, hitKart } from '../kart/KartPhysics';
import type { RaceSim } from '../race/RaceSim';
import type { DroppedHazard, ItemBox, ItemId, KartState, Projectile, ProjectileKind, SpecialId } from '../types';
import { itemWeights } from './itemDefs';

export const ITEM_TUNING = {
  boxRespawn: 2.5,
  roulette: 1.2,
  sodaBoost: { duration: 1.4, power: 0.42 },
  rocket: { duration: 3.0, power: 0.55 },
  shield: 9,
  pizzaSpeed: 46,
  pieSpeed: 42,
  boneSpeed: 38,
  hazardLife: 40,
  potholeLife: 14,
};

/** Item boxes, inventory, projectiles, dropped hazards and signature specials. */
export class ItemSystem {
  boxes: ItemBox[] = [];
  projectiles: Projectile[] = [];
  hazards: DroppedHazard[] = [];
  private nextId = 1;

  constructor(private sim: RaceSim) {
    this.boxes = sim.track.itemBoxPositions.map((p, i) => ({ id: i, pos: { ...p }, respawn: 0 }));
  }

  step(dt: number): void {
    const sim = this.sim;
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        continue;
      }
      for (const k of sim.karts) {
        if (k.respawnTime > 0) continue;
        const dx = k.pos.x - b.pos.x, dz = k.pos.z - b.pos.z, dy = k.pos.y + 0.8 - b.pos.y;
        if (dx * dx + dz * dz < 2.2 * 2.2 && Math.abs(dy) < 2.5) {
          b.respawn = ITEM_TUNING.boxRespawn;
          sim.events.push({ type: 'itemPickup', kart: k.id });
          if (!k.item && k.itemRoulette <= 0) k.itemRoulette = ITEM_TUNING.roulette;
          break;
        }
      }
    }
    for (const k of sim.karts) {
      if (k.itemRoulette > 0) {
        k.itemRoulette -= dt;
        if (k.itemRoulette <= 0) {
          k.itemRoulette = 0;
          k.item = this.rollItem(k);
          sim.events.push({ type: 'itemGranted', kart: k.id, item: k.item });
        }
      }
      if (k.specialCooldown > 0) k.specialCooldown = Math.max(0, k.specialCooldown - dt);
    }
    this.stepProjectiles(dt);
    this.stepHazards(dt);
  }

  rollItem(k: KartState): ItemId {
    const n = this.sim.karts.length;
    const p = n > 1 ? (k.place - 1) / (n - 1) : 0;
    const w = itemWeights(p);
    if (this.sim.mode === 'timeTrial') return 'turboSoda';
    return this.sim.rng.weighted(w);
  }

  useItem(k: KartState): void {
    const item = k.item;
    if (!item || k.respawnTime > 0 || k.spinTime > 0) return;
    k.item = null;
    k.stats.itemsUsed++;
    k.reaction = 'item';
    k.reactionTime = 0.6;
    this.sim.events.push({ type: 'itemUse', kart: k.id, item });
    this.activate(k, item);
  }

  private activate(k: KartState, item: ItemId): void {
    const ev = this.sim.events;
    switch (item) {
      case 'turboSoda':
        applyBoost(k, ITEM_TUNING.sodaBoost.duration, ITEM_TUNING.sodaBoost.power, 'item');
        ev.push({ type: 'boost', kart: k.id, kind: 'item' });
        break;
      case 'rocketKart':
        applyBoost(k, ITEM_TUNING.rocket.duration, ITEM_TUNING.rocket.power, 'rocket');
        k.rocketTime = ITEM_TUNING.rocket.duration;
        ev.push({ type: 'boost', kart: k.id, kind: 'rocket' });
        break;
      case 'bubbleShield':
        k.shieldTime = ITEM_TUNING.shield;
        break;
      case 'flyingPizza':
        this.launch(k, 'pizza', this.targetAhead(k));
        break;
      case 'giantDogBone':
        this.launch(k, 'bone', -1);
        break;
      case 'bananaPeel':
        this.drop(k, 'banana', 0.9, ITEM_TUNING.hazardLife);
        break;
      case 'chicagoPothole':
        this.drop(k, 'pothole', 2.0, ITEM_TUNING.potholeLife);
        break;
      case 'mysteryBox': {
        const options: ItemId[] = ['turboSoda', 'flyingPizza', 'bananaPeel', 'bubbleShield', 'giantDogBone', 'chicagoPothole', 'rocketKart'];
        const next = this.sim.rng.pick(options);
        this.sim.events.push({ type: 'itemGranted', kart: k.id, item: next });
        this.activate(k, next);
        break;
      }
    }
  }

  useSpecial(k: KartState): void {
    if (k.specialCooldown > 0 || k.respawnTime > 0 || k.spinTime > 0) return;
    const def = characterById(k.character);
    k.specialCooldown = def.special.cooldown;
    k.specialMax = def.special.cooldown;
    k.reaction = 'item';
    k.reactionTime = 0.8;
    const id: SpecialId = def.special.id;
    this.sim.events.push({ type: 'special', kart: k.id, special: id });
    switch (id) {
      case 'dadBoost':
        applyBoost(k, 2.0, 0.48, 'special');
        this.sim.events.push({ type: 'boost', kart: k.id, kind: 'special' });
        break;
      case 'momShield':
        k.shieldTime = 6;
        break;
      case 'turboDrift':
        k.turboDriftTime = 7;
        applyBoost(k, 0.4, 0.2, 'special');
        break;
      case 'lightningDash': {
        applyBoost(k, 1.0, 0.6, 'special');
        this.sim.events.push({ type: 'boost', kart: k.id, kind: 'special' });
        for (const o of this.sim.karts) {
          if (o === k || o.respawnTime > 0) continue;
          const dx = o.pos.x - k.pos.x, dz = o.pos.z - k.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 7 && d > 0.01) {
            if (o.shieldTime > 0) {
              o.shieldTime = 0;
              this.sim.events.push({ type: 'shieldBlock', kart: o.id });
              continue;
            }
            o.vel.x += (dx / d) * 9;
            o.vel.z += (dz / d) * 9;
            o.vel.x *= 0.75;
            o.vel.z *= 0.75;
            this.sim.events.push({ type: 'bump', a: k.id, b: o.id, impact: 9 });
          }
        }
        break;
      }
      case 'puppyPanic':
        for (let i = 0; i < 3; i++) this.drop(k, 'tennisBall', 0.8, 25, (i - 1) * 2.2, 4 + i * 1.5);
        break;
      case 'grandmasRevenge':
        this.launch(k, 'pie', this.targetAhead(k));
        break;
    }
  }

  /** Nearest racer ahead in race order (or the leader if none). */
  targetAhead(k: KartState): number {
    let best = -1;
    let bestGap = Infinity;
    for (const o of this.sim.karts) {
      if (o === k || o.finished) continue;
      const gap = o.raceDistance - k.raceDistance;
      if (gap > 0 && gap < bestGap) {
        bestGap = gap;
        best = o.id;
      }
    }
    return best;
  }

  private launch(k: KartState, kind: ProjectileKind, target: number): void {
    const f = forwardOf(k.yaw);
    const speed = kind === 'pizza' ? ITEM_TUNING.pizzaSpeed : kind === 'pie' ? ITEM_TUNING.pieSpeed : ITEM_TUNING.boneSpeed;
    const pos = { x: k.pos.x + f.x * 2.5, y: k.pos.y + 0.9, z: k.pos.z + f.z * 2.5 };
    const p: Projectile = {
      id: this.nextId++, kind, owner: k.id, target, pos, prevPos: { ...pos }, yaw: k.yaw,
      s: k.mainS + 2.5, lateral: k.pathId === 0 ? k.lateral : 0, speed, life: kind === 'bone' ? 6 : 9, age: 0,
    };
    this.projectiles.push(p);
    this.sim.events.push({ type: 'projectile', id: p.id, kind, owner: k.id });
  }

  private drop(k: KartState, kind: DroppedHazard['kind'], radius: number, life: number, lateralOffset = 0, back = 3.2): void {
    const f = forwardOf(k.yaw);
    const r = { x: -f.z, z: f.x };
    const pos: Vec3 = { x: k.pos.x - f.x * back + r.x * lateralOffset, y: k.pos.y + (kind === 'tennisBall' ? 1.2 : 0.05), z: k.pos.z - f.z * back + r.z * lateralOffset };
    const vel: Vec3 = kind === 'tennisBall' ? { x: -f.x * 3 + r.x * lateralOffset, y: 5, z: -f.z * 3 + r.z * lateralOffset } : { x: 0, y: 0, z: 0 };
    this.hazards.push({ id: this.nextId++, kind, owner: k.id, pos, vel, radius, life, age: 0 });
    this.sim.events.push({ type: 'drop', kind, owner: k.id });
  }

  private stepProjectiles(dt: number): void {
    const sim = this.sim;
    const track = sim.track;
    const L = track.length;
    for (const p of this.projectiles) {
      p.age += dt;
      p.life -= dt;
      p.prevPos = { ...p.pos };
      const target = p.target >= 0 ? sim.karts[p.target] : undefined;
      if (p.kind === 'bone') {
        // rolls along the track at a fixed lateral offset
        p.s += p.speed * dt;
        const pt = track.pointAt(0, p.s, p.lateral);
        const smp = track.sampleAt(0, p.s);
        p.pos = { x: pt.x, y: pt.y + 0.9, z: pt.z };
        p.yaw = Math.atan2(smp.tx, smp.tz);
      } else if (target && !target.finished) {
        const gap = wrapDelta(target.mainS - p.s, L);
        const d3 = Math.hypot(target.pos.x - p.pos.x, target.pos.z - p.pos.z);
        if (d3 < 18) {
          // direct homing
          const dx = target.pos.x - p.pos.x, dz = target.pos.z - p.pos.z;
          const step = Math.min(d3, p.speed * dt);
          p.pos.x += (dx / (d3 || 1)) * step;
          p.pos.z += (dz / (d3 || 1)) * step;
          p.pos.y += (target.pos.y + 0.9 - p.pos.y) * Math.min(1, dt * 8);
          p.yaw = Math.atan2(dx, dz);
          p.s = target.mainS - d3;
        } else {
          p.s += p.speed * dt * (gap < 0 ? 0.3 : 1);
          p.lateral += (target.lateral - p.lateral) * Math.min(1, dt * 2);
          const pt = track.pointAt(0, p.s, p.lateral);
          const smp = track.sampleAt(0, p.s);
          p.pos = { x: pt.x, y: pt.y + 1.2 + Math.sin(p.age * 6) * 0.2, z: pt.z };
          p.yaw = Math.atan2(smp.tx, smp.tz);
        }
      } else {
        p.s += p.speed * dt;
        const pt = track.pointAt(0, p.s, p.lateral);
        p.pos = { x: pt.x, y: pt.y + 1.2, z: pt.z };
      }
      for (const k of sim.karts) {
        if (k.respawnTime > 0) continue;
        if (k.id === p.owner && p.age < 0.6) continue;
        if (p.kind !== 'bone' && p.target >= 0 && k.id !== p.target && k.id === p.owner) continue;
        const dx = k.pos.x - p.pos.x, dz = k.pos.z - p.pos.z, dy = k.pos.y + 0.8 - p.pos.y;
        if (dx * dx + dz * dz < 1.9 * 1.9 && Math.abs(dy) < 2.5) {
          if (p.kind === 'bone' && k.shieldTime <= 0 && k.invulnTime <= 0 && k.rocketTime <= 0) {
            const smp = track.sampleAt(0, p.s);
            const side = (k.lateral >= p.lateral ? 1 : -1) * 8;
            k.vel.x += smp.nx * side;
            k.vel.z += smp.nz * side;
          }
          hitKart(k, p.owner, p.kind, sim.events, p.kind === 'bone' ? 0.8 : 1.1);
          p.life = 0;
          break;
        }
      }
      // projectiles collide with dropped hazards
      for (const h of this.hazards) {
        if (h.life <= 0 || h.kind === 'pothole') continue;
        const dx = h.pos.x - p.pos.x, dz = h.pos.z - p.pos.z;
        if (dx * dx + dz * dz < 1.5 * 1.5) {
          h.life = 0;
          p.life = 0;
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.life > 0);
  }

  private stepHazards(dt: number): void {
    const sim = this.sim;
    for (const h of this.hazards) {
      h.age += dt;
      h.life -= dt;
      if (h.kind === 'tennisBall') {
        h.vel.y -= 22 * dt;
        h.pos.x += h.vel.x * dt;
        h.pos.y += h.vel.y * dt;
        h.pos.z += h.vel.z * dt;
        const q = sim.track.query(h.pos, 0);
        const gy = (q ? q.groundY : 0) + h.radius * 0.5;
        if (h.pos.y < gy) {
          h.pos.y = gy;
          h.vel.y = Math.abs(h.vel.y) * 0.62;
          if (h.vel.y < 2.5) h.vel.y = 5.5; // keep bouncing forever, it's a dog toy
          h.vel.x *= 0.7;
          h.vel.z *= 0.7;
        }
        if (q && Math.abs(q.lateral) > q.wallDist - 1) {
          h.vel.x = -h.vel.x;
          h.vel.z = -h.vel.z;
        }
      }
      for (const k of sim.karts) {
        if (k.respawnTime > 0) continue;
        if (k.id === h.owner && h.age < 1) continue;
        const dx = k.pos.x - h.pos.x, dz = k.pos.z - h.pos.z;
        const r = h.radius + k.tuning.radius * 0.7;
        if (dx * dx + dz * dz < r * r && Math.abs(k.pos.y - h.pos.y) < 2.2) {
          if (k.rocketTime > 0) {
            h.life = 0;
            break;
          }
          if (h.kind === 'pothole') {
            if (k.invulnTime <= 0 && k.shieldTime <= 0) {
              k.vel.x *= 0.55;
              k.vel.z *= 0.55;
              k.vy = 4;
              k.grounded = false;
              k.invulnTime = 1;
              k.reaction = 'hit';
              k.reactionTime = 0.8;
              sim.events.push({ type: 'hit', kart: k.id, by: h.owner, cause: 'pothole' });
            }
          } else if (hitKart(k, h.owner, h.kind, sim.events, h.kind === 'banana' ? 1 : 0.8) || k.shieldTime <= 0) {
            h.life = 0;
            break;
          } else {
            h.life = 0;
          }
        }
      }
    }
    this.hazards = this.hazards.filter((h) => h.life > 0);
  }
}

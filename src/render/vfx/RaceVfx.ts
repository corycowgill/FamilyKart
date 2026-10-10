import * as THREE from 'three';
import { characterById } from '../../data/characters';
import type { RaceSim } from '../../sim/race/RaceSim';
import type { Track } from '../../sim/track/Track';
import type { KartState, SimEvent } from '../../sim/types';
import { creamSplat, projectileImpact } from '../ItemsView';
import { DRIFT_COLORS, type KartView } from '../KartView';
import { SPRITE, sprayColor, type Effects } from '../Particles';
import { WindVolume } from './Wind';

/** Chicago flag palette (+ gold) used for celebrations. */
const CHI = ['#ff2338', '#ffffff', '#7fd3ff', '#ffc43a'];
const RWB = ['#ff2338', '#ffffff', '#2f6bff', '#7fd3ff'];
const UP = new THREE.Vector3(0, 1, 0);
const tv = new THREE.Vector3();

interface Timed {
  t: number;
  dur: number;
  step: (t: number, dt: number) => void;
}

interface Sweep {
  vol: WindVolume;
  s: number;
  t: number;
  lateral: number;
  owner: number;
}

/**
 * Race "VFX director": turns sim events and kart state into particle / ring / arc / wind effects
 * (event → VFX hookups live here so RaceSession stays a thin forwarder). Owns the Windy City Gust
 * sweep volumes and short-lived timed emitters (final-lap confetti swirl, finish fountain, ...).
 */
export class RaceVfx {
  private timed: Timed[] = [];
  private sweeps: Sweep[] = [];
  private sweepPool: WindVolume[] = [];
  private respawning = new Map<number, boolean>();
  private time = 0;
  /** per local player: hit-flash amount (0..1) + colour for the PostFX vignette */
  readonly hit: Array<{ amount: number; color: THREE.Color }> = [];

  constructor(
    private scene: THREE.Scene,
    private fx: Effects,
    private views: KartView[],
    private sim: RaceSim,
    private track: Track,
    private players: KartState[],
  ) {
    for (let i = 0; i < players.length; i++) this.hit.push({ amount: 0, color: new THREE.Color('#ff4030') });
  }

  private v(id: number): KartView | undefined {
    return this.views[id];
  }
  private local(id: number): boolean {
    return !!this.sim.karts[id]?.isHuman;
  }
  /** don't spend particles on karts far away from every player (AI events on the other side of the map) */
  private near(p: THREE.Vector3, r = 90): boolean {
    if (!this.players.length) return true;
    for (const k of this.players) if (Math.hypot(k.pos.x - p.x, k.pos.z - p.z) < r) return true;
    return false;
  }
  private fwd(view: KartView): [number, number] {
    return [Math.sin(view.interpYaw), Math.cos(view.interpYaw)];
  }
  private flash(kart: number, color: THREE.ColorRepresentation, amount: number): void {
    const i = this.players.findIndex((p) => p.id === kart);
    if (i < 0) return;
    const h = this.hit[i];
    h.amount = Math.min(1, Math.max(h.amount, amount));
    h.color.set(color);
  }
  private after(dur: number, step: (t: number, dt: number) => void): void {
    this.timed.push({ t: 0, dur, step });
  }

  onEvent(e: SimEvent): void {
    const fx = this.fx;
    switch (e.type) {
      case 'countdown': {
        const col = e.n >= 3 ? '#ff3344' : e.n === 2 ? '#ff9a2e' : '#ffd23a';
        for (const p of this.players) {
          const v = this.v(p.id);
          if (!v) continue;
          const [fx0, fz0] = this.fwd(v);
          const x = v.interpPos.x + fx0 * 9, y = v.interpPos.y + 4.5, z = v.interpPos.z + fz0 * 9;
          for (let i = 0; i < fx.n(14); i++) fx.glow.emit({ x, y, z, spread: 4, color: col, sprite: i % 2 ? SPRITE.SPARKLE : SPRITE.STAR, size: 0.6, life: 0.6, drag: 3, spin: 5, curve: 'shrink' });
          fx.rings.spawn({ x, y, z, normal: tv.set(fx0, 0, fz0), color: col, size: 3, life: 0.5, thickness: 0.2 });
        }
        break;
      }
      case 'go':
        for (const p of this.players) {
          const v = this.v(p.id);
          if (!v) continue;
          const [fx0, fz0] = this.fwd(v);
          const x = v.interpPos.x + fx0 * 9, y = v.interpPos.y + 4.5, z = v.interpPos.z + fz0 * 9;
          fx.burst(x, y, z, ['#3cff6a', '#ffffff', '#ffd23a'], 40, 9);
          fx.rings.spawn({ x, y, z, normal: tv.set(fx0, 0, fz0), color: '#3cff6a', size: 6, life: 0.6, thickness: 0.16 });
          fx.rings.spawn({ x: v.interpPos.x, y: v.interpPos.y + 0.2, z: v.interpPos.z, color: '#9cffb0', size: 7, life: 0.7, thickness: 0.12 });
        }
        break;
      case 'lap': {
        if (!this.local(e.kart)) break;
        const k = this.sim.karts[e.kart];
        const smp = this.track.sampleAt(0, k.mainS);
        const n = fx.n(26);
        for (let i = 0; i < n; i++) {
          const l = -smp.halfWidth + (i / Math.max(1, n - 1)) * smp.halfWidth * 2;
          fx.glow.emit({ x: smp.x + smp.nx * l, y: smp.y + 0.4, z: smp.z + smp.nz * l, vy: 4 + Math.random() * 3, spread: 0.6, color: i % 2 ? '#ffd23a' : '#ffffff', sprite: i % 3 ? SPRITE.SPARKLE : SPRITE.STAR, size: 0.6, life: 0.9, drag: 1.5, spin: 5, curve: 'shrink' });
        }
        break;
      }
      case 'finalLap': {
        if (!this.local(e.kart)) break;
        const id = e.kart;
        // red / white / blue confetti swirl spiralling around the kart
        this.after(1.8, (t) => {
          const v = this.v(id);
          if (!v) return;
          for (let i = 0; i < Math.max(1, fx.n(4)); i++) {
            const a = t * 9 + i * 1.7 + Math.random();
            const r = 2.2;
            fx.smoke.emit({
              x: v.interpPos.x + Math.cos(a) * r, y: v.interpPos.y + 0.5 + t * 1.5, z: v.interpPos.z + Math.sin(a) * r,
              vx: -Math.sin(a) * 7 + (this.sim.karts[id].vel.x), vz: Math.cos(a) * 7 + (this.sim.karts[id].vel.z), vy: 3,
              color: RWB[(i + Math.floor(t * 20)) % RWB.length], sprite: i % 4 === 0 ? SPRITE.STREAMER : SPRITE.CONFETTI, size: i % 4 === 0 ? 0.55 : 0.3, life: 1.4, drag: 1.4, gravity: 2.5, flutter: i % 4 !== 0, spin: 4,
            });
          }
          if (Math.random() < 0.3) fx.glow.emit({ x: v.interpPos.x, y: v.interpPos.y + 2.5, z: v.interpPos.z, spread: 3, color: '#ffffff', sprite: SPRITE.STAR, size: 0.5, life: 0.5, curve: 'shrink', spin: 5 });
        });
        break;
      }
      case 'finish': {
        if (!this.local(e.kart)) break;
        const v = this.v(e.kart);
        if (!v) break;
        const p = v.interpPos;
        fx.burst(p.x, p.y + 2, p.z, [...CHI, '#7cff6a'], 90, 11);
        fx.rings.spawn({ x: p.x, y: p.y + 0.3, z: p.z, color: '#ffd23a', size: 10, life: 0.8, thickness: 0.12 });
        fx.rings.spawn({ x: p.x, y: p.y + 2, z: p.z, normal: tv.set(Math.sin(v.interpYaw), 0, Math.cos(v.interpYaw)), color: '#ffffff', size: 7, life: 0.6, thickness: 0.14 });
        const id = e.kart;
        // confetti + streamer fountain keeps going for a moment
        this.after(2.2, (t) => {
          const vv = this.v(id);
          if (!vv) return;
          for (let i = 0; i < Math.max(1, fx.n(5)); i++) {
            const a = Math.random() * Math.PI * 2;
            const streamer = i % 3 === 0;
            fx.smoke.emit({
              x: vv.interpPos.x + Math.cos(a) * 3, y: vv.interpPos.y + 1, z: vv.interpPos.z + Math.sin(a) * 3, vx: Math.cos(a) * 3, vz: Math.sin(a) * 3, vy: 10 + Math.random() * 4,
              color: CHI[(i + Math.floor(t * 13)) % CHI.length], sprite: streamer ? SPRITE.STREAMER : SPRITE.CONFETTI, size: streamer ? 0.7 : 0.34, life: 2.6, gravity: 5, drag: 1.1, flutter: !streamer, spin: 4,
            });
          }
          if (Math.random() < 0.25) fx.glow.emit({ x: vv.interpPos.x + (Math.random() - 0.5) * 8, y: vv.interpPos.y + 4 + Math.random() * 3, z: vv.interpPos.z + (Math.random() - 0.5) * 8, color: CHI[Math.floor(Math.random() * 4)], sprite: SPRITE.BURST, size: 1.6, life: 0.3, curve: 'flash' });
        });
        break;
      }
      case 'itemUse': {
        const v = this.v(e.kart);
        if (!v || !this.near(v.interpPos)) break;
        const p = v.interpPos;
        if (e.item === 'bubbleShield') {
          v.setShieldStyle('bubble');
          fx.rings.spawn({ x: p.x, y: p.y + 1, z: p.z, normal: UP, color: '#5fd2ff', size: 3.2, life: 0.4, thickness: 0.2 });
          for (let i = 0; i < fx.n(10); i++) fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, spread: 4, color: '#9fe8ff', sprite: SPRITE.SPARKLE, size: 0.5, life: 0.5, drag: 3, spin: 4, curve: 'shrink' });
        } else if (e.item === 'mysteryBox') {
          fx.glow.emit({ x: p.x, y: p.y + 2.5, z: p.z, color: '#ffd23a', sprite: SPRITE.BURST, size: 3, life: 0.3, curve: 'flash' });
          for (let i = 0; i < fx.n(16); i++) fx.glow.emit({ x: p.x, y: p.y + 2.5, z: p.z, spread: 5, vy: 2, color: new THREE.Color().setHSL(i / 16, 0.9, 0.6), sprite: SPRITE.STAR, size: 0.55, life: 0.7, drag: 2.5, spin: 6, curve: 'shrink' });
        } else if (e.item === 'turboSoda') {
          // fizzy soda burst
          for (let i = 0; i < fx.n(16); i++) fx.smoke.emit({ x: p.x, y: p.y + 1, z: p.z, spread: 2.5, vy: 5, color: '#c9f0ff', sprite: SPRITE.DROP, size: 0.25, life: 0.6, gravity: 12, stretch: 1 });
        } else if (e.item === 'rocketKart') {
          fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, color: '#ff7a2e', sprite: SPRITE.BURST, size: 4, life: 0.3, curve: 'flash' });
          for (let i = 0; i < fx.n(10); i++) fx.puff(p.x, p.y + 0.6, p.z, '#d6d0dc', 1.1, { spread: 4, vy: 1.5, life: 1.1, grow: 2.4 });
          fx.dustRings.spawn({ x: p.x, y: p.y + 0.2, z: p.z, color: '#c8c0b8', size: 6, life: 0.6, thickness: 0.35, style: 1, alpha: 0.9 });
        }
        break;
      }
      case 'projectile': {
        const v = this.v(e.owner);
        if (!v || !this.near(v.interpPos)) break;
        const [a, b] = this.fwd(v);
        for (let i = 0; i < fx.n(4); i++) fx.puff(v.interpPos.x + a * 1.8, v.interpPos.y + 1, v.interpPos.z + b * 1.8, '#f4efe4', 0.8, { spread: 1.5, vy: 1, life: 0.5 });
        break;
      }
      case 'special':
        this.special(e.kart, e.special);
        break;
      case 'hit':
        this.hitFx(e.kart, e.cause);
        break;
      case 'shieldBlock': {
        const v = this.v(e.kart);
        if (!v) break;
        v.shieldBlock();
        const p = v.interpPos;
        fx.rings.spawn({ x: p.x, y: p.y + 1, z: p.z, normal: UP, color: '#8fe6ff', size: 3.6, life: 0.4, thickness: 0.18 });
        for (let i = 0; i < fx.n(18); i++) fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, spread: 7, vy: 2, color: i % 2 ? '#bff3ff' : '#d0a8ff', size: 0.3, life: 0.45, gravity: 6, drag: 2, stretch: 1 });
        fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, color: '#9fe8ff', sprite: SPRITE.BURST, size: 3.2, life: 0.25, curve: 'flash' });
        this.flash(e.kart, '#7fdcff', 0.5);
        break;
      }
      case 'boost':
        this.boostFx(e.kart, e.kind);
        break;
      case 'driftTier': {
        const v = this.v(e.kart);
        if (!v || !this.near(v.interpPos, 60)) break;
        const c = DRIFT_COLORS[Math.min(3, e.tier)];
        for (const rc of v.kart.rearContacts) {
          rc.getWorldPosition(tv);
          for (let i = 0; i < fx.n(6); i++) fx.glow.emit({ x: tv.x, y: tv.y + 0.3, z: tv.z, spread: 3, vy: 2, color: c, sprite: SPRITE.STAR, size: 0.45, life: 0.4, drag: 3, spin: 6, curve: 'shrink' });
          fx.glow.emit({ x: tv.x, y: tv.y + 0.3, z: tv.z, color: c, sprite: SPRITE.BURST, size: 1.3, life: 0.18, curve: 'flash' });
        }
        break;
      }
      case 'jump': {
        const v = this.v(e.kart);
        if (!v || !this.near(v.interpPos, 60)) break;
        for (let i = 0; i < fx.n(4); i++) fx.puff(v.interpPos.x, v.interpPos.y + 0.2, v.interpPos.z, '#e9e4da', 0.6, { spread: 1.2, vy: 0.5, life: 0.45 });
        break;
      }
      case 'land':
        this.landFx(e.kart, e.impact);
        break;
      case 'bump': {
        const a = this.v(e.a)?.interpPos, b = this.v(e.b)?.interpPos;
        if (!a || !b || !this.near(a, 70)) break;
        const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2 + 0.8, z = (a.z + b.z) / 2;
        for (let i = 0; i < fx.n(6); i++) fx.glow.emit({ x, y, z, spread: 4, vy: 3, color: i % 2 ? '#fff6a0' : '#ffffff', sprite: SPRITE.STAR, size: 0.5, life: 0.45, gravity: 6, drag: 2, spin: 8, curve: 'shrink' });
        for (let i = 0; i < fx.n(6); i++) fx.glow.emit({ x, y, z, spread: 6, vy: 2, color: '#ffe08a', size: 0.22, life: 0.3, gravity: 10, stretch: 1 });
        fx.glow.emit({ x, y, z, color: '#fff6a0', sprite: SPRITE.BURST, size: 1.6 + Math.min(1.5, e.impact * 0.1), life: 0.18, curve: 'flash' });
        break;
      }
      case 'wall': {
        const k = this.sim.karts[e.kart];
        const v = this.v(e.kart);
        if (!v || !this.near(v.interpPos, 70)) break;
        // scraping sparks thrown off the wall side
        const smp = this.track.sampleAt(0, k.mainS);
        const side = Math.sign(k.lateral) || 1;
        const x = v.interpPos.x + smp.nx * side * 0.9, y = v.interpPos.y + 0.5, z = v.interpPos.z + smp.nz * side * 0.9;
        const n = fx.n(Math.min(26, 8 + e.impact));
        for (let i = 0; i < n; i++) {
          fx.glow.emit({ x, y, z, vx: -smp.nx * side * 4 - k.vel.x * 0.3, vz: -smp.nz * side * 4 - k.vel.z * 0.3, vy: 3 + Math.random() * 3, spread: 3, color: '#ffffff', color2: '#ff9a2e', size: 0.2, life: 0.4, gravity: 16, stretch: 1.4, floor: k.groundY + 0.05 });
        }
        fx.glow.emit({ x, y, z, color: '#ffd27a', sprite: SPRITE.BURST, size: 1.2, life: 0.15, curve: 'flash' });
        if (e.impact > 8) fx.puff(x, y, z, '#d8d4cc', 0.9, { spread: 1, vy: 1 });
        break;
      }
      case 'overtake': {
        if (!this.local(e.kart)) break;
        const v = this.v(e.kart);
        if (!v) break;
        for (let i = 0; i < fx.n(5); i++) fx.glow.emit({ x: v.interpPos.x, y: v.interpPos.y + 2.6, z: v.interpPos.z, spread: 2, vy: 2, color: '#ffd23a', sprite: SPRITE.STAR, size: 0.45, life: 0.5, drag: 3, spin: 5, curve: 'shrink' });
        break;
      }
      case 'gust':
        this.gustFx(e.kart, e.victims);
        break;
      default:
        break;
    }
  }

  private special(id: number, sp: string): void {
    const fx = this.fx;
    const v = this.v(id);
    if (!v || !this.near(v.interpPos)) return;
    const p = v.interpPos;
    const col = characterById(this.sim.karts[id].character).colors.primary;
    switch (sp) {
      case 'dadBoost':
        fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, color: '#ff9a2e', sprite: SPRITE.BURST, size: 4, life: 0.3, curve: 'flash' });
        for (let i = 0; i < fx.n(16); i++) fx.glow.emit({ x: p.x, y: p.y + 0.6, z: p.z, spread: 6, vy: 3, color: '#ffe08a', color2: '#ff5a1a', sprite: SPRITE.FLAME, size: 0.9, life: 0.5, drag: 3, curve: 'shrink' });
        break;
      case 'momShield':
        v.setShieldStyle('mom');
        fx.rings.spawn({ x: p.x, y: p.y + 1, z: p.z, normal: UP, color: '#ff6fc8', size: 3.6, life: 0.5, thickness: 0.2 });
        for (let i = 0; i < fx.n(14); i++) fx.glow.emit({ x: p.x, y: p.y + 1.2, z: p.z, spread: 4, vy: 2, color: i % 2 ? '#ff9ad5' : '#ffd36a', sprite: SPRITE.STAR, size: 0.5, life: 0.7, drag: 3, spin: 5, curve: 'shrink' });
        break;
      case 'turboDrift':
        fx.rings.spawn({ x: p.x, y: p.y + 0.3, z: p.z, color: '#b34dff', size: 6, life: 0.55, thickness: 0.16 });
        for (let i = 0; i < fx.n(16); i++) fx.glow.emit({ x: p.x, y: p.y + 0.5, z: p.z, spread: 5, vy: 3, color: '#d58bff', sprite: SPRITE.SPARKLE, size: 0.55, life: 0.6, drag: 3, spin: 6, curve: 'shrink' });
        break;
      case 'lightningDash':
        fx.arcs.add(() => (this.sim.karts[id].respawnTime > 0 ? null : v.interpPos), 1.0, '#9fdcff', 2.8);
        fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, color: '#bfe8ff', sprite: SPRITE.BURST, size: 5, life: 0.25, curve: 'flash' });
        fx.rings.spawn({ x: p.x, y: p.y + 0.3, z: p.z, color: '#7fd3ff', size: 7, life: 0.4, thickness: 0.12 });
        break;
      case 'puppyPanic':
        for (let i = 0; i < fx.n(26); i++) {
          const ball = i % 4 === 0;
          fx.smoke.emit({ x: p.x, y: p.y + 1.5, z: p.z, spread: 6, vy: 7, color: ball ? '#d7f23a' : ['#d7f23a', '#ffffff', '#ff9ad5', '#7fd3ff'][i % 4], sprite: ball ? SPRITE.BALL : SPRITE.CONFETTI, size: ball ? 0.45 : 0.3, life: 1.4, gravity: 8, drag: 1.4, flutter: !ball, spin: 6, floor: p.y });
        }
        break;
      case 'grandmasRevenge':
        for (let i = 0; i < fx.n(14); i++) fx.glow.emit({ x: p.x, y: p.y + 1.5, z: p.z, spread: 4, vy: 2, color: i % 2 ? '#ff9ad5' : '#ffffff', sprite: SPRITE.SPARKLE, size: 0.5, life: 0.6, drag: 3, spin: 5, curve: 'shrink' });
        break;
      default:
        fx.burst(p.x, p.y + 1.5, p.z, [col, '#ffffff'], 30, 6);
    }
  }

  private hitFx(id: number, cause: string): void {
    const fx = this.fx;
    const v = this.v(id);
    if (!v) return;
    const p = v.interpPos;
    const x = p.x, y = p.y + 1, z = p.z;
    const nearby = this.near(p);
    switch (cause) {
      case 'wind':
        this.flash(id, '#bfe8ff', 0.45);
        if (!nearby) return;
        for (let i = 0; i < fx.n(14); i++) fx.smoke.emit({ x, y, z, spread: 5, vy: 3, color: i % 2 ? '#e8a43a' : '#9ccf4a', sprite: SPRITE.LEAF, size: 0.35, life: 0.9, drag: 1.2, spin: 9, gravity: 2 });
        fx.dustRings.spawn({ x, y: p.y + 0.3, z, color: '#eef8ff', size: 3.5, life: 0.5, thickness: 0.3, style: 1, alpha: 0.7 });
        return;
      case 'pie':
        this.flash(id, '#ffffff', 0.8);
        if (nearby) creamSplat(fx, x, y + 0.4, z);
        return;
      case 'banana':
        this.flash(id, '#ffd23a', 0.6);
        if (!nearby) return;
        for (let i = 0; i < fx.n(12); i++) fx.smoke.emit({ x, y: p.y + 0.4, z, spread: 4, vy: 4, color: i % 3 ? '#ffd83a' : '#fff2b0', sprite: SPRITE.BLOB, size: 0.3, life: 0.7, gravity: 12, spin: 6, floor: p.y + 0.05 });
        fx.dustRings.spawn({ x, y: p.y + 0.2, z, color: '#ffe58a', size: 3, life: 0.45, thickness: 0.35, style: 1, alpha: 0.8 });
        break;
      case 'pothole':
        this.flash(id, '#ff9a5a', 0.6);
        if (!nearby) return;
        for (let i = 0; i < fx.n(12); i++) fx.smoke.emit({ x, y: p.y + 0.3, z, spread: 5, vy: 5, color: '#3a3632', sprite: SPRITE.SHARD, size: 0.3, life: 0.8, gravity: 14, spin: 10, floor: p.y });
        for (let i = 0; i < fx.n(5); i++) fx.puff(x, p.y + 0.4, z, '#a89c8c', 1.2, { spread: 2.5, vy: 1.5, life: 0.9 });
        break;
      case 'pizza':
      case 'bone':
        this.flash(id, '#ff6a3a', 0.75);
        if (nearby) projectileImpact(fx, cause, x, y, z);
        break;
      default:
        this.flash(id, '#ff4030', 0.75);
        if (!nearby) return;
        fx.glow.emit({ x, y, z, color: '#ffb347', sprite: SPRITE.BURST, size: 3, life: 0.28, curve: 'flash', grow: 1.5 });
        for (let i = 0; i < fx.n(4); i++) fx.puff(x, y, z, '#ece4d8', 1, { spread: 2.5, vy: 1.5 });
    }
    // dizzy stars pop
    for (let i = 0; i < fx.n(8); i++) fx.glow.emit({ x, y: y + 1, z, spread: 5, vy: 3, color: i % 2 ? '#ffd23f' : '#ffffff', sprite: SPRITE.STAR, size: 0.5, life: 0.55, gravity: 6, drag: 2, spin: 7, curve: 'shrink' });
  }

  private boostFx(id: number, kind: KartState['boostKind']): void {
    const fx = this.fx;
    const v = this.v(id);
    if (!v || !this.near(v.interpPos, 70)) return;
    const [a, b] = this.fwd(v);
    const p = v.interpPos;
    const tier = kind === 'drift1' ? 1 : kind === 'drift2' ? 2 : kind === 'drift3' ? 3 : 0;
    const col = tier ? DRIFT_COLORS[tier] : kind === 'rocket' ? '#ff6a2e' : kind === 'special' ? '#ffb02e' : kind === 'pad' ? '#ffd23a' : '#ffb02e';
    // shockwave ring released behind the kart (+ a ground ring for the strongest boosts)
    const bx = p.x - a * 1.4, by = p.y + 0.8, bz = p.z - b * 1.4;
    fx.rings.spawn({ x: bx, y: by, z: bz, normal: tv.set(a, 0, b), color: col, size: 2.4 + tier * 0.5 + (kind === 'rocket' ? 1.5 : 0), start: 0.25, life: 0.38, thickness: 0.22 });
    if (tier === 3 || kind === 'rocket' || kind === 'special') fx.rings.spawn({ x: p.x, y: p.y + 0.15, z: p.z, color: col, size: 5, life: 0.5, thickness: 0.12 });
    fx.glow.emit({ x: bx, y: by, z: bz, color: col, sprite: SPRITE.BURST, size: 1.8 + tier * 0.4, life: 0.2, curve: 'flash' });
    const n = fx.n(8 + tier * 5);
    for (let i = 0; i < n; i++) {
      fx.glow.emit({ x: bx, y: by, z: bz, vx: -a * 8, vz: -b * 8, vy: 2, spread: 5, color: '#ffffff', color2: col, size: 0.24, life: 0.4, gravity: 8, drag: 1.5, stretch: 1.3 });
    }
    if (tier >= 2) for (let i = 0; i < fx.n(tier * 2); i++) fx.glow.emit({ x: bx, y: by, z: bz, spread: 4, vy: 2, color: col, sprite: SPRITE.STAR, size: 0.5, life: 0.5, drag: 3, spin: 6, curve: 'shrink' });
  }

  private landFx(id: number, impact: number): void {
    const fx = this.fx;
    const v = this.v(id);
    const k = this.sim.karts[id];
    if (!v || impact < 4 || !this.near(v.interpPos, 70)) return;
    const p = v.interpPos;
    const big = Math.min(1, (impact - 4) / 10);
    const wet = k.surface === 'milk' || k.surface === 'mud';
    const sc = sprayColor(this.fx.theme, k.offroad ? 'offroad' : k.surface);
    const ground = k.surface === 'road' && !k.offroad ? '#e4e0d8' : sc.color;
    fx.dustRings.spawn({ x: p.x, y: k.groundY + 0.12, z: p.z, color: wet ? sc.color : ground, size: 3 + big * 3, life: 0.5, thickness: 0.4, style: 1, alpha: 0.85 });
    for (let i = 0; i < fx.n(5 + big * 6); i++) {
      const a = Math.random() * Math.PI * 2;
      fx.puff(p.x + Math.cos(a) * 1.2, k.groundY + 0.3, p.z + Math.sin(a) * 1.2, ground, 0.8 + big * 0.5, { vx: Math.cos(a) * 4, vz: Math.sin(a) * 4, vy: 0.8, life: 0.6 });
    }
    if (wet) {
      // splash crown + droplets
      const col = k.surface === 'milk' ? '#fffaf0' : '#6b4a2b';
      for (let i = 0; i < fx.n(18 + big * 14); i++) {
        const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 3;
        fx.smoke.emit({ x: p.x, y: k.groundY + 0.3, z: p.z, vx: Math.cos(a) * r, vz: Math.sin(a) * r, vy: 5 + Math.random() * 4, color: col, sprite: SPRITE.DROP, size: 0.3, life: 0.7, gravity: 16, stretch: 1, floor: k.groundY });
      }
      fx.dustRings.spawn({ x: p.x, y: k.groundY + 0.1, z: p.z, color: col, size: 4.5, life: 0.7, thickness: 0.18, style: 1 });
    }
  }

  private gustFx(id: number, victims: number[]): void {
    const fx = this.fx;
    const k = this.sim.karts[id];
    if (!k) return;
    if (fx.quality !== 'low') {
      let vol = this.sweepPool.pop();
      if (!vol) {
        vol = new WindVolume({ kind: 'tunnel', radius: 4.2, length: 18, lanes: 16, swirl: 0.55, density: 0.7, color: '#d8f0ff', width: 1.8 });
        vol.uniforms.color.value.multiplyScalar(1.8);
        this.scene.add(vol.mesh);
      }
      this.sweeps.push({ vol, s: k.mainS, t: 0, lateral: k.lateral, owner: id });
    }
    const v = this.v(id);
    if (v && this.near(v.interpPos)) {
      const [a, b] = this.fwd(v);
      for (let i = 0; i < fx.n(20); i++) fx.smoke.emit({ x: v.interpPos.x, y: v.interpPos.y + 1.5, z: v.interpPos.z, vx: a * 18, vz: b * 18, vy: 2, spread: 4, color: i % 3 ? '#9ccf4a' : '#e8a43a', sprite: SPRITE.LEAF, size: 0.35, life: 1, drag: 0.8, spin: 9 });
      fx.rings.spawn({ x: v.interpPos.x + a * 2, y: v.interpPos.y + 1.2, z: v.interpPos.z + b * 2, normal: tv.set(a, 0, b), color: '#dff4ff', size: 4, life: 0.45, thickness: 0.14 });
    }
    void victims;
  }

  update(dt: number): void {
    this.time += dt;
    const fx = this.fx;
    // hit flashes decay
    for (const h of this.hit) h.amount = Math.max(0, h.amount - dt * 2.2);
    // gust state for KartView swirls
    for (const k of this.sim.karts) {
      const v = this.v(k.id);
      if (v) v.blown = this.sim.items.blownTime(k.id);
    }
    // Windy City Gust sweep: a swirling wind tunnel racing ahead along the track
    this.sweeps = this.sweeps.filter((sw) => {
      sw.t += dt;
      const dur = 1.5;
      if (sw.t >= dur) {
        sw.vol.set(0, this.time);
        this.sweepPool.push(sw.vol);
        return false;
      }
      const s = sw.s + 6 + sw.t * 85;
      const smp = this.track.sampleAt(0, s);
      const lat = sw.lateral * (1 - sw.t / dur);
      const x = smp.x + smp.nx * lat, z = smp.z + smp.nz * lat;
      sw.vol.mesh.position.set(x, smp.y + 1.6, z);
      sw.vol.mesh.rotation.set(0, Math.atan2(smp.tx, smp.tz), 0);
      const env = Math.min(1, sw.t * 6) * Math.min(1, (dur - sw.t) * 3);
      sw.vol.set(env, this.time, -2.5, 0.6);
      if (this.near(tv.set(x, smp.y, z), 80)) {
        for (let i = 0; i < Math.max(1, fx.n(4)); i++) {
          const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 3.5;
          const px = x + smp.nx * Math.cos(a) * r, py = smp.y + 1.6 + Math.sin(a) * r * 0.7, pz = z + smp.nz * Math.cos(a) * r;
          if (i % 2) fx.smoke.emit({ x: px, y: Math.max(smp.y + 0.3, py), z: pz, vx: smp.tx * 40, vz: smp.tz * 40, vy: 1, spread: 2, color: i % 4 === 1 ? '#e8a43a' : '#9ccf4a', sprite: SPRITE.LEAF, size: 0.38, life: 0.6, drag: 1.5, spin: 10 });
          else fx.glow.emit({ x: px, y: Math.max(smp.y + 0.3, py), z: pz, vx: smp.tx * 50, vz: smp.tz * 50, color: '#bfe0ff', size: 0.16, life: 0.25, stretch: 1.6 });
        }
      }
      return true;
    });
    // respawn teleport: sparkle column at the drop-in spot, flash when the kart reappears
    for (const k of this.sim.karts) {
      const was = this.respawning.get(k.id) ?? false;
      const now = k.respawnTime > 0;
      if (now) {
        const p = k.lastSafe.pos;
        if (this.near(tv.set(p.x, p.y, p.z), 70) && Math.random() < 0.9) {
          const a = Math.random() * Math.PI * 2;
          fx.glow.emit({ x: p.x + Math.cos(a) * 1.4, y: p.y + 0.2, z: p.z + Math.sin(a) * 1.4, vy: 4 + Math.random() * 3, color: '#9fe8ff', color2: '#ffffff', sprite: Math.random() < 0.5 ? SPRITE.SPARKLE : SPRITE.SOFT, size: 0.4, life: 0.7, drag: 0.5, spin: 4, curve: 'shrink', stretch: 0 });
          if (Math.random() < 0.12) fx.rings.spawn({ x: p.x, y: p.y + 0.2 + Math.random() * 2.5, z: p.z, color: '#7fd3ff', size: 2.2, start: 0.8, life: 0.5, thickness: 0.15 });
        }
      } else if (was) {
        const v = this.v(k.id);
        if (v && this.near(v.interpPos, 70)) {
          const p = v.interpPos;
          fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, color: '#bff3ff', sprite: SPRITE.BURST, size: 3.5, life: 0.25, curve: 'flash' });
          fx.rings.spawn({ x: p.x, y: p.y + 0.2, z: p.z, color: '#7fd3ff', size: 4, life: 0.45, thickness: 0.16 });
          for (let i = 0; i < fx.n(14); i++) fx.glow.emit({ x: p.x, y: p.y + 1, z: p.z, spread: 4, vy: 3, color: '#ffffff', sprite: SPRITE.SPARKLE, size: 0.45, life: 0.5, drag: 3, spin: 5, curve: 'shrink' });
        }
      }
      this.respawning.set(k.id, now);
    }
    this.timed = this.timed.filter((tm) => {
      tm.t += dt;
      tm.step(tm.t, dt);
      return tm.t < tm.dur;
    });
  }

  dispose(): void {
    for (const sw of this.sweeps) sw.vol.dispose();
    for (const v of this.sweepPool) v.dispose();
    this.sweeps = [];
    this.sweepPool = [];
    this.timed = [];
  }
}

import { characterById } from '../data/characters';
import { formatTime } from '../persist/Save';
import { ITEMS } from '../sim/items/itemDefs';
import { DRIFT_TIERS } from '../sim/kart/kartConfig';
import type { RaceSim } from '../sim/race/RaceSim';
import type { KartState, SimEvent } from '../sim/types';
import { h, ordinal } from './dom';
import type { Portraits } from './Portraits';

const ROULETTE = Object.values(ITEMS).map((i) => i.icon);
const DRIFT_COLORS = ['#9fb4cc', '#4fb4ff', '#ff9a2e', '#c45cff'];

interface View {
  kart: KartState;
  el: HTMLElement;
  pos: HTMLElement;
  lap: HTMLElement;
  timer: HTMLElement;
  speed: HTMLElement;
  drift: HTMLElement;
  item: HTMLElement;
  itemName: HTMLElement;
  special: HTMLElement;
  board: HTMLElement;
  minimap: HTMLCanvasElement;
  center: HTMLElement;
  toast: HTMLElement;
  wrong: HTMLElement;
  lastPlace: number;
}

/** In-race heads-up display (one panel per local player). */
export class HUD {
  readonly root: HTMLElement;
  private views: View[] = [];
  private mapPts: Array<[number, number]> = [];
  private bounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1 };
  private hint: HTMLElement;

  constructor(private sim: RaceSim, players: KartState[], private portraits: Portraits, timeTrial: boolean, hasGhost: boolean) {
    this.root = h('div', { class: `hud${players.length > 1 ? ' split' : ''}`, 'data-testid': 'hud' });
    const main = sim.track.paths[0].samples;
    for (const s of main) this.mapPts.push([s.x, s.z]);
    const xs = main.map((s) => s.x), zs = main.map((s) => s.z);
    this.bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    players.forEach((k, i) => {
      const el = h('div', { class: 'hud-view', style: players.length === 1 ? 'top:0;bottom:0' : i === 0 ? 'top:0;height:50%' : 'top:50%;height:50%' });
      const v: View = {
        kart: k, el,
        pos: h('div', { class: 'pos', 'data-testid': `hud-pos-${i}` }),
        lap: h('div', { class: 'lap', 'data-testid': `hud-lap-${i}` }),
        timer: h('div', { class: 'timer', 'data-testid': `hud-timer-${i}` }),
        speed: h('div', { class: 'speed', 'data-testid': `hud-speed-${i}` }),
        drift: h('div', { class: 'drift' }, h('div')),
        item: h('div', { class: 'item-slot', 'data-testid': `hud-item-${i}` }),
        itemName: h('div', { class: 'item-name' }),
        special: h('div', { class: 'special' }),
        board: h('div', { class: 'board' }),
        minimap: h('canvas', { class: 'minimap', width: 220, height: 220 }),
        center: h('div', { class: 'center-msg' }),
        toast: h('div', { class: 'toast' }),
        wrong: h('div', { class: 'wrong-way' }, 'WRONG WAY!'),
        lastPlace: k.place,
      };
      el.append(v.lap, v.timer, v.board, v.minimap, v.item, v.itemName, v.special, v.drift, v.speed, v.pos, v.center, v.toast, v.wrong);
      if (timeTrial) {
        v.board.style.display = 'none';
        v.pos.style.display = 'none';
        v.item.style.display = 'none';
        v.special.style.display = 'none';
        if (hasGhost) el.append(h('div', { class: 'ghost-tag' }, '👻 Racing your best ghost'));
      }
      this.root.append(el);
      this.views.push(v);
    });
    if (players.length > 1) this.root.append(h('div', { class: 'split-line' }));
    this.hint = h('div', { class: 'controls-hint' }, players.length > 1
      ? 'P1: WASD · Space drift · E item · F special    |    P2: Arrows · R-Shift drift · Enter item · , special'
      : 'W/↑ Gas · S/↓ Brake · A/D Steer · Space Drift · E Item · F Special · Q Look back · Esc Pause');
    this.root.append(this.hint);
    setTimeout(() => (this.hint.style.opacity = '0'), 9000);
  }

  event(e: SimEvent): void {
    switch (e.type) {
      case 'countdown':
        this.views.forEach((v) => this.flash(v.center, String(e.n)));
        break;
      case 'go':
        this.views.forEach((v) => this.flash(v.center, 'GO!'));
        break;
      case 'finalLap':
        this.forKart(e.kart, (v) => this.toast(v, '🏁 FINAL LAP! 🏁'));
        break;
      case 'lap':
        this.forKart(e.kart, (v) => this.toast(v, `Lap ${e.lap}  ·  ${formatTime(e.time)}`));
        break;
      case 'finish':
        this.forKart(e.kart, (v) => {
          v.center.textContent = e.place === 1 ? '🏆 1st! 🏆' : `FINISH! ${e.place}${ordinal(e.place)}`;
          v.center.className = 'center-msg sticky';
        });
        break;
      case 'driftTier':
        if (e.tier === 3) this.forKart(e.kart, (v) => this.toast(v, '💜 Ultra Mini-Turbo!'));
        break;
      case 'shieldBlock':
        this.forKart(e.kart, (v) => this.toast(v, '🫧 Blocked!'));
        break;
      case 'special':
        this.forKart(e.kart, (v) => this.toast(v, `⚡ ${characterById(this.sim.karts[e.kart].character).special.name}!`));
        break;
      case 'hit':
        if (e.by >= 0) this.forKart(e.by, (v) => this.toast(v, `💥 Got ${characterById(this.sim.karts[e.kart].character).name}!`));
        break;
    }
  }

  private forKart(id: number, fn: (v: View) => void): void {
    this.views.filter((v) => v.kart.id === id).forEach(fn);
  }

  private flash(el: HTMLElement, text: string): void {
    el.textContent = text;
    el.className = 'center-msg';
    void el.offsetWidth;
    el.className = 'center-msg show';
  }

  private toast(v: View, text: string): void {
    v.toast.textContent = text;
    v.toast.className = 'toast';
    void v.toast.offsetWidth;
    v.toast.className = 'toast show';
  }

  update(time: number): void {
    const sim = this.sim;
    for (const v of this.views) {
      const k = v.kart;
      const place = k.finished ? k.finishPlace : k.place;
      const posHtml = `${place}<sup>${ordinal(place)}</sup>`;
      if (v.pos.innerHTML !== posHtml) {
        v.pos.innerHTML = posHtml;
        v.pos.className = `pos p${place}`;
        if (place !== v.lastPlace) {
          void v.pos.offsetWidth;
          v.pos.className = `pos p${place} bump`;
        }
        v.lastPlace = place;
      }
      const lapTxt = `LAP ${sim.displayLap(k)}/${sim.laps}`;
      if (v.lap.firstChild?.textContent !== lapTxt) v.lap.innerHTML = `${lapTxt}<small>${k.lastLapTime ? 'Last ' + formatTime(k.lastLapTime) : ''}</small>`;
      const raceT = k.finished ? k.finishTime : Math.max(0, sim.time);
      v.timer.innerHTML = `${formatTime(raceT)}<small>${isFinite(k.bestLapTime) ? 'Best lap ' + formatTime(k.bestLapTime) : ''}</small>`;
      v.speed.innerHTML = `${Math.round(Math.abs(k.forwardSpeed) * 3.6)}<small> km/h</small>`;
      // drift meter
      const bar = v.drift.firstChild as HTMLElement;
      if (k.drift.active) {
        const pct = Math.min(1, k.drift.charge / DRIFT_TIERS[2].charge);
        bar.style.width = `${pct * 100}%`;
        bar.style.background = DRIFT_COLORS[k.drift.tier];
        v.drift.style.opacity = '1';
      } else {
        bar.style.width = '0%';
        v.drift.style.opacity = '0.45';
      }
      // item
      if (k.itemRoulette > 0) {
        v.item.textContent = ROULETTE[Math.floor(time * 18) % ROULETTE.length];
        v.item.className = 'item-slot rolling';
        v.itemName.textContent = '';
      } else {
        const icon = k.item ? ITEMS[k.item].icon : '';
        if (v.item.textContent !== icon) v.item.textContent = icon;
        v.item.className = 'item-slot';
        v.itemName.textContent = k.item ? ITEMS[k.item].name : '';
      }
      // special
      const def = characterById(k.character);
      const ready = k.specialCooldown <= 0;
      const frac = ready ? 1 : 1 - k.specialCooldown / (k.specialMax || 1);
      v.special.className = `special${ready ? ' ready' : ''}`;
      v.special.style.background = `conic-gradient(${def.colors.primary} ${frac * 360}deg, rgba(10,14,40,0.75) 0)`;
      const label = ready ? `${def.special.name}<br>READY` : `${Math.ceil(k.specialCooldown)}s`;
      if (v.special.dataset.l !== label) {
        v.special.innerHTML = `<span>${label}</span>`;
        v.special.dataset.l = label;
      }
      v.wrong.style.display = k.wrongWayTime > 1.2 && !k.finished ? 'block' : 'none';
      this.drawBoard(v);
      this.drawMinimap(v);
    }
  }

  private drawBoard(v: View): void {
    const order = [...this.sim.karts].sort((a, b) => a.place - b.place);
    const key = order.map((k) => k.id).join(',');
    if (v.board.dataset.k === key) return;
    v.board.dataset.k = key;
    v.board.innerHTML = '';
    for (const k of order) {
      const def = characterById(k.character);
      v.board.append(
        h('div', { class: `row${k.id === v.kart.id ? ' me' : ''}` },
          h('span', { class: 'n' }, String(k.place)),
          h('img', { src: this.portraits.get(k.character), alt: '' }),
          h('span', {}, def.name)),
      );
    }
  }

  private drawMinimap(v: View): void {
    const c = v.minimap;
    const g = c.getContext('2d');
    if (!g) return;
    const W = c.width, H = c.height;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const sc = (Math.min(W, H) * 0.78) / Math.max(maxX - minX, maxZ - minZ);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    // map: +x to the right is screen-left mirrored so it matches the chase view for a camera looking north
    const tx = (x: number) => W / 2 - (x - cx) * sc;
    const tz = (z: number) => H / 2 - (z - cz) * sc;
    g.clearRect(0, 0, W, H);
    g.lineJoin = 'round';
    g.beginPath();
    this.mapPts.forEach(([x, z], i) => (i ? g.lineTo(tx(x), tz(z)) : g.moveTo(tx(x), tz(z))));
    g.closePath();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 12;
    g.stroke();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 6;
    g.stroke();
    for (const p of this.sim.track.paths.slice(1)) {
      g.beginPath();
      p.samples.forEach((s, i) => (i ? g.lineTo(tx(s.x), tz(s.z)) : g.moveTo(tx(s.x), tz(s.z))));
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 3;
      g.stroke();
      g.setLineDash([]);
    }
    const s0 = this.sim.track.paths[0].samples[0];
    g.fillStyle = '#111';
    g.fillRect(tx(s0.x) - 6, tz(s0.z) - 2, 12, 4);
    const sorted = [...this.sim.karts].sort((a, b) => (a.id === v.kart.id ? 1 : 0) - (b.id === v.kart.id ? 1 : 0));
    for (const k of sorted) {
      const def = characterById(k.character);
      const me = k.id === v.kart.id;
      g.beginPath();
      g.arc(tx(k.pos.x), tz(k.pos.z), me ? 8 : 6, 0, Math.PI * 2);
      g.fillStyle = def.colors.primary;
      g.fill();
      g.lineWidth = me ? 3 : 2;
      g.strokeStyle = me ? '#ffd23f' : '#fff';
      g.stroke();
    }
    for (const p of this.sim.items.projectiles) {
      g.fillStyle = '#ff3b3b';
      g.fillRect(tx(p.pos.x) - 3, tz(p.pos.z) - 3, 6, 6);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

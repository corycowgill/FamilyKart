/**
 * Xbox-style controller support on top of the browser Gamepad API.
 *
 * Browsers expose Xbox One / Series / 360 pads with the W3C "standard" mapping:
 *   0 A · 1 B · 2 X · 3 Y · 4 LB · 5 RB · 6 LT (analog) · 7 RT (analog) · 8 View · 9 Menu
 *   10 LS click · 11 RS click · 12-15 D-pad up/down/left/right · axes 0/1 left stick, 2/3 right stick
 * Some browser/OS combinations report a non-standard layout with the triggers on axes; that is
 * normalised here so the rest of the game only ever sees `PadState`.
 */

export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause';

export interface PadState {
  index: number;
  id: string;
  /** pressed state per standard button index */
  buttons: boolean[];
  lt: number; // 0..1
  rt: number; // 0..1
  lx: number; // -1..1 with deadzone applied
  ly: number;
  rx: number;
  ry: number;
}

const STICK_DEADZONE = 0.18;
const TRIGGER_DEADZONE = 0.06;
const NAV_THRESHOLD = 0.55;
const NAV_DELAY = 0.38;
const NAV_REPEAT = 0.14;

const dz = (v: number, d: number): number => {
  const a = Math.abs(v);
  return a < d ? 0 : Math.sign(v) * Math.min(1, (a - d) / (1 - d));
};

/** Read one browser Gamepad into a normalised Xbox-layout state. */
export function readPad(g: Gamepad): PadState {
  const b = (i: number) => !!g.buttons[i]?.pressed;
  const buttons = Array.from({ length: 16 }, (_, i) => b(i));
  let lt = g.buttons[6]?.value ?? 0;
  let rt = g.buttons[7]?.value ?? 0;
  let rx = g.axes[2] ?? 0;
  let ry = g.axes[3] ?? 0;
  if (g.mapping !== 'standard' && g.axes.length >= 6) {
    // common non-standard Xbox layout (e.g. Firefox on Linux): LT = axis 2, RX/RY = 3/4, RT = axis 5, rest at -1
    lt = Math.max(lt, ((g.axes[2] ?? -1) + 1) / 2);
    rt = Math.max(rt, ((g.axes[5] ?? -1) + 1) / 2);
    rx = g.axes[3] ?? 0;
    ry = g.axes[4] ?? 0;
    if (g.axes.length >= 8) {
      // d-pad reported as a hat on axes 6/7
      buttons[BTN.LEFT] ||= (g.axes[6] ?? 0) < -0.5;
      buttons[BTN.RIGHT] ||= (g.axes[6] ?? 0) > 0.5;
      buttons[BTN.UP] ||= (g.axes[7] ?? 0) < -0.5;
      buttons[BTN.DOWN] ||= (g.axes[7] ?? 0) > 0.5;
    }
  }
  lt = lt < TRIGGER_DEADZONE ? 0 : lt;
  rt = rt < TRIGGER_DEADZONE ? 0 : rt;
  buttons[BTN.LT] = lt > 0.5;
  buttons[BTN.RT] = rt > 0.5;
  return {
    index: g.index, id: g.id, buttons, lt, rt,
    lx: dz(g.axes[0] ?? 0, STICK_DEADZONE), ly: dz(g.axes[1] ?? 0, STICK_DEADZONE),
    rx: dz(rx, STICK_DEADZONE), ry: dz(ry, STICK_DEADZONE),
  };
}

/** Tracks connected pads, edge-triggered buttons, stick-based menu navigation and rumble. */
export class Gamepads {
  private states = new Map<number, PadState>();
  private prev = new Map<number, boolean[]>();
  private edges: Array<{ pad: number; button: number }> = [];
  private nav = new Map<number, { dir: MenuAction | null; t: number; repeat: boolean }>();
  private navQueue: Array<{ pad: number; action: MenuAction }> = [];
  /** Set whenever any pad input happens (used to switch on-screen prompts). */
  lastActivity = 0;
  onConnectionChange: ((connected: number) => void) | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', () => this.onConnectionChange?.(this.connected().length));
    window.addEventListener('gamepaddisconnected', (e) => {
      this.states.delete(e.gamepad.index);
      this.prev.delete(e.gamepad.index);
      this.onConnectionChange?.(this.connected().length);
    });
  }

  private raw(): Gamepad[] {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    try {
      return Array.from(navigator.getGamepads()).filter((g): g is Gamepad => !!g && g.connected);
    } catch {
      return [];
    }
  }

  /** Poll once per frame. */
  poll(dt: number): void {
    const seen = new Set<number>();
    for (const g of this.raw()) {
      const s = readPad(g);
      seen.add(s.index);
      this.states.set(s.index, s);
      const prev = this.prev.get(s.index) ?? [];
      s.buttons.forEach((v, i) => {
        if (v && !prev[i]) {
          this.edges.push({ pad: s.index, button: i });
          this.lastActivity = performance.now();
        }
      });
      if (Math.abs(s.lx) > 0.3 || Math.abs(s.ly) > 0.3 || s.rt > 0.2 || s.lt > 0.2) this.lastActivity = performance.now();
      this.prev.set(s.index, s.buttons.slice());
      this.updateNav(s, dt);
    }
    for (const idx of [...this.states.keys()]) if (!seen.has(idx)) this.states.delete(idx);
  }

  /** Left stick held in a direction produces repeated menu moves (with an initial delay). */
  private updateNav(s: PadState, dt: number): void {
    let dir: MenuAction | null = null;
    if (s.ly < -NAV_THRESHOLD) dir = 'up';
    else if (s.ly > NAV_THRESHOLD) dir = 'down';
    else if (s.lx < -NAV_THRESHOLD) dir = 'left';
    else if (s.lx > NAV_THRESHOLD) dir = 'right';
    const st = this.nav.get(s.index) ?? { dir: null, t: 0, repeat: false };
    if (dir !== st.dir) {
      st.dir = dir;
      st.t = NAV_DELAY;
      st.repeat = false;
      if (dir) this.navQueue.push({ pad: s.index, action: dir });
    } else if (dir) {
      st.t -= dt;
      if (st.t <= 0) {
        st.t = NAV_REPEAT;
        this.navQueue.push({ pad: s.index, action: dir });
      }
    }
    this.nav.set(s.index, st);
  }

  connected(): PadState[] {
    return [...this.states.values()].sort((a, b) => a.index - b.index);
  }

  state(index: number): PadState | undefined {
    return this.states.get(index);
  }

  /** Edge-triggered menu actions from every pad since the last call. */
  consumeMenu(): Array<{ pad: number; action: MenuAction }> {
    const out = [...this.navQueue];
    for (const e of this.edges) {
      const map: Partial<Record<number, MenuAction>> = {
        [BTN.A]: 'confirm', [BTN.B]: 'back', [BTN.MENU]: 'pause', [BTN.VIEW]: 'back',
        [BTN.UP]: 'up', [BTN.DOWN]: 'down', [BTN.LEFT]: 'left', [BTN.RIGHT]: 'right',
      };
      const a = map[e.button];
      if (a) out.push({ pad: e.pad, action: a });
    }
    this.edges = [];
    this.navQueue = [];
    return out;
  }

  /** Any button pressed since last consume (for "press start"). */
  anyEdge(): boolean {
    return this.edges.length > 0;
  }

  /** Dual-motor rumble where the browser supports it (Chrome / Edge with Xbox pads). Silently ignored elsewhere. */
  rumble(index: number, strong: number, weak: number, ms: number): void {
    const g = this.raw().find((p) => p.index === index) as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | undefined;
    const act = g?.vibrationActuator;
    if (!act?.playEffect) return;
    act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
  }
}

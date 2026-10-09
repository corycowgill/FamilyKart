import type { KartInput } from '../sim/types';

export type Action = 'up' | 'down' | 'left' | 'right' | 'drift' | 'item' | 'special' | 'rear' | 'pause';

export type KeyMap = Record<Action, string[]>;

export const DEFAULT_KEYS_P1: KeyMap = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['Space', 'ShiftLeft'],
  item: ['KeyE', 'KeyX'],
  special: ['KeyF', 'KeyC'],
  rear: ['KeyQ'],
  pause: ['Escape', 'KeyP'],
};

/** In 2-player mode P1 uses WASD-side keys and P2 the arrow/numpad cluster. */
export const SPLIT_KEYS_P1: KeyMap = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], drift: ['Space'], item: ['KeyE'], special: ['KeyF'], rear: ['KeyQ'], pause: ['Escape'],
};
export const SPLIT_KEYS_P2: KeyMap = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], drift: ['ShiftRight', 'Slash'], item: ['Enter', 'Period'], special: ['Comma', 'Quote'], rear: ['Semicolon'], pause: ['Backspace'],
};

const DEADZONE = 0.18;

/**
 * Keyboard + Gamepad input. Players are mapped to a key map and/or a gamepad index.
 * Produces KartInput for the simulation and edge-triggered menu actions.
 */
export class Input {
  private down = new Set<string>();
  private pressedQueue: string[] = [];
  steeringAssist = false;
  keyMaps: KeyMap[] = [DEFAULT_KEYS_P1];
  /** Gamepad index per player (-1 = any connected pad for P1). */
  padForPlayer: number[] = [-1, 1];
  private prevPad: Record<number, boolean[]> = {};
  private padEdges: Array<{ pad: number; button: number }> = [];
  private smoothSteer = [0, 0];

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressedQueue.push(e.code);
      this.down.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  setSplitScreen(on: boolean): void {
    this.keyMaps = on ? [SPLIT_KEYS_P1, SPLIT_KEYS_P2] : [this.keyMaps[0] === SPLIT_KEYS_P1 ? DEFAULT_KEYS_P1 : this.keyMaps[0]];
    this.padForPlayer = on ? [0, 1] : [-1];
  }

  setKeyMap(player: number, map: KeyMap): void {
    this.keyMaps[player] = map;
  }

  private keyActive(player: number, a: Action): boolean {
    const map = this.keyMaps[player];
    return !!map && map[a].some((c) => this.down.has(c));
  }

  private pads(): Gamepad[] {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    return Array.from(navigator.getGamepads()).filter((g): g is Gamepad => !!g && g.connected);
  }

  private padFor(player: number): Gamepad | undefined {
    const pads = this.pads();
    const want = this.padForPlayer[player] ?? -1;
    if (want < 0) return pads[0];
    return pads.find((p) => p.index === want) ?? (player === 0 ? pads[0] : undefined);
  }

  /** Poll once per frame: updates gamepad edge detection. */
  poll(): void {
    for (const p of this.pads()) {
      const prev = this.prevPad[p.index] ?? [];
      const now = p.buttons.map((b) => b.pressed);
      now.forEach((v, i) => {
        if (v && !prev[i]) this.padEdges.push({ pad: p.index, button: i });
      });
      this.prevPad[p.index] = now;
    }
  }

  kartInput(player: number, dt = 1 / 60): KartInput {
    const pad = this.padFor(player);
    let throttle = 0;
    let steer = 0;
    let drift = this.keyActive(player, 'drift');
    let useItem = this.keyActive(player, 'item');
    let useSpecial = this.keyActive(player, 'special');
    let rear = this.keyActive(player, 'rear');
    if (this.keyActive(player, 'up')) throttle += 1;
    if (this.keyActive(player, 'down')) throttle -= 1;
    let keySteer = 0;
    if (this.keyActive(player, 'left')) keySteer -= 1;
    if (this.keyActive(player, 'right')) keySteer += 1;
    // smooth digital steering a little for nicer feel
    const s = this.smoothSteer[player] ?? 0;
    const rate = keySteer === 0 ? 14 : Math.sign(keySteer) !== Math.sign(s) ? 16 : 9;
    this.smoothSteer[player] = s + (keySteer - s) * Math.min(1, dt * rate);
    steer = Math.abs(this.smoothSteer[player]) < 0.02 ? 0 : this.smoothSteer[player];
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) steer = Math.sign(ax) * ((Math.abs(ax) - DEADZONE) / (1 - DEADZONE));
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      if (rt > 0.05) throttle += rt;
      if (lt > 0.1) throttle -= lt;
      if (pad.buttons[12]?.pressed) throttle = 1;
      if (pad.buttons[14]?.pressed) steer = -1;
      if (pad.buttons[15]?.pressed) steer = 1;
      drift = drift || !!pad.buttons[5]?.pressed || !!pad.buttons[4]?.pressed;
      useItem = useItem || !!pad.buttons[0]?.pressed;
      useSpecial = useSpecial || !!pad.buttons[2]?.pressed;
      rear = rear || !!pad.buttons[3]?.pressed;
    }
    throttle = Math.max(-1, Math.min(1, throttle));
    return { throttle, steer, drift, useItem, useSpecial, rearView: rear };
  }

  /** Edge-triggered menu/pause actions since last call. */
  consumeMenuActions(): Array<'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause'> {
    const out: Array<'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause'> = [];
    for (const code of this.pressedQueue) {
      if (code === 'Escape' || code === 'KeyP') out.push('pause');
      if (code === 'Escape' || code === 'Backspace') out.push('back');
      if (code === 'Enter') out.push('confirm');
    }
    for (const e of this.padEdges) {
      if (e.button === 9) out.push('pause');
      if (e.button === 0) out.push('confirm');
      if (e.button === 1) out.push('back');
      if (e.button === 12) out.push('up');
      if (e.button === 13) out.push('down');
      if (e.button === 14) out.push('left');
      if (e.button === 15) out.push('right');
    }
    this.pressedQueue = [];
    this.padEdges = [];
    return out;
  }

  /** True if any key/pad button was pressed since last consume (used for 'press any key'). */
  anyPressed(): boolean {
    return this.pressedQueue.length > 0 || this.padEdges.length > 0;
  }
}

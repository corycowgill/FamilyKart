import type { KartInput } from '../sim/types';
import { BTN, Gamepads, type MenuAction, type PadState } from './Gamepads';
import { isTouchDevice, type TouchControls } from './TouchControls';

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


/**
 * Keyboard + Gamepad input. Players are mapped to a key map and/or a gamepad index.
 * Produces KartInput for the simulation and edge-triggered menu actions.
 */
export class Input {
  private down = new Set<string>();
  private pressedQueue: string[] = [];
  steeringAssist = false;
  keyMaps: KeyMap[] = [DEFAULT_KEYS_P1];
  readonly pads = new Gamepads();
  private split = false;
  private smoothSteer = [0, 0];
  /** 'gamepad' after controller input, 'keyboard' after a key press - drives on-screen prompts. */
  lastDevice: 'keyboard' | 'gamepad' | 'touch' = 'keyboard';
  /** On-screen touch controls for player 1 (present only during a race on touch devices). */
  touch: TouchControls | null = null;

  constructor(target: Window = window) {
    if (isTouchDevice() && !window.matchMedia?.('(any-pointer: fine)').matches) this.lastDevice = 'touch';
    target.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressedQueue.push(e.code);
      this.lastDevice = 'keyboard';
      this.down.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') this.lastDevice = 'touch';
    }, { capture: true });
    target.addEventListener('blur', () => this.down.clear());
  }

  setSplitScreen(on: boolean): void {
    this.keyMaps = on ? [SPLIT_KEYS_P1, SPLIT_KEYS_P2] : [this.keyMaps[0] === SPLIT_KEYS_P1 ? DEFAULT_KEYS_P1 : this.keyMaps[0]];
    this.split = on;
  }

  setKeyMap(player: number, map: KeyMap): void {
    this.keyMaps[player] = map;
  }

  private keyActive(player: number, a: Action): boolean {
    const map = this.keyMaps[player];
    return !!map && map[a].some((c) => this.down.has(c));
  }

  /**
   * Which controller drives which player. Single player: the first connected pad (keyboard works too).
   * Split screen: two pads -> P1 pad 1, P2 pad 2; one pad -> P1 keyboard, P2 the pad.
   */
  padFor(player: number): PadState | undefined {
    const pads = this.pads.connected();
    if (!this.split) return player === 0 ? pads[0] : undefined;
    if (pads.length >= 2) return pads[player];
    return player === 1 ? pads[0] : undefined;
  }

  /** Poll once per frame: updates gamepad state and edge detection. */
  poll(dt = 1 / 60): void {
    this.pads.poll(dt);
    if (performance.now() - this.pads.lastActivity < 50) this.lastDevice = 'gamepad';
  }

  /** Rumble the controller belonging to a player (no-op without a pad or browser support). */
  rumble(player: number, strong: number, weak: number, ms: number): void {
    const p = this.padFor(player);
    if (p) this.pads.rumble(p.index, strong, weak, ms);
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
      // Xbox layout: RT gas, LT brake/reverse, left stick (or d-pad) steer, RB/LB drift, A item, X special, Y look back
      if (pad.lx !== 0) steer = pad.lx;
      if (pad.buttons[BTN.LEFT]) steer = -1;
      if (pad.buttons[BTN.RIGHT]) steer = 1;
      throttle += pad.rt - pad.lt;
      drift = drift || pad.buttons[BTN.RB] || pad.buttons[BTN.LB];
      useItem = useItem || pad.buttons[BTN.A];
      useSpecial = useSpecial || pad.buttons[BTN.X];
      rear = rear || pad.buttons[BTN.Y];
    }
    if (player === 0 && this.touch && (this.lastDevice === 'touch' || this.touch.active)) {
      const t = this.touch.state();
      if (t.steer !== 0) steer = t.steer;
      throttle = t.throttle;
      drift = drift || t.drift;
      useItem = useItem || t.item;
      useSpecial = useSpecial || t.special;
    }
    throttle = Math.max(-1, Math.min(1, throttle));
    return { throttle, steer, drift, useItem, useSpecial, rearView: rear };
  }

  /** Edge-triggered controller menu actions (buttons + left-stick navigation) since last call. */
  consumeMenuActions(): Array<{ pad: number; action: MenuAction }> {
    this.pressedQueue = [];
    return this.pads.consumeMenu();
  }

  /** True if any key/pad button was pressed since last consume (used for 'press any key'). */
  anyPressed(): boolean {
    return this.pressedQueue.length > 0 || this.pads.anyEdge();
  }
}

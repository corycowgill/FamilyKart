import { afterEach, describe, expect, it, vi } from 'vitest';
import { BTN, Gamepads, readPad } from '../../src/input/Gamepads';

type FakePad = { index: number; id: string; connected: boolean; mapping: string; axes: number[]; buttons: Array<{ pressed: boolean; value: number }> };
const pad = (over: Partial<FakePad> = {}): FakePad => ({
  index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true, mapping: 'standard',
  axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), ...over,
});
const press = (p: FakePad, i: number, value = 1) => (p.buttons[i] = { pressed: value > 0.5, value });

describe('Xbox controller mapping', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads triggers as analog throttle/brake and applies a stick deadzone', () => {
    const p = pad({ axes: [0.1, 0, 0, 0] });
    press(p, BTN.RT, 0.8);
    press(p, BTN.LT, 0.03);
    const s = readPad(p as unknown as Gamepad);
    expect(s.rt).toBeCloseTo(0.8);
    expect(s.lt).toBe(0);
    expect(s.lx).toBe(0);
    expect(readPad(pad({ axes: [-1, 0, 0, 0] }) as unknown as Gamepad).lx).toBe(-1);
  });

  it('normalises the non-standard layout with triggers on axes', () => {
    const p = pad({ mapping: '', axes: [0, 0, 1, 0, 0, -1, 1, 0] });
    const s = readPad(p as unknown as Gamepad);
    expect(s.lt).toBeCloseTo(1);
    expect(s.rt).toBe(0);
    expect(s.buttons[BTN.RIGHT]).toBe(true);
  });

  it('turns button presses and held stick directions into menu actions', () => {
    const p = pad();
    vi.stubGlobal('navigator', { getGamepads: () => [p] });
    vi.stubGlobal('performance', { now: () => 0 });
    const g = new Gamepads();
    g.poll(1 / 60);
    press(p, BTN.A);
    g.poll(1 / 60);
    expect(g.consumeMenu().map((x) => x.action)).toEqual(['confirm']);
    // holding A does not repeat
    g.poll(1 / 60);
    expect(g.consumeMenu()).toEqual([]);
    // holding the stick down: one move immediately, then auto-repeat after a delay
    p.axes[1] = 1;
    g.poll(1 / 60);
    expect(g.consumeMenu().map((x) => x.action)).toEqual(['down']);
    for (let i = 0; i < 30; i++) g.poll(1 / 60);
    expect(g.consumeMenu().length).toBeGreaterThanOrEqual(1);
  });
});

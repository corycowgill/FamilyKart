/**
 * On-screen touch controls for phones and tablets.
 *
 * Left half: a floating analog steering stick (touch anywhere, slide left/right).
 * Right side: hold-to-drift, Item, Special and Brake buttons. Gas is automatic (it's a kids' game:
 * steering is the whole job) and is released while Brake is held, which also reverses.
 * Multi-touch via Pointer Events, so steering and drifting work at the same time.
 */
export interface TouchState {
  steer: number;
  throttle: number;
  drift: boolean;
  item: boolean;
  special: boolean;
}

const STICK_RANGE = 70; // px of horizontal travel for full lock
const TILT_RANGE = 28; // degrees of device tilt for full lock

export interface TouchOptions {
  /** Gas held automatically (default). When off a GAS button appears. */
  autoGas: boolean;
  /** Steer by tilting the device like a steering wheel. */
  tilt: boolean;
  size: 's' | 'm' | 'l';
  /** Mirror the layout: steering on the right, buttons on the left. */
  leftHanded: boolean;
}

export const DEFAULT_TOUCH_OPTIONS: TouchOptions = { autoGas: true, tilt: false, size: 'm', leftHanded: false };

/** iOS 13+ needs an explicit permission prompt (from a tap) before device orientation events fire. */
export async function requestTiltPermission(): Promise<boolean> {
  const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (!DOE) return false;
  if (typeof DOE.requestPermission !== 'function') return true;
  try {
    return (await DOE.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0 || window.matchMedia?.('(pointer: coarse)').matches);

export class TouchControls {
  readonly root: HTMLElement;
  private stickBase: HTMLElement;
  private stickKnob: HTMLElement;
  private stickPointer: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private steer = 0;
  private held = new Map<string, number>(); // button -> pointerId
  private specialBtn: HTMLElement;
  private itemBtn: HTMLElement;
  onPause: (() => void) | null = null;
  private opts: TouchOptions;
  private tiltSteer = 0;
  private tiltZero: number | null = null;
  private onOrientation = (e: DeviceOrientationEvent) => this.orientation(e);

  constructor(parent: HTMLElement, opts: TouchOptions = DEFAULT_TOUCH_OPTIONS) {
    this.opts = { ...opts };
    this.root = document.createElement('div');
    this.root.className = 'touch-controls';
    this.root.dataset.testid = 'touch-controls';
    const zone = document.createElement('div');
    zone.className = 'touch-steer-zone';
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'touch-stick';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'touch-knob';
    this.stickBase.append(this.stickKnob);
    const hint = document.createElement('div');
    hint.className = 'touch-steer-hint';
    hint.textContent = '◀  slide to steer  ▶';
    zone.append(this.stickBase, hint);

    const buttons = document.createElement('div');
    buttons.className = 'touch-buttons';
    const mk = (name: string, label: string, cls: string) => {
      const b = document.createElement('div');
      b.className = `touch-btn ${cls}`;
      b.dataset.btn = name;
      b.innerHTML = label;
      buttons.append(b);
      return b;
    };
    this.itemBtn = mk('item', '🎁<small>ITEM</small>', 'item');
    this.specialBtn = mk('special', '⚡<small>SPECIAL</small>', 'special');
    mk('brake', '🛑<small>BRAKE</small>', 'brake');
    mk('drift', '💨<small>DRIFT</small>', 'drift');
    if (!this.opts.autoGas) mk('gas', '⏩<small>GAS</small>', 'gas');
    this.root.classList.add(`size-${this.opts.size}`);
    if (this.opts.leftHanded) this.root.classList.add('lefty');
    if (!this.opts.autoGas) this.root.classList.add('manual-gas');
    if (this.opts.tilt) {
      hint.textContent = 'tilt to steer · or slide here';
      window.addEventListener('deviceorientation', this.onOrientation);
    }

    const pause = document.createElement('button');
    pause.className = 'touch-pause';
    pause.textContent = '⏸';
    pause.setAttribute('aria-label', 'pause');
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onPause?.();
    });

    this.root.append(zone, buttons, pause);
    parent.append(this.root);

    zone.addEventListener('pointerdown', (e) => this.stickDown(e, zone));
    zone.addEventListener('pointermove', (e) => this.stickMove(e));
    zone.addEventListener('pointerup', (e) => this.stickUp(e));
    zone.addEventListener('pointercancel', (e) => this.stickUp(e));
    zone.addEventListener('lostpointercapture', (e) => this.stickUp(e));

    for (const b of Array.from(buttons.children) as HTMLElement[]) {
      const name = b.dataset.btn!;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointers */
        }
        this.held.set(name, e.pointerId);
        b.classList.add('on');
        navigator.vibrate?.(12);
      });
      const up = (e: PointerEvent) => {
        if (this.held.get(name) === e.pointerId) {
          this.held.delete(name);
          b.classList.remove('on');
        }
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    }
    // no long-press menus / text selection on the controls
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private stickDown(e: PointerEvent, zone: HTMLElement): void {
    if (this.stickPointer !== null) return;
    e.preventDefault();
    this.stickPointer = e.pointerId;
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
    const r = zone.getBoundingClientRect();
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.stickBase.style.left = `${e.clientX - r.left}px`;
    this.stickBase.style.top = `${e.clientY - r.top}px`;
    this.stickBase.classList.add('active');
    this.stickMove(e);
  }

  private stickMove(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    const dx = e.clientX - this.stickOrigin.x;
    const clamped = Math.max(-STICK_RANGE, Math.min(STICK_RANGE, dx));
    // small deadzone, then a gentle response curve for fine control
    const raw = clamped / STICK_RANGE;
    const a = Math.abs(raw);
    this.steer = a < 0.08 ? 0 : Math.sign(raw) * Math.pow((a - 0.08) / 0.92, 1.3);
    this.stickKnob.style.transform = `translate(calc(-50% + ${clamped}px), -50%)`;
  }

  private stickUp(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.steer = 0;
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    this.stickBase.classList.remove('active');
  }

  /** Device tilt -> steering. Works in either landscape orientation; zeroed on the first reading (and on recalibrate()). */
  private orientation(e: DeviceOrientationEvent): void {
    if (e.beta === null) return;
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 90) as number;
    const portrait = angle === 0 || angle === 180;
    let tilt = portrait ? (e.gamma ?? 0) : e.beta * (angle === 270 || angle === -90 ? -1 : 1);
    if (this.tiltZero === null) this.tiltZero = tilt;
    tilt -= this.tiltZero;
    const raw = Math.max(-1, Math.min(1, tilt / TILT_RANGE));
    this.tiltSteer = Math.abs(raw) < 0.06 ? 0 : raw;
  }

  /** Treat the current device angle as "straight ahead". */
  recalibrate(): void {
    this.tiltZero = null;
  }

  get active(): boolean {
    return this.stickPointer !== null || this.held.size > 0;
  }

  state(): TouchState {
    const brake = this.held.has('brake');
    const gas = this.opts.autoGas || this.held.has('gas');
    // the on-screen stick always wins over tilt while a thumb is on it
    const steer = this.stickPointer !== null || !this.opts.tilt ? this.steer : this.tiltSteer;
    return {
      steer,
      throttle: brake ? -1 : gas ? 1 : 0,
      drift: this.held.has('drift'),
      item: this.held.has('item'),
      special: this.held.has('special'),
    };
  }

  /** Reflect item / special availability on the buttons. */
  setAvailability(hasItem: boolean, specialReady: boolean): void {
    this.itemBtn.classList.toggle('ready', hasItem);
    this.specialBtn.classList.toggle('ready', specialReady);
  }

  reset(): void {
    this.held.clear();
    this.stickPointer = null;
    this.steer = 0;
    this.root.querySelectorAll('.on').forEach((b) => b.classList.remove('on'));
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.root.remove();
  }
}

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

  constructor(parent: HTMLElement) {
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

  get active(): boolean {
    return this.stickPointer !== null || this.held.size > 0;
  }

  state(): TouchState {
    const brake = this.held.has('brake');
    return {
      steer: this.steer,
      throttle: brake ? -1 : 1,
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
    this.root.remove();
  }
}

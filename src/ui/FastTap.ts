/**
 * Reliable taps for the HTML menus on touch screens.
 *
 * Mobile browsers drop or delay `click` for many reasons: the finger wobbles a few pixels, the
 * element sits in a scrollable row, a hover/active style moves it, or the layout changes mid-tap.
 * For touch pointers we fire the click ourselves on pointerup when the finger hasn't travelled
 * more than a few pixels, then swallow the browser's own (trusted) click that may follow, which
 * would otherwise land on whatever appeared under the finger on the next screen ("ghost click").
 */
const TAP_SELECTOR = 'button:not([disabled]), .char-card, .track-card, .title-screen, label';
const MOVE_TOLERANCE = 16; // px; more than this is a swipe/scroll, not a tap
const MAX_TAP_MS = 900;
const GHOST_WINDOW_MS = 650;

export class FastTap {
  private active: { id: number; el: HTMLElement; x: number; y: number; t: number } | null = null;
  private lastFastTap = 0;

  constructor(private root: HTMLElement) {
    root.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.move(e), { capture: true, passive: true });
    window.addEventListener('pointerup', (e) => this.up(e), { capture: true });
    window.addEventListener('pointercancel', (e) => this.cancel(e), { capture: true });
    // swallow the browser's own click right after we've handled a tap
    window.addEventListener('click', (e) => {
      if (e.isTrusted && performance.now() - this.lastFastTap < GHOST_WINDOW_MS) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, { capture: true });
  }

  private down(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    const target = e.target as HTMLElement | null;
    if (!target || target.closest('.touch-controls, input, select, textarea')) return;
    const el = target.closest<HTMLElement>(TAP_SELECTOR);
    if (!el || !this.root.contains(el)) return;
    this.active = { id: e.pointerId, el, x: e.clientX, y: e.clientY, t: performance.now() };
    el.classList.add('tapped');
  }

  private move(e: PointerEvent): void {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    if (Math.hypot(e.clientX - a.x, e.clientY - a.y) > MOVE_TOLERANCE) this.clear();
  }

  private up(e: PointerEvent): void {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    this.clear();
    if (performance.now() - a.t > MAX_TAP_MS || !a.el.isConnected) return;
    if (Math.hypot(e.clientX - a.x, e.clientY - a.y) > MOVE_TOLERANCE) return;
    e.preventDefault();
    this.lastFastTap = performance.now();
    if (a.el instanceof HTMLButtonElement || a.el.classList.contains('char-card') || a.el.classList.contains('track-card')) a.el.focus({ preventScroll: true });
    // labels need the native activation behaviour (toggling their checkbox)
    if (a.el.tagName === 'LABEL') return void a.el.click();
    // detail: 1 marks it as a pointer click (keyboard/gamepad activations use detail 0)
    a.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, view: window, clientX: e.clientX, clientY: e.clientY }));
  }

  private cancel(e: PointerEvent): void {
    if (this.active && e.pointerId === this.active.id) this.clear();
  }

  private clear(): void {
    this.active?.el.classList.remove('tapped');
    this.active = null;
  }
}

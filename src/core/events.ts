/** Minimal typed event emitter for decoupled systems (UI, audio, render listen to sim/game). */
export class Emitter<E extends Record<string, unknown>> {
  private handlers: { [K in keyof E]?: Array<(p: E[K]) => void> } = {};
  on<K extends keyof E>(type: K, fn: (p: E[K]) => void): () => void {
    (this.handlers[type] ??= []).push(fn);
    return () => this.off(type, fn);
  }
  off<K extends keyof E>(type: K, fn: (p: E[K]) => void): void {
    const list = this.handlers[type];
    if (list) this.handlers[type] = list.filter((h) => h !== fn);
  }
  emit<K extends keyof E>(type: K, payload: E[K]): void {
    this.handlers[type]?.forEach((h) => h(payload));
  }
}

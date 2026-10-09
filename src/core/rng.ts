/** Deterministic seeded PRNG (mulberry32) so races can be replayed and simulated reproducibly. */
export class Rng {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  /** Pick a key from a weight table. */
  weighted<T extends string>(weights: Partial<Record<T, number>>): T {
    let total = 0;
    for (const k in weights) total += Math.max(0, weights[k] ?? 0);
    let r = this.next() * total;
    let last: T | undefined;
    for (const k in weights) {
      const w = Math.max(0, weights[k] ?? 0);
      if (w <= 0) continue;
      last = k;
      r -= w;
      if (r <= 0) return k;
    }
    return last as T;
  }
}

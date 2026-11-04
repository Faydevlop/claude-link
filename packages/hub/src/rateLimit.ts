/**
 * Sliding-window counter per key, in memory. Good enough for one hub process on a LAN; it forgets
 * everything on restart, which only ever makes it more lenient.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  private now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  private recent(key: string) {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }

  /** Records a hit; returns false if the key is over its limit (the hit is still counted). */
  hit(key: string): boolean {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep();
    return list.length <= this.limit;
  }

  /** True if the key is already over its limit, without counting a new hit. */
  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  reset(key: string) { this.hits.delete(key); }

  private sweep() {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}

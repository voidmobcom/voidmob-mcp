/** A fixed one-minute window per key, holding at most `maxKeys` windows. */
export class RateLimiter {
  // Map order is window-start order: a new window re-inserts its key.
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Counts `cost` (the JSON-RPC messages in one request) against the key.
   * Returns 0 when they fit, else the seconds to wait (nothing is counted).
   */
  hit(key: string, cost = 1): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.delete(key);
      for (const [k, old] of this.windows) {
        if (t - old.start < this.windowMs && this.windows.size < this.maxKeys) break;
        this.windows.delete(k);
      }
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count + cost > this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count += cost;
    return 0;
  }
}

/** Keys remembered for a fixed time, at most `max` of them (the oldest go first). */
export class ExpiringSet {
  // Map order is expiry order: every entry lives the same time.
  private readonly expires = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  add(key: string): void {
    const t = this.now();
    this.expires.delete(key);
    for (const [k, at] of this.expires) {
      if (at > t && this.expires.size < this.max) break;
      this.expires.delete(k);
    }
    this.expires.set(key, t + this.ttlMs);
  }

  delete(key: string): void {
    this.expires.delete(key);
  }

  has(key: string): boolean {
    const at = this.expires.get(key);
    if (at === undefined) return false;
    if (at > this.now()) return true;
    this.expires.delete(key);
    return false;
  }
}

/** At most `perKey` slots held at once per key (open listen streams). */
export class Slots {
  private readonly held = new Map<string, number>();

  constructor(private readonly perKey: number) {}

  /** A release function (safe to call more than once), or null when the key holds all its slots. */
  take(key: string): (() => void) | null {
    const n = this.held.get(key) ?? 0;
    if (n >= this.perKey) return null;
    this.held.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.held.get(key) ?? 1) - 1;
      if (left > 0) this.held.set(key, left);
      else this.held.delete(key);
    };
  }
}

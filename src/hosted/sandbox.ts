import type { HttpClient } from "../client/http.js";
import { createSandboxHttpClient } from "../sandbox/mock-http.js";

export const SANDBOX_MAX_ENTRIES = 1_000;
export const SANDBOX_IDLE_MS = 60 * 60_000;
/** Sandbox requests one IP may send per minute. */
export const SANDBOX_REQUESTS_PER_MINUTE = 60;

/**
 * Sandbox state per caller: the path token when given, else the client IP.
 * Least recently used first; an entry idle for an hour starts over, and the
 * oldest goes when 1,000 are held.
 */
export class SandboxStore {
  // Map order is use order: every hit moves its entry to the end.
  private readonly entries = new Map<string, { http: HttpClient; usedAt: number }>();

  constructor(
    private readonly create: () => HttpClient = createSandboxHttpClient,
    private readonly max = SANDBOX_MAX_ENTRIES,
    private readonly idleMs = SANDBOX_IDLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** The mock API for this key, created on first use. */
  get(key: string): HttpClient {
    const t = this.now();
    const hit = this.entries.get(key);
    this.entries.delete(key);
    if (hit && t - hit.usedAt < this.idleMs) {
      hit.usedAt = t;
      this.entries.set(key, hit);
      return hit.http;
    }
    for (const [k, e] of this.entries) {
      if (t - e.usedAt < this.idleMs && this.entries.size < this.max) break;
      this.entries.delete(k);
    }
    const entry = { http: this.create(), usedAt: t };
    this.entries.set(key, entry);
    return entry.http;
  }
}

/** A fixed one-minute window per key, holding at most `maxKeys` windows. */
export class RateLimiter {
  // Map order is window-start order: a new window re-inserts its key.
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit = SANDBOX_REQUESTS_PER_MINUTE,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait before the next request, or 0 when this one may go ahead (and is counted). */
  hit(key: string): number {
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
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return 0;
  }
}

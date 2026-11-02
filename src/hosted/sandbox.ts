import type { HttpClient } from "../client/http.js";
import { createSandboxHttpClient } from "../sandbox/mock-http.js";

export const SANDBOX_MAX_ENTRIES = 1_000;
export const SANDBOX_IDLE_MS = 60 * 60_000;

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

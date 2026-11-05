import { createHash } from "node:crypto";
import type { HttpClient } from "./client/http.js";
import { callApi } from "./client/call-api.js";
import { MePayload } from "./client/types.js";

/** What an action needs: view (reads), manage (changes that do not spend) or buy (every charge). */
export type PermissionLevel = "view" | "manage" | "buy";

export const LEVEL_LABEL: Record<PermissionLevel, string> = { view: "View", manage: "Manage", buy: "Buy" };

/** "View", "Manage" or "Buy" for a level value, or undefined for anything else. */
export function levelLabel(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(LEVEL_LABEL, value) ? LEVEL_LABEL[value as PermissionLevel] : undefined;
}

/**
 * The calling API key's or app connection's settings, as GET /v1/me reports
 * them. The API enforces the permission and both limits on every call; the
 * server uses them to shape its tool list and instructions.
 */
export interface Connection {
  permission: PermissionLevel;
  /** "Buy without asking": changes only the server instructions. */
  autoMode: boolean;
  /** Per-order limit in cents, or null for no limit. */
  maxOrderCents: number | null;
  /** Rolling-24h limit in cents, or null for no limit. */
  dailyLimitCents: number | null;
  /** "key" for an API key, "oauth" for an app connection; picks the settings page. Defaults to "key". */
  kind?: "key" | "oauth";
  /** Where the user adds funds (/v1/me deposit_url); its origin is the dashboard's. */
  depositUrl?: string;
}

const DEFAULT_DASHBOARD = "https://dashboard.voidmob.com";

/** The deposit link: /v1/me's, else the dashboard wallet. */
export function depositUrlFor(connection: Connection | null): string {
  return connection?.depositUrl ?? `${DEFAULT_DASHBOARD}/wallet`;
}

/** Where the account owner changes this key's or connection's permission and limits. */
export function settingsUrlFor(connection: Connection | null): string {
  let origin = DEFAULT_DASHBOARD;
  if (connection?.depositUrl) {
    try {
      origin = new URL(connection.depositUrl).origin;
    } catch {
      // Keep the default dashboard.
    }
  }
  return `${origin}${connection?.kind === "oauth" ? "/account/connected-apps" : "/developers/api-keys"}`;
}

/** The connection a /v1/me payload describes, or null when it carries no key block. */
export function connectionFromMe(me: MePayload): Connection | null {
  if (!me.key) return null;
  return {
    permission: me.key.permission,
    autoMode: me.key.auto_mode,
    maxOrderCents: me.key.max_order_cents,
    dailyLimitCents: me.key.daily_limit_cents,
    kind: me.key.kind,
    ...(me.deposit_url ? { depositUrl: me.deposit_url } : {}),
  };
}

const TTL_MS = 60_000;
export const CONNECTION_CACHE_MAX = 1_000;

// Keyed by a SHA-256 of the credential, never the credential itself. Holds
// the in-flight promise, so concurrent loads for one credential share a
// request. Failures are dropped, never cached.
const cache = new Map<string, { at: number; value: Promise<Connection | null> }>();

/**
 * The credential's settings from GET /v1/me, cached for 60 s. Resolves null
 * when the API reports no key block; rejects with the API or network error
 * (callers fall back to the local controls).
 */
export function loadConnection(http: HttpClient, credential: string): Promise<Connection | null> {
  const id = createHash("sha256").update(credential).digest("hex");
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  cache.delete(id);

  const value = callApi<unknown>(http, "GET", "/v1/me").then((raw) => connectionFromMe(MePayload.parse(raw)));
  value.catch(() => {
    if (cache.get(id)?.value === value) cache.delete(id);
  });
  // Map keys iterate in insertion order, so the first is the oldest entry.
  if (cache.size >= CONNECTION_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(id, { at: now, value });
  return value;
}

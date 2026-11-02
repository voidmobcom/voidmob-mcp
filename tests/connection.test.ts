// The API key's or app connection's settings (GET /v1/me key block): the 60 s
// per-credential cache, the instructions they produce (level, limits,
// auto-mode), and stdio startup (one read before serving, a fallback to the
// local controls, and VOIDMOB_AUTONOMOUS refused without a limit).
import { describe, it, expect, afterEach, vi } from "vitest";
import type { HttpClient } from "../src/client/http.js";
import { HttpError } from "../src/client/http.js";
import { ConfigError, DEFAULT_CONTROLS, parseEnv, type OwnerControls } from "../src/config.js";
import {
  CONNECTION_CACHE_MAX, connectionFromMe, depositUrlFor, loadConnection, settingsUrlFor, type Connection,
} from "../src/connection.js";
import { loadLiveConnection } from "../src/modes/live.js";
import { createSandboxHttpClient } from "../src/sandbox/mock-http.js";
import { createVoidmobServer } from "../src/server.js";
import { prepareServer } from "../src/startup.js";
import { connect } from "./connect.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const conn = (c: Partial<Connection> = {}): Connection => ({
  permission: "buy", autoMode: false, maxOrderCents: null, dailyLimitCents: null, ...c,
});

const instructionsFor = async (connection: Connection | null, controls: Partial<OwnerControls> = {}) =>
  (await connect(createVoidmobServer(createSandboxHttpClient(), { ...DEFAULT_CONTROLS, ...controls }, connection))).getInstructions() ?? "";

// A unique vmk_live_ key per test, so the module cache never carries over.
let keySeq = 0;
const freshKey = () => `vmk_live_${String(++keySeq).padStart(4, "0")}${"k".repeat(28)}`;

const meBody = (key: Record<string, unknown> | undefined) => ({
  success: true,
  data: {
    id: "usr_1",
    balance: { amount_cents: 1000, currency: "USD", formatted: "$10.00" },
    rate_limits: {},
    ...(key ? { key, deposit_url: "https://dash.example/wallet" } : {}),
    created_at: "2026-01-01T00:00:00Z",
  },
});

const apiKey = (over: Record<string, unknown> = {}) => ({
  id: "key_1", kind: "key", name: "agent", permission: "buy", max_order_cents: null,
  daily_limit_cents: null, spent_24h_cents: 0, auto_mode: false, ...over,
});

/** A counting HttpClient that answers GET /v1/me with this key block. */
function meClient(key: Record<string, unknown> | undefined): HttpClient & { calls: number } {
  const client = {
    calls: 0,
    async request() {
      client.calls++;
      return { status: 200, body: meBody(key), headers: new Headers() };
    },
  };
  return client;
}

describe("loadConnection (60 s cache per credential)", () => {
  it("maps the key block, and returns null when /v1/me has none", async () => {
    const http = meClient(apiKey({ kind: "oauth", permission: "manage", max_order_cents: 500, daily_limit_cents: 2000, auto_mode: true }));
    expect(await loadConnection(http, "cred-map")).toEqual({
      permission: "manage", autoMode: true, maxOrderCents: 500, dailyLimitCents: 2000, kind: "oauth",
      depositUrl: "https://dash.example/wallet",
    });
    expect(await loadConnection(meClient(undefined), "cred-none")).toBeNull();
  });

  it("reads /v1/me once per credential for 60 s, then again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-11-02T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const http = meClient(apiKey());
    await Promise.all([loadConnection(http, "cred-ttl"), loadConnection(http, "cred-ttl")]);
    expect(http.calls).toBe(1);
    vi.setSystemTime(t0 + 59_000);
    await loadConnection(http, "cred-ttl");
    expect(http.calls).toBe(1);
    await loadConnection(http, "cred-ttl-other");
    expect(http.calls).toBe(2);
    vi.setSystemTime(t0 + 60_000);
    await loadConnection(http, "cred-ttl");
    expect(http.calls).toBe(3);
  });

  it("never caches a failure", async () => {
    let calls = 0;
    const http: HttpClient = {
      async request() {
        calls++;
        if (calls === 1) throw new HttpError(503, "INTERNAL_ERROR", "r", undefined, "down", { method: "GET" });
        return { status: 200, body: meBody(apiKey()), headers: new Headers() };
      },
    };
    await expect(loadConnection(http, "cred-fail")).rejects.toThrow(HttpError);
    expect(await loadConnection(http, "cred-fail")).toMatchObject({ permission: "buy" });
    expect(calls).toBe(2);
  });

  it("is bounded: past the cap the oldest credential is read again", async () => {
    const http = meClient(apiKey());
    await loadConnection(http, "cred-bound-0");
    for (let i = 1; i <= CONNECTION_CACHE_MAX; i++) await loadConnection(http, `cred-bound-${i}`);
    const before = http.calls;
    await loadConnection(http, "cred-bound-0");
    expect(http.calls).toBe(before + 1);
  });

  it("the settings page follows the kind, on the deposit link's origin", () => {
    expect(settingsUrlFor(null)).toBe("https://dashboard.voidmob.com/developers/api-keys");
    expect(depositUrlFor(null)).toBe("https://dashboard.voidmob.com/wallet");
    expect(settingsUrlFor(conn({ kind: "oauth", depositUrl: "http://localhost:4000/wallet" }))).toBe("http://localhost:4000/account/connected-apps");
    expect(settingsUrlFor(conn({ kind: "key", depositUrl: "http://localhost:4000/wallet" }))).toBe("http://localhost:4000/developers/api-keys");
    expect(connectionFromMe({ id: "u", balance: { amount_cents: 0, currency: "USD", formatted: "$0.00" }, rate_limits: {}, created_at: "x" })).toBeNull();
  });
});

describe("instructions follow the key's settings", () => {
  it("auto-mode off: confirm the price before buying, and the deposit link", async () => {
    const text = await instructionsFor(conn());
    expect(text).toContain("Quote first: show the user the price");
    expect(text).toContain("get their go-ahead");
    expect(text).not.toContain("Auto-mode");
    expect(text).toContain("add funds at https://dashboard.voidmob.com/wallet");
  });

  it("auto-mode on (the key's): may buy without asking within the limits, and must report every purchase", async () => {
    const text = await instructionsFor(conn({ autoMode: true, dailyLimitCents: 5000 }));
    expect(text).toContain("Auto-mode is on");
    expect(text).toContain("buy without asking first, within the spending limits");
    expect(text).toContain("tell the user about every purchase");
    expect(text).not.toContain("get their go-ahead");
    expect(text).toContain("This API key has spending limits: $50.00 per rolling 24 hours");
  });

  it("a key's auto-mode without a daily limit stays off: confirm first", async () => {
    const text = await instructionsFor(conn({ autoMode: true, dailyLimitCents: null, maxOrderCents: 1000 }));
    expect(text).not.toContain("Auto-mode is on");
    expect(text).toContain("get their go-ahead");
  });

  it("auto-mode on (local VOIDMOB_AUTONOMOUS with a budget, or the key's daily limit)", async () => {
    expect(await instructionsFor(null, { autonomous: true, budgetCents: 3000 })).toContain("Auto-mode is on");
    expect(await instructionsFor(conn({ dailyLimitCents: 2000 }), { autonomous: true })).toContain("Auto-mode is on");
    // No limit anywhere: the flag never turns auto-mode on (startup refuses it; see below).
    expect(await instructionsFor(conn(), { autonomous: true })).not.toContain("Auto-mode is on");
    expect(await instructionsFor(null, { autonomous: true })).not.toContain("Auto-mode is on");
  });

  it("states both key limits, naming an app connection and its settings page", async () => {
    const text = await instructionsFor(conn({ kind: "oauth", maxOrderCents: 2500, dailyLimitCents: 5000 }));
    expect(text).toContain(
      "This app connection has spending limits: at most $25.00 per order and $50.00 per rolling 24 hours; " +
      "a purchase over a limit is refused with nothing charged",
    );
    expect(text).toContain("https://dashboard.voidmob.com/account/connected-apps");
  });

  it("below Buy: names the level, what it cannot do and where the owner changes it; no auto-mode or limit lines", async () => {
    const view = await instructionsFor(conn({ permission: "view", autoMode: true, dailyLimitCents: 5000 }));
    expect(view).toContain("This server has View access: it can look up prices, the balance and orders, but cannot buy");
    expect(view).toContain("The account owner sets the access level at https://dashboard.voidmob.com/developers/api-keys.");
    expect(view).not.toContain("Auto-mode");
    expect(view).not.toContain("spending limits");
    const manage = await instructionsFor(conn({ permission: "manage", kind: "oauth" }));
    expect(manage).toContain("This server has Manage access: it can cancel");
    expect(manage).toContain("cannot buy, renew, top up, reuse a number for a fee or turn auto-renew on");
    expect(manage).toContain("at https://dashboard.voidmob.com/account/connected-apps.");
    expect(await instructionsFor(conn(), { readOnly: true })).toContain("in this MCP server's configuration (VOIDMOB_READ_ONLY)");
  });

  it("a Buy key with no limits reads like today's server", async () => {
    expect(await instructionsFor(conn())).toBe(await instructionsFor(null));
  });
});

describe("stdio startup", () => {
  const stubMe = (key: Record<string, unknown> | undefined) => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(meBody(key)), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  };

  it("reads the key's settings once, before serving, and builds every server from them", async () => {
    const fetchSpy = stubMe(apiKey({ permission: "view" }));
    const build = await prepareServer({ VOIDMOB_API_KEY: freshKey() });
    const first = await connect(build());
    const second = await connect(build());
    expect((await first.listTools()).tools).toHaveLength(10);
    expect((await second.listTools()).tools).toHaveLength(10);
    // Only the startup read: building twice reads nothing more.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("/v1/me");
  });

  it("falls back to the local controls with one stderr line when /v1/me fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: "INTERNAL_ERROR", message: "x", request_id: "r" } }), { status: 500 })));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const build = await prepareServer({ VOIDMOB_API_KEY: freshKey(), VOIDMOB_AUTONOMOUS: "1" });
    const client = await connect(build());
    expect((await client.listTools()).tools).toHaveLength(26);
    expect(client.getInstructions()).not.toContain("Auto-mode is on");
    const lines = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("permission and limits"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("INTERNAL_ERROR");
    expect(lines[0]).toContain("VOIDMOB_AUTONOMOUS stays off");
    expect(lines[0]).not.toMatch(/vmk_live_/);
  });

  it("gives up waiting after the startup cap", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cfg = parseEnv({ VOIDMOB_API_KEY: freshKey() });
    expect(await loadLiveConnection(cfg, 20)).toBeNull();
  });

  it("refuses VOIDMOB_AUTONOMOUS=1 when neither a budget nor the key's daily limit is set", async () => {
    stubMe(apiKey({ daily_limit_cents: null }));
    await expect(prepareServer({ VOIDMOB_API_KEY: freshKey(), VOIDMOB_AUTONOMOUS: "1" })).rejects.toThrow(ConfigError);
    stubMe(apiKey({ daily_limit_cents: null }));
    await expect(prepareServer({ VOIDMOB_API_KEY: freshKey(), VOIDMOB_AUTONOMOUS: "1" })).rejects.toThrow(
      /VOIDMOB_AUTONOMOUS=1 needs a spending limit: set VOIDMOB_BUDGET_CENTS .*or give this API key a daily limit at https:\/\/dashboard\.voidmob\.com\/developers\/api-keys/,
    );
    expect(() => parseEnv({ VOIDMOB_SANDBOX: "1", VOIDMOB_AUTONOMOUS: "1" })).toThrow(/needs a spending limit: set VOIDMOB_BUDGET_CENTS/);
    expect(() => parseEnv({ VOIDMOB_AUTONOMOUS: "true" })).toThrow(ConfigError);
  });

  it("accepts VOIDMOB_AUTONOMOUS=1 with the key's daily limit or a session budget", async () => {
    stubMe(apiKey({ daily_limit_cents: 5000 }));
    const withKeyLimit = await connect((await prepareServer({ VOIDMOB_API_KEY: freshKey(), VOIDMOB_AUTONOMOUS: "1" }))());
    expect(withKeyLimit.getInstructions()).toContain("Auto-mode is on");
    stubMe(apiKey());
    const withBudget = await connect((await prepareServer({ VOIDMOB_API_KEY: freshKey(), VOIDMOB_AUTONOMOUS: "1", VOIDMOB_BUDGET_CENTS: "2000" }))());
    expect(withBudget.getInstructions()).toContain("Auto-mode is on");
    const sandbox = await connect((await prepareServer({ VOIDMOB_SANDBOX: "1", VOIDMOB_AUTONOMOUS: "1", VOIDMOB_BUDGET_CENTS: "2000" }))());
    expect(sandbox.getInstructions()).toContain("Auto-mode is on");
  });
});

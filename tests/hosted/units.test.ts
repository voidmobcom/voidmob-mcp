// Hosted building blocks: env config, the sandbox store (LRU with idle
// expiry) and its capped mock, the rate limits, the refused-credential cache,
// listen slots, and the error wording per mode.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { HttpClient } from "../../src/client/http.js";
import { HttpError } from "../../src/client/http.js";
import { mapApiError } from "../../src/client/errors.js";
import { ConfigError } from "../../src/config.js";
import { parseHostedEnv } from "../../src/hosted/config.js";
import { ExpiringSet, RateLimiter, Slots } from "../../src/hosted/limits.js";
import { SandboxStore } from "../../src/hosted/sandbox.js";
import {
  createSandboxHttpClient, READY_AFTER_MS, SANDBOX_MAX_LISTS, SANDBOX_MAX_MESSAGES, SANDBOX_MAX_ORDERS_PER_TYPE,
} from "../../src/sandbox/mock-http.js";

afterEach(() => vi.useRealTimers());

describe("parseHostedEnv", () => {
  it("defaults to production", () => {
    const cfg = parseHostedEnv({});
    expect(cfg.port).toBe(8080);
    expect(cfg.resourceUrl.href).toBe("https://mcp.voidmob.com/mcp");
    expect(cfg.issuer).toBe("https://dashboard.voidmob.com");
    expect(cfg.jwksUrl.href).toBe("https://dashboard.voidmob.com/oauth/jwks");
    expect(cfg.apiBaseUrl).toBe("https://dashboard.voidmob.com/api");
    expect(cfg.allowedHosts).toEqual(["mcp.voidmob.com"]);
    expect(cfg.allowedOrigins).toEqual([]);
  });

  it("takes overrides for local testing", () => {
    const cfg = parseHostedEnv({
      PORT: "3001",
      MCP_RESOURCE_URL: "http://localhost:3001/mcp",
      OAUTH_ISSUER: "http://localhost:4000",
      VOIDMOB_BASE_URL: "http://localhost:4000/api/",
      MCP_ALLOWED_HOSTS: "127.0.0.1, Example.test",
      MCP_ALLOWED_ORIGINS: "inspector.example",
    });
    expect(cfg.jwksUrl.href).toBe("http://localhost:4000/oauth/jwks");
    expect(cfg.apiBaseUrl).toBe("http://localhost:4000/api");
    expect(cfg.allowedHosts).toEqual(["localhost", "127.0.0.1", "example.test"]);
    expect(cfg.allowedOrigins).toEqual(["inspector.example"]);
  });

  it("refuses plain http off localhost, an issuer with a path, a resource with no path, and a bad port", () => {
    for (const env of [
      { OAUTH_ISSUER: "http://dashboard.voidmob.com" },
      { OAUTH_JWKS_URL: "http://keys.example/jwks" },
      { VOIDMOB_BASE_URL: "http://api.example" },
      { OAUTH_ISSUER: "https://dashboard.voidmob.com/oauth" },
      { MCP_RESOURCE_URL: "https://mcp.voidmob.com" },
      { PORT: "http" },
    ]) {
      expect(() => parseHostedEnv(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});

describe("SandboxStore", () => {
  const fake = () => ({ request: async () => ({ status: 200, headers: new Headers() }) }) as HttpClient;

  it("keeps state per key, starts over after an hour idle, and drops the least recently used when full", () => {
    let now = 0;
    const store = new SandboxStore(fake, 2, 3_600_000, () => now);
    const a = store.get("a");
    expect(store.get("a")).toBe(a);
    const b = store.get("b");
    store.get("a"); // a is now the most recent
    store.get("c"); // full: b goes
    expect(store.size).toBe(2);
    expect(store.get("a")).toBe(a);
    expect(store.get("b")).not.toBe(b);

    now += 3_600_000;
    expect(store.get("a")).not.toBe(a);
  });
});

describe("RateLimiter", () => {
  it("allows the limit per minute per key, then says how long to wait", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, 100, () => now);
    expect(limiter.hit("ip1")).toBe(0);
    expect(limiter.hit("ip1")).toBe(0);
    expect(limiter.hit("ip1")).toBe(60);
    expect(limiter.hit("ip2")).toBe(0);
    now += 45_000;
    expect(limiter.hit("ip1")).toBe(15);
    now += 15_000;
    expect(limiter.hit("ip1")).toBe(0);
  });

  it("counts a request's messages; a request that does not fit counts nothing", () => {
    const limiter = new RateLimiter(5, 60_000, 100, () => 0);
    expect(limiter.hit("ip", 4)).toBe(0);
    expect(limiter.hit("ip", 2)).toBe(60);
    expect(limiter.hit("ip", 1)).toBe(0);
    expect(limiter.hit("ip", 1)).toBe(60);
  });

  it("holds at most maxKeys windows", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, 2, () => now);
    limiter.hit("a");
    limiter.hit("b");
    limiter.hit("c"); // a's window is dropped to make room
    expect(limiter.hit("a")).toBe(0);
  });
});

describe("ExpiringSet", () => {
  it("remembers a key for its TTL, holding at most max keys", () => {
    let now = 0;
    const set = new ExpiringSet(30_000, 2, () => now);
    set.add("a");
    now += 29_999;
    expect(set.has("a")).toBe(true);
    now += 1;
    expect(set.has("a")).toBe(false);
    set.add("b");
    set.add("c");
    set.add("d"); // full: b goes
    expect([set.has("b"), set.has("c"), set.has("d")]).toEqual([false, true, true]);
  });
});

describe("Slots", () => {
  it("allows perKey slots per key; a release (once) frees one", () => {
    const slots = new Slots(2);
    const r1 = slots.take("k")!;
    expect(slots.take("k")).not.toBeNull();
    expect(slots.take("k")).toBeNull();
    expect(slots.take("other")).not.toBeNull();
    r1();
    r1();
    expect(slots.take("k")).not.toBeNull();
    expect(slots.take("k")).toBeNull();
  });
});

describe("sandbox mock caps", () => {
  const call = async (http: HttpClient, method: string, path: string, body?: unknown) => {
    const res = await http.request(method, path, body === undefined ? {} : { body });
    return { status: res.status, body: res.body as Record<string, any> };
  };

  it(`keeps the newest ${SANDBOX_MAX_ORDERS_PER_TYPE} orders of a type`, async () => {
    const http = createSandboxHttpClient();
    const ids: string[] = [];
    for (let i = 0; i <= SANDBOX_MAX_ORDERS_PER_TYPE; i++) {
      const res = await call(http, "POST", "/v1/verifications", { service_id: "svc_discord", max_price_cents: 120 });
      ids.push(res.body.data.verification.id);
      if (i % 2) await call(http, "POST", `/v1/verifications/${ids[i]}/cancel`); // refunds keep the balance up
    }
    expect((await call(http, "GET", `/v1/verifications/${ids[0]}`)).status).toBe(404);
    expect((await call(http, "GET", `/v1/verifications/${ids[1]}`)).status).toBe(200);
  });

  it(`keeps the newest ${SANDBOX_MAX_MESSAGES} SMS of a verification`, async () => {
    vi.useFakeTimers();
    const http = createSandboxHttpClient();
    const id = (await call(http, "POST", "/v1/verifications", { service_id: "svc_discord", max_price_cents: 120 })).body.data.verification.id;
    for (let i = 0; i < SANDBOX_MAX_MESSAGES + 5; i++) {
      vi.advanceTimersByTime(READY_AFTER_MS + 1);
      await call(http, "GET", `/v1/verifications/${id}`); // the code arrives
      await call(http, "POST", `/v1/verifications/${id}/reuse`);
    }
    vi.advanceTimersByTime(READY_AFTER_MS + 1);
    await call(http, "GET", `/v1/verifications/${id}`);
    expect((await call(http, "GET", `/v1/verifications/${id}/messages`)).body.data.messages).toHaveLength(SANDBOX_MAX_MESSAGES);
  });

  it(`refuses list ${SANDBOX_MAX_LISTS + 1} on a proxy, like prod`, async () => {
    vi.useFakeTimers();
    const http = createSandboxHttpClient();
    const proxy = (await call(http, "POST", "/v1/proxies", { plan_id: "plan_US5GB30D", max_price_cents: 1800 })).body.data.proxy.id;
    vi.advanceTimersByTime(READY_AFTER_MS + 1);
    for (let i = 0; i < SANDBOX_MAX_LISTS; i++) {
      expect((await call(http, "POST", `/v1/proxies/${proxy}/lists`, { name: `l${i}`, country: "US" })).status).toBe(201);
    }
    const over = await call(http, "POST", `/v1/proxies/${proxy}/lists`, { name: "over", country: "US" });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("PROXY_LIST_LIMIT_EXCEEDED");
  });
});

describe("IP_NOT_ALLOWED wording", () => {
  const err = new HttpError(403, "IP_NOT_ALLOWED", "req_1", undefined, "IP not allowed", { method: "GET" });
  it("stdio: this machine's IP; hosted: keys with an IP allowlist do not work through the hosted server", () => {
    expect(mapApiError(err, { depositUrl: "x" })).toContain("this machine's IP is not on the list");
    const hosted = mapApiError(err, { depositUrl: "x", hosted: true });
    expect(hosted).toContain("does not work through the hosted VoidMob MCP server");
    expect(hosted).not.toContain("this machine");
  });
});

describe("UNAUTHENTICATED wording", () => {
  const err = new HttpError(401, "UNAUTHENTICATED", "req_1", undefined, "Invalid API key", { method: "GET" });
  const links = { depositUrl: "https://dashboard.voidmob.com/wallet" };

  it("stdio: the VOIDMOB_API_KEY setting", () => {
    expect(mapApiError(err, links)).toContain("Your VOIDMOB_API_KEY is invalid or revoked");
  });

  it("hosted app connection: reconnect and sign in again", () => {
    const text = mapApiError(err, {
      ...links,
      hosted: true,
      connection: { permission: "buy", autoMode: false, maxOrderCents: null, dailyLimitCents: null, kind: "oauth" },
    });
    expect(text).toContain("reconnect VoidMob in this app and sign in again");
    expect(text).not.toContain("VOIDMOB_API_KEY");
  });

  it("hosted API key: a new key, set in the app", () => {
    const text = mapApiError(err, { ...links, hosted: true, connection: null });
    expect(text).toContain("generate a new key");
    expect(text).not.toContain("VOIDMOB_API_KEY");
  });
});

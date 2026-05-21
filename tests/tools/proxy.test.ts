import { describe, it, expect } from "vitest";
import {
  searchProxiesHandler,
  purchaseProxyHandler,
  getProxyStatusHandler,
  rotateProxyIpHandler,
  renewProxyHandler,
  topupProxyHandler,
  regenerateProxyPasswordHandler,
} from "../../src/tools/proxy.js";
import { createMockHttpClient } from "../../src/testing/mock-http.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function planFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "proxy_plan_us_shared_5gb",
    name: "US Shared 5GB / 30d",
    type: "shared",
    country: "US",
    data_gb: 5,
    duration_days: 30,
    quoted_price_cents: 1499,
    ...overrides,
  };
}

function gatewayFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    host: "us.proxy.voidmob.com",
    port: 10000,
    protocol: "http",
    username: "vm_abc123",
    password: "p4ssw0rd",
    ...overrides,
  };
}

function proxyResp(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    status: "active",
    plan_id: "proxy_plan_us_shared_5gb",
    type: "shared",
    country: "US",
    data_gb_total: 5,
    data_bytes_used: 0,
    charged_price_cents: 1499,
    expires_at: "2026-06-20T00:00:00Z",
    gateway: gatewayFixture(),
    lists: [],
    created_at: "2026-05-21T00:00:00Z",
    ...overrides,
  };
}

// ── search_proxies ──────────────────────────────────────────────────────────

describe("search_proxies", () => {
  it("composes query string with all filters and renders a list", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans?country=US&type=shared&min_gb=5", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy_plans: [planFixture()] },
      },
    });
    const res = await searchProxiesHandler(http)({
      country: "US",
      type: "shared",
      min_data_gb: 5,
    });
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("US Shared 5GB / 30d");
    expect(t.text).toContain("$14.99");
    expect(t.text).toContain("US");
    const plans = res.structuredContent?.proxy_plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: "proxy_plan_us_shared_5gb",
      type: "shared",
      country: "US",
      quoted_price_cents: 1499,
    });
  });

  it("returns toolError when no plans match", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans?country=ZZ", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy_plans: [] } },
    });
    const res = await searchProxiesHandler(http)({ country: "ZZ" });
    expect(res.isError).toBe(true);
  });

  it("surfaces upstream error with request_id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans", {
      status: 500,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "boom",
          request_id: "req_proxy_err",
          docs_url: "",
        },
      },
    });
    const res = await searchProxiesHandler(http)({});
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_proxy_err");
  });
});

// ── purchase_proxy ──────────────────────────────────────────────────────────

describe("purchase_proxy", () => {
  it("quote-then-commit: GET plans, find plan, POST /v1/proxies with tied max_price_cents and idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy_plans: [planFixture()] },
      },
    });
    http.expect("POST", "/v1/proxies", {
      status: 202,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz", { status: "provisioning", gateway: null }),
        },
      },
    });
    const res = await purchaseProxyHandler(http)({ plan_id: "proxy_plan_us_shared_5gb" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(http.history[1].method).toBe("POST");
    expect(http.history[1].path).toBe("/v1/proxies");
    expect(http.history[1].body).toMatchObject({
      plan_id: "proxy_plan_us_shared_5gb",
      max_price_cents: 1499,
    });
    expect(http.history[1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.proxy).toMatchObject({
      id: "proxy_xyz",
      status: "provisioning",
    });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("provisioning");
    expect(t.text).toContain("get_proxy_status");
  });

  it("plan not found → toolError without commit attempt", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy_plans: [planFixture()] },
      },
    });
    const res = await purchaseProxyHandler(http)({ plan_id: "proxy_plan_does_not_exist" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1); // No POST attempt
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("proxy_plan_does_not_exist");
    expect(t.text).toContain("search_proxies");
  });
});

// ── get_proxy_status ────────────────────────────────────────────────────────

describe("get_proxy_status", () => {
  it("happy path: 3 parallel calls (proxy, usage, nolist_credentials), merged response", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 1073741824 }) },
      },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { data_used_gb: 1.0, data_total_gb: 5 },
      },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/nolist_credentials", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { username: "nolist_user", password: "nolist_pass" },
      },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz" });
    expect(res.structuredContent?.usage).toMatchObject({ data_used_gb: 1.0 });
    expect(res.structuredContent?.nolist_credentials).toMatchObject({ username: "nolist_user" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("proxy_xyz");
    expect(t.text).toContain("us.proxy.voidmob.com");
    expect(t.text).toContain("p4ssw0rd");
  });

  it("partial failure: usage and nolist_credentials return 503 → still succeeds with those fields null", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz", { gateway: null, status: "provisioning" }) },
      },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", {
      status: 503,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "USAGE_UNAVAILABLE",
          message: "usage not ready",
          request_id: "req_usage_503",
          docs_url: "",
        },
      },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/nolist_credentials", {
      status: 503,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "NOLIST_UNAVAILABLE",
          message: "not provisioned yet",
          request_id: "req_nolist_503",
          docs_url: "",
        },
      },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz" });
    expect(res.structuredContent?.usage).toBeNull();
    expect(res.structuredContent?.nolist_credentials).toBeNull();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("not yet provisioned");
  });
});

// ── rotate_proxy_ip ─────────────────────────────────────────────────────────

describe("rotate_proxy_ip", () => {
  it("happy path with idempotency, surfaces old_ip/new_ip", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/rotate_ip", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz"),
          old_ip: "203.0.113.5",
          new_ip: "203.0.113.99",
        },
      },
    });
    const res = await rotateProxyIpHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].method).toBe("POST");
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("203.0.113.5");
    expect(t.text).toContain("203.0.113.99");
    expect(res.structuredContent?.old_ip).toBe("203.0.113.5");
    expect(res.structuredContent?.new_ip).toBe("203.0.113.99");
  });
});

// ── renew_proxy ─────────────────────────────────────────────────────────────

describe("renew_proxy", () => {
  it("happy path: fetch core, fetch plans, POST renew with tied max_price_cents + idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz") },
      },
    });
    http.expect("GET", "/v1/proxy_plans", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy_plans: [planFixture()] },
      },
    });
    http.expect("POST", "/v1/proxies/proxy_xyz/renew", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz", { expires_at: "2026-07-20T00:00:00Z" }),
        },
      },
    });
    const res = await renewProxyHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(3);
    expect(http.history[2].method).toBe("POST");
    expect(http.history[2].path).toBe("/v1/proxies/proxy_xyz/renew");
    expect(http.history[2].body).toMatchObject({ max_price_cents: 1499 });
    expect(http.history[2].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.proxy).toMatchObject({
      id: "proxy_xyz",
      expires_at: "2026-07-20T00:00:00Z",
    });
  });

  it("proxy has null plan_id → toolError, no plan fetch or POST", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_legacy", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_legacy", { plan_id: null }) },
      },
    });
    const res = await renewProxyHandler(http)({ proxy_id: "proxy_legacy" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1); // Stopped before plans + renew
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("proxy_legacy");
    expect(t.text).toContain("no plan_id");
  });
});

// ── topup_proxy ─────────────────────────────────────────────────────────────

describe("topup_proxy", () => {
  it("happy path with body {data_gb} + idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/topup", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz", { data_gb_total: 10 }),
          charged_price_cents: 599,
        },
      },
    });
    const res = await topupProxyHandler(http)({ proxy_id: "proxy_xyz", data_gb: 5 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].method).toBe("POST");
    expect(http.history[0].body).toMatchObject({ data_gb: 5 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("5 GB");
    expect(t.text).toContain("$5.99");
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz", data_gb_total: 10 });
  });
});

// ── regenerate_proxy_password ───────────────────────────────────────────────

describe("regenerate_proxy_password", () => {
  it("happy path + new password surfaced in text", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/regenerate_password", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz", {
            gateway: gatewayFixture({ password: "n3wP4ssw0rd" }),
          }),
        },
      },
    });
    const res = await regenerateProxyPasswordHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].method).toBe("POST");
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("n3wP4ssw0rd");
    expect(t.text).toContain("proxy_xyz");
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz" });
  });
});

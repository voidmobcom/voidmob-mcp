import { describe, it, expect } from "vitest";
import {
  searchProxiesHandler,
  purchaseProxyHandler,
  getProxyStatusHandler,
  rotateProxyIpHandler,
  renewProxyHandler,
  topupProxyHandler,
  regenerateProxyPasswordHandler,
  listProxyListsHandler,
  createProxyListHandler,
  deleteProxyListHandler,
  setProxyAutoRenewHandler,
} from "../../src/tools/proxy.js";
import { createMockHttpClient } from "../mock-http.js";

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

function dedicatedPlanFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "plan_DED_US_NY",
    name: "United States Verizon New York (monthly)",
    type: "dedicated_standard",
    country: "us",
    country_name: "United States",
    carrier: "Verizon",
    region: "New York",
    data_gb: null,
    duration_days: 30,
    period: "monthly",
    quoted_price_cents: 6900,
    available: true,
    ...overrides,
  };
}

function dedicatedResp(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return proxyResp(id, {
    type: "dedicated_standard",
    country: "us",
    carrier: "Verizon",
    plan_id: "plan_DED_US_NY",
    data_gb_total: 0,
    charged_price_cents: 6900,
    auto_renew: false,
    next_renewal_price_cents: 6900,
    gateway: { host: "h1.example.net", port: 8001, protocol: "http", username: "u1", password: "p1", socks_port: 9001 },
    rotation_url: "https://dashboard.voidmob.com/api/proxy/rotate/tok",
    ...overrides,
  });
}

// ── search_proxies ──────────────────────────────────────────────────────────

describe("search_proxies", () => {
  it("composes query string with all filters and renders a list", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans?country=US&min_gb=5", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { plans: [planFixture()] },
      },
    });
    const res = await searchProxiesHandler(http)({
      country: "US",
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
      body: { success: true, data: { plans: [] } },
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
  it("quote-then-commit: GET the plan, POST /v1/proxies with tied max_price_cents and idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { plan: planFixture() },
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
    http.expect("GET", "/v1/proxy_plans/proxy_plan_does_not_exist", {
      status: 404,
      headers: new Headers(),
      body: {
        success: false,
        error: { code: "PROXY_PLAN_NOT_FOUND", message: "Unknown proxy plan id.", request_id: "req_nf", docs_url: "" },
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
  const usageOk = {
    status: 200,
    headers: new Headers(),
    body: {
      success: true,
      data: { usage: { daily_bytes: 0, weekly_bytes: 0, monthly_bytes: 0, total_bytes: 1073741824, total_gb_allocated: 5, remaining_bytes: 4 } },
    },
  };

  it("active proxy without a gateway: provisions it via POST flex_credentials (the only credentials endpoint)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      // Core GET has gateway null until the Flex credentials are first requested.
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 1073741824, gateway: null }) },
      },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", usageOk);
    http.expect("POST", "/v1/proxies/proxy_xyz/flex_credentials", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 1073741824 }) },
      },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    // Regression: v1.1.5 called the removed nolist_credentials alias and the
    // 404 was swallowed, so the gateway never appeared.
    expect(http.history.map((h) => `${h.method} ${h.path}`)).toContain("POST /v1/proxies/proxy_xyz/flex_credentials");
    expect(http.history.find((h) => h.path.endsWith("/flex_credentials"))?.headers["Idempotency-Key"]).toMatch(/^flex-proxy_xyz-\d+$/);
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz" });
    expect(res.structuredContent?.usage).toMatchObject({ total_bytes: 1073741824 });
    expect(res.structuredContent?.nolist_credentials).toMatchObject({ username: "vm_abc123" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("proxy_xyz");
    expect(t.text).toContain("us.proxy.voidmob.com");
    expect(t.text).toContain("p4ssw0rd");
  });

  it("gateway already provisioned: no flex call, live core values win", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 3221225472 }) } },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", usageOk);
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(res.structuredContent?.proxy).toMatchObject({ data_bytes_used: 3221225472 });
    expect(res.structuredContent?.nolist_credentials).toMatchObject({ username: "vm_abc123" });
  });

  it("takes only the gateway from flex_credentials, never its (replayable, stale) proxy snapshot", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 3221225472, gateway: null }) } },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", usageOk);
    http.expect("POST", "/v1/proxies/proxy_xyz/flex_credentials", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 0 }) } },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.structuredContent?.proxy).toMatchObject({ data_bytes_used: 3221225472 });
    expect(res.structuredContent?.nolist_credentials).toMatchObject({ username: "vm_abc123" });
  });

  it("provisioning proxy: no flex call; usage failure degrades to null", async () => {
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
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz" });
    expect(res.structuredContent?.usage).toBeNull();
    expect(res.structuredContent?.nolist_credentials).toBeNull();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("not yet provisioned");
  });

  it("flex_credentials failure on an active proxy degrades to no gateway, never an error", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { gateway: null }) } },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", usageOk);
    http.expect("POST", "/v1/proxies/proxy_xyz/flex_credentials", {
      status: 409,
      headers: new Headers(),
      body: {
        success: false,
        error: { code: "PROXY_NOT_READY", message: "not ready", request_id: "req_flex_409", docs_url: "" },
      },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.nolist_credentials).toBeNull();
  });
});

// ── rotate_proxy_ip ─────────────────────────────────────────────────────────

describe("rotate_proxy_ip", () => {
  it("happy path with idempotency, surfaces proxy_id/rotated_at/current_ip", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/PRX-abc/rotate_ip", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy_id: "PRX-abc",
          rotated_at: "2026-01-01T00:00:00Z",
          current_ip: "1.2.3.4",
        },
      },
    });
    const res = await rotateProxyIpHandler(http)({ proxy_id: "PRX-abc" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].method).toBe("POST");
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("PRX-abc");
    expect(t.text).toContain("2026-01-01T00:00:00Z");
    expect(t.text).toContain("1.2.3.4");
    expect(res.structuredContent?.proxy_id).toBe("PRX-abc");
    expect(res.structuredContent?.rotated_at).toBe("2026-01-01T00:00:00Z");
    expect(res.structuredContent?.current_ip).toBe("1.2.3.4");
  });
});

// ── renew_proxy ─────────────────────────────────────────────────────────────

describe("renew_proxy", () => {
  it("charges exactly the proxy's own renewal quote: GET core, POST renew with it as max_price_cents + idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz", { next_renewal_price_cents: 1299 }) },
      },
    });
    http.expect("POST", "/v1/proxies/proxy_xyz/renew", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz", { expires_at: "2026-07-20T00:00:00Z", next_renewal_price_cents: 1299 }),
        },
      },
    });
    const res = await renewProxyHandler(http)({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(http.history[1].method).toBe("POST");
    expect(http.history[1].path).toBe("/v1/proxies/proxy_xyz/renew");
    expect(http.history[1].body).toMatchObject({ max_price_cents: 1299 });
    expect(http.history[1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.proxy).toMatchObject({
      id: "proxy_xyz",
      expires_at: "2026-07-20T00:00:00Z",
    });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$12.99");
    expect(t.text).toContain("2026-07-20T00:00:00Z");
  });

  it("dedicated proxy renews at its locked-in price, not the plan's current one", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_ded", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { next_renewal_price_cents: 5520 }) } },
    });
    http.expect("POST", "/v1/proxies/prx_ded/renew", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { expires_at: "2026-11-01T00:00:00Z" }) } },
    });
    const res = await renewProxyHandler(http)({ proxy_id: "prx_ded" });
    expect(res.isError).toBeFalsy();
    expect(http.history.map((h) => `${h.method} ${h.path}`)).toEqual(["GET /v1/proxies/prx_ded", "POST /v1/proxies/prx_ded/renew"]);
    expect(http.history[1].body).toMatchObject({ max_price_cents: 5520 });
  });

  it("no renewal quote → toolError, no POST", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_legacy", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_legacy", { plan_id: null, status: "refunded", next_renewal_price_cents: null }) },
      },
    });
    const res = await renewProxyHandler(http)({ proxy_id: "proxy_legacy" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("proxy_legacy");
    expect(t.text).toContain("cannot be renewed");
  });

  it("expired dedicated proxy → explains it can only renew while active, no POST", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_ded", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { status: "expired", next_renewal_price_cents: null, gateway: null }) } },
    });
    const res = await renewProxyHandler(http)({ proxy_id: "prx_ded" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("only be renewed while active");
  });
});

// ── topup_proxy ─────────────────────────────────────────────────────────────

describe("topup_proxy", () => {
  it("quote-then-commit: GET proxy + plan, POST topup with additional_gb + tied max_price_cents + idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz") },
      },
    });
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { plan: planFixture() },
      },
    });
    http.expect("POST", "/v1/proxies/proxy_xyz/topup", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("proxy_xyz", { data_gb_total: 10 }),
          charged_price_cents: 1499,
        },
      },
    });
    const res = await topupProxyHandler(http)({ proxy_id: "proxy_xyz", additional_gb: 5 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(3);
    expect(http.history[2].method).toBe("POST");
    expect(http.history[2].path).toBe("/v1/proxies/proxy_xyz/topup");
    // Plan: quoted=1499c for 5GB → perGb=299.8 → 5GB topup = round(1499) = 1499
    expect(http.history[2].body).toMatchObject({ additional_gb: 5, max_price_cents: 1499 });
    expect(http.history[2].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("5 GB");
    expect(t.text).toContain("$14.99");
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

// ── list_proxy_lists ────────────────────────────────────────────────────────

describe("list_proxy_lists", () => {
  it("reads lists from GET /v1/proxies/:id (no list collection endpoint)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_abc", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("prx_abc", { lists: [{
        id: "lst_1", proxy_id: "prx_abc", name: "Default",
        country: null, countries: ["us", "ca"], region: null, city: null, isp: null, zip: null,
        rotation_period_seconds: 0, rotation_mode: "instant", format: "login_pass_host_port",
        credentials: { host: "proxy.voidmob.com", port: 10000, protocol: "http", username: "u", password: "p" },
        entries: ["u:p@proxy.voidmob.com:10000"], activation_note: "List active within 1-2 minutes.",
        created_at: "2026-05-01T00:00:00Z",
      }] }) } },
    });
    const res = await listProxyListsHandler(http)({ proxy_id: "prx_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.lists).toHaveLength(1);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("per-request");
    expect(t.text).toContain("us,ca");
  });

  it("empty lists → toolError", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_abc", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("prx_abc", { lists: [] }) } },
    });
    const res = await listProxyListsHandler(http)({ proxy_id: "prx_abc" });
    expect(res.isError).toBe(true);
  });

  it("propagates request_id on PROXY_NOT_FOUND", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_missing", {
      status: 404, headers: new Headers(),
      body: { success: false, error: { code: "PROXY_NOT_FOUND", message: "Proxy not found.", request_id: "req_listmissing", docs_url: "" } },
    });
    const res = await listProxyListsHandler(http)({ proxy_id: "prx_missing" });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_listmissing");
  });
});

// ── create_proxy_list ───────────────────────────────────────────────────────

describe("create_proxy_list", () => {
  function listFixture(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id, proxy_id: "prx_abc", name: "Test",
      country: null, countries: null, region: null, city: null, isp: null, zip: null,
      rotation_period_seconds: 0, rotation_mode: "instant", format: "login_pass_host_port",
      credentials: { host: "proxy.voidmob.com", port: 10000, protocol: "http", username: "u", password: "p" },
      entries: ["u:p@proxy.voidmob.com:10000"], activation_note: "List active within 1-2 minutes.",
      created_at: "2026-05-01T00:00:00Z",
      ...overrides,
    };
  }

  it("single country → POST /v1/proxies/:id/lists with country + defaults + idempotency key", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_abc/lists", {
      status: 201, headers: new Headers(),
      body: { success: true, data: { list: listFixture("lst_new", { country: "us" }) } },
    });
    const res = await createProxyListHandler(http)({
      proxy_id: "prx_abc",
      name: "Test",
      country: "us",
    });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toMatchObject({
      name: "Test", country: "us", rotation_period_seconds: 0, rotation_mode: "instant", format: "login_pass_host_port",
    });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("u:p@proxy.voidmob.com:10000");
  });

  it("neither country nor countries → toolError (no HTTP call)", async () => {
    const http = createMockHttpClient();
    const res = await createProxyListHandler(http)({ proxy_id: "prx_abc", name: "Test" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("country AND countries together → toolError (no HTTP call)", async () => {
    const http = createMockHttpClient();
    const res = await createProxyListHandler(http)({
      proxy_id: "prx_abc", name: "Test", country: "us", countries: ["us", "gb"],
    });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("countries with a subfilter → toolError (no HTTP call)", async () => {
    const http = createMockHttpClient();
    const res = await createProxyListHandler(http)({
      proxy_id: "prx_abc", name: "Test", countries: ["us", "gb"], region: "California",
    });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("countries (multi) → POST with countries array, no subfilters", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_abc/lists", {
      status: 201, headers: new Headers(),
      body: { success: true, data: { list: listFixture("lst_new", { countries: ["us", "gb"] }) } },
    });
    const res = await createProxyListHandler(http)({
      proxy_id: "prx_abc",
      name: "Test",
      countries: ["us", "gb"],
    });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toMatchObject({ countries: ["us", "gb"] });
    expect(http.history[0].body).not.toHaveProperty("country");
  });
});

// ── delete_proxy_list ───────────────────────────────────────────────────────

describe("delete_proxy_list", () => {
  it("DELETE /v1/proxies/:id/lists/:lid with idempotency key", async () => {
    const http = createMockHttpClient();
    http.expect("DELETE", "/v1/proxies/prx_abc/lists/lst_xyz", {
      status: 204, headers: new Headers(),
      body: { success: true, data: null },
    });
    const res = await deleteProxyListHandler(http)({ proxy_id: "prx_abc", list_id: "lst_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── dedicated proxies ───────────────────────────────────────────────────────

describe("search_proxies - dedicated", () => {
  it("type=dedicated maps to dedicated_standard, passes available/cursor, renders location + stock, returns next_cursor", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans?type=dedicated_standard&country=US&available=true&cursor=abc", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { plans: [dedicatedPlanFixture(), dedicatedPlanFixture({ id: "plan_DED_US_TX", region: "Texas", available: false })], next_cursor: "def" },
      },
    });
    const res = await searchProxiesHandler(http)({ type: "dedicated", country: "US", available_only: true, cursor: "abc" });
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Verizon / New York");
    expect(t.text).toContain("unmetered");
    expect(t.text).toContain("$69.00");
    expect(t.text).toContain("(sold out)");
    expect(t.text).toContain('cursor="def"');
    expect(res.structuredContent?.next_cursor).toBe("def");
  });

  it("without type keeps the original shared-only request (no available/cursor params)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans?country=US", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { plans: [planFixture()] } },
    });
    const res = await searchProxiesHandler(http)({ country: "US", available_only: true, cursor: "abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.next_cursor).toBeNull();
  });
});

describe("purchase_proxy - dedicated", () => {
  it("sold-out plan → toolError, no POST", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans/plan_DED_US_NY", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { plan: dedicatedPlanFixture({ available: false }) } },
    });
    const res = await purchaseProxyHandler(http)({ plan_id: "plan_DED_US_NY" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("sold out");
  });

  it("active on purchase → says so and points at get_proxy_status", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans/plan_DED_US_NY", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { plan: dedicatedPlanFixture() } },
    });
    http.expect("POST", "/v1/proxies", {
      status: 202,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded") } },
    });
    const res = await purchaseProxyHandler(http)({ plan_id: "plan_DED_US_NY" });
    expect(res.isError).toBeFalsy();
    expect(http.history[1].body).toMatchObject({ plan_id: "plan_DED_US_NY", max_price_cents: 6900 });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("is active");
    expect(t.text).toContain("get_proxy_status");
  });

  it("provisioning dedicated → mentions the ~5 minute window and the automatic refund", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans/plan_DED_US_NY", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { plan: dedicatedPlanFixture() } },
    });
    http.expect("POST", "/v1/proxies", {
      status: 202,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { status: "provisioning", gateway: null }) } },
    });
    const res = await purchaseProxyHandler(http)({ plan_id: "plan_DED_US_NY" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("5 minutes");
    expect(t.text).toContain("refunded");
  });
});

describe("get_proxy_status - dedicated", () => {
  it("shows location, unmetered data, SOCKS5 port, auto-renew and renewal price; no flex call; the usage 404 is ignored", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_ded", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { auto_renew: true, next_renewal_price_cents: 5520 }) } },
    });
    http.expect("GET", "/v1/proxies/prx_ded/usage", {
      status: 404,
      headers: new Headers(),
      body: { success: false, error: { code: "PROXY_NOT_FOUND", message: "Proxy not found.", request_id: "req_u", docs_url: "" } },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "prx_ded" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(res.structuredContent?.usage).toBeNull();
    expect(res.structuredContent?.nolist_credentials).toMatchObject({ host: "h1.example.net", socks_port: 9001 });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("US / Verizon");
    expect(t.text).toContain("unmetered");
    expect(t.text).toContain("SOCKS5:    9001");
    expect(t.text).toContain("Auto-renew:    on");
    expect(t.text).toContain("$55.20");
  });

  it("an active Premium proxy never triggers a flex call and says where its credentials are", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_prem", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_prem", { type: "dedicated_premium", gateway: null, next_renewal_price_cents: null }) } },
    });
    http.expect("GET", "/v1/proxies/prx_prem/usage", {
      status: 404,
      headers: new Headers(),
      body: { success: false, error: { code: "PROXY_NOT_FOUND", message: "Proxy not found.", request_id: "req_u", docs_url: "" } },
    });
    const res = await getProxyStatusHandler(http)({ proxy_id: "prx_prem" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("dashboard");
  });
});

describe("topup_proxy - dedicated", () => {
  it("refuses locally - dedicated data is unmetered - without fetching the plan", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_ded", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded") } },
    });
    const res = await topupProxyHandler(http)({ proxy_id: "prx_ded", additional_gb: 5 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("unmetered");
  });
});

describe("set_proxy_auto_renew", () => {
  it("POSTs the explicit state and reports the renewal price and timing", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_ded/auto_renew", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { auto_renew: true, next_renewal_price_cents: 5520 }) } },
    });
    const res = await setProxyAutoRenewHandler(http)({ proxy_id: "prx_ded", enabled: true });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toEqual({ enabled: true });
    expect(http.history[0].headers["Idempotency-Key"]).toBeUndefined();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Auto-renew is on");
    expect(t.text).toContain("$55.20");
  });

  it("surfaces NOT_SUPPORTED for a shared proxy", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/auto_renew", {
      status: 422,
      headers: new Headers(),
      body: { success: false, error: { code: "NOT_SUPPORTED", message: "Not supported.", request_id: "req_ns", docs_url: "" } },
    });
    const res = await setProxyAutoRenewHandler(http)({ proxy_id: "proxy_xyz", enabled: true });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_ns");
  });
});


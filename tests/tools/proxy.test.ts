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
  updateProxyListHandler,
} from "../../src/tools/proxy.js";
import { createMockHttpClient } from "../mock-http.js";
import { toolContext } from "../../src/tools/context.js";

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

const planOk = (plan: Record<string, unknown> = planFixture()) => ({
  status: 200,
  headers: new Headers(),
  body: { success: true, data: { plan } },
});
const priceMismatch = { status: 409, headers: new Headers(), body: { success: false, error: { code: "PRICE_MISMATCH", message: "Price exceeds the supplied max_price_cents.", request_id: "req_pm" } } };
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? "";

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
    const res = await searchProxiesHandler(toolContext(http))({
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

  it("no matching plans is a normal empty result, not an error", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxy_plans?country=ZZ", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { plans: [] } },
    });
    const res = await searchProxiesHandler(toolContext(http))({ country: "ZZ" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.proxy_plans).toEqual([]);
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
    const res = await searchProxiesHandler(toolContext(http))({});
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_proxy_err");
  });
});

// ── purchase_proxy ──────────────────────────────────────────────────────────

describe("purchase_proxy", () => {
  it("commits with the caller's max_price_cents + idempotency, no internal quote; counts the charge", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies", {
      status: 202,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { status: "provisioning", gateway: null }) } },
    });
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await purchaseProxyHandler(ctx)({ plan_id: "proxy_plan_us_shared_5gb", max_price_cents: 1499 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].path).toBe("/v1/proxies");
    expect(http.history[0].body).toEqual({ plan_id: "proxy_plan_us_shared_5gb", max_price_cents: 1499 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz", status: "provisioning" });
    expect(textOf(res)).toContain("provisioning");
    expect(textOf(res)).toContain("get_proxy_status");
    expect(ctx.guard.countedCents).toBe(1499);
  });

  it("PRICE_MISMATCH: reads the plan's current price and hands it back to re-confirm; nothing counted", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies", priceMismatch);
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk(planFixture({ quoted_price_cents: 1599 })));
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await purchaseProxyHandler(ctx)({ plan_id: "proxy_plan_us_shared_5gb", max_price_cents: 1499 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("$15.99");
    expect(textOf(res)).toContain("max_price_cents=1599");
    expect(textOf(res)).toContain("nothing was charged");
    expect(textOf(res)).toContain("req_pm");
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("an unknown plan is the API's PROXY_PLAN_NOT_FOUND", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies", {
      status: 404,
      headers: new Headers(),
      body: { success: false, error: { code: "PROXY_PLAN_NOT_FOUND", message: "Unknown proxy plan id.", request_id: "req_nf" } },
    });
    const res = await purchaseProxyHandler(toolContext(http))({ plan_id: "proxy_plan_does_not_exist", max_price_cents: 100 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Unknown proxy plan id.");
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
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk());
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "proxy_xyz" });
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

  it("shared gateway: prints a ready http:// URL, the targeting hint and flex username examples", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_flex", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          proxy: proxyResp("prx_flex", {
            gateway: gatewayFixture({ host: "proxy.voidmob.com", port: 10092, username_geo_hint: "Flex mode: append parameters to username. _c_US (country)" }),
          }),
        },
      },
    });
    http.expect("GET", "/v1/proxies/prx_flex/usage", usageOk);
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk());
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "prx_flex" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    // Top-up price basis: 1499c / 5 GB.
    expect(t.text).toContain("Top-up price:  about $3.00 per GB");
    expect(res.structuredContent?.topup_estimate_per_gb_cents).toBe(300);
    expect(t.text).toContain("HTTP URL:  http://vm_abc123:p4ssw0rd@proxy.voidmob.com:10092");
    expect(t.text).toContain("Flex mode: append parameters to username.");
    expect(t.text).toContain("http://vm_abc123_c_US:p4ssw0rd@proxy.voidmob.com:10092");
    expect(t.text).toContain("http://vm_abc123_c_US_s_worker1_ttl_10m:p4ssw0rd@proxy.voidmob.com:10092");
    expect(t.text).not.toContain("socks5://");
  });

  it("gateway already provisioned: no flex call, live core values win", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { data_bytes_used: 3221225472 }) } },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", usageOk);
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk());
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history.map((h) => h.method)).not.toContain("POST");
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
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk());
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "proxy_xyz" });
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
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "proxy_xyz" });
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
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", {
      status: 500, headers: new Headers(),
      body: { success: false, error: { code: "INTERNAL_ERROR", message: "x", request_id: "r" } },
    });
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.nolist_credentials).toBeNull();
    // The failed plan read degrades to no top-up price, never an error.
    expect(res.structuredContent?.topup_estimate_per_gb_cents).toBeNull();
  });

  it("read-only mode never creates the gateway login (no POST) and says why", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/proxy_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { gateway: null }) } },
    });
    http.expect("GET", "/v1/proxies/proxy_xyz/usage", usageOk);
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk());
    const res = await getProxyStatusHandler(toolContext(http, { readOnly: true }))({ proxy_id: "proxy_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history.every((h) => h.method === "GET")).toBe(true);
    expect(textOf(res)).toContain("read-only");
  });
});

// ── rotate_proxy_ip ─────────────────────────────────────────────────────────

describe("rotate_proxy_ip", () => {
  it("happy path, surfaces proxy_id/rotated_at/current_ip; sends no Idempotency-Key (not honored - never auto-retried)", async () => {
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
    const res = await rotateProxyIpHandler(toolContext(http))({ proxy_id: "PRX-abc" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].method).toBe("POST");
    expect(http.history[0].headers["Idempotency-Key"]).toBeUndefined();
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
  it("POSTs renew with the caller's max_price_cents + idempotency, no internal quote; the budget counts the cap", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/renew", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { proxy: proxyResp("proxy_xyz", { expires_at: "2026-07-20T00:00:00Z", next_renewal_price_cents: 1299 }) },
      },
    });
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await renewProxyHandler(ctx)({ proxy_id: "proxy_xyz", max_price_cents: 1299 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].path).toBe("/v1/proxies/proxy_xyz/renew");
    expect(http.history[0].body).toEqual({ max_price_cents: 1299 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz", expires_at: "2026-07-20T00:00:00Z" });
    expect(textOf(res)).toContain("$12.99");
    expect(textOf(res)).toContain("2026-07-20T00:00:00Z");
    // The response does not state this charge, so the approved cap is counted.
    expect(ctx.guard.countedCents).toBe(1299);
  });

  it("PRICE_MISMATCH: reads next_renewal_price_cents and hands it back to re-confirm", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_ded/renew", priceMismatch);
    http.expect("GET", "/v1/proxies/prx_ded", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { next_renewal_price_cents: 5520 }) } },
    });
    const ctx = toolContext(http, { budgetCents: 10000 });
    const res = await renewProxyHandler(ctx)({ proxy_id: "prx_ded", max_price_cents: 5000 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("$55.20");
    expect(textOf(res)).toContain("max_price_cents=5520");
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("an expired dedicated proxy is the API's PROXY_EXPIRED, passed through", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_ded/renew", {
      status: 409,
      headers: new Headers(),
      body: { success: false, error: { code: "PROXY_EXPIRED", message: "Proxy has expired.", request_id: "r" } },
    });
    const res = await renewProxyHandler(toolContext(http))({ proxy_id: "prx_ded", max_price_cents: 6900 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Proxy has expired.");
  });
});

// ── topup_proxy ─────────────────────────────────────────────────────────────

describe("topup_proxy", () => {
  it("POSTs topup with additional_gb + the caller's max_price_cents + idempotency, no internal quote", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/topup", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("proxy_xyz", { data_gb_total: 10 }) } },
    });
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await topupProxyHandler(ctx)({ proxy_id: "proxy_xyz", additional_gb: 5, max_price_cents: 1500 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].body).toEqual({ additional_gb: 5, max_price_cents: 1500 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(textOf(res)).toContain("5 GB");
    expect(textOf(res)).toContain("$15.00");
    expect(res.structuredContent?.proxy).toMatchObject({ id: "proxy_xyz", data_gb_total: 10 });
    expect(ctx.guard.countedCents).toBe(1500);
  });

  it("PRICE_MISMATCH: estimates from the plan's price per GB and suggests a ceiling above the refused one", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/topup", priceMismatch);
    http.expect("GET", "/v1/proxies/proxy_xyz", { status: 200, headers: new Headers(), body: { success: true, data: { proxy: proxyResp("proxy_xyz") } } });
    http.expect("GET", "/v1/proxy_plans/proxy_plan_us_shared_5gb", planOk(planFixture({ quoted_price_cents: 2000 })));
    const res = await topupProxyHandler(toolContext(http))({ proxy_id: "proxy_xyz", additional_gb: 5, max_price_cents: 1500 });
    expect(res.isError).toBe(true);
    const t = textOf(res);
    expect(t).toContain("nothing was charged");
    expect(t).toContain("about $20.00");
    expect(t).toContain("max_price_cents (e.g. 2100)");
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
    const res = await regenerateProxyPasswordHandler(toolContext(http))({ proxy_id: "proxy_xyz" });
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
    const res = await listProxyListsHandler(toolContext(http))({ proxy_id: "prx_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.lists).toHaveLength(1);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("per-request");
    expect(t.text).toContain("us,ca");
  });

  it("empty lists → normal empty result pointing at create_proxy_list", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_abc", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { proxy: proxyResp("prx_abc", { lists: [] }) } },
    });
    const res = await listProxyListsHandler(toolContext(http))({ proxy_id: "prx_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.lists).toEqual([]);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("create_proxy_list");
  });

  it("propagates request_id on PROXY_NOT_FOUND", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_missing", {
      status: 404, headers: new Headers(),
      body: { success: false, error: { code: "PROXY_NOT_FOUND", message: "Proxy not found.", request_id: "req_listmissing", docs_url: "" } },
    });
    const res = await listProxyListsHandler(toolContext(http))({ proxy_id: "prx_missing" });
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
    const res = await createProxyListHandler(toolContext(http))({
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
    expect(t.text).toContain("HTTP URL:   http://u:p@proxy.voidmob.com:10000");
    expect(t.text).toContain("SOCKS5 URL: socks5://u:p@proxy.voidmob.com:10000");
  });

  it("neither country nor countries → toolError (no HTTP call)", async () => {
    const http = createMockHttpClient();
    const res = await createProxyListHandler(toolContext(http))({ proxy_id: "prx_abc", name: "Test" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("country AND countries together → toolError (no HTTP call)", async () => {
    const http = createMockHttpClient();
    const res = await createProxyListHandler(toolContext(http))({
      proxy_id: "prx_abc", name: "Test", country: "us", countries: ["us", "gb"],
    });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("countries with a subfilter → toolError (no HTTP call)", async () => {
    const http = createMockHttpClient();
    const res = await createProxyListHandler(toolContext(http))({
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
    const res = await createProxyListHandler(toolContext(http))({
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
  it("encodes both ids so a crafted list id cannot retarget the request", async () => {
    const http = createMockHttpClient();
    http.expect("DELETE", "/v1/proxies/prx_abc/lists/..%2F..%2F..%2Frentals%2Fren_x", {
      status: 404, headers: new Headers(),
      body: { success: false, error: { code: "PROXY_LIST_NOT_FOUND", message: "Proxy list not found.", request_id: "req_x" } },
    });
    const res = await deleteProxyListHandler(toolContext(http))({ proxy_id: "prx_abc", list_id: "../../../rentals/ren_x" });
    expect(res.isError).toBe(true);
    expect(http.history[0].path).toBe("/v1/proxies/prx_abc/lists/..%2F..%2F..%2Frentals%2Fren_x");
  });

  it("DELETE /v1/proxies/:id/lists/:lid with idempotency key", async () => {
    const http = createMockHttpClient();
    http.expect("DELETE", "/v1/proxies/prx_abc/lists/lst_xyz", {
      status: 204, headers: new Headers(),
      body: { success: true, data: null },
    });
    const res = await deleteProxyListHandler(toolContext(http))({ proxy_id: "prx_abc", list_id: "lst_xyz" });
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
    const res = await searchProxiesHandler(toolContext(http))({ type: "dedicated", country: "US", available_only: true, cursor: "abc" });
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
    const res = await searchProxiesHandler(toolContext(http))({ country: "US", available_only: true, cursor: "abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.next_cursor).toBeNull();
  });
});

describe("purchase_proxy - dedicated", () => {
  it("sold out is the API's SERVICE_OUT_OF_STOCK: nothing charged, nothing counted", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies", {
      status: 503,
      headers: new Headers(),
      body: { success: false, error: { code: "SERVICE_OUT_OF_STOCK", message: "out", request_id: "r" } },
    });
    const ctx = toolContext(http, { budgetCents: 10000 });
    const res = await purchaseProxyHandler(ctx)({ plan_id: "plan_DED_US_NY", max_price_cents: 6900 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Nothing was charged");
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("active on purchase → says so and points at get_proxy_status", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies", {
      status: 202,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded") } },
    });
    const res = await purchaseProxyHandler(toolContext(http))({ plan_id: "plan_DED_US_NY", max_price_cents: 6900 });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toEqual({ plan_id: "plan_DED_US_NY", max_price_cents: 6900 });
    expect(textOf(res)).toContain("is active");
    expect(textOf(res)).toContain("get_proxy_status");
  });

  it("provisioning dedicated → mentions the ~5 minute window and the automatic refund", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies", {
      status: 202,
      headers: new Headers(),
      body: { success: true, data: { proxy: dedicatedResp("prx_ded", { status: "provisioning", gateway: null }) } },
    });
    const res = await purchaseProxyHandler(toolContext(http))({ plan_id: "plan_DED_US_NY", max_price_cents: 6900 });
    expect(textOf(res)).toContain("5 minutes");
    expect(textOf(res)).toContain("refunded");
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
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "prx_ded" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(res.structuredContent?.usage).toBeNull();
    expect(res.structuredContent?.nolist_credentials).toMatchObject({ host: "h1.example.net", socks_port: 9001 });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("US / Verizon");
    expect(t.text).toContain("unmetered");
    expect(t.text).toContain("SOCKS5:    9001");
    expect(t.text).toContain("HTTP URL:  http://u1:p1@h1.example.net:8001");
    expect(t.text).toContain("SOCKS5 URL: socks5://u1:p1@h1.example.net:9001");
    expect(t.text).not.toContain("_c_US");
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
    const res = await getProxyStatusHandler(toolContext(http))({ proxy_id: "prx_prem" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("dashboard");
  });
});

describe("topup_proxy - dedicated", () => {
  it("a dedicated proxy is the API's NOT_SUPPORTED, passed through; nothing counted", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_ded/topup", {
      status: 422,
      headers: new Headers(),
      body: { success: false, error: { code: "NOT_SUPPORTED", message: "This action is not supported.", request_id: "r" } },
    });
    const ctx = toolContext(http, { budgetCents: 10000 });
    const res = await topupProxyHandler(ctx)({ proxy_id: "prx_ded", additional_gb: 5, max_price_cents: 1000 });
    expect(res.isError).toBe(true);
    expect(ctx.guard.countedCents).toBe(0);
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
    const res = await setProxyAutoRenewHandler(toolContext(http))({ proxy_id: "prx_ded", enabled: true });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toEqual({ enabled: true });
    expect(http.history[0].headers["Idempotency-Key"]).toBeUndefined();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Auto-renew is on");
    expect(t.text).toContain("$55.20");
  });

  it("owner limits: turning auto-renew on checks the renewal price against the per-order limit, and is off-limits with a budget", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/proxies/prx_ded", { status: 200, headers: new Headers(), body: { success: true, data: { proxy: dedicatedResp("prx_ded") } } });
    const over = await setProxyAutoRenewHandler(toolContext(http, { maxOrderCents: 5000 }))({ proxy_id: "prx_ded", enabled: true });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("$69.00");
    expect(http.history).toHaveLength(1);
    const budget = await setProxyAutoRenewHandler(toolContext(http, { budgetCents: 100_000 }))({ proxy_id: "prx_ded", enabled: true });
    expect(budget.isError).toBe(true);
    expect(textOf(budget)).toContain("VOIDMOB_BUDGET_CENTS");
    expect(http.history).toHaveLength(1);
  });

  it("surfaces NOT_SUPPORTED for a shared proxy", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/proxy_xyz/auto_renew", {
      status: 422,
      headers: new Headers(),
      body: { success: false, error: { code: "NOT_SUPPORTED", message: "Not supported.", request_id: "req_ns", docs_url: "" } },
    });
    const res = await setProxyAutoRenewHandler(toolContext(http))({ proxy_id: "proxy_xyz", enabled: true });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_ns");
  });
});


// ── proxy lists: IP whitelist, updates, per-list passwords ──────────────────

function listResp(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, proxy_id: "prx_abc", name: "Test",
    country: "US", countries: null, region: null, city: null, isp: null, zip: null,
    rotation_period_seconds: 0, rotation_mode: "instant", format: "login_pass_host_port",
    credentials: { host: "proxy.voidmob.com", port: 10000, protocol: "http", username: "u", password: "p" },
    entries: ["u:p@proxy.voidmob.com:10000"], network: null, activation_note: "List active within a few minutes of creation.",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}
const listOk = (list: Record<string, unknown>) => ({ status: 200, headers: new Headers(), body: { success: true, data: { list } } });

describe("create_proxy_list - IP whitelist", () => {
  it("sends network and renders the bare endpoint instead of a login", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_abc/lists", listOk(listResp("list_ip", {
      credentials: null, entries: ["proxy.voidmob.com:10000"], network: "203.0.113.7,198.51.100.0/24",
    })));
    const res = await createProxyListHandler(toolContext(http))({
      proxy_id: "prx_abc", name: "vm", country: "US", network: "203.0.113.7,198.51.100.0/24",
    });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toMatchObject({ name: "vm", country: "US", network: "203.0.113.7,198.51.100.0/24" });
    const t = textOf(res);
    expect(t).toContain("IP whitelist (203.0.113.7,198.51.100.0/24)");
    expect(t).toContain("http://proxy.voidmob.com:10000");
    expect(t).toContain("socks5://proxy.voidmob.com:10000");
    expect(t).not.toContain("provisioning");
    expect(res.structuredContent?.list).toMatchObject({ credentials: null, network: "203.0.113.7,198.51.100.0/24" });
  });

  it("omits network when not given (login/password list)", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_abc/lists", listOk(listResp("list_pw")));
    await createProxyListHandler(toolContext(http))({ proxy_id: "prx_abc", name: "pw", country: "US" });
    expect(http.history[0].body).not.toHaveProperty("network");
  });
});

describe("update_proxy_list", () => {
  it("PATCHes only the given fields with an idempotency key", async () => {
    const http = createMockHttpClient();
    http.expect("PATCH", "/v1/proxies/prx_abc/lists/list_1", listOk(listResp("list_1", { country: "DE", city: "Berlin", rotation_period_seconds: 600 })));
    const res = await updateProxyListHandler(toolContext(http))({
      proxy_id: "prx_abc", list_id: "list_1", country: "DE", city: "Berlin", rotation_period_seconds: 600,
    });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toEqual({ country: "DE", city: "Berlin", rotation_period_seconds: 600 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(textOf(res)).toContain("geo=DE/Berlin");
    expect(textOf(res)).toContain("rotation=600s");
    expect(res.structuredContent?.list).toMatchObject({ id: "list_1", city: "Berlin" });
  });

  it("switching to several countries sends countries alone", async () => {
    const http = createMockHttpClient();
    http.expect("PATCH", "/v1/proxies/prx_abc/lists/list_1", listOk(listResp("list_1", { country: null, countries: ["US", "CA"] })));
    await updateProxyListHandler(toolContext(http))({ proxy_id: "prx_abc", list_id: "list_1", countries: ["US", "CA"], rotation_mode: "delayed_5s", format: "socks5_url", name: "na" });
    expect(http.history[0].body).toEqual({ countries: ["US", "CA"], rotation_mode: "delayed_5s", format: "socks5_url", name: "na" });
  });

  it("nothing to change, or a geo conflict, is refused before any request", async () => {
    const http = createMockHttpClient();
    const ctx = toolContext(http);
    expect((await updateProxyListHandler(ctx)({ proxy_id: "prx_abc", list_id: "list_1" })).isError).toBe(true);
    expect((await updateProxyListHandler(ctx)({ proxy_id: "prx_abc", list_id: "list_1", country: "US", countries: ["US", "CA"] })).isError).toBe(true);
    expect((await updateProxyListHandler(ctx)({ proxy_id: "prx_abc", list_id: "list_1", countries: ["US", "CA"], city: "Austin" })).isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("encodes both ids as single path segments", async () => {
    const http = createMockHttpClient();
    http.expect("PATCH", "/v1/proxies/prx_abc/lists/list_a%2F..%2Fb", { status: 404, headers: new Headers(), body: { success: false, error: { code: "PROXY_LIST_NOT_FOUND", message: "Proxy list not found.", request_id: "r" } } });
    const res = await updateProxyListHandler(toolContext(http))({ proxy_id: "prx_abc", list_id: "list_a/../b", name: "x" });
    expect(res.isError).toBe(true);
  });
});

describe("regenerate_proxy_password - per list", () => {
  it("with list_id rotates that list's login and shows the new credentials", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/proxies/prx_abc/lists/list_1/regenerate_password", listOk(listResp("list_1", {
      credentials: { host: "proxy.voidmob.com", port: 10000, protocol: "http", username: "u", password: "fr3sh" },
      entries: ["u:fr3sh@proxy.voidmob.com:10000"],
    })));
    const res = await regenerateProxyPasswordHandler(toolContext(http))({ proxy_id: "prx_abc", list_id: "list_1" });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(textOf(res)).toContain("fr3sh");
    expect(textOf(res)).toContain("http://u:fr3sh@proxy.voidmob.com:10000");
    expect(res.structuredContent?.list).toMatchObject({ id: "list_1" });
    expect(res.structuredContent).not.toHaveProperty("proxy");
  });
});

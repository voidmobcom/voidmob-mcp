import { describe, it, expect } from "vitest";
import { listOrdersHandler } from "../../src/tools/orders.js";
import { createMockHttpClient } from "../../src/testing/mock-http.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function rentalFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ren_old",
    kind: "rental",
    status: "active",
    phone_number: "+14155550123",
    service_id: "svc_tg",
    service_name: "Telegram",
    duration: "7d",
    charged_price_cents: 500,
    auto_renew: false,
    paid_until: "2026-05-28T00:00:00Z",
    expires_at: "2026-05-28T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    messages: [],
    ...overrides,
  };
}

function esimFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "esim_mid",
    status: "completed",
    plan_title: "Japan 5GB / 7 days",
    countries: ["JP"],
    data_gb_total: 5,
    data_unlimited: false,
    validity_days: 7,
    charged_price_cents: 999,
    activation_code: "LPA:1$smdp.voidmob.com$ABC123",
    iccid: "8901123412345678901",
    is_topup: false,
    parent_order_id: null,
    supports_topup: true,
    expires_at: "2026-05-28T00:00:00Z",
    created_at: "2026-05-10T00:00:00Z",
    ...overrides,
  };
}

function gatewayFixture() {
  return {
    host: "us.proxy.voidmob.com",
    port: 10000,
    protocol: "http",
    username: "vm_abc",
    password: "p4ss",
  };
}

function proxyFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "px_new",
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
    created_at: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

// ── list_orders ─────────────────────────────────────────────────────────────

describe("list_orders", () => {
  it("with no kind filter fans out to all 3 endpoints, merges, sorts desc by created_at", async () => {
    const http = createMockHttpClient();
    // FIFO: handler enqueues sms → esim → proxy in order
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { rentals: [rentalFixture()] } },
    });
    http.expect("GET", "/v1/esims", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esims: [esimFixture()] } },
    });
    http.expect("GET", "/v1/proxies", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { proxies: [proxyFixture()] } },
    });

    const res = await listOrdersHandler(http)({});
    expect(res.isError).toBeFalsy();

    // All three GETs occurred
    expect(http.history.map((h) => h.path)).toEqual([
      "/v1/rentals",
      "/v1/esims",
      "/v1/proxies",
    ]);

    const orders = res.structuredContent?.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(3);
    // Sorted by created_at desc: proxy(2026-05-20) > esim(2026-05-10) > rental(2026-05-01)
    expect(orders[0]).toMatchObject({ kind: "proxy", id: "px_new" });
    expect(orders[1]).toMatchObject({ kind: "esim", id: "esim_mid" });
    expect(orders[2]).toMatchObject({ kind: "sms", id: "ren_old" });

    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("3 order(s)");
    expect(t.text).toContain("SMS");
    expect(t.text).toContain("ESIM");
    expect(t.text).toContain("PROXY");
  });

  it("with kind='sms' only fetches /v1/rentals", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { rentals: [rentalFixture()] } },
    });

    const res = await listOrdersHandler(http)({ kind: "sms" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].path).toBe("/v1/rentals");
    const orders = res.structuredContent?.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ kind: "sms", id: "ren_old" });
  });

  it("surfaces results from successful fan-out branches when one fails, with partial warning", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { rentals: [rentalFixture()] } },
    });
    http.expect("GET", "/v1/esims", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esims: [esimFixture()] } },
    });
    // Proxies endpoint fails — callApi will throw on success:false envelope
    http.expect("GET", "/v1/proxies", {
      status: 500,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Proxy service down.",
          request_id: "req_px_500",
        },
      },
    });

    const res = await listOrdersHandler(http)({});
    expect(res.isError).toBeFalsy();
    const orders = res.structuredContent?.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(2);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("partial:");
  });

  it("with limit=2 truncates output even when more rows exist", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          rentals: [
            rentalFixture({ id: "ren_1", created_at: "2026-05-01T00:00:00Z" }),
            rentalFixture({ id: "ren_2", created_at: "2026-05-02T00:00:00Z" }),
            rentalFixture({ id: "ren_3", created_at: "2026-05-03T00:00:00Z" }),
            rentalFixture({ id: "ren_4", created_at: "2026-05-04T00:00:00Z" }),
          ],
        },
      },
    });

    const res = await listOrdersHandler(http)({ kind: "sms", limit: 2 });
    expect(res.isError).toBeFalsy();
    const orders = res.structuredContent?.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(2);
    // Newest first
    expect(orders[0]).toMatchObject({ id: "ren_4" });
    expect(orders[1]).toMatchObject({ id: "ren_3" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("4 order(s)");
    expect(t.text).toContain("(showing 2)");
  });

  it("returns toolError 'No orders found.' when all 3 fan-out branches fail", async () => {
    const http = createMockHttpClient();
    const fail = {
      status: 500,
      headers: new Headers(),
      body: {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "boom", request_id: "req_x" },
      },
    };
    http.expect("GET", "/v1/rentals", fail);
    http.expect("GET", "/v1/esims", fail);
    http.expect("GET", "/v1/proxies", fail);

    const res = await listOrdersHandler(http)({});
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("No orders found.");
  });
});

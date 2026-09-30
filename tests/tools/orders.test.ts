import { describe, it, expect } from "vitest";
import { listOrdersHandler } from "../../src/tools/orders.js";
import { createMockHttpClient } from "../mock-http.js";
import { dedNumberFixture } from "../fixtures/dedicated.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function rentalFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ren_old",
    display_id: "LTR123",
    status: "active",
    phone_number: "+14155550123",
    service_id: "svc_tg",
    service_name: "Telegram",
    country: "us",
    duration: "7D",
    rental_type: "rental",
    charged_price_cents: 500,
    auto_renew: false,
    next_renewal_price_cents: 500,
    re_rent_available: false,
    re_rent_price_cents: null,
    re_rent_blocked_at: null,
    created_at: "2026-05-01T00:00:00Z",
    paid_until: "2026-05-28T00:00:00Z",
    expires_at: "2026-05-28T00:00:00Z",
    can_cancel: false,
    cancel_window_expires_at: null,
    messages: [],
    ...overrides,
  };
}

function esimFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "esim_mid",
    status: "completed",
    product_id: "prod_jp7d",
    is_topup: false,
    parent_order_id: null,
    iccid: "8901123412345678901",
    activation_code: "LPA:1$smdp.voidmob.com$ABC123",
    qr_code_url: "https://dashboard.voidmob.com/api/v1/esims/esim_mid/qr.png",
    smdp_address: "smdp.voidmob.com",
    data_limit_gb: 5,
    data_unlimited: false,
    validity_days: 7,
    countries: ["JP"],
    routing_location: "JP",
    charged_price_cents: 999,
    currency: "USD",
    created_at: "2026-05-10T00:00:00Z",
    completed_at: "2026-05-10T00:00:00Z",
    expires_at: "2026-05-28T00:00:00Z",
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
    data_gb_total: 5,
    data_bytes_used: 0,
    charged_price_cents: 1499,
    expires_at: "2026-06-20T00:00:00Z",
    gateway: gatewayFixture(),
    lists: [],
    rotation_url: null,
    created_at: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

function verificationFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ver_recent",
    display_id: "SMS1UW0YT",
    status: "waiting_for_code",
    phone_number: "+12085976486",
    service_id: "svc_google",
    service_name: "Google",
    charged_price_cents: 105,
    expires_at: "2026-05-18T00:15:00Z",
    can_cancel: true,
    created_at: "2026-05-18T00:00:00Z",
    reuse_counter: 0,
    allow_reuse: false,
    allow_paid_reuse: false,
    paid_reuse_price_cents: 50,
    ...overrides,
  };
}

const noVerifications = { status: 200, headers: new Headers(), body: { success: true, data: [] as unknown[] } };

// ── list_orders ─────────────────────────────────────────────────────────────

describe("list_orders", () => {
  it("with no kind filter fans out to all 5 endpoints, merges, sorts desc by created_at", async () => {
    const http = createMockHttpClient();
    // FIFO: handler enqueues rentals → verifications → esim → proxy → dedicated in order
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: [rentalFixture()] },
    });
    http.expect("GET", "/v1/verifications", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: [verificationFixture()] },
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
    http.expect("GET", "/v1/dedicated/numbers?limit=100", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: [dedNumberFixture({ id: "ded_mid", created_at: "2026-05-15T00:00:00Z" })] },
    });

    const res = await listOrdersHandler(http)({});
    expect(res.isError).toBeFalsy();

    // All five GETs occurred
    expect(http.history.map((h) => h.path)).toEqual([
      "/v1/rentals",
      "/v1/verifications",
      "/v1/esims",
      "/v1/proxies",
      "/v1/dedicated/numbers?limit=100",
    ]);

    const orders = res.structuredContent?.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(5);
    // Sorted by created_at desc: proxy(05-20) > verification(05-18) > dedicated(05-15) > esim(05-10) > rental(05-01)
    expect(orders[0]).toMatchObject({ kind: "proxy", id: "px_new" });
    expect(orders[1]).toMatchObject({ kind: "sms", id: "ver_recent" });
    expect(orders[2]).toMatchObject({ kind: "dedicated", id: "ded_mid" });
    expect(orders[3]).toMatchObject({ kind: "esim", id: "esim_mid" });
    expect(orders[4]).toMatchObject({ kind: "sms", id: "ren_old" });

    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("5 order(s)");
    expect(t.text).toContain("Google +12085976486 verification");
    expect(t.text).toContain("SMS");
    expect(t.text).toContain("ESIM");
    expect(t.text).toContain("PROXY");
    expect(t.text).toContain("DEDICATED");
  });

  it("with kind='sms' fetches rentals and verifications only", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: [rentalFixture()] },
    });
    http.expect("GET", "/v1/verifications", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: [verificationFixture()] },
    });

    const res = await listOrdersHandler(http)({ kind: "sms" });
    expect(res.isError).toBeFalsy();
    expect(http.history.map((h) => h.path)).toEqual(["/v1/rentals", "/v1/verifications"]);
    const orders = res.structuredContent?.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ kind: "sms", id: "ver_recent" });
    expect(orders[1]).toMatchObject({ kind: "sms", id: "ren_old" });
  });

  it("surfaces results from successful fan-out branches when one fails, with partial warning", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: [rentalFixture()] },
    });
    http.expect("GET", "/v1/verifications", noVerifications);
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
        data: [
          rentalFixture({ id: "ren_1", created_at: "2026-05-01T00:00:00Z" }),
          rentalFixture({ id: "ren_2", created_at: "2026-05-02T00:00:00Z" }),
          rentalFixture({ id: "ren_3", created_at: "2026-05-03T00:00:00Z" }),
          rentalFixture({ id: "ren_4", created_at: "2026-05-04T00:00:00Z" }),
        ],
      },
    });

    http.expect("GET", "/v1/verifications", noVerifications);

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

  it("surfaces partial-failure warnings (not a misleading 'No orders found.') when all 3 branches fail", async () => {
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
    http.expect("GET", "/v1/verifications", fail);
    http.expect("GET", "/v1/esims", fail);
    http.expect("GET", "/v1/proxies", fail);

    const res = await listOrdersHandler(http)({});
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    // When every fan-out call fails, the empty result is a hidden error, not an
    // empty account: surface the partial failures instead of "No orders found."
    expect(t.text).toContain("Could not load orders");
    expect(t.text).toContain("partial:");
    expect(t.text).not.toContain("No orders found.");
  });

  it("returns 'No orders found.' as a normal (non-error) result when the account is genuinely empty", async () => {
    const http = createMockHttpClient();
    const empty = { status: 200, headers: new Headers(), body: { success: true, data: [] as unknown[] } };
    http.expect("GET", "/v1/rentals", empty);
    http.expect("GET", "/v1/verifications", empty);
    http.expect("GET", "/v1/esims", { status: 200, headers: new Headers(), body: { success: true, data: { esims: [] } } });
    http.expect("GET", "/v1/proxies", { status: 200, headers: new Headers(), body: { success: true, data: { proxies: [] } } });
    http.expect("GET", "/v1/dedicated/numbers?limit=100", empty);

    const res = await listOrdersHandler(http)({});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.orders).toEqual([]);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("No orders found.");
  });

  it("kind=dedicated fetches /v1/dedicated/numbers and renders rows", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/numbers?limit=100", {
      status: 200, headers: new Headers(),
      body: { success: true, data: [dedNumberFixture()] },
    });
    const res = await listOrdersHandler(http)({ kind: "dedicated" });
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("ded_abc123");
    expect(t.text).toContain("DEDICATED");
    expect(res.structuredContent?.orders).toHaveLength(1);
  });
});

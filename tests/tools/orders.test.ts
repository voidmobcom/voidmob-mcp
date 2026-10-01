import { describe, it, expect } from "vitest";
import { listOrdersHandler } from "../../src/tools/orders.js";
import { createMockHttpClient } from "../mock-http.js";
import { dedNumberFixture } from "../fixtures/dedicated.js";
import { toolContext } from "../../src/tools/context.js";

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

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, headers: new Headers(), body: { success: true, data, ...extra } });
const fail = (status: number, code: string) => ({ status, headers: new Headers(), body: { success: false, error: { code, message: code, request_id: "req_x" } } });
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? "";

// ── list_orders ─────────────────────────────────────────────────────────────

describe("list_orders overview (no kind)", () => {
  it("reads up to 100 of every list, shows the newest per kind, and flags lists with more", async () => {
    const http = createMockHttpClient();
    // Requests go out in kind order: verification, rental, dedicated, esim, proxy.
    http.expect("GET", "/v1/verifications?limit=100", ok([verificationFixture()], { has_more: true, next_cursor: "vcur" }));
    // Lists other than verifications come back in id order, not by date.
    http.expect("GET", "/v1/rentals?limit=100", ok(
      [rentalFixture({ id: "ren_a", created_at: "2026-05-01T00:00:00Z" }), rentalFixture({ id: "ren_b", created_at: "2026-05-09T00:00:00Z" }), rentalFixture({ id: "ren_c", created_at: "2026-05-05T00:00:00Z" })],
      { has_more: false, next_cursor: null },
    ));
    http.expect("GET", "/v1/dedicated/numbers?limit=100", ok([dedNumberFixture()], { has_more: false, next_cursor: null }));
    http.expect("GET", "/v1/esims?limit=100", ok({ esims: [esimFixture()], next_cursor: "ecur" }));
    http.expect("GET", "/v1/proxies?limit=100", ok({ proxies: [proxyFixture()], next_cursor: null }));
    const res = await listOrdersHandler(toolContext(http))({ limit: 2 });
    expect(res.isError).toBeFalsy();
    const orders = res.structuredContent?.orders as Array<{ id: string; kind: string }>;
    // The newest 2 rentals, whatever order the API returned them in.
    expect(orders.filter((o) => o.kind === "rental").map((o) => o.id)).toEqual(["ren_b", "ren_c"]);
    expect(orders.map((o) => o.kind)).toEqual(["verification", "rental", "rental", "dedicated", "esim", "proxy"]);
    expect(res.structuredContent?.incomplete_kinds).toEqual(["verification", "esim"]);
    expect(text(res)).toContain("there are more, so newer ones may be missing - page through with kind='esim'");
    // No first-page count is presented as a total.
    expect(text(res)).not.toMatch(/^\d+ order\(s\)/);
  });

  it("kind='sms' reads verifications and rentals only", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications?limit=100", ok([verificationFixture()], { next_cursor: null }));
    http.expect("GET", "/v1/rentals?limit=100", ok([rentalFixture()], { next_cursor: null }));
    const res = await listOrdersHandler(toolContext(http))({ kind: "sms" });
    expect(http.history.map((h) => h.path)).toEqual(["/v1/verifications?limit=100", "/v1/rentals?limit=100"]);
    expect((res.structuredContent?.orders as unknown[]).length).toBe(2);
  });

  it("a failed list is reported as partial, the others still show", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications?limit=100", ok([verificationFixture()], { next_cursor: null }));
    http.expect("GET", "/v1/rentals?limit=100", fail(500, "INTERNAL_ERROR"));
    const res = await listOrdersHandler(toolContext(http))({ kind: "sms" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.partial).toEqual([expect.stringContaining("rental: could not be read")]);
    expect(text(res)).toContain("(partial) rental");
  });

  it("every list failing is an error, not a misleading 'No orders found.'", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications?limit=100", fail(500, "INTERNAL_ERROR"));
    http.expect("GET", "/v1/rentals?limit=100", fail(500, "INTERNAL_ERROR"));
    const res = await listOrdersHandler(toolContext(http))({ kind: "sms" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Could not load orders");
  });

  it("an empty account is a normal empty result", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications?limit=100", ok([], { next_cursor: null }));
    http.expect("GET", "/v1/rentals?limit=100", ok([], { next_cursor: null }));
    http.expect("GET", "/v1/dedicated/numbers?limit=100", ok([], { next_cursor: null }));
    http.expect("GET", "/v1/esims?limit=100", ok({ esims: [], next_cursor: null }));
    http.expect("GET", "/v1/proxies?limit=100", ok({ proxies: [], next_cursor: null }));
    const res = await listOrdersHandler(toolContext(http))({});
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe("No orders found.");
    expect(res.structuredContent?.orders).toEqual([]);
  });

  it("status or cursor without kind is refused before any request", async () => {
    const http = createMockHttpClient();
    expect((await listOrdersHandler(toolContext(http))({ status: "active" })).isError).toBe(true);
    expect((await listOrdersHandler(toolContext(http))({ kind: "sms", cursor: "abc" })).isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });
});

describe("list_orders with kind (one paginated list)", () => {
  it("verification: passes limit, status and cursor through and returns next_cursor", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications?limit=2&status=waiting_for_code&cursor=abc", ok(
      [verificationFixture({ id: "ver_a", created_at: "2026-05-18T00:00:00Z" }), verificationFixture({ id: "ver_b", created_at: "2026-05-18T00:05:00Z" })],
      { has_more: true, next_cursor: "def" },
    ));
    const res = await listOrdersHandler(toolContext(http))({ kind: "verification", status: "waiting_for_code", cursor: "abc", limit: 2 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.next_cursor).toBe("def");
    // Sorted newest first within the page.
    expect((res.structuredContent?.orders as Array<{ id: string }>).map((o) => o.id)).toEqual(["ver_b", "ver_a"]);
    expect(text(res)).toContain("cursor='def'");
    expect(text(res)).toContain("status='waiting_for_code'");
  });

  it("last page says so and returns next_cursor null", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals?limit=20", ok([rentalFixture()], { has_more: false, next_cursor: null }));
    const res = await listOrdersHandler(toolContext(http))({ kind: "rental" });
    expect(res.structuredContent?.next_cursor).toBeNull();
    expect(text(res)).toContain("This is the last page.");
    expect(text(res)).toContain("not in date order");
  });

  it("dedicated, esim and proxy read their own list endpoints and cursor shapes", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/numbers?limit=20&status=active", ok([dedNumberFixture()], { next_cursor: "d2" }));
    http.expect("GET", "/v1/esims?limit=20&status=processing", ok({ esims: [esimFixture({ status: "processing" })], next_cursor: "e2" }));
    http.expect("GET", "/v1/proxies?limit=20&status=provisioning", ok({ proxies: [proxyFixture({ status: "provisioning" })], next_cursor: null }));
    const ctx = toolContext(http);
    expect((await listOrdersHandler(ctx)({ kind: "dedicated", status: "active" })).structuredContent?.next_cursor).toBe("d2");
    expect((await listOrdersHandler(ctx)({ kind: "esim", status: "processing" })).structuredContent?.next_cursor).toBe("e2");
    const proxies = await listOrdersHandler(ctx)({ kind: "proxy", status: "provisioning" });
    expect(proxies.structuredContent?.next_cursor).toBeNull();
    expect(proxies.structuredContent?.orders).toEqual([expect.objectContaining({ kind: "proxy", id: "px_new", status: "provisioning" })]);
  });

  it("a status that the kind does not have is refused with the valid ones", async () => {
    const http = createMockHttpClient();
    const res = await listOrdersHandler(toolContext(http))({ kind: "dedicated", status: "cancelled" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("active, expired");
    expect(http.history).toHaveLength(0);
  });

  it("an empty filtered page is a normal result", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications?limit=20&status=code_received", ok([], { has_more: false, next_cursor: null }));
    const res = await listOrdersHandler(toolContext(http))({ kind: "verification", status: "code_received" });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe("No verification orders with status code_received.");
  });
});

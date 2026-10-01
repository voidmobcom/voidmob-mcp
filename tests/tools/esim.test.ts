import { describe, it, expect } from "vitest";
import {
  searchEsimPlansHandler,
  purchaseEsimHandler,
  getEsimStatusHandler,
  topupEsimHandler,
  getEsimQrHandler,
} from "../../src/tools/esim.js";
import { createMockHttpClient } from "../mock-http.js";
import { toolContext } from "../../src/tools/context.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function productFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "esim_product_jp7d",
    title: "Japan 5GB / 7 days",
    countries: ["JP"],
    region: "Asia",
    country_count: 1,
    routing_location: "JP",
    data_limit_gb: 5,
    data_unlimited: false,
    validity_days: 7,
    features: {
      has_5g: true,
      has_hotspot: true,
      has_calls: false,
      has_sms: false,
      supports_topup: true,
    },
    price_cents: 999,
    currency: "USD",
    ...overrides,
  };
}

function esimFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "esim_abc",
    status: "completed",
    product_id: "esim_product_jp7d",
    is_topup: false,
    parent_order_id: null,
    iccid: "8901123412345678901",
    activation_code: "LPA:1$smdp.voidmob.com$ABC123",
    qr_code_url: "https://dashboard.voidmob.com/api/v1/esims/esim_abc/qr.png",
    smdp_address: "smdp.voidmob.com",
    data_limit_gb: 5,
    data_unlimited: false,
    validity_days: 7,
    countries: ["JP"],
    routing_location: "JP",
    charged_price_cents: 999,
    currency: "USD",
    created_at: "2026-05-21T00:00:00Z",
    completed_at: "2026-05-21T00:00:00Z",
    expires_at: "2026-05-28T00:00:00Z",
    ...overrides,
  };
}

function usageFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    esim_id: "esim_abc",
    esim_status: "completed",
    packages: [
      {
        name: "Plan A",
        total_mb: 5120,
        total_gb: 5,
        used_mb: 250,
        used_gb: 0.24,
        remaining_mb: 4870,
        remaining_gb: 4.8,
        percent_used: 4.9,
        activation_date: "2026-05-21T00:00:00Z",
        expiration_date: "2026-05-28T00:00:00Z",
      },
    ],
    ...overrides,
  };
}

// ── search_esim_plans ───────────────────────────────────────────────────────

describe("search_esim_plans", () => {
  it("composes query string with all filters (country as the API's countries filter) and renders a list", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products?countries=JP&min_data_gb=5&has_5g=true&limit=20", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          products: [productFixture()],
          next_cursor: null,
        },
      },
    });
    const res = await searchEsimPlansHandler(toolContext(http))({
      country: "JP",
      min_data_gb: 5,
      has_5g: true,
    });
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Japan 5GB / 7 days");
    expect(t.text).toContain("JP");
    expect(t.text).toContain("$9.99");
    const plans = res.structuredContent?.esim_plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    // Full plan shape returned — no separate get_esim_plan_details tool needed
    expect(plans[0]).toMatchObject({
      region: "Asia",
      country_count: 1,
      routing_location: "JP",
      data_limit_gb: 5,
      features: { has_5g: true, has_hotspot: true, supports_topup: true },
    });
  });

  it("no matching plans is a normal empty result with a hint, not an error", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products?countries=XX&limit=20", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { products: [], next_cursor: null } },
    });
    const res = await searchEsimPlansHandler(toolContext(http))({ country: "xx" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.esim_plans).toEqual([]);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("No eSIM plans matched");
  });

  it("surfaces upstream error with request_id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products?limit=20", {
      status: 500,
      headers: new Headers(),
      body: {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "boom", request_id: "req_esim_err", docs_url: "" },
      },
    });
    const res = await searchEsimPlansHandler(toolContext(http))({});
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_esim_err");
  });
});

// ── purchase_esim ───────────────────────────────────────────────────────────

describe("purchase_esim", () => {
  it("commits with the caller's max_price_cents and idempotency, no internal quote; counts the charge", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/esims", {
      status: 201,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture() } },
    });
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await purchaseEsimHandler(ctx)({ plan_id: "esim_product_jp7d", max_price_cents: 1099 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].body).toEqual({ product_id: "esim_product_jp7d", max_price_cents: 1099 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_abc" });
    expect(ctx.guard.countedCents).toBe(esimFixture().charged_price_cents);
  });

  it("purchase output carries the LPA string, or says to poll while processing", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/esims", {
      status: 201,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture({ activation_code: "K2-AAAAAA-BBBBBB", smdp_address: "smdp.example.com" }) } },
    });
    const done = await purchaseEsimHandler(toolContext(http))({ plan_id: "esim_product_jp7d", max_price_cents: 999 });
    const t1 = done.content[0];
    if (t1.type !== "text") throw new Error("text");
    expect(t1.text).toContain("LPA:1$smdp.example.com$K2-AAAAAA-BBBBBB");

    http.expect("POST", "/v1/esims", {
      status: 202,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture({ status: "processing", activation_code: null, smdp_address: null, iccid: null, qr_code_url: null }) } },
    });
    const pending = await purchaseEsimHandler(toolContext(http))({ plan_id: "esim_product_jp7d", max_price_cents: 999 });
    const t2 = pending.content[0];
    if (t2.type !== "text") throw new Error("text");
    expect(t2.text).toContain("poll get_esim_status");
  });

  it("PRICE_OVER_CAP returns the new price to re-confirm, with request_id; nothing counted", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/esims", {
      status: 409,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "PRICE_OVER_CAP",
          message: "...",
          request_id: "req_esim_cap",
          details: { available_price_cents: 1099 },
          docs_url: "",
        },
      },
    });
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await purchaseEsimHandler(ctx)({ plan_id: "esim_product_jp7d", max_price_cents: 999 });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$10.99");
    expect(t.text).toContain("max_price_cents=1099");
    expect(t.text).toContain("req_esim_cap");
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("a network failure after sending counts the full max price against the session budget", async () => {
    const { NetworkError } = await import("../../src/client/http.js");
    const ctx = toolContext({ request: () => Promise.reject(new NetworkError(new Error("reset"), "POST")) }, { budgetCents: 5000 });
    const res = await purchaseEsimHandler(ctx)({ plan_id: "esim_product_jp7d", max_price_cents: 1200 });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("may or may not have gone through");
    expect(ctx.guard.countedCents).toBe(1200);
  });
});

// ── get_esim_status ─────────────────────────────────────────────────────────

describe("get_esim_status", () => {
  it("fetches core + usage in parallel and merges into structuredContent", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture() } },
    });
    http.expect("GET", "/v1/esims/esim_abc/usage", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { usage: usageFixture() } },
    });
    const res = await getEsimStatusHandler(toolContext(http))({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_abc" });
    expect(res.structuredContent?.usage).toMatchObject({
      esim_id: "esim_abc",
      esim_status: "completed",
    });
    expect((res.structuredContent?.usage as { packages: unknown[] }).packages).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("250 MB");
    expect(t.text).toContain("5120 MB");
  });

  it("renders every package on the eSIM plus an eSIM-level total - never just packages[0]", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture() } },
    });
    const base = usageFixture().packages[0];
    http.expect("GET", "/v1/esims/esim_abc/usage", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          usage: usageFixture({
            packages: [
              { ...base, used_mb: 5120, remaining_mb: 0, percent_used: 100 },
              { ...base, name: "Top-up", total_mb: 3072, used_mb: 1024, remaining_mb: 2048, percent_used: 33.3, activation_date: "2026-05-25T00:00:00Z", expiration_date: "2026-06-01T00:00:00Z" },
            ],
          }),
        },
      },
    });
    const res = await getEsimStatusHandler(toolContext(http))({ esim_id: "esim_abc" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Usage (2 packages)");
    expect(t.text).toContain("Package 1: 5120 MB / 5120 MB used (100%), 0 MB left");
    expect(t.text).toContain("Package 2: 1024 MB / 3072 MB used (33.3%), 2048 MB left, 2026-05-25 to 2026-06-01");
    expect(t.text).toContain("Total:     6144 MB / 8192 MB used, 2048 MB left");
    // Carrier-supplied package names stay out of the text.
    expect(t.text).not.toContain("Plan A");
  });

  it("prints the LPA string built from smdp_address + activation_code", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture({ activation_code: "K2-2VOZBJ-22QT3D", smdp_address: "smdp.example.com" }) } },
    });
    http.expect("GET", "/v1/esims/esim_abc/usage", { status: 200, headers: new Headers(), body: { success: true, data: { usage: usageFixture() } } });
    const res = await getEsimStatusHandler(toolContext(http))({ esim_id: "esim_abc" });
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("LPA string:     LPA:1$smdp.example.com$K2-2VOZBJ-22QT3D");
    expect(t.text).toContain("SM-DP+ address: smdp.example.com");
    expect(t.text).toContain("Activation code: K2-2VOZBJ-22QT3D");
  });

  it("USAGE_UNAVAILABLE: degrades gracefully with usage=null", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture() } },
    });
    http.expect("GET", "/v1/esims/esim_abc/usage", {
      status: 503,
      headers: new Headers(),
      body: {
        success: false,
        error: { code: "USAGE_UNAVAILABLE", message: "...", request_id: "req_u", docs_url: "" },
      },
    });
    const res = await getEsimStatusHandler(toolContext(http))({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_abc" });
    expect(res.structuredContent?.usage).toBeNull();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("not yet available");
  });
});

// ── topup_esim ──────────────────────────────────────────────────────────────

describe("topup_esim", () => {
  it("browse: no topup_product_id → GET /v1/esims/:id/topups, renders list", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc/topups", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          supports_topup: true,
          topups: [
            productFixture({ id: "esim_topup_jp_3gb", title: "Japan +3GB", price_cents: 599, data_limit_gb: 3 }),
            productFixture({ id: "esim_topup_jp_10gb", title: "Japan +10GB", price_cents: 1499, data_limit_gb: 10 }),
          ],
        },
      },
    });
    const res = await topupEsimHandler(toolContext(http))({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Japan +3GB");
    expect(t.text).toContain("Japan +10GB");
    expect((res.structuredContent?.topups as unknown[])).toHaveLength(2);
  });

  it("browse: supports_topup=false → normal empty result", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc/topups", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { supports_topup: false, topups: [] } },
    });
    const res = await topupEsimHandler(toolContext(http))({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.topups).toEqual([]);
  });

  it("purchase: topup_product_id + max_price_cents → POST /v1/esims/:id/topups, no internal quote", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/esims/esim_abc/topups", {
      status: 201,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          esim: esimFixture({
            id: "esim_topup_xyz",
            product_id: "esim_topup_jp_3gb",
            data_limit_gb: null,
            validity_days: 7,
            charged_price_cents: 599,
            is_topup: true,
            parent_order_id: "esim_abc",
            iccid: null,
            activation_code: null,
            qr_code_url: null,
            smdp_address: null,
          }),
        },
      },
    });
    const res = await topupEsimHandler(toolContext(http))({
      esim_id: "esim_abc",
      topup_product_id: "esim_topup_jp_3gb",
      max_price_cents: 599,
    });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].path).toBe("/v1/esims/esim_abc/topups");
    expect(http.history[0].body).toEqual({ product_id: "esim_topup_jp_3gb", max_price_cents: 599 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_topup_xyz", is_topup: true });
  });

  it("purchase without max_price_cents is refused before any request", async () => {
    const http = createMockHttpClient();
    const res = await topupEsimHandler(toolContext(http))({ esim_id: "esim_abc", topup_product_id: "esim_topup_jp_3gb" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });
});

// ── get_esim_qr ─────────────────────────────────────────────────────────────

describe("get_esim_qr", () => {
  it("returns content with both text + image blocks; structuredContent has esim_id", async () => {
    const http = createMockHttpClient();
    // Minimal PNG magic bytes
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    http.expect("GET", "/v1/esims/esim_abc/qr.png", {
      status: 200,
      headers: new Headers(),
      binary: png,
    });
    const res = await getEsimQrHandler(toolContext(http))({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe("text");
    const img = res.content[1];
    if (img.type !== "image") throw new Error("expected image block");
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toBe(png.toString("base64"));
    expect(res.structuredContent?.esim_id).toBe("esim_abc");
  });

  it("returns toolError when server returns no binary payload", async () => {
    const http = createMockHttpClient();
    // Edge case: 2xx with neither binary nor a parseable body (server bug)
    http.expect("GET", "/v1/esims/esim_abc/qr.png", {
      status: 200,
      headers: new Headers(),
    });
    const res = await getEsimQrHandler(toolContext(http))({ esim_id: "esim_abc" });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toMatch(/no binary payload/i);
  });
});

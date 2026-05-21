import { describe, it, expect } from "vitest";
import {
  searchEsimPlansHandler,
  purchaseEsimHandler,
  getEsimStatusHandler,
  topupEsimHandler,
  getEsimQrHandler,
} from "../../src/tools/esim.js";
import { createMockHttpClient } from "../../src/testing/mock-http.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function productFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "esim_product_jp7d",
    title: "Japan 5GB / 7 days",
    countries: ["JP"],
    data_gb: 5,
    data_unlimited: false,
    validity_days: 7,
    retail_price_cents: 999,
    has_5g: true,
    has_hotspot: true,
    supports_topup: true,
    network_type: "LTE/5G",
    speed: "fast",
    activation_policy: "first_use",
    tags: ["asia", "popular"],
    ...overrides,
  };
}

function esimFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "esim_abc",
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
    created_at: "2026-05-21T00:00:00Z",
    ...overrides,
  };
}

function usageFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    esim_id: "esim_abc",
    esim_status: "active",
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
  it("composes query string with all filters and renders a list", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products?country=JP&min_data_gb=5&has_5g=true&limit=20", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          esim_products: [productFixture()],
          next_cursor: null,
        },
      },
    });
    const res = await searchEsimPlansHandler(http)({
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
      network_type: "LTE/5G",
      speed: "fast",
      activation_policy: "first_use",
      supports_topup: true,
      tags: ["asia", "popular"],
    });
  });

  it("returns toolError when no plans match", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products?country=XX&limit=20", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { esim_products: [], next_cursor: null } },
    });
    const res = await searchEsimPlansHandler(http)({ country: "XX" });
    expect(res.isError).toBe(true);
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
    const res = await searchEsimPlansHandler(http)({});
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_esim_err");
  });
});

// ── purchase_esim ───────────────────────────────────────────────────────────

describe("purchase_esim", () => {
  it("quote-then-commit: GET product, POST /v1/esims with tied max_price_cents and idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products/esim_product_jp7d", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { product: productFixture() } },
    });
    http.expect("POST", "/v1/esims", {
      status: 201,
      headers: new Headers(),
      body: { success: true, data: { esim: esimFixture() } },
    });
    const res = await purchaseEsimHandler(http)({ plan_id: "esim_product_jp7d" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(http.history[1].method).toBe("POST");
    expect(http.history[1].body).toMatchObject({
      product_id: "esim_product_jp7d",
      max_price_cents: 999,
    });
    expect(http.history[1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_abc" });
  });

  it("maps PRICE_OVER_CAP from commit step with request_id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products/esim_product_jp7d", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { product: productFixture() } },
    });
    http.expect("POST", "/v1/esims", {
      status: 409,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "PRICE_OVER_CAP",
          message: "...",
          request_id: "req_esim_cap",
          details: { max_price_cents: 999, available_price_cents: 1099 },
          docs_url: "",
        },
      },
    });
    const res = await purchaseEsimHandler(http)({ plan_id: "esim_product_jp7d" });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$9.99");
    expect(t.text).toContain("$10.99");
    expect(t.text).toContain("req_esim_cap");
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
    const res = await getEsimStatusHandler(http)({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_abc" });
    expect(res.structuredContent?.usage).toMatchObject({
      esim_id: "esim_abc",
      esim_status: "active",
    });
    expect((res.structuredContent?.usage as { packages: unknown[] }).packages).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("250 MB");
    expect(t.text).toContain("5120 MB");
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
    const res = await getEsimStatusHandler(http)({ esim_id: "esim_abc" });
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
            productFixture({ id: "esim_topup_jp_3gb", title: "Japan +3GB", retail_price_cents: 599, data_gb: 3 }),
            productFixture({ id: "esim_topup_jp_10gb", title: "Japan +10GB", retail_price_cents: 1499, data_gb: 10 }),
          ],
        },
      },
    });
    const res = await topupEsimHandler(http)({ esim_id: "esim_abc" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Japan +3GB");
    expect(t.text).toContain("Japan +10GB");
    expect((res.structuredContent?.topups as unknown[])).toHaveLength(2);
  });

  it("browse: supports_topup=false → toolError", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esims/esim_abc/topups", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { supports_topup: false, topups: [] } },
    });
    const res = await topupEsimHandler(http)({ esim_id: "esim_abc" });
    expect(res.isError).toBe(true);
  });

  it("purchase: topup_product_id supplied → quote then POST /v1/esims/:id/topups", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/esim_products/esim_topup_jp_3gb", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { product: productFixture({ id: "esim_topup_jp_3gb", title: "Japan +3GB", retail_price_cents: 599, data_gb: 3 }) },
      },
    });
    http.expect("POST", "/v1/esims/esim_abc/topups", {
      status: 201,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          esim: esimFixture({
            id: "esim_topup_xyz",
            plan_title: "Japan +3GB",
            data_gb_total: 3,
            charged_price_cents: 599,
            is_topup: true,
            parent_order_id: "esim_abc",
          }),
        },
      },
    });
    const res = await topupEsimHandler(http)({
      esim_id: "esim_abc",
      topup_product_id: "esim_topup_jp_3gb",
    });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(http.history[1].method).toBe("POST");
    expect(http.history[1].path).toBe("/v1/esims/esim_abc/topups");
    expect(http.history[1].body).toMatchObject({
      product_id: "esim_topup_jp_3gb",
      max_price_cents: 599,
    });
    expect(http.history[1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.esim).toMatchObject({ id: "esim_topup_xyz", is_topup: true });
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
    const res = await getEsimQrHandler(http)({ esim_id: "esim_abc" });
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
    const res = await getEsimQrHandler(http)({ esim_id: "esim_abc" });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toMatch(/no binary payload/i);
  });
});

import { describe, it, expect } from "vitest";
import {
  searchSmsServicesHandler,
  getRentalHandler,
  rentNumberHandler,
  cancelRentalHandler,
  reuseNumberHandler,
  reRentRentalHandler,
  toggleAutoRenewHandler,
} from "../../src/tools/sms.js";
import { createMockHttpClient } from "../mock-http.js";
import { dedNumberFixture } from "./dedicated.test.js";

describe("search_sms_services", () => {
  it("calls GET /v1/services and renders a table", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          services: [
            { id: "svc_tg", name: "Telegram", quoted_price_cents: 35 },
            { id: "svc_wa", name: "WhatsApp", quoted_price_cents: 42 },
          ],
        },
      },
    });
    const handler = searchSmsServicesHandler(http);
    const res = await handler({});
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Telegram");
    expect(t.text).toContain("$0.35");
    expect(res.structuredContent?.services).toHaveLength(2);
  });

  it("filters by query substring on service name", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: {
          services: [
            { id: "svc_tg", name: "Telegram", quoted_price_cents: 35 },
            { id: "svc_wa", name: "WhatsApp", quoted_price_cents: 42 },
          ],
        },
      },
    });
    const handler = searchSmsServicesHandler(http);
    const res = await handler({ query: "tele" });
    expect(res.structuredContent?.services).toHaveLength(1);
  });
});

describe("get_rental", () => {
  function verFixture() {
    return {
      id: "ver_abc",
      status: "waiting_for_code",
      phone_number: "+14155550123",
      service_id: "svc_tg",
      service_name: "Telegram",
      charged_price_cents: 35,
      expires_at: "2026-05-21T19:00:00Z",
      can_cancel: true,
      created_at: "2026-05-21T18:40:00Z",
      reuse_counter: 0,
      allow_reuse: false,
      allow_paid_reuse: false,
      paid_reuse_price_cents: 50,
      messages: [],
    };
  }
  function rntFixture() {
    return {
      id: "ren_xyz",
      display_id: "LTR456",
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
      created_at: "2026-05-21T00:00:00Z",
      paid_until: "2026-05-28T00:00:00Z",
      expires_at: "2026-05-28T00:00:00Z",
      can_cancel: true,
      cancel_window_expires_at: "2026-05-21T01:00:00Z",
      messages: [],
    };
  }

  it("routes ver_ ID to /v1/verifications/:id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { verification: verFixture() } },
    });
    const res = await getRentalHandler(http)({ rental_id: "ver_abc" });
    expect(res.structuredContent?.verification).toMatchObject({ id: "ver_abc" });
  });

  it("routes ren_ ID to /v1/rentals/:id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/ren_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: rntFixture() },
    });
    const res = await getRentalHandler(http)({ rental_id: "ren_xyz" });
    expect(res.structuredContent?.rental).toMatchObject({ id: "ren_xyz" });
  });

  it("rejects bad ID prefix without an HTTP call", async () => {
    const http = createMockHttpClient();
    const res = await getRentalHandler(http)({ rental_id: "bad_id" });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toMatch(/ver_|ren_/);
    expect(http.history).toHaveLength(0); // no HTTP call made
  });

  it("maps VERIFICATION_NOT_FOUND error with request_id end-to-end", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_missing", {
      status: 404,
      headers: new Headers(),
      body: {
        success: false,
        error: { code: "VERIFICATION_NOT_FOUND", message: "Verification not found.", request_id: "req_xyz", docs_url: "" },
      },
    });
    const res = await getRentalHandler(http)({ rental_id: "ver_missing" });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_xyz"); // request_id flowed end-to-end
  });
});

describe("rent_number (verification path)", () => {
  it("quotes via /v1/services then commits with strict-tie max_price_cents + idempotency key", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { services: [{ id: "svc_tg", name: "Telegram", quoted_price_cents: 35 }] } },
    });
    http.expect("POST", "/v1/verifications", {
      status: 201, headers: new Headers(),
      body: {
        success: true,
        data: {
          verification: {
            id: "ver_new", status: "waiting_for_code", phone_number: "+14155550123",
            service_id: "svc_tg", service_name: "Telegram", charged_price_cents: 35,
            expires_at: "2026-05-21T19:00:00Z", can_cancel: true,
            created_at: "2026-05-21T18:40:00Z", reuse_counter: 0,
            allow_reuse: false, allow_paid_reuse: false, paid_reuse_price_cents: 50,
            messages: [],
          },
        },
      },
    });
    const res = await rentNumberHandler(http)({ service_id: "svc_tg", kind: "verification" });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(2);
    expect(http.history[1].method).toBe("POST");
    expect(http.history[1].body).toMatchObject({ service_id: "svc_tg", max_price_cents: 35 });
    expect(http.history[1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.verification).toMatchObject({ id: "ver_new" });
  });

  it("surfaces PRICE_OVER_CAP with quote/available delta + request_id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { services: [{ id: "svc_tg", name: "Telegram", quoted_price_cents: 35 }] } },
    });
    http.expect("POST", "/v1/verifications", {
      status: 409, headers: new Headers(),
      body: {
        success: false,
        error: { code: "PRICE_OVER_CAP", message: "...", request_id: "req_pricecap", details: { max_price_cents: 35, available_price_cents: 42 }, docs_url: "" },
      },
    });
    const res = await rentNumberHandler(http)({ service_id: "svc_tg", kind: "verification" });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$0.35");
    expect(t.text).toContain("$0.42");
    expect(t.text).toContain("req_pricecap"); // request_id flows
  });

  it("returns toolError when service not in catalog (no commit attempted)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { services: [{ id: "svc_other", name: "Other", quoted_price_cents: 50 }] } },
    });
    const res = await rentNumberHandler(http)({ service_id: "svc_tg", kind: "verification" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1); // no POST
  });
});

describe("rent_number (rental path)", () => {
  // Real rental shape: rental_type (not kind), uppercase duration, country, etc.
  function rentalResp(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id, display_id: "LTR789", status: "active", phone_number: "+14155550123",
      service_id: "svc_tg", service_name: "Telegram", country: "us", duration: "7D",
      rental_type: "rental", charged_price_cents: 500, auto_renew: false,
      next_renewal_price_cents: 500, re_rent_available: false, re_rent_price_cents: null,
      re_rent_blocked_at: null, created_at: "x", paid_until: "x", expires_at: "x",
      can_cancel: true, cancel_window_expires_at: "x", messages: [],
      ...overrides,
    };
  }

  it("rental kind → POST /v1/rentals with uppercase duration body and tied max_price_cents (no kind field)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { services: [{ id: "svc_tg", name: "Telegram", quoted_price_cents: 35, ltr_7d_price_cents: 500 }] } },
    });
    http.expect("POST", "/v1/rentals", {
      status: 201, headers: new Headers(),
      body: { success: true, data: rentalResp("ren_new") },
    });
    const res = await rentNumberHandler(http)({ service_id: "svc_tg", kind: "rental", duration: "7d" });
    expect(http.history[1].body).toMatchObject({ service_id: "svc_tg", duration: "7D", max_price_cents: 500 });
    expect(http.history[1].body).not.toHaveProperty("kind");
    expect(res.structuredContent?.rental).toMatchObject({ id: "ren_new" });
  });

  it("rental kind without duration → toolError without HTTP call", async () => {
    const http = createMockHttpClient();
    const res = await rentNumberHandler(http)({ service_id: "svc_tg", kind: "rental" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("rental tier not offered (price 0) → toolError without commit", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { services: [{ id: "svc_tg", name: "Telegram", quoted_price_cents: 35, ltr_7d_price_cents: 0 }] } },
    });
    const res = await rentNumberHandler(http)({ service_id: "svc_tg", kind: "rental", duration: "7d" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
  });
});

describe("cancel_rental", () => {
  it("ver_ ID → POST /v1/verifications/:id/cancel with idempotency", async () => {
    const http = createMockHttpClient();
    // Cancel returns a SLIM verification object, not the full resource.
    http.expect("POST", "/v1/verifications/ver_abc/cancel", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { verification: { id: "ver_abc", status: "cancelled", refunded_cents: 15 } } },
    });
    const res = await cancelRentalHandler(http)({ rental_id: "ver_abc" });
    expect(res.isError).toBeFalsy();
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Refunded $0.15");
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ren_ ID → DELETE /v1/rentals/:id with idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("DELETE", "/v1/rentals/ren_xyz", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { id: "ren_xyz", status: "cancelled", phone_number: "x", service_id: "x", service_name: "x", country: "us", duration: "7D", rental_type: "rental", charged_price_cents: 0, auto_renew: false, next_renewal_price_cents: 0, re_rent_available: false, re_rent_price_cents: null, re_rent_blocked_at: null, paid_until: "x", expires_at: "x", created_at: "x", can_cancel: false, messages: [] } },
    });
    const res = await cancelRentalHandler(http)({ rental_id: "ren_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("reuse_number, re_rent_rental, toggle_auto_renew", () => {
  function verResp(id: string) {
    return { success: true, data: { verification: { id, status: "waiting_for_code", phone_number: "x", service_id: "x", service_name: "x", charged_price_cents: 0, expires_at: "x", can_cancel: true, created_at: "x", reuse_counter: 1, allow_reuse: false, allow_paid_reuse: false, paid_reuse_price_cents: 50, messages: [] } } };
  }
  function rntResp(id: string, auto_renew = false) {
    return { success: true, data: { id, status: "active", phone_number: "x", service_id: "x", service_name: "x", country: "us", duration: "7D", rental_type: "rental", charged_price_cents: 500, auto_renew, next_renewal_price_cents: 500, re_rent_available: false, re_rent_price_cents: null, re_rent_blocked_at: null, paid_until: "x", expires_at: "x", created_at: "x", can_cancel: true, messages: [] } };
  }

  it("reuse_number free path → POST /v1/verifications/:id/reuse", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/verifications/ver_abc/reuse", { status: 200, headers: new Headers(), body: verResp("ver_abc") });
    const res = await reuseNumberHandler(http)({ rental_id: "ver_abc", paid: false });
    expect(res.isError).toBeFalsy();
  });

  it("reuse_number paid path → POST /v1/verifications/:id/reuse/paid", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/verifications/ver_abc/reuse/paid", { status: 200, headers: new Headers(), body: verResp("ver_abc") });
    await reuseNumberHandler(http)({ rental_id: "ver_abc", paid: true });
    expect(http.history[0].path).toBe("/v1/verifications/ver_abc/reuse/paid");
  });

  it("reuse_number rejects ren_ prefix", async () => {
    const http = createMockHttpClient();
    const res = await reuseNumberHandler(http)({ rental_id: "ren_xyz", paid: false });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("re_rent_rental → POST /v1/rentals/:id/re_rent with no body + idempotency", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/rentals/ren_xyz/re_rent", { status: 200, headers: new Headers(), body: rntResp("ren_new") });
    const res = await reRentRentalHandler(http)({ rental_id: "ren_xyz" });
    expect(http.history[0].body).toBeUndefined();
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.rental).toMatchObject({ id: "ren_new" });
  });

  it("re_rent_rental rejects ver_ prefix", async () => {
    const http = createMockHttpClient();
    const res = await reRentRentalHandler(http)({ rental_id: "ver_abc" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("toggle_auto_renew → POST /v1/rentals/:id/auto_renew", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/rentals/ren_xyz/auto_renew", { status: 200, headers: new Headers(), body: rntResp("ren_xyz", true) });
    await toggleAutoRenewHandler(http)({ rental_id: "ren_xyz", auto_renew: true });
    expect(http.history[0].body).toMatchObject({ auto_renew: true });
  });

  it("ded_ id -> POST /v1/dedicated/numbers/:id/auto_renew with { enabled }", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/dedicated/numbers/ded_abc123/auto_renew", {
      status: 200, headers: new Headers(),
      body: { success: true, data: dedNumberFixture({ auto_renew: true }) },
    });
    const res = await toggleAutoRenewHandler(http)({ rental_id: "ded_abc123", auto_renew: true });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toEqual({ enabled: true });
    expect(res.structuredContent?.dedicated_number).toMatchObject({ auto_renew: true });
  });

  it("still rejects ver_ ids", async () => {
    const http = createMockHttpClient();
    const res = await toggleAutoRenewHandler(http)({ rental_id: "ver_abc", auto_renew: true });
    expect(res.isError).toBe(true);
  });
});

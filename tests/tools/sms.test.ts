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
import { dedNumberFixture } from "../fixtures/dedicated.js";
import { toolContext } from "../../src/tools/context.js";

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
    const handler = searchSmsServicesHandler(toolContext(http));
    const res = await handler({});
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Telegram");
    expect(t.text).toContain("$0.35");
    expect(res.structuredContent?.services).toHaveLength(2);
  });

  it("passes query server-side as q and still filters by name", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services?q=tele", {
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
    const handler = searchSmsServicesHandler(toolContext(http));
    const res = await handler({ query: "tele" });
    expect(res.structuredContent?.services).toHaveLength(1);
  });

  it("says when output is truncated and keeps structuredContent to the printed rows", async () => {
    const http = createMockHttpClient();
    const services = Array.from({ length: 120 }, (_, i) => ({ id: `svc_s${i}`, name: `Service ${i}`, quoted_price_cents: 100 }));
    http.expect("GET", "/v1/services", { status: 200, headers: new Headers(), body: { success: true, data: { services } } });
    const res = await searchSmsServicesHandler(toolContext(http))({});
    expect(res.isError).toBeFalsy();
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Showing 50 of 120");
    expect(t.text).toContain("query");
    expect(res.structuredContent?.services).toHaveLength(50);
    expect(res.structuredContent).toMatchObject({ total: 120, truncated: true });
  });

  it("no match is a normal empty result with a hint, not an error", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/services?q=nothing", { status: 200, headers: new Headers(), body: { success: true, data: { services: [] } } });
    const res = await searchSmsServicesHandler(toolContext(http))({ query: "nothing" });
    expect(res.isError).toBeFalsy();
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("No SMS services match 'nothing'");
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

  const noMessages = { status: 200, headers: new Headers(), body: { success: true, data: { messages: [] } } };

  it("routes ver_ ID to /v1/verifications/:id and reads the live number's messages", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { verification: verFixture() } },
    });
    http.expect("GET", "/v1/verifications/ver_abc/messages", noMessages);
    const res = await getRentalHandler(toolContext(http))({ rental_id: "ver_abc" });
    expect(res.structuredContent?.verification).toMatchObject({ id: "ver_abc" });
    expect(res.structuredContent).toMatchObject({ messages: [], messages_total: 0 });
  });

  it("a waiting verification explains the open window and the automatic no-SMS refund", async () => {
    const http = createMockHttpClient();
    const expires = new Date(Date.now() + 12 * 60_000).toISOString();
    http.expect("GET", "/v1/verifications/ver_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { verification: { ...verFixture(), expires_at: expires } } },
    });
    http.expect("GET", "/v1/verifications/ver_abc/messages", noMessages);
    const res = await getRentalHandler(toolContext(http))({ rental_id: "ver_abc" });
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toMatch(/1[12]m left/);
    expect(t.text).toContain("wait_seconds");
    expect(t.text).toContain("refunded automatically");
    expect(t.text).toContain("cancelled");
  });

  it("a verification with a code shows the latest code and that more can arrive", async () => {
    const http = createMockHttpClient();
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    http.expect("GET", "/v1/verifications/ver_abc", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { verification: { ...verFixture(), status: "code_received", can_cancel: false, code: "492183", code_received_at: "2026-05-21T18:42:00Z", expires_at: expires } } },
    });
    http.expect("GET", "/v1/verifications/ver_abc/messages", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { messages: [{ code: "492183", text: "Your code is 492183", received_at: "2026-05-21T18:42:00Z" }] } },
    });
    const res = await getRentalHandler(toolContext(http))({ rental_id: "ver_abc" });
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Latest code:  492183");
    expect(t.text).toContain("More codes can arrive");
    expect(t.text).toContain("BEGIN UNTRUSTED SMS TEXT");
    expect(t.text).toContain('text="Your code is 492183"');
  });

  it("a failed messages read degrades to the verification alone", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_abc", {
      status: 200, headers: new Headers(), body: { success: true, data: { verification: verFixture() } },
    });
    http.expect("GET", "/v1/verifications/ver_abc/messages", {
      status: 503, headers: new Headers(), body: { success: false, error: { code: "SERVICE_UNAVAILABLE", message: "x", request_id: "r" } },
    });
    const res = await getRentalHandler(toolContext(http))({ rental_id: "ver_abc" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toHaveProperty("messages");
  });

  it("encodes the id as a single path segment", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_a%2F..%2Fb", {
      status: 404,
      headers: new Headers(),
      body: { success: false, error: { code: "VERIFICATION_NOT_FOUND", message: "Verification not found.", request_id: "req_enc" } },
    });
    await getRentalHandler(toolContext(http))({ rental_id: "ver_a/../b" });
    expect(http.history[0].path).toBe("/v1/verifications/ver_a%2F..%2Fb");
  });

  it("routes ren_ ID to /v1/rentals/:id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/ren_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: rntFixture() },
    });
    const res = await getRentalHandler(toolContext(http))({ rental_id: "ren_xyz" });
    expect(res.structuredContent?.rental).toMatchObject({ id: "ren_xyz" });
  });

  it("rejects bad ID prefix without an HTTP call", async () => {
    const http = createMockHttpClient();
    const res = await getRentalHandler(toolContext(http))({ rental_id: "bad_id" });
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
    const res = await getRentalHandler(toolContext(http))({ rental_id: "ver_missing" });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_xyz"); // request_id flowed end-to-end
  });
});

describe("rent_number (verification path)", () => {
  const verification = {
    id: "ver_new", status: "waiting_for_code", phone_number: "+14155550123",
    service_id: "svc_tg", service_name: "Telegram", charged_price_cents: 35,
    expires_at: "2026-05-21T19:00:00Z", can_cancel: true,
    created_at: "2026-05-21T18:40:00Z", reuse_counter: 0,
    allow_reuse: false, allow_paid_reuse: false, paid_reuse_price_cents: 50,
  };

  it("commits with the caller's max_price_cents + idempotency key, no internal quote", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/verifications", {
      status: 201, headers: new Headers(),
      body: { success: true, data: { verification } },
    });
    const ctx = toolContext(http, { budgetCents: 1000 });
    const res = await rentNumberHandler(ctx)({ service_id: "svc_tg", kind: "verification", max_price_cents: 40 });
    expect(res.isError).toBeFalsy();
    expect(http.history).toHaveLength(1);
    expect(http.history[0].body).toEqual({ service_id: "svc_tg", max_price_cents: 40 });
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.structuredContent?.verification).toMatchObject({ id: "ver_new" });
    // The budget counts the charge the response reports, not the cap.
    expect(ctx.guard.countedCents).toBe(35);
  });

  it("PRICE_OVER_CAP returns the new price and asks to re-confirm; nothing counted", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/verifications", {
      status: 409, headers: new Headers(),
      body: {
        success: false,
        error: { code: "PRICE_OVER_CAP", message: "...", request_id: "req_pricecap", details: { max_price_cents: 35, available_price_cents: 42 }, docs_url: "" },
      },
    });
    const ctx = toolContext(http, { budgetCents: 1000 });
    const res = await rentNumberHandler(ctx)({ service_id: "svc_tg", kind: "verification", max_price_cents: 35 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$0.35");
    expect(t.text).toContain("$0.42");
    expect(t.text).toContain("max_price_cents=42");
    expect(t.text).toContain("nothing was charged");
    expect(t.text).toContain("req_pricecap"); // request_id flows
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("an unknown service is the API's error (no local catalog read)", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/verifications", {
      status: 404, headers: new Headers(),
      body: { success: false, error: { code: "SERVICE_NOT_FOUND", message: "Service not found.", request_id: "req_nf" } },
    });
    const res = await rentNumberHandler(toolContext(http))({ service_id: "svc_tg", kind: "verification", max_price_cents: 50 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
  });

  it("refuses above VOIDMOB_MAX_ORDER_CENTS before any request", async () => {
    const http = createMockHttpClient();
    const res = await rentNumberHandler(toolContext(http, { maxOrderCents: 100 }))({ service_id: "svc_tg", max_price_cents: 150 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("VOIDMOB_MAX_ORDER_CENTS");
    expect(t.text).toContain("Nothing was charged");
    expect(http.history).toHaveLength(0);
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

  it("rental kind → POST /v1/rentals with uppercase duration and the caller's max_price_cents (no kind field)", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/rentals", {
      status: 201, headers: new Headers(),
      body: { success: true, data: rentalResp("ren_new") },
    });
    const res = await rentNumberHandler(toolContext(http))({ service_id: "svc_tg", kind: "rental", duration: "7d", max_price_cents: 550 });
    expect(http.history).toHaveLength(1);
    expect(http.history[0].body).toEqual({ service_id: "svc_tg", duration: "7D", max_price_cents: 550 });
    expect(res.structuredContent?.rental).toMatchObject({ id: "ren_new" });
  });

  it("rental kind without duration → toolError without HTTP call", async () => {
    const http = createMockHttpClient();
    const res = await rentNumberHandler(toolContext(http))({ service_id: "svc_tg", kind: "rental", max_price_cents: 500 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("a duration that is not offered is the API's LTR_NOT_AVAILABLE, passed through", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/rentals", {
      status: 404, headers: new Headers(),
      body: { success: false, error: { code: "LTR_NOT_AVAILABLE", message: "This rental duration is not offered.", request_id: "r" } },
    });
    const res = await rentNumberHandler(toolContext(http))({ service_id: "svc_tg", kind: "rental", duration: "7d", max_price_cents: 500 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("not offered");
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
    const res = await cancelRentalHandler(toolContext(http))({ rental_id: "ver_abc" });
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
    const res = await cancelRentalHandler(toolContext(http))({ rental_id: "ren_xyz" });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ren_ cancel reports the full refund of the rental price", async () => {
    const http = createMockHttpClient();
    http.expect("DELETE", "/v1/rentals/ren_xyz", {
      status: 200, headers: new Headers(),
      body: { success: true, data: { id: "ren_xyz", status: "cancelled", phone_number: "x", service_id: "x", service_name: "x", country: "us", duration: "7D", rental_type: "rental", charged_price_cents: 900, auto_renew: false, next_renewal_price_cents: 900, re_rent_available: false, re_rent_price_cents: null, re_rent_blocked_at: null, paid_until: "x", expires_at: "x", created_at: "x", can_cancel: false, messages: [] } },
    });
    const res = await cancelRentalHandler(toolContext(http))({ rental_id: "ren_xyz" });
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toBe("Rental ren_xyz cancelled. Refunded $9.00.");
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
    const res = await reuseNumberHandler(toolContext(http))({ rental_id: "ver_abc", paid: false });
    expect(res.isError).toBeFalsy();
  });

  it("reuse_number paid path → reads the price, then POST /reuse/paid acknowledging it (accept_charge_cents)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_abc", { status: 200, headers: new Headers(), body: verResp("ver_abc") });
    const charged = verResp("ver_abc");
    (charged.data.verification as Record<string, unknown>).charged_reuse_cents = 50;
    http.expect("POST", "/v1/verifications/ver_abc/reuse/paid", { status: 200, headers: new Headers(), body: charged });
    const ctx = toolContext(http, { budgetCents: 500 });
    const res = await reuseNumberHandler(ctx)({ rental_id: "ver_abc", paid: true, max_price_cents: 50 });
    expect(res.isError).toBeFalsy();
    expect(http.history[1].path).toBe("/v1/verifications/ver_abc/reuse/paid");
    expect(http.history[1].body).toEqual({ accept_charge_cents: 50 });
    expect(http.history[1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.guard.countedCents).toBe(50);
  });

  it("paid reuse without max_price_cents is refused before any request", async () => {
    const http = createMockHttpClient();
    const res = await reuseNumberHandler(toolContext(http))({ rental_id: "ver_abc", paid: true });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("max_price_cents");
    expect(http.history).toHaveLength(0);
  });

  it("paid reuse refuses when the current price is above max_price_cents (no POST, nothing counted)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/verifications/ver_abc", { status: 200, headers: new Headers(), body: verResp("ver_abc") });
    const ctx = toolContext(http, { budgetCents: 500 });
    const res = await reuseNumberHandler(ctx)({ rental_id: "ver_abc", paid: true, max_price_cents: 40 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("max_price_cents=50");
    expect(http.history).toHaveLength(1);
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("reuse_number rejects ren_ prefix", async () => {
    const http = createMockHttpClient();
    const res = await reuseNumberHandler(toolContext(http))({ rental_id: "ren_xyz", paid: false });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  function expiredRental(price: number | null, available = true) {
    const r = rntResp("ren_xyz");
    Object.assign(r.data, { status: "expired", re_rent_available: available, re_rent_price_cents: price });
    return r;
  }

  it("re_rent_rental reads the re-rent price, then POST /re_rent with no body and no idempotency key; the budget counts the cap", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/ren_xyz", { status: 200, headers: new Headers(), body: expiredRental(480) });
    http.expect("POST", "/v1/rentals/ren_xyz/re_rent", { status: 200, headers: new Headers(), body: rntResp("ren_xyz") });
    const ctx = toolContext(http, { budgetCents: 2000 });
    const res = await reRentRentalHandler(ctx)({ rental_id: "ren_xyz", max_price_cents: 500 });
    expect(res.isError).toBeFalsy();
    expect(http.history[1].body).toBeUndefined();
    // The endpoint ignores Idempotency-Key, so none is sent and the HTTP
    // client never retries it (a retry would re-run the re-rent).
    expect(http.history[1].headers).not.toHaveProperty("Idempotency-Key");
    expect(res.structuredContent?.rental).toMatchObject({ id: "ren_xyz" });
    // The response does not state this charge, so the approved cap is counted.
    expect(ctx.guard.countedCents).toBe(500);
  });

  it("re_rent_rental: a dropped connection is reported as uncertain and counted, never retried", async () => {
    const { NetworkError } = await import("../../src/client/http.js");
    const calls: string[] = [];
    const http = {
      async request(method: string, path: string) {
        calls.push(`${method} ${path}`);
        if (method === "GET") return { status: 200, headers: new Headers(), body: expiredRental(480) };
        throw new NetworkError(new Error("socket hang up"), method);
      },
    };
    const ctx = toolContext(http, { budgetCents: 2000 });
    const res = await reRentRentalHandler(ctx)({ rental_id: "ren_xyz", max_price_cents: 500 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("may or may not have gone through");
    expect(calls).toEqual(["GET /v1/rentals/ren_xyz", "POST /v1/rentals/ren_xyz/re_rent"]);
    expect(ctx.guard.countedCents).toBe(500);
  });

  it("re_rent_rental refuses when the re-rent price is above max_price_cents (no POST)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/ren_xyz", { status: 200, headers: new Headers(), body: expiredRental(650) });
    const ctx = toolContext(http, { budgetCents: 2000 });
    const res = await reRentRentalHandler(ctx)({ rental_id: "ren_xyz", max_price_cents: 500 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$6.50");
    expect(t.text).toContain("max_price_cents=650");
    expect(http.history).toHaveLength(1);
    expect(ctx.guard.countedCents).toBe(0);
  });

  it("re_rent_rental refuses a rental that is not re-rentable (no POST)", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/ren_xyz", { status: 200, headers: new Headers(), body: rntResp("ren_xyz") });
    const res = await reRentRentalHandler(toolContext(http))({ rental_id: "ren_xyz", max_price_cents: 500 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
  });

  it("re_rent_rental rejects ver_ prefix", async () => {
    const http = createMockHttpClient();
    const res = await reRentRentalHandler(toolContext(http))({ rental_id: "ver_abc", max_price_cents: 500 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });

  it("toggle_auto_renew → POST /v1/rentals/:id/auto_renew with { enabled } (the API's field)", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/rentals/ren_xyz/auto_renew", { status: 200, headers: new Headers(), body: rntResp("ren_xyz", true) });
    await toggleAutoRenewHandler(toolContext(http))({ rental_id: "ren_xyz", auto_renew: true });
    expect(http.history[0].body).toEqual({ enabled: true });
  });

  it("ded_ id -> POST /v1/dedicated/numbers/:id/auto_renew with { enabled }", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/dedicated/numbers/ded_abc123/auto_renew", {
      status: 200, headers: new Headers(),
      body: { success: true, data: dedNumberFixture({ auto_renew: true }) },
    });
    const res = await toggleAutoRenewHandler(toolContext(http))({ rental_id: "ded_abc123", auto_renew: true });
    expect(res.isError).toBeFalsy();
    expect(http.history[0].body).toEqual({ enabled: true });
    expect(res.structuredContent?.dedicated_number).toMatchObject({ auto_renew: true });
  });

  it("with a per-order limit, turning auto-renew on checks the renewal price first", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/ren_xyz", { status: 200, headers: new Headers(), body: rntResp("ren_xyz") });
    const refused = await toggleAutoRenewHandler(toolContext(http, { maxOrderCents: 400 }))({ rental_id: "ren_xyz", auto_renew: true });
    expect(refused.isError).toBe(true);
    const t = refused.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$5.00");
    expect(t.text).toContain("VOIDMOB_MAX_ORDER_CENTS");
    expect(http.history).toHaveLength(1); // no POST

    const ok = createMockHttpClient();
    ok.expect("GET", "/v1/dedicated/numbers/ded_abc123", { status: 200, headers: new Headers(), body: { success: true, data: dedNumberFixture() } });
    ok.expect("POST", "/v1/dedicated/numbers/ded_abc123/auto_renew", { status: 200, headers: new Headers(), body: { success: true, data: dedNumberFixture({ auto_renew: true }) } });
    const allowed = await toggleAutoRenewHandler(toolContext(ok, { maxOrderCents: 5000 }))({ rental_id: "ded_abc123", auto_renew: true });
    expect(allowed.isError).toBeFalsy();
  });

  it("with a session budget, auto-renew cannot be turned on, but can always be turned off", async () => {
    const http = createMockHttpClient();
    const refused = await toggleAutoRenewHandler(toolContext(http, { budgetCents: 10_000 }))({ rental_id: "ren_xyz", auto_renew: true });
    expect(refused.isError).toBe(true);
    const t = refused.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("VOIDMOB_BUDGET_CENTS");
    expect(http.history).toHaveLength(0);
    http.expect("POST", "/v1/rentals/ren_xyz/auto_renew", { status: 200, headers: new Headers(), body: rntResp("ren_xyz", false) });
    const off = await toggleAutoRenewHandler(toolContext(http, { budgetCents: 10_000, maxOrderCents: 1 }))({ rental_id: "ren_xyz", auto_renew: false });
    expect(off.isError).toBeFalsy();
  });

  it("still rejects ver_ ids", async () => {
    const http = createMockHttpClient();
    const res = await toggleAutoRenewHandler(toolContext(http))({ rental_id: "ver_abc", auto_renew: true });
    expect(res.isError).toBe(true);
  });
});

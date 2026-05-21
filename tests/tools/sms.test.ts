import { describe, it, expect } from "vitest";
import { searchSmsServicesHandler, getRentalHandler } from "../../src/tools/sms.js";
import { createMockHttpClient } from "../../src/testing/mock-http.js";

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
      id: "rnt_xyz",
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
      created_at: "2026-05-21T00:00:00Z",
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

  it("routes rnt_ ID to /v1/rentals/:id", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/rentals/rnt_xyz", {
      status: 200,
      headers: new Headers(),
      body: { success: true, data: { rental: rntFixture() } },
    });
    const res = await getRentalHandler(http)({ rental_id: "rnt_xyz" });
    expect(res.structuredContent?.rental).toMatchObject({ id: "rnt_xyz" });
  });

  it("rejects bad ID prefix without an HTTP call", async () => {
    const http = createMockHttpClient();
    const res = await getRentalHandler(http)({ rental_id: "bad_id" });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toMatch(/ver_|rnt_/);
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

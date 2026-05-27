import { describe, it, expect } from "vitest";
import { getAccountHandler } from "../../src/tools/account.js";
import { createMockHttpClient } from "../mock-http.js";

describe("get_account", () => {
  it("calls GET /v1/me and renders balance + rate limits", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/me", {
      status: 200,
      body: {
        success: true,
        data: {
          id: "usr_abc",
          balance: { amount_cents: 1250, currency: "USD", formatted: "$12.50" },
          rate_limits: {
            account: { limit: 60, window_seconds: 60 },
            verifications: { limit: 30, window_seconds: 60 },
          },
          created_at: "2026-01-01T00:00:00Z",
        },
      },
      headers: new Headers(),
    });

    const handler = getAccountHandler(http);
    const res = await handler();
    expect(res.isError).toBeFalsy();
    const textBlock = res.content[0];
    if (textBlock.type !== "text") throw new Error("expected text block");
    expect(textBlock.text).toContain("$12.50");
    expect(res.structuredContent?.account).toMatchObject({ id: "usr_abc" });
  });

  it("maps UNAUTHENTICATED to docs URL", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/me", {
      status: 401,
      body: {
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required.",
          request_id: "req_x",
          docs_url: "",
        },
      },
      headers: new Headers(),
    });
    const handler = getAccountHandler(http);
    const res = await handler();
    expect(res.isError).toBe(true);
    const textBlock = res.content[0];
    if (textBlock.type !== "text") throw new Error("expected text block");
    expect(textBlock.text).toContain("developers/api-keys");
    expect(textBlock.text).toContain("req_x");
  });
});

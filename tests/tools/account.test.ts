import { describe, it, expect } from "vitest";
import { getAccountHandler } from "../../src/tools/account.js";
import { createMockHttpClient } from "../mock-http.js";
import { toolContext } from "../../src/tools/context.js";

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

    const handler = getAccountHandler(toolContext(http));
    const res = await handler({});
    expect(res.isError).toBeFalsy();
    const textBlock = res.content[0];
    if (textBlock.type !== "text") throw new Error("expected text block");
    expect(textBlock.text).toContain("$12.50");
    expect(res.structuredContent?.account).toMatchObject({ id: "usr_abc" });
  });

  it("shows the key's permission, limits, 24h spend, auto-mode, settings page and the deposit link", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/me", {
      status: 200,
      body: {
        success: true,
        data: {
          id: "usr_abc",
          balance: { amount_cents: 1250, currency: "USD", formatted: "$12.50" },
          rate_limits: {},
          key: {
            id: "key_1", kind: "oauth", name: "Claude", permission: "buy", max_order_cents: null,
            daily_limit_cents: 5000, spent_24h_cents: 1200, auto_mode: true,
          },
          deposit_url: "https://dash.example/wallet",
          created_at: "2026-01-01T00:00:00Z",
        },
      },
      headers: new Headers(),
    });
    const res = await getAccountHandler(toolContext(http))({});
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain("Add funds:   create_deposit (ask the user which coin and how much), or https://dash.example/wallet");
    expect(text).toContain('App connection "Claude":');
    expect(text).toContain("Permission:      Buy");
    expect(text).toContain("Max per order:   No limit");
    expect(text).toContain("Daily limit:     $50.00 ($12.00 spent in the last 24h, $38.00 left)");
    expect(text).toContain("Auto-mode:       on");
    expect(text).toContain("Settings:        https://dash.example/account/connected-apps");
    expect(res.structuredContent?.account).toMatchObject({ key: { permission: "buy", daily_limit_cents: 5000 } });
    expect(res.structuredContent?.access).toEqual({
      permission: "buy", auto_mode: false, settings_url: "https://dash.example/account/connected-apps", deposit_url: "https://dash.example/wallet",
    });
  });

  it("shows the local auto-mode and read-only controls under the owner limits", async () => {
    const http = createMockHttpClient();
    const me = { id: "u", balance: { amount_cents: 0, currency: "USD", formatted: "$0.00" }, rate_limits: {}, created_at: "2026-01-01T00:00:00Z" };
    http.expect("GET", "/v1/me", { status: 200, body: { success: true, data: me }, headers: new Headers() });
    const res = await getAccountHandler(toolContext(http, { autonomous: true, budgetCents: 2000 }))({});
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain("Add funds:   create_deposit (ask the user which coin and how much), or https://dashboard.voidmob.com/wallet");
    expect(text).toContain("Auto-mode:       on (VOIDMOB_AUTONOMOUS");
    expect(text).toContain("Session budget:  $20.00 left");
    expect(res.structuredContent?.access).toMatchObject({ permission: "buy", auto_mode: true });
  });

  it("below Manage the Add funds line is the link alone", async () => {
    const http = createMockHttpClient();
    const me = { id: "u", balance: { amount_cents: 0, currency: "USD", formatted: "$0.00" }, rate_limits: {}, created_at: "2026-01-01T00:00:00Z" };
    http.expect("GET", "/v1/me", { status: 200, body: { success: true, data: me }, headers: new Headers() });
    const res = await getAccountHandler(toolContext(http, { readOnly: true }))({});
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain("Add funds:   https://dashboard.voidmob.com/wallet\n");
    expect(text).not.toContain("create_deposit");
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
    const handler = getAccountHandler(toolContext(http));
    const res = await handler({});
    expect(res.isError).toBe(true);
    const textBlock = res.content[0];
    if (textBlock.type !== "text") throw new Error("expected text block");
    expect(textBlock.text).toContain("developers/api-keys");
    expect(textBlock.text).toContain("req_x");
  });
});

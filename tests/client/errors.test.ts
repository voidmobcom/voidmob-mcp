import { describe, it, expect } from "vitest";
import { mapApiError } from "../../src/client/errors.js";
import { HttpError, NetworkError } from "../../src/client/http.js";

describe("mapApiError", () => {
  it("UNAUTHENTICATED → docs URL pointer", () => {
    const err = new HttpError(401, "UNAUTHENTICATED", "req_x", undefined, "Authentication required.");
    expect(mapApiError(err)).toContain("dashboard.voidmob.com/developers/api-keys");
  });

  it("INSUFFICIENT_BALANCE → wallet URL pointer", () => {
    const err = new HttpError(402, "INSUFFICIENT_BALANCE", "req_x", undefined, "...");
    expect(mapApiError(err)).toContain("dashboard.voidmob.com/wallet");
  });

  it("RATE_LIMITED → retry hint", () => {
    const err = new HttpError(429, "RATE_LIMITED", "req_x", undefined, "...");
    expect(mapApiError(err)).toMatch(/retry/i);
  });

  it("PRICE_OVER_CAP → quote/available delta", () => {
    const err = new HttpError(409, "PRICE_OVER_CAP", "req_x", { max_price_cents: 35, available_price_cents: 42 }, "...");
    expect(mapApiError(err)).toContain("$0.35");
    expect(mapApiError(err)).toContain("$0.42");
  });

  it("unknown API code → falls through to API message", () => {
    const err = new HttpError(500, "WEIRD_NEW_CODE", "req_x", undefined, "Pass-through msg.");
    expect(mapApiError(err)).toContain("Pass-through msg.");
  });

  it("NetworkError → connection text", () => {
    const err = new NetworkError(new Error("ECONNREFUSED"));
    expect(mapApiError(err)).toMatch(/could not reach/i);
  });

  it("always includes request_id when present", () => {
    const err = new HttpError(500, "INTERNAL_ERROR", "req_abc123", undefined, "...");
    expect(mapApiError(err)).toContain("req_abc123");
  });
  it("write NetworkError → says the purchase may have gone through and to check before buying again (never 'check your connection')", () => {
    const text = mapApiError(new NetworkError(new Error("timeout"), "POST"));
    expect(text).toMatch(/may or may not have gone through/);
    expect(text).toContain("list_orders");
    expect(text).toContain("get_account");
    expect(text).not.toMatch(/check your connection/i);
  });

  it("GET NetworkError keeps the retry message", () => {
    expect(mapApiError(new NetworkError(new Error("x"), "GET"))).toMatch(/check your connection and retry/i);
  });

  it("PROVISIONING_FAILED / PROVIDER_TIMEOUT → refunded, white-labeled, no timeout wording", () => {
    for (const code of ["PROVISIONING_FAILED", "PROVIDER_TIMEOUT"]) {
      const text = mapApiError(new HttpError(502, code, "req_p", undefined, "x"));
      expect(text).toContain("refunded");
      expect(text).not.toMatch(/provider|timed out/i);
    }
  });

  it("SERVICE_OUT_OF_STOCK distinguishes throttled (wait retry_after_seconds) from no_stock", () => {
    const throttled = mapApiError(new HttpError(503, "SERVICE_OUT_OF_STOCK", "r", { reason: "throttled", retry_after_seconds: 4 }));
    expect(throttled).toContain("Wait 4s");
    expect(throttled).toContain("only extends the wait");
    const noStock = mapApiError(new HttpError(503, "SERVICE_OUT_OF_STOCK", "r", { reason: "no_stock" }));
    expect(noStock).toContain("No stock available right now");
    expect(noStock).not.toContain("Wait 4s");
  });

  it("RATE_LIMITED surfaces Retry-After and the penalty pause", () => {
    expect(mapApiError(new HttpError(429, "RATE_LIMITED", "r", undefined, "x", { retryAfterSeconds: 12 }))).toContain("Wait 12s");
    const paused = mapApiError(new HttpError(429, "RATE_LIMITED", "r", { reason: "sustained_rate_limit_violations", paused_for_seconds: 300 }, "x", { retryAfterSeconds: 300 }));
    expect(paused).toContain("paused for 300s");
  });

  it("PRICE_MISMATCH and IDEMPOTENCY_REPLAY_IN_FLIGHT map to clear next steps", () => {
    const mismatch = mapApiError(new HttpError(409, "PRICE_MISMATCH", "r"));
    expect(mismatch).toContain("nothing was charged");
    expect(mismatch).toContain("only if they approve");
    expect(mismatch).toContain("max_price_cents");
    const inFlight = mapApiError(new HttpError(409, "IDEMPOTENCY_REPLAY_IN_FLIGHT", "r", undefined, "x", { method: "POST", retryAfterSeconds: 5 }));
    expect(inFlight).toContain("still being processed");
    expect(inFlight).toContain("wait 5s");
    expect(inFlight).toContain("before buying again");
  });

  it("CANCEL_NOT_ALLOWED explains the SMS cancel rules and the automatic refund", () => {
    const text = mapApiError(new HttpError(409, "CANCEL_NOT_ALLOWED", "r"));
    expect(text).toContain("60 minutes");
    expect(text).toContain("refunded automatically");
  });

  it("a write without an API verdict (INTERNAL_ERROR or a non-API 5xx) says to check before retrying", () => {
    expect(mapApiError(new HttpError(500, "INTERNAL_ERROR", "r", undefined, "x", { method: "POST" }))).toContain("before buying again");
    expect(mapApiError(new HttpError(500, "INTERNAL_ERROR", "r", undefined, "x", { method: "GET" }))).not.toContain("buying again");
    expect(mapApiError(new HttpError(502, "UNKNOWN_ERROR", "", undefined, undefined, { method: "POST" }))).toMatch(/may or may not have gone through/);
  });

  it("drops the misleading allowlist copy", () => {
    const ip = mapApiError(new HttpError(403, "IP_NOT_ALLOWED", "r"));
    expect(ip).toContain("Contact VoidMob support");
  });

  it("INSUFFICIENT_BALANCE gives the deposit link: /v1/me's, else the dashboard wallet", () => {
    const err = new HttpError(402, "INSUFFICIENT_BALANCE", "req_b", undefined, "Your wallet balance is too low for this purchase.", { method: "POST" });
    const known = mapApiError(err, { depositUrl: "https://dash.example/wallet" });
    expect(known).toContain("Nothing was charged");
    expect(known).toContain("add funds at https://dash.example/wallet");
    expect(known).toContain("req_b");
    expect(mapApiError(err)).toContain("add funds at https://dashboard.voidmob.com/wallet");
  });

  it("INSUFFICIENT_BALANCE at each level: create_deposit at Manage and Buy, the link alone at View or unknown", () => {
    const err = new HttpError(402, "INSUFFICIENT_BALANCE", "req_b", undefined, "Your wallet balance is too low for this purchase.", { method: "POST" });
    const depositUrl = "https://dash.example/wallet";
    for (const level of ["manage", "buy"] as const) {
      expect(mapApiError(err, { depositUrl, level }), level).toBe(
        "Your VoidMob balance is too low for this purchase. Nothing was charged. " +
        "Offer to add funds with create_deposit (ask which coin and how much), or the user can add funds at https://dash.example/wallet. Then retry. (request_id: req_b)",
      );
    }
    const linkOnly = "Your VoidMob balance is too low for this purchase. Nothing was charged. Ask the user to add funds at https://dash.example/wallet, then retry (request_id: req_b)";
    expect(mapApiError(err, { depositUrl, level: "view" })).toBe(linkOnly);
    expect(mapApiError(err, { depositUrl })).toBe(linkOnly);
  });

  it("DEPOSIT_LIMIT_REACHED: open or daily deposits, reuse an open one, nothing created", () => {
    const open = mapApiError(new HttpError(429, "DEPOSIT_LIMIT_REACHED", "req_d", { reason: "open_deposits", limit: 8 }, "Too many open deposits.", { method: "POST" }));
    expect(open).toBe(
      "This account already has 8 open deposits, the most allowed at once, so no deposit was created. " +
      "Reuse an open one (get_deposit without a deposit_id lists the newest) or wait until one is paid or expires (request_id: req_d)",
    );
    const daily = mapApiError(new HttpError(429, "DEPOSIT_LIMIT_REACHED", "r", { reason: "daily_deposits", limit: 25 }, "x", { method: "POST" }));
    expect(daily).toContain("This account has created 25 deposits in the last 24 hours, the most allowed, so no deposit was created.");
    expect(daily).toContain("or try again later");
    expect(mapApiError(new HttpError(429, "DEPOSIT_LIMIT_REACHED", "r", { reason: "daily_deposits" }))).toContain("as many deposits in the last 24 hours as allowed");
    // An unknown reason keeps the API's message.
    expect(mapApiError(new HttpError(429, "DEPOSIT_LIMIT_REACHED", "r", { reason: "new" }, "Deposit limit reached."))).toBe("Deposit limit reached. No deposit was created. (request_id: r)");
  });

  it("VALIDATION_ERROR with min_amount_cents names the coin's minimum; without it, the API's message", () => {
    const min = mapApiError(new HttpError(400, "VALIDATION_ERROR", "req_v", { min_amount_cents: 500 }, "Below the minimum.", { method: "POST" }));
    expect(min).toBe(
      "The amount is below this coin's minimum deposit of $5.00 (amount_cents 500), so no deposit was created. " +
      "Ask the user for at least that much or another coin (get_deposit without a deposit_id lists the coins and their minimums) (request_id: req_v)",
    );
    expect(mapApiError(new HttpError(400, "VALIDATION_ERROR", "r", undefined, "status is not valid."))).toBe("status is not valid. (request_id: r)");
  });

  it("PERMISSION_DENIED names the current and required level and the settings page", () => {
    const text = mapApiError(new HttpError(403, "PERMISSION_DENIED", "req_p",
      { permission: "manage", required_permission: "buy", settings_url: "https://dashboard.voidmob.com/account/connected-apps" },
      "This app connection has Manage access. This action needs Buy access.", { method: "POST" }));
    expect(text).toContain("This needs Buy access, and the API key or app connection this server uses has Manage access.");
    expect(text).toContain("Nothing was charged or changed");
    expect(text).toContain("only the account owner can change the permission level, at https://dashboard.voidmob.com/account/connected-apps");
    expect(text).toContain("req_p");
    // Without details: the API's message, and the dashboard as the place to change it.
    const bare = mapApiError(new HttpError(403, "PERMISSION_DENIED", "r", undefined, "This API key has View access. This action needs Manage access."));
    expect(bare).toContain("This API key has View access. This action needs Manage access.");
    expect(bare).toContain("in the dashboard");
  });

  it("ORDER_LIMIT_EXCEEDED: the limit, the largest order allowed now, the raise-limit link, and a fresh call after raising", () => {
    const text = mapApiError(new HttpError(402, "ORDER_LIMIT_EXCEEDED", "req_o",
      { limit_cents: 2500, remaining_cents: 2500, settings_url: "https://dashboard.voidmob.com/developers/api-keys" },
      "This order ($30.00) is over this API key's per-order limit of $25.00.", { method: "POST" }));
    expect(text).toContain("This order ($30.00) is over this API key's per-order limit of $25.00. Nothing was charged.");
    expect(text).toContain("The largest order allowed right now is $25.00.");
    expect(text).toContain("only the account owner can raise the limit, at https://dashboard.voidmob.com/developers/api-keys");
    expect(text).toContain("call this tool again: each call is a new request");
    expect(text).toContain("req_o");
    // Without the API's message the limit still shows.
    expect(mapApiError(new HttpError(402, "ORDER_LIMIT_EXCEEDED", "r", { limit_cents: 2500 }))).toContain("per-order spending limit of $25.00");
  });

  it("DAILY_SPEND_CAP_EXCEEDED: the daily limit, what is left, the raise-limit link", () => {
    const text = mapApiError(new HttpError(402, "DAILY_SPEND_CAP_EXCEEDED", "r",
      { limit_cents: 5000, remaining_cents: 1200, settings_url: "https://dashboard.voidmob.com/developers/api-keys" },
      "This order ($20.00) would go over this API key's daily limit of $50.00 - $12.00 left in the last 24 hours.", { method: "POST" }));
    expect(text).toContain("daily limit of $50.00 - $12.00 left in the last 24 hours. Nothing was charged.");
    expect(text).toContain("The largest order allowed right now is $12.00.");
    expect(text).toContain("raise the limit, at https://dashboard.voidmob.com/developers/api-keys");
    const spent = mapApiError(new HttpError(402, "DAILY_SPEND_CAP_EXCEEDED", "r", { limit_cents: 5000, remaining_cents: 0 }));
    expect(spent).toContain("daily spending limit of $50.00");
    expect(spent).toContain("No order is allowed right now until earlier purchases are more than 24 hours old.");
    expect(spent).toContain("in the dashboard");
  });

  it("no mapped message names a supplier or says 'provider'", () => {
    const codes = [
      "UNAUTHENTICATED", "IP_NOT_ALLOWED", "RATE_LIMITED", "INSUFFICIENT_BALANCE", "PRICE_OVER_CAP", "PRICE_MISMATCH",
      "SERVICE_OUT_OF_STOCK", "OUT_OF_STOCK_AT_PRICE", "CANCEL_WINDOW_NOT_OPEN", "CANCEL_NOT_ALLOWED",
      "IDEMPOTENCY_REPLAY_IN_FLIGHT", "PROVIDER_TIMEOUT", "PROVISIONING_FAILED", "PROVIDER_ERROR", "INTERNAL_ERROR",
      "PERMISSION_DENIED", "ORDER_LIMIT_EXCEEDED", "DAILY_SPEND_CAP_EXCEEDED", "DEPOSIT_LIMIT_REACHED", "VALIDATION_ERROR",
    ];
    for (const code of codes) {
      for (const method of ["GET", "POST"]) {
        expect(mapApiError(new HttpError(500, code, "", undefined, "white-labeled", { method }))).not.toMatch(/provider/i);
      }
    }
  });
});

describe("app connection refusals", () => {
  const oauth = { permission: "buy" as const, autoMode: false, maxOrderCents: null, dailyLimitCents: null, kind: "oauth" as const };
  const links = { depositUrl: "https://dashboard.voidmob.com/wallet", hosted: true, connection: oauth };

  it("connection_not_allowed shows the API's message, never the permission-level advice", () => {
    const err = new HttpError(403, "PERMISSION_DENIED", "req_1", {
      reason: "connection_not_allowed", settings_url: "https://dashboard.voidmob.com/account/connected-apps",
    }, "App connections can't turn auto-renew on. Do this in the VoidMob dashboard or with an API key.", { method: "PATCH" });
    const text = mapApiError(err, links);
    expect(text).toBe(
      "App connections can't turn auto-renew on. Do this in the VoidMob dashboard or with an API key. Nothing was charged or changed. (request_id: req_1)",
    );
    expect(text).not.toMatch(/permission level|account owner/);
  });

  it("an ordinary PERMISSION_DENIED still names the levels and where they change", () => {
    const err = new HttpError(403, "PERMISSION_DENIED", "req_2", {
      permission: "view", required_permission: "buy", settings_url: "https://dashboard.voidmob.com/account/connected-apps",
    }, "x", { method: "POST" });
    expect(mapApiError(err, links)).toContain("only the account owner can change the permission level");
  });

  it("paused connected-app purchases are matched by their reason, whatever else is known", () => {
    const err = new HttpError(503, "SERVICE_UNAVAILABLE", "req_5", { reason: "connected_app_purchases_paused" },
      "Purchases through connected apps are paused right now. Try again later.", { method: "POST", retryAfterSeconds: 300 });
    const expected = "Purchases through connected apps are paused right now, so nothing was charged. Try again later (in about 5 minutes) (request_id: req_5)";
    expect(mapApiError(err, links)).toBe(expected);
    // Even without the connection's kind (its /v1/me read failed).
    expect(mapApiError(err, { depositUrl: links.depositUrl, hosted: true })).toBe(expected);
  });

  it("a write 503 on a connected app without the reason is not taken for the pause", () => {
    const err = new HttpError(503, "SERVICE_UNAVAILABLE", "req_3", undefined,
      "Purchases through connected apps are paused right now. Try again later.", { method: "POST", retryAfterSeconds: 300 });
    const text = mapApiError(err, links);
    expect(text).toBe("Purchases through connected apps are paused right now. Try again later. (request_id: req_3)");
    expect(text).not.toContain("nothing was charged");
  });

  it("a short throttle (retry_after_seconds) keeps the API's own message", () => {
    const err = new HttpError(503, "SERVICE_UNAVAILABLE", "req_4", { retry_after_seconds: 5 },
      "This service is momentarily unavailable. Please retry after the interval in the Retry-After header.", { method: "POST", retryAfterSeconds: 5 });
    expect(mapApiError(err, links)).toContain("This service is momentarily unavailable");
  });
});

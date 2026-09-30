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
    expect(mismatch).toContain("confirm");
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

  it("drops the misleading spend-cap and allowlist copy", () => {
    const cap = mapApiError(new HttpError(402, "DAILY_SPEND_CAP_EXCEEDED", "r", undefined, "This key has reached its daily spend cap."));
    expect(cap).not.toMatch(/raise the cap/i);
    const ip = mapApiError(new HttpError(403, "IP_NOT_ALLOWED", "r"));
    expect(ip).toContain("Contact VoidMob support");
  });

  it("no mapped message names a supplier or says 'provider'", () => {
    const codes = [
      "UNAUTHENTICATED", "IP_NOT_ALLOWED", "RATE_LIMITED", "INSUFFICIENT_BALANCE", "PRICE_OVER_CAP", "PRICE_MISMATCH",
      "SERVICE_OUT_OF_STOCK", "OUT_OF_STOCK_AT_PRICE", "CANCEL_WINDOW_NOT_OPEN", "CANCEL_NOT_ALLOWED",
      "IDEMPOTENCY_REPLAY_IN_FLIGHT", "PROVIDER_TIMEOUT", "PROVISIONING_FAILED", "PROVIDER_ERROR", "INTERNAL_ERROR",
    ];
    for (const code of codes) {
      for (const method of ["GET", "POST"]) {
        expect(mapApiError(new HttpError(500, code, "", undefined, "white-labeled", { method }))).not.toMatch(/provider/i);
      }
    }
  });
});

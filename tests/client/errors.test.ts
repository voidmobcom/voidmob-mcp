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
});

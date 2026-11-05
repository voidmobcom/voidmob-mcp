import { describe, it, expect } from "vitest";
import { topupQuote } from "../src/utils/topup-price.js";

const LIST = [
  { additional_gb: 1, price_cents: 399, days_added: 3 },
  { additional_gb: 10, price_cents: 3500, days_added: 30 },
  { additional_gb: 25, price_cents: 8125, days_added: 30 },
  { additional_gb: 50, price_cents: 14950, days_added: 30 },
  { additional_gb: 100, price_cents: 25000, days_added: 30 },
];

describe("topupQuote", () => {
  it("is exact for a listed size", () => {
    expect(topupQuote(LIST, 10)).toEqual({ cents: 3500, exact: true });
  });

  it("follows the API rule for other sizes", () => {
    expect(topupQuote(LIST, 5)).toEqual({ cents: 1995, exact: false }); // 5 x 399
    expect(topupQuote(LIST, 37)).toEqual({ cents: 12025, exact: false }); // 37 x 325
    expect(topupQuote(LIST, 150)).toEqual({ cents: 37500, exact: false }); // 150 x 250
  });

  it("never prices a size above the next listed size", () => {
    expect(topupQuote(LIST, 9)?.cents).toBe(3500);
    expect(topupQuote(LIST, 99)?.cents).toBe(25000);
  });

  it("is null without a list", () => {
    expect(topupQuote([], 5)).toBeNull();
  });
});

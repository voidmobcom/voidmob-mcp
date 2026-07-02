import { describe, it, expect } from "vitest";
import { DedicatedCountry, DedicatedNumber } from "../../src/client/types.js";
import { isDedicatedId } from "../../src/constants/rental-id.js";

export function dedCountryFixture(over: Partial<DedicatedCountry> = {}): DedicatedCountry {
  return { country: "de", name: "Germany", quoted_price_cents: 4899, base_price_cents: 4899, in_stock: true, ...over };
}

export function dedNumberFixture(over: Partial<DedicatedNumber> = {}): DedicatedNumber {
  return {
    id: "ded_abc123",
    display_id: "DED1",
    status: "active",
    phone_number: "+4915123456789",
    country: "de",
    country_name: "Germany",
    billing_period: "monthly",
    nickname: null,
    quoted_price_cents: 4899,
    charged_price_cents: 4899,
    next_renewal_price_cents: 4899,
    auto_renew: false,
    created_at: "2026-07-01T12:00:00Z",
    paid_until: "2026-08-01T12:00:00Z",
    expires_at: "2026-08-01T12:00:00Z",
    messages: [],
    ...over,
  };
}

describe("dedicated schemas", () => {
  it("parses the documented country row", () => {
    expect(DedicatedCountry.parse(dedCountryFixture())).toMatchObject({ country: "de", in_stock: true });
  });

  it("parses the documented number resource incl. messages", () => {
    const d = DedicatedNumber.parse(dedNumberFixture({
      messages: [{ id: "msg_1", code: "123456", text: "Your code is 123456", received_at: "2026-07-01T13:00:00Z" }],
    }));
    expect(d.messages?.[0].code).toBe("123456");
  });

  it("isDedicatedId matches ded_ prefix only", () => {
    expect(isDedicatedId("ded_abc")).toBe(true);
    expect(isDedicatedId("ren_abc")).toBe(false);
  });
});

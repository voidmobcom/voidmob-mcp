import { describe, it, expect } from "vitest";
import { DedicatedCountry, DedicatedNumber } from "../../src/client/types.js";
import { isDedicatedId } from "../../src/constants/rental-id.js";
import { searchDedicatedCountriesHandler, getDedicatedNumberHandler } from "../../src/tools/dedicated.js";
import { createMockHttpClient } from "../mock-http.js";

const okBody = (data: unknown) => ({ status: 200, headers: new Headers(), body: { success: true, data } });

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

describe("search_dedicated_countries", () => {
  it("lists countries with monthly price and stock", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody([
      dedCountryFixture(),
      dedCountryFixture({ country: "hk", name: "Hong Kong", quoted_price_cents: 2699, base_price_cents: 2699, in_stock: false }),
    ]));
    const res = await searchDedicatedCountriesHandler(http)({});
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Germany");
    expect(t.text).toContain("$48.99/mo");
    expect(t.text).toContain("(out of stock)");
    expect(res.structuredContent?.countries).toHaveLength(2);
  });

  it("empty catalog -> toolError", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody([]));
    const res = await searchDedicatedCountriesHandler(http)({});
    expect(res.isError).toBe(true);
  });
});

describe("get_dedicated_number", () => {
  it("renders status and messages with codes", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/numbers/ded_abc123", okBody(dedNumberFixture({
      messages: [{ id: "msg_1", code: "424242", text: "Your code is 424242", received_at: "2026-07-01T13:00:00Z" }],
    })));
    const res = await getDedicatedNumberHandler(http)({ number_id: "ded_abc123" });
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("+4915123456789");
    expect(t.text).toContain("Code: 424242");
    expect(res.structuredContent?.dedicated_number).toMatchObject({ id: "ded_abc123" });
  });

  it("rejects non-ded_ ids without calling the API", async () => {
    const http = createMockHttpClient();
    const res = await getDedicatedNumberHandler(http)({ number_id: "ren_abc" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });
});

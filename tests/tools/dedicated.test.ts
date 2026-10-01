import { describe, it, expect } from "vitest";
import { DedicatedCountry, DedicatedNumber } from "../../src/client/types.js";
import { isDedicatedId } from "../../src/constants/rental-id.js";
import { searchDedicatedCountriesHandler, getDedicatedNumberHandler, purchaseDedicatedNumberHandler } from "../../src/tools/dedicated.js";
import { createMockHttpClient } from "../mock-http.js";
import { dedCountryFixture, dedNumberFixture } from "../fixtures/dedicated.js";
import { toolContext } from "../../src/tools/context.js";

const okBody = (data: unknown) => ({ status: 200, headers: new Headers(), body: { success: true, data } });

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
    const res = await searchDedicatedCountriesHandler(toolContext(http))({});
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("Germany");
    expect(t.text).toContain("$48.99/mo");
    expect(t.text).toContain("(out of stock)");
    expect(res.structuredContent?.countries).toHaveLength(2);
  });

  it("empty catalog -> a normal empty result, not an error", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody([]));
    const res = await searchDedicatedCountriesHandler(toolContext(http))({});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.countries).toEqual([]);
  });
});

describe("get_dedicated_number", () => {
  it("renders status and messages with codes", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/numbers/ded_abc123", okBody(dedNumberFixture({
      messages: [{ id: "msg_1", code: "424242", text: "Your code is 424242", received_at: "2026-07-01T13:00:00Z" }],
    })));
    const res = await getDedicatedNumberHandler(toolContext(http))({ number_id: "ded_abc123" });
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("+4915123456789");
    expect(t.text).toContain('code="424242"');
    expect(t.text).toContain("UNTRUSTED SMS TEXT");
    expect(res.structuredContent?.dedicated_number).toMatchObject({ id: "ded_abc123" });
  });

  it("rejects non-ded_ ids without calling the API", async () => {
    const http = createMockHttpClient();
    const res = await getDedicatedNumberHandler(toolContext(http))({ number_id: "ren_abc" });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(0);
  });
});

describe("purchase_dedicated_number", () => {
  const catalog = [
    dedCountryFixture({ country: "us", name: "United States", quoted_price_cents: 1999, base_price_cents: 1999 }),
    dedCountryFixture({ country: "uk", name: "United Kingdom", quoted_price_cents: 1699, base_price_cents: 1699 }),
    dedCountryFixture({ country: "hk", name: "Hong Kong", quoted_price_cents: 2699, base_price_cents: 2699, in_stock: false }),
  ];

  it("resolves country by code, sends the caller's max_price_cents and an idempotency key", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    http.expect("POST", "/v1/dedicated/numbers", { status: 201, headers: new Headers(), body: { success: true, data: dedNumberFixture({ country: "uk", country_name: "United Kingdom", charged_price_cents: 1699 }) } });
    const ctx = toolContext(http, { budgetCents: 5000 });
    const res = await purchaseDedicatedNumberHandler(ctx)({ country: "UK", max_price_cents: 1800 });
    expect(res.isError).toBeFalsy();
    expect(http.history[1].body).toEqual({ country: "uk", auto_renew: false, max_price_cents: 1800 });
    expect(http.history[1].headers["Idempotency-Key"]).toBeTruthy();
    expect(ctx.guard.countedCents).toBe(1699);
  });

  it("listed price above max_price_cents -> refused with the new price, no purchase call", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    const res = await purchaseDedicatedNumberHandler(toolContext(http))({ country: "us", max_price_cents: 1500 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("$19.99");
    expect(t.text).toContain("max_price_cents=1999");
    expect(http.history).toHaveLength(1);
  });

  it("resolves country by name substring", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    http.expect("POST", "/v1/dedicated/numbers", { status: 201, headers: new Headers(), body: { success: true, data: dedNumberFixture({ country: "us", country_name: "United States" }) } });
    const res = await purchaseDedicatedNumberHandler(toolContext(http))({ country: "united sta", auto_renew: true, max_price_cents: 1999 });
    expect(res.isError).toBeFalsy();
    expect(http.history[1].body).toMatchObject({ country: "us", auto_renew: true });
  });

  it("unknown country -> toolError listing available codes, no purchase call", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    const res = await purchaseDedicatedNumberHandler(toolContext(http))({ country: "france", max_price_cents: 1999 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("us (United States), uk (United Kingdom), hk (Hong Kong)");
    expect(http.history).toHaveLength(1);
  });

  it("a 2-letter code matches codes only: an unavailable 'at' never becomes United St-at-es", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    const res = await purchaseDedicatedNumberHandler(toolContext(http))({ country: "at", max_price_cents: 5000 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
  });

  it("a name matching several countries asks for the code instead of guessing", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    const res = await purchaseDedicatedNumberHandler(toolContext(http))({ country: "united", max_price_cents: 5000 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("matches several countries (us, uk)");
    expect(http.history).toHaveLength(1);
  });

  it("auto_renew=true with a session budget is refused before anything happens", async () => {
    const http = createMockHttpClient();
    const res = await purchaseDedicatedNumberHandler(toolContext(http, { budgetCents: 10_000 }))({ country: "us", auto_renew: true, max_price_cents: 1999 });
    expect(res.isError).toBe(true);
    const t = res.content[0]; if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("auto_renew=false");
    expect(http.history).toHaveLength(0);
  });

  it("out-of-stock country -> toolError, no purchase call", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/dedicated/countries", okBody(catalog));
    const res = await purchaseDedicatedNumberHandler(toolContext(http))({ country: "hk", max_price_cents: 2699 });
    expect(res.isError).toBe(true);
    expect(http.history).toHaveLength(1);
  });
});

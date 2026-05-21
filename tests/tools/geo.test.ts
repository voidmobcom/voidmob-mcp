import { describe, it, expect } from "vitest";
import { getGeoHandler } from "../../src/tools/geo.js";
import { createMockHttpClient } from "../../src/testing/mock-http.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function countryFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return { code: "US", name: "United States", available_nodes: 1234, ...overrides };
}

function regionFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return { code: "California", name: "California", available_nodes: 250, ...overrides };
}

function cityFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return { code: "Los Angeles", name: "Los Angeles", available_nodes: 80, ...overrides };
}

function ispFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return { name: "Comcast", available_nodes: 12, ...overrides };
}

// ── get_geo ────────────────────────────────────────────────────────────────

describe("get_geo", () => {
  it("with no params hits /v1/geo and renders countries", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/geo", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { countries: [countryFixture(), countryFixture({ code: "GB", name: "United Kingdom", available_nodes: 500 })] },
      },
    });
    const res = await getGeoHandler(http)({});
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("2 countries");
    expect(t.text).toContain("United States");
    expect(t.text).toContain("United Kingdom");
    expect(t.text).toContain("(US)");
    const countries = res.structuredContent?.countries as Array<Record<string, unknown>>;
    expect(countries).toHaveLength(2);
    expect(countries[0]).toMatchObject({ code: "US", name: "United States", available_nodes: 1234 });
  });

  it("with country=US hits /v1/geo?country=US and renders regions", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/geo?country=US", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { regions: [regionFixture()] },
      },
    });
    const res = await getGeoHandler(http)({ country: "US" });
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("1 regions");
    expect(t.text).toContain("California");
    const regions = res.structuredContent?.regions as Array<Record<string, unknown>>;
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ code: "California", available_nodes: 250 });
  });

  it("with country + region hits cascading geo and renders cities", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/geo?country=US&region=California", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { cities: [cityFixture(), cityFixture({ code: "San Francisco", name: "San Francisco", available_nodes: 45 })] },
      },
    });
    const res = await getGeoHandler(http)({ country: "US", region: "California" });
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("2 cities");
    expect(t.text).toContain("Los Angeles");
    expect(t.text).toContain("San Francisco");
    const cities = res.structuredContent?.cities as Array<Record<string, unknown>>;
    expect(cities).toHaveLength(2);
  });

  it("with country + region + city hits cascading geo and renders ISPs", async () => {
    const http = createMockHttpClient();
    // URLSearchParams encodes spaces as '+'
    http.expect("GET", "/v1/geo?country=US&region=California&city=Los+Angeles", {
      status: 200,
      headers: new Headers(),
      body: {
        success: true,
        data: { isps: [ispFixture(), ispFixture({ name: "AT&T", available_nodes: 7 })] },
      },
    });
    const res = await getGeoHandler(http)({ country: "US", region: "California", city: "Los Angeles" });
    expect(res.isError).toBeFalsy();
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("2 ISP(s)");
    expect(t.text).toContain("Comcast");
    expect(t.text).toContain("AT&T");
    const isps = res.structuredContent?.isps as Array<Record<string, unknown>>;
    expect(isps).toHaveLength(2);
    expect(isps[0]).toMatchObject({ name: "Comcast", available_nodes: 12 });
  });

  it("propagates request_id on 4xx error", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/geo?country=ZZ", {
      status: 400,
      headers: new Headers(),
      body: {
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Unknown country code.",
          request_id: "req_geo_4xx",
        },
      },
    });
    const res = await getGeoHandler(http)({ country: "ZZ" });
    expect(res.isError).toBe(true);
    const t = res.content[0];
    if (t.type !== "text") throw new Error("text");
    expect(t.text).toContain("req_geo_4xx");
    expect(t.text).toContain("Unknown country code");
  });
});

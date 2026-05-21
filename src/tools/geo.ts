// src/tools/geo.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { GeoCountry, GeoRegion, GeoCity, GeoIsp } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";

export const getGeoHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { country?: string; region?: string; city?: string }): Promise<ToolResult> => {
    const q = new URLSearchParams();
    if (args.country) q.set("country", args.country);
    if (args.region) q.set("region", args.region);
    if (args.city) q.set("city", args.city);
    const path = `/v1/geo${q.toString() ? `?${q}` : ""}`;
    const data = await callApi<Record<string, unknown[]>>(http, "GET", path);

    if (data.isps) {
      const isps = z.array(GeoIsp).parse(data.isps);
      return structuredOk(
        `${isps.length} ISP(s):\n${isps.map((i) => `  ${i.name} (${i.available_nodes} nodes)`).join("\n")}`,
        { isps },
      );
    }
    if (data.cities) {
      const cities = z.array(GeoCity).parse(data.cities);
      return structuredOk(
        `${cities.length} cities:\n${cities.map((c) => `  ${c.name} (${c.code}) ${c.available_nodes} nodes`).join("\n")}`,
        { cities },
      );
    }
    if (data.regions) {
      const regions = z.array(GeoRegion).parse(data.regions);
      return structuredOk(
        `${regions.length} regions:\n${regions.map((r) => `  ${r.name} (${r.code}) ${r.available_nodes} nodes`).join("\n")}`,
        { regions },
      );
    }
    if (data.countries) {
      const countries = z.array(GeoCountry).parse(data.countries);
      return structuredOk(
        `${countries.length} countries:\n${countries.map((c) => `  ${c.name} (${c.code}) ${c.available_nodes} nodes`).join("\n")}`,
        { countries },
      );
    }
    return toolError("Unexpected geo response shape.");
  });

export function registerGeoTools(server: McpServer, http: HttpClient) {
  server.tool(
    "get_geo",
    "Cascading geo discovery for proxy list targeting. No params -> countries; country=US -> regions; country=US&region=California -> cities; +city=Los%20Angeles -> ISPs.",
    {
      country: z.string().optional().describe("ISO 3166-1 alpha-2 (e.g., US)"),
      region: z.string().optional(),
      city: z.string().optional(),
    },
    getGeoHandler(http),
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { GeoCountry, GeoRegion, GeoCity, GeoIsp } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";

interface GeoKind {
  key: "isps" | "cities" | "regions" | "countries";
  schema: z.ZodTypeAny;
  label: string;
  fmt: (item: never) => string;
}

const KINDS: ReadonlyArray<GeoKind> = [
  {
    key: "isps",
    schema: GeoIsp,
    label: "ISP(s)",
    fmt: ((i: z.infer<typeof GeoIsp>) => `  ${i.name} (${i.available_nodes} nodes)`) as (item: never) => string,
  },
  {
    key: "cities",
    schema: GeoCity,
    label: "cities",
    fmt: ((c: z.infer<typeof GeoCity>) => `  ${c.name} (${c.available_nodes} nodes)`) as (item: never) => string,
  },
  {
    key: "regions",
    schema: GeoRegion,
    label: "regions",
    fmt: ((r: z.infer<typeof GeoRegion>) => `  ${r.name} (${r.available_nodes} nodes)`) as (item: never) => string,
  },
  {
    key: "countries",
    schema: GeoCountry,
    label: "countries",
    fmt: ((c: z.infer<typeof GeoCountry>) => `  ${c.name} (${c.code}) ${c.available_nodes} nodes`) as (item: never) => string,
  },
];

export const getGeoHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { country?: string; region?: string; city?: string }): Promise<ToolResult> => {
    const q = new URLSearchParams();
    if (args.country) q.set("country", args.country);
    if (args.region) q.set("region", args.region);
    if (args.city) q.set("city", args.city);
    const path = `/v1/geo${q.toString() ? `?${q}` : ""}`;
    const data = await callApi<Record<string, unknown[]>>(http, "GET", path);

    for (const kind of KINDS) {
      if (data[kind.key]) {
        const items = z.array(kind.schema).parse(data[kind.key]);
        return structuredOk(
          `${items.length} ${kind.label}:\n${items.map((i) => kind.fmt(i as never)).join("\n")}`,
          { [kind.key]: items },
        );
      }
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

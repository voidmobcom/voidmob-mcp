import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { Rental, Esim, Proxy, DedicatedNumber } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";

interface OrderRow {
  kind: "sms" | "esim" | "proxy" | "dedicated";
  id: string;
  status: string;
  charged_price_cents: number;
  created_at: string;
  summary: string;
}

export const listOrdersHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { kind?: "sms" | "esim" | "proxy" | "dedicated"; limit?: number }): Promise<ToolResult> => {
    const limit = args.limit ?? 20;
    const warnings: string[] = [];
    const tasks: Promise<OrderRow[]>[] = [];
    if (!args.kind || args.kind === "sms") tasks.push(fetchRentals(http));
    if (!args.kind || args.kind === "esim") tasks.push(fetchEsims(http));
    if (!args.kind || args.kind === "proxy") tasks.push(fetchProxies(http));
    if (!args.kind || args.kind === "dedicated") tasks.push(fetchDedicated(http, warnings));
    const settled = await Promise.allSettled(tasks);
    const rows: OrderRow[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") rows.push(...r.value);
      else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        warnings.push(`(partial: ${msg})`);
      }
    }
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const page = rows.slice(0, limit);
    if (page.length === 0) {
      // Distinguish a genuinely empty account from a fan-out where every
      // branch failed (e.g. a schema mismatch throwing out of every fetch).
      // Surfacing the warnings avoids the misleading "No orders found."
      if (warnings.length > 0) {
        return toolError(`Could not load orders. ${warnings.join(" ")}`);
      }
      return toolError("No orders found.");
    }
    const text = [
      `${rows.length} order(s)${rows.length > limit ? ` (showing ${limit})` : ""}:`,
      ``,
      ...page.map(
        (r) =>
          // 9 = "dedicated".length, the longest kind - keep in sync with OrderRow["kind"]
          `  [${r.kind.toUpperCase().padEnd(9)}] ${r.id.padEnd(20)} ${r.status.padEnd(14)} ${formatUsd(r.charged_price_cents).padStart(8)} ${r.created_at.slice(0, 16)}  ${r.summary}`,
      ),
      warnings.length ? `\n${warnings.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return structuredOk(text, { orders: page });
  });

async function fetchRentals(http: HttpClient): Promise<OrderRow[]> {
  const data = await callApi<unknown[]>(http, "GET", "/v1/rentals");
  const items = z.array(Rental).parse(data);
  return items.map((r) => ({
    kind: "sms" as const,
    id: r.id,
    status: r.status,
    charged_price_cents: r.charged_price_cents,
    created_at: r.created_at,
    summary: `${r.service_name} ${r.phone_number} ${r.duration ?? ""}`,
  }));
}

async function fetchEsims(http: HttpClient): Promise<OrderRow[]> {
  const data = await callApi<{ esims: unknown[] }>(http, "GET", "/v1/esims");
  const items = z.array(Esim).parse(data.esims);
  return items.map((e) => ({
    kind: "esim" as const,
    id: e.id,
    status: e.status,
    charged_price_cents: e.charged_price_cents,
    created_at: e.created_at,
    summary: `${e.countries.join(",")} ${e.data_unlimited || e.data_limit_gb == null ? "unlim" : `${e.data_limit_gb}GB`}`,
  }));
}

async function fetchProxies(http: HttpClient): Promise<OrderRow[]> {
  const data = await callApi<{ proxies: unknown[] }>(http, "GET", "/v1/proxies");
  const items = z.array(Proxy).parse(data.proxies);
  return items.map((p) => ({
    kind: "proxy" as const,
    id: p.id,
    status: p.status,
    charged_price_cents: p.charged_price_cents,
    created_at: p.created_at ?? "",
    summary: `${p.data_gb_total}GB ${p.lists.length} list(s)`,
  }));
}

async function fetchDedicated(http: HttpClient, warnings: string[]): Promise<OrderRow[]> {
  // Pagination fields live outside `data`; 100 is the API's max page size.
  const data = await callApi<unknown[]>(http, "GET", "/v1/dedicated/numbers?limit=100");
  const items = z.array(DedicatedNumber).parse(data);
  if (items.length === 100) warnings.push("(dedicated: only the newest 100 numbers are shown)");
  return items.map((d) => ({
    kind: "dedicated" as const,
    id: d.id,
    status: d.status,
    charged_price_cents: d.charged_price_cents,
    created_at: d.created_at,
    summary: `${d.country_name} ${d.phone_number} monthly`,
  }));
}

export function registerOrdersTools(server: McpServer, http: HttpClient) {
  server.tool(
    "list_orders",
    "List the user's active and past orders across SMS rentals, dedicated numbers, eSIMs, and proxies. Note: ephemeral verifications (20-min single-SMS) are NOT listable - the rental id you got from rent_number is your handle to them.",
    {
      kind: z.enum(["sms", "esim", "proxy", "dedicated"]).optional().describe("Filter by kind"),
      limit: z.number().min(1).max(100).default(20),
    },
    listOrdersHandler(http),
  );
}

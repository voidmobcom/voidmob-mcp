import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { mapApiError } from "../client/errors.js";
import { Rental, Esim, Proxy, DedicatedNumber, Verification } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";
import { READ_ONLY } from "../utils/annotations.js";

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
    if (!args.kind || args.kind === "sms") tasks.push(fetchRentals(http), fetchVerifications(http));
    if (!args.kind || args.kind === "esim") tasks.push(fetchEsims(http));
    if (!args.kind || args.kind === "proxy") tasks.push(fetchProxies(http));
    if (!args.kind || args.kind === "dedicated") tasks.push(fetchDedicated(http, warnings));
    const settled = await Promise.allSettled(tasks);
    const rows: OrderRow[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") rows.push(...r.value);
      else {
        // White-labeled copy for API errors; never raw parser output.
        const msg = r.reason instanceof HttpError || r.reason instanceof NetworkError ? mapApiError(r.reason) : "unexpected response";
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
      return structuredOk(
        args.kind ? `No ${args.kind} orders found.` : "No orders found.",
        { orders: [] },
      );
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

// Newest page of one-time verifications - the recovery path for a purchase
// whose response was lost.
async function fetchVerifications(http: HttpClient): Promise<OrderRow[]> {
  const data = await callApi<unknown[]>(http, "GET", "/v1/verifications");
  const items = z.array(Verification).parse(data);
  return items.map((v) => ({
    kind: "sms" as const,
    id: v.id,
    status: v.status,
    charged_price_cents: v.charged_price_cents,
    created_at: v.created_at,
    summary: `${v.service_name} ${v.phone_number} verification`,
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
    summary: p.type === "dedicated_standard" || p.type === "dedicated_premium"
      ? `dedicated ${[p.country?.toUpperCase(), p.carrier].filter(Boolean).join(" ")}`.trim()
      : `${p.data_gb_total}GB ${p.lists.length} list(s)`,
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
  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List your most recent orders, newest first, across SMS verifications (ver_...) and long-term rentals (ren_...), dedicated numbers (ded_...), eSIMs (esim_...) and proxies (prx_...), with status and price. " +
        "Reads the newest page of each kind (not a full history). Use it to find an order whose purchase result was lost before buying again; " +
        "then use the matching get tool with its id for details.",
      inputSchema: {
        kind: z.enum(["sms", "esim", "proxy", "dedicated"]).optional().describe("Filter by kind (sms = verifications and long-term rentals)"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_ONLY,
    },
    listOrdersHandler(http),
  );
}

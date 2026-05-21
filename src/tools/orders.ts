// src/tools/orders.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { Rental, Esim, Proxy } from "../client/types.js";
import { mapApiError } from "../client/errors.js";
import { structuredOk, toolError, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";

interface OrderRow {
  kind: "sms" | "esim" | "proxy";
  id: string;
  status: string;
  charged_price_cents: number;
  created_at: string;
  summary: string;
}

export const listOrdersHandler = (http: HttpClient) =>
  async (args: { kind?: "sms" | "esim" | "proxy"; limit?: number }): Promise<ToolResult> => {
    const limit = args.limit ?? 20;
    try {
      const tasks: Promise<OrderRow[]>[] = [];
      if (!args.kind || args.kind === "sms") tasks.push(fetchRentals(http));
      if (!args.kind || args.kind === "esim") tasks.push(fetchEsims(http));
      if (!args.kind || args.kind === "proxy") tasks.push(fetchProxies(http));
      const settled = await Promise.allSettled(tasks);
      const rows: OrderRow[] = [];
      const warnings: string[] = [];
      for (const r of settled) {
        if (r.status === "fulfilled") rows.push(...r.value);
        else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          warnings.push(`(partial: ${msg})`);
        }
      }
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const page = rows.slice(0, limit);
      if (page.length === 0) return toolError("No orders found.");
      const text = [
        `${rows.length} order(s)${rows.length > limit ? ` (showing ${limit})` : ""}:`,
        ``,
        ...page.map(
          (r) =>
            `  [${r.kind.toUpperCase().padEnd(5)}] ${r.id.padEnd(20)} ${r.status.padEnd(14)} ${formatUsd(r.charged_price_cents).padStart(8)} ${r.created_at.slice(0, 16)}  ${r.summary}`,
        ),
        warnings.length ? `\n${warnings.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return structuredOk(text, { orders: page });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

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
    summary: `${e.plan_title} ${e.countries.join(",")} ${e.data_unlimited ? "unlim" : `${e.data_gb_total}GB`}`,
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
    summary: `${p.type ?? ""} ${p.country ?? ""}`,
  }));
}

export function registerOrdersTools(server: McpServer, http: HttpClient) {
  server.tool(
    "list_orders",
    "List the user's active and past orders across SMS rentals, eSIMs, and proxies. Note: ephemeral verifications (20-min single-SMS) are NOT listable - the rental id you got from rent_number is your handle to them.",
    {
      kind: z.enum(["sms", "esim", "proxy"]).optional().describe("Filter by kind"),
      limit: z.number().min(1).max(100).default(20),
    },
    listOrdersHandler(http),
  );
}

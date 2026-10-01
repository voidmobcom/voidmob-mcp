import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpError, NetworkError } from "../client/http.js";
import { callApi, callApiPage } from "../client/call-api.js";
import { mapApiError } from "../client/errors.js";
import { Rental, Esim, Proxy, DedicatedNumber, Verification } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";
import { READ_ONLY } from "../utils/annotations.js";
import { outputObject } from "../utils/output.js";
import { defineTool, type ToolContext } from "./context.js";

/** One paginated v1 list per kind. */
export const ORDER_KINDS = ["verification", "rental", "dedicated", "esim", "proxy"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** Status filters each list accepts (v1 query `status`). */
export const KIND_STATUSES: Record<OrderKind, readonly string[]> = {
  verification: ["waiting_for_code", "code_received", "cancelled", "expired"],
  rental: ["active", "expired", "cancelled"],
  dedicated: ["active", "expired"],
  esim: ["processing", "completed", "cancelled", "refunded", "expired"],
  proxy: ["provisioning", "active", "expired", "exhausted", "refunded"],
};

// Only verifications are listed newest first; the other lists page in a
// stable id order that is not by date.
const ORDERING: Record<OrderKind, string> = {
  verification: "newest first",
  rental: "not in date order",
  dedicated: "not in date order",
  esim: "not in date order",
  proxy: "not in date order",
};

const OrderRow = z.object({
  kind: z.enum(ORDER_KINDS),
  id: z.string(),
  status: z.string(),
  charged_price_cents: z.number().int(),
  created_at: z.string(),
  summary: z.string(),
});
type OrderRow = z.infer<typeof OrderRow>;

interface Page {
  rows: OrderRow[];
  nextCursor: string | null;
}

// The overview reads this many rows per list (the API maximum) and shows the
// newest few: every list except verifications is in id order, not by date, so
// a small page would be an arbitrary sample, useless for finding a purchase
// whose result was lost.
const OVERVIEW_READ = 100;

export const ListOrdersOutput = outputObject({
  orders: z.array(OrderRow),
  // With kind: the cursor for the next page of that list (null = last page).
  next_cursor: z.string().nullable().optional(),
  // Without kind: lists with more orders than the overview read, so their
  // newest may be missing (page through them with kind).
  incomplete_kinds: z.array(z.enum(ORDER_KINDS)).optional(),
  // Lists that could not be read, as agent-readable notes.
  partial: z.array(z.string()).optional(),
});

function query(limit: number, status?: string, cursor?: string): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (status) q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

async function fetchKind(ctx: ToolContext, kind: OrderKind, limit: number, status?: string, cursor?: string): Promise<Page> {
  const qs = query(limit, status, cursor);
  switch (kind) {
    case "verification": {
      const page = await callApiPage<unknown[]>(ctx.http, `/v1/verifications?${qs}`);
      return {
        nextCursor: page.nextCursor,
        rows: z.array(Verification).parse(page.data).map((v) => ({
          kind, id: v.id, status: v.status, charged_price_cents: v.charged_price_cents, created_at: v.created_at,
          summary: `${v.service_name} ${v.phone_number} verification`,
        })),
      };
    }
    case "rental": {
      const page = await callApiPage<unknown[]>(ctx.http, `/v1/rentals?${qs}`);
      return {
        nextCursor: page.nextCursor,
        rows: z.array(Rental).parse(page.data).map((r) => ({
          kind, id: r.id, status: r.status, charged_price_cents: r.charged_price_cents, created_at: r.created_at,
          summary: `${r.service_name} ${r.phone_number} ${r.duration ?? ""}`.trim(),
        })),
      };
    }
    case "dedicated": {
      const page = await callApiPage<unknown[]>(ctx.http, `/v1/dedicated/numbers?${qs}`);
      return {
        nextCursor: page.nextCursor,
        rows: z.array(DedicatedNumber).parse(page.data).map((d) => ({
          kind, id: d.id, status: d.status, charged_price_cents: d.charged_price_cents, created_at: d.created_at,
          summary: `${d.country_name} ${d.phone_number} monthly`,
        })),
      };
    }
    case "esim": {
      const data = await callApi<{ esims: unknown[]; next_cursor?: string | null }>(ctx.http, "GET", `/v1/esims?${qs}`);
      return {
        nextCursor: data.next_cursor ?? null,
        rows: z.array(Esim).parse(data.esims).map((e) => ({
          kind, id: e.id, status: e.status, charged_price_cents: e.charged_price_cents, created_at: e.created_at,
          summary: `${e.is_topup ? "top-up " : ""}${e.countries.length > 3 ? `${e.countries.slice(0, 3).join(",")} +${e.countries.length - 3}` : e.countries.join(",")} ${e.data_unlimited || e.data_limit_gb == null ? "unlim" : `${e.data_limit_gb}GB`}`,
        })),
      };
    }
    case "proxy": {
      const data = await callApi<{ proxies: unknown[]; next_cursor?: string | null }>(ctx.http, "GET", `/v1/proxies?${qs}`);
      return {
        nextCursor: data.next_cursor ?? null,
        rows: z.array(Proxy).parse(data.proxies).map((p) => ({
          kind, id: p.id, status: p.status, charged_price_cents: p.charged_price_cents, created_at: p.created_at ?? "",
          summary: p.type === "dedicated_standard" || p.type === "dedicated_premium"
            ? `dedicated ${[p.country?.toUpperCase(), p.carrier].filter(Boolean).join(" ")}`.trim()
            : `${p.data_gb_total}GB ${p.lists.length} list(s)`,
        })),
      };
    }
  }
}

function rowLine(r: OrderRow): string {
  // 12 = "verification".length, the longest kind
  return `  [${r.kind.toUpperCase().padEnd(12)}] ${r.id.padEnd(24)} ${r.status.padEnd(16)} ${formatUsd(r.charged_price_cents).padStart(8)} ${r.created_at.slice(0, 16)}  ${r.summary}`;
}

const newestFirst = (a: OrderRow, b: OrderRow) => b.created_at.localeCompare(a.created_at);

const failureNote = (kind: OrderKind, e: unknown): string =>
  `${kind}: could not be read (${e instanceof HttpError || e instanceof NetworkError ? mapApiError(e) : "unexpected response"})`;

export const listOrdersHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { kind?: OrderKind | "sms"; status?: string; cursor?: string; limit?: number }): Promise<ToolResult> => {
    const single = args.kind && args.kind !== "sms" ? args.kind : undefined;
    if ((args.status || args.cursor) && !single) {
      return toolError(
        `status and cursor apply to one list: also pass kind (${ORDER_KINDS.join(", ")}).`,
      );
    }

    if (single) {
      const allowed = KIND_STATUSES[single];
      if (args.status && !allowed.includes(args.status)) {
        return toolError(`status '${args.status}' is not valid for kind '${single}'. Use one of: ${allowed.join(", ")}.`);
      }
      const page = await fetchKind(ctx, single, args.limit ?? 20, args.status, args.cursor);
      const rows = [...page.rows].sort(newestFirst);
      const filter = args.status ? ` with status ${args.status}` : "";
      const text = rows.length === 0
        ? `No ${single} orders${filter}${args.cursor ? " on this page" : ""}.`
        : [
            `${rows.length} ${single} order(s)${filter} on this page (${ORDERING[single]} across pages; sorted by date within the page):`,
            ``,
            ...rows.map(rowLine),
            ...(page.nextCursor
              ? [``, `More: call list_orders with kind='${single}'${args.status ? `, status='${args.status}'` : ""} and cursor='${page.nextCursor}'.`]
              : [``, `This is the last page.`]),
          ].join("\n");
      return structuredOk(text, { orders: rows, next_cursor: page.nextCursor });
    }

    // Overview: the newest orders of each list, grouped by kind.
    const kinds: OrderKind[] = args.kind === "sms" ? ["verification", "rental"] : [...ORDER_KINDS];
    const perKind = args.limit ?? 5;
    const settled = await Promise.allSettled(kinds.map((k) => fetchKind(ctx, k, OVERVIEW_READ)));
    const orders: OrderRow[] = [];
    const incomplete: OrderKind[] = [];
    const partial: string[] = [];
    const sections: string[] = [];
    settled.forEach((result, i) => {
      const kind = kinds[i];
      if (result.status === "rejected") {
        partial.push(failureNote(kind, result.reason));
        return;
      }
      const rows = [...result.value.rows].sort(newestFirst).slice(0, perKind);
      orders.push(...rows);
      const more = result.value.nextCursor !== null;
      if (more) incomplete.push(kind);
      if (rows.length === 0) return;
      sections.push(
        ``,
        `${kind} (newest ${rows.length}${more ? ` of the first ${OVERVIEW_READ} read; there are more, so newer ones may be missing - page through with kind='${kind}'` : ""}):`,
        ...rows.map(rowLine),
      );
    });
    if (orders.length === 0 && partial.length === kinds.length) {
      return toolError(`Could not load orders. ${partial.join(" ")}`);
    }
    const text = [
      orders.length === 0
        ? args.kind === "sms" ? "No SMS orders found." : "No orders found."
        : `Newest orders, up to ${perKind} per kind (pass kind, status and cursor to page through one list):`,
      ...sections,
      ...(partial.length ? [``, ...partial.map((p) => `(partial) ${p}`)] : []),
    ].join("\n");
    return structuredOk(text, {
      orders,
      ...(incomplete.length ? { incomplete_kinds: incomplete } : {}),
      ...(partial.length ? { partial } : {}),
    });
  });

export function registerOrdersTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, "list_orders", {
    group: "core",
    writes: false,
    title: "List orders",
    description:
      "List your orders: SMS verifications (ver_...), long-term rentals (ren_...), dedicated numbers (ded_...), eSIMs (esim_...) and proxies (prx_...), with status and price. " +
      "Without kind: the newest orders of every list. With kind: one page of that list, optionally filtered by status, with a cursor for the next page " +
      "(only verifications are paged newest first). Use it to find an order whose purchase result was lost before buying again (e.g. kind='verification', status='waiting_for_code'), " +
      "then the matching get tool for details. " +
      `Statuses - verification: ${KIND_STATUSES.verification.join("/")}; rental: ${KIND_STATUSES.rental.join("/")}; dedicated: ${KIND_STATUSES.dedicated.join("/")}; ` +
      `esim: ${KIND_STATUSES.esim.join("/")}; proxy: ${KIND_STATUSES.proxy.join("/")}.`,
    inputSchema: {
      kind: z.enum([...ORDER_KINDS, "sms"]).optional().describe("One list to page through ('sms' = the first page of verifications and rentals)"),
      status: z.string().max(40).optional().describe("With kind: only orders in this status (see the description for each kind's statuses)"),
      cursor: z.string().max(200).optional().describe("With kind: next_cursor from the previous page of the same list"),
      limit: z.number().int().min(1).max(100).optional().describe("With kind: page size (default 20). Without kind: newest orders shown per kind (default 5)"),
    },
    outputSchema: ListOrdersOutput,
    annotations: READ_ONLY,
  }, listOrdersHandler(ctx));
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { path } from "../client/path.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { EsimProduct, Esim, EsimUsage, type Esim as EsimT, type EsimUsage as EsimUsageT } from "../client/types.js";
import { structuredOk, structuredWithImage, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd, formatData } from "../utils/format.js";
import { READ_ONLY, SPENDS } from "../utils/annotations.js";
import { outputObject } from "../utils/output.js";
import { EsimId, EsimProductId } from "../constants/ids.js";
import { MaxPriceCents } from "../constants/price.js";
import { defineTool, type ToolContext } from "./context.js";

// ── search_esim_plans ───────────────────────────────────────────────────────

export const SearchEsimPlansOutput = outputObject({ esim_plans: z.array(EsimProduct), next_cursor: z.string().nullable() });

export const searchEsimPlansHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: {
    country?: string;
    min_data_gb?: number;
    min_days?: number;
    has_5g?: boolean;
    has_hotspot?: boolean;
    query?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ToolResult> => {
    const q = new URLSearchParams();
    // The API filter is `countries` (plans covering any listed code).
    if (args.country) q.set("countries", args.country.trim().toUpperCase());
    if (args.min_data_gb !== undefined) q.set("min_data_gb", String(args.min_data_gb));
    // API param is min_validity_days (not min_days); has_5g is server-side.
    if (args.min_days !== undefined) q.set("min_validity_days", String(args.min_days));
    if (args.has_5g !== undefined) q.set("has_5g", String(args.has_5g));
    if (args.query) q.set("search", args.query);
    q.set("limit", String(args.limit ?? 20));
    if (args.cursor) q.set("cursor", args.cursor);

    const data = await callApi<{ products: unknown[]; next_cursor: string | null }>(
      ctx.http,
      "GET",
      `/v1/esim_products?${q.toString()}`,
    );
    let products = z.array(EsimProduct).parse(data.products);
    // has_hotspot is not a server-side filter, so apply it to the returned page
    // (rather than silently ignoring it as the query param did before).
    if (args.has_hotspot !== undefined) {
      products = products.filter((p) => p.features.has_hotspot === args.has_hotspot);
    }
    if (products.length === 0) {
      return structuredOk(
        data.next_cursor
          ? "No plans on this page matched your filters. More plans are available - pass cursor to see the next page."
          : "No eSIM plans matched your filters. Try fewer filters or a region search (e.g. query='Europe').",
        { esim_plans: [], next_cursor: data.next_cursor },
      );
    }
    const text = [
      `Found ${products.length} eSIM plan(s)${data.next_cursor ? " (more available - pass cursor to paginate)" : ""}:`,
      ...products.map((p) =>
        [
          ``,
          `  ${p.title} (${p.id})`,
          `    Countries:  ${p.countries.join(", ")}`,
          `    Data:       ${formatData(p.data_limit_gb, p.data_unlimited)}`,
          `    Validity:   ${p.validity_days} days`,
          `    Price:      ${formatUsd(p.price_cents)}`,
          `    5G/Hotspot: ${p.features.has_5g ? "yes" : "no"} / ${p.features.has_hotspot ? "yes" : "no"}`,
        ].join("\n"),
      ),
    ].join("\n");
    return structuredOk(text, { esim_plans: products, next_cursor: data.next_cursor });
  });

// ── install details ─────────────────────────────────────────────────────────

/** Manual-install lines: SM-DP+ address, activation code and the LPA string built from them. */
function installLines(esim: EsimT): string[] {
  if (!esim.activation_code) return [`  Install:        (pending - poll get_esim_status until status is completed)`];
  const lpa = esim.activation_code.startsWith("LPA:")
    ? esim.activation_code
    : esim.smdp_address
      ? `LPA:1$${esim.smdp_address}$${esim.activation_code}`
      : null;
  return [
    ...(esim.smdp_address ? [`  SM-DP+ address: ${esim.smdp_address}`] : []),
    `  Activation code: ${esim.activation_code}`,
    ...(lpa ? [`  LPA string:     ${lpa}`] : []),
    `  Install:        scan the QR from get_esim_qr, or enter the LPA string (or SM-DP+ address + activation code) manually`,
  ];
}

// ── purchase_esim ───────────────────────────────────────────────────────────

export const EsimOrderOutput = outputObject({ esim: Esim });

export const purchaseEsimHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { plan_id: string; max_price_cents: number }): Promise<ToolResult> => {
    const max = args.max_price_cents;
    // The API enforces max_price_cents: above it, PRICE_OVER_CAP and no charge.
    const esim = await ctx.guard.run(max, async () => {
      const out = await callApi<{ esim: unknown }>(ctx.http, "POST", "/v1/esims", {
        body: { product_id: args.plan_id, max_price_cents: max },
        idempotencyKey: newIdempotencyKey(),
      });
      const value = Esim.parse(out.esim);
      return { value, chargedCents: value.charged_price_cents };
    });
    const text = [
      `eSIM purchased: ${esim.id}`,
      ``,
      `  Plan:           ${args.plan_id}`,
      `  Status:         ${esim.status}`,
      `  Countries:      ${esim.countries.join(", ")}`,
      `  Data:           ${formatData(esim.data_limit_gb, esim.data_unlimited)}`,
      `  Validity:       ${esim.validity_days} days`,
      `  Charged:        ${formatUsd(esim.charged_price_cents)}`,
      `  ICCID:          ${esim.iccid ?? "(pending)"}`,
      ...installLines(esim),
      ``,
      esim.status === "processing"
        ? `Still processing - poll get_esim_status(esim_id="${esim.id}") until status is completed, then get_esim_qr for the QR image.`
        : `Use get_esim_qr(esim_id="${esim.id}") to fetch the QR code as an image.`,
    ].join("\n");
    return structuredOk(text, { esim });
  });

// ── get_esim_status ─────────────────────────────────────────────────────────

const mb = (n: number): string => `${n.toFixed(0)} MB`;

/** Every package on the eSIM (base plan + top-ups), then an eSIM-level total. */
function usageLines(usage: EsimUsageT | null): string[] {
  if (!usage || usage.packages.length === 0) return [`  Usage:       (not yet available)`];
  const lines = [`  Usage (${usage.packages.length} package${usage.packages.length === 1 ? "" : "s"}):`];
  usage.packages.forEach((p, i) => {
    const window = [p.activation_date?.slice(0, 10), p.expiration_date?.slice(0, 10)].filter(Boolean).join(" to ");
    lines.push(
      `    Package ${i + 1}: ${mb(p.used_mb)} / ${mb(p.total_mb)} used (${p.percent_used}%), ${mb(p.remaining_mb)} left${window ? `, ${window}` : ""}`,
    );
  });
  const used = usage.packages.reduce((s, p) => s + p.used_mb, 0);
  const total = usage.packages.reduce((s, p) => s + p.total_mb, 0);
  const remaining = usage.packages.reduce((s, p) => s + p.remaining_mb, 0);
  lines.push(`    Total:     ${mb(used)} / ${mb(total)} used, ${mb(remaining)} left`);
  return lines;
}

export const EsimStatusOutput = outputObject({ esim: Esim, usage: EsimUsage.nullable() });

export const getEsimStatusHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { esim_id: string }): Promise<ToolResult> => {
    // Usage is best-effort enrichment on a read path: degrade to null on ANY
    // API/network error so a transient usage-subservice failure never sinks the
    // core eSIM status read. Non-API throws (bugs) still propagate.
    const [esimRaw, usageRaw] = await Promise.all([
      callApi<{ esim: unknown }>(ctx.http, "GET", path`/v1/esims/${args.esim_id}`),
      callApi<{ usage: unknown }>(ctx.http, "GET", path`/v1/esims/${args.esim_id}/usage`).catch((e) => {
        if (e instanceof HttpError || e instanceof NetworkError) return null;
        throw e;
      }),
    ]);
    const esim = Esim.parse(esimRaw.esim);
    const usage = usageRaw ? EsimUsage.parse(usageRaw.usage) : null;
    const text = [
      `eSIM ${esim.id}`,
      ``,
      `  Countries:   ${esim.countries.join(", ")}`,
      `  Data:        ${formatData(esim.data_limit_gb, esim.data_unlimited)}`,
      `  Status:      ${esim.status}`,
      `  Validity:    ${esim.validity_days} days`,
      `  Expires:     ${esim.expires_at ?? "(not yet activated)"}`,
      ...usageLines(usage),
      ...(esim.is_topup ? [] : ["", ...installLines(esim)]),
    ].join("\n");
    return structuredOk(text, { esim, usage });
  });

// ── topup_esim ──────────────────────────────────────────────────────────────

export const TopupEsimOutput = outputObject({ topups: z.array(EsimProduct).optional(), esim: Esim.optional() });

export const topupEsimHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { esim_id: string; topup_product_id?: string; max_price_cents?: number }): Promise<ToolResult> => {
    if (!args.topup_product_id) {
      // Browse path
      const out = await callApi<{ supports_topup: boolean; topups: unknown[] }>(
        ctx.http,
        "GET",
        path`/v1/esims/${args.esim_id}/topups`,
      );
      if (!out.supports_topup || out.topups.length === 0) {
        return structuredOk(`No top-up products are available for ${args.esim_id}.`, { topups: [] });
      }
      const topups = z.array(EsimProduct).parse(out.topups);
      const text = [
        `Available top-ups for ${args.esim_id}:`,
        ``,
        ...topups.map(
          (t) =>
            `  ${t.title} (${t.id}) - ${formatData(t.data_limit_gb, t.data_unlimited)}, ${t.validity_days} days, ${formatUsd(t.price_cents)}`,
        ),
        ``,
        `To buy one, show the user its price, then call topup_esim again with topup_product_id and that price as max_price_cents.`,
      ].join("\n");
      return structuredOk(text, { topups });
    }
    const max = args.max_price_cents;
    if (max === undefined) {
      return toolError(
        "Buying a top-up charges your balance, so it needs max_price_cents: the top-up price (from topup_esim without topup_product_id) that you showed the user and they approved. Nothing was charged.",
      );
    }
    // The API enforces max_price_cents: above it, PRICE_OVER_CAP and no charge.
    const esim = await ctx.guard.run(max, async () => {
      const created = await callApi<{ esim: unknown }>(
        ctx.http,
        "POST",
        path`/v1/esims/${args.esim_id}/topups`,
        {
          body: { product_id: args.topup_product_id, max_price_cents: max },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      const value = Esim.parse(created.esim);
      return { value, chargedCents: value.charged_price_cents };
    });
    const text = [
      `Top-up ${esim.id} purchased on ${args.esim_id}.`,
      ``,
      `  Product:   ${args.topup_product_id}`,
      `  Data:      ${formatData(esim.data_limit_gb, esim.data_unlimited)}`,
      `  Validity:  ${esim.validity_days} days`,
      `  Charged:   ${formatUsd(esim.charged_price_cents)}`,
      ``,
      `The data is added to the same installed eSIM - nothing to reinstall. get_esim_status(esim_id="${args.esim_id}") shows every package.`,
    ].join("\n");
    return structuredOk(text, { esim });
  });

// ── get_esim_qr ─────────────────────────────────────────────────────────────

export const EsimQrOutput = outputObject({ esim_id: z.string() });

export const getEsimQrHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { esim_id: string }): Promise<ToolResult> => {
    const res = await ctx.http.request("GET", path`/v1/esims/${args.esim_id}/qr.png`, {
      expectBinary: true,
    });
    if (!res.binary) return toolError("QR fetch returned no binary payload.");
    const base64 = res.binary.toString("base64");
    return structuredWithImage(
      `QR code for eSIM ${args.esim_id}. Scan with your device camera to install.`,
      { esim_id: args.esim_id },
      { mimeType: "image/png", base64 },
    );
  });

// ── registration ────────────────────────────────────────────────────────────

export function registerEsimTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, "search_esim_plans", {
    group: "esim",
    writes: false,
    title: "Search eSIM plans",
    description:
      "Search prepaid eSIM data plans for travel by country or region: data allowance, validity, price, 5G, hotspot, calls/SMS and top-up support. " +
      "Results are paged - pass cursor for more. Next: show the user the plan and price, then purchase_esim with the prod_ id and that price as max_price_cents.",
    inputSchema: {
      country: z.string().regex(/^[A-Za-z]{2}$/, "Expected a 2-letter ISO country code").optional()
        .describe("ISO-3166 country code, any case (e.g. 'JP'): plans that cover this country"),
      min_data_gb: z.number().min(0).optional(),
      min_days: z.number().int().min(0).optional(),
      has_5g: z.boolean().optional(),
      has_hotspot: z.boolean().optional(),
      query: z.string().optional().describe("Substring search on plan title (e.g. 'Europe')"),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().optional(),
    },
    outputSchema: SearchEsimPlansOutput,
    annotations: READ_ONLY,
  }, searchEsimPlansHandler(ctx));

  defineTool(server, ctx, "purchase_esim", {
    group: "esim",
    writes: true,
    title: "Buy an eSIM",
    description:
      "Buy an eSIM data plan, charged to your balance immediately. It cannot be cancelled through this server once issued. " +
      "Requires max_price_cents: the price from search_esim_plans that you showed the user and they approved; if the price is now higher, nothing is charged and the new price comes back to re-confirm. " +
      "Returns the esim_ id with install details (LPA string, SM-DP+ address, activation code); if it is still processing, poll get_esim_status. Use get_esim_qr for the QR image.",
    inputSchema: {
      plan_id: EsimProductId.describe("prod_... id from search_esim_plans"),
      max_price_cents: MaxPriceCents,
    },
    outputSchema: EsimOrderOutput,
    annotations: SPENDS,
  }, purchaseEsimHandler(ctx));

  defineTool(server, ctx, "get_esim_status", {
    group: "esim",
    writes: false,
    title: "eSIM status and usage",
    description:
      "Read an eSIM's status, expiry, install details (LPA string) and data usage for every package on it (the base plan plus any top-ups), with an eSIM-level total.",
    inputSchema: { esim_id: EsimId.describe("esim_... id from purchase_esim or list_orders") },
    outputSchema: EsimStatusOutput,
    annotations: READ_ONLY,
  }, getEsimStatusHandler(ctx));

  defineTool(server, ctx, "topup_esim", {
    group: "esim",
    writes: true,
    title: "Browse or buy eSIM top-ups",
    description:
      "Add data to an existing eSIM. Without topup_product_id: lists compatible top-ups with prices (no charge). " +
      "With topup_product_id: buys that top-up, charged to your balance immediately; requires max_price_cents (the top-up price you showed the user and they approved).",
    inputSchema: {
      esim_id: EsimId.describe("esim_... id of the eSIM to top up"),
      topup_product_id: EsimProductId.optional().describe("prod_... id from the top-up list; omit to browse"),
      max_price_cents: MaxPriceCents.optional().describe(
        "Required with topup_product_id: the top-up price you showed the user and they approved, in US cents. Refused uncharged if the price is higher.",
      ),
    },
    outputSchema: TopupEsimOutput,
    annotations: SPENDS,
  }, topupEsimHandler(ctx));

  defineTool(server, ctx, "get_esim_qr", {
    group: "esim",
    writes: false,
    title: "eSIM QR code",
    description:
      "Fetch the activation QR code for an eSIM as an image. Most MCP clients render the image inline so the user can scan it directly.",
    inputSchema: { esim_id: EsimId.describe("esim_... id") },
    outputSchema: EsimQrOutput,
    annotations: READ_ONLY,
  }, getEsimQrHandler(ctx));
}

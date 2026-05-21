import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { EsimProduct, Esim, EsimUsage } from "../client/types.js";
import { structuredOk, structuredWithImage, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";

// ── search_esim_plans ───────────────────────────────────────────────────────

export const searchEsimPlansHandler = (http: HttpClient) =>
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
    if (args.country) q.set("country", args.country);
    if (args.min_data_gb !== undefined) q.set("min_data_gb", String(args.min_data_gb));
    if (args.min_days !== undefined) q.set("min_days", String(args.min_days));
    if (args.has_5g !== undefined) q.set("has_5g", String(args.has_5g));
    if (args.has_hotspot !== undefined) q.set("has_hotspot", String(args.has_hotspot));
    if (args.query) q.set("search", args.query);
    q.set("limit", String(args.limit ?? 20));
    if (args.cursor) q.set("cursor", args.cursor);

    const path = `/v1/esim_products?${q.toString()}`;
    const data = await callApi<{ esim_products: unknown[]; next_cursor: string | null }>(
      http,
      "GET",
      path,
    );
    const products = z.array(EsimProduct).parse(data.esim_products);
    if (products.length === 0) return toolError("No eSIM plans matched your filters.");
    const text = [
      `Found ${products.length} eSIM plan(s)${data.next_cursor ? " (more available - pass cursor to paginate)" : ""}:`,
      ``,
      ...products.map((p) =>
        [
          `  ${p.title} (${p.id})`,
          `    Countries:  ${p.countries.join(", ")}`,
          `    Data:       ${p.data_unlimited ? "unlimited" : `${p.data_gb} GB`}`,
          `    Validity:   ${p.validity_days} days`,
          `    Price:      ${formatUsd(p.retail_price_cents)}`,
          `    5G/Hotspot: ${p.has_5g ? "yes" : "no"} / ${p.has_hotspot ? "yes" : "no"}`,
        ].join("\n"),
      ),
    ].join("\n\n");
    return structuredOk(text, { esim_plans: products, next_cursor: data.next_cursor });
  });

// ── purchase_esim ───────────────────────────────────────────────────────────

export const purchaseEsimHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { plan_id: string }): Promise<ToolResult> => {
    const productResp = await callApi<{ product: unknown }>(http, "GET", `/v1/esim_products/${args.plan_id}`);
    const product = EsimProduct.parse(productResp.product);
    const out = await callApi<{ esim: unknown }>(http, "POST", "/v1/esims", {
      body: { product_id: args.plan_id, max_price_cents: product.retail_price_cents },
      idempotencyKey: newIdempotencyKey(),
    });
    const esim = Esim.parse(out.esim);
    const text = [
      `eSIM purchased: ${esim.id}`,
      ``,
      `  Plan:           ${esim.plan_title}`,
      `  Countries:      ${esim.countries.join(", ")}`,
      `  Data:           ${esim.data_unlimited ? "unlimited" : `${esim.data_gb_total} GB`}`,
      `  Validity:       ${esim.validity_days} days`,
      `  Charged:        ${formatUsd(esim.charged_price_cents)}`,
      `  Activation:     ${esim.activation_code}`,
      `  ICCID:          ${esim.iccid}`,
      ``,
      `Use get_esim_qr(esim_id="${esim.id}") to fetch the QR code as an image.`,
    ].join("\n");
    return structuredOk(text, { esim });
  });

// ── get_esim_status ─────────────────────────────────────────────────────────

export const getEsimStatusHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { esim_id: string }): Promise<ToolResult> => {
    const [esimRaw, usageRaw] = await Promise.all([
      callApi<{ esim: unknown }>(http, "GET", `/v1/esims/${args.esim_id}`),
      callApi<{ usage: unknown }>(http, "GET", `/v1/esims/${args.esim_id}/usage`).catch((e) => {
        if (e instanceof HttpError && e.code === "USAGE_UNAVAILABLE") return null;
        throw e;
      }),
    ]);
    const esim = Esim.parse(esimRaw.esim);
    const usage = usageRaw ? EsimUsage.parse(usageRaw.usage) : null;
    const primaryPkg = usage?.packages[0] ?? null;
    const text = [
      `eSIM ${esim.id}`,
      ``,
      `  Plan:        ${esim.plan_title}`,
      `  Status:      ${esim.status}`,
      `  Validity:    ${esim.validity_days} days`,
      `  Expires:     ${esim.expires_at}`,
      primaryPkg
        ? `  Usage:       ${primaryPkg.used_mb.toFixed(0)} MB / ${primaryPkg.total_mb.toFixed(0)} MB (${primaryPkg.percent_used}%)`
        : `  Usage:       (not yet available)`,
    ].join("\n");
    return structuredOk(text, { esim, usage });
  });

// ── topup_esim ──────────────────────────────────────────────────────────────

export const topupEsimHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { esim_id: string; topup_product_id?: string }): Promise<ToolResult> => {
    if (!args.topup_product_id) {
      // Browse path
      const out = await callApi<{ supports_topup: boolean; topups: unknown[] }>(
        http,
        "GET",
        `/v1/esims/${args.esim_id}/topups`,
      );
      if (!out.supports_topup || out.topups.length === 0) {
        return toolError(`No top-up products available for ${args.esim_id}.`);
      }
      const topups = z.array(EsimProduct).parse(out.topups);
      const text = [
        `Available top-ups for ${args.esim_id}:`,
        ``,
        ...topups.map(
          (t) =>
            `  ${t.title} (${t.id}) - ${t.data_gb} GB, ${t.validity_days} days, ${formatUsd(t.retail_price_cents)}`,
        ),
        ``,
        `Re-run topup_esim with topup_product_id to purchase.`,
      ].join("\n");
      return structuredOk(text, { topups });
    }
    // Purchase path: quote-then-commit
    const productResp = await callApi<{ product: unknown }>(
      http,
      "GET",
      `/v1/esim_products/${args.topup_product_id}`,
    );
    const product = EsimProduct.parse(productResp.product);
    const created = await callApi<{ esim: unknown }>(
      http,
      "POST",
      `/v1/esims/${args.esim_id}/topups`,
      {
        body: { product_id: args.topup_product_id, max_price_cents: product.retail_price_cents },
        idempotencyKey: newIdempotencyKey(),
      },
    );
    const esim = Esim.parse(created.esim);
    const text = [
      `Top-up ${esim.id} purchased on ${args.esim_id}.`,
      ``,
      `  Plan:      ${esim.plan_title}`,
      `  Data:      ${esim.data_unlimited ? "unlimited" : `${esim.data_gb_total} GB`}`,
      `  Validity:  ${esim.validity_days} days`,
      `  Charged:   ${formatUsd(esim.charged_price_cents)}`,
    ].join("\n");
    return structuredOk(text, { esim });
  });

// ── get_esim_qr ─────────────────────────────────────────────────────────────

export const getEsimQrHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { esim_id: string }): Promise<ToolResult> => {
    const res = await http.request("GET", `/v1/esims/${args.esim_id}/qr.png`, {
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

export function registerEsimTools(server: McpServer, http: HttpClient) {
  server.tool(
    "search_esim_plans",
    "Search global eSIM data plans. Each result includes the full plan shape (countries, data, validity, network type, speed, 5G/hotspot, activation policy) so a separate plan-details tool is unnecessary.",
    {
      country: z.string().optional().describe("ISO-3166 country code (e.g. 'JP')"),
      min_data_gb: z.number().optional(),
      min_days: z.number().optional(),
      has_5g: z.boolean().optional(),
      has_hotspot: z.boolean().optional(),
      query: z.string().optional().describe("Substring search on plan title"),
      limit: z.number().min(1).max(50).default(20),
      cursor: z.string().optional(),
    },
    searchEsimPlansHandler(http),
  );

  server.tool(
    "purchase_esim",
    "Purchase an eSIM plan. Quote-then-commit: the tool fetches the live retail price and ties max_price_cents to it so you never pay above what you saw.",
    { plan_id: z.string().describe("esim_product_xxx from search_esim_plans") },
    purchaseEsimHandler(http),
  );

  server.tool(
    "get_esim_status",
    "Read an eSIM's current status, plan info, and data usage. Combines GET /v1/esims/:id + /usage in one parallel call.",
    { esim_id: z.string() },
    getEsimStatusHandler(http),
  );

  server.tool(
    "topup_esim",
    "Browse top-up products (omit topup_product_id) or purchase a specific top-up (supply topup_product_id) for an active eSIM.",
    {
      esim_id: z.string(),
      topup_product_id: z.string().optional(),
    },
    topupEsimHandler(http),
  );

  server.tool(
    "get_esim_qr",
    "Fetch the activation QR code for an eSIM as an image. Most MCP clients render the image inline so the user can scan it directly.",
    { esim_id: z.string() },
    getEsimQrHandler(http),
  );
}

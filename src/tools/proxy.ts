// src/tools/proxy.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { Proxy, ProxyPlan } from "../client/types.js";
import { mapApiError } from "../client/errors.js";
import { structuredOk, toolError, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";

// ── search_proxies ──────────────────────────────────────────────────────────

export const searchProxiesHandler = (http: HttpClient) =>
  async (args: {
    country?: string;
    type?: "shared" | "dedicated_standard" | "dedicated_premium";
    min_data_gb?: number;
  }): Promise<ToolResult> => {
    try {
      const q = new URLSearchParams();
      if (args.country) q.set("country", args.country);
      if (args.type) q.set("type", args.type);
      if (args.min_data_gb !== undefined) q.set("min_gb", String(args.min_data_gb));
      const path = `/v1/proxy_plans${q.toString() ? `?${q}` : ""}`;
      const data = await callApi<{ proxy_plans: unknown[] }>(http, "GET", path);
      const plans = z.array(ProxyPlan).parse(data.proxy_plans);
      if (plans.length === 0) return toolError("No proxy plans matched your filters.");
      const text = [
        `Found ${plans.length} proxy plan(s):`,
        ``,
        ...plans.map((p) =>
          `  ${p.name.padEnd(36)} ${p.id.padEnd(20)} ${p.type.padEnd(20)} ${p.country} ${p.data_gb !== null ? `${p.data_gb}GB` : "unlim"} ${p.duration_days}d ${formatUsd(p.quoted_price_cents)}`,
        ),
      ].join("\n");
      return structuredOk(text, { proxy_plans: plans });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── purchase_proxy ──────────────────────────────────────────────────────────

export const purchaseProxyHandler = (http: HttpClient) =>
  async (args: { plan_id: string }): Promise<ToolResult> => {
    try {
      const plansData = await callApi<{ proxy_plans: unknown[] }>(http, "GET", `/v1/proxy_plans`);
      const plans = z.array(ProxyPlan).parse(plansData.proxy_plans);
      const plan = plans.find((p) => p.id === args.plan_id);
      if (!plan) {
        return toolError(
          `Plan '${args.plan_id}' not found. Use search_proxies to list available plans.`,
        );
      }
      const out = await callApi<{ proxy: unknown }>(http, "POST", "/v1/proxies", {
        body: { plan_id: args.plan_id, max_price_cents: plan.quoted_price_cents },
        idempotencyKey: newIdempotencyKey(),
      });
      const proxy = Proxy.parse(out.proxy);
      return structuredOk(
        `Proxy ${proxy.id} provisioning. Status: ${proxy.status}. Poll get_proxy_status until active.`,
        { proxy },
      );
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── get_proxy_status ────────────────────────────────────────────────────────

export const getProxyStatusHandler = (http: HttpClient) =>
  async (args: { proxy_id: string }): Promise<ToolResult> => {
    try {
      const [coreRaw, usageRaw, nolistRaw] = await Promise.all([
        callApi<{ proxy: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}`),
        callApi<unknown>(http, "GET", `/v1/proxies/${args.proxy_id}/usage`).catch(() => null),
        callApi<unknown>(http, "GET", `/v1/proxies/${args.proxy_id}/nolist_credentials`).catch(
          () => null,
        ),
      ]);
      const proxy = Proxy.parse(coreRaw.proxy);
      const lines = [
        `Proxy ${proxy.id}`,
        ``,
        `  Status:        ${proxy.status}`,
        `  Type:          ${proxy.type ?? "-"}`,
        `  Country:       ${proxy.country ?? "-"}`,
        `  Data:          ${(proxy.data_bytes_used / 1024 / 1024 / 1024).toFixed(2)} GB / ${proxy.data_gb_total} GB`,
        `  Expires:       ${proxy.expires_at}`,
      ];
      if (proxy.gateway) {
        lines.push(
          ``,
          `  Gateway:`,
          `    Host:      ${proxy.gateway.host}`,
          `    Port:      ${proxy.gateway.port}`,
          `    Protocol:  ${proxy.gateway.protocol}`,
          `    User:      ${proxy.gateway.username}`,
          `    Password:  ${proxy.gateway.password}`,
        );
      } else {
        lines.push(``, `  Gateway:       (not yet provisioned)`);
      }
      return structuredOk(lines.join("\n"), {
        proxy,
        usage: usageRaw,
        nolist_credentials: nolistRaw,
      });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── rotate_proxy_ip ─────────────────────────────────────────────────────────

export const rotateProxyIpHandler = (http: HttpClient) =>
  async (args: { proxy_id: string }): Promise<ToolResult> => {
    try {
      const out = await callApi<{ proxy: unknown; old_ip?: string; new_ip?: string }>(
        http,
        "POST",
        `/v1/proxies/${args.proxy_id}/rotate_ip`,
        { idempotencyKey: newIdempotencyKey() },
      );
      const proxy = Proxy.parse(out.proxy);
      return structuredOk(
        `Rotated ${proxy.id}: ${out.old_ip ?? "?"} -> ${out.new_ip ?? "?"}`,
        { proxy, old_ip: out.old_ip ?? null, new_ip: out.new_ip ?? null },
      );
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── renew_proxy ─────────────────────────────────────────────────────────────

export const renewProxyHandler = (http: HttpClient) =>
  async (args: { proxy_id: string }): Promise<ToolResult> => {
    try {
      const coreRaw = await callApi<{ proxy: unknown }>(
        http,
        "GET",
        `/v1/proxies/${args.proxy_id}`,
      );
      const proxy = Proxy.parse(coreRaw.proxy);
      if (!proxy.plan_id) {
        return toolError(`Proxy ${args.proxy_id} has no plan_id; renewal not available.`);
      }
      const plansData = await callApi<{ proxy_plans: unknown[] }>(
        http,
        "GET",
        `/v1/proxy_plans`,
      );
      const plans = z.array(ProxyPlan).parse(plansData.proxy_plans);
      const plan = plans.find((p) => p.id === proxy.plan_id);
      if (!plan) return toolError(`Original plan ${proxy.plan_id} no longer available.`);
      const out = await callApi<{ proxy: unknown }>(
        http,
        "POST",
        `/v1/proxies/${args.proxy_id}/renew`,
        {
          body: { max_price_cents: plan.quoted_price_cents },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      return structuredOk(`Proxy ${args.proxy_id} renewed.`, { proxy: Proxy.parse(out.proxy) });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── topup_proxy ─────────────────────────────────────────────────────────────

export const topupProxyHandler = (http: HttpClient) =>
  async (args: { proxy_id: string; data_gb: number }): Promise<ToolResult> => {
    try {
      const out = await callApi<{ proxy: unknown; charged_price_cents: number }>(
        http,
        "POST",
        `/v1/proxies/${args.proxy_id}/topup`,
        {
          body: { data_gb: args.data_gb },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      const proxy = Proxy.parse(out.proxy);
      return structuredOk(
        `Topped up ${args.proxy_id} by ${args.data_gb} GB (${formatUsd(out.charged_price_cents)}).`,
        { proxy },
      );
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── regenerate_proxy_password ───────────────────────────────────────────────

export const regenerateProxyPasswordHandler = (http: HttpClient) =>
  async (args: { proxy_id: string }): Promise<ToolResult> => {
    try {
      const out = await callApi<{ proxy: unknown }>(
        http,
        "POST",
        `/v1/proxies/${args.proxy_id}/regenerate_password`,
        { idempotencyKey: newIdempotencyKey() },
      );
      const proxy = Proxy.parse(out.proxy);
      const password = proxy.gateway?.password ?? "(no gateway)";
      return structuredOk(`New password for ${args.proxy_id}: ${password}`, { proxy });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── registration ────────────────────────────────────────────────────────────

export function registerProxyTools(server: McpServer, http: HttpClient) {
  server.tool(
    "search_proxies",
    "Search available mobile proxy plans.",
    {
      country: z.string().optional(),
      type: z.enum(["shared", "dedicated_standard", "dedicated_premium"]).optional(),
      min_data_gb: z.number().optional(),
    },
    searchProxiesHandler(http),
  );

  server.tool(
    "purchase_proxy",
    "Purchase a proxy plan. Returns 202 Accepted with status=provisioning; the gateway becomes active in 1-2 minutes. Poll get_proxy_status until status='active'.",
    { plan_id: z.string() },
    purchaseProxyHandler(http),
  );

  server.tool(
    "get_proxy_status",
    "Read a proxy's status, usage, and gateway credentials in one call.",
    { proxy_id: z.string() },
    getProxyStatusHandler(http),
  );

  server.tool(
    "rotate_proxy_ip",
    "Rotate a dedicated proxy to a new IP. Shared proxies rotate per-request through their lists - use create_proxy_list / list_proxy_lists instead.",
    { proxy_id: z.string() },
    rotateProxyIpHandler(http),
  );

  server.tool(
    "renew_proxy",
    "Extend a proxy's expiry by purchasing another period. Quote-then-commit.",
    { proxy_id: z.string() },
    renewProxyHandler(http),
  );

  server.tool(
    "topup_proxy",
    "Add more data to a shared proxy plan.",
    {
      proxy_id: z.string(),
      data_gb: z.number().int().positive(),
    },
    topupProxyHandler(http),
  );

  server.tool(
    "regenerate_proxy_password",
    "Rotate the main proxy gateway password. Returns the new credentials.",
    { proxy_id: z.string() },
    regenerateProxyPasswordHandler(http),
  );

  // List management tools (list_proxy_lists, create_proxy_list, delete_proxy_list) land in Task 13.
}

// src/tools/proxy.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { Proxy, ProxyPlan, ProxyList } from "../client/types.js";
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
      const data = await callApi<{ plans: unknown[] }>(http, "GET", path);
      const plans = z.array(ProxyPlan).parse(data.plans);
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
      const plansData = await callApi<{ plans: unknown[] }>(http, "GET", `/v1/proxy_plans`);
      const plans = z.array(ProxyPlan).parse(plansData.plans);
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
      const out = await callApi<{ proxy_id: string; rotated_at: string; current_ip: string | null }>(
        http,
        "POST",
        `/v1/proxies/${args.proxy_id}/rotate_ip`,
        { idempotencyKey: newIdempotencyKey() },
      );
      return structuredOk(
        `Rotated ${out.proxy_id} at ${out.rotated_at}. New IP: ${out.current_ip ?? "(unknown)"}`,
        { proxy_id: out.proxy_id, rotated_at: out.rotated_at, current_ip: out.current_ip },
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
      const plansData = await callApi<{ plans: unknown[] }>(
        http,
        "GET",
        `/v1/proxy_plans`,
      );
      const plans = z.array(ProxyPlan).parse(plansData.plans);
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
  async (args: { proxy_id: string; additional_gb: number }): Promise<ToolResult> => {
    try {
      // Quote: derive per-GB price from the proxy's original plan, then tie
      // max_price_cents to (perGb * additional_gb) so we never pay above quote.
      const coreRaw = await callApi<{ proxy: unknown }>(
        http,
        "GET",
        `/v1/proxies/${args.proxy_id}`,
      );
      const proxy = Proxy.parse(coreRaw.proxy);
      if (!proxy.plan_id) {
        return toolError(`Proxy ${args.proxy_id} has no plan_id; top-up not available.`);
      }
      const plansData = await callApi<{ plans: unknown[] }>(
        http,
        "GET",
        `/v1/proxy_plans`,
      );
      const plans = z.array(ProxyPlan).parse(plansData.plans);
      const plan = plans.find((p) => p.id === proxy.plan_id);
      if (!plan) return toolError(`Original plan ${proxy.plan_id} no longer available.`);
      if (!plan.data_gb || plan.data_gb <= 0) {
        return toolError(`Plan ${plan.id} has no GB allowance; top-up not available.`);
      }
      const maxPriceCents = Math.round((plan.quoted_price_cents / plan.data_gb) * args.additional_gb);
      const out = await callApi<{ proxy: unknown; charged_price_cents: number }>(
        http,
        "POST",
        `/v1/proxies/${args.proxy_id}/topup`,
        {
          body: { additional_gb: args.additional_gb, max_price_cents: maxPriceCents },
          idempotencyKey: newIdempotencyKey(),
        },
      );
      const refreshed = Proxy.parse(out.proxy);
      return structuredOk(
        `Topped up ${args.proxy_id} by ${args.additional_gb} GB (${formatUsd(out.charged_price_cents)}).`,
        { proxy: refreshed },
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

// ── list_proxy_lists ────────────────────────────────────────────────────────

export const listProxyListsHandler = (http: HttpClient) =>
  async (args: { proxy_id: string }): Promise<ToolResult> => {
    try {
      const coreRaw = await callApi<{ proxy: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}`);
      const proxy = Proxy.parse(coreRaw.proxy);
      const lists = proxy.lists;
      if (lists.length === 0) return toolError(`No proxy lists on ${args.proxy_id}.`);
      const text = [
        `Lists for ${args.proxy_id}:`,
        ``,
        ...lists.map((l) =>
          `  ${l.name} (${l.id}) preset=${l.location_preset} rotation=${l.rotation_period === 0 ? "per-request" : l.rotation_period === -1 ? "sticky" : `${l.rotation_period}s`}`,
        ),
      ].join("\n");
      return structuredOk(text, { lists });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── create_proxy_list ───────────────────────────────────────────────────────

export const createProxyListHandler = (http: HttpClient) =>
  async (args: {
    proxy_id: string;
    name: string;
    location_preset: "world_mix" | "north_america" | "europe" | "asia" | "latin_america" | "custom";
    countries?: string[];
    rotation_period: number;
  }): Promise<ToolResult> => {
    if (args.location_preset === "custom" && (!args.countries || args.countries.length === 0)) {
      return toolError("countries is required when location_preset='custom'.");
    }
    try {
      const out = await callApi<{ list: unknown }>(http, "POST", `/v1/proxies/${args.proxy_id}/lists`, {
        body: {
          name: args.name,
          location_preset: args.location_preset,
          countries: args.countries ?? null,
          rotation_period: args.rotation_period,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      const list = ProxyList.parse(out.list);
      return structuredOk(`Created list ${list.id}.\n  Login: ${list.login}\n  Password: ${list.password}`, { list });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── delete_proxy_list ───────────────────────────────────────────────────────

export const deleteProxyListHandler = (http: HttpClient) =>
  async (args: { proxy_id: string; list_id: string }): Promise<ToolResult> => {
    try {
      await callApi<unknown>(http, "DELETE", `/v1/proxies/${args.proxy_id}/lists/${args.list_id}`, {
        idempotencyKey: newIdempotencyKey(),
      });
      return structuredOk(`List ${args.list_id} deleted.`, { proxy_id: args.proxy_id, list_id: args.list_id });
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
    "Add more data to a shared proxy plan. Quote-then-commit: derives per-GB price from the proxy's original plan and ties max_price_cents to (per_gb * additional_gb).",
    {
      proxy_id: z.string(),
      additional_gb: z.number().int().positive(),
    },
    topupProxyHandler(http),
  );

  server.tool(
    "regenerate_proxy_password",
    "Rotate the main proxy gateway password. Returns the new credentials.",
    { proxy_id: z.string() },
    regenerateProxyPasswordHandler(http),
  );

  server.tool(
    "list_proxy_lists",
    "List proxy lists for a shared proxy (geo-targeted sub-pools that share the proxy's bandwidth).",
    { proxy_id: z.string() },
    listProxyListsHandler(http),
  );

  server.tool(
    "create_proxy_list",
    "Create a new geo-targeted proxy list on a shared proxy. To edit an existing list, delete it and create a new one.",
    {
      proxy_id: z.string(),
      name: z.string(),
      location_preset: z.enum(["world_mix", "north_america", "europe", "asia", "latin_america", "custom"]).default("world_mix"),
      countries: z.array(z.string()).optional().describe("Required when location_preset='custom'."),
      rotation_period: z.number().int().default(0).describe("0=per-request, -1=sticky, N=seconds"),
    },
    createProxyListHandler(http),
  );

  server.tool(
    "delete_proxy_list",
    "Delete a proxy list. The list's credentials stop working immediately.",
    {
      proxy_id: z.string(),
      list_id: z.string(),
    },
    deleteProxyListHandler(http),
  );
}

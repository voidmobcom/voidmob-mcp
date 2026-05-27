import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { Proxy, ProxyPlan, ProxyList, type ProxyPlan as ProxyPlanT } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";

async function fetchProxyPlan(http: HttpClient, planId: string): Promise<ProxyPlanT | null> {
  const plansData = await callApi<{ plans: unknown[] }>(http, "GET", `/v1/proxy_plans`);
  const plans = z.array(ProxyPlan).parse(plansData.plans);
  return plans.find((p) => p.id === planId) ?? null;
}

// ── search_proxies ──────────────────────────────────────────────────────────

export const searchProxiesHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: {
    country?: string;
    type?: "shared" | "dedicated_standard" | "dedicated_premium";
    min_data_gb?: number;
  }): Promise<ToolResult> => {
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
        `  ${p.name.padEnd(36)} ${p.id.padEnd(20)} ${p.type.padEnd(10)} ${(p.country_name ?? p.country ?? "global").padEnd(16)} ${p.data_gb}GB ${p.duration_days}d ${formatUsd(p.quoted_price_cents)}`,
      ),
    ].join("\n");
    return structuredOk(text, { proxy_plans: plans });
  });

// ── purchase_proxy ──────────────────────────────────────────────────────────

export const purchaseProxyHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { plan_id: string }): Promise<ToolResult> => {
    const plan = await fetchProxyPlan(http, args.plan_id);
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
  });

// ── get_proxy_status ────────────────────────────────────────────────────────

export const getProxyStatusHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    const [coreRaw, usageRaw, nolistRaw] = await Promise.all([
      callApi<{ proxy: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}`),
      callApi<{ usage: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}/usage`).catch((e) => {
        if (e instanceof HttpError && (e.code === "PROXY_NOT_READY" || e.code === "USAGE_UNAVAILABLE")) return null;
        throw e;
      }),
      // Idempotent get-or-create for the package-level NoList gateway. Requires
      // the package to be active (else 409 PROXY_NOT_READY); returns the
      // persisted credentials on subsequent calls.
      callApi<{ proxy: unknown }>(http, "POST", `/v1/proxies/${args.proxy_id}/nolist_credentials`, {
        idempotencyKey: newIdempotencyKey(),
      }).catch((e) => {
        if (e instanceof HttpError && (e.code === "PROXY_NOT_READY" || e.code === "PROXY_NOT_FOUND")) return null;
        throw e;
      }),
    ]);
    // Prefer the nolist response (gateway populated once active) over the core
    // GET, whose gateway is null until nolist credentials are provisioned.
    const proxy = Proxy.parse((nolistRaw?.proxy as unknown) ?? coreRaw.proxy);
    const lines = [
      `Proxy ${proxy.id}`,
      ``,
      `  Status:        ${proxy.status}`,
      `  Data:          ${(proxy.data_bytes_used / 1024 / 1024 / 1024).toFixed(2)} GB / ${proxy.data_gb_total} GB`,
      `  Expires:       ${proxy.expires_at}`,
    ];
    if (proxy.rotation_url) lines.push(`  Rotation URL:  ${proxy.rotation_url}`);
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
      usage: usageRaw?.usage ?? null,
      nolist_credentials: proxy.gateway,
    });
  });

// ── rotate_proxy_ip ─────────────────────────────────────────────────────────

export const rotateProxyIpHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
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
  });

// ── renew_proxy ─────────────────────────────────────────────────────────────

export const renewProxyHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    const coreRaw = await callApi<{ proxy: unknown }>(
      http,
      "GET",
      `/v1/proxies/${args.proxy_id}`,
    );
    const proxy = Proxy.parse(coreRaw.proxy);
    if (!proxy.plan_id) {
      return toolError(`Proxy ${args.proxy_id} has no plan_id; renewal not available.`);
    }
    const plan = await fetchProxyPlan(http, proxy.plan_id);
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
  });

// ── topup_proxy ─────────────────────────────────────────────────────────────

export const topupProxyHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string; additional_gb: number }): Promise<ToolResult> => {
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
    const plan = await fetchProxyPlan(http, proxy.plan_id);
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
  });

// ── regenerate_proxy_password ───────────────────────────────────────────────

export const regenerateProxyPasswordHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    const out = await callApi<{ proxy: unknown }>(
      http,
      "POST",
      `/v1/proxies/${args.proxy_id}/regenerate_password`,
      { idempotencyKey: newIdempotencyKey() },
    );
    const proxy = Proxy.parse(out.proxy);
    const password = proxy.gateway?.password ?? "(no gateway)";
    return structuredOk(`New password for ${args.proxy_id}: ${password}`, { proxy });
  });

// ── list_proxy_lists ────────────────────────────────────────────────────────

export const listProxyListsHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    const coreRaw = await callApi<{ proxy: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}`);
    const proxy = Proxy.parse(coreRaw.proxy);
    const lists = proxy.lists;
    if (lists.length === 0) return toolError(`No proxy lists on ${args.proxy_id}.`);
    const text = [
      `Lists for ${args.proxy_id}:`,
      ``,
      ...lists.map((l) => {
        const geo = l.countries?.length
          ? l.countries.join(",")
          : [l.country, l.region, l.city, l.isp].filter(Boolean).join("/") || "world";
        const rot =
          l.rotation_period_seconds === 0
            ? "per-request"
            : l.rotation_period_seconds === -1
              ? "sticky"
              : `${l.rotation_period_seconds}s`;
        return `  ${l.name} (${l.id}) geo=${geo} rotation=${rot} mode=${l.rotation_mode}`;
      }),
    ].join("\n");
    return structuredOk(text, { lists });
  });

// ── create_proxy_list ───────────────────────────────────────────────────────

export const createProxyListHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: {
    proxy_id: string;
    name: string;
    country?: string;
    countries?: string[];
    region?: string;
    city?: string;
    isp?: string;
    zip?: string;
    rotation_period_seconds?: number;
    rotation_mode?: "instant" | "delayed_5s" | "no_rotation_on_fail";
    format?: string;
  }): Promise<ToolResult> => {
    // Geo: country (single) XOR countries (2-30). region/city/isp/zip only
    // valid with a single country. Mirror the API's validation locally to
    // fail fast without a wasted round-trip.
    const hasCountry = !!args.country;
    const hasCountries = !!args.countries && args.countries.length > 0;
    if (!hasCountry && !hasCountries) {
      return toolError("Provide either country (single) or countries (2-30).");
    }
    if (hasCountry && hasCountries) {
      return toolError("country and countries are mutually exclusive.");
    }
    if (hasCountries && (args.region || args.city || args.isp || args.zip)) {
      return toolError("region/city/isp/zip are only valid with a single country, not countries.");
    }
    const body: Record<string, unknown> = {
      name: args.name,
      rotation_period_seconds: args.rotation_period_seconds ?? 0,
      rotation_mode: args.rotation_mode ?? "instant",
      format: args.format ?? "login_pass_host_port",
    };
    if (hasCountry) {
      body.country = args.country;
      if (args.region) body.region = args.region;
      if (args.city) body.city = args.city;
      if (args.isp) body.isp = args.isp;
      if (args.zip) body.zip = args.zip;
    } else {
      body.countries = args.countries;
    }
    const out = await callApi<{ list: unknown }>(http, "POST", `/v1/proxies/${args.proxy_id}/lists`, {
      body,
      idempotencyKey: newIdempotencyKey(),
    });
    const list = ProxyList.parse(out.list);
    const credLines = list.credentials
      ? [`  Username: ${list.credentials.username}`, `  Password: ${list.credentials.password}`]
      : [`  Credentials: (provisioning - active within 1-2 minutes)`];
    const text = [`Created list ${list.id}.`, ...credLines, ...list.entries.map((e) => `  ${e}`)].join("\n");
    return structuredOk(text, { list });
  });

// ── delete_proxy_list ───────────────────────────────────────────────────────

export const deleteProxyListHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string; list_id: string }): Promise<ToolResult> => {
    await callApi<unknown>(http, "DELETE", `/v1/proxies/${args.proxy_id}/lists/${args.list_id}`, {
      idempotencyKey: newIdempotencyKey(),
    });
    return structuredOk(`List ${args.list_id} deleted.`, { proxy_id: args.proxy_id, list_id: args.list_id });
  });

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
    "Create a new geo-targeted proxy list on a shared proxy. Provide either a single country (with optional region/city/isp/zip subfilters) or a countries array (2-30, mutually exclusive with the subfilters). To edit an existing list, delete it and create a new one.",
    {
      proxy_id: z.string(),
      name: z.string(),
      country: z.string().optional().describe("ISO-3166-1 alpha-2, lowercased. Mutually exclusive with countries."),
      countries: z.array(z.string()).optional().describe("2-30 ISO-3166-1 alpha-2 codes. Mutually exclusive with country/subfilters."),
      region: z.string().optional().describe("Only valid with a single country."),
      city: z.string().optional().describe("Only valid with a single country."),
      isp: z.string().optional().describe("Only valid with a single country."),
      zip: z.string().optional().describe("Only valid with a single country."),
      rotation_period_seconds: z.number().int().default(0).describe("0=per-request, -1=sticky, N=seconds (max 86400)"),
      rotation_mode: z.enum(["instant", "delayed_5s", "no_rotation_on_fail"]).default("instant"),
      format: z.string().default("login_pass_host_port").describe("Output format for entries[] (e.g. login_pass_host_port, http_url, socks5_url)"),
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

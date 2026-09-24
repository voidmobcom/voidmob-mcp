import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { Proxy, ProxyPlan, ProxyList, type ProxyPlan as ProxyPlanT } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";

/** One plan with the caller's live quote; null when the plan does not exist (or is not sold via the API). */
async function fetchProxyPlan(http: HttpClient, planId: string): Promise<ProxyPlanT | null> {
  try {
    const data = await callApi<{ plan: unknown }>(http, "GET", `/v1/proxy_plans/${encodeURIComponent(planId)}`);
    return ProxyPlan.parse(data.plan);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

const isDedicated = (type: string | undefined): boolean => type === "dedicated_standard" || type === "dedicated_premium";

function planLine(p: ProxyPlanT): string {
  const where = p.country_name ?? p.country ?? "global";
  if (p.type === "dedicated_standard") {
    const spot = [where, p.carrier, p.region].filter(Boolean).join(" / ");
    const stock = p.available === false ? "  (sold out)" : "";
    return `  ${p.name.padEnd(44)} ${p.id.padEnd(20)} dedicated  ${spot.padEnd(36)} unmetered ${p.duration_days}d ${formatUsd(p.quoted_price_cents)}${stock}`;
  }
  return `  ${p.name.padEnd(44)} ${p.id.padEnd(20)} ${p.type.padEnd(10)} ${where.padEnd(36)} ${p.data_gb}GB ${p.duration_days}d ${formatUsd(p.quoted_price_cents)}`;
}

// ── search_proxies ──────────────────────────────────────────────────────────

const PLAN_TYPE_PARAM = { shared: "shared", dedicated: "dedicated_standard", all: "all" } as const;

export const searchProxiesHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: {
    country?: string;
    min_data_gb?: number;
    type?: "shared" | "dedicated" | "all";
    available_only?: boolean;
    cursor?: string;
  }): Promise<ToolResult> => {
    const q = new URLSearchParams();
    if (args.type) q.set("type", PLAN_TYPE_PARAM[args.type]);
    if (args.country) q.set("country", args.country);
    if (args.min_data_gb !== undefined) q.set("min_gb", String(args.min_data_gb));
    // available / cursor only exist on the typed catalog
    const typed = args.type !== undefined;
    if (typed && args.available_only) q.set("available", "true");
    if (typed && args.cursor) q.set("cursor", args.cursor);
    const path = `/v1/proxy_plans${q.toString() ? `?${q}` : ""}`;
    const data = await callApi<{ plans: unknown[]; next_cursor?: string | null }>(http, "GET", path);
    const plans = z.array(ProxyPlan).parse(data.plans);
    const nextCursor = data.next_cursor ?? null;
    if (plans.length === 0) return toolError("No proxy plans matched your filters.");
    const text = [
      `Found ${plans.length} proxy plan(s):`,
      ``,
      ...plans.map(planLine),
      ...(nextCursor ? [``, `More plans available - call search_proxies again with cursor="${nextCursor}".`] : []),
    ].join("\n");
    return structuredOk(text, { proxy_plans: plans, next_cursor: nextCursor });
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
    if (plan.available === false) {
      return toolError(
        `Plan '${args.plan_id}' is sold out right now. Use search_proxies with available_only=true to pick another.`,
      );
    }
    const out = await callApi<{ proxy: unknown }>(http, "POST", "/v1/proxies", {
      body: { plan_id: args.plan_id, max_price_cents: plan.quoted_price_cents },
      idempotencyKey: newIdempotencyKey(),
    });
    const proxy = Proxy.parse(out.proxy);
    const text = proxy.status === "active"
      ? `Proxy ${proxy.id} is active (${formatUsd(proxy.charged_price_cents)}). Call get_proxy_status for its credentials.`
      : `Proxy ${proxy.id} provisioning. Status: ${proxy.status}. Poll get_proxy_status until active${plan.type === "dedicated_standard" ? " (usually within 5 minutes; refunded automatically if it cannot be provisioned)" : ""}.`;
    return structuredOk(text, { proxy });
  });

// ── get_proxy_status ────────────────────────────────────────────────────────

export const getProxyStatusHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    // The core GET is the source of truth (and enforces auth/ownership). Usage
    // and the Flex gateway are best-effort enrichment: degrade either to null
    // on ANY API/network error so a transient secondary failure never sinks a
    // status read. Non-API throws (bugs) still propagate. Logged, so a moved
    // endpoint (v1.1.5's silent 404) shows up instead of hiding as "no gateway".
    const degradeToNull = (e: unknown) => {
      if (e instanceof HttpError || e instanceof NetworkError) {
        process.stderr.write(`[voidmob-mcp] get_proxy_status enrichment degraded: ${e.message}\n`);
        return null;
      }
      throw e;
    };
    // Usage is read in parallel with the core GET; its failure is only judged
    // once the type is known, so a dedicated proxy's (expected) usage 404 is
    // neither logged nor surfaced.
    const [coreRaw, usageSettled] = await Promise.all([
      callApi<{ proxy: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}`),
      callApi<{ usage: unknown }>(http, "GET", `/v1/proxies/${args.proxy_id}/usage`).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      ),
    ]);
    const core = Proxy.parse(coreRaw.proxy);
    // Dedicated proxies are unmetered and carry their own credentials: no
    // usage to report, no Flex gateway to provision.
    const dedicated = isDedicated(core.type);
    const usageRaw = dedicated
      ? null
      : usageSettled.error ? degradeToNull(usageSettled.error) : usageSettled.value;
    // An active shared proxy has no gateway until the Flex credentials are
    // first requested (get-or-create). Only then call it, and take ONLY the
    // gateway from it: the endpoint replays its first response per idempotency
    // key, so its proxy snapshot goes stale. Once created, the core GET carries
    // the gateway itself. The key is per 10-minute window: polls inside a window
    // share one create, and a cached failure is retried in the next window
    // instead of replaying for the key's 24h lifetime.
    let gateway = core.gateway;
    if (!gateway && core.status === "active" && !dedicated) {
      const slot = Math.floor(Date.now() / 600_000);
      const flexRaw = await callApi<{ proxy: unknown }>(http, "POST", `/v1/proxies/${args.proxy_id}/flex_credentials`, {
        idempotencyKey: `flex-${args.proxy_id}-${slot}`,
      }).catch(degradeToNull);
      gateway = flexRaw ? Proxy.parse(flexRaw.proxy).gateway : null;
    }
    const proxy = { ...core, gateway };
    const lines = [
      `Proxy ${proxy.id}`,
      ``,
      `  Status:        ${proxy.status}`,
    ];
    if (dedicated) {
      const where = [proxy.country?.toUpperCase(), proxy.carrier].filter(Boolean).join(" / ");
      lines.push(
        `  Type:          dedicated${proxy.type === "dedicated_premium" ? " (Premium)" : ""}${where ? ` - ${where}` : ""}`,
        `  Data:          unmetered`,
      );
    } else {
      lines.push(`  Data:          ${(proxy.data_bytes_used / 1024 / 1024 / 1024).toFixed(2)} GB / ${proxy.data_gb_total} GB`);
    }
    lines.push(`  Expires:       ${proxy.expires_at}`);
    if (proxy.auto_renew !== undefined) lines.push(`  Auto-renew:    ${proxy.auto_renew ? "on" : "off"}`);
    if (proxy.next_renewal_price_cents != null) lines.push(`  Renewal price: ${formatUsd(proxy.next_renewal_price_cents)}`);
    if (proxy.rotation_url) lines.push(`  Rotation URL:  ${proxy.rotation_url}`);
    if (proxy.gateway) {
      lines.push(
        ``,
        `  Gateway:`,
        `    Host:      ${proxy.gateway.host}`,
        `    Port:      ${proxy.gateway.port}`,
        `    Protocol:  ${proxy.gateway.protocol}`,
      );
      if (proxy.gateway.socks_port != null) lines.push(`    SOCKS5:    ${proxy.gateway.socks_port}`);
      lines.push(
        `    User:      ${proxy.gateway.username}`,
        `    Password:  ${proxy.gateway.password}`,
      );
    } else if (proxy.type === "dedicated_premium") {
      lines.push(``, `  Gateway:       (Premium proxy credentials are shown in the dashboard)`);
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
    // The API quotes the exact renewal charge (a dedicated proxy renews at its
    // own locked-in price, not the plan's current one); null = not renewable.
    const quote = proxy.next_renewal_price_cents;
    if (quote == null) {
      return toolError(
        proxy.type === "dedicated_premium"
          ? `Proxy ${args.proxy_id} is a Premium proxy; renew it in the dashboard.`
          : isDedicated(proxy.type) && proxy.status !== "active"
            ? `Proxy ${args.proxy_id} is ${proxy.status}; a dedicated proxy can only be renewed while active.`
            : `Proxy ${args.proxy_id} cannot be renewed right now (status: ${proxy.status}).`,
      );
    }
    const out = await callApi<{ proxy: unknown }>(
      http,
      "POST",
      `/v1/proxies/${args.proxy_id}/renew`,
      {
        body: { max_price_cents: quote },
        idempotencyKey: newIdempotencyKey(),
      },
    );
    const renewed = Proxy.parse(out.proxy);
    return structuredOk(
      `Proxy ${args.proxy_id} renewed for ${formatUsd(quote)}. New expiry: ${renewed.expires_at}.`,
      { proxy: renewed },
    );
  });

// ── set_proxy_auto_renew ────────────────────────────────────────────────────

export const setProxyAutoRenewHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string; enabled: boolean }): Promise<ToolResult> => {
    // Explicit state, so a retry can never flip it back - no idempotency key needed.
    const out = await callApi<{ proxy: unknown }>(
      http,
      "POST",
      `/v1/proxies/${args.proxy_id}/auto_renew`,
      { body: { enabled: args.enabled } },
    );
    const proxy = Proxy.parse(out.proxy);
    const price = proxy.next_renewal_price_cents != null ? ` for ${formatUsd(proxy.next_renewal_price_cents)}` : "";
    const text = proxy.auto_renew
      ? `Auto-renew is on for ${proxy.id}: it renews${price} about 12 hours before ${proxy.expires_at}, charged to your balance. Keep enough balance - if it cannot renew by expiry, the proxy expires.`
      : `Auto-renew is off for ${proxy.id}. It expires at ${proxy.expires_at} unless renewed with renew_proxy.`;
    return structuredOk(text, { proxy });
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
    if (isDedicated(proxy.type)) {
      return toolError(`Proxy ${args.proxy_id} is a dedicated proxy with unmetered data - top-up applies to mobile/GB proxies only.`);
    }
    if (!proxy.plan_id) {
      return toolError(`Proxy ${args.proxy_id} has no plan_id; top-up not available.`);
    }
    const plan = await fetchProxyPlan(http, proxy.plan_id);
    if (!plan) return toolError(`Original plan ${proxy.plan_id} no longer available.`);
    if (!plan.data_gb || plan.data_gb <= 0) {
      return toolError(`Plan ${plan.id} has no GB allowance; top-up not available.`);
    }
    const maxPriceCents = Math.round((plan.quoted_price_cents / plan.data_gb) * args.additional_gb);
    const out = await callApi<{ proxy: unknown }>(
      http,
      "POST",
      `/v1/proxies/${args.proxy_id}/topup`,
      {
        body: { additional_gb: args.additional_gb, max_price_cents: maxPriceCents },
        idempotencyKey: newIdempotencyKey(),
      },
    );
    // The topup response body carries only the refreshed proxy (no per-topup
    // charged amount), so report the quoted ceiling we tied - the strict-tie
    // contract guarantees the actual charge did not exceed it.
    const refreshed = Proxy.parse(out.proxy);
    return structuredOk(
      `Topped up ${args.proxy_id} by ${args.additional_gb} GB (up to ${formatUsd(maxPriceCents)}).`,
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
    "Search proxy plans. Shared plans are rotating mobile IPs billed by data; region/city/ISP targeting is set per list after purchase via create_proxy_list. Dedicated plans are one mobile modem of your own in a fixed country, carrier and region, with unmetered data and on-demand IP rotation. Each result includes the plan id, location, duration, price and (dedicated) whether it is in stock. Without type, only shared plans are returned.",
    {
      type: z.enum(["shared", "dedicated", "all"]).optional().describe("Plan kind. Omit for shared plans only."),
      country: z.string().optional().describe("ISO-3166-1 alpha-2 (e.g. 'US'). Many shared plans are worldwide and match any country."),
      min_data_gb: z.number().optional().describe("Minimum included data allowance in GB (excludes dedicated plans)"),
      available_only: z.boolean().optional().describe("With type set: only plans in stock right now"),
      cursor: z.string().optional().describe("With type set: the cursor from a previous search_proxies result, to fetch more plans"),
    },
    searchProxiesHandler(http),
  );

  server.tool(
    "purchase_proxy",
    "Purchase a proxy plan from search_proxies. Quote-then-commit: the tool fetches your live price and ties max_price_cents to it. A shared proxy becomes active in 1-2 minutes; a dedicated proxy is often active immediately, otherwise within about 5 minutes (refunded automatically if it cannot be provisioned). Poll get_proxy_status until status='active'.",
    { plan_id: z.string() },
    purchaseProxyHandler(http),
  );

  server.tool(
    "get_proxy_status",
    "Read a proxy's status, usage, expiry, auto-renew state and connection credentials in one call. Dedicated proxies also show their location, carrier and SOCKS5 port.",
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
    "Extend a proxy's expiry by one more period of its plan (a shared proxy also gets its plan's GB added). Quote-then-commit: charges exactly the proxy's current renewal price. A dedicated proxy must still be active.",
    { proxy_id: z.string() },
    renewProxyHandler(http),
  );

  server.tool(
    "set_proxy_auto_renew",
    "Turn auto-renew on or off for a dedicated proxy. With it on, the proxy renews itself about 12 hours before expiry, charged to your balance at its renewal price.",
    {
      proxy_id: z.string(),
      enabled: z.boolean(),
    },
    setProxyAutoRenewHandler(http),
  );

  server.tool(
    "topup_proxy",
    "Add more data to a shared proxy (dedicated proxies are unmetered). Quote-then-commit: derives per-GB price from the proxy's original plan and ties max_price_cents to (per_gb * additional_gb).",
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

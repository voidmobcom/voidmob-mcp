import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { path } from "../client/path.js";
import { Proxy, ProxyPlan, ProxyList, type ProxyPlan as ProxyPlanT } from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";
import { READ_ONLY, SPENDS } from "../utils/annotations.js";
import { ProxyId, ProxyListId, ProxyPlanId } from "../constants/ids.js";

/** One plan with the caller's live quote; null when the plan does not exist (or is not sold via the API). */
async function fetchProxyPlan(http: HttpClient, planId: string): Promise<ProxyPlanT | null> {
  try {
    const data = await callApi<{ plan: unknown }>(http, "GET", path`/v1/proxy_plans/${planId}`);
    return ProxyPlan.parse(data.plan);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

const isDedicated = (type: string | undefined): boolean => type === "dedicated_standard" || type === "dedicated_premium";

/** Ready-to-paste proxy URL; credentials are percent-encoded so any character survives. */
const proxyUrl = (scheme: "http" | "socks5", username: string, password: string, host: string, port: number): string =>
  `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;

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
    const data = await callApi<{ plans: unknown[]; next_cursor?: string | null }>(
      http,
      "GET",
      `/v1/proxy_plans${q.toString() ? `?${q}` : ""}`,
    );
    const plans = z.array(ProxyPlan).parse(data.plans);
    const nextCursor = data.next_cursor ?? null;
    if (plans.length === 0) {
      return structuredOk(
        "No proxy plans matched your filters. Try another country, a lower min_data_gb, or type='all'.",
        { proxy_plans: [], next_cursor: nextCursor },
      );
    }
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
      callApi<{ proxy: unknown }>(http, "GET", path`/v1/proxies/${args.proxy_id}`),
      callApi<{ usage: unknown }>(http, "GET", path`/v1/proxies/${args.proxy_id}/usage`).then(
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
      const flexRaw = await callApi<{ proxy: unknown }>(http, "POST", path`/v1/proxies/${args.proxy_id}/flex_credentials`, {
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
      const gw = proxy.gateway;
      lines.push(
        ``,
        `  Gateway:`,
        `    Host:      ${gw.host}`,
        `    Port:      ${gw.port}`,
        `    Protocol:  ${gw.protocol}`,
      );
      if (gw.socks_port != null) lines.push(`    SOCKS5:    ${gw.socks_port}`);
      lines.push(
        `    User:      ${gw.username}`,
        `    Password:  ${gw.password}`,
        `    HTTP URL:  ${proxyUrl("http", gw.username, gw.password, gw.host, gw.port)}`,
      );
      if (gw.socks_port != null) {
        lines.push(`    SOCKS5 URL: ${proxyUrl("socks5", gw.username, gw.password, gw.host, gw.socks_port)}`);
      }
      if (!dedicated) {
        // Flex gateway: geo, sticky session and rotation ride on the username.
        lines.push(
          ``,
          `  Per-request targeting (append to the username):`,
          ...(gw.username_geo_hint ? [`    ${gw.username_geo_hint}`] : []),
          `    US exit, new IP per request:  ${proxyUrl("http", `${gw.username}_c_US`, gw.password, gw.host, gw.port)}`,
          `    Same US IP for 10 minutes:    ${proxyUrl("http", `${gw.username}_c_US_s_worker1_ttl_10m`, gw.password, gw.host, gw.port)}`,
        );
      }
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
    // No Idempotency-Key: the API does not honor one here (every call must
    // rotate), so this write is also never retried automatically.
    const out = await callApi<{ proxy_id: string; rotated_at: string; current_ip: string | null }>(
      http,
      "POST",
      path`/v1/proxies/${args.proxy_id}/rotate_ip`,
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
      path`/v1/proxies/${args.proxy_id}`,
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
      path`/v1/proxies/${args.proxy_id}/renew`,
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
      path`/v1/proxies/${args.proxy_id}/auto_renew`,
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
      path`/v1/proxies/${args.proxy_id}`,
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
      path`/v1/proxies/${args.proxy_id}/topup`,
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
      path`/v1/proxies/${args.proxy_id}/regenerate_password`,
      { idempotencyKey: newIdempotencyKey() },
    );
    const proxy = Proxy.parse(out.proxy);
    const password = proxy.gateway?.password ?? "(no gateway)";
    return structuredOk(`New password for ${args.proxy_id}: ${password}`, { proxy });
  });

// ── list_proxy_lists ────────────────────────────────────────────────────────

export const listProxyListsHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    const coreRaw = await callApi<{ proxy: unknown }>(http, "GET", path`/v1/proxies/${args.proxy_id}`);
    const proxy = Proxy.parse(coreRaw.proxy);
    const lists = proxy.lists;
    if (lists.length === 0) {
      return structuredOk(`No proxy lists on ${args.proxy_id} yet. Create one with create_proxy_list.`, { lists: [] });
    }
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

const LIST_FORMATS = [
  "login_pass_host_port",
  "host_port_login_pass",
  "http_url",
  "socks5_url",
  "host_port",
  "login_pass_at_host_port",
  "json",
] as const;
type ListFormat = (typeof LIST_FORMATS)[number];

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
    format?: ListFormat;
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
    const out = await callApi<{ list: unknown }>(http, "POST", path`/v1/proxies/${args.proxy_id}/lists`, {
      body,
      idempotencyKey: newIdempotencyKey(),
    });
    const list = ProxyList.parse(out.list);
    const c = list.credentials;
    const credLines = c
      ? [
          `  Username: ${c.username}`,
          `  Password: ${c.password}`,
          `  HTTP URL:   ${proxyUrl("http", c.username, c.password, c.host, c.port)}`,
          `  SOCKS5 URL: ${proxyUrl("socks5", c.username, c.password, c.host, c.port)}`,
        ]
      : [`  Credentials: (provisioning - active within 1-2 minutes)`];
    const text = [
      `Created list ${list.id}.`,
      ...credLines,
      ...list.entries.map((e) => `  ${e}`),
      ...(list.activation_note ? [`  ${list.activation_note}`] : []),
    ].join("\n");
    return structuredOk(text, { list });
  });

// ── delete_proxy_list ───────────────────────────────────────────────────────

export const deleteProxyListHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { proxy_id: string; list_id: string }): Promise<ToolResult> => {
    await callApi<unknown>(http, "DELETE", path`/v1/proxies/${args.proxy_id}/lists/${args.list_id}`, {
      idempotencyKey: newIdempotencyKey(),
    });
    return structuredOk(`List ${args.list_id} deleted.`, { proxy_id: args.proxy_id, list_id: args.list_id });
  });

// ── registration ────────────────────────────────────────────────────────────

export function registerProxyTools(server: McpServer, http: HttpClient) {
  server.registerTool(
    "search_proxies",
    {
      title: "Search proxy plans",
      description:
        "Search mobile (4G/5G) proxy plans. Shared plans are rotating mobile IPs billed by data; geo (country/region/city/ISP), sticky sessions and rotation " +
        "are chosen after purchase per request or per list. Dedicated plans are one mobile modem of your own in a fixed country, carrier and region, " +
        "with unmetered data and on-demand IP rotation. Each result shows the plan id, location, duration, price and (dedicated) stock. " +
        "Without type, only shared plans are returned. Next: purchase_proxy with the plan_ id.",
      inputSchema: {
        type: z.enum(["shared", "dedicated", "all"]).optional().describe("Plan kind. Omit for shared plans only."),
        country: z.string().optional().describe("ISO-3166-1 alpha-2, any case (e.g. 'US'). Many shared plans are worldwide and match any country."),
        min_data_gb: z.number().min(0).optional().describe("Minimum included data allowance in GB (excludes dedicated plans)"),
        available_only: z.boolean().optional().describe("With type set: only plans in stock right now"),
        cursor: z.string().optional().describe("With type set: the cursor from a previous search_proxies result, to fetch more plans"),
      },
      annotations: READ_ONLY,
    },
    searchProxiesHandler(http),
  );

  server.registerTool(
    "purchase_proxy",
    {
      title: "Buy a proxy",
      description:
        "Buy a proxy plan from search_proxies, charged to your balance immediately. It charges your live price at that moment (re-read just before buying, so it can differ from an earlier search); " +
        "show the user the price first. A shared proxy becomes active in 1-2 minutes; a dedicated proxy is often active immediately, otherwise within about 5 minutes. " +
        "If it cannot be provisioned, the charge is refunded automatically. Poll get_proxy_status until status='active' for the connection details.",
      inputSchema: { plan_id: ProxyPlanId.describe("plan_... id from search_proxies") },
      annotations: SPENDS,
    },
    purchaseProxyHandler(http),
  );

  server.registerTool(
    "get_proxy_status",
    {
      title: "Proxy status and connection details",
      description:
        "Read a proxy's status, usage, expiry, auto-renew state and ready-to-paste connection URLs. " +
        "Shared proxies: the first call on an active proxy sets up its gateway login (free); country, sticky session and rotation are chosen per request " +
        "by appending parameters to the username - the output shows the syntax and examples. Dedicated proxies also show their location, carrier and SOCKS5 URL.",
      inputSchema: { proxy_id: ProxyId.describe("prx_... id from purchase_proxy or list_orders") },
      // Not strictly read-only: for an active shared proxy without a gateway it
      // creates the gateway login once (get-or-create, free, idempotent). Hinted
      // read-only so hosts can poll it without a confirmation prompt each time.
      annotations: READ_ONLY,
    },
    getProxyStatusHandler(http),
  );

  server.registerTool(
    "rotate_proxy_ip",
    {
      title: "Rotate dedicated proxy IP",
      description:
        "Force a new exit IP on a dedicated proxy; open connections drop. 60-second cooldown per proxy. " +
        "Shared proxies rotate per request instead (list settings or gateway username parameters).",
      inputSchema: { proxy_id: ProxyId.describe("prx_... id of a dedicated proxy") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    rotateProxyIpHandler(http),
  );

  server.registerTool(
    "renew_proxy",
    {
      title: "Renew a proxy",
      description:
        "Extend a proxy by one more period of its plan, charged to your balance at its current renewal price (next_renewal_price_cents in get_proxy_status); " +
        "a shared proxy also gets its plan's GB added. A dedicated proxy must still be active; a shared one can be renewed until 7 days after it expires.",
      inputSchema: { proxy_id: ProxyId.describe("prx_... id") },
      annotations: SPENDS,
    },
    renewProxyHandler(http),
  );

  server.registerTool(
    "set_proxy_auto_renew",
    {
      title: "Set proxy auto-renew",
      description:
        "Turn auto-renew on or off for a Standard dedicated proxy. With it on, the proxy renews itself about 12 hours before expiry, charged to your balance at its renewal price.",
      inputSchema: {
        proxy_id: ProxyId.describe("prx_... id of a dedicated proxy"),
        enabled: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    setProxyAutoRenewHandler(http),
  );

  server.registerTool(
    "topup_proxy",
    {
      title: "Add data to a shared proxy",
      description:
        "Add GB to a shared proxy (dedicated proxies are unmetered), charged to your balance immediately at the plan's per-GB price; the tool caps the charge at that prorated amount. " +
        "Also re-activates a proxy that ran out of data or expired less than 7 days ago. Confirm the amount with the user first.",
      inputSchema: {
        proxy_id: ProxyId.describe("prx_... id of a shared proxy"),
        additional_gb: z.number().int().positive().max(1000),
      },
      annotations: SPENDS,
    },
    topupProxyHandler(http),
  );

  server.registerTool(
    "regenerate_proxy_password",
    {
      title: "Reset proxy gateway password",
      description:
        "Rotate a shared proxy's gateway password (the gateway shown by get_proxy_status). The old password stops working immediately - update every client using it. " +
        "Lists keep their own credentials.",
      inputSchema: { proxy_id: ProxyId.describe("prx_... id of a shared proxy") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    regenerateProxyPasswordHandler(http),
  );

  server.registerTool(
    "list_proxy_lists",
    {
      title: "List proxy lists",
      description:
        "List the proxy lists on a shared proxy: geo-targeted sub-pools, each with its own login and rotation settings, all sharing the proxy's data.",
      inputSchema: { proxy_id: ProxyId.describe("prx_... id of a shared proxy") },
      annotations: READ_ONLY,
    },
    listProxyListsHandler(http),
  );

  server.registerTool(
    "create_proxy_list",
    {
      title: "Create proxy list",
      description:
        "Create a geo-targeted list with its own login on an active shared proxy (up to 100 lists, all sharing the proxy's data). " +
        "Provide either a single country (optional region/city/isp/zip, see get_geo) or a countries array (2-30, no subfilters). " +
        "Returns ready-to-paste http:// and socks5:// URLs; entries are always login:pass@host:port. " +
        "This server has no edit tool: to change a list here, delete it and create a new one.",
      inputSchema: {
        proxy_id: ProxyId.describe("prx_... id of an active shared proxy"),
        name: z.string().min(1).max(60),
        country: z.string().optional().describe("ISO-3166-1 alpha-2, any case. Mutually exclusive with countries."),
        countries: z.array(z.string()).optional().describe("2-30 ISO-3166-1 alpha-2 codes. Mutually exclusive with country/subfilters."),
        region: z.string().optional().describe("Only valid with a single country."),
        city: z.string().optional().describe("Only valid with a single country."),
        isp: z.string().optional().describe("Only valid with a single country."),
        zip: z.string().optional().describe("Only valid with a single country."),
        rotation_period_seconds: z.number().int().min(-1).max(86400).default(0).describe("0=new IP per request, -1=sticky, N=keep the IP for N seconds (max 86400)"),
        rotation_mode: z.enum(["instant", "delayed_5s", "no_rotation_on_fail"]).default("instant").describe("What happens when the current node fails"),
        format: z.enum(LIST_FORMATS).default("login_pass_host_port").describe("Saved export-format preference for the dashboard. Does not change entries in the response."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    createProxyListHandler(http),
  );

  server.registerTool(
    "delete_proxy_list",
    {
      title: "Delete proxy list",
      description: "Delete a proxy list. The list's credentials stop working immediately.",
      inputSchema: {
        proxy_id: ProxyId.describe("prx_... id"),
        list_id: ProxyListId.describe("list_... id from list_proxy_lists"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    deleteProxyListHandler(http),
  );
}

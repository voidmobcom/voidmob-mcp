import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { priceChangedText } from "../client/errors.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { path } from "../client/path.js";
import { Proxy, ProxyPlan, ProxyList, ProxyGateway, type ProxyPlan as ProxyPlanT, type ProxyList as ProxyListT } from "../client/types.js";
import { ToolRefusal } from "../controls/spend-guard.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd } from "../utils/format.js";
import { READ_ONLY, SPENDS } from "../utils/annotations.js";
import { outputObject } from "../utils/output.js";
import { ProxyId, ProxyListId, ProxyPlanId } from "../constants/ids.js";
import { MaxPriceCents } from "../constants/price.js";
import { defineTool, type ToolContext } from "./context.js";

/** One plan with the caller's live quote; null when the plan does not exist (or is not sold via the API). */
async function fetchProxyPlan(ctx: ToolContext, planId: string): Promise<ProxyPlanT | null> {
  try {
    const data = await callApi<{ plan: unknown }>(ctx.http, "GET", path`/v1/proxy_plans/${planId}`);
    return ProxyPlan.parse(data.plan);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

async function fetchProxy(ctx: ToolContext, proxyId: string) {
  const raw = await callApi<{ proxy: unknown }>(ctx.http, "GET", path`/v1/proxies/${proxyId}`);
  return Proxy.parse(raw.proxy);
}

const isDedicated = (type: string | undefined): boolean => type === "dedicated_standard" || type === "dedicated_premium";

/** Ready-to-paste proxy URL; credentials are percent-encoded so any character survives. */
const proxyUrl = (scheme: "http" | "socks5", username: string, password: string, host: string, port: number): string =>
  `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;

/**
 * A top-up has no quote endpoint; the API prices it from the plan's price per
 * GB, with discounts and rounding applied to the total. The plan's current
 * price per GB is therefore an estimate that can differ by a few cents.
 */
function topupEstimateCents(plan: ProxyPlanT, gb: number): number | null {
  if (!plan.data_gb || plan.data_gb <= 0) return null;
  return Math.round((plan.quoted_price_cents / plan.data_gb) * gb);
}

/**
 * On PRICE_MISMATCH (the API's "price above max_price_cents", which carries
 * no price) look up the current price and hand it back to re-confirm. The
 * lookup is a read after the refused write, so nothing was charged either way.
 */
async function withCurrentPrice<T>(
  fn: () => Promise<T>,
  explain: () => Promise<string | null>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError && e.code === "PRICE_MISMATCH") {
      const text = await explain().catch(() => null);
      if (text) throw new ToolRefusal(`${text}${e.requestId ? ` (request_id: ${e.requestId})` : ""}`);
    }
    throw e;
  }
}

function planLine(p: ProxyPlanT): string {
  const where = p.country_name ?? p.country ?? "global";
  if (p.type === "dedicated_standard") {
    const spot = [where, p.carrier, p.region].filter(Boolean).join(" / ");
    const stock = p.available === false ? "  (sold out)" : "";
    return `  ${p.name.padEnd(44)} ${p.id.padEnd(20)} dedicated  ${spot.padEnd(36)} unmetered ${p.duration_days}d ${formatUsd(p.quoted_price_cents)}${stock}`;
  }
  return `  ${p.name.padEnd(44)} ${p.id.padEnd(20)} ${p.type.padEnd(10)} ${where.padEnd(36)} ${p.data_gb}GB ${p.duration_days}d ${formatUsd(p.quoted_price_cents)}`;
}

function listGeo(l: ProxyListT): string {
  return l.countries?.length
    ? l.countries.join(",")
    : [l.country, l.region, l.city, l.isp, l.zip].filter(Boolean).join("/") || "world";
}

function listRotation(seconds: number): string {
  return seconds === 0 ? "per-request" : seconds === -1 ? "sticky" : `${seconds}s`;
}

/** Credentials and ready-to-paste URLs for one list. */
function listCredentialLines(list: ProxyListT): string[] {
  const c = list.credentials;
  if (c) {
    return [
      `  Username:   ${c.username}`,
      `  Password:   ${c.password}`,
      `  HTTP URL:   ${proxyUrl("http", c.username, c.password, c.host, c.port)}`,
      `  SOCKS5 URL: ${proxyUrl("socks5", c.username, c.password, c.host, c.port)}`,
    ];
  }
  if (list.network) {
    const endpoint = list.entries[0] ?? "";
    return [
      `  Auth:       IP whitelist (${list.network}) - no login; connect from a whitelisted address`,
      ...(endpoint ? [`  HTTP:       http://${endpoint}`, `  SOCKS5:     socks5://${endpoint}`] : []),
    ];
  }
  return [`  Credentials: (provisioning - active within a few minutes)`];
}

// ── search_proxies ──────────────────────────────────────────────────────────

const PLAN_TYPE_PARAM = { shared: "shared", dedicated: "dedicated_standard", all: "all" } as const;

export const SearchProxiesOutput = outputObject({ proxy_plans: z.array(ProxyPlan), next_cursor: z.string().nullable() });

export const searchProxiesHandler = (ctx: ToolContext) =>
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
      ctx.http,
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

export const ProxyOutput = outputObject({ proxy: Proxy });

export const purchaseProxyHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { plan_id: string; max_price_cents: number }): Promise<ToolResult> => {
    const max = args.max_price_cents;
    const proxy = await withCurrentPrice(
      // The API enforces max_price_cents (PRICE_MISMATCH, nothing charged) and
      // refuses a sold-out dedicated plan before charging.
      () => ctx.guard.run(max, async () => {
        const out = await callApi<{ proxy: unknown }>(ctx.http, "POST", "/v1/proxies", {
          body: { plan_id: args.plan_id, max_price_cents: max },
          idempotencyKey: newIdempotencyKey(),
        });
        const value = Proxy.parse(out.proxy);
        return { value, chargedCents: value.charged_price_cents };
      }),
      async () => {
        const plan = await fetchProxyPlan(ctx, args.plan_id);
        return plan ? priceChangedText(plan.quoted_price_cents, max) : null;
      },
    );
    const text = proxy.status === "active"
      ? `Proxy ${proxy.id} is active (${formatUsd(proxy.charged_price_cents)}). Call get_proxy_status for its credentials.`
      : `Proxy ${proxy.id} provisioning (charged ${formatUsd(proxy.charged_price_cents)}). Status: ${proxy.status}. Poll get_proxy_status until active${isDedicated(proxy.type) ? " (usually within 5 minutes; refunded automatically if it cannot be provisioned)" : " (usually 1-2 minutes)"}.`;
    return structuredOk(text, { proxy });
  });

// ── get_proxy_status ────────────────────────────────────────────────────────

const ProxyUsage = z.record(z.string(), z.unknown());

export const ProxyStatusOutput = outputObject({
  proxy: Proxy,
  usage: ProxyUsage.nullable(),
  nolist_credentials: ProxyGateway.nullable(),
  // Shared proxies: the plan's current price per GB, the basis of a top-up price.
  topup_estimate_per_gb_cents: z.number().int().nullable().optional(),
});

export const getProxyStatusHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    // The core GET is the source of truth (and enforces auth/ownership). Usage,
    // the Flex gateway and the top-up estimate are best-effort enrichment:
    // degrade each to null on ANY API/network error so a transient secondary
    // failure never sinks a status read. Non-API throws (bugs) still propagate.
    // Logged, so a moved endpoint shows up instead of hiding as "no gateway".
    const degradeToNull = (e: unknown) => {
      if (e instanceof HttpError || e instanceof NetworkError || e instanceof z.ZodError) {
        process.stderr.write(`[voidmob-mcp] get_proxy_status enrichment degraded: ${e.message}\n`);
        return null;
      }
      throw e;
    };
    // Usage is read in parallel with the core GET; its failure is only judged
    // once the type is known, so a dedicated proxy's (expected) usage 404 is
    // neither logged nor surfaced.
    const [coreRaw, usageSettled] = await Promise.all([
      callApi<{ proxy: unknown }>(ctx.http, "GET", path`/v1/proxies/${args.proxy_id}`),
      callApi<{ usage: unknown }>(ctx.http, "GET", path`/v1/proxies/${args.proxy_id}/usage`).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      ),
    ]);
    const core = Proxy.parse(coreRaw.proxy);
    // Dedicated proxies are unmetered and carry their own credentials: no
    // usage to report, no Flex gateway to provision.
    const dedicated = isDedicated(core.type);
    let usage: z.infer<typeof ProxyUsage> | null = null;
    if (!dedicated) {
      if (usageSettled.error) degradeToNull(usageSettled.error);
      else {
        const parsed = ProxyUsage.safeParse(usageSettled.value?.usage);
        usage = parsed.success ? parsed.data : null;
      }
    }
    // An active shared proxy has no gateway until the Flex credentials are
    // first requested (get-or-create). Only then call it, and take ONLY the
    // gateway from it: the endpoint replays its first response per idempotency
    // key, so its proxy snapshot goes stale. Once created, the core GET carries
    // the gateway itself. The key is per 10-minute window: polls inside a window
    // share one create, and a cached failure is retried in the next window
    // instead of replaying for the key's 24h lifetime. In read-only mode this
    // server changes nothing, so it does not create the login.
    let gateway = core.gateway;
    const needsGateway = !gateway && core.status === "active" && !dedicated;
    if (needsGateway && !ctx.readOnly) {
      const slot = Math.floor(Date.now() / 600_000);
      const flexRaw = await callApi<{ proxy: unknown }>(ctx.http, "POST", path`/v1/proxies/${args.proxy_id}/flex_credentials`, {
        idempotencyKey: `flex-${args.proxy_id}-${slot}`,
      }).catch(degradeToNull);
      gateway = flexRaw ? Proxy.parse(flexRaw.proxy).gateway : null;
    }
    // Top-up price basis for a shared proxy that can take one.
    let perGbCents: number | null = null;
    if (!dedicated && core.plan_id && ["active", "exhausted", "expired"].includes(core.status)) {
      const plan = await fetchProxyPlan(ctx, core.plan_id).catch(degradeToNull);
      perGbCents = plan ? topupEstimateCents(plan, 1) : null;
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
    if (proxy.next_renewal_price_cents != null) {
      lines.push(`  Renewal price: ${formatUsd(proxy.next_renewal_price_cents)} (renew_proxy max_price_cents=${proxy.next_renewal_price_cents})`);
    }
    if (perGbCents !== null) lines.push(`  Top-up price:  about ${formatUsd(perGbCents)} per GB (topup_proxy; the exact total can differ by a few cents)`);
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
          `  Rotate this password with regenerate_proxy_password if it leaks.`,
        );
      }
    } else if (proxy.type === "dedicated_premium") {
      lines.push(``, `  Gateway:       (Premium proxy credentials are shown in the dashboard)`);
    } else if (needsGateway && ctx.readOnly) {
      lines.push(``, `  Gateway:       (not set up yet; this server is read-only, so it cannot create the login - use the dashboard or a server without VOIDMOB_READ_ONLY)`);
    } else {
      lines.push(``, `  Gateway:       (not yet provisioned)`);
    }
    return structuredOk(lines.join("\n"), {
      proxy,
      usage,
      nolist_credentials: proxy.gateway,
      ...(dedicated ? {} : { topup_estimate_per_gb_cents: perGbCents }),
    });
  });

// ── rotate_proxy_ip ─────────────────────────────────────────────────────────

const RotateResult = z.object({ proxy_id: z.string(), rotated_at: z.string(), current_ip: z.string().nullable() });

export const RotateProxyIpOutput = outputObject(RotateResult.shape);

export const rotateProxyIpHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    // No Idempotency-Key: the API does not honor one here (every call must
    // rotate), so this write is also never retried automatically.
    const out = RotateResult.parse(await callApi<unknown>(ctx.http, "POST", path`/v1/proxies/${args.proxy_id}/rotate_ip`));
    return structuredOk(
      `Rotated ${out.proxy_id} at ${out.rotated_at}. New IP: ${out.current_ip ?? "(unknown)"}`,
      { proxy_id: out.proxy_id, rotated_at: out.rotated_at, current_ip: out.current_ip },
    );
  });

// ── renew_proxy ─────────────────────────────────────────────────────────────

export const renewProxyHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string; max_price_cents: number }): Promise<ToolResult> => {
    const max = args.max_price_cents;
    const renewed = await withCurrentPrice(
      // The API enforces max_price_cents (PRICE_MISMATCH, nothing charged).
      // Its response does not state this charge, so the session budget counts
      // max_price_cents.
      () => ctx.guard.run(max, async () => {
        const out = await callApi<{ proxy: unknown }>(ctx.http, "POST", path`/v1/proxies/${args.proxy_id}/renew`, {
          body: { max_price_cents: max },
          idempotencyKey: newIdempotencyKey(),
        });
        return { value: Proxy.parse(out.proxy) };
      }),
      async () => {
        const quote = (await fetchProxy(ctx, args.proxy_id)).next_renewal_price_cents;
        return quote != null ? priceChangedText(quote, max) : null;
      },
    );
    return structuredOk(
      `Proxy ${args.proxy_id} renewed (at most ${formatUsd(max)}). New expiry: ${renewed.expires_at}.`,
      { proxy: renewed },
    );
  });

// ── set_proxy_auto_renew ────────────────────────────────────────────────────

export const setProxyAutoRenewHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string; enabled: boolean }): Promise<ToolResult> => {
    // Turning it on schedules charges, so the owner's limits apply to the
    // renewal price. Turning it off is always allowed.
    if (args.enabled && ctx.guard.limitsAutoRenew) {
      const renewal = ctx.guard.budgetCents !== null ? null : (await fetchProxy(ctx, args.proxy_id)).next_renewal_price_cents ?? null;
      const refusal = ctx.guard.autoRenewRefusal(renewal);
      if (refusal) return toolError(refusal);
    }
    // Explicit state, so a retry can never flip it back - no idempotency key needed.
    const out = await callApi<{ proxy: unknown }>(
      ctx.http,
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

export const topupProxyHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string; additional_gb: number; max_price_cents: number }): Promise<ToolResult> => {
    const max = args.max_price_cents;
    const refreshed = await withCurrentPrice(
      // The API prices the top-up itself and enforces max_price_cents
      // (PRICE_MISMATCH, nothing charged). Its response does not state the
      // charge, so the session budget counts max_price_cents.
      () => ctx.guard.run(max, async () => {
        const out = await callApi<{ proxy: unknown }>(ctx.http, "POST", path`/v1/proxies/${args.proxy_id}/topup`, {
          body: { additional_gb: args.additional_gb, max_price_cents: max },
          idempotencyKey: newIdempotencyKey(),
        });
        return { value: Proxy.parse(out.proxy) };
      }),
      async () => {
        const proxy = await fetchProxy(ctx, args.proxy_id);
        const plan = proxy.plan_id ? await fetchProxyPlan(ctx, proxy.plan_id) : null;
        const estimate = plan ? topupEstimateCents(plan, args.additional_gb) : null;
        if (estimate === null) return null;
        // A ceiling a little above both the estimate and the refused cap, so
        // an approved retry is not refused again over a few cents.
        const suggested = Math.ceil(Math.max(estimate, max) * 1.05);
        return (
          `The ${args.additional_gb} GB top-up costs more than your max_price_cents ${max} (${formatUsd(max)}), so nothing was charged. ` +
          `At the plan's current price it comes to about ${formatUsd(estimate)}; the exact total can be a few cents higher (discounts and rounding apply to the total). ` +
          `Show the user; only if they approve a ceiling a little above that, call topup_proxy again with it as max_price_cents (e.g. ${suggested})`
        );
      },
    );
    return structuredOk(
      `Topped up ${args.proxy_id} by ${args.additional_gb} GB (at most ${formatUsd(max)}). Data now: ${refreshed.data_gb_total} GB; status ${refreshed.status}.`,
      { proxy: refreshed },
    );
  });

// ── regenerate_proxy_password ───────────────────────────────────────────────

export const RegeneratePasswordOutput = outputObject({ proxy: Proxy.optional(), list: ProxyList.optional() });

export const regenerateProxyPasswordHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string; list_id?: string }): Promise<ToolResult> => {
    if (args.list_id) {
      const out = await callApi<{ list: unknown }>(
        ctx.http,
        "POST",
        path`/v1/proxies/${args.proxy_id}/lists/${args.list_id}/regenerate_password`,
        { idempotencyKey: newIdempotencyKey() },
      );
      const list = ProxyList.parse(out.list);
      return structuredOk(
        [`New credentials for list ${list.id} (the old password no longer works):`, ...listCredentialLines(list)].join("\n"),
        { list },
      );
    }
    const out = await callApi<{ proxy: unknown }>(
      ctx.http,
      "POST",
      path`/v1/proxies/${args.proxy_id}/regenerate_password`,
      { idempotencyKey: newIdempotencyKey() },
    );
    const proxy = Proxy.parse(out.proxy);
    const password = proxy.gateway?.password ?? "(no gateway)";
    return structuredOk(`New gateway password for ${args.proxy_id}: ${password}`, { proxy });
  });

// ── list_proxy_lists ────────────────────────────────────────────────────────

export const ListProxyListsOutput = outputObject({ lists: z.array(ProxyList) });

export const listProxyListsHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string }): Promise<ToolResult> => {
    const lists = (await fetchProxy(ctx, args.proxy_id)).lists;
    if (lists.length === 0) {
      return structuredOk(`No proxy lists on ${args.proxy_id} yet. Create one with create_proxy_list.`, { lists: [] });
    }
    const text = [
      `Lists for ${args.proxy_id}:`,
      ``,
      ...lists.map((l) =>
        `  ${l.name} (${l.id}) geo=${listGeo(l)} rotation=${listRotation(l.rotation_period_seconds)} mode=${l.rotation_mode}${l.network ? ` ip-whitelist=${l.network}` : ""}`,
      ),
    ].join("\n");
    return structuredOk(text, { lists });
  });

// ── create_proxy_list / update_proxy_list ───────────────────────────────────

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
type RotationMode = "instant" | "delayed_5s" | "no_rotation_on_fail";

interface GeoArgs {
  country?: string;
  countries?: string[];
  region?: string;
  city?: string;
  isp?: string;
  zip?: string;
}

/** The API's geo rules, checked locally so a bad combination costs no round-trip. */
function geoConflict(args: GeoArgs): string | null {
  const hasCountry = !!args.country;
  const hasCountries = !!args.countries && args.countries.length > 0;
  if (hasCountry && hasCountries) return "country and countries are mutually exclusive.";
  if (hasCountries && (args.region || args.city || args.isp || args.zip)) {
    return "region/city/isp/zip are only valid with a single country, not countries.";
  }
  return null;
}

function geoBody(args: GeoArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ["country", "countries", "region", "city", "isp", "zip"] as const) {
    if (args[key] !== undefined && !(key === "countries" && args.countries?.length === 0)) body[key] = args[key];
  }
  return body;
}

export const ProxyListOutput = outputObject({ list: ProxyList });

export const createProxyListHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: GeoArgs & {
    proxy_id: string;
    name: string;
    rotation_period_seconds?: number;
    rotation_mode?: RotationMode;
    format?: ListFormat;
    network?: string;
  }): Promise<ToolResult> => {
    if (!args.country && !(args.countries && args.countries.length > 0)) {
      return toolError("Provide either country (single) or countries (2-30).");
    }
    const conflict = geoConflict(args);
    if (conflict) return toolError(conflict);
    const body: Record<string, unknown> = {
      name: args.name,
      rotation_period_seconds: args.rotation_period_seconds ?? 0,
      rotation_mode: args.rotation_mode ?? "instant",
      format: args.format ?? "login_pass_host_port",
      ...geoBody(args),
    };
    if (args.network) body.network = args.network;
    const out = await callApi<{ list: unknown }>(ctx.http, "POST", path`/v1/proxies/${args.proxy_id}/lists`, {
      body,
      idempotencyKey: newIdempotencyKey(),
    });
    const list = ProxyList.parse(out.list);
    const text = [
      `Created list ${list.id}.`,
      ...listCredentialLines(list),
      ...list.entries.map((e) => `  ${e}`),
      ...(list.activation_note ? [`  ${list.activation_note}`] : []),
      ...(list.network ? [`  IP-whitelist lists take a few minutes longer; until then requests return 407.`] : []),
    ].join("\n");
    return structuredOk(text, { list });
  });

export const updateProxyListHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: GeoArgs & {
    proxy_id: string;
    list_id: string;
    name?: string;
    rotation_period_seconds?: number;
    rotation_mode?: RotationMode;
    format?: ListFormat;
  }): Promise<ToolResult> => {
    const conflict = geoConflict(args);
    if (conflict) return toolError(conflict);
    const body: Record<string, unknown> = { ...geoBody(args) };
    if (args.name !== undefined) body.name = args.name;
    if (args.rotation_period_seconds !== undefined) body.rotation_period_seconds = args.rotation_period_seconds;
    if (args.rotation_mode !== undefined) body.rotation_mode = args.rotation_mode;
    if (args.format !== undefined) body.format = args.format;
    if (Object.keys(body).length === 0) {
      return toolError("Nothing to change: pass at least one of name, country/countries (with region/city/isp/zip), rotation_period_seconds, rotation_mode or format.");
    }
    const out = await callApi<{ list: unknown }>(ctx.http, "PATCH", path`/v1/proxies/${args.proxy_id}/lists/${args.list_id}`, {
      body,
      idempotencyKey: newIdempotencyKey(),
    });
    const list = ProxyList.parse(out.list);
    const text = [
      `Updated list ${list.id}: geo=${listGeo(list)} rotation=${listRotation(list.rotation_period_seconds)} mode=${list.rotation_mode} format=${list.format}.`,
      ...listCredentialLines(list),
    ].join("\n");
    return structuredOk(text, { list });
  });

// ── delete_proxy_list ───────────────────────────────────────────────────────

export const DeleteProxyListOutput = outputObject({ proxy_id: z.string(), list_id: z.string() });

export const deleteProxyListHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (args: { proxy_id: string; list_id: string }): Promise<ToolResult> => {
    await callApi<unknown>(ctx.http, "DELETE", path`/v1/proxies/${args.proxy_id}/lists/${args.list_id}`, {
      idempotencyKey: newIdempotencyKey(),
    });
    return structuredOk(`List ${args.list_id} deleted.`, { proxy_id: args.proxy_id, list_id: args.list_id });
  });

// ── registration ────────────────────────────────────────────────────────────

const CountryCode = z.string().regex(/^[A-Za-z]{2}$/, "Expected a 2-letter ISO country code");

const listGeoInputs = {
  country: CountryCode.optional().describe("ISO-3166-1 alpha-2, any case. Mutually exclusive with countries."),
  countries: z.array(CountryCode).min(2).max(30).optional().describe("2-30 ISO-3166-1 alpha-2 codes. Mutually exclusive with country/subfilters."),
  region: z.string().max(80).optional().describe("Only valid with a single country (names from get_geo)."),
  city: z.string().max(80).optional().describe("Only valid with a single country (names from get_geo)."),
  isp: z.string().max(80).optional().describe("Only valid with a single country (names from get_geo)."),
  zip: z.string().max(20).optional().describe("Only valid with a single country."),
};

const rotationPeriodInput = z.number().int().min(-1).max(86400).describe("0=new IP per request, -1=sticky, N=keep the IP for N seconds (max 86400)");
const rotationModeInput = z.enum(["instant", "delayed_5s", "no_rotation_on_fail"]).describe("What happens when the current node fails");
const formatInput = z.enum(LIST_FORMATS).describe("Saved export-format preference for the dashboard. Does not change entries in the response.");

export function registerProxyTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, "search_proxies", {
    group: "proxy",
    writes: false,
    title: "Search proxy plans",
    description:
      "Search mobile (4G/5G) proxy plans. Shared plans are rotating mobile IPs billed by data; geo (country/region/city/ISP), sticky sessions and rotation " +
      "are chosen after purchase per request or per list. Dedicated plans are one mobile modem of your own in a fixed country, carrier and region, " +
      "with unmetered data and on-demand IP rotation. Each result shows the plan id, location, duration, price and (dedicated) stock. " +
      "Without type, only shared plans are returned. Next: show the user the price, then purchase_proxy with the plan_ id and that price as max_price_cents.",
    inputSchema: {
      type: z.enum(["shared", "dedicated", "all"]).optional().describe("Plan kind. Omit for shared plans only."),
      country: z.string().optional().describe("ISO-3166-1 alpha-2, any case (e.g. 'US'). Many shared plans are worldwide and match any country."),
      min_data_gb: z.number().min(0).optional().describe("Minimum included data allowance in GB (excludes dedicated plans)"),
      available_only: z.boolean().optional().describe("With type set: only plans in stock right now"),
      cursor: z.string().optional().describe("With type set: the cursor from a previous search_proxies result, to fetch more plans"),
    },
    outputSchema: SearchProxiesOutput,
    annotations: READ_ONLY,
  }, searchProxiesHandler(ctx));

  defineTool(server, ctx, "purchase_proxy", {
    group: "proxy",
    writes: true,
    title: "Buy a proxy",
    description:
      "Buy a proxy plan from search_proxies, charged to your balance immediately. " +
      "Requires max_price_cents: the plan price you showed the user and they approved; if the price is now higher, nothing is charged and the new price comes back to re-confirm. " +
      "A shared proxy becomes active in 1-2 minutes; a dedicated proxy is often active immediately, otherwise within about 5 minutes. " +
      "If it cannot be provisioned, the charge is refunded automatically. Poll get_proxy_status until status='active' for the connection details.",
    inputSchema: {
      plan_id: ProxyPlanId.describe("plan_... id from search_proxies"),
      max_price_cents: MaxPriceCents,
    },
    outputSchema: ProxyOutput,
    annotations: SPENDS,
  }, purchaseProxyHandler(ctx));

  defineTool(server, ctx, "get_proxy_status", {
    group: "proxy",
    writes: false,
    title: "Proxy status and connection details",
    description:
      "Read a proxy's status, usage, expiry, auto-renew state, renewal and top-up prices, and ready-to-paste connection URLs. " +
      "Shared proxies: the first call on an active proxy sets up its gateway login (free); country, sticky session and rotation are chosen per request " +
      "by appending parameters to the username - the output shows the syntax and examples. Dedicated proxies also show their location, carrier and SOCKS5 URL.",
    inputSchema: { proxy_id: ProxyId.describe("prx_... id from purchase_proxy or list_orders") },
    outputSchema: ProxyStatusOutput,
    // Not strictly read-only: for an active shared proxy without a gateway it
    // creates the gateway login once (get-or-create, free, idempotent), except
    // in read-only mode. Hinted read-only so hosts can poll it without a
    // confirmation prompt each time.
    annotations: READ_ONLY,
  }, getProxyStatusHandler(ctx));

  defineTool(server, ctx, "rotate_proxy_ip", {
    group: "proxy",
    writes: true,
    title: "Rotate dedicated proxy IP",
    description:
      "Force a new exit IP on a dedicated proxy; open connections drop. 60-second cooldown per proxy. " +
      "Shared proxies rotate per request instead (list settings or gateway username parameters).",
    inputSchema: { proxy_id: ProxyId.describe("prx_... id of a dedicated proxy") },
    outputSchema: RotateProxyIpOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, rotateProxyIpHandler(ctx));

  defineTool(server, ctx, "renew_proxy", {
    group: "proxy",
    writes: true,
    title: "Renew a proxy",
    description:
      "Extend a proxy by one more period of its plan, charged to your balance at its renewal price (next_renewal_price_cents in get_proxy_status); " +
      "a shared proxy also gets its plan's GB added. A dedicated proxy must still be active; a shared one can be renewed until 7 days after it expires. " +
      "Requires max_price_cents: the renewal price you showed the user and they approved; refused uncharged if the price is higher.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id"),
      max_price_cents: MaxPriceCents,
    },
    outputSchema: ProxyOutput,
    annotations: SPENDS,
  }, renewProxyHandler(ctx));

  defineTool(server, ctx, "set_proxy_auto_renew", {
    group: "proxy",
    writes: true,
    title: "Set proxy auto-renew",
    description:
      "Turn auto-renew on or off for a Standard dedicated proxy. With it on, the proxy renews itself about 12 hours before expiry, charged to your balance at its renewal price. " +
      "Ask the user before turning it on.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id of a dedicated proxy"),
      enabled: z.boolean(),
    },
    outputSchema: ProxyOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, setProxyAutoRenewHandler(ctx));

  defineTool(server, ctx, "topup_proxy", {
    group: "proxy",
    writes: true,
    title: "Add data to a shared proxy",
    description:
      "Add GB to a shared proxy (dedicated proxies are unmetered), charged to your balance immediately. The price is about the plan's price per GB times additional_gb " +
      "(get_proxy_status shows it; the exact total can differ by a few cents). Also re-activates a proxy that ran out of data or expired less than 7 days ago. " +
      "Requires max_price_cents: the total you showed the user and they approved; refused uncharged if the price is higher.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id of a shared proxy"),
      additional_gb: z.number().int().positive().max(1000),
      max_price_cents: MaxPriceCents,
    },
    outputSchema: ProxyOutput,
    annotations: SPENDS,
  }, topupProxyHandler(ctx));

  defineTool(server, ctx, "regenerate_proxy_password", {
    group: "proxy",
    writes: true,
    title: "Reset proxy gateway or list password",
    description:
      "Rotate a shared proxy's gateway password (the gateway shown by get_proxy_status), or with list_id the login of one list. " +
      "The old password stops working immediately - update every client using it. Rotating the gateway leaves list logins unchanged, and the other way round.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id of a shared proxy"),
      list_id: ProxyListId.optional().describe("list_... id to rotate that list's login instead of the gateway password"),
    },
    outputSchema: RegeneratePasswordOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, regenerateProxyPasswordHandler(ctx));

  defineTool(server, ctx, "list_proxy_lists", {
    group: "proxy",
    writes: false,
    title: "List proxy lists",
    description:
      "List the proxy lists on a shared proxy: geo-targeted sub-pools, each with its own login (or IP whitelist) and rotation settings, all sharing the proxy's data.",
    inputSchema: { proxy_id: ProxyId.describe("prx_... id of a shared proxy") },
    outputSchema: ListProxyListsOutput,
    annotations: READ_ONLY,
  }, listProxyListsHandler(ctx));

  defineTool(server, ctx, "create_proxy_list", {
    group: "proxy",
    writes: true,
    title: "Create proxy list",
    description:
      "Create a geo-targeted list on an active shared proxy (up to 100 lists, all sharing the proxy's data). " +
      "Provide either a single country (optional region/city/isp/zip, see get_geo) or a countries array (2-30, no subfilters). " +
      "By default it gets its own login and returns ready-to-paste http:// and socks5:// URLs (entries are login:pass@host:port). " +
      "With network, it authenticates by source IP instead (no login; set at creation only). Change geo, rotation or format later with update_proxy_list.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id of an active shared proxy"),
      name: z.string().min(1).max(60),
      ...listGeoInputs,
      rotation_period_seconds: rotationPeriodInput.default(0),
      rotation_mode: rotationModeInput.default("instant"),
      format: formatInput.default("login_pass_host_port"),
      network: z.string().max(120).optional().describe(
        "IP whitelist instead of a login: comma-separated IPv4 addresses and/or /24-/32 subnets, max 5 (e.g. '203.0.113.7,198.51.100.0/24'). " +
        "Cannot be changed later; an address can be on one list at a time.",
      ),
    },
    outputSchema: ProxyListOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, createProxyListHandler(ctx));

  defineTool(server, ctx, "update_proxy_list", {
    group: "proxy",
    writes: true,
    title: "Update proxy list",
    description:
      "Change an existing list's name, geo (country with region/city/isp/zip, or countries), rotation or format; omitted fields keep their values. " +
      "The login stays the same. The IP whitelist (network) cannot be changed: delete the list and create a new one for that.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id of an active shared proxy"),
      list_id: ProxyListId.describe("list_... id from list_proxy_lists"),
      name: z.string().min(1).max(60).optional(),
      ...listGeoInputs,
      rotation_period_seconds: rotationPeriodInput.optional(),
      rotation_mode: rotationModeInput.optional(),
      format: formatInput.optional(),
    },
    outputSchema: ProxyListOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, updateProxyListHandler(ctx));

  defineTool(server, ctx, "delete_proxy_list", {
    group: "proxy",
    writes: true,
    title: "Delete proxy list",
    description: "Delete a proxy list. The list's credentials stop working immediately.",
    inputSchema: {
      proxy_id: ProxyId.describe("prx_... id"),
      list_id: ProxyListId.describe("list_... id from list_proxy_lists"),
    },
    outputSchema: DeleteProxyListOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, deleteProxyListHandler(ctx));
}

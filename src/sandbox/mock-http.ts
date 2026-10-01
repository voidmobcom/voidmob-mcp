import type { HttpClient, HttpResponse, HttpRequestOpts } from "../client/http.js";
import type {
  MePayload,
  SmsService,
  Verification,
  VerificationMessage,
  Rental,
  EsimProduct,
  Esim,
  EsimUsage,
  Proxy,
  ProxyList,
  ProxyPlan,
  DedicatedCountry,
  DedicatedNumber,
} from "../client/types.js";
import { formatUsd } from "../utils/format.js";

// In-memory mock of the VoidMob v1 API. The sandbox registers the SAME live
// tools (src/tools/*) but with this client injected instead of the real HTTP
// one, so the sandbox tool surface is always identical to live by construction.
// Everything here is fake data generated at runtime; nothing leaves the process
// and state resets when the server restarts.

// ── tiny generators ──────────────────────────────────────────────────────────

let seq = 0;
const uid = (prefix: string): string => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
const rnd = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;
const hex = (n: number): string => Array.from({ length: n }, () => rnd(0, 15).toString(16)).join("");
const alnum = (n: number): string => {
  const c = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => c[rnd(0, c.length - 1)]).join("");
};
const phone = (dial = "+1"): string => `${dial}${rnd(200, 989)}${rnd(200, 989)}${rnd(1000, 9999)}`;
const smsCode = (): string => String(rnd(100000, 999999));
const ip = (): string => `${rnd(11, 223)}.${rnd(1, 254)}.${rnd(1, 254)}.${rnd(1, 254)}`;
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;
const MINUTE = 60_000;
// Mirrors prod: a verification stays open 15 minutes; a long-term rental can be
// cancelled (full refund) for 60 minutes after purchase.
const VERIFICATION_WINDOW_MS = 15 * MINUTE;
const RENTAL_CANCEL_WINDOW_MS = 60 * MINUTE;
// Shared-proxy gateways: Flex (username parameters) on 10092, lists on 10000.
const GATEWAY_HOST = "proxy.voidmob.com";
const FLEX_PORT = 10092;
const LIST_PORT = 10000;
const FLEX_HINT =
  "Flex mode: append parameters to username for per-request control. _c_US (country), _s_<id> (sticky session), _ttl_5m (TTL), _city_New-York, _rotm_0.";

// Time (ms) before a verification's code "arrives" / a proxy goes active, so the
// poll-until-ready flow the tools describe is demonstrable without a long wait.
// Exported so e2e tests can wait exactly this long rather than duplicating the value.
export const READY_AFTER_MS = 1_500;

// ── catalog (static, shaped to the live Zod schemas) ─────────────────────────

const SERVICES: SmsService[] = [
  { id: "svc_whatsapp", name: "WhatsApp", quoted_price_cents: 250, available: true, ltr_3d_price_cents: 550, ltr_7d_price_cents: 900, ltr_14d_price_cents: 1500, ltr_30d_price_cents: 2500 },
  { id: "svc_telegram", name: "Telegram", quoted_price_cents: 150, available: true, ltr_3d_price_cents: 350, ltr_7d_price_cents: 600, ltr_14d_price_cents: 1000, ltr_30d_price_cents: 1700 },
  { id: "svc_google", name: "Google", quoted_price_cents: 180, available: true, ltr_3d_price_cents: 400, ltr_7d_price_cents: 700, ltr_14d_price_cents: 1200, ltr_30d_price_cents: 2000 },
  { id: "svc_twitter", name: "Twitter / X", quoted_price_cents: 200, available: true, ltr_7d_price_cents: 750, ltr_30d_price_cents: 2200 },
  { id: "svc_instagram", name: "Instagram", quoted_price_cents: 220, available: true, ltr_7d_price_cents: 850, ltr_30d_price_cents: 2400 },
  { id: "svc_discord", name: "Discord", quoted_price_cents: 120, available: true, ltr_7d_price_cents: 480, ltr_30d_price_cents: 1400 },
  { id: "svc_tiktok", name: "TikTok", quoted_price_cents: 250, available: true, ltr_7d_price_cents: 900 },
  { id: "svc_openai", name: "OpenAI", quoted_price_cents: 300, available: true, ltr_7d_price_cents: 1100, ltr_30d_price_cents: 3000 },
];

// Real live retail prices (public dashboard prices); hk is out of stock to demo that path.
const DEDICATED_COUNTRIES: DedicatedCountry[] = [
  { country: "us", name: "United States", quoted_price_cents: 1999, base_price_cents: 1999, in_stock: true },
  { country: "uk", name: "United Kingdom", quoted_price_cents: 1699, base_price_cents: 1699, in_stock: true },
  { country: "de", name: "Germany", quoted_price_cents: 4499, base_price_cents: 4499, in_stock: true },
  { country: "au", name: "Australia", quoted_price_cents: 3299, base_price_cents: 3299, in_stock: true },
  { country: "it", name: "Italy", quoted_price_cents: 2999, base_price_cents: 2999, in_stock: true },
  { country: "hk", name: "Hong Kong", quoted_price_cents: 2699, base_price_cents: 2699, in_stock: false },
];

const DED_DIAL: Record<string, string> = { us: "+1", uk: "+44", de: "+49", au: "+61", it: "+39", hk: "+852" };
const dedPhone = (country: string): string => phone(DED_DIAL[country] ?? "+1");

const esimFeatures = (over: Partial<EsimProduct["features"]> = {}): EsimProduct["features"] => ({
  has_5g: true,
  has_hotspot: true,
  has_calls: false,
  has_sms: false,
  supports_topup: true,
  ...over,
});

const ESIM_PRODUCTS: EsimProduct[] = [
  { id: "prod_us_5gb_30d", title: "USA 5GB 30 days", countries: ["US"], region: null, country_count: 1, routing_location: "US", data_limit_gb: 5, data_unlimited: false, validity_days: 30, features: esimFeatures(), price_cents: 1500, currency: "USD" },
  { id: "prod_eu_10gb_30d", title: "Europe 10GB 30 days", countries: ["FR", "DE", "ES", "IT", "NL", "PT", "BE", "AT", "IE", "SE"], region: "Europe", country_count: 10, routing_location: "DE", data_limit_gb: 10, data_unlimited: false, validity_days: 30, features: esimFeatures(), price_cents: 2600, currency: "USD" },
  { id: "prod_jp_3gb_15d", title: "Japan 3GB 15 days", countries: ["JP"], region: null, country_count: 1, routing_location: "JP", data_limit_gb: 3, data_unlimited: false, validity_days: 15, features: esimFeatures({ has_hotspot: false }), price_cents: 1100, currency: "USD" },
  { id: "prod_global_unl_7d", title: "Global Unlimited 7 days", countries: ["US", "GB", "FR", "DE", "JP", "AU", "BR", "ZA"], region: "Global", country_count: 8, routing_location: null, data_limit_gb: null, data_unlimited: true, validity_days: 7, features: esimFeatures(), price_cents: 3200, currency: "USD" },
  { id: "prod_topup_5gb", title: "Top-up 5GB", countries: [], region: null, country_count: 0, routing_location: null, data_limit_gb: 5, data_unlimited: false, validity_days: 30, features: esimFeatures(), price_cents: 1400, currency: "USD" },
];

const PROXY_PLANS: ProxyPlan[] = [
  { id: "plan_US5GB30D", name: "US Mobile 5GB", type: "shared", country: "US", country_name: "United States", data_gb: 5, duration_days: 30, period: "monthly", quoted_price_cents: 1800, available: true },
  { id: "plan_US10GB30D", name: "US Mobile 10GB", type: "shared", country: "US", country_name: "United States", data_gb: 10, duration_days: 30, period: "monthly", quoted_price_cents: 3000, available: true },
  { id: "plan_GB5GB30D", name: "UK Mobile 5GB", type: "shared", country: "GB", country_name: "United Kingdom", data_gb: 5, duration_days: 30, period: "monthly", quoted_price_cents: 2000, available: true },
  { id: "plan_DE5GB30D", name: "Germany Mobile 5GB", type: "shared", country: "DE", country_name: "Germany", data_gb: 5, duration_days: 30, period: "monthly", quoted_price_cents: 2100, available: true },
  { id: "plan_DEDUSNY30D", name: "United States Carrier A New York (monthly)", type: "dedicated_standard", country: "us", country_name: "United States", carrier: "Carrier A", region: "New York", data_gb: null, duration_days: 30, period: "monthly", quoted_price_cents: 6900, available: true },
  { id: "plan_DEDGBLON7D", name: "United Kingdom Carrier B London (weekly)", type: "dedicated_standard", country: "gb", country_name: "United Kingdom", carrier: "Carrier B", region: "London", data_gb: null, duration_days: 7, period: "weekly", quoted_price_cents: 2900, available: true },
  { id: "plan_DEDDEBER30D", name: "Germany Carrier A Berlin (monthly)", type: "dedicated_standard", country: "de", country_name: "Germany", carrier: "Carrier A", region: "Berlin", data_gb: null, duration_days: 30, period: "monthly", quoted_price_cents: 7400, available: false },
];

const isDedicatedProxy = (p: Proxy): boolean => p.type === "dedicated_standard" || p.type === "dedicated_premium";

const GEO: Record<string, { name: string; available_nodes: number; code?: string }[]> = {
  countries: [
    { code: "US", name: "United States", available_nodes: 4200 },
    { code: "GB", name: "United Kingdom", available_nodes: 1800 },
    { code: "DE", name: "Germany", available_nodes: 1500 },
  ],
  regions: [
    { name: "California", available_nodes: 920 },
    { name: "New York", available_nodes: 740 },
    { name: "Texas", available_nodes: 610 },
  ],
  cities: [
    { name: "Los Angeles", available_nodes: 410 },
    { name: "San Francisco", available_nodes: 300 },
  ],
  isps: [
    { name: "Carrier A", available_nodes: 210 },
    { name: "Carrier B", available_nodes: 160 },
  ],
};

// ── state ────────────────────────────────────────────────────────────────────

class Store {
  balanceCents = 50000; // $500 play-money balance (sandbox has no deposit tool, so spend-only)
  verifications = new Map<string, Verification>();
  messages = new Map<string, VerificationMessage[]>(); // verification id -> SMS, newest first
  rentals = new Map<string, Rental>();
  esims = new Map<string, Esim>();
  proxies = new Map<string, Proxy>();
  dedicateds = new Map<string, DedicatedNumber>();
  createdAtMs = new Map<string, number>(); // entity id -> creation epoch ms
}

// ── response envelope helpers ─────────────────────────────────────────────────

const ok = <T>(data: T, status = 200): HttpResponse => ({ status, body: { success: true, data }, headers: new Headers() });
// Verifications, rentals and dedicated numbers carry pagination next to `data`.
const okPage = <T>(data: T[], nextCursor: string | null): HttpResponse => ({
  status: 200,
  body: { success: true, data, has_more: nextCursor !== null, next_cursor: nextCursor },
  headers: new Headers(),
});
const noContent = (): HttpResponse => ({ status: 204, headers: new Headers() });
const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): HttpResponse => ({
  status,
  body: { success: false, error: { code, message, request_id: uid("req_"), details } },
  headers: new Headers(),
});

// Offset cursors: opaque to the client, like prod's.
function paginate<T>(items: T[], query: URLSearchParams, defaultLimit: number): { page: T[]; nextCursor: string | null } {
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? defaultLimit) || defaultLimit));
  const cursor = query.get("cursor");
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) || 0 : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
  return { page, nextCursor: next };
}

const byStatus = <T extends { status: string }>(items: T[], query: URLSearchParams): T[] => {
  const wanted = query.getAll("status");
  return wanted.length ? items.filter((i) => wanted.includes(i.status)) : items;
};

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// ── entity builders ────────────────────────────────────────────────────────────

function makeFlexGateway(): NonNullable<Proxy["gateway"]> {
  return {
    host: GATEWAY_HOST,
    port: FLEX_PORT,
    protocol: "http",
    username: `vm_${alnum(8)}`,
    password: alnum(12),
    username_geo_hint: FLEX_HINT,
  };
}

export function createSandboxHttpClient(): HttpClient {
  const db = new Store();

  // One expired long-term rental whose number is still held, so re-renting
  // (re_rent_rental) can be tried in the sandbox.
  {
    const id = "ren_sandboxexpired1";
    db.rentals.set(id, {
      id,
      display_id: "LTRSANDBOX1",
      status: "expired",
      phone_number: "+12025550143",
      service_id: "svc_telegram",
      service_name: "Telegram",
      country: "US",
      duration: "7D",
      rental_type: "rental",
      charged_price_cents: 600,
      auto_renew: false,
      next_renewal_price_cents: 600,
      re_rent_available: true,
      re_rent_price_cents: 600,
      re_rent_blocked_at: null,
      created_at: iso(-10 * DAY),
      paid_until: iso(-3 * DAY),
      expires_at: iso(-3 * DAY),
      can_cancel: false,
      cancel_window_expires_at: null,
      messages: [],
    });
    db.createdAtMs.set(id, Date.now() - 10 * DAY);
  }

  // True once READY_AFTER_MS has elapsed since the entity was (re)armed.
  const isReady = (id: string): boolean => Date.now() - (db.createdAtMs.get(id) ?? 0) >= READY_AFTER_MS;

  // Charge the wallet, or return a 402 response if the balance can't cover it.
  const charge = (cents: number): HttpResponse | null =>
    db.balanceCents < cents ? fail(402, "INSUFFICIENT_BALANCE", "Insufficient balance.") : ((db.balanceCents -= cents), null);

  // Lazily flip a just-created verification to code_received once the code has
  // "arrived", mirroring the real "poll get_rental until the code lands" flow.
  const settleVerification = (v: Verification): Verification => {
    if (v.status !== "waiting_for_code" || !isReady(v.id)) return v;
    v.status = "code_received";
    v.code = smsCode();
    v.code_received_at = iso();
    v.can_cancel = false;
    v.allow_reuse = true;
    const sms: VerificationMessage = { code: v.code, text: `Your ${v.service_name} verification code is ${v.code}. Do not share it.`, received_at: v.code_received_at };
    db.messages.set(v.id, [sms, ...(db.messages.get(v.id) ?? [])]);
    return v;
  };

  // Proxies provision asynchronously; flip to active once ready.
  const settleProxy = (p: Proxy): Proxy => {
    if (p.status === "provisioning" && isReady(p.id)) p.status = "active";
    return p;
  };

  // A dedicated number "receives" its first SMS once ready, so the poll flow
  // get_dedicated_number describes is demonstrable.
  const settleDedicated = (d: DedicatedNumber): DedicatedNumber => {
    if ((d.messages?.length ?? 0) === 0 && isReady(d.id)) {
      const code = smsCode();
      d.messages = [{ id: uid("msg_"), code, text: `Your verification code is ${code}`, received_at: iso() }];
    }
    return d;
  };

  function route(method: string, rawPath: string, query: URLSearchParams, opts: HttpRequestOpts): HttpResponse {
    const body = (opts.body ?? {}) as Record<string, unknown>;
    const seg = rawPath.split("/").filter(Boolean); // e.g. ["v1","proxies","prx_1","lists"]

    // ── account ──
    if (method === "GET" && rawPath === "/v1/me") {
      const me: MePayload = {
        id: "acct_sandbox",
        balance: { amount_cents: db.balanceCents, currency: "USD", formatted: formatUsd(db.balanceCents) },
        rate_limits: {
          verifications: { limit: 60, window_seconds: 60 },
          verifications_read: { limit: 600, window_seconds: 60 },
          services: { limit: 60, window_seconds: 60 },
          rentals: { limit: 60, window_seconds: 60 },
          dedicated: { limit: 60, window_seconds: 60 },
          account: { limit: 60, window_seconds: 60 },
          esim: { limit: 60, window_seconds: 60 },
          esim_read: { limit: 600, window_seconds: 60 },
          proxies: { limit: 60, window_seconds: 60 },
          reads: { limit: 60, window_seconds: 60 },
        },
        created_at: iso(-90 * DAY),
      };
      return ok(me);
    }

    // ── SMS services ──
    if (method === "GET" && rawPath === "/v1/services") {
      const q = query.get("q")?.trim().toLowerCase();
      return ok({ country: "us", services: q ? SERVICES.filter((s) => s.name.toLowerCase().includes(q)) : SERVICES });
    }

    // ── verifications ──
    if (method === "POST" && rawPath === "/v1/verifications") {
      const svc = SERVICES.find((s) => s.id === body.service_id);
      if (!svc) return fail(404, "SERVICE_NOT_FOUND", "Service not found.");
      if (body.max_price_cents != null && svc.quoted_price_cents > Number(body.max_price_cents)) {
        return fail(409, "PRICE_OVER_CAP", "Current price exceeds the supplied max_price_cents.", {
          max_price_cents: Number(body.max_price_cents),
          available_price_cents: svc.quoted_price_cents,
        });
      }
      const paid = charge(svc.quoted_price_cents);
      if (paid) return paid;
      const id = uid("ver_");
      const v: Verification = {
        id,
        display_id: id.slice(0, 12),
        status: "waiting_for_code",
        phone_number: phone(),
        service_id: svc.id,
        service_name: svc.name,
        charged_price_cents: svc.quoted_price_cents,
        expires_at: iso(VERIFICATION_WINDOW_MS),
        can_cancel: true,
        created_at: iso(),
        reuse_counter: 0,
        allow_reuse: false,
        allow_paid_reuse: true,
        paid_reuse_price_cents: 50,
      };
      db.verifications.set(id, v);
      db.createdAtMs.set(id, Date.now());
      return ok({ verification: v }, 201);
    }
    if (method === "GET" && rawPath === "/v1/verifications") {
      // Newest first, like prod.
      const all = byStatus([...db.verifications.values()].map(settleVerification).reverse(), query);
      const { page, nextCursor } = paginate(all, query, 20);
      return okPage(page, nextCursor);
    }
    if (seg[1] === "verifications" && seg[2]) {
      const v = db.verifications.get(seg[2]);
      if (!v) return fail(404, "NOT_FOUND", "Verification not found.");
      if (method === "GET" && !seg[3]) return ok({ verification: settleVerification(v) });
      if (method === "GET" && seg[3] === "messages") {
        settleVerification(v);
        return ok({ messages: db.messages.get(v.id) ?? [] });
      }
      if (method === "POST" && seg[3] === "cancel") {
        // Refund only if the code hasn't landed yet. settleVerification reflects
        // elapsed time, so eligibility doesn't depend on whether the client polled.
        const refund = settleVerification(v).status === "waiting_for_code" ? v.charged_price_cents : 0;
        if (refund > 0) db.balanceCents += refund;
        v.status = "cancelled";
        return ok({ verification: { id: v.id, status: v.status, refunded_cents: refund } });
      }
      // paid reuse (/reuse/paid) is more specific than free reuse (/reuse) - match it first
      if (method === "POST" && seg[3] === "reuse" && seg[4] === "paid") {
        if (body.accept_charge_cents !== v.paid_reuse_price_cents) {
          return fail(400, "VALIDATION_ERROR", `accept_charge_cents must equal the current paid-reuse price (${v.paid_reuse_price_cents}).`);
        }
        const paid = charge(v.paid_reuse_price_cents);
        if (paid) return paid;
        v.reuse_counter += 1;
        v.charged_reuse_cents = v.paid_reuse_price_cents;
        v.status = "waiting_for_code";
        v.code = undefined;
        v.code_received_at = undefined;
        db.createdAtMs.set(v.id, Date.now());
        return ok({ verification: v });
      }
      if (method === "POST" && seg[3] === "reuse") {
        v.reuse_counter += 1;
        v.status = "waiting_for_code";
        v.code = undefined;
        v.code_received_at = undefined;
        db.createdAtMs.set(v.id, Date.now());
        return ok({ verification: v });
      }
    }

    // ── rentals (long-term + dedicated) ──
    if (rawPath === "/v1/rentals" && method === "GET") {
      const { page, nextCursor } = paginate(byStatus([...db.rentals.values()].reverse(), query), query, 20);
      return okPage(page, nextCursor);
    }
    if (rawPath === "/v1/rentals" && method === "POST") {
      const svc = SERVICES.find((s) => s.id === body.service_id);
      if (!svc) return fail(404, "SERVICE_NOT_FOUND", "Service not found.");
      const duration = String(body.duration ?? "");
      const tierPrice: Record<string, number | undefined> = {
        "3D": svc.ltr_3d_price_cents,
        "7D": svc.ltr_7d_price_cents,
        "14D": svc.ltr_14d_price_cents,
        "30D": svc.ltr_30d_price_cents,
      };
      const price = tierPrice[duration];
      if (!price) return fail(404, "LTR_NOT_AVAILABLE", "This rental duration is not offered for the service.");
      if (body.max_price_cents != null && price > Number(body.max_price_cents)) {
        return fail(409, "PRICE_OVER_CAP", "Current price exceeds the supplied max_price_cents.", {
          max_price_cents: Number(body.max_price_cents),
          available_price_cents: price,
        });
      }
      const paid = charge(price);
      if (paid) return paid;
      const id = uid("ren_");
      const days = parseInt(duration, 10) || 7;
      const r: Rental = {
        id,
        display_id: id.slice(0, 12),
        status: "active",
        phone_number: phone(),
        service_id: svc.id,
        service_name: svc.name,
        country: "US",
        duration,
        rental_type: "rental",
        charged_price_cents: price,
        auto_renew: false,
        next_renewal_price_cents: price,
        re_rent_available: false,
        re_rent_price_cents: null,
        re_rent_blocked_at: null,
        created_at: iso(),
        paid_until: iso(days * DAY),
        expires_at: iso(days * DAY),
        can_cancel: true,
        cancel_window_expires_at: iso(RENTAL_CANCEL_WINDOW_MS),
        messages: [],
      };
      db.rentals.set(id, r);
      db.createdAtMs.set(id, Date.now());
      return ok(r, 201);
    }
    if (seg[1] === "rentals" && seg[2]) {
      const r = db.rentals.get(seg[2]);
      if (!r) return fail(404, "NOT_FOUND", "Rental not found.");
      if (method === "GET" && !seg[3]) return ok(r);
      if (method === "DELETE") {
        const inWindow = Date.now() - (db.createdAtMs.get(r.id) ?? 0) < RENTAL_CANCEL_WINDOW_MS;
        if (r.status !== "active" || !inWindow) {
          return fail(409, "CANCEL_NOT_ALLOWED", "This verification can no longer be cancelled.");
        }
        db.balanceCents += r.charged_price_cents;
        r.status = "cancelled";
        r.can_cancel = false;
        return ok(r);
      }
      if (method === "POST" && seg[3] === "re_rent") {
        if (r.status !== "expired" || !r.re_rent_available || r.re_rent_price_cents == null) {
          return fail(410, "RE_RENT_NOT_AVAILABLE", "This number can no longer be re-rented.");
        }
        const paid = charge(r.re_rent_price_cents);
        if (paid) return paid;
        const days = parseInt(r.duration, 10) || 7;
        r.status = "active";
        r.re_rent_available = false;
        r.re_rent_price_cents = null;
        r.paid_until = iso(days * DAY);
        r.expires_at = iso(days * DAY);
        return ok(r);
      }
      if (method === "POST" && seg[3] === "auto_renew") {
        if (typeof body.enabled !== "boolean") return fail(400, "VALIDATION_ERROR", "enabled must be a boolean.");
        r.auto_renew = body.enabled;
        return ok(r);
      }
    }

    // ── dedicated numbers ──
    if (rawPath === "/v1/dedicated/countries" && method === "GET") {
      return ok(DEDICATED_COUNTRIES);
    }
    if (rawPath === "/v1/dedicated/numbers" && method === "GET") {
      // messages are always empty on the list endpoint
      const all = byStatus([...db.dedicateds.values()].reverse(), query).map((d) => ({ ...d, messages: [] }));
      const { page, nextCursor } = paginate(all, query, 20);
      return okPage(page, nextCursor);
    }
    if (rawPath === "/v1/dedicated/numbers" && method === "POST") {
      const c = DEDICATED_COUNTRIES.find((x) => x.country === String(body.country ?? "").toLowerCase());
      if (!c) return fail(404, "DEDICATED_NOT_AVAILABLE", "No dedicated numbers for this country.");
      if (!c.in_stock) return fail(503, "SERVICE_OUT_OF_STOCK", "This country is out of stock.");
      if (body.max_price_cents != null && c.quoted_price_cents > Number(body.max_price_cents)) {
        return fail(409, "PRICE_OVER_CAP", "Current price exceeds max_price_cents.", {
          max_price_cents: Number(body.max_price_cents),
          available_price_cents: c.quoted_price_cents,
        });
      }
      const paid = charge(c.quoted_price_cents);
      if (paid) return paid;
      const id = uid("ded_");
      const d: DedicatedNumber = {
        id,
        display_id: id.slice(4, 10).toUpperCase(),
        status: "active",
        phone_number: dedPhone(c.country),
        country: c.country,
        country_name: c.name,
        billing_period: "monthly",
        nickname: null,
        quoted_price_cents: c.quoted_price_cents,
        charged_price_cents: c.quoted_price_cents,
        next_renewal_price_cents: c.quoted_price_cents,
        auto_renew: Boolean(body.auto_renew),
        created_at: iso(),
        paid_until: iso(30 * DAY),
        expires_at: iso(30 * DAY),
        messages: [],
      };
      db.dedicateds.set(id, d);
      db.createdAtMs.set(id, Date.now());
      return ok(d, 201);
    }
    if (seg[1] === "dedicated" && seg[2] === "numbers" && seg[3]) {
      const d = db.dedicateds.get(seg[3]);
      if (!d) return fail(404, "NOT_FOUND", "Dedicated number not found.");
      if (method === "GET" && !seg[4]) return ok(settleDedicated(d));
      if (method === "POST" && seg[4] === "auto_renew") {
        d.auto_renew = Boolean(body.enabled);
        return ok({ ...d, messages: [] });
      }
    }

    // ── eSIM products ──
    if (rawPath === "/v1/esim_products" && method === "GET") {
      let products = ESIM_PRODUCTS.filter((p) => !p.id.startsWith("prod_topup"));
      const countries = query.get("countries")?.toUpperCase().split(",").filter(Boolean);
      const minGb = query.get("min_data_gb");
      const minDays = query.get("min_validity_days");
      const has5g = query.get("has_5g");
      const search = query.get("search");
      if (countries?.length) products = products.filter((p) => p.countries.some((c) => countries.includes(c)));
      if (minGb) products = products.filter((p) => p.data_unlimited || (p.data_limit_gb ?? 0) >= Number(minGb));
      if (minDays) products = products.filter((p) => p.validity_days >= Number(minDays));
      if (has5g) products = products.filter((p) => p.features.has_5g === (has5g === "true"));
      if (search) products = products.filter((p) => p.title.toLowerCase().includes(search.toLowerCase()));
      return ok({ products, next_cursor: null });
    }
    if (seg[1] === "esim_products" && seg[2] && method === "GET") {
      const product = ESIM_PRODUCTS.find((p) => p.id === seg[2]);
      if (!product) return fail(404, "NOT_FOUND", "Product not found.");
      return ok({ product });
    }

    // ── eSIMs ──
    if (rawPath === "/v1/esims" && method === "GET") {
      const { page, nextCursor } = paginate(byStatus([...db.esims.values()], query), query, 50);
      return ok({ esims: page, next_cursor: nextCursor });
    }
    if (rawPath === "/v1/esims" && method === "POST") {
      const product = ESIM_PRODUCTS.find((p) => p.id === body.product_id);
      if (!product) return fail(404, "PRODUCT_NOT_FOUND", "Product not found.");
      if (body.max_price_cents != null && product.price_cents > Number(body.max_price_cents)) {
        return fail(409, "PRICE_OVER_CAP", "Current price exceeds the supplied max_price_cents.", { available_price_cents: product.price_cents });
      }
      const paid = charge(product.price_cents);
      if (paid) return paid;
      const id = uid("esim_");
      const esim: Esim = {
        id,
        status: "completed",
        product_id: product.id,
        is_topup: false,
        parent_order_id: null,
        iccid: `8910${rnd(10, 99)}${hex(14)}`,
        // The SM-DP+ matching ID; the LPA string is LPA:1$<smdp_address>$<activation_code>.
        activation_code: `K2-${alnum(6).toUpperCase()}-${alnum(6).toUpperCase()}`,
        qr_code_url: `/v1/esims/${id}/qr.png`,
        smdp_address: "smdp.voidmob.com",
        data_limit_gb: product.data_limit_gb,
        data_unlimited: product.data_unlimited,
        validity_days: product.validity_days,
        countries: product.countries,
        routing_location: product.routing_location,
        charged_price_cents: product.price_cents,
        currency: "USD",
        created_at: iso(),
        completed_at: iso(),
        expires_at: iso(product.validity_days * DAY),
      };
      db.esims.set(id, esim);
      return ok({ esim }, 201);
    }
    if (seg[1] === "esims" && seg[2]) {
      const esim = db.esims.get(seg[2]);
      if (seg[3] === "qr.png" && method === "GET") {
        if (!esim) return fail(404, "NOT_FOUND", "eSIM not found.");
        return { status: 200, binary: PNG_1x1, headers: new Headers({ "content-type": "image/png" }) };
      }
      if (!esim) return fail(404, "NOT_FOUND", "eSIM not found.");
      if (method === "GET" && !seg[3]) return ok({ esim });
      if (seg[3] === "usage" && method === "GET") {
        // Usage is eSIM-scoped: one package per order on the eSIM (base plan +
        // top-ups), whichever order id is asked about.
        const baseId = esim.parent_order_id ?? esim.id;
        const chain = [...db.esims.values()].filter((e) => e.id === baseId || e.parent_order_id === baseId);
        const usage: EsimUsage = {
          esim_id: baseId,
          esim_status: "in_use",
          packages: chain.map((order, i) => {
            const totalGb = order.data_unlimited ? 50 : order.data_limit_gb ?? 0;
            const totalMb = totalGb * 1024;
            // Only the first package has been used so far; top-ups are queued.
            const usedMb = i === 0 ? Math.min(totalMb, rnd(0, Math.floor(totalMb * 0.6))) : 0;
            return {
              name: order.is_topup ? `Top-up ${i}` : "Base plan",
              total_mb: totalMb,
              total_gb: totalGb,
              used_mb: usedMb,
              used_gb: Number((usedMb / 1024).toFixed(2)),
              remaining_mb: totalMb - usedMb,
              remaining_gb: Number(((totalMb - usedMb) / 1024).toFixed(2)),
              percent_used: totalMb ? Math.round((usedMb / totalMb) * 100) : 0,
              activation_date: i === 0 ? order.completed_at : null,
              expiration_date: order.expires_at,
            };
          }),
        };
        return ok({ usage });
      }
      if (seg[3] === "topups" && method === "GET") {
        const topups = ESIM_PRODUCTS.filter((p) => p.id.startsWith("prod_topup"));
        return ok({ supports_topup: true, topups });
      }
      if (seg[3] === "topups" && method === "POST") {
        const product = ESIM_PRODUCTS.find((p) => p.id === body.product_id);
        if (!product) return fail(404, "PRODUCT_NOT_FOUND", "Top-up product not found.");
        if (body.max_price_cents != null && product.price_cents > Number(body.max_price_cents)) {
          return fail(409, "PRICE_OVER_CAP", "Current price exceeds the supplied max_price_cents.", { available_price_cents: product.price_cents });
        }
        const paid = charge(product.price_cents);
        if (paid) return paid;
        const id = uid("esim_");
        const topup: Esim = {
          id,
          status: "completed",
          product_id: product.id,
          is_topup: true,
          parent_order_id: esim.id,
          // Top-ups ride the installed profile: no install details of their own.
          iccid: esim.iccid,
          activation_code: null,
          qr_code_url: null,
          smdp_address: null,
          data_limit_gb: product.data_limit_gb,
          data_unlimited: product.data_unlimited,
          validity_days: product.validity_days,
          countries: esim.countries,
          routing_location: esim.routing_location,
          charged_price_cents: product.price_cents,
          currency: "USD",
          created_at: iso(),
          completed_at: iso(),
          expires_at: esim.expires_at,
        };
        db.esims.set(id, topup);
        return ok({ esim: topup }, 201);
      }
    }

    // ── proxy plans ──
    if (rawPath === "/v1/proxy_plans" && method === "GET") {
      const type = query.get("type");
      const country = query.get("country");
      const minGb = query.get("min_gb");
      // Without type the catalog is shared-only (the original response).
      let plans = PROXY_PLANS.filter((p) =>
        type === "all" ? true : p.type === (type === "dedicated_standard" ? "dedicated_standard" : "shared"),
      );
      if (country) plans = plans.filter((p) => p.country?.toUpperCase() === country.toUpperCase());
      if (minGb) plans = plans.filter((p) => (p.data_gb ?? 0) >= Number(minGb));
      if (!type) return ok({ plans });
      if (query.get("available") === "true") plans = plans.filter((p) => p.available !== false);
      return ok({ plans, next_cursor: null });
    }
    if (seg[1] === "proxy_plans" && seg[2] && method === "GET") {
      const plan = PROXY_PLANS.find((p) => p.id === seg[2]);
      return plan ? ok({ plan }) : fail(404, "PROXY_PLAN_NOT_FOUND", "Unknown proxy plan id.");
    }

    // ── proxies ──
    if (rawPath === "/v1/proxies" && method === "GET") {
      const { page, nextCursor } = paginate(byStatus([...db.proxies.values()].map(settleProxy), query), query, 50);
      return ok({ proxies: page, next_cursor: nextCursor });
    }
    if (rawPath === "/v1/proxies" && method === "POST") {
      const plan = PROXY_PLANS.find((p) => p.id === body.plan_id);
      if (!plan) return fail(404, "PROXY_PLAN_NOT_FOUND", "Unknown proxy plan id.");
      if (Number(body.max_price_cents) < plan.quoted_price_cents) {
        return fail(409, "PRICE_MISMATCH", "Price exceeds the supplied max_price_cents.");
      }
      if (plan.available === false) {
        return fail(503, "SERVICE_OUT_OF_STOCK", "This service is temporarily unavailable. Please try again shortly.");
      }
      const paid = charge(plan.quoted_price_cents);
      if (paid) return paid;
      const id = uid("prx_");
      const dedicated = plan.type === "dedicated_standard";
      // A dedicated modem is issued on the spot; a shared package provisions.
      const proxy: Proxy = {
        id,
        status: dedicated ? "active" : "provisioning",
        type: plan.type,
        country: dedicated ? plan.country : null,
        carrier: dedicated ? plan.carrier ?? null : null,
        plan_id: plan.id,
        data_gb_total: plan.data_gb ?? 0,
        data_bytes_used: 0,
        charged_price_cents: plan.quoted_price_cents,
        expires_at: iso(plan.duration_days * DAY),
        auto_renew: false,
        next_renewal_price_cents: plan.quoted_price_cents,
        gateway: dedicated
          // A modem's own endpoint (documentation-range IP), HTTP + SOCKS5 ports.
          ? { host: `203.0.113.${rnd(1, 254)}`, port: 8000 + rnd(0, 999), protocol: "http", username: `vm_${alnum(6)}`, password: alnum(12), socks_port: 9000 + rnd(0, 999) }
          : null,
        lists: [],
        rotation_url: dedicated ? `https://dashboard.voidmob.com/api/proxy/rotate/${alnum(24)}` : null,
        created_at: iso(),
      };
      db.proxies.set(id, proxy);
      db.createdAtMs.set(id, Date.now());
      return ok({ proxy }, 202);
    }
    if (seg[1] === "proxies" && seg[2]) {
      const proxy = db.proxies.get(seg[2]);
      if (!proxy) return fail(404, "NOT_FOUND", "Proxy not found.");

      if (method === "GET" && !seg[3]) return ok({ proxy: settleProxy(proxy) });
      if (seg[3] === "usage" && method === "GET") {
        if (isDedicatedProxy(proxy)) return fail(404, "PROXY_NOT_FOUND", "Proxy not found.");
        return ok({ usage: { total_gb: proxy.data_gb_total, used_gb: Number((proxy.data_bytes_used / 1024 ** 3).toFixed(2)) } });
      }
      if (seg[3] === "flex_credentials" && method === "POST") {
        settleProxy(proxy);
        if (isDedicatedProxy(proxy)) return fail(409, "PROXY_NOT_READY", "Proxy is still provisioning. Retry shortly.");
        if (proxy.status === "active" && !proxy.gateway) proxy.gateway = makeFlexGateway();
        return ok({ proxy });
      }
      if (seg[3] === "rotate_ip" && method === "POST") {
        // Shared proxies rotate per request; only a dedicated modem rotates on demand.
        if (!isDedicatedProxy(proxy)) return fail(422, "NOT_SUPPORTED", "This action is not supported.");
        return ok({ proxy_id: proxy.id, rotated_at: iso(), current_ip: ip() });
      }
      if (seg[3] === "renew" && method === "POST") {
        if (isDedicatedProxy(proxy) && proxy.status !== "active") {
          return fail(409, "PROXY_EXPIRED", "Proxy has expired.");
        }
        const renewalPrice = proxy.next_renewal_price_cents ?? proxy.charged_price_cents;
        if (Number(body.max_price_cents) < renewalPrice) {
          return fail(409, "PRICE_MISMATCH", "Price exceeds the supplied max_price_cents.");
        }
        const paid = charge(renewalPrice);
        if (paid) return paid;
        const days = PROXY_PLANS.find((p) => p.id === proxy.plan_id)?.duration_days ?? 30;
        proxy.expires_at = iso(days * DAY);
        return ok({ proxy });
      }
      if (seg[3] === "auto_renew" && method === "POST") {
        if (proxy.type !== "dedicated_standard") return fail(422, "NOT_SUPPORTED", "Not supported for this proxy.");
        proxy.auto_renew = Boolean(body.enabled);
        return ok({ proxy: settleProxy(proxy) });
      }
      if (seg[3] === "topup" && method === "POST") {
        if (isDedicatedProxy(proxy)) return fail(422, "NOT_SUPPORTED", "Not supported for this proxy.");
        // Priced from the plan's price per GB, like prod.
        const plan = PROXY_PLANS.find((p) => p.id === proxy.plan_id);
        const gb = Number(body.additional_gb ?? 0);
        const price = plan?.data_gb ? Math.round((plan.quoted_price_cents / plan.data_gb) * gb) : 0;
        if (body.max_price_cents === undefined) return fail(400, "VALIDATION_ERROR", "max_price_cents is required.");
        if (price > Number(body.max_price_cents)) return fail(409, "PRICE_MISMATCH", "Price exceeds the supplied max_price_cents.");
        const paid = charge(price);
        if (paid) return paid;
        proxy.data_gb_total += gb;
        return ok({ proxy });
      }
      if (seg[3] === "regenerate_password" && method === "POST") {
        // Rotates the Flex gateway password; the gateway must exist first.
        if (isDedicatedProxy(proxy) || !proxy.gateway) return fail(409, "PROXY_NOT_READY", "Proxy is still provisioning. Retry shortly.");
        proxy.gateway = { ...proxy.gateway, password: alnum(12) };
        return ok({ proxy });
      }
      if (seg[3] === "lists" && !seg[4] && method === "POST") {
        if (settleProxy(proxy).status !== "active") return fail(409, "PROXY_NOT_READY", "Proxy is still provisioning. Retry shortly.");
        const id = uid("list_");
        const single = typeof body.country === "string" ? body.country.toUpperCase() : null;
        const login = { username: `vm_${alnum(8)}`, password: alnum(12) };
        // IP-whitelist lists authenticate by source IP: no credentials.
        const network = typeof body.network === "string" && body.network ? body.network : null;
        const list: ProxyList = {
          id,
          proxy_id: proxy.id,
          name: String(body.name ?? "list"),
          country: single,
          countries: Array.isArray(body.countries) ? (body.countries as string[]).map((c) => c.toUpperCase()) : null,
          region: (body.region as string) ?? null,
          city: (body.city as string) ?? null,
          isp: (body.isp as string) ?? null,
          zip: (body.zip as string) ?? null,
          rotation_period_seconds: Number(body.rotation_period_seconds ?? 0),
          rotation_mode: String(body.rotation_mode ?? "instant"),
          format: String(body.format ?? "login_pass_host_port"),
          credentials: network ? null : { host: GATEWAY_HOST, port: LIST_PORT, protocol: "http", ...login },
          // entries[] is login:pass@host:port whatever `format` says (bare
          // host:port for an IP-whitelist list).
          entries: [network ? `${GATEWAY_HOST}:${LIST_PORT}` : `${login.username}:${login.password}@${GATEWAY_HOST}:${LIST_PORT}`],
          network,
          activation_note: "List active within a few minutes of creation.",
          created_at: iso(),
        };
        proxy.lists.push(list);
        return ok({ list }, 201);
      }
      if (seg[3] === "lists" && seg[4] && method === "DELETE") {
        proxy.lists = proxy.lists.filter((l) => l.id !== seg[4]);
        return noContent();
      }
      if (seg[3] === "lists" && seg[4]) {
        const list = proxy.lists.find((l) => l.id === seg[4]);
        if (!list) return fail(404, "PROXY_LIST_NOT_FOUND", "Proxy list not found.");
        if (method === "PATCH" && !seg[5]) {
          // The IP whitelist is create-time only; everything else can change.
          if ("network" in body) return fail(400, "VALIDATION_ERROR", "network cannot be changed on an existing list.");
          if (typeof body.country === "string") {
            list.country = body.country.toUpperCase();
            list.countries = null;
          }
          if (Array.isArray(body.countries)) {
            list.countries = (body.countries as string[]).map((c) => c.toUpperCase());
            list.country = null;
            list.region = list.city = list.isp = list.zip = null;
          }
          for (const key of ["region", "city", "isp", "zip", "name", "rotation_mode", "format"] as const) {
            if (typeof body[key] === "string") (list as Record<string, unknown>)[key] = body[key];
          }
          if (typeof body.rotation_period_seconds === "number") list.rotation_period_seconds = body.rotation_period_seconds;
          return ok({ list });
        }
        if (method === "POST" && seg[5] === "regenerate_password") {
          if (list.credentials) {
            list.credentials = { ...list.credentials, password: alnum(12) };
            list.entries = [`${list.credentials.username}:${list.credentials.password}@${GATEWAY_HOST}:${LIST_PORT}`];
          }
          return ok({ list });
        }
      }
    }

    // ── geo (cascading) ──
    if (rawPath === "/v1/geo" && method === "GET") {
      const country = query.get("country");
      const region = query.get("region");
      const city = query.get("city");
      if (city) return ok({ isps: GEO.isps });
      if (region) return ok({ cities: GEO.cities });
      if (country) return ok({ regions: GEO.regions });
      return ok({ countries: GEO.countries });
    }

    return fail(404, "NOT_FOUND", `No sandbox route for ${method} ${rawPath}.`);
  }

  return {
    async request(method, path, opts = {}): Promise<HttpResponse> {
      const [rawPath, queryStr = ""] = path.split("?");
      return route(method.toUpperCase(), rawPath, new URLSearchParams(queryStr), opts);
    },
  };
}

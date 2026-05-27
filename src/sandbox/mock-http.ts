import type { HttpClient, HttpResponse, HttpRequestOpts } from "../client/http.js";
import type {
  MePayload,
  SmsService,
  Verification,
  Rental,
  EsimProduct,
  Esim,
  EsimUsage,
  Proxy,
  ProxyList,
  ProxyPlan,
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
const phone = (): string => `+1${rnd(200, 989)}${rnd(200, 989)}${rnd(1000, 9999)}`;
const smsCode = (): string => String(rnd(100000, 999999));
const ip = (): string => `${rnd(11, 223)}.${rnd(1, 254)}.${rnd(1, 254)}.${rnd(1, 254)}`;
const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;

// Time (ms) before a verification's code "arrives" / a proxy goes active, so the
// poll-until-ready flow the tools describe is demonstrable without a long wait.
const READY_AFTER_MS = 1_500;

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
  { id: "svc_dedicated_28d", name: "Dedicated (all services)", quoted_price_cents: 3500, available: true, ltr_28d_price_cents: 3500 },
];

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
  { id: "pplan_us_5gb_30d", name: "US Mobile 5GB", type: "shared", country: "US", country_name: "United States", data_gb: 5, duration_days: 30, period: "monthly", quoted_price_cents: 1800, available: true },
  { id: "pplan_us_10gb_30d", name: "US Mobile 10GB", type: "shared", country: "US", country_name: "United States", data_gb: 10, duration_days: 30, period: "monthly", quoted_price_cents: 3000, available: true },
  { id: "pplan_gb_5gb_30d", name: "UK Mobile 5GB", type: "shared", country: "GB", country_name: "United Kingdom", data_gb: 5, duration_days: 30, period: "monthly", quoted_price_cents: 2000, available: true },
  { id: "pplan_de_5gb_30d", name: "Germany Mobile 5GB", type: "shared", country: "DE", country_name: "Germany", data_gb: 5, duration_days: 30, period: "monthly", quoted_price_cents: 2100, available: true },
];

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
  rentals = new Map<string, Rental>();
  esims = new Map<string, Esim>();
  proxies = new Map<string, Proxy>();
  createdAtMs = new Map<string, number>(); // entity id -> creation epoch ms
}

// ── response envelope helpers ─────────────────────────────────────────────────

const ok = <T>(data: T, status = 200): HttpResponse => ({ status, body: { success: true, data }, headers: new Headers() });
const noContent = (): HttpResponse => ({ status: 204, headers: new Headers() });
const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): HttpResponse => ({
  status,
  body: { success: false, error: { code, message, request_id: uid("req_"), details } },
  headers: new Headers(),
});

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// ── entity builders ────────────────────────────────────────────────────────────

function makeGateway(geoHint = "us"): NonNullable<Proxy["gateway"]> {
  return {
    host: `${geoHint}.gw.voidmob.com`,
    port: 10000 + rnd(0, 4999),
    protocol: "http",
    username: `vm_${alnum(6)}`,
    password: alnum(12),
    username_geo_hint: geoHint,
  };
}

export function createSandboxHttpClient(): HttpClient {
  const db = new Store();

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
    return v;
  };

  // Proxies provision asynchronously; flip to active once ready.
  const settleProxy = (p: Proxy): Proxy => {
    if (p.status === "provisioning" && isReady(p.id)) p.status = "active";
    return p;
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
          default: { limit: 120, window_seconds: 60 },
          purchases: { limit: 30, window_seconds: 60 },
        },
        created_at: iso(-90 * DAY),
      };
      return ok(me);
    }

    // ── SMS services ──
    if (method === "GET" && rawPath === "/v1/services") {
      return ok({ services: SERVICES });
    }

    // ── verifications ──
    if (method === "POST" && rawPath === "/v1/verifications") {
      const svc = SERVICES.find((s) => s.id === body.service_id);
      if (!svc) return fail(404, "NOT_FOUND", "Service not found.");
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
        expires_at: iso(20 * 60_000),
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
    if (seg[1] === "verifications" && seg[2]) {
      const v = db.verifications.get(seg[2]);
      if (!v) return fail(404, "NOT_FOUND", "Verification not found.");
      if (method === "GET" && !seg[3]) return ok({ verification: settleVerification(v) });
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
      return ok([...db.rentals.values()]);
    }
    if (rawPath === "/v1/rentals" && method === "POST") {
      const svc = SERVICES.find((s) => s.id === body.service_id);
      if (!svc) return fail(404, "NOT_FOUND", "Service not found.");
      const price = Number(body.max_price_cents ?? svc.quoted_price_cents);
      const paid = charge(price);
      if (paid) return paid;
      const id = uid("ren_");
      const duration = String(body.duration ?? "7D");
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
        cancel_window_expires_at: iso(30_000),
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
        r.status = "cancelled";
        return ok(r);
      }
      if (method === "POST" && seg[3] === "re_rent") {
        const paid = charge(r.charged_price_cents);
        if (paid) return paid;
        const days = parseInt(r.duration, 10) || 7;
        r.status = "active";
        r.paid_until = iso(days * DAY);
        r.expires_at = iso(days * DAY);
        return ok(r);
      }
      if (method === "POST" && seg[3] === "auto_renew") {
        r.auto_renew = Boolean(body.auto_renew);
        return ok(r);
      }
    }

    // ── eSIM products ──
    if (rawPath === "/v1/esim_products" && method === "GET") {
      let products = ESIM_PRODUCTS.filter((p) => !p.id.startsWith("prod_topup"));
      const country = query.get("country");
      const minGb = query.get("min_data_gb");
      const minDays = query.get("min_validity_days");
      const has5g = query.get("has_5g");
      const search = query.get("search");
      if (country) products = products.filter((p) => p.countries.includes(country.toUpperCase()));
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
      return ok({ esims: [...db.esims.values()] });
    }
    if (rawPath === "/v1/esims" && method === "POST") {
      const product = ESIM_PRODUCTS.find((p) => p.id === body.product_id);
      if (!product) return fail(404, "NOT_FOUND", "Product not found.");
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
        activation_code: `LPA:1$smdp.voidmob.com$${hex(32).toUpperCase()}`,
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
        const totalGb = esim.data_unlimited ? 50 : esim.data_limit_gb ?? 0;
        const totalMb = totalGb * 1024;
        const usedMb = Math.min(totalMb, rnd(0, Math.floor(totalMb * 0.6)));
        const usage: EsimUsage = {
          esim_id: esim.id,
          esim_status: esim.status,
          packages: [
            {
              name: "Primary",
              total_mb: totalMb,
              total_gb: totalGb,
              used_mb: usedMb,
              used_gb: Number((usedMb / 1024).toFixed(2)),
              remaining_mb: totalMb - usedMb,
              remaining_gb: Number(((totalMb - usedMb) / 1024).toFixed(2)),
              percent_used: totalMb ? Math.round((usedMb / totalMb) * 100) : 0,
              activation_date: esim.completed_at,
              expiration_date: esim.expires_at,
            },
          ],
        };
        return ok({ usage });
      }
      if (seg[3] === "topups" && method === "GET") {
        const topups = ESIM_PRODUCTS.filter((p) => p.id.startsWith("prod_topup"));
        return ok({ supports_topup: true, topups });
      }
      if (seg[3] === "topups" && method === "POST") {
        const product = ESIM_PRODUCTS.find((p) => p.id === body.product_id);
        if (!product) return fail(404, "NOT_FOUND", "Top-up product not found.");
        const paid = charge(product.price_cents);
        if (paid) return paid;
        const id = uid("esim_");
        const topup: Esim = {
          id,
          status: "completed",
          product_id: product.id,
          is_topup: true,
          parent_order_id: esim.id,
          iccid: esim.iccid,
          activation_code: esim.activation_code,
          qr_code_url: esim.qr_code_url,
          smdp_address: esim.smdp_address,
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
      let plans = PROXY_PLANS;
      const country = query.get("country");
      const minGb = query.get("min_gb");
      if (country) plans = plans.filter((p) => p.country === country.toUpperCase());
      if (minGb) plans = plans.filter((p) => p.data_gb >= Number(minGb));
      return ok({ plans });
    }

    // ── proxies ──
    if (rawPath === "/v1/proxies" && method === "GET") {
      return ok({ proxies: [...db.proxies.values()].map(settleProxy) });
    }
    if (rawPath === "/v1/proxies" && method === "POST") {
      const plan = PROXY_PLANS.find((p) => p.id === body.plan_id);
      if (!plan) return fail(404, "NOT_FOUND", "Plan not found.");
      const paid = charge(plan.quoted_price_cents);
      if (paid) return paid;
      const id = uid("prx_");
      const proxy: Proxy = {
        id,
        status: "provisioning",
        plan_id: plan.id,
        data_gb_total: plan.data_gb,
        data_bytes_used: 0,
        charged_price_cents: plan.quoted_price_cents,
        expires_at: iso(plan.duration_days * DAY),
        gateway: null,
        lists: [],
        rotation_url: null,
        created_at: iso(),
      };
      db.proxies.set(id, proxy);
      db.createdAtMs.set(id, Date.now());
      return ok({ proxy }, 202);
    }
    if (seg[1] === "proxies" && seg[2]) {
      const proxy = db.proxies.get(seg[2]);
      if (!proxy) return fail(404, "NOT_FOUND", "Proxy not found.");
      const geoHint = (PROXY_PLANS.find((p) => p.id === proxy.plan_id)?.country ?? "us").toLowerCase();

      if (method === "GET" && !seg[3]) return ok({ proxy: settleProxy(proxy) });
      if (seg[3] === "usage" && method === "GET") {
        return ok({ usage: { total_gb: proxy.data_gb_total, used_gb: Number((proxy.data_bytes_used / 1024 ** 3).toFixed(2)) } });
      }
      if (seg[3] === "nolist_credentials" && method === "POST") {
        settleProxy(proxy);
        if (proxy.status === "active" && !proxy.gateway) proxy.gateway = makeGateway(geoHint);
        return ok({ proxy });
      }
      if (seg[3] === "rotate_ip" && method === "POST") {
        return ok({ proxy_id: proxy.id, rotated_at: iso(), current_ip: ip() });
      }
      if (seg[3] === "renew" && method === "POST") {
        const paid = charge(Number(body.max_price_cents ?? proxy.charged_price_cents));
        if (paid) return paid;
        const days = PROXY_PLANS.find((p) => p.id === proxy.plan_id)?.duration_days ?? 30;
        proxy.expires_at = iso(days * DAY);
        return ok({ proxy });
      }
      if (seg[3] === "topup" && method === "POST") {
        const paid = charge(Number(body.max_price_cents ?? 0));
        if (paid) return paid;
        proxy.data_gb_total += Number(body.additional_gb ?? 0);
        return ok({ proxy });
      }
      if (seg[3] === "regenerate_password" && method === "POST") {
        proxy.gateway = makeGateway(geoHint);
        return ok({ proxy });
      }
      if (seg[3] === "lists" && !seg[4] && method === "POST") {
        const id = uid("plist_");
        const single = typeof body.country === "string" ? body.country : null;
        const gw = makeGateway(geoHint);
        const list: ProxyList = {
          id,
          proxy_id: proxy.id,
          name: String(body.name ?? "list"),
          country: single,
          countries: Array.isArray(body.countries) ? (body.countries as string[]) : null,
          region: (body.region as string) ?? null,
          city: (body.city as string) ?? null,
          isp: (body.isp as string) ?? null,
          zip: (body.zip as string) ?? null,
          rotation_period_seconds: Number(body.rotation_period_seconds ?? 0),
          rotation_mode: String(body.rotation_mode ?? "instant"),
          format: String(body.format ?? "login_pass_host_port"),
          credentials: { host: gw.host, port: gw.port, protocol: gw.protocol, username: gw.username, password: gw.password },
          entries: [`${gw.host}:${gw.port}:${gw.username}:${gw.password}`],
          activation_note: "Active within 1-2 minutes.",
          created_at: iso(),
        };
        proxy.lists.push(list);
        return ok({ list }, 201);
      }
      if (seg[3] === "lists" && seg[4] && method === "DELETE") {
        proxy.lists = proxy.lists.filter((l) => l.id !== seg[4]);
        return noContent();
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

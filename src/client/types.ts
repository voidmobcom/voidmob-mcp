import { z } from "zod";

// ── Common envelopes ────────────────────────────────────────────────────────

export const SuccessEnvelope = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ success: z.literal(true), data: inner });

// ── /v1/me ──────────────────────────────────────────────────────────────────

export const MePayload = z.object({
  id: z.string(),
  balance: z.object({
    amount_cents: z.number().int(),
    currency: z.literal("USD"),
    formatted: z.string(),
  }),
  rate_limits: z.record(
    z.string(),
    z.object({ limit: z.number(), window_seconds: z.number() }),
  ),
  created_at: z.string(),
});
export type MePayload = z.infer<typeof MePayload>;

// ── /v1/services ────────────────────────────────────────────────────────────

export const SmsService = z.object({
  id: z.string(),
  name: z.string(),
  icon_hash: z.string().nullable().optional(),
  quoted_price_cents: z.number().int(),
  ltr_prices_cents: z
    .object({
      "3d": z.number().int().optional(),
      "7d": z.number().int().optional(),
      "14d": z.number().int().optional(),
      "30d": z.number().int().optional(),
    })
    .optional(),
  dedicated_price_cents: z.number().int().optional(),
});
export type SmsService = z.infer<typeof SmsService>;

export const ServicesResponse = z.object({
  services: z.array(SmsService),
  next_cursor: z.string().nullable().optional(),
});

// ── Verifications ────────────────────────────────────────────────────────────

export const Message = z.object({
  id: z.string(),
  text: z.string(),
  code: z.string().nullable().optional(),
  received_at: z.string(),
});

export const Verification = z.object({
  id: z.string(),
  status: z.enum(["waiting_for_code", "code_received", "completed", "cancelled", "expired"]),
  phone_number: z.string(),
  service_id: z.string(),
  service_name: z.string(),
  charged_price_cents: z.number().int(),
  expires_at: z.string(),
  can_cancel: z.boolean(),
  created_at: z.string(),
  reuse_counter: z.number().int(),
  allow_reuse: z.boolean(),
  allow_paid_reuse: z.boolean(),
  paid_reuse_price_cents: z.number().int(),
  messages: z.array(Message).optional(),
});
export type Verification = z.infer<typeof Verification>;

// ── Rentals (LTR + dedicated) ───────────────────────────────────────────────

export const Rental = z.object({
  id: z.string(),
  kind: z.enum(["rental", "dedicated"]),
  status: z.enum(["active", "expired", "cancelled"]),
  phone_number: z.string(),
  service_id: z.string(),
  service_name: z.string(),
  duration: z.string().nullable(),
  charged_price_cents: z.number().int(),
  auto_renew: z.boolean(),
  paid_until: z.string().nullable(),
  expires_at: z.string(),
  created_at: z.string(),
  messages: z.array(Message).optional(),
});
export type Rental = z.infer<typeof Rental>;

// ── eSIM products + orders ──────────────────────────────────────────────────

export const EsimProduct = z.object({
  id: z.string(),
  title: z.string(),
  countries: z.array(z.string()),
  data_gb: z.number().nullable(),
  data_unlimited: z.boolean(),
  validity_days: z.number().int(),
  retail_price_cents: z.number().int(),
  has_5g: z.boolean(),
  has_hotspot: z.boolean(),
  supports_topup: z.boolean(),
  network_type: z.string().optional(),
  speed: z.string().optional(),
  activation_policy: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type EsimProduct = z.infer<typeof EsimProduct>;

export const Esim = z.object({
  id: z.string(),
  status: z.enum(["pending", "processing", "completed", "cancelled", "refunded", "expired"]),
  plan_title: z.string(),
  countries: z.array(z.string()),
  data_gb_total: z.number().nullable(),
  data_unlimited: z.boolean(),
  validity_days: z.number().int(),
  charged_price_cents: z.number().int(),
  activation_code: z.string(),
  iccid: z.string(),
  is_topup: z.boolean(),
  parent_order_id: z.string().nullable(),
  supports_topup: z.boolean(),
  expires_at: z.string(),
  created_at: z.string(),
});
export type Esim = z.infer<typeof Esim>;

export const EsimUsage = z.object({
  data_used_mb: z.number(),
  data_total_mb: z.number().nullable(),
  expires_at: z.string(),
});

// ── Proxies ──────────────────────────────────────────────────────────────────

export const ProxyGateway = z.object({
  host: z.string(),
  port: z.number().int(),
  protocol: z.enum(["http", "socks5"]),
  username: z.string(),
  password: z.string(),
  username_geo_hint: z.string().optional(),
});

export const ProxyList = z.object({
  id: z.string(),
  name: z.string(),
  login: z.string(),
  password: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  isp: z.string().nullable(),
  location_preset: z.string(),
  countries: z.array(z.string()).nullable(),
  rotation_period: z.number().int(),
});

export const Proxy = z.object({
  id: z.string(),
  status: z.enum(["active", "provisioning", "expired", "refunded"]),
  plan_id: z.string().nullable(),
  type: z.enum(["shared", "dedicated_standard", "dedicated_premium"]).optional(),
  country: z.string().optional(),
  data_gb_total: z.number().int(),
  data_bytes_used: z.number().int(),
  charged_price_cents: z.number().int(),
  expires_at: z.string(),
  gateway: ProxyGateway.nullable(),
  lists: z.array(ProxyList).default([]),
  created_at: z.string().optional(),
});
export type Proxy = z.infer<typeof Proxy>;

export const ProxyPlan = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["shared", "dedicated_standard", "dedicated_premium"]),
  country: z.string(),
  data_gb: z.number().nullable(),
  duration_days: z.number().int(),
  quoted_price_cents: z.number().int(),
});
export type ProxyPlan = z.infer<typeof ProxyPlan>;

// ── Geo ─────────────────────────────────────────────────────────────────────

export const GeoCountry = z.object({
  code: z.string(),
  name: z.string(),
  available_nodes: z.number().int(),
});

export const GeoRegion = z.object({ code: z.string(), name: z.string(), available_nodes: z.number().int() });
export const GeoCity = GeoRegion;
export const GeoIsp = z.object({ name: z.string(), available_nodes: z.number().int() });

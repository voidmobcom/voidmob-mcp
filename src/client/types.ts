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
  icon_url: z.string().nullable().optional(),
  quoted_price_cents: z.number().int(),
  base_price_cents: z.number().int().optional(),
  price_ceiling_cents: z.number().int().optional(),
  available: z.boolean().optional(),
  // Long-term rental tiers are flat fields. `0` means the tier is not offered.
  ltr_3d_price_cents: z.number().int().optional(),
  ltr_7d_price_cents: z.number().int().optional(),
  ltr_14d_price_cents: z.number().int().optional(),
  ltr_30d_price_cents: z.number().int().optional(),
  // Only present on the svc_dedicated_28d row (the 28-day dedicated number tier).
  ltr_28d_price_cents: z.number().int().optional(),
});
export type SmsService = z.infer<typeof SmsService>;

export const ServicesResponse = z.object({
  country: z.string().optional(),
  services: z.array(SmsService),
  fetched_at: z.string().optional(),
});

// ── Verifications ────────────────────────────────────────────────────────────

export const Verification = z.object({
  id: z.string(),
  display_id: z.string().nullable().optional(),
  status: z.enum(["waiting_for_code", "code_received", "cancelled", "expired", "failed"]),
  phone_number: z.string(),
  service_id: z.string().nullable(),
  service_name: z.string(),
  charged_price_cents: z.number().int(),
  expires_at: z.string(),
  can_cancel: z.boolean(),
  created_at: z.string(),
  // The received SMS code (present only when status = code_received).
  code: z.string().optional(),
  code_received_at: z.string().optional(),
  reuse_counter: z.number().int(),
  allow_reuse: z.boolean(),
  allow_paid_reuse: z.boolean(),
  paid_reuse_price_cents: z.number().int(),
  charged_reuse_cents: z.number().int().optional(),
  refunded_cents: z.number().int().optional(),
});
export type Verification = z.infer<typeof Verification>;

// Terminal-action responses (cancel) return a slim verification object, not
// the full resource: { id, status, refunded_cents }.
export const VerificationCancelResult = z.object({
  id: z.string(),
  status: z.string(),
  refunded_cents: z.number().int().optional(),
});
export type VerificationCancelResult = z.infer<typeof VerificationCancelResult>;

// ── Rentals (long-term + 28-day dedicated) ──────────────────────────────────

export const RentalMessage = z.object({
  id: z.string(),
  code: z.string().nullable().optional(),
  text: z.string(),
  received_at: z.string(),
});

export const Rental = z.object({
  id: z.string(),
  display_id: z.string().nullable().optional(),
  status: z.enum(["active", "expired", "cancelled"]),
  phone_number: z.string(),
  service_id: z.string().nullable(),
  service_name: z.string(),
  country: z.string(),
  duration: z.string(),
  rental_type: z.literal("rental"),
  charged_price_cents: z.number().int(),
  auto_renew: z.boolean(),
  next_renewal_price_cents: z.number().int(),
  re_rent_available: z.boolean(),
  re_rent_price_cents: z.number().int().nullable(),
  re_rent_blocked_at: z.string().nullable(),
  created_at: z.string(),
  paid_until: z.string(),
  expires_at: z.string(),
  can_cancel: z.boolean(),
  cancel_window_expires_at: z.string().nullable().optional(),
  messages: z.array(RentalMessage).optional(),
});
export type Rental = z.infer<typeof Rental>;

// ── Dedicated numbers (/v1/dedicated/*) ─────────────────────────────────────

export const DedicatedCountry = z.object({
  country: z.string(),
  name: z.string(),
  quoted_price_cents: z.number().int(),
  base_price_cents: z.number().int(),
  in_stock: z.boolean(),
});
export type DedicatedCountry = z.infer<typeof DedicatedCountry>;

export const DedicatedNumber = z.object({
  id: z.string(),
  display_id: z.string().nullable().optional(),
  status: z.enum(["active", "expired"]),
  phone_number: z.string(),
  country: z.string(),
  country_name: z.string(),
  billing_period: z.string(),
  nickname: z.string().nullable().optional(),
  quoted_price_cents: z.number().int(),
  charged_price_cents: z.number().int(),
  next_renewal_price_cents: z.number().int(),
  auto_renew: z.boolean(),
  created_at: z.string(),
  paid_until: z.string(),
  expires_at: z.string(),
  // Empty on list/purchase/auto-renew responses; populated on the detail GET.
  messages: z.array(RentalMessage).optional(),
});
export type DedicatedNumber = z.infer<typeof DedicatedNumber>;

// ── eSIM products + orders ──────────────────────────────────────────────────

export const EsimProductFeatures = z.object({
  has_5g: z.boolean(),
  has_hotspot: z.boolean(),
  has_calls: z.boolean(),
  has_sms: z.boolean(),
  supports_topup: z.boolean(),
});

export const EsimProduct = z.object({
  id: z.string(),
  title: z.string(),
  countries: z.array(z.string()),
  region: z.string().nullable(),
  country_count: z.number().int(),
  routing_location: z.string().nullable(),
  data_limit_gb: z.number().nullable(),
  data_unlimited: z.boolean(),
  validity_days: z.number().int(),
  features: EsimProductFeatures,
  price_cents: z.number().int(),
  currency: z.literal("USD"),
});
export type EsimProduct = z.infer<typeof EsimProduct>;

export const Esim = z.object({
  id: z.string(),
  status: z.enum(["processing", "completed", "cancelled", "refunded", "expired"]),
  product_id: z.string().nullable(),
  is_topup: z.boolean(),
  parent_order_id: z.string().nullable(),
  iccid: z.string().nullable(),
  activation_code: z.string().nullable(),
  qr_code_url: z.string().nullable(),
  smdp_address: z.string().nullable(),
  data_limit_gb: z.number().nullable(),
  data_unlimited: z.boolean(),
  validity_days: z.number().int(),
  countries: z.array(z.string()),
  routing_location: z.string().nullable(),
  charged_price_cents: z.number().int(),
  currency: z.literal("USD"),
  created_at: z.string(),
  completed_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});
export type Esim = z.infer<typeof Esim>;

export const EsimUsagePackage = z.object({
  name: z.string(),
  total_mb: z.number(),
  total_gb: z.number(),
  used_mb: z.number(),
  used_gb: z.number(),
  remaining_mb: z.number(),
  remaining_gb: z.number(),
  percent_used: z.number(),
  activation_date: z.string().nullable(),
  expiration_date: z.string().nullable(),
});

export const EsimUsage = z.object({
  esim_id: z.string(),
  esim_status: z.string(),
  packages: z.array(EsimUsagePackage),
});
export type EsimUsage = z.infer<typeof EsimUsage>;

// ── Proxies ──────────────────────────────────────────────────────────────────

export const ProxyGateway = z.object({
  host: z.string(),
  port: z.number().int(),
  protocol: z.enum(["http", "socks5"]),
  username: z.string(),
  password: z.string(),
  username_geo_hint: z.string().optional(),
});

export const ProxyCredentials = z.object({
  host: z.string(),
  port: z.number().int(),
  protocol: z.string(),
  username: z.string(),
  password: z.string(),
});

export const ProxyList = z.object({
  id: z.string(),
  proxy_id: z.string(),
  name: z.string(),
  country: z.string().nullable().optional(),
  countries: z.array(z.string()).nullable().optional(),
  region: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  isp: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  rotation_period_seconds: z.number().int(),
  rotation_mode: z.string(),
  format: z.string(),
  credentials: ProxyCredentials.nullable(),
  entries: z.array(z.string()),
  activation_note: z.string(),
  created_at: z.string(),
});
export type ProxyList = z.infer<typeof ProxyList>;

export const Proxy = z.object({
  id: z.string(),
  status: z.enum(["provisioning", "active", "expired", "refunded", "exhausted"]),
  plan_id: z.string().nullable().optional(),
  data_gb_total: z.number().int(),
  data_bytes_used: z.number().int(),
  charged_price_cents: z.number().int(),
  expires_at: z.string(),
  gateway: ProxyGateway.nullable(),
  lists: z.array(ProxyList).default([]),
  rotation_url: z.string().nullable().optional(),
  created_at: z.string().optional(),
});
export type Proxy = z.infer<typeof Proxy>;

export const ProxyPlan = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["shared"]),
  country: z.string().nullable(),
  country_name: z.string().nullable().optional(),
  data_gb: z.number().int(),
  duration_days: z.number().int(),
  period: z.enum(["daily", "weekly", "monthly"]).optional(),
  quoted_price_cents: z.number().int(),
  available: z.boolean().optional(),
});
export type ProxyPlan = z.infer<typeof ProxyPlan>;

// ── Geo ─────────────────────────────────────────────────────────────────────

export const GeoCountry = z.object({
  code: z.string(),
  name: z.string(),
  available_nodes: z.number().int(),
});

// Regions, cities, and ISPs are all GeoNode shape: { name, available_nodes }.
// No `code` field (countries are the only geo level that carry a code).
export const GeoRegion = z.object({ name: z.string(), available_nodes: z.number().int() });
export const GeoCity = GeoRegion;
export const GeoIsp = GeoRegion;

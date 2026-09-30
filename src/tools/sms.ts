import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { path } from "../client/path.js";
import {
  Verification,
  VerificationCancelResult,
  Rental,
  ServicesResponse,
  DedicatedNumber,
  type Verification as VerificationT,
  type Rental as RentalT,
} from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, renderMessages, type ToolResult } from "../utils/render.js";
import { formatUsd, formatTimeRemaining } from "../utils/format.js";
import { READ_ONLY, SPENDS } from "../utils/annotations.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import {
  VER_PREFIX,
  REN_PREFIX,
  DED_PREFIX,
  isVerificationId,
  isRentalId,
  isDedicatedId,
  INVALID_RENTAL_ID,
} from "../constants/rental-id.js";
import {
  VerificationOrRentalId,
  VerificationId,
  RentalId,
  RentalOrDedicatedId,
  ServiceId,
} from "../constants/ids.js";

// Rows printed by search_sms_services; structuredContent carries the same rows.
const MAX_SERVICE_ROWS = 50;

// ── search_sms_services ─────────────────────────────────────────────────────

export const searchSmsServicesHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { query?: string }): Promise<ToolResult> => {
    const query = args.query?.trim();
    const raw = await callApi<unknown>(http, "GET", query ? `/v1/services?${new URLSearchParams({ q: query })}` : "/v1/services");
    const parsed = ServicesResponse.parse(raw);
    let services = parsed.services;
    if (query) {
      const q = query.toLowerCase();
      services = services.filter((s) => s.name.toLowerCase().includes(q));
    }
    if (services.length === 0) {
      return structuredOk(
        query
          ? `No SMS services match '${query}'. Try a shorter or different name, or omit query to list all services.`
          : "No SMS services are listed right now.",
        { services: [], total: 0, truncated: false },
      );
    }
    const shown = services.slice(0, MAX_SERVICE_ROWS);
    const truncated = services.length > shown.length;
    const text = [
      truncated
        ? `Showing ${shown.length} of ${services.length} SMS services - pass query (e.g. query='telegram') to narrow the list:`
        : `${services.length} SMS service(s):`,
      ``,
      ...shown.map((s) =>
        `  ${s.name.padEnd(20)} ${s.id.padEnd(14)} verify=${formatUsd(s.quoted_price_cents)}${
          s.ltr_7d_price_cents ? `  7d=${formatUsd(s.ltr_7d_price_cents)}` : ""
        }${s.available === false ? "  (out of stock)" : ""}`,
      ),
    ].join("\n");
    return structuredOk(text, { services: shown, total: services.length, truncated });
  });

// ── get_rental ──────────────────────────────────────────────────────────────

export const getRentalHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (isVerificationId(id)) {
      const raw = await callApi<{ verification: unknown }>(http, "GET", path`/v1/verifications/${id}`);
      const v = Verification.parse(raw.verification);
      return structuredOk(renderVerification(v), { verification: v });
    }
    if (isRentalId(id)) {
      const raw = await callApi<unknown>(http, "GET", path`/v1/rentals/${id}`);
      const r = Rental.parse(raw);
      return structuredOk(renderRental(r), { rental: r });
    }
    return toolError(INVALID_RENTAL_ID(id));
  });

// ── rent_number ─────────────────────────────────────────────────────────────

export const rentNumberHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { service_id: string; kind?: "verification" | "rental"; duration?: "3d" | "7d" | "14d" | "30d" }): Promise<ToolResult> => {
    const kind = args.kind ?? "verification";
    if (kind === "rental" && !args.duration) {
      return toolError("rent_number kind='rental' requires a duration (3d|7d|14d|30d).");
    }
    // Quote against the live catalog.
    const services = await callApi<unknown>(http, "GET", "/v1/services");
    const parsed = ServicesResponse.parse(services);

    if (kind === "verification") {
      const svc = parsed.services.find((s) => s.id === args.service_id);
      if (!svc) {
        return toolError(`Service '${args.service_id}' not found. Use search_sms_services to list available services.`);
      }
      const created = await callApi<{ verification: unknown }>(http, "POST", "/v1/verifications", {
        body: { service_id: args.service_id, max_price_cents: svc.quoted_price_cents },
        idempotencyKey: newIdempotencyKey(),
      });
      const v = Verification.parse(created.verification);
      return structuredOk(`Verification ${v.id} created.\n\n${renderVerification(v)}`, { verification: v });
    }

    // Long-term rentals POST /v1/rentals with an uppercase duration.
    const svc = parsed.services.find((s) => s.id === args.service_id);
    if (!svc) {
      return toolError(`Service '${args.service_id}' not found. Use search_sms_services to list available services.`);
    }
    const tier = args.duration as "3d" | "7d" | "14d" | "30d";
    const priceByTier: Record<typeof tier, number | undefined> = {
      "3d": svc.ltr_3d_price_cents,
      "7d": svc.ltr_7d_price_cents,
      "14d": svc.ltr_14d_price_cents,
      "30d": svc.ltr_30d_price_cents,
    };
    const quotedCents = priceByTier[tier];
    if (!quotedCents) {
      return toolError(`Long-term rental ${args.duration} is not offered for ${svc.name}. Try a different duration.`);
    }
    const duration = tier.toUpperCase() as "3D" | "7D" | "14D" | "30D";
    // /v1/rentals returns the rental object flat (no { rental: ... } wrapper)
    const created = await callApi<unknown>(http, "POST", "/v1/rentals", {
      body: { service_id: args.service_id, duration, max_price_cents: quotedCents },
      idempotencyKey: newIdempotencyKey(),
    });
    const r = Rental.parse(created);
    return structuredOk(`Rental ${r.id} created.\n\n${renderRental(r)}`, { rental: r });
  });

// ── cancel_rental ───────────────────────────────────────────────────────────

export const cancelRentalHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (isVerificationId(id)) {
      const out = await callApi<{ verification: unknown }>(http, "POST", path`/v1/verifications/${id}/cancel`, {
        idempotencyKey: newIdempotencyKey(),
      });
      const v = VerificationCancelResult.parse(out.verification);
      const refund = v.refunded_cents && v.refunded_cents > 0 ? ` Refunded ${formatUsd(v.refunded_cents)}.` : "";
      return structuredOk(`Verification ${v.id} cancelled.${refund}`, { verification: v });
    }
    if (isRentalId(id)) {
      const out = await callApi<unknown>(http, "DELETE", path`/v1/rentals/${id}`, {
        idempotencyKey: newIdempotencyKey(),
      });
      const r = Rental.parse(out);
      // A cancel inside the 60-minute window refunds the rental price in full.
      const refunded = r.refunded_cents ?? r.charged_price_cents;
      const refund = refunded > 0 ? ` Refunded ${formatUsd(refunded)}.` : "";
      return structuredOk(`Rental ${r.id} cancelled.${refund}`, { rental: r });
    }
    return toolError(INVALID_RENTAL_ID(id));
  });

// ── reuse_number ────────────────────────────────────────────────────────────

export const reuseNumberHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string; paid?: boolean }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (!isVerificationId(id)) {
      return toolError(`reuse_number requires a verification id (${VER_PREFIX}xxx). Got '${id}'.`);
    }
    let out: { verification: unknown };
    if (args.paid) {
      // Paid reuse must acknowledge the exact charge; read it from the resource.
      const current = await callApi<{ verification: unknown }>(http, "GET", path`/v1/verifications/${id}`);
      const price = Verification.parse(current.verification).paid_reuse_price_cents;
      out = await callApi<{ verification: unknown }>(http, "POST", path`/v1/verifications/${id}/reuse/paid`, {
        body: { accept_charge_cents: price },
        idempotencyKey: newIdempotencyKey(),
      });
    } else {
      out = await callApi<{ verification: unknown }>(http, "POST", path`/v1/verifications/${id}/reuse`, {
        idempotencyKey: newIdempotencyKey(),
      });
    }
    const v = Verification.parse(out.verification);
    return structuredOk(renderVerification(v), { verification: v });
  });

// ── re_rent_rental ──────────────────────────────────────────────────────────

export const reRentRentalHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (!isRentalId(id)) {
      return toolError(`re_rent_rental requires ${REN_PREFIX}xxx. Got '${id}'.`);
    }
    // No request body: re-rents the same number for the same duration at the
    // current price. Only valid when re_rent_available is true on the rental.
    const out = await callApi<unknown>(http, "POST", path`/v1/rentals/${id}/re_rent`, {
      idempotencyKey: newIdempotencyKey(),
    });
    const r = Rental.parse(out);
    return structuredOk(`Re-rented ${r.id}.\n\n${renderRental(r)}`, { rental: r });
  });

// ── toggle_auto_renew ───────────────────────────────────────────────────────

export const toggleAutoRenewHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string; auto_renew: boolean }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (isDedicatedId(id)) {
      const out = await callApi<unknown>(http, "POST", path`/v1/dedicated/numbers/${id}/auto_renew`, {
        body: { enabled: args.auto_renew },
        idempotencyKey: newIdempotencyKey(),
      });
      const d = DedicatedNumber.parse(out);
      return structuredOk(`Auto-renew on ${d.id} is now ${d.auto_renew ? "on" : "off"}.`, { dedicated_number: d });
    }
    if (!isRentalId(id)) {
      return toolError(`toggle_auto_renew requires ${REN_PREFIX}xxx or ${DED_PREFIX}xxx. Got '${id}'.`);
    }
    // Rentals take { enabled } too - an explicit state, safe to repeat.
    const out = await callApi<unknown>(http, "POST", path`/v1/rentals/${id}/auto_renew`, {
      body: { enabled: args.auto_renew },
      idempotencyKey: newIdempotencyKey(),
    });
    const r = Rental.parse(out);
    return structuredOk(`Auto-renew on ${r.id} is now ${r.auto_renew ? "on" : "off"}.`, { rental: r });
  });

// ── render helpers ──────────────────────────────────────────────────────────

export function renderVerification(v: VerificationT): string {
  const expiresMs = new Date(v.expires_at).getTime();
  const open = expiresMs > Date.now();
  const lines = [
    `Verification ${v.id}`,
    ``,
    `  Phone:        ${v.phone_number}`,
    `  Service:      ${v.service_name} (${v.service_id})`,
    `  Status:       ${v.status}`,
    `  Charged:      ${formatUsd(v.charged_price_cents)}`,
    `  Expires:      ${formatTimeRemaining(expiresMs)}`,
  ];
  if (v.code) {
    lines.push(``, `  Latest code:  ${v.code}`);
    if (v.code_received_at) lines.push(`  At:           ${v.code_received_at}`);
  }
  if (v.status === "waiting_for_code") {
    lines.push(
      ``,
      open
        ? `  No ${v.code ? "new " : ""}SMS yet. The number stays open until expires_at (${formatTimeRemaining(expiresMs)} left); poll get_rental every 10-30s. ` +
          `If no SMS arrives by then, the price is refunded automatically and the status becomes cancelled - no need to cancel.`
        : `  The window has closed without an SMS; the automatic refund is being applied (status becomes cancelled).`,
    );
  } else if (v.status === "code_received" && open) {
    lines.push(``, `  More codes can arrive on this number until it expires; get_rental always shows the latest.`);
  } else if (v.status === "cancelled") {
    lines.push(``, `  Cancelled - the price was refunded to your balance (it was cancelled, or no SMS arrived in time).`);
  } else if (v.status === "expired") {
    lines.push(
      ``,
      `  Expired without an SMS and without an automatic refund (this happens only for services marked non-refundable, ` +
        `or when the refund could not be applied). Contact support if you believe a refund is due.`,
    );
  }
  return lines.join("\n");
}

export function renderRental(r: RentalT): string {
  const label = r.duration === "28D" ? "dedicated" : "rental";
  const lines = [
    `Rental ${r.id} (${label})`,
    ``,
    `  Phone:        ${r.phone_number}`,
    `  Service:      ${r.service_name} (${r.service_id})`,
    `  Status:       ${r.status}`,
    `  Charged:      ${formatUsd(r.charged_price_cents)}`,
    `  Duration:     ${r.duration ?? "-"}`,
    `  Auto-renew:   ${r.auto_renew ? "on" : "off"}`,
    `  Paid until:   ${r.paid_until ?? "-"}`,
    `  Expires:      ${formatTimeRemaining(new Date(r.expires_at).getTime())}`,
  ];
  if (r.can_cancel) {
    lines.push(
      `  Cancel:       cancel_rental refunds it in full until ${r.cancel_window_expires_at ?? "60 minutes after purchase"}`,
    );
  }
  if (r.messages && r.messages.length > 0) {
    lines.push(...renderMessages(r.messages));
  }
  return lines.join("\n");
}

// ── registration ────────────────────────────────────────────────────────────

export function registerSmsTools(server: McpServer, http: HttpClient) {
  server.registerTool(
    "search_sms_services",
    {
      title: "Search SMS services",
      description:
        "Search US non-VoIP SMS services (OTP / phone verification) with your prices: the one-time verification price and, when offered, long-term rental prices. " +
        "Shows up to 50 rows; pass query to narrow by service name. Next: rent_number with the svc_ id.",
      inputSchema: { query: z.string().max(80).optional().describe("Case-insensitive substring of the service name (e.g. 'telegram').") },
      annotations: READ_ONLY,
    },
    searchSmsServicesHandler(http),
  );

  server.registerTool(
    "get_rental",
    {
      title: "Check SMS verification or rental",
      description:
        "Read an SMS verification (ver_...) or long-term rental (ren_...): status, time left, the latest code and received messages. " +
        "After rent_number, poll every 10-30s until a code arrives. A verification stays open for up to 15 minutes (expires_at) and can receive several codes; the latest is shown. " +
        "If no SMS arrives in the window, the price is refunded automatically and the status becomes cancelled - no need to cancel. " +
        "For dedicated numbers (ded_...) use get_dedicated_number.",
      inputSchema: { rental_id: VerificationOrRentalId.describe("ver_... or ren_... id from rent_number or list_orders") },
      annotations: READ_ONLY,
    },
    getRentalHandler(http),
  );

  server.registerTool(
    "rent_number",
    {
      title: "Rent an SMS number",
      description:
        "Buy a US non-VoIP phone number for one service, charged to your balance immediately. " +
        "kind='verification' (default): a one-time number that stays open for up to 15 minutes (expires_at) and can receive several codes in that window. " +
        "You pay only when an SMS arrives: if none arrives, the full price is refunded automatically and the verification ends as cancelled " +
        "(rare exception: services marked non-refundable end as expired without a refund). " +
        "kind='rental': the number is yours for 3/7/14/30 days and receives every SMS for that service; cancel_rental refunds it in full within 60 minutes of purchase. " +
        "It charges the live price at that moment (re-read just before buying, so it can differ from an earlier search); show the user the price from search_sms_services first. " +
        "For a private number that receives SMS from any service, use purchase_dedicated_number. Next: poll get_rental with the returned id.",
      inputSchema: {
        service_id: ServiceId.describe("svc_... id from search_sms_services"),
        kind: z.enum(["verification", "rental"]).default("verification"),
        duration: z.enum(["3d", "7d", "14d", "30d"]).optional().describe("Required when kind='rental'"),
      },
      annotations: SPENDS,
    },
    rentNumberHandler(http),
  );

  server.registerTool(
    "cancel_rental",
    {
      title: "Cancel SMS verification or rental",
      description:
        "Cancel an SMS order and refund it in full. Verification (ver_...): only before any SMS arrives. Usually unnecessary - " +
        "a verification that gets no SMS is refunded automatically when its window closes, and frequent cancellations can temporarily pause SMS purchasing. " +
        "Long-term rental (ren_...): only within 60 minutes of purchase; after that it runs to its end date. The result shows the amount refunded.",
      inputSchema: { rental_id: VerificationOrRentalId.describe("ver_... or ren_... id to cancel") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    cancelRentalHandler(http),
  );

  server.registerTool(
    "reuse_number",
    {
      title: "Reuse a verification number",
      description:
        "Receive another SMS on the number of an earlier verification (ver_...). Free reuse: when allow_reuse is true. " +
        "Paid reuse (paid=true): when allow_paid_reuse is true; charges paid_reuse_price_cents (currently $0.50), refunded automatically if the number is no longer available. " +
        "Check both flags with get_rental first, then poll get_rental for the new code.",
      inputSchema: {
        rental_id: VerificationId.describe("ver_... id of an earlier verification"),
        paid: z.boolean().default(false),
      },
      annotations: SPENDS,
    },
    reuseNumberHandler(http),
  );

  server.registerTool(
    "re_rent_rental",
    {
      title: "Re-rent an expired rental",
      description:
        "Re-rent the same number for another period of its original duration, charged at re_rent_price_cents. Only works on an expired rental whose " +
        "re_rent_available is true (the number has not been released yet). No duration argument.",
      inputSchema: {
        rental_id: RentalId.describe("ren_... id of an expired rental with re_rent_available=true"),
      },
      annotations: SPENDS,
    },
    reRentRentalHandler(http),
  );

  server.registerTool(
    "toggle_auto_renew",
    {
      title: "Set rental or dedicated number auto-renew",
      description:
        "Turn auto-renewal on or off for a long-term rental (ren_...) or a dedicated number (ded_...). When on, each new period is charged to your balance " +
        "at next_renewal_price_cents; if that charge fails, auto-renew switches off and the number expires at the end of its period.",
      inputSchema: {
        rental_id: RentalOrDedicatedId.describe("ren_... or ded_..."),
        auto_renew: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    toggleAutoRenewHandler(http),
  );
}

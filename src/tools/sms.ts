import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import {
  Verification,
  Rental,
  ServicesResponse,
  type Verification as VerificationT,
  type Rental as RentalT,
} from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd, formatTimeRemaining } from "../utils/format.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import {
  VER_PREFIX,
  REN_PREFIX,
  isVerificationId,
  isRentalId,
  INVALID_RENTAL_ID,
} from "../constants/rental-id.js";

// The catalog service id for the 28-day dedicated number tier.
const DEDICATED_SERVICE_ID = "svc_dedicated_28d";

// ── search_sms_services ─────────────────────────────────────────────────────

export const searchSmsServicesHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { query?: string }): Promise<ToolResult> => {
    const raw = await callApi<unknown>(http, "GET", "/v1/services");
    const parsed = ServicesResponse.parse(raw);
    let services = parsed.services;
    if (args.query) {
      const q = args.query.toLowerCase();
      services = services.filter((s) => s.name.toLowerCase().includes(q));
    }
    if (services.length === 0) return toolError("No services matched.");
    const text = [
      `${services.length} SMS service(s):`,
      ``,
      ...services.slice(0, 50).map((s) =>
        `  ${s.name.padEnd(20)} ${s.id.padEnd(14)} verify=${formatUsd(s.quoted_price_cents)}${
          s.ltr_7d_price_cents ? `  7d=${formatUsd(s.ltr_7d_price_cents)}` : ""
        }`,
      ),
    ].join("\n");
    return structuredOk(text, { services });
  });

// ── get_rental ──────────────────────────────────────────────────────────────

export const getRentalHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (isVerificationId(id)) {
      const raw = await callApi<{ verification: unknown }>(http, "GET", `/v1/verifications/${id}`);
      const v = Verification.parse(raw.verification);
      return structuredOk(renderVerification(v), { verification: v });
    }
    if (isRentalId(id)) {
      const raw = await callApi<unknown>(http, "GET", `/v1/rentals/${id}`);
      const r = Rental.parse(raw);
      return structuredOk(renderRental(r), { rental: r });
    }
    return toolError(INVALID_RENTAL_ID(id));
  });

// ── rent_number ─────────────────────────────────────────────────────────────

export const rentNumberHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { service_id: string; kind?: "verification" | "rental" | "dedicated"; duration?: "3d" | "7d" | "14d" | "30d" }): Promise<ToolResult> => {
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

    // Long-term + dedicated both POST /v1/rentals with an uppercase duration.
    // Dedicated is the dedicated 28-day catalog service (svc_dedicated_28d, 28D).
    let serviceId: string;
    let duration: "3D" | "7D" | "14D" | "30D" | "28D";
    let quotedCents: number;
    if (kind === "dedicated") {
      serviceId = DEDICATED_SERVICE_ID;
      duration = "28D";
      const ded = parsed.services.find((s) => s.id === DEDICATED_SERVICE_ID);
      if (!ded || !ded.ltr_28d_price_cents) {
        return toolError("Dedicated 28-day numbers are not currently available.");
      }
      quotedCents = ded.ltr_28d_price_cents;
    } else {
      serviceId = args.service_id;
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
      const v = priceByTier[tier];
      if (!v) {
        return toolError(`Long-term rental ${args.duration} is not offered for ${svc.name}. Try a different duration or kind='dedicated'.`);
      }
      quotedCents = v;
      duration = tier.toUpperCase() as "3D" | "7D" | "14D" | "30D";
    }
    // /v1/rentals returns the rental object flat (no { rental: ... } wrapper)
    const created = await callApi<unknown>(http, "POST", "/v1/rentals", {
      body: { service_id: serviceId, duration, max_price_cents: quotedCents },
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
      const out = await callApi<{ verification: unknown }>(http, "POST", `/v1/verifications/${id}/cancel`, {
        idempotencyKey: newIdempotencyKey(),
      });
      const v = Verification.parse(out.verification);
      return structuredOk(`Verification ${v.id} cancelled.`, { verification: v });
    }
    if (isRentalId(id)) {
      const out = await callApi<unknown>(http, "DELETE", `/v1/rentals/${id}`, {
        idempotencyKey: newIdempotencyKey(),
      });
      const r = Rental.parse(out);
      return structuredOk(`Rental ${r.id} cancelled.`, { rental: r });
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
    const path = args.paid ? `/v1/verifications/${id}/reuse/paid` : `/v1/verifications/${id}/reuse`;
    const out = await callApi<{ verification: unknown }>(http, "POST", path, {
      idempotencyKey: newIdempotencyKey(),
    });
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
    const out = await callApi<unknown>(http, "POST", `/v1/rentals/${id}/re_rent`, {
      idempotencyKey: newIdempotencyKey(),
    });
    const r = Rental.parse(out);
    return structuredOk(`Re-rented ${r.id}.\n\n${renderRental(r)}`, { rental: r });
  });

// ── toggle_auto_renew ───────────────────────────────────────────────────────

export const toggleAutoRenewHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { rental_id: string; auto_renew: boolean }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (!isRentalId(id)) {
      return toolError(`toggle_auto_renew requires ${REN_PREFIX}xxx. Got '${id}'.`);
    }
    const out = await callApi<unknown>(http, "POST", `/v1/rentals/${id}/auto_renew`, {
      body: { auto_renew: args.auto_renew },
      idempotencyKey: newIdempotencyKey(),
    });
    const r = Rental.parse(out);
    return structuredOk(`Auto-renew on ${r.id} is now ${r.auto_renew ? "on" : "off"}.`, { rental: r });
  });

// ── render helpers ──────────────────────────────────────────────────────────

export function renderVerification(v: VerificationT): string {
  const lines = [
    `Verification ${v.id}`,
    ``,
    `  Phone:        ${v.phone_number}`,
    `  Service:      ${v.service_name} (${v.service_id})`,
    `  Status:       ${v.status}`,
    `  Charged:      ${formatUsd(v.charged_price_cents)}`,
    `  Expires:      ${formatTimeRemaining(new Date(v.expires_at).getTime())}`,
  ];
  if (v.status === "code_received" && v.code) {
    lines.push(``, `  Code received: ${v.code}`);
    if (v.code_received_at) lines.push(`  At:           ${v.code_received_at}`);
  } else if (v.status === "waiting_for_code") {
    lines.push(``, `  No code yet. Try get_rental again in 10-30s.`);
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
  if (r.messages && r.messages.length > 0) {
    lines.push(``, `  Messages (${r.messages.length}):`);
    for (const m of r.messages) {
      lines.push(`    [${m.received_at.slice(11, 19)}] ${m.text}`);
      if (m.code) lines.push(`      Code: ${m.code}`);
    }
  }
  return lines.join("\n");
}

// ── registration ────────────────────────────────────────────────────────────

export function registerSmsTools(server: McpServer, http: HttpClient) {
  server.tool(
    "search_sms_services",
    "Search available US non-VoIP SMS services with prices per row. Returns each service's verification price plus LTR/dedicated tiers when offered.",
    { query: z.string().optional().describe("Substring filter on service name (e.g. 'telegram').") },
    searchSmsServicesHandler(http),
  );

  server.tool(
    "get_rental",
    "Read a rental's current status and any messages received. Pass the ID you got from rent_number (ver_xxx for verifications, ren_xxx for long-term/dedicated). SMS codes typically arrive 10-60s after rent_number; poll this tool until status changes.",
    { rental_id: z.string().describe("ver_xxx or ren_xxx") },
    getRentalHandler(http),
  );

  server.tool(
    "rent_number",
    "Rent a US non-VoIP phone number. kind='verification' (single SMS, 20min); kind='rental' (timed LTR with duration); kind='dedicated' (28-day all-services number). Quote-then-commit: the tool fetches the live price and ties max_price_cents to the quote so you never pay above what you saw.",
    {
      service_id: z.string().describe("svc_xxx from search_sms_services"),
      kind: z.enum(["verification", "rental", "dedicated"]).default("verification"),
      duration: z.enum(["3d", "7d", "14d", "30d"]).optional().describe("Required when kind='rental'"),
    },
    rentNumberHandler(http),
  );

  server.tool(
    "cancel_rental",
    "Cancel a rental. For verifications (ver_xxx) the API may refund if no message arrived. For long-term/dedicated rentals (ren_xxx) cancellation is typically non-refundable - check the response.",
    { rental_id: z.string() },
    cancelRentalHandler(http),
  );

  server.tool(
    "reuse_number",
    "Reuse a completed/expired verification to receive another SMS. Free reuse is available when allow_reuse is true on the verification. Paid reuse ($0.50) is available when allow_paid_reuse is true.",
    {
      rental_id: z.string().describe("ver_xxx from a verification"),
      paid: z.boolean().default(false),
    },
    reuseNumberHandler(http),
  );

  server.tool(
    "re_rent_rental",
    "Re-rent the same number for another period at the current price. Only works on an expired rental whose re_rent_available is true (the provider has not yet released the number). Re-uses the rental's original duration; no duration argument.",
    {
      rental_id: z.string().describe("ren_xxx from an expired LTR with re_rent_available=true"),
    },
    reRentRentalHandler(http),
  );

  server.tool(
    "toggle_auto_renew",
    "Turn auto-renewal on/off for an LTR or dedicated rental.",
    {
      rental_id: z.string().describe("ren_xxx"),
      auto_renew: z.boolean(),
    },
    toggleAutoRenewHandler(http),
  );
}

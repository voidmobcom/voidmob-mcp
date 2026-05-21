// src/tools/sms.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpClient, HttpError, NetworkError } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import {
  Verification,
  Rental,
  ServicesResponse,
  type Verification as VerificationT,
  type Rental as RentalT,
} from "../client/types.js";
import { mapApiError } from "../client/errors.js";
import { structuredOk, toolError, type ToolResult } from "../utils/render.js";
import { formatUsd, formatTimeRemaining } from "../utils/format.js";

// ── search_sms_services ─────────────────────────────────────────────────────

export const searchSmsServicesHandler = (http: HttpClient) =>
  async (args: { query?: string }): Promise<ToolResult> => {
    try {
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
            s.dedicated_price_cents !== undefined ? `  ded=${formatUsd(s.dedicated_price_cents)}` : ""
          }`,
        ),
      ].join("\n");
      return structuredOk(text, { services });
    } catch (e) {
      if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
      throw e;
    }
  };

// ── get_rental ──────────────────────────────────────────────────────────────

export const getRentalHandler = (http: HttpClient) =>
  async (args: { rental_id: string }): Promise<ToolResult> => {
    const id = args.rental_id;
    if (id.startsWith("ver_")) {
      try {
        const raw = await callApi<{ verification: unknown }>(http, "GET", `/v1/verifications/${id}`);
        const v = Verification.parse(raw.verification);
        return structuredOk(renderVerification(v), { verification: v });
      } catch (e) {
        if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
        throw e;
      }
    }
    if (id.startsWith("rnt_")) {
      try {
        const raw = await callApi<{ rental: unknown }>(http, "GET", `/v1/rentals/${id}`);
        const r = Rental.parse(raw.rental);
        return structuredOk(renderRental(r), { rental: r });
      } catch (e) {
        if (e instanceof HttpError || e instanceof NetworkError) return toolError(mapApiError(e));
        throw e;
      }
    }
    return toolError(`Invalid rental_id '${id}'. Expected ver_xxx (verification) or rnt_xxx (long-term/dedicated).`);
  };

// ── registration (write tools added in Task 10) ─────────────────────────────

export function registerSmsTools(server: McpServer, http: HttpClient) {
  server.tool(
    "search_sms_services",
    "Search available US non-VoIP SMS services with prices per row. Returns each service's verification price plus LTR/dedicated tiers when offered.",
    { query: z.string().optional().describe("Substring filter on service name (e.g. 'telegram').") },
    searchSmsServicesHandler(http),
  );

  server.tool(
    "get_rental",
    "Read a rental's current status and any messages received. Pass the ID you got from rent_number (ver_xxx for verifications, rnt_xxx for long-term/dedicated). SMS codes typically arrive 10-60s after rent_number; poll this tool until status changes.",
    { rental_id: z.string().describe("ver_xxx or rnt_xxx") },
    getRentalHandler(http),
  );
}

// ── render helpers (also used by Task 10 write tools) ───────────────────────

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
  if (v.messages && v.messages.length > 0) {
    lines.push(``, `  Messages (${v.messages.length}):`);
    for (const m of v.messages) {
      lines.push(`    [${m.received_at.slice(11, 19)}] ${m.text}`);
      if (m.code) lines.push(`      Code: ${m.code}`);
    }
  } else if (v.status === "waiting_for_code") {
    lines.push(``, `  No messages yet. Try get_rental again in 10-30s.`);
  }
  return lines.join("\n");
}

export function renderRental(r: RentalT): string {
  const lines = [
    `Rental ${r.id} (${r.kind})`,
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

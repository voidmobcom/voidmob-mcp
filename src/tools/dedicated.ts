import { z } from "zod";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import {
  DedicatedCountry,
  DedicatedNumber,
  type DedicatedNumber as DedicatedNumberT,
} from "../client/types.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { formatUsd, formatTimeRemaining } from "../utils/format.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { DED_PREFIX, isDedicatedId } from "../constants/rental-id.js";

const Countries = z.array(DedicatedCountry);

// ── search_dedicated_countries ──────────────────────────────────────────────

export const searchDedicatedCountriesHandler = (http: HttpClient) =>
  wrapToolErrors(async (): Promise<ToolResult> => {
    const raw = await callApi<unknown>(http, "GET", "/v1/dedicated/countries");
    const countries = Countries.parse(raw);
    if (countries.length === 0) return toolError("No dedicated-number countries are currently offered.");
    const text = [
      `${countries.length} dedicated-number countries:`,
      ``,
      ...countries.map(
        (c) =>
          `  ${c.name.padEnd(18)} ${c.country.padEnd(4)} ${formatUsd(c.quoted_price_cents)}/mo${c.in_stock ? "" : "  (out of stock)"}`,
      ),
    ].join("\n");
    return structuredOk(text, { countries });
  });

// ── get_dedicated_number ────────────────────────────────────────────────────

export const getDedicatedNumberHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { number_id: string }): Promise<ToolResult> => {
    const id = args.number_id;
    if (!isDedicatedId(id)) {
      return toolError(`get_dedicated_number requires ${DED_PREFIX}xxx. Got '${id}'.`);
    }
    const raw = await callApi<unknown>(http, "GET", `/v1/dedicated/numbers/${id}`);
    const d = DedicatedNumber.parse(raw);
    return structuredOk(renderDedicated(d), { dedicated_number: d });
  });

// ── render helper ───────────────────────────────────────────────────────────

function renderDedicated(d: DedicatedNumberT): string {
  const lines = [
    `Dedicated number ${d.id}`,
    ``,
    `  Phone:        ${d.phone_number}`,
    `  Country:      ${d.country_name} (${d.country})`,
    `  Status:       ${d.status}`,
    `  Charged:      ${formatUsd(d.charged_price_cents)}/mo`,
    `  Auto-renew:   ${d.auto_renew ? "on" : "off"} (next renewal ${formatUsd(d.next_renewal_price_cents)})`,
    `  Paid until:   ${d.paid_until}`,
    `  Expires:      ${formatTimeRemaining(new Date(d.expires_at).getTime())}`,
  ];
  if (d.nickname) lines.splice(3, 0, `  Nickname:     ${d.nickname}`);
  if (d.messages && d.messages.length > 0) {
    lines.push(``, `  Messages (${d.messages.length}):`);
    for (const m of d.messages) {
      lines.push(`    [${m.received_at.slice(11, 19)}] ${m.text}`);
      if (m.code) lines.push(`      Code: ${m.code}`);
    }
  }
  return lines.join("\n");
}

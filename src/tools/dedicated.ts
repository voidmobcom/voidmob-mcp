import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// ── purchase_dedicated_number ───────────────────────────────────────────────

export const purchaseDedicatedNumberHandler = (http: HttpClient) =>
  wrapToolErrors(async (args: { country: string; auto_renew?: boolean }): Promise<ToolResult> => {
    const raw = await callApi<unknown>(http, "GET", "/v1/dedicated/countries");
    const countries = Countries.parse(raw);
    const q = args.country.trim().toLowerCase();
    const match =
      countries.find((c) => c.country.toLowerCase() === q) ??
      countries.find((c) => c.name.toLowerCase().includes(q));
    if (!match) {
      return toolError(
        `No dedicated numbers offered for '${args.country}'. Available: ${countries.map((c) => c.country).join(", ")}.`,
      );
    }
    if (!match.in_stock) {
      return toolError(
        `${match.name} dedicated numbers are out of stock right now. Run search_dedicated_countries to pick an in-stock country, or retry later.`,
      );
    }
    const created = await callApi<unknown>(http, "POST", "/v1/dedicated/numbers", {
      body: {
        country: match.country,
        auto_renew: args.auto_renew ?? false,
        max_price_cents: match.quoted_price_cents,
      },
      idempotencyKey: newIdempotencyKey(),
    });
    const d = DedicatedNumber.parse(created);
    return structuredOk(`Dedicated number ${d.id} purchased.\n\n${renderDedicated(d)}`, { dedicated_number: d });
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

// ── registration ────────────────────────────────────────────────────────────

export function registerDedicatedTools(server: McpServer, http: HttpClient) {
  server.tool(
    "search_dedicated_countries",
    "List countries where dedicated numbers are offered, with your monthly price and stock status. A dedicated number is a private number that receives SMS for ALL services, renews monthly, and stays yours until you stop renewing.",
    {},
    searchDedicatedCountriesHandler(http),
  );

  server.tool(
    "purchase_dedicated_number",
    "Buy a dedicated monthly number in a country from search_dedicated_countries. Quote-then-commit: the tool fetches your live price and ties max_price_cents to it so you never pay above the quote. Returns a ded_xxx id - poll get_dedicated_number to read incoming SMS.",
    {
      country: z.string().describe("Country code or name from search_dedicated_countries (e.g. 'us', 'uk', 'germany')"),
      auto_renew: z.boolean().default(false).describe("Auto-charge at the end of each monthly period"),
    },
    purchaseDedicatedNumberHandler(http),
  );

  server.tool(
    "get_dedicated_number",
    "Read a dedicated number's status and received SMS messages (parsed codes included). Messages keep arriving for the life of the number; poll this tool after directing an SMS at it.",
    { number_id: z.string().describe("ded_xxx from purchase_dedicated_number or list_orders") },
    getDedicatedNumberHandler(http),
  );
}

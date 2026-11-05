import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { callApi } from "../client/call-api.js";
import { priceChangedText } from "../client/errors.js";
import {
  DedicatedCountry,
  DedicatedNumber,
  type DedicatedNumber as DedicatedNumberT,
} from "../client/types.js";
import { ToolRefusal } from "../controls/spend-guard.js";
import { structuredOk, toolError, wrapToolErrors, renderMessages, type ToolResult } from "../utils/render.js";
import { formatUsd, formatTimeRemaining } from "../utils/format.js";
import { READ_ONLY, SPENDS } from "../utils/annotations.js";
import { outputObject } from "../utils/output.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { MaxPriceCents } from "../constants/price.js";
import { defineTool, type ToolContext } from "./context.js";

const Countries = z.array(DedicatedCountry);

// ── search_dedicated_countries ──────────────────────────────────────────────

export const SearchDedicatedCountriesOutput = outputObject({ countries: Countries });

export const searchDedicatedCountriesHandler = (ctx: ToolContext) =>
  wrapToolErrors(ctx, async (): Promise<ToolResult> => {
    const raw = await callApi<unknown>(ctx.http, "GET", "/v1/dedicated/countries");
    const countries = Countries.parse(raw);
    if (countries.length === 0) {
      return structuredOk("No dedicated-number countries are offered right now.", { countries: [] });
    }
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

// ── purchase_dedicated_number ───────────────────────────────────────────────

export const DedicatedNumberOutput = outputObject({ dedicated_number: DedicatedNumber });

/**
 * The one country the caller means, or refusal text. A 2-letter input is a
 * code and matches codes only (a name substring match would turn an
 * unavailable 'at' into United St-at-es); a longer input must name exactly
 * one country.
 */
function matchCountry(countries: DedicatedCountry[], input: string): DedicatedCountry | string {
  const q = input.trim().toLowerCase();
  const available = `Available: ${countries.map((c) => `${c.country} (${c.name})`).join(", ")}. Nothing was charged.`;
  const byCode = countries.find((c) => c.country.toLowerCase() === q);
  if (byCode) return byCode;
  if (q.length <= 2) return `No dedicated numbers offered for country code '${input}'. ${available}`;
  const exact = countries.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const byName = countries.filter((c) => c.name.toLowerCase().includes(q));
  if (byName.length === 1) return byName[0];
  return byName.length === 0
    ? `No dedicated numbers offered for '${input}'. ${available}`
    : `'${input}' matches several countries (${byName.map((c) => c.country).join(", ")}); pass the country code. Nothing was charged.`;
}

export const purchaseDedicatedNumberHandler = (ctx: ToolContext) =>
  wrapToolErrors(ctx, async (args: { country: string; auto_renew?: boolean; max_price_cents: number }): Promise<ToolResult> => {
    const max = args.max_price_cents;
    // The renewals auto_renew schedules are charged later, outside a session
    // budget (the per-order limit is covered: a renewal costs the monthly
    // price, which max_price_cents already bounds).
    if (args.auto_renew && ctx.guard.budgetCents !== null) {
      return toolError(`${ctx.guard.autoRenewRefusal(null)} Buy it with auto_renew=false instead.`);
    }
    const d = await ctx.guard.run(max, async () => {
      // The country list resolves a name ('germany') to its code and shows
      // stock; the price check itself is the API's (max_price_cents ->
      // PRICE_OVER_CAP). Refusing here on the listed price just saves a call.
      const countries = Countries.parse(await callApi<unknown>(ctx.http, "GET", "/v1/dedicated/countries"));
      const match = matchCountry(countries, args.country);
      if (typeof match === "string") throw new ToolRefusal(match);
      if (!match.in_stock) {
        throw new ToolRefusal(
          `${match.name} dedicated numbers are out of stock right now. Nothing was charged. Run search_dedicated_countries to pick an in-stock country, or retry later.`,
        );
      }
      if (match.quoted_price_cents > max) throw new ToolRefusal(priceChangedText(match.quoted_price_cents, max));
      const created = await callApi<unknown>(ctx.http, "POST", "/v1/dedicated/numbers", {
        body: {
          country: match.country,
          auto_renew: args.auto_renew ?? false,
          max_price_cents: max,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      const value = DedicatedNumber.parse(created);
      return { value, chargedCents: value.charged_price_cents };
    });
    return structuredOk(`Dedicated number ${d.id} purchased.\n\n${renderDedicated(d)}`, { dedicated_number: d });
  });

// ── render helper ───────────────────────────────────────────────────────────

/** A dedicated number for purchase_dedicated_number and get_rental (ded_ ids). */
export function renderDedicated(d: DedicatedNumberT): string {
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
    lines.push(...renderMessages(d.messages));
  }
  return lines.join("\n");
}

// ── registration ────────────────────────────────────────────────────────────

export function registerDedicatedTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, "search_dedicated_countries", {
    group: "numbers",
    level: "view",
    title: "Dedicated number countries",
    description:
      "List countries where dedicated numbers are offered, with your monthly price and stock status. A dedicated number is a private number that receives SMS " +
      "from ALL services, renews monthly, and stays yours until you stop renewing. Next: show the user the price, then purchase_dedicated_number with it as max_price_cents.",
    inputSchema: {},
    outputSchema: SearchDedicatedCountriesOutput,
    annotations: READ_ONLY,
  }, searchDedicatedCountriesHandler(ctx));

  defineTool(server, ctx, "purchase_dedicated_number", {
    group: "numbers",
    level: "buy",
    title: "Buy a dedicated number",
    description:
      "Buy a dedicated monthly number in a country from search_dedicated_countries, charged to your balance immediately for the first month. " +
      "Requires max_price_cents: the monthly price you showed the user and they approved; if the price is now higher, nothing is charged and the new price comes back to re-confirm. " +
      "There is no cancel or refund - to stop paying, leave auto_renew off and let the month run out. Returns a ded_ id - poll get_rental with it to read incoming SMS.",
    inputSchema: {
      country: z.string().min(2).max(40).describe("Country code or name from search_dedicated_countries (e.g. 'us', 'uk', 'germany')"),
      auto_renew: z.boolean().default(false).describe(
        "Charge the next month automatically at the end of each monthly period (ask the user first). " +
        "An app connection can never turn it on: such a purchase is refused with nothing charged.",
      ),
      max_price_cents: MaxPriceCents,
    },
    outputSchema: DedicatedNumberOutput,
    annotations: SPENDS,
  }, purchaseDedicatedNumberHandler(ctx));
}

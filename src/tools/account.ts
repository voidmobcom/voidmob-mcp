import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { callApi } from "../client/call-api.js";
import { MePayload, type MeKey } from "../client/types.js";
import { connectionFromMe, LEVEL_LABEL, settingsUrlFor } from "../connection.js";
import { describeLimits } from "../controls/spend-guard.js";
import { formatUsd } from "../utils/format.js";
import { structuredOk, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { READ_ONLY } from "../utils/annotations.js";
import { outputObject } from "../utils/output.js";
import { defineTool, type ToolContext } from "./context.js";

// What this server acts with: its permission level (the key's, lowered by
// VOIDMOB_READ_ONLY) and whether auto-mode is in force.
const Access = z.object({
  permission: z.enum(["view", "manage", "buy"]),
  auto_mode: z.boolean(),
  settings_url: z.string(),
  deposit_url: z.string(),
});

const OwnerLimits = z.object({
  max_order_cents: z.number().int().nullable(),
  budget_cents: z.number().int().nullable(),
  budget_counted_cents: z.number().int(),
  budget_remaining_cents: z.number().int().nullable(),
});

export const GetAccountOutput = outputObject({ account: MePayload, access: Access, owner_limits: OwnerLimits });

const limitText = (cents: number | null) => (cents === null ? "No limit" : formatUsd(cents));

function describeKey(key: MeKey, settingsUrl: string): string[] {
  const spent = `${formatUsd(key.spent_24h_cents)} spent in the last 24h`;
  const daily = key.daily_limit_cents === null
    ? `No limit (${spent})`
    : `${formatUsd(key.daily_limit_cents)} (${spent}, ${formatUsd(Math.max(0, key.daily_limit_cents - key.spent_24h_cents))} left)`;
  return [
    ``,
    `  ${key.kind === "oauth" ? "App connection" : "API key"} ${JSON.stringify(key.name.slice(0, 80))}:`,
    `    Permission:      ${LEVEL_LABEL[key.permission]}`,
    `    Max per order:   ${limitText(key.max_order_cents)}`,
    `    Daily limit:     ${daily}`,
    `    Auto-mode:       ${key.auto_mode ? "on (may buy without asking, within the limits)" : "off (asks before buying)"}`,
    `    Settings:        ${settingsUrl}`,
  ];
}

// Exported as a factory for test direct-invocation. registerAccountTools wires
// it onto the McpServer; tests can call getAccountHandler(ctx)() without
// going through the SDK private internals.
export const getAccountHandler = (ctx: ToolContext) =>
  wrapToolErrors(ctx, async (): Promise<ToolResult> => {
    const raw = await callApi<unknown>(ctx.http, "GET", "/v1/me");
    const me = MePayload.parse(raw);
    const fresh = connectionFromMe(me);
    const depositUrl = me.deposit_url ?? ctx.depositUrl;
    const settingsUrl = fresh ? settingsUrlFor(fresh) : ctx.settingsUrl;
    const local: string[] = [];
    if (ctx.localReadOnly) local.push(`    Access:          View (VOIDMOB_READ_ONLY: nothing can be bought or changed)`);
    if (ctx.localAutoMode) local.push(`    Auto-mode:       on (VOIDMOB_AUTONOMOUS: may buy without asking, within the limits)`);
    const text = [
      `Account ${me.id}`,
      ``,
      `  Balance:     ${me.balance.formatted}`,
      `  Add funds:   ${depositUrl}`,
      `  Created:     ${me.created_at.slice(0, 10)}`,
      ...(me.key ? describeKey(me.key, settingsUrl) : []),
      ``,
      `  Rate limits (per 60s):`,
      ...Object.entries(me.rate_limits).map(
        ([g, l]) => `    ${g.padEnd(20)} ${l.limit}/min`,
      ),
      ...describeLimits(ctx.guard, local),
    ].join("\n");
    return structuredOk(text, {
      account: me,
      access: { permission: ctx.level, auto_mode: ctx.autoMode, settings_url: settingsUrl, deposit_url: depositUrl },
      owner_limits: {
        max_order_cents: ctx.guard.maxOrderCents,
        budget_cents: ctx.guard.budgetCents,
        budget_counted_cents: ctx.guard.countedCents,
        budget_remaining_cents: ctx.guard.remainingCents,
      },
    });
  });

export function registerAccountTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, "get_account", {
    group: "core",
    level: "view",
    title: "Account balance",
    description:
      "Get the authenticated account: id, prepaid USD balance and the link to add funds, this API key's or app connection's permission level, " +
      "spending limits (per order and per rolling 24 hours), spend in the last 24 hours and auto-mode, per-endpoint-group rate limits, " +
      "plus any limits the owner set on this server. " +
      "Use it before buying to confirm sufficient funds, and after an uncertain purchase result to see whether a charge landed. " +
      "The balance is topped up with crypto in the dashboard by the account owner.",
    inputSchema: {},
    outputSchema: GetAccountOutput,
    annotations: READ_ONLY,
  }, getAccountHandler(ctx));
}

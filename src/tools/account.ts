import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callApi } from "../client/call-api.js";
import { MePayload } from "../client/types.js";
import { describeLimits } from "../controls/spend-guard.js";
import { structuredOk, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { READ_ONLY } from "../utils/annotations.js";
import { outputObject } from "../utils/output.js";
import { defineTool, type ToolContext } from "./context.js";

const OwnerLimits = z.object({
  read_only: z.boolean(),
  max_order_cents: z.number().int().nullable(),
  budget_cents: z.number().int().nullable(),
  budget_counted_cents: z.number().int(),
  budget_remaining_cents: z.number().int().nullable(),
});

export const GetAccountOutput = outputObject({ account: MePayload, owner_limits: OwnerLimits });

// Exported as a factory for test direct-invocation. registerAccountTools wires
// it onto the McpServer; tests can call getAccountHandler(ctx)() without
// going through the SDK private internals.
export const getAccountHandler = (ctx: ToolContext) =>
  wrapToolErrors(async (): Promise<ToolResult> => {
    const raw = await callApi<unknown>(ctx.http, "GET", "/v1/me");
    const me = MePayload.parse(raw);
    const text = [
      `Account ${me.id}`,
      ``,
      `  Balance:     ${me.balance.formatted}`,
      `  Created:     ${me.created_at.slice(0, 10)}`,
      ``,
      `  Rate limits (per 60s):`,
      ...Object.entries(me.rate_limits).map(
        ([g, l]) => `    ${g.padEnd(20)} ${l.limit}/min`,
      ),
      ...describeLimits(ctx.guard, ctx.readOnly),
    ].join("\n");
    return structuredOk(text, {
      account: me,
      owner_limits: {
        read_only: ctx.readOnly,
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
    writes: false,
    title: "Account balance",
    description:
      "Get the authenticated account: id, prepaid USD balance, and per-endpoint-group rate limits, plus any spend limits the owner set on this server. " +
      "Use it before buying to confirm sufficient funds, and after an uncertain purchase result to see whether a charge landed. " +
      "The balance is topped up with crypto in the dashboard by the account owner.",
    inputSchema: {},
    outputSchema: GetAccountOutput,
    annotations: READ_ONLY,
  }, getAccountHandler(ctx));
}

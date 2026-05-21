import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { MePayload } from "../client/types.js";
import { structuredOk, wrapToolErrors, type ToolResult } from "../utils/render.js";

// Exported as a factory for test direct-invocation. registerAccountTools wires
// it onto the McpServer; tests can call getAccountHandler(mockHttp)() without
// going through the SDK private internals.
export const getAccountHandler = (http: HttpClient) =>
  wrapToolErrors(async (): Promise<ToolResult> => {
    const raw = await callApi<unknown>(http, "GET", "/v1/me");
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
    ].join("\n");
    return structuredOk(text, { account: me });
  });

export function registerAccountTools(server: McpServer, http: HttpClient) {
  server.tool(
    "get_account",
    "Get the authenticated account: id, USD wallet balance, and per-endpoint-group rate limits. Use this before money-touching tool calls to confirm sufficient funds.",
    {},
    getAccountHandler(http),
  );
}

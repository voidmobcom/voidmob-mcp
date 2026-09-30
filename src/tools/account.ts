import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../client/http.js";
import { callApi } from "../client/call-api.js";
import { MePayload } from "../client/types.js";
import { structuredOk, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { READ_ONLY } from "../utils/annotations.js";

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
  server.registerTool(
    "get_account",
    {
      title: "Account balance",
      description:
        "Get the authenticated account: id, prepaid USD balance, and per-endpoint-group rate limits. Use it before buying to confirm sufficient funds, " +
        "and after an uncertain purchase result to see whether a charge landed. The balance is topped up with crypto in the dashboard by the account owner.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    getAccountHandler(http),
  );
}

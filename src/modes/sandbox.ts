import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSandboxHttpClient } from "../sandbox/mock-http.js";
import { createVoidmobServer } from "../server.js";

// Sandbox mode registers the exact same live tools, but injects an in-memory
// mock HttpClient instead of the real one. The tool surface is therefore
// identical to live by construction - it cannot drift.
export function buildSandboxServer(): McpServer {
  return createVoidmobServer(createSandboxHttpClient());
}

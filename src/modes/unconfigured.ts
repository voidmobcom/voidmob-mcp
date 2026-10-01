import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpError, type HttpClient } from "../client/http.js";
import { DEFAULT_CONTROLS, type OwnerControls } from "../config.js";
import { createVoidmobServer } from "../server.js";

const SETUP_MESSAGE =
  "VOIDMOB_API_KEY is not set. Generate a key at https://dashboard.voidmob.com/developers/api-keys " +
  "and restart with VOIDMOB_API_KEY=vmk_live_..., or set VOIDMOB_SANDBOX=1 to explore with mock data.";

export function createUnconfiguredClient(): HttpClient {
  return {
    request() {
      return Promise.reject(new HttpError(401, "NOT_CONFIGURED", "", undefined, SETUP_MESSAGE));
    },
  };
}

// No-key mode: boots and exposes the full tool surface (so MCP clients and
// registry crawlers can enumerate tools), but every call fails with setup
// instructions instead of touching the network. Registers the SAME live tools
// with the rejecting client injected, so the surface cannot drift from live.
export function buildUnconfiguredServer(controls: OwnerControls = DEFAULT_CONTROLS): McpServer {
  return createVoidmobServer(createUnconfiguredClient(), controls);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HttpError, type HttpClient } from "../client/http.js";
import { registerAccountTools } from "../tools/account.js";
import { registerSmsTools } from "../tools/sms.js";
import { registerEsimTools } from "../tools/esim.js";
import { registerProxyTools } from "../tools/proxy.js";
import { registerGeoTools } from "../tools/geo.js";
import { registerOrdersTools } from "../tools/orders.js";
import { registerDedicatedTools } from "../tools/dedicated.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

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
export function buildUnconfiguredServer(): McpServer {
  const http = createUnconfiguredClient();
  const server = new McpServer({ name: "@voidmob/mcp", version: pkg.version });

  registerAccountTools(server, http);
  registerSmsTools(server, http);
  registerDedicatedTools(server, http);
  registerEsimTools(server, http);
  registerProxyTools(server, http);
  registerGeoTools(server, http);
  registerOrdersTools(server, http);

  return server;
}

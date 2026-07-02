import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSandboxHttpClient } from "../sandbox/mock-http.js";
import { registerAccountTools } from "../tools/account.js";
import { registerSmsTools } from "../tools/sms.js";
import { registerEsimTools } from "../tools/esim.js";
import { registerProxyTools } from "../tools/proxy.js";
import { registerGeoTools } from "../tools/geo.js";
import { registerOrdersTools } from "../tools/orders.js";
import { registerDedicatedTools } from "../tools/dedicated.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

// Sandbox mode registers the exact same live tools, but injects an in-memory
// mock HttpClient instead of the real one. The tool surface is therefore
// identical to live by construction - it cannot drift.
export function buildSandboxServer(): McpServer {
  const http = createSandboxHttpClient();
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

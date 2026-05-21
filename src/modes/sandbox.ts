// src/modes/sandbox.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWalletTools } from "../sandbox/tools/wallet.js";
import { registerSmsTools } from "../sandbox/tools/sms.js";
import { registerEsimTools } from "../sandbox/tools/esim.js";
import { registerProxyTools } from "../sandbox/tools/proxy.js";
import { registerOrdersTools } from "../sandbox/tools/orders.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

export function buildSandboxServer(): McpServer {
  const server = new McpServer({ name: "@voidmob/mcp", version: pkg.version });
  registerWalletTools(server);
  registerSmsTools(server);
  registerEsimTools(server);
  registerProxyTools(server);
  registerOrdersTools(server);
  return server;
}

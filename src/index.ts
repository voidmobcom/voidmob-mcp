#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWalletTools } from "./sandbox/tools/wallet.js";
import { registerSmsTools } from "./sandbox/tools/sms.js";
import { registerEsimTools } from "./sandbox/tools/esim.js";
import { registerProxyTools } from "./sandbox/tools/proxy.js";
import { registerOrdersTools } from "./sandbox/tools/orders.js";

function createServer() {
  const server = new McpServer({ name: "@voidmob/mcp", version: "1.0.0" });
  registerWalletTools(server);
  registerSmsTools(server);
  registerEsimTools(server);
  registerProxyTools(server);
  registerOrdersTools(server);
  return server;
}

export function createSandboxServer() {
  return createServer();
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWalletTools } from "./tools/wallet.js";
import { registerSmsTools } from "./tools/sms.js";
import { registerEsimTools } from "./tools/esim.js";
import { registerProxyTools } from "./tools/proxy.js";
import { registerOrdersTools } from "./tools/orders.js";

function createServer() {
  const server = new McpServer({
    name: "@voidmob/mcp",
    version: "0.1.0",
  });

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

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseEnv, ConfigError } from "./config.js";
import { buildLiveServer } from "./modes/live.js";
import { buildSandboxServer } from "./modes/sandbox.js";

async function main() {
  let cfg;
  try {
    cfg = parseEnv();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[voidmob-mcp] config error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const server = cfg.sandbox ? buildSandboxServer() : buildLiveServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[voidmob-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

export { buildSandboxServer } from "./modes/sandbox.js";
export { buildLiveServer } from "./modes/live.js";

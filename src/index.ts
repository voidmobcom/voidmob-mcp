#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseEnv, ConfigError } from "./config.js";
import { buildLiveServer } from "./modes/live.js";
import { buildSandboxServer } from "./modes/sandbox.js";
import { buildUnconfiguredServer } from "./modes/unconfigured.js";

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

  let server;
  if (cfg.sandbox) {
    server = buildSandboxServer();
  } else if (cfg.apiKey) {
    server = buildLiveServer(cfg);
  } else {
    process.stderr.write(
      `[voidmob-mcp] no VOIDMOB_API_KEY set - tools are listed but every call will fail. ` +
      `Set VOIDMOB_API_KEY=vmk_live_... or VOIDMOB_SANDBOX=1 for mock data.\n`,
    );
    server = buildUnconfiguredServer();
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[voidmob-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

export { buildSandboxServer } from "./modes/sandbox.js";
export { buildLiveServer } from "./modes/live.js";
export { buildUnconfiguredServer } from "./modes/unconfigured.js";

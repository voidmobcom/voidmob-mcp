#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError } from "./config.js";
import { prepareServer } from "./startup.js";

async function main() {
  let build;
  try {
    build = await prepareServer();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[voidmob-mcp] config error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  // serveStdio builds the server on the connection's first message and serves
  // both 2025-era (initialize) and 2026-07-28 (server/discover) clients.
  serveStdio(build);
}

main().catch((err) => {
  process.stderr.write(`[voidmob-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

export { buildSandboxServer } from "./modes/sandbox.js";
export { buildLiveServer } from "./modes/live.js";
export { buildUnconfiguredServer } from "./modes/unconfigured.js";

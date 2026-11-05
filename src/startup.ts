import type { McpServer } from "@modelcontextprotocol/server";
import { parseEnv, assertAutonomousLimit } from "./config.js";
import { buildLiveServer, loadLiveConnection } from "./modes/live.js";
import { buildSandboxServer } from "./modes/sandbox.js";
import { buildUnconfiguredServer } from "./modes/unconfigured.js";

/**
 * Reads the config (and, with a key, the key's settings) and returns the
 * server factory for stdio. Throws ConfigError for a setting that cannot run.
 */
export async function prepareServer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<() => McpServer> {
  const cfg = parseEnv(env);
  if (cfg.sandbox) return () => buildSandboxServer(cfg.controls);
  if (cfg.apiKey) {
    // Read once, before serving: the factory may run twice per connection,
    // and the tool list must follow the key's level from the first tools/list.
    const connection = await loadLiveConnection(cfg);
    if (connection) assertAutonomousLimit(cfg.controls, connection.dailyLimitCents, true);
    return () => buildLiveServer(cfg, connection);
  }
  process.stderr.write(
    `[voidmob-mcp] no VOIDMOB_API_KEY set - tools are listed but every call will fail. ` +
    `Set VOIDMOB_API_KEY=vmk_live_... or VOIDMOB_SANDBOX=1 for mock data.\n`,
  );
  return () => buildUnconfiguredServer(cfg.controls);
}

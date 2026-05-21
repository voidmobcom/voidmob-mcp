// src/modes/live.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { createHttpClient } from "../client/http.js";
import { registerAccountTools } from "../tools/account.js";
import { registerSmsTools } from "../tools/sms.js";
import { registerEsimTools } from "../tools/esim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

export function buildLiveServer(cfg: Config): McpServer {
  if (!cfg.apiKey) throw new Error("buildLiveServer requires an API key");
  const http = createHttpClient({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    debug: cfg.debug,
    userAgent: `voidmob-mcp/${pkg.version} node/${process.version}`,
  });
  const server = new McpServer({ name: "@voidmob/mcp", version: pkg.version });

  // Tool registrations land here. Tasks 9-14 add more registrations alongside
  // registerAccountTools using the same factory-handler pattern.
  registerAccountTools(server, http);
  registerSmsTools(server, http);
  registerEsimTools(server, http);

  return server;
}

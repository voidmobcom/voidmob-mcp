// src/modes/live.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { createHttpClient } from "../client/http.js";

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

  // Tool registrations land in Tasks 8-14. The http instance is unused for now
  // (TS will warn). To suppress the unused-warning until Task 8 wires it in,
  // include a void marker so the import isn't accidentally pruned:
  void http;

  return server;
}

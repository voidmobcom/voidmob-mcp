import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { createHttpClient } from "../client/http.js";
import { createVoidmobServer, VERSION } from "../server.js";

export function buildLiveServer(cfg: Config): McpServer {
  if (!cfg.apiKey) throw new Error("buildLiveServer requires an API key");
  const http = createHttpClient({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    debug: cfg.debug,
    userAgent: `voidmob-mcp/${VERSION} node/${process.version}`,
  });
  return createVoidmobServer(http);
}

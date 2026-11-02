import type { McpServer } from "@modelcontextprotocol/server";
import { ZodError } from "zod";
import type { Config } from "../config.js";
import { createHttpClient, HttpError, type HttpClient } from "../client/http.js";
import { loadConnection, type Connection } from "../connection.js";
import { createVoidmobServer, VERSION } from "../server.js";

// Startup waits at most this long for the key's settings, so a slow or
// unreachable API cannot stall the client's connect.
const STARTUP_WAIT_MS = 10_000;

function liveHttpClient(cfg: Config, apiKey: string): HttpClient {
  return createHttpClient({
    apiKey,
    baseUrl: cfg.baseUrl,
    debug: cfg.debug,
    userAgent: `voidmob-mcp/${VERSION} node/${process.version}`,
  });
}

/**
 * The API key's settings from /v1/me, read once before serving. On any
 * failure (network, timeout, an API error) it logs one line to stderr and
 * returns null: the server then runs on the local controls alone, and the API
 * still enforces the key's permission and limits on every call.
 */
export async function loadLiveConnection(cfg: Config, waitMs = STARTUP_WAIT_MS): Promise<Connection | null> {
  if (!cfg.apiKey) throw new Error("loadLiveConnection requires an API key");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${waitMs / 1000}s`)), waitMs);
  });
  try {
    return await Promise.race([loadConnection(liveHttpClient(cfg, cfg.apiKey), cfg.apiKey), timeout]);
  } catch (e) {
    const reason = e instanceof HttpError ? e.code : e instanceof ZodError ? "unexpected response" : e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[voidmob-mcp] could not read this API key's permission and limits (${reason}); using the local controls only` +
      (cfg.controls.autonomous && cfg.controls.budgetCents === null ? `, and VOIDMOB_AUTONOMOUS stays off until a daily limit is confirmed` : ``) +
      `. The API still enforces the key's settings on every call.\n`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildLiveServer(cfg: Config, connection: Connection | null = null): McpServer {
  if (!cfg.apiKey) throw new Error("buildLiveServer requires an API key");
  return createVoidmobServer(liveHttpClient(cfg, cfg.apiKey), cfg.controls, connection);
}

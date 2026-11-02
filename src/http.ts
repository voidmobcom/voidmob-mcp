// The hosted MCP service (mcp.voidmob.com): the same tools as the stdio
// server, served over HTTP to OAuth-connected apps and API-key clients.
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { ConfigError } from "./config.js";
import { createHostedApp } from "./hosted/app.js";
import { MAX_BODY_BYTES, parseHostedEnv, type HostedConfig } from "./hosted/config.js";
import { VERSION } from "./server.js";

// Longer than the tunnel's idle keep-alive (90 s), so the server never closes
// a connection the tunnel is about to reuse.
const KEEP_ALIVE_MS = 95_000;
const SHUTDOWN_GRACE_MS = 10_000;

const say = (line: string) => process.stdout.write(`[voidmob-mcp] ${line}\n`);

function main() {
  let cfg: HostedConfig;
  try {
    cfg = parseHostedEnv(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[voidmob-mcp] config error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const app = createHostedApp(cfg);
  const server = createServer(
    toNodeHandler(app, {
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: (e) => say(`request failed: ${e.name}`),
    }),
  );
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;
  server.listen(cfg.port, () => say(`${VERSION} listening on :${cfg.port} for ${cfg.resourceUrl.href}`));

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    say("shutting down");
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    void app.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();

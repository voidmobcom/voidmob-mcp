// The hosted MCP service (mcp.voidmob.com): the same tools as the stdio
// server, served over HTTP to OAuth-connected apps and API-key clients.
import { ConfigError } from "./config.js";
import { createHostedApp } from "./hosted/app.js";
import { parseHostedEnv, type HostedConfig } from "./hosted/config.js";
import { serveHosted } from "./hosted/serve.js";
import { VERSION } from "./server.js";

const say = (line: string) => process.stdout.write(`[voidmob-mcp] ${line}\n`);

async function main() {
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

  const running = await serveHosted(createHostedApp(cfg), {
    port: cfg.port,
    onError: (e) => say(`request failed: ${e.name}`),
  });
  say(`${VERSION} listening on :${running.port} for ${cfg.resourceUrl.href}`);

  const stop = () => {
    say("shutting down");
    void running.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  process.stderr.write(`[voidmob-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

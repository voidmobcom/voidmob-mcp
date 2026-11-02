import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { HostedApp } from "./app.js";
import { MAX_BODY_BYTES } from "./config.js";

// Longer than the tunnel's idle keep-alive (90 s), so the server never closes
// a connection the tunnel is about to reuse.
const KEEP_ALIVE_MS = 95_000;
export const SHUTDOWN_GRACE_MS = 10_000;

export interface RunningServer {
  server: Server;
  port: number;
  /**
   * Stops taking connections and lets requests in flight finish (a purchase
   * already charged still returns its result), then closes the app. Whatever
   * is still open after the grace period is cut.
   */
  stop(): Promise<void>;
}

export function serveHosted(
  app: HostedApp,
  opts: { port: number; host?: string; graceMs?: number; onError?: (e: Error) => void },
): Promise<RunningServer> {
  const server = createServer(toNodeHandler(app, { maxRequestBodySize: MAX_BODY_BYTES, onerror: opts.onError }));
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(sweep);
        clearTimeout(cutoff);
        server.closeAllConnections();
        // Only now: closing the app aborts its in-flight exchanges.
        void app.close().finally(resolve);
      };
      server.close(() => finish());
      // A keep-alive connection closes as soon as its request is answered.
      server.closeIdleConnections();
      const sweep = setInterval(() => server.closeIdleConnections(), 250);
      const cutoff = setTimeout(finish, graceMs);
    }));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve({ server, port: (server.address() as AddressInfo).port, stop });
    });
  });
}

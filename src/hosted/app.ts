import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
  type McpServer,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import type { JWTVerifyGetKey } from "jose";
import { createHttpClient, type HttpClient } from "../client/http.js";
import { DEFAULT_CONTROLS } from "../config.js";
import { loadConnection, type Connection } from "../connection.js";
import { createVoidmobServer, VERSION } from "../server.js";
import { createTokenVerifier, hostedAuthOf, remoteJwks, type HostedAuth } from "./auth.js";
import { MAX_BODY_BYTES, type HostedConfig } from "./config.js";
import { RateLimiter, SandboxStore } from "./sandbox.js";

/** How long a request waits for the credential's settings before using its claims (or the defaults). */
const CONNECTION_WAIT_MS = 5_000;
const FORWARD_TIMEOUT_MS = 10_000;
const SANDBOX_PATH = /^\/sandbox(?:\/([A-Za-z0-9_-]{1,128}))?$/;

/**
 * The User-Agent the hosted server sends to the API: the "voidmob-mcp/" prefix
 * marks MCP traffic, "+remote" the hosted server, then the MCP client's name
 * when it is known (letters, digits and a few separators, at most 48).
 */
export function remoteUserAgent(clientName?: unknown): string {
  const name = typeof clientName === "string"
    ? clientName.replace(/[^\w .\/@+:-]/g, "").replace(/\s+/g, " ").trim().slice(0, 48).trim()
    : "";
  return `voidmob-mcp/${VERSION}+remote${name ? ` (${name})` : ""}`;
}

export interface HostedApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface HostedDeps {
  /** Key lookup for access tokens; defaults to the issuer's JWKS over HTTPS. */
  jwks?: JWTVerifyGetKey;
  /** One line per request; defaults to stdout. */
  log?: (line: string) => void;
  sandboxes?: SandboxStore;
  sandboxLimiter?: RateLimiter;
}

/** What the request log line reports. */
interface RequestNote {
  route: string;
  auth: "oauth" | "key" | "none" | "sandbox" | "-";
  error?: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });

const methodNotAllowed = (allow: string): Response =>
  json(405, { error: "method_not_allowed" }, { Allow: allow });

const CORS = { "Access-Control-Allow-Origin": "*" };

// Public discovery documents: readable from any origin, like the SDK's own.
function metadataResponse(request: Request, body: unknown): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD, OPTIONS");
  const response = json(200, body, CORS);
  return request.method === "HEAD" ? new Response(null, { status: 200, headers: response.headers }) : response;
}

/** The client IP Cloudflare reports; the container is reachable only through the tunnel. */
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim().slice(0, 64) || "local";
}

function sandboxKey(request: Request): string {
  const token = SANDBOX_PATH.exec(new URL(request.url).pathname)?.[1];
  return token ? `token:${token}` : `ip:${clientIp(request)}`;
}

function protocolVersion(request: Request): string {
  const v = request.headers.get("mcp-protocol-version") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "-";
}

const NO_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Sends a request on to the authorization server and returns its status,
 * body and content type. Never follows a redirect, and never logs the body,
 * which carries codes, secrets and tokens.
 */
async function forward(request: Request, target: string, cors = false): Promise<Response> {
  const headers = new Headers({ "User-Agent": remoteUserAgent() });
  for (const name of ["content-type", "accept", "authorization"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json(413, { error: "invalid_request", error_description: "Request body too large" });
  }
  let upstream: Response;
  let payload: ArrayBuffer;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    payload = await upstream.arrayBuffer();
  } catch {
    return json(503, { error: "temporarily_unavailable", error_description: "Sign-in is unavailable right now. Try again shortly." });
  }
  if (payload.byteLength > MAX_BODY_BYTES) {
    return json(503, { error: "temporarily_unavailable", error_description: "Sign-in is unavailable right now. Try again shortly." });
  }
  const out = new Headers({ "Cache-Control": "no-store", ...(cors ? CORS : {}) });
  for (const name of ["content-type", "www-authenticate", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(NO_BODY_STATUS.has(upstream.status) ? null : payload, { status: upstream.status, headers: out });
}

/**
 * The credential's settings from /v1/me (fresher than the token's claims, and
 * they carry the limits). When /v1/me fails or is slow, an access token falls
 * back to its claims and an API key to the defaults: the API enforces the
 * real settings on every call either way.
 */
async function hostedConnection(http: HttpClient, token: string, auth: HostedAuth): Promise<Connection | null> {
  const fallback: Connection | null = auth.kind === "oauth"
    ? { permission: auth.permission, autoMode: auth.autoMode, maxOrderCents: null, dailyLimitCents: null, kind: "oauth" }
    : null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CONNECTION_WAIT_MS);
  });
  try {
    return (await Promise.race([loadConnection(http, token), timeout])) ?? fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hosted MCP service as a web-standard fetch handler: POST /mcp (an
 * access token or a vmk_live_ key), the public sandbox, discovery documents,
 * forwards to the authorization server, and /health.
 */
export function createHostedApp(cfg: HostedConfig, deps: HostedDeps = {}): HostedApp {
  const log = deps.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const sandboxes = deps.sandboxes ?? new SandboxStore();
  const sandboxLimiter = deps.sandboxLimiter ?? new RateLimiter();
  const mcpPath = cfg.resourceUrl.pathname;
  const prmUrl = getOAuthProtectedResourceMetadataUrl(cfg.resourceUrl);
  const prmPaths = new Set(["/.well-known/oauth-protected-resource", new URL(prmUrl).pathname]);
  const prm = buildOAuthProtectedResourceMetadata({
    oauthMetadata: {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
      token_endpoint: `${cfg.issuer}/oauth/token`,
      response_types_supported: ["code"],
    },
    resourceServerUrl: cfg.resourceUrl,
    resourceName: "VoidMob",
    serviceDocumentationUrl: new URL("https://voidmob.com/mcp"),
  });

  const gate = requireBearerAuth({
    verifier: createTokenVerifier({
      issuer: cfg.issuer,
      audience: cfg.resourceUrl.href,
      jwks: deps.jwks ?? remoteJwks(cfg.jwksUrl, remoteUserAgent()),
    }),
    resourceMetadataUrl: prmUrl,
    expectedResource: cfg.resourceUrl,
  });

  // One server per request, built from the caller's own credential: its
  // calls reach the public API with that credential, and its tool list
  // follows the credential's permission. No local controls apply on hosted.
  const mcpFactory: McpServerFactory = async ({ authInfo }) => {
    try {
      if (!authInfo) throw new Error("no credential on an MCP request");
      let server: McpServer | undefined;
      const http = createHttpClient({
        apiKey: authInfo.token,
        baseUrl: cfg.apiBaseUrl,
        debug: false,
        // Filled from initialize (2025) or the request's envelope (2026-07-28).
        userAgent: () => remoteUserAgent(server?.server.getClientVersion()?.name),
      });
      const connection = await hostedConnection(http, authInfo.token, hostedAuthOf(authInfo));
      server = createVoidmobServer(http, DEFAULT_CONTROLS, connection, { hosted: true });
      return server;
    } catch (e) {
      log(`[voidmob-mcp] could not build the MCP server: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      throw e;
    }
  };

  const sandboxFactory: McpServerFactory = ({ requestInfo }) => {
    if (!requestInfo) throw new Error("no request on a sandbox request");
    return createVoidmobServer(sandboxes.get(sandboxKey(requestInfo)), DEFAULT_CONTROLS, null, { hosted: true });
  };

  // Stateless: 2025-era clients are served per request (legacy: "stateless"),
  // 2026-07-28 clients natively.
  const mcp = createMcpHandler(mcpFactory, { legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES, maxSubscriptions: 256 });
  const sandbox = createMcpHandler(sandboxFactory, { legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES, maxSubscriptions: 32 });

  async function route(request: Request, note: RequestNote): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health checks come from inside the container, by IP.
    if (path === "/health") {
      note.route = "/health";
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      return json(200, { ok: true, version: VERSION });
    }

    const badHost = hostHeaderValidationResponse(request, cfg.allowedHosts);
    if (badHost) {
      note.route = "bad-host";
      return badHost;
    }

    if (prmPaths.has(path)) {
      note.route = path;
      return metadataResponse(request, prm);
    }

    if (path === "/.well-known/oauth-authorization-server") {
      note.route = path;
      // Proxied rather than redirected, so clients that do not follow a
      // redirect for metadata still find the authorization server.
      if (request.method === "GET" || request.method === "HEAD") {
        return forward(request, `${cfg.issuer}/.well-known/oauth-authorization-server`, true);
      }
      return metadataResponse(request, null);
    }

    // Clients that send the OAuth steps to the MCP host instead of the
    // authorization server's endpoints.
    if (path === "/authorize") {
      note.route = path;
      if (request.method !== "GET") return methodNotAllowed("GET");
      return new Response(null, { status: 302, headers: { Location: `${cfg.issuer}/oauth/authorize${url.search}`, "Cache-Control": "no-store" } });
    }
    if (path === "/token" || path === "/register") {
      note.route = path;
      if (request.method !== "POST") return methodNotAllowed("POST");
      return forward(request, `${cfg.issuer}/oauth${path}`);
    }

    if (path === mcpPath) {
      note.route = mcpPath;
      const badOrigin = originValidationResponse(request, cfg.allowedOrigins);
      if (badOrigin) return badOrigin;
      const auth = await gate(request);
      if (auth instanceof Response) {
        note.auth = "none";
        return auth;
      }
      note.auth = hostedAuthOf(auth).kind;
      return mcp.fetch(request, { authInfo: auth });
    }

    const sandboxMatch = SANDBOX_PATH.exec(path);
    if (sandboxMatch) {
      note.route = sandboxMatch[1] ? "/sandbox/:token" : "/sandbox";
      note.auth = "sandbox";
      const badOrigin = originValidationResponse(request, cfg.allowedOrigins);
      if (badOrigin) return badOrigin;
      const wait = sandboxLimiter.hit(clientIp(request));
      if (wait > 0) {
        return json(
          429,
          { jsonrpc: "2.0", error: { code: -32000, message: `Too many sandbox requests from this address. Wait ${wait}s.` }, id: null },
          { "Retry-After": String(wait) },
        );
      }
      return sandbox.fetch(request);
    }

    note.route = "other";
    return json(404, { error: "not_found" });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const started = performance.now();
      const note: RequestNote = { route: "-", auth: "-" };
      let response: Response;
      try {
        response = await route(request, note);
      } catch (e) {
        note.error = e instanceof Error ? e.name : "Error";
        response = json(500, { error: "server_error" });
      }
      // Signal only: one line per request, never a token, header value or body.
      if (!(note.route === "/health" && response.ok)) {
        log(
          `[voidmob-mcp] ${request.method} ${note.route} ${response.status} ${Math.round(performance.now() - started)}ms ` +
          `proto=${protocolVersion(request)} auth=${note.auth}${note.error ? ` error=${note.error}` : ""}`,
        );
      }
      return response;
    },
    async close() {
      await Promise.all([mcp.close(), sandbox.close()]);
    },
  };
}

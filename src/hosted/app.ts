import {
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type McpServer,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import { createHttpClient, HttpError, type HttpClient } from "../client/http.js";
import { DEFAULT_CONTROLS } from "../config.js";
import { loadConnection, type Connection } from "../connection.js";
import { createSandboxHttpClient } from "../sandbox/mock-http.js";
import { createVoidmobServer, VERSION } from "../server.js";
import { createTokenVerifier, hostedAuthOf, remoteJwks, type HostedAuth } from "./auth.js";
import { MAX_BODY_BYTES, type HostedConfig } from "./config.js";
import { ExpiringSet, RateLimiter, Slots } from "./limits.js";
import { SandboxStore } from "./sandbox.js";

/** How long a request waits for the credential's settings before using its claims (or the defaults). */
const CONNECTION_WAIT_MS = 5_000;
const FORWARD_TIMEOUT_MS = 10_000;
/** A sandbox path token: 16 to 128 URL-safe characters, so tokens are hard to guess. */
const SANDBOX_PATH = /^\/sandbox(?:\/([A-Za-z0-9_-]{16,128}))?$/;

/** JSON-RPC messages per minute for one sandbox path token. */
export const SANDBOX_MESSAGES_PER_MINUTE = 60;
/** JSON-RPC messages per minute from one IP, on /mcp and (separately) on /sandbox. */
export const IP_MESSAGES_PER_MINUTE = 600;
/** Open subscriptions/listen streams per credential on /mcp and per IP on /sandbox. */
export const LISTEN_STREAMS_PER_CALLER = 4;
/** How long a credential the API refused is answered 401 without asking the API again. */
export const REFUSED_CREDENTIAL_TTL_MS = 30_000;

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
  /** Per sandbox path token. */
  sandboxLimiter?: RateLimiter;
  /** Per IP across /sandbox. */
  sandboxIpLimiter?: RateLimiter;
  /** Per IP across /mcp. */
  mcpIpLimiter?: RateLimiter;
  /** Credential hashes the API refused, answered 401 without another /v1/me. */
  refusedCredentials?: ExpiringSet;
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

/** The path token of a persistent sandbox, or undefined on bare /sandbox. */
function sandboxToken(request: Request): string | undefined {
  return SANDBOX_PATH.exec(new URL(request.url).pathname)?.[1];
}

const credentialHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** What the limits need from a POST body: its JSON-RPC message count, and the listen request in it. */
interface BodyShape {
  messages: number;
  /** The id of a subscriptions/listen request, when the body is one. */
  listenId?: string | number;
}

// The body is at most 64 KB (toNodeHandler refuses more before this runs);
// the handler reads it again from the untouched request.
async function bodyShape(request: Request): Promise<BodyShape> {
  if (request.method !== "POST") return { messages: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.clone().text());
  } catch {
    return { messages: 1 };
  }
  if (Array.isArray(parsed)) return { messages: Math.max(1, parsed.length) };
  const message = parsed as { method?: unknown; id?: unknown } | null;
  if (message?.method === "subscriptions/listen" && (typeof message.id === "string" || typeof message.id === "number")) {
    return { messages: 1, listenId: message.id };
  }
  return { messages: 1 };
}

const tooManyRequests = (wait: number): Response =>
  json(
    429,
    { jsonrpc: "2.0", error: { code: -32000, message: `Too many requests. Wait ${wait}s.` }, id: null },
    { "Retry-After": String(wait) },
  );

// Refused in band before the stream opens, the way the SDK refuses past its
// own global cap.
const listenRefused = (id: string | number): Response =>
  json(200, { jsonrpc: "2.0", id, error: { code: -32603, message: "Subscription limit reached" } });

/** Serves the request, holding the listen slot (if any) until its response is done. */
async function holdSlot(release: (() => void) | undefined, request: Request, serve: () => Promise<Response>): Promise<Response> {
  if (!release) return serve();
  let response: Response;
  try {
    response = await serve();
  } catch (e) {
    release();
    throw e;
  }
  return releaseWhenDone(response, request, release);
}

/** Holds a listen slot for as long as the response streams; released when it ends, fails or is cancelled. */
function releaseWhenDone(response: Response, request: Request, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  request.signal.addEventListener("abort", release, { once: true });
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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

/** The verified credential plus its settings, as the MCP factory receives them in AuthInfo.extra. */
type McpAuth = HostedAuth & { connection: Connection | null };

/**
 * The credential's settings from /v1/me (fresher than the token's claims, and
 * they carry the limits), or "revoked" when the API no longer accepts the
 * credential. When /v1/me fails otherwise (network, timeout, 5xx) or is slow,
 * an access token falls back to its claims and an API key to the defaults:
 * the API enforces the real settings on every call either way.
 */
async function hostedConnection(http: HttpClient, token: string, auth: HostedAuth): Promise<Connection | null | "revoked"> {
  const fallback: Connection | null = auth.kind === "oauth"
    ? { permission: auth.permission, autoMode: auth.autoMode, maxOrderCents: null, dailyLimitCents: null, kind: "oauth" }
    : null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), CONNECTION_WAIT_MS);
  });
  try {
    return (await Promise.race([loadConnection(http, token), timeout])) ?? fallback;
  } catch (e) {
    // Disconnected, expired or revoked: the app should sign in again now
    // (the caller remembers the refusal for a short while).
    if (e instanceof HttpError && e.status === 401 && e.code === "UNAUTHENTICATED") return "revoked";
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
  const sandboxLimiter = deps.sandboxLimiter ?? new RateLimiter(SANDBOX_MESSAGES_PER_MINUTE);
  const sandboxIpLimiter = deps.sandboxIpLimiter ?? new RateLimiter(IP_MESSAGES_PER_MINUTE);
  const mcpIpLimiter = deps.mcpIpLimiter ?? new RateLimiter(IP_MESSAGES_PER_MINUTE);
  const refused = deps.refusedCredentials ?? new ExpiringSet(REFUSED_CREDENTIAL_TTL_MS);
  const mcpListens = new Slots(LISTEN_STREAMS_PER_CALLER);
  const sandboxListens = new Slots(LISTEN_STREAMS_PER_CALLER);
  const refusedChallenge = () =>
    bearerAuthChallengeResponse(
      new OAuthError(OAuthErrorCode.InvalidToken, "This token is no longer accepted; sign in again"),
      { resourceMetadataUrl: prmUrl },
    );
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
      const { connection } = authInfo.extra as unknown as McpAuth;
      server = createVoidmobServer(http, DEFAULT_CONTROLS, connection, { hosted: true });
      return server;
    } catch (e) {
      log(`[voidmob-mcp] could not build the MCP server: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      throw e;
    }
  };

  // Bare /sandbox keeps nothing: every request starts from fresh demo data,
  // so callers behind one address never see each other's orders. A path
  // token is a persistent playground, kept for an hour idle.
  const playgroundUrl = `${cfg.resourceUrl.origin}/sandbox/<any-random-id>`;
  const sandboxFactory: McpServerFactory = ({ requestInfo }) => {
    if (!requestInfo) throw new Error("no request on a sandbox request");
    const token = sandboxToken(requestInfo);
    return token
      ? createVoidmobServer(sandboxes.get(token), DEFAULT_CONTROLS, null, { hosted: true })
      : createVoidmobServer(createSandboxHttpClient(), DEFAULT_CONTROLS, null, { hosted: true, statelessSandbox: { playgroundUrl } });
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
      // Counted per JSON-RPC message, before any token check, so a flood of
      // made-up keys cannot reach the API.
      const shape = await bodyShape(request);
      const wait = mcpIpLimiter.hit(clientIp(request), shape.messages);
      if (wait > 0) return tooManyRequests(wait);
      const auth = await gate(request);
      if (auth instanceof Response) {
        note.auth = "none";
        return auth;
      }
      const hosted = hostedAuthOf(auth);
      note.auth = hosted.kind;
      const credential = credentialHash(auth.token);
      if (refused.has(credential)) return refusedChallenge();
      const connection = await hostedConnection(
        createHttpClient({ apiKey: auth.token, baseUrl: cfg.apiBaseUrl, debug: false, userAgent: remoteUserAgent() }),
        auth.token,
        hosted,
      );
      if (connection === "revoked") {
        refused.add(credential);
        return refusedChallenge();
      }
      const release = shape.listenId !== undefined ? mcpListens.take(credential) : undefined;
      if (release === null) return listenRefused(shape.listenId!);
      const extra: McpAuth = { ...hosted, connection };
      return holdSlot(release, request, () => mcp.fetch(request, { authInfo: { ...auth, extra: extra as unknown as Record<string, unknown> } }));
    }

    if (path === "/sandbox" || path.startsWith("/sandbox/")) {
      const sandboxMatch = SANDBOX_PATH.exec(path);
      note.route = path === "/sandbox" ? "/sandbox" : "/sandbox/:token";
      note.auth = "sandbox";
      if (!sandboxMatch) return json(404, { error: "not_found" });
      const badOrigin = originValidationResponse(request, cfg.allowedOrigins);
      if (badOrigin) return badOrigin;
      const ip = clientIp(request);
      const shape = await bodyShape(request);
      // A playground is limited per token; every sandbox request counts
      // toward its IP's ceiling (bare /sandbox has only the ceiling: it holds
      // no state, and many users can share one egress address).
      const token = sandboxToken(request);
      const wait = (token ? sandboxLimiter.hit(token, shape.messages) : 0) || sandboxIpLimiter.hit(ip, shape.messages);
      if (wait > 0) return tooManyRequests(wait);
      const release = shape.listenId !== undefined ? sandboxListens.take(ip) : undefined;
      if (release === null) return listenRefused(shape.listenId!);
      return holdSlot(release, request, () => sandbox.fetch(request));
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

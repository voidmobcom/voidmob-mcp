// The hosted HTTP service, in process: the bearer gate (access tokens against
// a local key set, vmk_live_ keys passed through), discovery documents,
// OAuth forwards, the sandbox, Host/Origin checks and logs. MCP traffic runs
// on both protocol eras: a 2025 client (served by the stateless legacy leg)
// and a 2026-07-28 client negotiating in auto mode.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { createHostedApp, remoteUserAgent, type HostedDeps } from "../../src/hosted/app.js";
import { MAX_BODY_BYTES, parseHostedEnv } from "../../src/hosted/config.js";
import { RateLimiter, SandboxStore } from "../../src/hosted/sandbox.js";
import { HOSTED_MAX_TOOL_INPUT_ELEMENTS, VERSION } from "../../src/server.js";

const ORIGIN = "https://mcp.voidmob.com";
const MCP_URL = `${ORIGIN}/mcp`;
const ISSUER = "https://dashboard.voidmob.com";
const PRM_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const API = "https://dashboard.voidmob.com/api";

let signingKey: CryptoKey;
let strangerKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey;
  strangerKey = (await generateKeyPair("ES256")).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface TokenOpts {
  aud?: string;
  iss?: string;
  perm?: unknown;
  auto?: unknown;
  key?: CryptoKey;
  exp?: number;
  sub?: string | null;
}

// Unique per call (jti and cid), so the 60 s /v1/me cache never carries over between tests.
let seq = 0;
async function accessToken(o: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ cid: `key_conn_${++seq}`, perm: o.perm ?? "buy", auto: o.auto ?? false })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? MCP_URL)
    .setIssuedAt(now)
    .setExpirationTime(o.exp ?? now + 3600)
    .setJti(`jti_${seq}`);
  if (o.sub !== null) jwt.setSubject(o.sub ?? "usr_1");
  return jwt.sign(o.key ?? signingKey);
}

const freshKey = () => `vmk_live_${String(++seq).padStart(6, "0")}${"h".repeat(26)}`;

const meKey = (over: Record<string, unknown> = {}) => ({
  id: "key_1", kind: "key", name: "agent", permission: "buy", max_order_cents: null,
  daily_limit_cents: null, spent_24h_cents: 0, auto_mode: false, ...over,
});

interface Upstream {
  calls: Array<{ url: string; method: string; auth: string | null; ua: string | null; contentType: string | null; body: string }>;
}

/**
 * Stubs the network: /v1/me answers with `me` (or fails with `meStatus`), the
 * OAuth endpoints answer with `oauth`. Everything else is a 404.
 */
function stubUpstream(opts: {
  me?: Record<string, unknown>;
  meStatus?: number;
  /** Answer /v1/me without the API's error envelope (a gateway, not the API). */
  meBare?: boolean;
  oauth?: (url: string) => Response | Promise<Response>;
} = {}): Upstream {
  const up: Upstream = { calls: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? Buffer.from(init.body as ArrayBuffer).toString("utf8") : "";
    up.calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), ua: headers.get("user-agent"), contentType: headers.get("content-type"), body });
    if (url.startsWith(`${API}/v1/me`)) {
      if (opts.meStatus) {
        if (opts.meBare) return new Response("<html>gateway</html>", { status: opts.meStatus });
        const code = opts.meStatus === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR";
        return Response.json({ success: false, error: { code, message: "x", request_id: "req_1" } }, { status: opts.meStatus });
      }
      return Response.json({
        success: true,
        data: {
          id: "usr_1",
          balance: { amount_cents: 1000, currency: "USD", formatted: "$10.00" },
          rate_limits: {},
          key: meKey(opts.me),
          deposit_url: "https://dashboard.voidmob.com/wallet",
          created_at: "2026-01-01T00:00:00Z",
        },
      });
    }
    if (url.startsWith(ISSUER) && opts.oauth) return opts.oauth(url);
    return new Response("not found", { status: 404 });
  });
  return up;
}

function makeApp(env: Record<string, string> = {}, deps: Partial<HostedDeps> = {}) {
  const lines: string[] = [];
  const app = createHostedApp(parseHostedEnv(env), { jwks, log: (l) => lines.push(l), ...deps });
  return { app, lines };
}

/** A request as it reaches the app through the tunnel: Host is the public name. */
function req(path: string, init: RequestInit & { host?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", init.host ?? "mcp.voidmob.com");
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

const initialize = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
});

const mcpPost = (token: string | null, extra: Record<string, string> = {}) =>
  req("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: initialize,
  });

type Era = "legacy" | "modern";

/** An MCP client of either era talking to the app in process. */
async function connectClient(app: { fetch(r: Request): Promise<Response> }, era: Era, path: string, token?: string, name = "Claude"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" }, era === "modern" ? { versionNegotiation: { mode: "auto" } } : {});
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}${path}`), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "mcp.voidmob.com");
      headers.set("cf-connecting-ip", "203.0.113.7");
      if (token) headers.set("authorization", `Bearer ${token}`);
      return app.fetch(new Request(url, { ...init, headers }));
    },
  });
  await client.connect(transport);
  const negotiated = client.getNegotiatedProtocolVersion();
  if (era === "modern") expect(negotiated).toBe("2026-07-28");
  else expect(negotiated).not.toBe("2026-07-28");
  return client;
}

const toolCount = async (client: Client) => (await client.listTools()).tools.length;
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text?: string }>)[0]?.text ?? "";

describe("GET /health", () => {
  it("answers ok and the version, with no upstream call, from any Host", async () => {
    const up = stubUpstream();
    const { app, lines } = makeApp();
    const res = await app.fetch(req("/health", { host: "10.0.0.5:8080" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
    expect(up.calls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
});

describe("discovery", () => {
  it("serves the protected-resource metadata at both well-known paths", async () => {
    const { app } = makeApp();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app.fetch(req(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toMatchObject({ resource: MCP_URL, authorization_servers: [ISSUER] });
    }
  });

  it("proxies the authorization server metadata from the dashboard", async () => {
    const meta = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize` };
    const up = stubUpstream({ oauth: () => Response.json(meta) });
    const { app } = makeApp();
    const res = await app.fetch(req("/.well-known/oauth-authorization-server"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(meta);
    expect(up.calls.map((c) => c.url)).toEqual([`${ISSUER}/.well-known/oauth-authorization-server`]);
  });
});

describe("POST /mcp authentication", () => {
  it("no token: 401 with the resource metadata challenge", async () => {
    const { app } = makeApp();
    const res = await app.fetch(mcpPost(null));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM_URL}"`);
  });

  it("refuses a wrong audience, an expired token, an unknown signing key, a wrong issuer and bad claims", async () => {
    stubUpstream();
    const { app } = makeApp();
    const now = Math.floor(Date.now() / 1000);
    const bad = {
      audience: await accessToken({ aud: "https://mcp.voidmob.com/other" }),
      audiencePlusSlashPath: await accessToken({ aud: `${ORIGIN}/` }),
      expired: await accessToken({ exp: now - 10 }),
      unknownKey: await accessToken({ key: strangerKey }),
      issuer: await accessToken({ iss: "https://evil.example" }),
      perm: await accessToken({ perm: "admin" }),
      auto: await accessToken({ auto: "yes" }),
      noSubject: await accessToken({ sub: null }),
      garbage: "not-a-token",
      shortKey: "vmk_live_short",
    };
    for (const [name, token] of Object.entries(bad)) {
      const res = await app.fetch(mcpPost(token));
      expect(res.status, name).toBe(401);
      expect(res.headers.get("www-authenticate"), name).toContain(`resource_metadata="${PRM_URL}"`);
    }
  });

  it("a credential the API no longer accepts gets a 401 challenge at once, and the refusal is not cached", async () => {
    stubUpstream({ meStatus: 401 });
    const { app, lines } = makeApp();
    const token = await accessToken();
    const key = freshKey();
    for (const credential of [token, key]) {
      const res = await app.fetch(mcpPost(credential));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM_URL}"`);
    }
    expect(lines.filter((l) => /POST \/mcp 401 .* auth=(oauth|key)/.test(l))).toHaveLength(2);

    stubUpstream({ me: { kind: "oauth" } });
    expect((await app.fetch(mcpPost(token))).status).toBe(200);
  });

  it("a 401 without the API's envelope (a gateway) falls back to the claims", async () => {
    stubUpstream({ meStatus: 401, meBare: true });
    const { app } = makeApp();
    expect((await app.fetch(mcpPost(await accessToken()))).status).toBe(200);
  });

  it("answers 500, not 401, when the signing keys cannot be read", async () => {
    const unavailable: JWTVerifyGetKey = async () => {
      throw new errors.JWKSTimeout();
    };
    const { app } = makeApp({}, { jwks: unavailable });
    const res = await app.fetch(mcpPost(await accessToken()));
    expect(res.status).toBe(500);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("refuses a browser Origin unless it is allowed; a request without Origin passes", async () => {
    const { app } = makeApp({ MCP_ALLOWED_ORIGINS: "inspector.example" });
    expect((await app.fetch(mcpPost(null, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await app.fetch(mcpPost(null, { origin: "https://inspector.example" }))).status).toBe(401);
    expect((await app.fetch(mcpPost(null))).status).toBe(401);
  });

  it("refuses a Host other than the public name (or MCP_ALLOWED_HOSTS)", async () => {
    const { app } = makeApp({ MCP_ALLOWED_HOSTS: "localhost" });
    expect((await app.fetch(req("/mcp", { method: "POST", host: "evil.example" }))).status).toBe(403);
    expect((await app.fetch(req("/.well-known/oauth-protected-resource", { host: "evil.example" }))).status).toBe(403);
    expect((await app.fetch(req("/mcp", { method: "POST", host: "localhost:8080" }))).status).toBe(401);
  });
});

describe.each<Era>(["legacy", "modern"])("MCP over HTTP (%s era)", (era) => {
  it("a vmk_live_ key passes through: /v1/me sets the tool list, calls carry the key and the remote User-Agent", async () => {
    const up = stubUpstream({ me: { permission: "view" } });
    const { app, lines } = makeApp();
    const key = freshKey();
    const client = await connectClient(app, era, "/mcp", key);
    expect(await toolCount(client)).toBe(10);
    const acct = await client.callTool({ name: "get_account", arguments: {} });
    expect(acct.isError ?? false).toBe(false);
    const me = up.calls.filter((c) => c.url === `${API}/v1/me`);
    expect(me.length).toBeGreaterThan(0);
    for (const c of me) {
      expect(c.auth).toBe(`Bearer ${key}`);
      expect(c.ua?.startsWith(`voidmob-mcp/${VERSION}+remote`)).toBe(true);
    }
    // The client's name reaches the API once the server knows it (the
    // 2026-07-28 envelope carries it on every request).
    if (era === "modern") expect(me.some((c) => c.ua === `voidmob-mcp/${VERSION}+remote (Claude)`)).toBe(true);
    // Signal-only logs: a line per request, never the credential.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(key);
      expect(line).not.toMatch(/bearer/i);
    }
    expect(lines.some((l) => /POST \/mcp 200 .* auth=key/.test(l))).toBe(true);
    await client.close();
  });

  it("an access token: /v1/me is fresher than the claims", async () => {
    stubUpstream({ me: { kind: "oauth", permission: "manage" } });
    const { app } = makeApp();
    const client = await connectClient(app, era, "/mcp", await accessToken({ perm: "buy" }));
    expect(await toolCount(client)).toBe(17);
    expect(client.getInstructions()).toContain("/account/connected-apps");
    await client.close();
  });

  it("an access token: when /v1/me fails, the claims decide the tool list", async () => {
    stubUpstream({ meStatus: 500 });
    const { app } = makeApp();
    const client = await connectClient(app, era, "/mcp", await accessToken({ perm: "view" }));
    expect(await toolCount(client)).toBe(10);
    expect(client.getInstructions()).toContain("View access");
    await client.close();
  });

  it("caps wait_seconds at 60 and refuses oversized tool arguments", async () => {
    stubUpstream({ me: {} });
    const { app } = makeApp();
    const client = await connectClient(app, era, "/mcp", freshKey());
    const getRental = (await client.listTools()).tools.find((t) => t.name === "get_rental")!;
    const wait = (getRental.inputSchema.properties as Record<string, { maximum?: number; description?: string }>).wait_seconds;
    expect(wait.maximum).toBe(60);
    expect(getRental.description).toContain("up to 60");
    const junk = Object.fromEntries(Array.from({ length: HOSTED_MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => [`x${i}`, i]));
    const outcome = await client.callTool({ name: "get_account", arguments: junk }).then(
      (r) => (r.isError ? text(r) : "accepted"),
      (e: Error) => e.message,
    );
    expect(outcome).toContain(`maximum of ${HOSTED_MAX_TOOL_INPUT_ELEMENTS}`);
    await client.close();
  });

  it("sandbox state persists across requests for the same address, and a path token gets its own", async () => {
    const up = stubUpstream();
    const { app } = makeApp();
    const first = await connectClient(app, era, "/sandbox");
    const bought = await first.callTool({ name: "rent_number", arguments: { service_id: "svc_telegram", max_price_cents: 150 } });
    expect(bought.isError ?? false).toBe(false);
    await first.close();

    const balance = async (client: Client) =>
      (((await client.callTool({ name: "get_account", arguments: {} })).structuredContent as Record<string, any>).account.balance.amount_cents);
    const again = await connectClient(app, era, "/sandbox");
    expect(await balance(again)).toBe(50_000 - 150);
    await again.close();

    const own = await connectClient(app, era, `/sandbox/demo-${era}`);
    expect(await balance(own)).toBe(50_000);
    await own.close();
    expect(up.calls).toHaveLength(0);
  });
});

describe("sandbox limits", () => {
  it("rate-limits per client IP, path token or not", async () => {
    const { app, lines } = makeApp({}, { sandboxLimiter: new RateLimiter(2), sandboxes: new SandboxStore() });
    const post = (path: string) =>
      app.fetch(req(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "198.51.100.9" },
        body: initialize,
      }));
    expect((await post("/sandbox")).status).toBe(200);
    expect((await post("/sandbox/abc")).status).toBe(200);
    const limited = await post("/sandbox/def");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // The path token never reaches the log.
    expect(lines.join("\n")).not.toContain("abc");
    expect(lines.some((l) => l.includes("/sandbox/:token 429"))).toBe(true);
  });
});

describe("OAuth forwards", () => {
  it("GET /authorize redirects to the dashboard with the same query", async () => {
    const { app } = makeApp();
    const query = "?response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=x&code_challenge_method=S256&state=s";
    const res = await app.fetch(req(`/authorize${query}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ISSUER}/oauth/authorize${query}`);
  });

  it("POST /token and /register pass body, content type and client auth through, and return the upstream answer", async () => {
    const up = stubUpstream({
      oauth: (url) => url.endsWith("/oauth/token")
        ? Response.json({ error: "invalid_grant" }, { status: 400, headers: { "www-authenticate": "Basic" } })
        : Response.json({ client_id: "c_new" }, { status: 201 }),
    });
    const { app, lines } = makeApp();
    const form = "grant_type=authorization_code&code=secret-code&code_verifier=v";
    const token = await app.fetch(req("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic YzE6cw==" },
      body: form,
    }));
    expect(token.status).toBe(400);
    expect(token.headers.get("content-type")).toContain("application/json");
    expect(token.headers.get("cache-control")).toBe("no-store");
    expect(token.headers.get("www-authenticate")).toBe("Basic");
    expect(await token.json()).toEqual({ error: "invalid_grant" });

    const reg = await app.fetch(req("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }),
    }));
    expect(reg.status).toBe(201);
    expect(await reg.json()).toEqual({ client_id: "c_new" });

    expect(up.calls.map((c) => [c.method, c.url, c.contentType])).toEqual([
      ["POST", `${ISSUER}/oauth/token`, "application/x-www-form-urlencoded"],
      ["POST", `${ISSUER}/oauth/register`, "application/json"],
    ]);
    expect(up.calls[0].body).toBe(form);
    expect(up.calls[0].auth).toBe("Basic YzE6cw==");
    expect(lines.join("\n")).not.toContain("secret-code");
  });

  it("answers 503 when the dashboard cannot be reached, and 405 for the wrong method", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { app } = makeApp();
    const res = await app.fetch(req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" }));
    expect(res.status).toBe(503);
    expect((await app.fetch(req("/token"))).status).toBe(405);
    expect((await app.fetch(req("/authorize", { method: "POST" }))).status).toBe(405);
  });
});

describe("over node:http (toNodeHandler)", () => {
  let server: Server;
  let port: number;

  const start = async () => {
    const { app } = makeApp({ MCP_ALLOWED_HOSTS: "127.0.0.1" });
    server = createServer(toNodeHandler(app, { maxRequestBodySize: MAX_BODY_BYTES }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));

  const raw = (path: string, opts: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest({
        host: "127.0.0.1", port, path, method: opts.method ?? "GET",
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
      }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on("error", reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });

  it("serves /health, refuses a bad Host and a body over 64 KB", async () => {
    await start();
    try {
      expect((await raw("/health")).status).toBe(200);
      expect((await raw("/.well-known/oauth-protected-resource/mcp", { host: "evil.example" })).status).toBe(403);
      const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MAX_BODY_BYTES) } });
      const over = await raw("/sandbox", {
        method: "POST",
        body: big,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(Buffer.byteLength(big)) },
      });
      expect(over.status).toBe(413);
      const ok = await raw("/sandbox", {
        method: "POST",
        body: initialize,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      });
      expect(ok.status).toBe(200);
    } finally {
      await stop();
    }
  });
});

describe("remoteUserAgent", () => {
  it("keeps the voidmob-mcp/ prefix and a cleaned, capped client name", () => {
    expect(remoteUserAgent()).toBe(`voidmob-mcp/${VERSION}+remote`);
    expect(remoteUserAgent("Visual Studio Code")).toBe(`voidmob-mcp/${VERSION}+remote (Visual Studio Code)`);
    expect(remoteUserAgent("evil)\r\nX-Injected: 1 (")).toBe(`voidmob-mcp/${VERSION}+remote (evilX-Injected: 1)`);
    expect(remoteUserAgent("()")).toBe(`voidmob-mcp/${VERSION}+remote`);
    expect(remoteUserAgent("a".repeat(200))).toBe(`voidmob-mcp/${VERSION}+remote (${"a".repeat(48)})`);
    expect(remoteUserAgent(42)).toBe(`voidmob-mcp/${VERSION}+remote`);
  });
});

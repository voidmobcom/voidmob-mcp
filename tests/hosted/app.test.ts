// The hosted HTTP service, in process: the bearer gate (access tokens against
// a local key set, vmk_live_ keys passed through), discovery documents,
// OAuth forwards, the sandbox, Host/Origin checks and logs. MCP traffic runs
// on both protocol eras: a 2025 client (served by the stateless legacy leg)
// and a 2026-07-28 client negotiating in auto mode.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { createHostedApp, LISTEN_STREAMS_PER_CALLER, remoteUserAgent, type HostedDeps } from "../../src/hosted/app.js";
import { MAX_BODY_BYTES, parseHostedEnv } from "../../src/hosted/config.js";
import { RateLimiter } from "../../src/hosted/limits.js";
import { serveHosted, SHUTDOWN_GRACE_MS, type RunningServer } from "../../src/hosted/serve.js";
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
  calls: Array<{ url: string; method: string; auth: string | null; ua: string | null; contentType: string | null; body: string; headerNames: string[] }>;
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
    up.calls.push({
      url, method: init?.method ?? "GET", auth: headers.get("authorization"), ua: headers.get("user-agent"),
      contentType: headers.get("content-type"), body, headerNames: [...headers.keys()],
    });
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
const balance = async (client: Client): Promise<number> =>
  ((await client.callTool({ name: "get_account", arguments: {} })).structuredContent as Record<string, any>).account.balance.amount_cents;
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

  it("a credential the API no longer accepts gets a 401 challenge at once, and the refusal is remembered", async () => {
    const up = stubUpstream({ meStatus: 401 });
    const { app, lines } = makeApp();
    const token = await accessToken();
    const key = freshKey();
    for (const credential of [token, key]) {
      const res = await app.fetch(mcpPost(credential));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${PRM_URL}"`);
    }
    expect(lines.filter((l) => /POST \/mcp 401 .* auth=(oauth|key)/.test(l))).toHaveLength(2);

    // The same credentials again: refused without asking the API.
    const meCalls = () => up.calls.filter((c) => c.url === `${API}/v1/me`).length;
    const asked = meCalls();
    for (const credential of [token, key]) expect((await app.fetch(mcpPost(credential))).status).toBe(401);
    expect(meCalls()).toBe(asked);

    // A new token, after signing in again, is read fresh.
    stubUpstream({ me: { kind: "oauth" } });
    expect((await app.fetch(mcpPost(await accessToken()))).status).toBe(200);
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
    expect(await toolCount(client)).toBe(11);
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
    expect(await toolCount(client)).toBe(20);
    expect(client.getInstructions()).toContain("/account/connected-apps");
    await client.close();
  });

  it("an access token: when /v1/me fails, the claims decide the tool list", async () => {
    stubUpstream({ meStatus: 500 });
    const { app } = makeApp();
    const client = await connectClient(app, era, "/mcp", await accessToken({ perm: "view" }));
    expect(await toolCount(client)).toBe(11);
    expect(client.getInstructions()).toContain("View access");
    await client.close();
  });

  it("an access token's auto claim alone (no daily limit known) does not turn auto-mode on", async () => {
    stubUpstream({ meStatus: 500 });
    const { app } = makeApp();
    const client = await connectClient(app, era, "/mcp", await accessToken({ perm: "buy", auto: true }));
    expect(client.getInstructions()).not.toContain("Auto-mode is on");
    expect(client.getInstructions()).toContain("get their go-ahead");
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

  it("a sandbox path token keeps its state across requests; another token has its own", async () => {
    const up = stubUpstream();
    const { app } = makeApp();
    const playground = `/sandbox/demo-${era}-0123456789`;
    const first = await connectClient(app, era, playground);
    const bought = await first.callTool({ name: "rent_number", arguments: { service_id: "svc_telegram", max_price_cents: 150 } });
    expect(bought.isError ?? false).toBe(false);
    expect(first.getInstructions()).not.toContain("keeps no state");
    await first.close();

    const again = await connectClient(app, era, playground);
    expect(await balance(again)).toBe(50_000 - 150);
    await again.close();

    const other = await connectClient(app, era, `/sandbox/other-${era}-0123456789`);
    expect(await balance(other)).toBe(50_000);
    await other.close();
    expect(up.calls).toHaveLength(0);
  });

  it("bare /sandbox keeps nothing between requests, even from one address, and says so", async () => {
    const { app } = makeApp();
    const client = await connectClient(app, era, "/sandbox");
    expect(client.getInstructions()).toContain("This sandbox keeps no state between calls");
    expect(client.getInstructions()).toContain("https://mcp.voidmob.com/sandbox/<any-random-id>");
    const bought = await client.callTool({ name: "rent_number", arguments: { service_id: "svc_telegram", max_price_cents: 150 } });
    expect(bought.isError ?? false).toBe(false);
    expect(await balance(client)).toBe(50_000);
    // A deposit made in one call is gone in the next: the lookup says where state is kept.
    const created = await client.callTool({ name: "create_deposit", arguments: { coin: "ltc", amount_cents: 1000 } });
    expect(created.isError ?? false).toBe(false);
    const id = (created.structuredContent as { deposit: { id: string } }).deposit.id;
    const lookup = await client.callTool({ name: "get_deposit", arguments: { deposit_id: id } });
    expect(lookup.isError).toBe(true);
    expect(text(lookup)).toContain(`No deposit ${id} was found`);
    expect(text(lookup)).toContain("https://mcp.voidmob.com/sandbox/<any-random-id>");
    await client.close();
    const next = await connectClient(app, era, "/sandbox");
    expect(await balance(next)).toBe(50_000);
    await next.close();
  });
});

const pings = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "ping" })));

describe("rate limits", () => {
  const post = (app: { fetch(r: Request): Promise<Response> }, path: string, body = initialize, ip = "198.51.100.9", extra: Record<string, string> = {}) =>
    app.fetch(req(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": ip, ...extra },
      body,
    }));

  it("sandbox: every message of a batch counts, per path token, under a per-IP ceiling (bare /sandbox: the ceiling only)", async () => {
    const { app, lines } = makeApp({}, { sandboxLimiter: new RateLimiter(3), sandboxIpLimiter: new RateLimiter(5) });
    const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(16));
    expect((await post(app, `/sandbox/${a}`, pings(4))).status).toBe(429); // 4 messages, 3 per token
    expect((await post(app, `/sandbox/${a}`, pings(3))).status).not.toBe(429);
    expect((await post(app, `/sandbox/${a}`)).status).toBe(429); // token a is spent
    expect((await post(app, `/sandbox/${b}`)).status).toBe(200); // b has its own; the IP is at 4 of 5
    expect((await post(app, `/sandbox/${b}`)).status).toBe(200);
    const capped = await post(app, `/sandbox/${b}`); // the IP ceiling is spent
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(app, `/sandbox/${c}`, initialize, "198.51.100.10")).status).toBe(200);
    // Bare /sandbox: only the per-IP ceiling.
    expect((await post(app, "/sandbox", pings(5), "198.51.100.11")).status).not.toBe(429);
    expect((await post(app, "/sandbox", initialize, "198.51.100.11")).status).toBe(429);
    // Path tokens never reach the log.
    expect(lines.join("\n")).not.toContain(a);
    expect(lines.some((l) => l.includes("/sandbox/:token 429"))).toBe(true);
  });

  it("sandbox: a path token shorter than 16 URL-safe characters is not found", async () => {
    const { app } = makeApp();
    expect((await post(app, "/sandbox/short-token")).status).toBe(404);
    expect((await post(app, `/sandbox/${"x".repeat(15)}`)).status).toBe(404);
    expect((await post(app, `/sandbox/${"x".repeat(16)}`)).status).toBe(200);
    expect((await post(app, `/sandbox/${"x".repeat(15)}!`)).status).toBe(404);
  });

  it("/mcp: a per-IP ceiling counted per message, before any credential reaches the API", async () => {
    const up = stubUpstream({ me: {} });
    const { app } = makeApp({}, { mcpIpLimiter: new RateLimiter(3) });
    const flood = await post(app, "/mcp", pings(4), "198.51.100.20", { authorization: `Bearer ${freshKey()}` });
    expect(flood.status).toBe(429);
    expect(up.calls).toHaveLength(0);
    expect((await post(app, "/mcp", initialize, "198.51.100.20")).status).toBe(401);
    expect((await post(app, "/mcp", initialize, "198.51.100.21", { authorization: `Bearer ${freshKey()}` })).status).toBe(200);
  });
});

describe("/mcp limits for known credentials", () => {
  const post = (app: { fetch(r: Request): Promise<Response> }, credential?: string) =>
    app.fetch(req("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "198.51.100.30",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: initialize,
    }));

  it("a credential the API accepted is limited per credential, not by its IP's ceiling", async () => {
    stubUpstream({ me: {} });
    const { app } = makeApp({}, { mcpIpLimiter: new RateLimiter(2), mcpCredentialLimiter: new RateLimiter(3) });
    const good = freshKey();
    expect((await post(app, good)).status).toBe(200); // not yet known: the IP's 1 of 2
    for (let i = 0; i < 3; i++) expect((await post(app, good)).status).toBe(200); // known: its own 3
    expect((await post(app, good)).status).toBe(429); // its own limit
    expect((await post(app, freshKey())).status).toBe(200); // unknown: the IP's 2 of 2
    expect((await post(app, freshKey())).status).toBe(429); // the IP ceiling
    expect((await post(app)).status).toBe(429); // no credential: the IP ceiling
  });

  it("a credential whose /v1/me read failed, or that the API refused, stays under the IP ceiling", async () => {
    stubUpstream({ meStatus: 500 });
    const { app } = makeApp({}, { mcpIpLimiter: new RateLimiter(2), mcpCredentialLimiter: new RateLimiter(100) });
    const key = freshKey();
    expect((await post(app, key)).status).toBe(200);
    expect((await post(app, key)).status).toBe(200);
    expect((await post(app, key)).status).toBe(429);

    stubUpstream({ meStatus: 401 });
    const { app: second } = makeApp({}, { mcpIpLimiter: new RateLimiter(2), mcpCredentialLimiter: new RateLimiter(100) });
    const refusedKey = freshKey();
    expect((await post(second, refusedKey)).status).toBe(401); // the IP's 1 of 2
    expect((await post(second, refusedKey)).status).toBe(401); // refused and remembered: the IP's 2 of 2
    expect((await post(second, refusedKey)).status).toBe(429);
  });
});

describe("listen streams (2026-07-28)", () => {
  it(`at most ${LISTEN_STREAMS_PER_CALLER} open per credential on /mcp and per IP on /sandbox; closing one frees its slot`, async () => {
    stubUpstream({ me: {} });
    const { app } = makeApp();
    for (const [path, token] of [["/mcp", freshKey()], [`/sandbox/${"l".repeat(16)}`, undefined]] as const) {
      const client = await connectClient(app, "modern", path, token);
      const subs = [];
      for (let i = 0; i < LISTEN_STREAMS_PER_CALLER; i++) subs.push(await client.listen({ toolsListChanged: true }));
      await expect(client.listen({ toolsListChanged: true }), path).rejects.toThrow(/limit/i);
      await subs.shift()!.close();
      await new Promise((r) => setTimeout(r, 20));
      subs.push(await client.listen({ toolsListChanged: true }));
      for (const sub of subs) await sub.close();
      await client.close();
    }
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
        ? Response.json({ error: "invalid_grant" }, { status: 400, headers: { "www-authenticate": "Basic", pragma: "no-cache" } })
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
    expect(token.headers.get("pragma")).toBe("no-cache");
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

  it("limits each forwarded step per IP with an OAuth-style 429, and sends no client IP upstream", async () => {
    const up = stubUpstream({ oauth: () => Response.json({ ok: true }) });
    const { app } = makeApp({}, {
      forwardLimiters: { "/token": new RateLimiter(2), "/register": new RateLimiter(1, 3_600_000), "/authorize": new RateLimiter(1) },
    });
    const from = (ip: string) => ({ "cf-connecting-ip": ip, "x-forwarded-for": ip, "x-real-ip": ip });
    const token = (ip: string) => app.fetch(req("/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...from(ip) }, body: "grant_type=refresh_token&refresh_token=r",
    }));
    const register = (ip: string) => app.fetch(req("/register", {
      method: "POST", headers: { "content-type": "application/json", ...from(ip) }, body: "{}",
    }));
    const authorize = (ip: string) => app.fetch(req("/authorize?client_id=c", { headers: from(ip) }));

    expect((await token("203.0.113.50")).status).toBe(200);
    expect((await token("203.0.113.50")).status).toBe(200);
    const limited = await token("203.0.113.50");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "temporarily_unavailable", error_description: "Too many requests. Try again later." });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await token("203.0.113.51")).status).toBe(200);

    expect((await register("203.0.113.50")).status).toBe(200);
    const hourly = await register("203.0.113.50");
    expect(hourly.status).toBe(429);
    expect(Number(hourly.headers.get("retry-after"))).toBeGreaterThan(60);

    expect((await authorize("203.0.113.50")).status).toBe(302);
    expect((await authorize("203.0.113.50")).status).toBe(429);

    expect(up.calls.length).toBe(4);
    for (const call of up.calls) {
      for (const name of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"]) expect(call.headerNames).not.toContain(name);
    }
  });

  it("forwards also count under the IP's /mcp ceiling", async () => {
    stubUpstream({ oauth: () => Response.json({ ok: true }) });
    const { app } = makeApp({}, { mcpIpLimiter: new RateLimiter(2) });
    const ip = { "cf-connecting-ip": "203.0.113.60" };
    expect((await app.fetch(req("/authorize?client_id=c", { headers: ip }))).status).toBe(302);
    expect((await app.fetch(req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...ip }, body: "a=b" }))).status).toBe(200);
    expect((await app.fetch(req("/authorize?client_id=c", { headers: ip }))).status).toBe(429);
    expect((await app.fetch(mcpPost(null, ip))).status).toBe(429);
  });

  it("a forward the IP's /mcp ceiling refuses does not use up the path's budget, and the reverse", async () => {
    stubUpstream({ oauth: () => Response.json({ ok: true }) });
    const ip = "203.0.113.70";
    const headers = { "cf-connecting-ip": ip };
    const token = () => app.fetch(req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "a=b" }));

    const tokenLimiter = new RateLimiter(2);
    const ceiling = new RateLimiter(2);
    const { app } = makeApp({}, { forwardLimiters: { "/token": tokenLimiter }, mcpIpLimiter: ceiling });
    expect((await app.fetch(mcpPost(null, headers))).status).not.toBe(429);
    expect((await app.fetch(mcpPost(null, headers))).status).not.toBe(429);
    for (let i = 0; i < 3; i++) expect((await token()).status).toBe(429);
    // Nothing was counted on /token: both of its slots are still free.
    expect(tokenLimiter.peek(ip)).toBe(0);
    expect(tokenLimiter.peek(ip, 2)).toBe(0);
    expect(tokenLimiter.peek(ip, 3)).toBeGreaterThan(0);

    const tight = new RateLimiter(1);
    const roomy = new RateLimiter(3);
    const second = makeApp({}, { forwardLimiters: { "/token": tight }, mcpIpLimiter: roomy });
    const call = () => second.app.fetch(req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "a=b" }));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    // Only the first forward counted on the ceiling.
    expect(roomy.peek(ip, 2)).toBe(0);
    expect(roomy.peek(ip, 3)).toBeGreaterThan(0);
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
  let running: RunningServer;
  let port: number;

  const start = async () => {
    const { app } = makeApp({ MCP_ALLOWED_HOSTS: "127.0.0.1" });
    running = await serveHosted(app, { port: 0, host: "127.0.0.1" });
    port = running.port;
  };
  const stop = () => running.stop();

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

  it("on shutdown, a 2026-07-28 call in flight finishes with its real result before the app closes", async () => {
    const { app } = makeApp({ MCP_ALLOWED_HOSTS: "127.0.0.1" });
    const server = await serveHosted(app, { port: 0, host: "127.0.0.1" });
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/sandbox/${"s".repeat(16)}`)));
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const bought = await client.callTool({ name: "rent_number", arguments: { service_id: "svc_telegram", max_price_cents: 150 } });
    const id = (bought.structuredContent as Record<string, any>).verification.id;
    // Waits about 2 s for the sandbox code; shutdown starts 300 ms in.
    const pending = client.callTool({ name: "get_rental", arguments: { rental_id: id, wait_seconds: 20 } });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    const stopped = server.stop();
    const result = await pending;
    expect(result.isError ?? false, text(result)).toBe(false);
    expect((result.structuredContent as Record<string, any>).verification.status).toBe("code_received");
    await stopped;
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS - 3_000);
  }, 15_000);
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

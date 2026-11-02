import { ConfigError } from "../config.js";

/** Largest request body the hosted server reads (MCP, OAuth forwards, sandbox). */
export const MAX_BODY_BYTES = 64 * 1024;

export interface HostedConfig {
  port: number;
  /** The MCP endpoint's public URL: the protected resource, the access-token audience and the Host it answers to. */
  resourceUrl: URL;
  /** The authorization server: access tokens' `iss`, and where /authorize, /token and /register go. */
  issuer: string;
  /** The issuer's signing keys. */
  jwksUrl: URL;
  /** Public API base the tools call with the caller's own token. */
  apiBaseUrl: string;
  /** Hostnames the Host header may name: the resource URL's, plus MCP_ALLOWED_HOSTS. */
  allowedHosts: string[];
  /** Browser origins (hostnames) allowed on /mcp and /sandbox; a request without Origin always passes. */
  allowedOrigins: string[];
}

const DEFAULT_RESOURCE_URL = "https://mcp.voidmob.com/mcp";
const DEFAULT_ISSUER = "https://dashboard.voidmob.com";
const DEFAULT_API_BASE_URL = "https://dashboard.voidmob.com/api";
const DEFAULT_PORT = 8080;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const read = (env: Record<string, string | undefined>, name: string): string => env[name]?.trim() ?? "";

// Tokens and keys travel to these URLs, so they must be https (plain http
// only on localhost, for local testing).
function secureUrl(env: Record<string, string | undefined>, name: string, fallback: string): URL {
  const raw = read(env, name) || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return url;
  throw new ConfigError(`${name} must use https:// (plain http:// only for localhost or 127.0.0.1). Got: ${raw}`);
}

const hostList = (raw: string): string[] =>
  raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

export function parseHostedEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): HostedConfig {
  const rawPort = read(env, "PORT");
  const port = rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError(`PORT must be a port number. Got: ${rawPort}`);

  const resourceUrl = secureUrl(env, "MCP_RESOURCE_URL", DEFAULT_RESOURCE_URL);
  if (resourceUrl.search || resourceUrl.hash || resourceUrl.pathname === "/") {
    throw new ConfigError(`MCP_RESOURCE_URL must name the MCP endpoint path, without query or fragment. Got: ${resourceUrl.href}`);
  }
  const issuerUrl = secureUrl(env, "OAUTH_ISSUER", DEFAULT_ISSUER);
  if (issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash) {
    throw new ConfigError(`OAUTH_ISSUER must be an origin with no path. Got: ${issuerUrl.href}`);
  }
  const issuer = issuerUrl.origin;

  return {
    port,
    resourceUrl,
    issuer,
    jwksUrl: secureUrl(env, "OAUTH_JWKS_URL", `${issuer}/oauth/jwks`),
    apiBaseUrl: secureUrl(env, "VOIDMOB_BASE_URL", DEFAULT_API_BASE_URL).href.replace(/\/$/, ""),
    allowedHosts: [...new Set([resourceUrl.hostname, ...hostList(read(env, "MCP_ALLOWED_HOSTS"))])],
    allowedOrigins: hostList(read(env, "MCP_ALLOWED_ORIGINS")),
  };
}

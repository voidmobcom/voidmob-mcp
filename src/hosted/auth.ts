import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { KEY_RE } from "../config.js";
import type { PermissionLevel } from "../connection.js";

/** What the verifier puts in `AuthInfo.extra`. */
export type HostedAuth =
  | { kind: "key" }
  | { kind: "oauth"; permission: PermissionLevel; autoMode: boolean };

/** The verified credential's details, from the AuthInfo the verifier returned. */
export function hostedAuthOf(info: AuthInfo): HostedAuth {
  return info.extra as unknown as HostedAuth;
}

// An API key has no expiry of its own; the bearer helper refuses a token
// without one. The API checks the key on every call, so this only ends the
// verification's validity, never the key's.
const KEY_TTL_SECONDS = 3_600;

const PERMISSIONS: ReadonlySet<unknown> = new Set<PermissionLevel>(["view", "manage", "buy"]);

/** The issuer's signing keys, fetched over HTTPS and cached. */
export function remoteJwks(url: URL, userAgent: string): JWTVerifyGetKey {
  return createRemoteJWKSet(url, {
    timeoutDuration: 5_000,
    // A token signed with a key not yet cached refetches at most every 30 s.
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    headers: { "User-Agent": userAgent },
  });
}

const invalidToken = () => new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");

// The keys could not be read (timeout, network, a bad JWKS response): the
// token may be fine, so this is a server error, not a reason to sign in again.
function keysUnavailable(e: unknown): boolean {
  if (!(e instanceof errors.JOSEError)) return true;
  return e instanceof errors.JWKSTimeout || e instanceof errors.JWKSInvalid || e.code === "ERR_JOSE_GENERIC";
}

export interface VerifierOptions {
  issuer: string;
  /** The MCP endpoint URL: the only audience accepted. */
  audience: string;
  jwks: JWTVerifyGetKey;
}

/**
 * Accepts an ES256 access token from the dashboard (iss, exact aud, exp,
 * sub, cid, perm, auto), or a vmk_live_ API key passed through to the API,
 * which checks it on every call. Anything else is refused as invalid_token.
 */
export function createTokenVerifier(opts: VerifierOptions): OAuthTokenVerifier {
  const resource = new URL(opts.audience);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (KEY_RE.test(token)) {
        const extra: HostedAuth = { kind: "key" };
        return {
          token,
          clientId: "api_key",
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + KEY_TTL_SECONDS,
          resource,
          extra,
        };
      }
      let payload;
      try {
        ({ payload } = await jwtVerify(token, opts.jwks, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ["ES256"],
          requiredClaims: ["exp", "sub"],
        }));
      } catch (e) {
        if (keysUnavailable(e)) throw new OAuthError(OAuthErrorCode.ServerError, "Access tokens cannot be checked right now");
        throw invalidToken();
      }
      const { aud, sub, cid, perm, auto, exp } = payload;
      if (
        aud !== opts.audience ||
        typeof sub !== "string" || sub === "" ||
        typeof cid !== "string" || cid === "" ||
        !PERMISSIONS.has(perm) ||
        typeof auto !== "boolean" ||
        typeof exp !== "number"
      ) {
        throw invalidToken();
      }
      const extra: HostedAuth = { kind: "oauth", permission: perm as PermissionLevel, autoMode: auto };
      return { token, clientId: cid, scopes: [], expiresAt: exp, resource, extra };
    },
  };
}

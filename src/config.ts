export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  sandbox: boolean;
  apiKey: string | null;
  baseUrl: string;
  debug: boolean;
}

const DEFAULT_BASE_URL = "https://dashboard.voidmob.com/api";
const SETUP_URL = "https://dashboard.voidmob.com/developers/api-keys";

const KEY_RE = /^vmk_live_[A-Za-z0-9]{32}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// The API key is sent to this URL, so it must be https (plain http only for a
// local dev server).
function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`VOIDMOB_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return raw;
  throw new ConfigError(
    `VOIDMOB_BASE_URL must use https:// (plain http:// is allowed only for localhost or 127.0.0.1). Got: ${raw}`,
  );
}

export function parseEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const sandbox = env.VOIDMOB_SANDBOX === "1";
  const debug = env.VOIDMOB_DEBUG === "1";
  const baseUrl = env.VOIDMOB_BASE_URL ?? DEFAULT_BASE_URL;
  const rawKey = env.VOIDMOB_API_KEY?.trim() || null;

  if (sandbox) {
    return { sandbox: true, apiKey: null, baseUrl, debug };
  }

  // No key and no sandbox is a valid config: the server boots in
  // "unconfigured" mode (tools listed, every call returns setup instructions)
  // so MCP clients and registry crawlers can enumerate the tool surface.
  if (!rawKey) {
    return { sandbox: false, apiKey: null, baseUrl, debug };
  }

  if (!KEY_RE.test(rawKey)) {
    throw new ConfigError(
      `VOIDMOB_API_KEY format is invalid. Expected vmk_live_ followed by 32 alphanumeric characters.\n` +
      `Generate a key at ${SETUP_URL}`,
    );
  }

  return { sandbox: false, apiKey: rawKey, baseUrl: validateBaseUrl(baseUrl), debug };
}

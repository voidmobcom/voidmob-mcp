export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Optional tool groups; account, orders and geo tools are always registered. */
export const TOOLSETS = ["sms", "numbers", "esim", "proxy"] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Safety controls the owner sets in the server's environment. */
export interface OwnerControls {
  /** Tools that spend money or change anything are not registered. */
  readOnly: boolean;
  /** Refuse any single purchase whose max price is above this (cents). */
  maxOrderCents: number | null;
  /** Running spend cap for this server process (cents). */
  budgetCents: number | null;
  /** Tool groups to register. */
  toolsets: ReadonlySet<Toolset>;
}

export const DEFAULT_CONTROLS: OwnerControls = {
  readOnly: false,
  maxOrderCents: null,
  budgetCents: null,
  toolsets: new Set(TOOLSETS),
};

export interface Config {
  sandbox: boolean;
  apiKey: string | null;
  baseUrl: string;
  debug: boolean;
  controls: OwnerControls;
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

// A Claude Desktop bundle (MCPB) passes an optional setting the user left
// empty as the literal "${user_config.<key>}" placeholder, so that counts as
// unset, like an empty value.
const UNFILLED_PLACEHOLDER = /^\$\{user_config\.[^}]*\}$/;

function readEnv(env: Record<string, string | undefined>, name: string): string {
  const raw = env[name]?.trim() ?? "";
  return UNFILLED_PLACEHOLDER.test(raw) ? "" : raw;
}

// "1" and "true" both switch a flag on (bundle installers write booleans as
// "true"/"false"); unset, empty, "0" and "false" leave it off. Anything else is
// a typo in a safety setting, so it stops the server instead of being ignored.
function parseFlag(env: Record<string, string | undefined>, name: string): boolean {
  const raw = readEnv(env, name).toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "" || raw === "0" || raw === "false") return false;
  throw new ConfigError(`${name} must be 1 or 0 (or true/false). Got: ${env[name]}`);
}

// Unset or empty = no limit. A value that is not a whole number of cents stops
// the server: silently ignoring a spend limit would fail open.
function parseCents(env: Record<string, string | undefined>, name: string): number | null {
  const raw = readEnv(env, name);
  if (raw === "") return null;
  if (!/^\d{1,12}$/.test(raw)) {
    throw new ConfigError(`${name} must be a whole number of US cents (e.g. 2000 for $20.00). Got: ${env[name]}`);
  }
  return Number(raw);
}

function parseToolsets(env: Record<string, string | undefined>): ReadonlySet<Toolset> {
  const raw = readEnv(env, "VOIDMOB_TOOLSETS");
  if (raw === "") return new Set(TOOLSETS);
  const picked = new Set<Toolset>();
  for (const part of raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    if (!(TOOLSETS as readonly string[]).includes(part)) {
      throw new ConfigError(
        `VOIDMOB_TOOLSETS has an unknown group '${part}'. Use a comma list of: ${TOOLSETS.join(", ")} ` +
        `(account, orders and geo tools are always on).`,
      );
    }
    picked.add(part as Toolset);
  }
  return picked;
}

export function parseControls(env: Record<string, string | undefined>): OwnerControls {
  return {
    readOnly: parseFlag(env, "VOIDMOB_READ_ONLY"),
    maxOrderCents: parseCents(env, "VOIDMOB_MAX_ORDER_CENTS"),
    budgetCents: parseCents(env, "VOIDMOB_BUDGET_CENTS"),
    toolsets: parseToolsets(env),
  };
}

export function parseEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const sandbox = parseFlag(env, "VOIDMOB_SANDBOX");
  const debug = env.VOIDMOB_DEBUG === "1";
  const baseUrl = readEnv(env, "VOIDMOB_BASE_URL") || DEFAULT_BASE_URL;
  const rawKey = readEnv(env, "VOIDMOB_API_KEY") || null;
  const controls = parseControls(env);

  if (sandbox) {
    return { sandbox: true, apiKey: null, baseUrl, debug, controls };
  }

  // No key and no sandbox is a valid config: the server boots in
  // "unconfigured" mode (tools listed, every call returns setup instructions)
  // so MCP clients and registry crawlers can enumerate the tool surface.
  if (!rawKey) {
    return { sandbox: false, apiKey: null, baseUrl, debug, controls };
  }

  if (!KEY_RE.test(rawKey)) {
    throw new ConfigError(
      `VOIDMOB_API_KEY format is invalid. Expected vmk_live_ followed by 32 alphanumeric characters.\n` +
      `Generate a key at ${SETUP_URL}`,
    );
  }

  return { sandbox: false, apiKey: rawKey, baseUrl: validateBaseUrl(baseUrl), debug, controls };
}

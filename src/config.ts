// src/config.ts
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

const DEFAULT_BASE_URL = "https://dashboard.voidmob.com";
const SETUP_URL = "https://dashboard.voidmob.com/settings/api-keys";

const KEY_RE = /^vmk_(live|test)_[A-Za-z0-9]{32}$/;

export function parseEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const sandbox = env.VOIDMOB_SANDBOX === "1";
  const debug = env.VOIDMOB_DEBUG === "1";
  const baseUrl = env.VOIDMOB_BASE_URL ?? DEFAULT_BASE_URL;
  const rawKey = env.VOIDMOB_API_KEY?.trim() || null;

  if (sandbox) {
    return { sandbox: true, apiKey: null, baseUrl, debug };
  }

  if (!rawKey) {
    throw new ConfigError(
      `Set VOIDMOB_API_KEY=vmk_live_... or VOIDMOB_SANDBOX=1.\n` +
      `Generate a key at ${SETUP_URL}`,
    );
  }

  if (!KEY_RE.test(rawKey)) {
    throw new ConfigError(
      `VOIDMOB_API_KEY format is invalid. Expected vmk_live_ or vmk_test_ followed by 32 alphanumeric characters.\n` +
      `Generate a key at ${SETUP_URL}`,
    );
  }

  return { sandbox: false, apiKey: rawKey, baseUrl, debug };
}

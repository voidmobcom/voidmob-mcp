import { describe, it, expect } from "vitest";
import { parseEnv, ConfigError } from "../src/config.js";

describe("parseEnv", () => {
  it("sandbox mode when VOIDMOB_SANDBOX=1 (no key needed)", () => {
    const cfg = parseEnv({ VOIDMOB_SANDBOX: "1" });
    expect(cfg.sandbox).toBe(true);
    expect(cfg.apiKey).toBeNull();
  });

  it("live mode when VOIDMOB_API_KEY is set", () => {
    const cfg = parseEnv({ VOIDMOB_API_KEY: "vmk_live_" + "a".repeat(32) });
    expect(cfg.sandbox).toBe(false);
    expect(cfg.apiKey).toBe("vmk_live_" + "a".repeat(32));
    expect(cfg.baseUrl).toBe("https://dashboard.voidmob.com/api");
  });

  it("rejects vmk_test_ keys (only vmk_live_ keys are issued)", () => {
    expect(() => parseEnv({ VOIDMOB_API_KEY: "vmk_test_" + "b".repeat(32) })).toThrow(ConfigError);
  });

  it("no key and no sandbox yields unconfigured mode (null apiKey)", () => {
    const cfg = parseEnv({});
    expect(cfg.sandbox).toBe(false);
    expect(cfg.apiKey).toBeNull();
  });

  it("throws ConfigError on bad key prefix", () => {
    expect(() => parseEnv({ VOIDMOB_API_KEY: "sk_test_abc" })).toThrow(ConfigError);
  });

  it("throws ConfigError on too-short key", () => {
    expect(() => parseEnv({ VOIDMOB_API_KEY: "vmk_live_short" })).toThrow(ConfigError);
  });

  it("VOIDMOB_BASE_URL overrides default", () => {
    const cfg = parseEnv({
      VOIDMOB_API_KEY: "vmk_live_" + "a".repeat(32),
      VOIDMOB_BASE_URL: "http://localhost:4000",
    });
    expect(cfg.baseUrl).toBe("http://localhost:4000");
  });

  it("VOIDMOB_BASE_URL accepts https and http only for localhost / 127.0.0.1", () => {
    const key = "vmk_live_" + "a".repeat(32);
    expect(parseEnv({ VOIDMOB_API_KEY: key, VOIDMOB_BASE_URL: "https://staging.example.com/api" }).baseUrl).toBe("https://staging.example.com/api");
    expect(parseEnv({ VOIDMOB_API_KEY: key, VOIDMOB_BASE_URL: "http://127.0.0.1:4000/api" }).baseUrl).toBe("http://127.0.0.1:4000/api");
    expect(() => parseEnv({ VOIDMOB_API_KEY: key, VOIDMOB_BASE_URL: "http://evil.example.com/api" })).toThrow(/https/);
    expect(() => parseEnv({ VOIDMOB_API_KEY: key, VOIDMOB_BASE_URL: "http://localhost.evil.example/api" })).toThrow(ConfigError);
    expect(() => parseEnv({ VOIDMOB_API_KEY: key, VOIDMOB_BASE_URL: "ftp://localhost/api" })).toThrow(ConfigError);
    expect(() => parseEnv({ VOIDMOB_API_KEY: key, VOIDMOB_BASE_URL: "not a url" })).toThrow(ConfigError);
  });

  it("VOIDMOB_DEBUG=1 enables debug", () => {
    const cfg = parseEnv({ VOIDMOB_SANDBOX: "1", VOIDMOB_DEBUG: "1" });
    expect(cfg.debug).toBe(true);
  });

  it("error message points the user to the docs URL", () => {
    expect(() => parseEnv({ VOIDMOB_API_KEY: "sk_test_abc" })).toThrowError(/dashboard\.voidmob\.com/);
  });

  it("empty VOIDMOB_API_KEY is treated as missing (unconfigured mode)", () => {
    const cfg = parseEnv({ VOIDMOB_API_KEY: "" });
    expect(cfg.apiKey).toBeNull();
    expect(cfg.sandbox).toBe(false);
  });

  it("unexpanded ${...} placeholders from any client count as unset", () => {
    const cfg = parseEnv({
      VOIDMOB_API_KEY: "${VOIDMOB_API_KEY}",
      VOIDMOB_SANDBOX: "${env:VOIDMOB_SANDBOX}",
      VOIDMOB_READ_ONLY: "${VOIDMOB_READ_ONLY}",
      VOIDMOB_MAX_ORDER_CENTS: "${VOIDMOB_MAX_ORDER_CENTS}",
      VOIDMOB_BUDGET_CENTS: "${user_config.budget_cents}",
    });
    expect(cfg.apiKey).toBeNull();
    expect(cfg.sandbox).toBe(false);
    expect(cfg.controls.readOnly).toBe(false);
    expect(cfg.controls.maxOrderCents).toBeNull();
    expect(cfg.controls.budgetCents).toBeNull();
  });

  it("a value that only contains ${...} is still read as given", () => {
    expect(() => parseEnv({ VOIDMOB_MAX_ORDER_CENTS: "25${x}" })).toThrow();
  });
});

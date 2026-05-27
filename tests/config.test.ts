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

  it("accepts vmk_test_ keys", () => {
    const cfg = parseEnv({ VOIDMOB_API_KEY: "vmk_test_" + "b".repeat(32) });
    expect(cfg.sandbox).toBe(false);
  });

  it("throws ConfigError when no mode selected", () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
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

  it("VOIDMOB_DEBUG=1 enables debug", () => {
    const cfg = parseEnv({ VOIDMOB_SANDBOX: "1", VOIDMOB_DEBUG: "1" });
    expect(cfg.debug).toBe(true);
  });

  it("error message points the user to the docs URL", () => {
    expect(() => parseEnv({})).toThrowError(/dashboard\.voidmob\.com/);
  });

  it("empty VOIDMOB_API_KEY in live mode is treated as missing", () => {
    expect(() => parseEnv({ VOIDMOB_API_KEY: "" })).toThrow(ConfigError);
  });
});

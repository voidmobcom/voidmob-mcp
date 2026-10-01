import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { SpendGuard, ToolRefusal, isDefinitelyNotCharged } from "../src/controls/spend-guard.js";
import { HttpError, NetworkError } from "../src/client/http.js";
import { parseEnv, parseControls, ConfigError, TOOLSETS } from "../src/config.js";

const post = (status: number, code: string) => new HttpError(status, code, "r", undefined, "x", { method: "POST" });

describe("SpendGuard", () => {
  it("no limits: everything goes through and the charge is still counted", async () => {
    const guard = new SpendGuard({ maxOrderCents: null, budgetCents: null });
    expect(await guard.run(5000, async () => ({ value: "ok", chargedCents: 4000 }))).toBe("ok");
    expect(guard.countedCents).toBe(4000);
    expect(guard.remainingCents).toBeNull();
  });

  it("max order: refuses a max price above the limit before running anything", async () => {
    const guard = new SpendGuard({ maxOrderCents: 1000, budgetCents: null });
    let ran = false;
    await expect(guard.run(1001, async () => { ran = true; return { value: 1 }; })).rejects.toThrow(ToolRefusal);
    expect(ran).toBe(false);
    await expect(guard.run(1001, async () => ({ value: 1 }))).rejects.toThrow(/VOIDMOB_MAX_ORDER_CENTS.*Nothing was charged/);
    expect(await guard.run(1000, async () => ({ value: 1, chargedCents: 900 }))).toBe(1);
  });

  it("budget: counts reported charges and refuses what would exceed it, saying it is a session safety net", async () => {
    const guard = new SpendGuard({ maxOrderCents: null, budgetCents: 1000 });
    await guard.run(600, async () => ({ value: 1, chargedCents: 550 }));
    expect(guard.remainingCents).toBe(450);
    const refused = guard.run(500, async () => ({ value: 2 }));
    await expect(refused).rejects.toThrow(ToolRefusal);
    await expect(guard.run(500, async () => ({ value: 2 }))).rejects.toThrow(/per-session safety net.*not a VoidMob account limit/);
    await guard.run(450, async () => ({ value: 3, chargedCents: 450 }));
    expect(guard.remainingCents).toBe(0);
  });

  it("budget: a response without the charge counts the full max price", async () => {
    const guard = new SpendGuard({ maxOrderCents: null, budgetCents: 1000 });
    await guard.run(700, async () => ({ value: 1 }));
    expect(guard.countedCents).toBe(700);
  });

  it("budget: an uncertain outcome counts the max price; a definite refusal counts nothing", async () => {
    const guard = new SpendGuard({ maxOrderCents: null, budgetCents: 10_000 });
    await expect(guard.run(300, async () => { throw new NetworkError(new Error("reset"), "POST"); })).rejects.toThrow(NetworkError);
    expect(guard.countedCents).toBe(300);
    await expect(guard.run(200, async () => { throw post(409, "IDEMPOTENCY_REPLAY_IN_FLIGHT"); })).rejects.toThrow();
    expect(guard.countedCents).toBe(500);
    await expect(guard.run(100, async () => { throw new ZodError([]); })).rejects.toThrow();
    expect(guard.countedCents).toBe(600);
    await expect(guard.run(900, async () => { throw post(409, "PRICE_OVER_CAP"); })).rejects.toThrow();
    await expect(guard.run(900, async () => { throw post(402, "INSUFFICIENT_BALANCE"); })).rejects.toThrow();
    await expect(guard.run(900, async () => { throw new ToolRefusal("price moved"); })).rejects.toThrow();
    expect(guard.countedCents).toBe(600);
  });

  it("concurrent purchases reserve their max price, so they cannot overshoot the budget together", async () => {
    const guard = new SpendGuard({ maxOrderCents: null, budgetCents: 1000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = guard.run(700, async () => { await gate; return { value: "a", chargedCents: 700 }; });
    // While the first is in flight, only 300 is available.
    await expect(guard.run(400, async () => ({ value: "b" }))).rejects.toThrow(ToolRefusal);
    expect(await guard.run(300, async () => ({ value: "c", chargedCents: 300 }))).toBe("c");
    release();
    expect(await first).toBe("a");
    expect(guard.countedCents).toBe(1000);
    expect(guard.remainingCents).toBe(0);
  });

  it("a refused in-flight purchase gives its reservation back", async () => {
    const guard = new SpendGuard({ maxOrderCents: null, budgetCents: 1000 });
    await expect(guard.run(1000, async () => { throw post(409, "PRICE_MISMATCH"); })).rejects.toThrow();
    expect(guard.remainingCents).toBe(1000);
  });
});

describe("isDefinitelyNotCharged", () => {
  it("reads and 4xx write verdicts are safe; no-verdict writes and unrefunded 5xx are not", () => {
    expect(isDefinitelyNotCharged(new NetworkError(new Error("x"), "GET"))).toBe(true);
    expect(isDefinitelyNotCharged(new HttpError(500, "INTERNAL_ERROR", "r", undefined, "x", { method: "GET" }))).toBe(true);
    expect(isDefinitelyNotCharged(post(404, "SERVICE_NOT_FOUND"))).toBe(true);
    expect(isDefinitelyNotCharged(post(503, "SERVICE_OUT_OF_STOCK"))).toBe(true);
    expect(isDefinitelyNotCharged(post(502, "PROVISIONING_FAILED"))).toBe(true);
    expect(isDefinitelyNotCharged(new NetworkError(new Error("x"), "POST"))).toBe(false);
    expect(isDefinitelyNotCharged(post(500, "INTERNAL_ERROR"))).toBe(false);
    expect(isDefinitelyNotCharged(post(502, "UNKNOWN_ERROR"))).toBe(false);
    expect(isDefinitelyNotCharged(post(409, "IDEMPOTENCY_REPLAY_IN_FLIGHT"))).toBe(false);
    expect(isDefinitelyNotCharged(new Error("bug"))).toBe(false);
  });
});

describe("owner controls from the environment", () => {
  it("defaults: everything on, no limits", () => {
    const c = parseControls({});
    expect(c).toMatchObject({ readOnly: false, maxOrderCents: null, budgetCents: null });
    expect([...c.toolsets]).toEqual([...TOOLSETS]);
  });

  it("parses read-only, limits and toolsets", () => {
    const c = parseControls({
      VOIDMOB_READ_ONLY: "1",
      VOIDMOB_MAX_ORDER_CENTS: "2500",
      VOIDMOB_BUDGET_CENTS: " 10000 ",
      VOIDMOB_TOOLSETS: "SMS, esim",
    });
    expect(c).toMatchObject({ readOnly: true, maxOrderCents: 2500, budgetCents: 10000 });
    expect([...c.toolsets].sort()).toEqual(["esim", "sms"]);
  });

  it("accepts true/false flags as a bundle installer writes them", () => {
    expect(parseControls({ VOIDMOB_READ_ONLY: "true" }).readOnly).toBe(true);
    expect(parseControls({ VOIDMOB_READ_ONLY: "false" }).readOnly).toBe(false);
    expect(parseEnv({ VOIDMOB_SANDBOX: "false" }).sandbox).toBe(false);
    expect(parseEnv({ VOIDMOB_SANDBOX: "true" }).sandbox).toBe(true);
  });

  it("treats an unfilled bundle placeholder or an empty value as unset", () => {
    const c = parseControls({
      VOIDMOB_MAX_ORDER_CENTS: "${user_config.max_order_cents}",
      VOIDMOB_BUDGET_CENTS: "",
      VOIDMOB_READ_ONLY: "${user_config.read_only}",
    });
    expect(c).toMatchObject({ readOnly: false, maxOrderCents: null, budgetCents: null });
    const cfg = parseEnv({ VOIDMOB_API_KEY: "${user_config.api_key}", VOIDMOB_BASE_URL: "${user_config.base_url}" });
    expect(cfg.apiKey).toBeNull();
    expect(cfg.baseUrl).toBe("https://dashboard.voidmob.com/api");
  });

  it("a malformed safety setting stops the server instead of being ignored", () => {
    expect(() => parseControls({ VOIDMOB_MAX_ORDER_CENTS: "20.50" })).toThrow(ConfigError);
    expect(() => parseControls({ VOIDMOB_BUDGET_CENTS: "-5" })).toThrow(ConfigError);
    expect(() => parseControls({ VOIDMOB_BUDGET_CENTS: "$20" })).toThrow(/whole number of US cents/);
    expect(() => parseControls({ VOIDMOB_READ_ONLY: "yes" })).toThrow(ConfigError);
    expect(() => parseControls({ VOIDMOB_TOOLSETS: "sms,webhooks" })).toThrow(/unknown group 'webhooks'/);
  });

  it("zero is a valid limit (nothing can be bought)", () => {
    expect(parseControls({ VOIDMOB_BUDGET_CENTS: "0" }).budgetCents).toBe(0);
  });
});

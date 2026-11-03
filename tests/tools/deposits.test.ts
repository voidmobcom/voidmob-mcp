// create_deposit and get_deposit: the request (body, a new Idempotency-Key per
// call, the 45 s timeout), the text for each deposit status, the coins and
// newest deposits, the deposit-specific error texts, and the sandbox flow.
import { describe, it, expect } from "vitest";
import type { HttpClient } from "../../src/client/http.js";
import { HttpError, NetworkError } from "../../src/client/http.js";
import type { Deposit } from "../../src/client/types.js";
import { DEFAULT_CONTROLS } from "../../src/config.js";
import type { Connection } from "../../src/connection.js";
import { createSandboxHttpClient } from "../../src/sandbox/mock-http.js";
import { createToolContext, toolContext } from "../../src/tools/context.js";
import {
  CREATE_DEPOSIT_TIMEOUT_MS, createDepositHandler, getDepositHandler,
} from "../../src/tools/deposits.js";
import type { ToolResult } from "../../src/utils/render.js";
import { createMockHttpClient } from "../mock-http.js";

const textOf = (r: ToolResult) => (r.content[0] as { text: string }).text;
const sc = (r: ToolResult) => r.structuredContent as Record<string, any>;
const okBody = (data: unknown, status = 200) => ({ status, body: { success: true, data }, headers: new Headers() });
const errBody = (status: number, code: string, message: string, details?: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  status, body: { success: false, error: { code, message, request_id: "req_d", details } }, headers: new Headers(headers),
});

const ID = "dep_0b7c9a52-3f4e-4d1a-9b8c-2e6f1a0d4c3b";
const IN_AN_HOUR = new Date(Date.now() + 60 * 60_000).toISOString();

const deposit = (over: Partial<Deposit> = {}): Deposit => ({
  id: ID,
  status: "awaiting_payment",
  coin: "ltc",
  asset: "LTC",
  network: "Litecoin",
  amount_cents: 2000,
  crypto_amount: "0.25000000",
  address: "ltc1qexampleaddress0000000000000000000",
  payment_uri: "litecoin:ltc1qexampleaddress0000000000000000000?amount=0.25000000",
  confirmations: 0,
  required_confirmations: 6,
  received_cents: 0,
  credited_cents: 0,
  bonus_cents: 0,
  top_up: null,
  url: `https://dashboard.voidmob.com/wallet?deposit=${ID}`,
  expires_at: IN_AN_HOUR,
  created_at: "2026-11-03T12:00:00.000Z",
  credited_at: null,
  ...over,
});

const manage: Connection = { permission: "manage", autoMode: false, maxOrderCents: null, dailyLimitCents: null };
const oauthBuy: Connection = { permission: "buy", autoMode: false, maxOrderCents: null, dailyLimitCents: null, kind: "oauth" };

/** An HttpClient whose every request fails with `err`. */
const failing = (err: unknown): HttpClient => ({ request: async () => { throw err; } });

describe("create_deposit", () => {
  it("POSTs the coin and amount with a new Idempotency-Key per call and the 45 s timeout", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/deposits", okBody({ deposit: deposit() }, 201));
    http.expect("POST", "/v1/deposits", okBody({ deposit: deposit() }, 201));
    const create = createDepositHandler(toolContext(http, {}, manage));
    await create({ coin: " LTC ", amount_cents: 2000 });
    await create({ coin: "ltc", amount_cents: 2000 });
    expect(http.history[0].body).toEqual({ coin: "ltc", amount_cents: 2000 });
    expect(http.history[0].timeoutMs).toBe(45_000);
    expect(CREATE_DEPOSIT_TIMEOUT_MS).toBe(45_000);
    const keys = http.history.map((h) => h.headers["Idempotency-Key"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("gives the exact amount, network, address, deadline, payment link, the payment window and that extra is credited", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/deposits", okBody({ deposit: deposit() }, 201));
    const res = await createDepositHandler(toolContext(http))({ coin: "ltc", amount_cents: 2000 });
    expect(res.isError ?? false).toBe(false);
    const text = textOf(res);
    expect(text).toContain(`Deposit ${ID} created for $20.00. Send exactly 0.25000000 LTC on the Litecoin network to the address below before ${IN_AN_HOUR}.`);
    expect(text).toContain("Send exactly:   0.25000000 LTC");
    expect(text).toContain("Network:        Litecoin");
    expect(text).toContain("Address:        ltc1qexampleaddress0000000000000000000");
    expect(text).toContain("Payment link:   litecoin:ltc1qexampleaddress0000000000000000000?amount=0.25000000");
    expect(text).toContain(`Pay before:     ${IN_AN_HOUR} (`);
    expect(text).toContain("Any extra is credited to your balance.");
    expect(text).toContain(`Payment window: https://dashboard.voidmob.com/wallet?deposit=${ID} (you can check the address here)`);
    expect(sc(res).deposit).toMatchObject({ id: ID, status: "awaiting_payment", payment_uri: expect.stringContaining("litecoin:") });
  });

  it("leaves the payment link out when the coin has none", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/deposits", okBody({ deposit: deposit({ coin: "usdt_trc20", asset: "USDT", network: "TRON (TRC-20)", crypto_amount: "20.00", payment_uri: null }) }, 201));
    const res = await createDepositHandler(toolContext(http))({ coin: "usdt_trc20", amount_cents: 2000 });
    const text = textOf(res);
    expect(text).toContain("Send exactly 20.00 USDT on the TRON (TRC-20) network");
    expect(text).not.toContain("Payment link");
    expect(sc(res).deposit.payment_uri).toBeNull();
  });

  it("maps the deposit limit, the coin minimum and an unknown coin to clear text", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/deposits", errBody(429, "DEPOSIT_LIMIT_REACHED", "Too many open deposits.", { reason: "open_deposits", limit: 8 }));
    http.expect("POST", "/v1/deposits", errBody(400, "VALIDATION_ERROR", "Below the minimum.", { min_amount_cents: 500 }));
    http.expect("POST", "/v1/deposits", errBody(400, "VALIDATION_ERROR", "Unknown coin 'doge'."));
    const create = createDepositHandler(toolContext(http, {}, manage));
    const limit = await create({ coin: "ltc", amount_cents: 2000 });
    expect(limit.isError).toBe(true);
    expect(textOf(limit)).toContain("This account already has 8 open deposits, the most allowed at once, so no deposit was created.");
    const min = await create({ coin: "ltc", amount_cents: 100 });
    expect(textOf(min)).toContain("below this coin's minimum deposit of $5.00 (amount_cents 500)");
    const coin = await create({ coin: "doge", amount_cents: 2000 });
    expect(textOf(coin)).toBe(
      "Unknown coin 'doge'. No deposit was created. get_deposit without a deposit_id lists the coins you can use and their minimums. (request_id: req_d)",
    );
  });

  it("a 503 says deposits are down, never that app purchases are paused, even on an app connection", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/deposits", errBody(503, "SERVICE_UNAVAILABLE", "Deposits are temporarily unavailable."));
    http.expect("POST", "/v1/deposits", errBody(503, "SERVICE_UNAVAILABLE", "Deposits are temporarily unavailable.", undefined, { "Retry-After": "30" }));
    const ctx = createToolContext(http, DEFAULT_CONTROLS, oauthBuy, { hosted: true });
    const first = textOf(await createDepositHandler(ctx)({ coin: "ltc", amount_cents: 2000 }));
    expect(first).toBe("Deposits can't be created right now, so none was created and nothing was charged. Try again in a few minutes. (request_id: req_d)");
    expect(first).not.toMatch(/paused|connected apps/);
    expect(textOf(await createDepositHandler(ctx)({ coin: "ltc", amount_cents: 2000 }))).toContain("Try again in 30s.");
  });

  it("an unknown outcome says a deposit may exist and nothing was charged: check get_deposit before creating another", async () => {
    for (const err of [
      new NetworkError(new Error("socket hang up"), "POST"),
      new HttpError(409, "IDEMPOTENCY_REPLAY_IN_FLIGHT", "r", undefined, "x", { method: "POST" }),
      new HttpError(500, "INTERNAL_ERROR", "r", undefined, "x", { method: "POST" }),
      new HttpError(502, "UNKNOWN_ERROR", "", undefined, undefined, { method: "POST" }),
    ]) {
      const text = textOf(await createDepositHandler(toolContext(failing(err)))({ coin: "ltc", amount_cents: 2000 }));
      expect(text, String(err)).toContain("a deposit may or may not have been created. Nothing was charged");
      expect(text, String(err)).toContain("check get_deposit without a deposit_id");
      expect(text, String(err)).not.toContain("purchase may already be charged");
    }
  });

  it("deposits switched off for the account (404): not available, with the deposit link", async () => {
    const http = createMockHttpClient();
    http.expect("POST", "/v1/deposits", errBody(404, "NOT_FOUND", "Not found."));
    const text = textOf(await createDepositHandler(toolContext(http))({ coin: "ltc", amount_cents: 2000 }));
    expect(text).toBe(
      "Deposits through the API aren't available for this account right now. The user can add funds at https://dashboard.voidmob.com/wallet. (request_id: req_d)",
    );
  });
});

describe("get_deposit with a deposit_id", () => {
  const read = async (d: Deposit) => {
    const http = createMockHttpClient();
    http.expect("GET", `/v1/deposits/${ID}`, okBody({ deposit: d }));
    const res = await getDepositHandler(toolContext(http))({ deposit_id: ID });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    expect(sc(res).deposit).toMatchObject({ id: ID, status: d.status });
    return textOf(res);
  };

  it("awaiting payment: where and how much to pay, and the payment window", async () => {
    const text = await read(deposit());
    expect(text).toContain(`Deposit ${ID}: awaiting payment`);
    expect(text).toContain("Address:        ltc1qexampleaddress0000000000000000000");
    expect(text).toContain("Waiting for the payment: send exactly 0.25000000 LTC on the Litecoin network to this address before the deadline. Any extra is credited to your balance.");
    expect(text).toContain("(you can check the address here)");
  });

  it("confirming: the confirmations so far", async () => {
    const text = await read(deposit({ status: "confirming", confirmations: 2 }));
    expect(text).toContain("A payment was seen and is being confirmed (2 of 6 network confirmations).");
    expect(await read(deposit({ status: "confirming", required_confirmations: null }))).toContain("A payment was seen and is being confirmed. The balance");
  });

  it("underpaid with a top-up: send X more until Y; without: create a new deposit for the rest", async () => {
    const until = "2026-11-03T13:30:00.000Z";
    const text = await read(deposit({
      status: "underpaid", received_cents: 1500, credited_cents: 1500, top_up: { crypto_amount: "0.06250000", until },
    }));
    expect(text).toContain("Received:       $15.00");
    expect(text).toContain("Credited:       $15.00");
    expect(text).toContain("Send more:      0.06250000 LTC");
    expect(text).toContain(`To complete it, send 0.06250000 LTC more on the Litecoin network to the same address until ${until}.`);
    const closed = await read(deposit({ status: "underpaid", received_cents: 1500, credited_cents: 1500, top_up: null }));
    expect(closed).toContain("This deposit takes no more payments: for the rest, create a new deposit.");
    expect(closed).not.toContain("Send more");
  });

  it("credited: the credited amount and any bonus", async () => {
    const text = await read(deposit({
      status: "credited", received_cents: 2000, credited_cents: 2000, bonus_cents: 1000, credited_at: "2026-11-03T12:20:00.000Z",
    }));
    expect(text).toContain("Credited:       $20.00 (+$10.00 bonus)");
    expect(text).toContain("Credited at:    2026-11-03T12:20:00.000Z");
    expect(text).toContain("Paid in full");
    expect(text).not.toContain("Address:");
    expect(text).toContain(`Payment window: https://dashboard.voidmob.com/wallet?deposit=${ID}`);
    expect(text).not.toContain("check the address");
  });

  it("expired: don't send to it, create a new one", async () => {
    const text = await read(deposit({ status: "expired" }));
    expect(text).toContain("Don't send to this deposit; create a new one. If a payment arrives anyway, it is credited once it confirms.");
    expect(text).not.toContain("Address:");
  });

  it("an unknown id says so; on the stateless sandbox it adds the playground hint", async () => {
    const http = createMockHttpClient();
    http.expect("GET", `/v1/deposits/${ID}`, errBody(404, "NOT_FOUND", "Deposit not found."));
    const plain = textOf(await getDepositHandler(toolContext(http))({ deposit_id: ID }));
    expect(plain).toBe(`No deposit ${ID} was found on this account. get_deposit without a deposit_id lists the newest. (request_id: req_d)`);
    const ctx = createToolContext(createSandboxHttpClient(), DEFAULT_CONTROLS, null, {
      hosted: true, statelessSandbox: { playgroundUrl: "https://mcp.voidmob.com/sandbox/<any-random-id>" },
    });
    const hinted = textOf(await getDepositHandler(ctx)({ deposit_id: ID }));
    expect(hinted).toContain(`No deposit ${ID} was found on this account.`);
    expect(hinted).toContain("This sandbox keeps no state between calls");
    expect(hinted).toContain("https://mcp.voidmob.com/sandbox/<any-random-id>");
  });
});

describe("get_deposit without a deposit_id", () => {
  const coins = [
    { coin: "btc", asset: "BTC", network: "Bitcoin", min_amount_cents: 1000, max_amount_cents: 1_000_000 },
    { coin: "usdt_trc20", asset: "USDT", network: "TRON (TRC-20)", min_amount_cents: 500, max_amount_cents: 1_000_000 },
  ];

  it("lists the coins with their limits and the 5 newest deposits, naming the ones that still take payments", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/deposit_coins", okBody({ coins }));
    http.expect("GET", "/v1/deposits?limit=5", okBody({ deposits: [deposit(), deposit({ id: "dep_old", status: "credited", credited_cents: 2000 })], next_cursor: null }));
    const res = await getDepositHandler(toolContext(http, {}, manage))({});
    const text = textOf(res);
    expect(text).toContain("btc          BTC on Bitcoin");
    expect(text).toContain("$10.00 - $10000.00");
    expect(text).toContain("usdt_trc20   USDT on TRON (TRC-20)");
    expect(text).toContain(`Still taking payments: ${ID}. Reuse one rather than creating another`);
    expect(text).not.toContain("Still taking payments: dep_old");
    expect(text).toContain("To add funds, create_deposit with a coin id and amount_cents (ask the user which coin and how much unless they said)");
    expect(sc(res)).toMatchObject({ coins, deposits: [{ id: ID }, { id: "dep_old" }] });
  });

  it("at View, the deposit link alone; no deposits yet", async () => {
    const http = createMockHttpClient();
    http.expect("GET", "/v1/deposit_coins", okBody({ coins }));
    http.expect("GET", "/v1/deposits?limit=5", okBody({ deposits: [], next_cursor: null }));
    const text = textOf(await getDepositHandler(toolContext(http, { readOnly: true }))({}));
    expect(text).toContain("No deposits yet.");
    expect(text).toContain("To add funds, the user goes to https://dashboard.voidmob.com/wallet.");
    expect(text).not.toContain("create_deposit");
  });
});

describe("sandbox deposit flow", () => {
  it("a fake address and no payment link; the first read says confirming, the second credited and the balance goes up", async () => {
    const http = createSandboxHttpClient();
    const ctx = toolContext(http);
    const balance = async () => ((await http.request("GET", "/v1/me")).body as any).data;
    const before = await balance();

    const created = await createDepositHandler(ctx)({ coin: "usdt_trc20", amount_cents: 2500 });
    expect(created.isError ?? false, textOf(created)).toBe(false);
    const d = sc(created).deposit;
    expect(d.id).toMatch(/^dep_[0-9a-f-]{36}$/);
    expect(d.address).toMatch(/^SANDBOX-NOT-A-REAL-ADDRESS-/);
    expect(d.payment_uri).toBeNull();
    expect(d.status).toBe("awaiting_payment");
    expect(textOf(created)).not.toContain("Payment link");

    const first = await getDepositHandler(ctx)({ deposit_id: d.id });
    expect(sc(first).deposit.status).toBe("confirming");
    expect((await balance()).balance.amount_cents).toBe(before.balance.amount_cents);

    const second = await getDepositHandler(ctx)({ deposit_id: d.id });
    expect(sc(second).deposit).toMatchObject({ status: "credited", credited_cents: 2500 });
    const after = await balance();
    expect(after.balance.amount_cents).toBe(before.balance.amount_cents + 2500);
    // A credit is not negative spend.
    expect(after.key.spent_24h_cents).toBe(0);

    // Credited once: further reads change nothing.
    await getDepositHandler(ctx)({ deposit_id: d.id });
    expect((await balance()).balance.amount_cents).toBe(before.balance.amount_cents + 2500);

    const listed = await getDepositHandler(ctx)({});
    expect(sc(listed).deposits.map((x: Deposit) => x.id)).toEqual([d.id]);
    expect(sc(listed).coins.length).toBeGreaterThan(0);
  });

  it("refuses an unknown coin, an amount under the coin's minimum and a ninth open deposit like the API", async () => {
    const ctx = toolContext(createSandboxHttpClient());
    expect(textOf(await createDepositHandler(ctx)({ coin: "doge", amount_cents: 2000 }))).toContain("Unknown coin 'doge'.");
    expect(textOf(await createDepositHandler(ctx)({ coin: "btc", amount_cents: 500 }))).toContain("minimum deposit of $10.00 (amount_cents 1000)");
    for (let i = 0; i < 8; i++) {
      expect((await createDepositHandler(ctx)({ coin: "ltc", amount_cents: 1000 })).isError ?? false).toBe(false);
    }
    expect(textOf(await createDepositHandler(ctx)({ coin: "ltc", amount_cents: 1000 }))).toContain("already has 8 open deposits");
  });
});

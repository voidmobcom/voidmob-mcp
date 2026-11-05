import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { callApi } from "../client/call-api.js";
import { HttpError, NetworkError } from "../client/http.js";
import { newIdempotencyKey } from "../client/idempotency.js";
import { path } from "../client/path.js";
import { Deposit, DepositCoin, type DepositStatus } from "../client/types.js";
import { DepositId } from "../constants/ids.js";
import { READ_ONLY } from "../utils/annotations.js";
import { formatTimeRemaining, formatUsd } from "../utils/format.js";
import { outputObject } from "../utils/output.js";
import { structuredOk, toolError, wrapToolErrors, type ToolResult } from "../utils/render.js";
import { defineTool, levelAllows, statelessSandboxNote, type ToolContext } from "./context.js";

/**
 * create_deposit's timeout: the API's own call that creates the payment
 * address may take up to 30 s, the shared write timeout, so this request
 * gets longer.
 */
export const CREATE_DEPOSIT_TIMEOUT_MS = 45_000;

/** Deposits get_deposit shows when no deposit_id is given. */
export const NEWEST_DEPOSITS = 5;

const Deposits = z.array(Deposit);
const Coins = z.array(DepositCoin);

export const DepositOutput = outputObject({ deposit: Deposit });
export const GetDepositOutput = outputObject({
  // With deposit_id: that deposit.
  deposit: Deposit.optional(),
  // Without: the coins with their limits, and the newest deposits.
  coins: Coins.optional(),
  deposits: Deposits.optional(),
});

type DepositT = z.infer<typeof Deposit>;

const reqLine = (e: HttpError): string => (e.requestId ? ` (request_id: ${e.requestId})` : "");

const STATUS_LABEL: Record<DepositStatus, string> = {
  awaiting_payment: "awaiting payment",
  confirming: "payment seen, confirming",
  underpaid: "underpaid",
  credited: "credited",
  expired: "expired",
};

/** Still takes money: a new payment should go here rather than to a new deposit. */
const takesPayment = (d: DepositT): boolean => d.status === "awaiting_payment" || (d.status === "underpaid" && d.top_up !== null);

const sendLine = (d: DepositT): string => `${d.crypto_amount} ${d.asset} on the ${d.network} network`;
const deadline = (iso: string): string => {
  const at = new Date(iso).getTime();
  return at > Date.now() ? `${iso} (${formatTimeRemaining(at)} left)` : `${iso} (ended)`;
};

/** The lines that say where and how much to pay, for a deposit awaiting payment. */
function payLines(d: DepositT): string[] {
  return [
    `  Send exactly:   ${d.crypto_amount} ${d.asset}`,
    `  Network:        ${d.network}`,
    `  Address:        ${d.address}`,
    ...(d.payment_uri ? [`  Payment link:   ${d.payment_uri}`] : []),
    `  Pay before:     ${deadline(d.expires_at)}`,
  ];
}

/**
 * Where the user checks the address. The sandbox has no payment window: its
 * addresses are fake and the dashboard holds no such deposit.
 */
function windowLine(d: DepositT, sandbox: boolean): string {
  if (sandbox) return "Payment window: none in the sandbox (the address is fake and nothing can be paid).";
  return `Payment window: ${d.url}${takesPayment(d) ? " (you can check the address here)" : ""}`;
}

/** A deposit's details and what to do next, by status. */
export function renderDeposit(d: DepositT, sandbox = false): string {
  const lines = [
    `Deposit ${d.id}: ${STATUS_LABEL[d.status]}`,
    ``,
    `  Amount:         ${formatUsd(d.amount_cents)} (${d.coin})`,
  ];
  const credited = d.bonus_cents > 0
    ? `${formatUsd(d.credited_cents)} (+${formatUsd(d.bonus_cents)} bonus)`
    : formatUsd(d.credited_cents);
  switch (d.status) {
    case "awaiting_payment":
      lines.push(...payLines(d), ``, `Waiting for the payment: send exactly ${sendLine(d)} to this address before the deadline. Any extra is credited to your balance.`);
      break;
    case "confirming": {
      const count = d.required_confirmations !== null ? ` (${d.confirmations} of ${d.required_confirmations} network confirmations)` : "";
      lines.push(``, `A payment was seen and is being confirmed${count}. The balance goes up once it confirms; check again in a few minutes.`);
      break;
    }
    case "underpaid": {
      const shortfall = d.credited_cents > 0
        ? `Less arrived than the deposit asked for, and what arrived was credited (${formatUsd(d.credited_cents)}).`
        : `Less arrived than the deposit asked for, and nothing is credited yet.`;
      lines.push(`  Received:       ${formatUsd(d.received_cents)}`, `  Credited:       ${credited}`);
      if (d.top_up) {
        lines.push(
          `  Send more:      ${d.top_up.crypto_amount} ${d.asset}`,
          `  Network:        ${d.network}`,
          `  Address:        ${d.address}`,
          // While a top-up is open, the link carries the rest to send.
          ...(d.payment_uri ? [`  Payment link:   ${d.payment_uri}`] : []),
          `  Until:          ${deadline(d.top_up.until)}`,
          ``,
          `${shortfall} To complete it, send ${d.top_up.crypto_amount} ${d.asset} more on the ${d.network} network to the same address until ${d.top_up.until}.`,
        );
      } else {
        lines.push(``, `${shortfall} This deposit takes no more payments: for the rest, create a new deposit.`);
      }
      break;
    }
    case "credited":
      lines.push(`  Credited:       ${credited}`, `  First credit:   ${d.credited_at ?? "-"}`, ``, `Paid in full: the amount is on the balance (any extra was credited too).`);
      break;
    case "expired":
      lines.push(``, `The payment window ended with nothing received. Don't send to this deposit; create a new one. If a payment arrives anyway, it is credited once it confirms.`);
      break;
  }
  lines.push(``, windowLine(d, sandbox));
  return lines.join("\n");
}

// A deposit never charges anything, but a create whose answer was lost may
// have opened one: look before opening another.
const UNCERTAIN_CREATE =
  "No answer came back, so a deposit may or may not have been created. Nothing was charged: a deposit only adds funds once it is paid. " +
  "Before creating another, check get_deposit without a deposit_id (it lists the newest deposits) and reuse an open one.";

/** The deposit routes answer 404 while deposits through the API are off for the account. */
const unavailableText = (ctx: ToolContext): string =>
  `Deposits through the API aren't available for this account right now. The user can add funds at ${ctx.depositUrl}.`;

/**
 * Text for create_deposit failures that differ from a purchase's: an unknown
 * outcome (a deposit may exist, nothing was charged), a 503 (deposits are
 * down, never the paused app purchases) and a coin the API refused. Anything
 * else falls through to the shared mapping.
 */
function createDepositErrorText(e: unknown, ctx: ToolContext): string | undefined {
  if (e instanceof NetworkError) return UNCERTAIN_CREATE;
  if (!(e instanceof HttpError)) return undefined;
  // Still running, or no verdict from the API itself (something in between answered).
  if (e.code === "IDEMPOTENCY_REPLAY_IN_FLIGHT" || e.code === "UNKNOWN_ERROR") return `${UNCERTAIN_CREATE}${reqLine(e)}`;
  if (e.code === "SERVICE_UNAVAILABLE") {
    const wait = e.meta.retryAfterSeconds;
    return `Deposits can't be created right now, so none was created and nothing was charged. Try again ${wait ? `in ${wait}s` : "in a few minutes"}.${reqLine(e)}`;
  }
  if (e.status >= 500) return `${UNCERTAIN_CREATE}${reqLine(e)}`;
  if (e.status === 404) return `${unavailableText(ctx)}${reqLine(e)}`;
  if (e.code === "VALIDATION_ERROR" && e.details?.min_amount_cents === undefined) {
    return `${e.message} No deposit was created. get_deposit without a deposit_id lists the coins you can use and their minimums.${reqLine(e)}`;
  }
  return undefined;
}

// ── create_deposit ──────────────────────────────────────────────────────────

export const createDepositHandler = (ctx: ToolContext) =>
  wrapToolErrors(ctx, async (args: { coin: string; amount_cents: number }): Promise<ToolResult> => {
    let raw: { deposit: unknown };
    try {
      raw = await callApi<{ deposit: unknown }>(ctx.http, "POST", "/v1/deposits", {
        body: { coin: args.coin.trim().toLowerCase(), amount_cents: args.amount_cents },
        idempotencyKey: newIdempotencyKey(),
        timeoutMs: CREATE_DEPOSIT_TIMEOUT_MS,
      });
    } catch (e) {
      const text = createDepositErrorText(e, ctx);
      if (text) return toolError(text);
      throw e;
    }
    const d = Deposit.parse(raw.deposit);
    const text = [
      `Deposit ${d.id} created for ${formatUsd(d.amount_cents)}. Send exactly ${sendLine(d)} to the address below before ${d.expires_at}.`,
      ``,
      ...payLines(d),
      ``,
      `Any extra is credited to your balance. Nothing is charged: the balance goes up once the payment confirms.`,
      windowLine(d, ctx.sandbox),
      `Check progress with get_deposit (deposit_id ${d.id}).`,
    ].join("\n");
    return structuredOk(text, { deposit: d });
  });

// ── get_deposit ─────────────────────────────────────────────────────────────

function coinsText(coins: z.infer<typeof Coins>): string[] {
  if (coins.length === 0) return [`No coins are available for deposits right now.`];
  return [
    `Coins you can deposit (coin id, asset and network, minimum - maximum per deposit):`,
    ...coins.map((c) =>
      `  ${c.coin.padEnd(12)} ${`${c.asset} on ${c.network}`.padEnd(28)} ${formatUsd(c.min_amount_cents)} - ${formatUsd(c.max_amount_cents)}`,
    ),
  ];
}

function depositsText(deposits: DepositT[]): string[] {
  if (deposits.length === 0) return [`No deposits yet.`];
  const open = deposits.filter(takesPayment);
  return [
    `Newest deposits:`,
    ...deposits.map((d) =>
      `  ${d.id.padEnd(40)} ${d.status.padEnd(16)} ${formatUsd(d.amount_cents).padStart(10)}  ${d.coin.padEnd(12)} ${d.created_at.slice(0, 16)}`,
    ),
    ...(open.length
      ? [``, `Still taking payments: ${open.map((d) => d.id).join(", ")}. Reuse one rather than creating another; get_deposit with its deposit_id shows where to pay.`]
      : []),
  ];
}

export const getDepositHandler = (ctx: ToolContext) =>
  wrapToolErrors(ctx, async (args: { deposit_id?: string }): Promise<ToolResult> => {
    if (args.deposit_id) {
      let raw: { deposit: unknown };
      try {
        raw = await callApi<{ deposit: unknown }>(ctx.http, "GET", path`/v1/deposits/${args.deposit_id}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          const hint = ctx.statelessSandbox ? ` ${statelessSandboxNote(ctx.statelessSandbox.playgroundUrl)}` : "";
          return toolError(`No deposit ${args.deposit_id} was found on this account. get_deposit without a deposit_id lists the newest.${reqLine(e)}${hint}`);
        }
        throw e;
      }
      const d = Deposit.parse(raw.deposit);
      return structuredOk(renderDeposit(d, ctx.sandbox), { deposit: d });
    }

    let coins: z.infer<typeof Coins>;
    let deposits: DepositT[];
    try {
      const [coinData, listData] = await Promise.all([
        callApi<{ coins: unknown }>(ctx.http, "GET", "/v1/deposit_coins"),
        callApi<{ deposits: unknown }>(ctx.http, "GET", `/v1/deposits?limit=${NEWEST_DEPOSITS}`),
      ]);
      coins = Coins.parse(coinData.coins);
      deposits = Deposits.parse(listData.deposits);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return toolError(`${unavailableText(ctx)}${reqLine(e)}`);
      throw e;
    }
    const next = levelAllows(ctx.level, "manage")
      ? `To add funds, create_deposit with a coin id and amount_cents (ask the user which coin and how much unless they said), or the user can add funds at ${ctx.depositUrl}.`
      : `To add funds, the user goes to ${ctx.depositUrl}.`;
    const text = [...coinsText(coins), ``, ...depositsText(deposits), ``, next].join("\n");
    return structuredOk(text, { coins, deposits });
  });

// ── registration ────────────────────────────────────────────────────────────

export function registerDepositTools(server: McpServer, ctx: ToolContext) {
  defineTool(server, ctx, "create_deposit", {
    group: "core",
    level: "manage",
    title: "Add funds with a crypto deposit",
    description:
      "Create a deposit to add funds to the prepaid balance with crypto. Returns the exact amount to send, the network, the address and the deadline, " +
      "plus the payment window in the VoidMob dashboard where the user can check the address. " +
      "Payment comes from a crypto wallet: the user's, or their own automation's. The balance goes up once the payment confirms, and any extra is credited too. " +
      "It spends nothing, so it needs no purchase approval, but ask the user which coin and how much unless they said. " +
      "Keep at most one open deposit: check get_deposit first and reuse one that still takes payments. " +
      "After a purchase is refused for a low balance, offer a deposit rather than creating one.",
    inputSchema: {
      coin: z.string().min(2).max(40).describe("Coin id from get_deposit (e.g. 'ltc', 'btc', 'usdt_trc20')"),
      amount_cents: z.number().int().min(1).max(1_000_000).describe(
        "Amount to add in US cents (2000 = $20.00). Each coin has a minimum (get_deposit lists them).",
      ),
    },
    outputSchema: DepositOutput,
    // Opens a payment request on the account: not a read, and nothing to undo.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, createDepositHandler(ctx));

  defineTool(server, ctx, "get_deposit", {
    group: "core",
    level: "view",
    title: "Deposit status and coins",
    description:
      "With deposit_id: one deposit's status (awaiting_payment, confirming, underpaid, credited, expired), where and how much to pay, " +
      "how much more to send to complete an underpaid deposit, and what was credited. " +
      `Without it: the coins you can deposit with their minimum and maximum, and the ${NEWEST_DEPOSITS} newest deposits, so an open one can be reused instead of creating another.`,
    inputSchema: {
      deposit_id: DepositId.optional().describe("A dep_... id; leave out to list the coins and the newest deposits"),
    },
    outputSchema: GetDepositOutput,
    annotations: READ_ONLY,
  }, getDepositHandler(ctx));
}

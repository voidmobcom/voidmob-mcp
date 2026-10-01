import { ZodError } from "zod";
import { HttpError, NetworkError, isWriteMethod } from "../client/http.js";
import { formatUsd } from "../utils/format.js";

/**
 * A refusal decided by this server before (or instead of) charging anything.
 * Tools render its message as a normal tool error; nothing was charged.
 */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

// Error codes a write can return with a 5xx status that still mean "nothing
// was charged, or the charge was already refunded".
const NO_CHARGE_5XX = new Set([
  "SERVICE_OUT_OF_STOCK",
  "OUT_OF_STOCK_AT_PRICE",
  "PRODUCT_UNAVAILABLE",
  "PROVISIONING_FAILED",
  "PROVIDER_TIMEOUT",
]);

/**
 * True only when the failure proves nothing was charged. Anything uncertain
 * (no verdict, an in-flight replay, a 5xx without a refund promise, a success
 * response we could not parse) is false, so the budget counts it.
 */
export function isDefinitelyNotCharged(err: unknown): boolean {
  if (err instanceof ToolRefusal) return true;
  if (err instanceof NetworkError) return !isWriteMethod(err.method);
  if (err instanceof HttpError) {
    if (!isWriteMethod(err.meta.method)) return true;
    if (err.code === "IDEMPOTENCY_REPLAY_IN_FLIGHT" || err.code === "UNKNOWN_ERROR") return false;
    if (err.status < 500) return true;
    return NO_CHARGE_5XX.has(err.code);
  }
  if (err instanceof ZodError) return false;
  return false;
}

export interface SpendLimits {
  maxOrderCents: number | null;
  budgetCents: number | null;
}

/** What the money-moving code reports back once the API has answered. */
export interface Charged<T> {
  value: T;
  /** The amount the response says was charged; omit when it does not say. */
  chargedCents?: number;
}

const SAFETY_NET =
  "This is a per-session safety net set by the owner in this MCP server's configuration, not a VoidMob account limit";

/**
 * Owner-set spend limits for one server process. Every money-moving tool runs
 * its API call through `run`, which refuses before any request when the
 * per-order limit or the session budget would be exceeded. In-flight
 * purchases reserve their max price, so concurrent calls cannot overshoot.
 */
export class SpendGuard {
  private counted = 0;
  private reserved = 0;

  constructor(private readonly limits: SpendLimits) {}

  get maxOrderCents(): number | null {
    return this.limits.maxOrderCents;
  }

  get budgetCents(): number | null {
    return this.limits.budgetCents;
  }

  /** Spend counted this session (charges, plus max prices of uncertain outcomes). */
  get countedCents(): number {
    return this.counted;
  }

  /** Budget left for new purchases, or null when no budget is set. */
  get remainingCents(): number | null {
    if (this.limits.budgetCents === null) return null;
    return Math.max(0, this.limits.budgetCents - this.counted - this.reserved);
  }

  /** The refusal text for a purchase with this max price, or null when it may go ahead. */
  check(maxPriceCents: number): string | null {
    const { maxOrderCents, budgetCents } = this.limits;
    if (maxOrderCents !== null && maxPriceCents > maxOrderCents) {
      return (
        `Refused before buying: max_price_cents ${maxPriceCents} (${formatUsd(maxPriceCents)}) is above this server's ` +
        `per-order limit of ${formatUsd(maxOrderCents)} (VOIDMOB_MAX_ORDER_CENTS). Nothing was charged. ` +
        `Pick a cheaper option, or ask the owner whether they want to raise the limit (it is set in the MCP server config).`
      );
    }
    if (budgetCents !== null) {
      const remaining = Math.max(0, budgetCents - this.counted - this.reserved);
      if (maxPriceCents > remaining) {
        return (
          `Refused before buying: this purchase could cost up to ${formatUsd(maxPriceCents)}, but only ${formatUsd(remaining)} ` +
          `is left of this session's ${formatUsd(budgetCents)} budget (VOIDMOB_BUDGET_CENTS; ${formatUsd(this.counted)} counted so far). ` +
          `Nothing was charged. ${SAFETY_NET}: the account balance may be higher. ` +
          `Tell the user; only the owner can raise it, by changing the setting and restarting the server.`
        );
      }
    }
    return null;
  }

  /** Whether turning on auto-renew has to pass autoRenewRefusal first. */
  get limitsAutoRenew(): boolean {
    return this.limits.maxOrderCents !== null || this.limits.budgetCents !== null;
  }

  /**
   * Refusal text for turning on auto-renew, or null. Each renewal is a
   * charge, so it must fit the per-order limit. Renewals are charged later,
   * outside this server process, so a session budget cannot count them: with
   * a budget set, auto-renew stays off.
   */
  autoRenewRefusal(renewalCents: number | null): string | null {
    const { maxOrderCents, budgetCents } = this.limits;
    if (budgetCents !== null) {
      return (
        `Refused: auto-renew cannot be turned on while this server has a session budget (VOIDMOB_BUDGET_CENTS), ` +
        `because renewals are charged later, outside this session, where the budget cannot count them. Nothing was changed. ` +
        `The account owner can turn auto-renew on in the dashboard.`
      );
    }
    if (maxOrderCents !== null && (renewalCents === null || renewalCents > maxOrderCents)) {
      return (
        `Refused: each renewal would cost ${renewalCents === null ? "an unknown amount" : formatUsd(renewalCents)}, ` +
        `and this server's per-order limit is ${formatUsd(maxOrderCents)} (VOIDMOB_MAX_ORDER_CENTS). Nothing was changed.`
      );
    }
    return null;
  }

  /**
   * Run one money-moving API call under the limits. Counts the charged amount
   * the response reports, or the full max price when the response does not
   * say or the outcome is uncertain. Releases the reservation when the
   * failure proves nothing was charged.
   */
  async run<T>(maxPriceCents: number, fn: () => Promise<Charged<T>>): Promise<T> {
    const refusal = this.check(maxPriceCents);
    if (refusal) throw new ToolRefusal(refusal);
    this.reserved += maxPriceCents;
    let settled = 0;
    try {
      const out = await fn();
      settled = typeof out.chargedCents === "number" && Number.isFinite(out.chargedCents) && out.chargedCents >= 0
        ? out.chargedCents
        : maxPriceCents;
      return out.value;
    } catch (err) {
      settled = isDefinitelyNotCharged(err) ? 0 : maxPriceCents;
      throw err;
    } finally {
      this.reserved -= maxPriceCents;
      this.counted += settled;
    }
  }
}

export function describeLimits(guard: SpendGuard, readOnly: boolean): string[] {
  const lines: string[] = [];
  if (readOnly) lines.push(`    Read-only:       on (tools that spend or change anything are not available)`);
  if (guard.maxOrderCents !== null) lines.push(`    Max per order:   ${formatUsd(guard.maxOrderCents)}`);
  if (guard.budgetCents !== null) {
    lines.push(
      `    Session budget:  ${formatUsd(guard.remainingCents ?? 0)} left of ${formatUsd(guard.budgetCents)} ` +
      `(${formatUsd(guard.countedCents)} counted; resets when the server restarts)`,
    );
  }
  return lines.length ? [``, `  Owner limits (this MCP server session, not account limits):`, ...lines] : [];
}

import { HttpError, NetworkError, isWriteMethod } from "./http.js";
import { formatUsd } from "../utils/format.js";

const SETUP_URL = "https://dashboard.voidmob.com/developers/api-keys";
const WALLET_URL = "https://dashboard.voidmob.com/wallet";

// A write that got no verdict may still have been applied (and charged).
const UNCERTAIN_WRITE =
  "No confirmation came back, so this request may or may not have gone through - a purchase may already be charged. " +
  "Do not repeat it yet: first check list_orders, the matching get tool or get_account (balance), " +
  "and only buy again once you have confirmed nothing was bought.";

const CHECK_BEFORE_REBUY =
  "check list_orders, the matching get tool or get_account (balance) before buying again";

function retryAfterSeconds(err: HttpError): number | undefined {
  for (const v of [err.details?.retry_after_seconds, err.details?.paused_for_seconds, err.meta.retryAfterSeconds]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.ceil(v);
  }
  return undefined;
}

export function mapApiError(err: unknown): string {
  if (err instanceof NetworkError) {
    return isWriteMethod(err.method)
      ? UNCERTAIN_WRITE
      : "Could not reach dashboard.voidmob.com. Check your connection and retry.";
  }
  if (!(err instanceof HttpError)) {
    return `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  }

  const reqLine = err.requestId ? ` (request_id: ${err.requestId})` : "";
  const wait = retryAfterSeconds(err);
  const write = isWriteMethod(err.meta.method);

  switch (err.code) {
    case "UNAUTHENTICATED":
      return `Your VOIDMOB_API_KEY is invalid or revoked. Generate a new key at ${SETUP_URL}${reqLine}`;
    case "IP_NOT_ALLOWED":
      return `This API key only accepts requests from allowlisted IP addresses, and this machine's IP is not on the list. Contact VoidMob support to change the allowlist${reqLine}`;
    case "RATE_LIMITED":
      if (typeof err.details?.paused_for_seconds === "number") {
        return `Requests from this account are paused for ${wait}s after repeated rate-limit hits. Wait ${wait}s before sending any request${reqLine}`;
      }
      return `Rate limit reached. ${wait ? `Wait ${wait}s before retrying` : "Wait a few seconds before retrying"}${reqLine}`;
    case "INSUFFICIENT_BALANCE":
      return `Your VoidMob balance is too low for this purchase. Nothing was charged. Ask the account owner to top up at ${WALLET_URL}, then retry${reqLine}`;
    case "PRICE_OVER_CAP": {
      const max = err.details?.max_price_cents as number | undefined;
      const avail = err.details?.available_price_cents as number | undefined;
      const next = "Nothing was charged. Confirm the new price with the user, then re-run the tool to buy at the current price";
      if (max !== undefined && avail !== undefined) {
        return `Price moved from ${formatUsd(max)} to ${formatUsd(avail)} between quote and purchase. ${next}${reqLine}`;
      }
      // eSIM emits only available_price_cents (no max). Still surface the
      // concrete current price rather than a vague "above your cap".
      if (avail !== undefined) {
        return `Price moved above your quote (now ${formatUsd(avail)}). ${next}${reqLine}`;
      }
      return `Price moved above your quote. ${next}${reqLine}`;
    }
    case "PRICE_MISMATCH":
      return `The current price is above the quoted maximum, so nothing was charged. Check the current price again (search_proxies, or get_proxy_status for a renewal) and confirm it with the user before retrying${reqLine}`;
    case "SERVICE_OUT_OF_STOCK":
    case "OUT_OF_STOCK_AT_PRICE":
      if (err.details?.reason === "throttled") {
        return `Numbers for this service are in stock but purchases are arriving faster than they can be placed. Nothing was charged. Wait ${wait ?? 5}s before retrying - retrying sooner only extends the wait${reqLine}`;
      }
      return `No stock available right now. Nothing was charged. Try again in a minute or two, or pick a different service or plan${reqLine}`;
    case "CANCEL_WINDOW_NOT_OPEN":
      return `Cancellation is not available yet. ${wait ? `Try again in ${wait}s` : "Try again shortly"}${reqLine}`;
    case "CANCEL_NOT_ALLOWED":
      return `This can no longer be cancelled. A verification can only be cancelled before any SMS arrives (one that gets no SMS is refunded automatically when its window closes), and a long-term rental only within 60 minutes of purchase${reqLine}`;
    case "IDEMPOTENCY_REPLAY_IN_FLIGHT":
      return `The original request is still being processed and may still complete, including its charge. Do not repeat it: wait ${wait ?? 5}s, then ${CHECK_BEFORE_REBUY}${reqLine}`;
    case "PROVIDER_TIMEOUT":
    case "PROVISIONING_FAILED":
      return `The order could not be completed, and its charge was refunded to your balance. You can retry${reqLine}`;
    case "PROVIDER_ERROR":
      return `Temporary service error. Please retry shortly${reqLine}`;
    case "INTERNAL_ERROR":
      return write
        ? `Unexpected error. Before retrying, ${CHECK_BEFORE_REBUY}; if this persists, contact support${reqLine}`
        : `Unexpected error. Please retry; if this persists, contact support${reqLine}`;
    case "UNKNOWN_ERROR":
      // No API envelope: a gateway answered, not the API, so a write's outcome is unknown.
      if (write) return `${UNCERTAIN_WRITE}${reqLine}`;
      return `${err.message ?? err.code}${reqLine}`;
    default:
      // Pass the API's white-labeled message through unchanged
      return `${err.message ?? err.code}${reqLine}`;
  }
}

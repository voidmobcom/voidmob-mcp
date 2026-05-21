import { HttpError, NetworkError } from "./http.js";
import { formatUsd } from "../utils/format.js";

const SETUP_URL = "https://dashboard.voidmob.com/settings/api-keys";
const WALLET_URL = "https://dashboard.voidmob.com/wallet";

export function mapApiError(err: unknown): string {
  if (err instanceof NetworkError) {
    return "Could not reach dashboard.voidmob.com. Check your connection and retry.";
  }
  if (!(err instanceof HttpError)) {
    return `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  }

  const reqLine = err.requestId ? ` (request_id: ${err.requestId})` : "";

  switch (err.code) {
    case "UNAUTHENTICATED":
      return `Your VOIDMOB_API_KEY is invalid or revoked. Generate a new key at ${SETUP_URL}${reqLine}`;
    case "IP_NOT_ALLOWED":
      return `This API key has an IP allowlist; the current IP is blocked. Update or remove the allowlist in the dashboard${reqLine}`;
    case "RATE_LIMITED":
      return `Rate limit hit. Retry shortly${reqLine}`;
    case "INSUFFICIENT_BALANCE":
      return `Insufficient balance. Top up at ${WALLET_URL}${reqLine}`;
    case "DAILY_SPEND_CAP_EXCEEDED":
      return `This API key's daily spend cap is reached. Raise the cap in the dashboard or wait for reset${reqLine}`;
    case "PRICE_OVER_CAP": {
      const max = err.details?.max_price_cents as number | undefined;
      const avail = err.details?.available_price_cents as number | undefined;
      if (max !== undefined && avail !== undefined) {
        return `Price moved from ${formatUsd(max)} to ${formatUsd(avail)} between quote and purchase. Re-run the tool to accept the new price${reqLine}`;
      }
      return `Price moved above your cap. Re-run the tool to accept the new price${reqLine}`;
    }
    case "SERVICE_OUT_OF_STOCK":
    case "OUT_OF_STOCK_AT_PRICE":
      return `No stock available right now. Try again in a few minutes or pick a different service${reqLine}`;
    case "CANCEL_WINDOW_NOT_OPEN":
      return `Cancellation cooldown active. Try again in ~30s${reqLine}`;
    case "PROVIDER_TIMEOUT":
    case "PROVISIONING_FAILED":
      return `Provider request timed out. Your funds were refunded. Retry${reqLine}`;
    case "PROVIDER_ERROR":
      return `Service error. Please retry shortly${reqLine}`;
    case "INTERNAL_ERROR":
      return `Unexpected error. Please retry; if this persists, contact support${reqLine}`;
    default:
      // Pass the API's white-labeled message through unchanged
      return `${err.message ?? err.code}${reqLine}`;
  }
}

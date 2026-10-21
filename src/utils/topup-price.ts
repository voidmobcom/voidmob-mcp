// ── Shared proxy top-up price ──

export interface TopupPrice {
  additional_gb: number;
  price_cents: number;
  days_added: number;
}

/**
 * The charge for an N GB shared top-up, from the proxy's `topup_prices` (the
 * API's exact charges for 1, 10, 25, 50 and 100 GB, discount included). Any
 * other size follows the API's rule: the per-GB rate of the largest listed
 * size below it, never more than the next listed size. `exact` is false for
 * those, where discount rounding can move the charge by a cent.
 */
export function topupQuote(prices: TopupPrice[], gb: number): { cents: number; exact: boolean } | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a.additional_gb - b.additional_gb);
  const hit = sorted.find((p) => p.additional_gb === gb);
  if (hit) return { cents: hit.price_cents, exact: true };
  let i = sorted.length - 1;
  while (i > 0 && sorted[i].additional_gb > gb) i--;
  const base = sorted[i];
  const prorated = Math.round((base.price_cents / base.additional_gb) * gb);
  const next = sorted[i + 1];
  return { cents: next ? Math.min(prorated, next.price_cents) : prorated, exact: false };
}

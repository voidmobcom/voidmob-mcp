import { z } from "zod";

/**
 * The caller's price commitment on every money-moving tool: the price the
 * agent showed the user and the user approved. The purchase is refused (and
 * nothing is charged) when the current price is higher.
 */
export const MaxPriceCents = z
  .number()
  .int()
  .positive()
  .max(1_000_000)
  .describe(
    "The price you showed the user and they approved, in US cents (e.g. 250 = $2.50). " +
    "Nothing is charged if the current price is higher; the new price comes back so you can ask the user again.",
  );

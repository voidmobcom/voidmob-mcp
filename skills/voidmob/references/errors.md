# Errors and recovery

Every error is `{"success": false, "error": {"code", "message", "request_id", "details"?}}`. Branch on `code`, not on `message`. `message` is safe to show the user. Quote `request_id` if the user contacts support. New codes can appear; treat an unknown code like the closest HTTP status below.

## Retrying a purchase safely

- **No response** (client timeout, dropped connection, unreadable body): send the same request again with the **same** `Idempotency-Key` and the same body. You get the original outcome and are never charged twice. `409 IDEMPOTENCY_REPLAY_IN_FLIGHT` means it is still running or the first attempt was dropped before it finished: wait `Retry-After` (5 s) and repeat once. If it still says this, check the order lists and `GET /me`; buy with a new key only once they show nothing was bought.
- **An error response**: that outcome is final for that key (a retry with the same key replays it). A new attempt needs a new key, and a new approval if the price changed. One exception: `SERVICE_UNAVAILABLE` on `POST /deposits` created nothing, so the same key may retry.
- **A 5xx on a purchase**: do not assume nothing happened. Check the matching list (`GET /verifications?status=waiting_for_code`, `/rentals`, `/dedicated/numbers`, `/proxies`, `/esims`) and `GET /me` before any new attempt.

## Codes

| Code | HTTP | Meaning | Next step |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | Key missing, malformed, unknown or revoked, or an app connection that was disconnected | Stop. Ask the user to check `VOIDMOB_API_KEY`, or to reconnect the app. Retrying the same credential never helps. |
| `PERMISSION_DENIED` | 403 | Key or app connection is below the permission level the call needs (`details.permission`, `details.required_permission`), or an app connection tried something connections can never do (`details.reason` `connection_not_allowed`) | Nothing was charged or changed. Tell the user; only the owner raises the level, at `details.settings_url`. For `connection_not_allowed`, use the dashboard or an API key. |
| `IP_NOT_ALLOWED` | 403 | Key is limited to other source IPs | Call from an allowed IP, or the user asks support to change the allowlist. |
| `FORBIDDEN` | 403 | Account restricted, or too many open verifications | If the message is about open verifications, wait for one to finish or complete it. Otherwise the user contacts support. |
| `RATE_LIMITED` | 429 | Per-minute limit hit, or a rotate_ip cooldown | Wait `Retry-After` seconds plus a little jitter. Ignoring 429s pauses the whole account for 10-60 minutes. |
| `VALIDATION_ERROR` | 400 | Bad body or header (often a missing `Idempotency-Key`), an unknown deposit coin, or a deposit under its coin's minimum (`details.min_amount_cents`) | Fix what `message` names and resend. For a deposit, pick a coin and amount from `GET /deposit_coins`. |
| `INSUFFICIENT_BALANCE` | 402 | Balance below the price | Stop. Tell the user the price and balance, and offer to add funds: a deposit (ask which coin and how much) or https://dashboard.voidmob.com/wallet. Then a new key. |
| `DEPOSIT_LIMIT_REACHED` | 429 | Too many open deposits (`details.reason` `open_deposits`) or too many created in 24 hours (`daily_deposits`); `details.limit` is the limit | Nothing was created. Reuse an open deposit (`GET /deposits`), or wait until one is paid or expires. |
| `ORDER_LIMIT_EXCEEDED`, `DAILY_SPEND_CAP_EXCEEDED` | 402 | Over the owner's per-order limit, or the daily limit over a rolling 24 hours, net of refunds | Nothing was charged. `details.limit_cents` and `details.remaining_cents` say how much is allowed; `details.settings_url` is where the owner raises it. Retry only after a raise, with a new key. |
| `PRICE_OVER_CAP` | 409 | Live price above `max_price_cents` (SMS, rentals, numbers, eSIM) | `details.available_price_cents` is the current price. Show it, ask again, retry with a new key. Nothing was charged. |
| `PRICE_MISMATCH` | 409 | Proxy price above `max_price_cents` | Re-read the plan or `next_renewal_price_cents`, ask again, new key. Nothing was charged. |
| `SERVICE_OUT_OF_STOCK` | 503 | No stock | `details.reason`: `no_stock` = try in a minute or two, or another option; `throttled` = wait `details.retry_after_seconds`. Dedicated proxy or number: pick another plan or country. |
| `OUT_OF_STOCK_AT_PRICE` | 503 | Nothing within your cap | Retry later or, with approval, a higher cap. |
| `PRODUCT_UNAVAILABLE` | 503 | eSIM plan temporarily unavailable | Retry later or choose another plan. |
| `IDEMPOTENCY_REPLAY_IN_FLIGHT` | 409 | Same key still processing, or the first attempt was dropped | Wait `Retry-After`, resend once with the same key and body; if it repeats, check the lists and `GET /me` before any new purchase. |
| `IDEMPOTENCY_CONFLICT` | 409 | Key reused with a different body | Do not just make a new key: first check whether the original purchase landed. |
| `SERVICE_NOT_FOUND`, `BAD_SERVICE` | 404, 422 | Unknown `service_id` | Re-list `GET /services?q=...`. |
| `LTR_NOT_AVAILABLE` | 404 | Rental duration not offered | Use a duration whose `ltr_*_price_cents` is non-zero. |
| `DEDICATED_NOT_AVAILABLE` | 404 | No dedicated numbers in that country | Re-list `GET /dedicated/countries`. |
| `CANCEL_NOT_ALLOWED` | 409 | Past the cancel window, or an SMS already arrived | No refund is due. Read the messages. |
| `ALREADY_COMPLETED` | 409 | A code arrived before the cancel | The number was used; read the code. |
| `CANCEL_WINDOW_NOT_OPEN` | 409 | Too early to cancel | Retry after the cooldown, or let the window close (no SMS = automatic refund). |
| `COMPLETE_NOT_ALLOWED` | 409 | Already completed or cancelled | Nothing to do. |
| `REUSE_NOT_ALLOWED` | 409 | Reuse not available now | Paid reuse was refunded automatically. Rent a fresh number (with approval). |
| `REUSE_RATE_LIMITED` | 429 | 30-second reuse cooldown | Wait `Retry-After`. |
| `NOT_SUPPORTED` | 422 | Action not available for this item (reuse on some services, top-up on a dedicated proxy, rotate_ip on a shared one) | Use the right action for the item type. |
| `RE_RENT_NOT_AVAILABLE` | 410 | Number released | Start a new rental. |
| `PROXY_NOT_READY` | 409 | Proxy still provisioning (or a shared-only endpoint on a dedicated proxy) | Poll `GET /proxies/{id}` until `active`. |
| `PROXY_EXPIRED`, `PROXY_EXHAUSTED` | 409 | Expired, or no GB left | With approval: shared can top up or renew (up to 7 days after expiry); otherwise buy new. |
| `PROXY_GEO_CONFLICT` | 400 | `countries` combined with region/city/isp/zip | Use one `country` with subfilters, or `countries` alone. |
| `PROXY_LIST_LIMIT_EXCEEDED` | 409 | 100 lists on this package | Delete unused lists. |
| `PROVISIONING_FAILED` | 502 | Proxy could not be set up | Refunded automatically. Ask before trying again with a new key. |
| `PARENT_ORDER_NOT_ACTIVE`, `TOPUP_INCOMPATIBLE` | 409 | eSIM cannot take this top-up | Re-list `GET /esims/{id}/topups`, or buy a new eSIM. |
| `ESIM_NOT_ACTIVE` | 422 | eSIM still processing or ended | Poll the order; usage works once it is installed and active. |
| `ESIM_GONE` | 410 | eSIM cancelled or refunded | `details.new_status` says which. |
| `USAGE_UNAVAILABLE` | 503 | Usage temporarily unreadable | Retry in a few minutes. |
| `VERIFICATION_NOT_FOUND`, `PROXY_NOT_FOUND`, `PROXY_PLAN_NOT_FOUND`, `PROXY_LIST_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ESIM_NOT_FOUND`, `PARENT_ORDER_NOT_FOUND`, `WEBHOOK_ENDPOINT_NOT_FOUND`, `NOT_FOUND` | 404 | Unknown id or not this account | Check the id prefix and re-list. |
| `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`, any other 5xx | 500-504 | Temporary failure | Reads: retry with backoff. Purchases: see "A 5xx on a purchase" above. |

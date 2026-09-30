# VoidMob MCP

[![npm version](https://img.shields.io/npm/v/@voidmob/mcp)](https://www.npmjs.com/package/@voidmob/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/node/v/@voidmob/mcp)](https://nodejs.org)

Mobile proxies, non-VoIP SMS verifications, dedicated numbers, and global eSIMs - exposed as 29 tools your AI agent can call directly.

```bash
npx -y @voidmob/mcp
```

## Setup

1. Generate an API key at https://dashboard.voidmob.com/developers/api-keys (keys are 32-char secrets prefixed `vmk_live_`).
2. Add the MCP to your client (snippets below). Provide the key as `VOIDMOB_API_KEY`.

### Claude Code

```bash
claude mcp add voidmob -e VOIDMOB_API_KEY=vmk_live_... -- npx -y @voidmob/mcp
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "voidmob": {
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"],
      "env": { "VOIDMOB_API_KEY": "vmk_live_..." }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "voidmob": {
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"],
      "env": { "VOIDMOB_API_KEY": "vmk_live_..." }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` (VS Code prompts for the key once and stores it securely):

```json
{
  "inputs": [
    { "type": "promptString", "id": "voidmob-api-key", "description": "VoidMob API key (vmk_live_...)", "password": true }
  ],
  "servers": {
    "voidmob": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"],
      "env": { "VOIDMOB_API_KEY": "${input:voidmob-api-key}" }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "voidmob": {
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"],
      "env": { "VOIDMOB_API_KEY": "vmk_live_..." }
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.voidmob]
command = "npx"
args = ["-y", "@voidmob/mcp"]
env = { VOIDMOB_API_KEY = "vmk_live_..." }
```

### Grok Bot

1. In your Bot's **Secrets**, add a secret named `VOIDMOB_API_KEY` with your key as the value.
2. In chat, send: *Add a custom MCP server called voidmob that runs: npx -y @voidmob/mcp*

Never paste the key itself into a chat.

## How money works

- **Prepaid balance.** Everything is paid from your USD balance, which you top up with crypto in the [dashboard](https://dashboard.voidmob.com/wallet). The MCP cannot add funds. The API key has no separate spend cap: your balance is the limit, so keep on it only what you are happy for an agent to spend.
- **Quote, then buy.** Search tools show your live prices. Every buy, renewal and top-up debits the balance immediately. A buy tool re-reads the live price just before buying and charges at most that price, which can differ from an earlier search; if it moves again in that moment, nothing is charged and the tool says so. Every result shows what was charged.
- **No double charges on retries.** Every purchase carries an idempotency key. If the connection drops, this MCP server retries once with the same key, which the API never charges twice.
- **When a result is uncertain,** the tool says the purchase may have gone through. Check `list_orders`, the matching get tool or `get_account` before buying again.
- **SMS verifications cost nothing if no SMS arrives.** A number stays open for up to 15 minutes and can receive several codes. If none arrives, the price is refunded automatically (status `cancelled`). Rare exception: services marked non-refundable end as `expired` without a refund. You can also cancel before any SMS arrives for a full refund; frequent cancellations can temporarily pause SMS purchasing.
- **Long-term rentals** can be cancelled with a full refund within 60 minutes of purchase.
- **Dedicated numbers** are billed monthly and cannot be cancelled; leave auto-renew off and the number simply expires at the end of the month.
- **eSIMs** cannot be cancelled through the MCP once issued. Contact support if one was bought by mistake and never installed.
- **Proxies** that cannot be provisioned are refunded automatically.

## Try without a key (sandbox)

```bash
VOIDMOB_SANDBOX=1 npx -y @voidmob/mcp
```

Boots in-memory mocks with a $500 play-money balance. Every tool works against fake data. State resets on restart.

## Configuration

| Env var | Purpose | Required |
|---|---|---|
| `VOIDMOB_API_KEY` | Bearer key from the dashboard | Live mode |
| `VOIDMOB_SANDBOX` | Set to `1` for mock-data mode | No |
| `VOIDMOB_DEBUG` | Set to `1` to log requests to stderr | No |
| `VOIDMOB_BASE_URL` | Override API host (advanced; must be `https://`, plain `http://` only for localhost) | No |

## Tools

29 tools across six domains.

### Account (1)

| Tool | Description |
|---|---|
| `get_account` | Balance, rate limits, and account id |

### SMS (7)

| Tool | Description |
|---|---|
| `search_sms_services` | List services with prices |
| `rent_number` | Rent a US number: one-time verification (15 min, refunded if no SMS) or long-term rental |
| `get_rental` | Read status, the latest code and received messages |
| `cancel_rental` | Cancel a verification (before any SMS) or long-term rental (within 60 min), with a full refund |
| `reuse_number` | Free or paid reuse of an earlier verification's number |
| `re_rent_rental` | Re-rent an expired long-term rental's number for another period |
| `toggle_auto_renew` | Turn auto-renewal on or off (rentals and dedicated numbers) |

### Dedicated numbers (3)

| Tool | Description |
|---|---|
| `search_dedicated_countries` | Countries, monthly prices, and stock |
| `purchase_dedicated_number` | Buy a private all-services monthly number |
| `get_dedicated_number` | Status and received SMS with parsed codes |

### eSIM (5)

| Tool | Description |
|---|---|
| `search_esim_plans` | Find global data plans |
| `purchase_esim` | Buy a plan |
| `get_esim_status` | Status, install details (LPA string) and data usage across all packages |
| `topup_esim` | Browse and buy top-ups |
| `get_esim_qr` | Fetch the activation QR as an inline image |

### Proxy (11)

| Tool | Description |
|---|---|
| `search_proxies` | List mobile (shared) and dedicated proxy plans, with dedicated stock |
| `purchase_proxy` | Buy a mobile or dedicated proxy |
| `get_proxy_status` | Status, usage, expiry, auto-renew and ready-to-paste connection URLs |
| `rotate_proxy_ip` | Rotate a dedicated proxy to a new IP |
| `renew_proxy` | Extend expiry at the proxy's current renewal price |
| `set_proxy_auto_renew` | Turn auto-renew on or off for a dedicated proxy |
| `topup_proxy` | Add data to a mobile proxy |
| `regenerate_proxy_password` | Rotate the gateway password |
| `list_proxy_lists` | List geo-targeted sub-pools |
| `create_proxy_list` | Create a geo-targeted sub-pool |
| `delete_proxy_list` | Remove a sub-pool |

### Discovery + history (2)

| Tool | Description |
|---|---|
| `get_geo` | Cascading country/region/city/ISP for targeting |
| `list_orders` | Recent SMS verifications and rentals, dedicated numbers, eSIMs and proxies |

## Example prompts

> Rent me a US number for Telegram verification

> Find an eSIM plan that covers all of Europe with at least 5GB for two weeks

> Show me my active proxies

> Top up esim_xxx with 5GB

## Sharing a key across processes

Multiple MCP clients running simultaneously (Claude Code + Cursor + Desktop) all share the same per-account rate limit. Heavy parallel usage may hit `RATE_LIMITED`; back off and retry.

---

<p align="center">
  <a href="https://voidmob.com">Website</a> · <a href="https://voidmob.com/docs">Docs</a> · <a href="https://voidmob.com/mcp">MCP</a> · <a href="https://dashboard.voidmob.com/api-reference">API reference</a> · MIT License
</p>

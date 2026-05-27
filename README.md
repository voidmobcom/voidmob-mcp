# VoidMob MCP

[![npm version](https://img.shields.io/npm/v/@voidmob/mcp)](https://www.npmjs.com/package/@voidmob/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/node/v/@voidmob/mcp)](https://nodejs.org)

Mobile proxies, non-VoIP SMS verifications, and global eSIMs - exposed as 25 tools your AI agent can call directly.

```bash
npx -y @voidmob/mcp
```

## Setup

1. Generate an API key at https://dashboard.voidmob.com/developers/api-keys (keys are 32-char secrets prefixed `vmk_live_`).
2. Add the MCP to your client (snippets below). Provide the key as `VOIDMOB_API_KEY`.

### Claude Code

```bash
claude mcp add voidmob -- env VOIDMOB_API_KEY=vmk_live_... npx -y @voidmob/mcp
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
| `VOIDMOB_BASE_URL` | Override API host (advanced) | No |

## Tools

25 tools across five domains.

### Account (1)

| Tool | Description |
|---|---|
| `get_account` | Balance, rate limits, and account id |

### SMS (7)

| Tool | Description |
|---|---|
| `search_sms_services` | List services with prices |
| `rent_number` | Rent a US number (verification / rental / dedicated) |
| `get_rental` | Read status and received messages |
| `cancel_rental` | Cancel a verification or long-term rental |
| `reuse_number` | Free or paid reuse of a completed verification |
| `re_rent_rental` | Extend a long-term rental for another period |
| `toggle_auto_renew` | Turn auto-renewal on or off |

### eSIM (5)

| Tool | Description |
|---|---|
| `search_esim_plans` | Find global data plans |
| `purchase_esim` | Buy a plan |
| `get_esim_status` | Status and data usage |
| `topup_esim` | Browse and buy top-ups |
| `get_esim_qr` | Fetch the activation QR as an inline image |

### Proxy (10)

| Tool | Description |
|---|---|
| `search_proxies` | List available mobile proxy plans |
| `purchase_proxy` | Buy a mobile proxy |
| `get_proxy_status` | Status, usage, and gateway credentials |
| `rotate_proxy_ip` | Rotate a dedicated proxy to a new IP |
| `renew_proxy` | Extend expiry |
| `topup_proxy` | Add data |
| `regenerate_proxy_password` | Rotate the gateway password |
| `list_proxy_lists` | List geo-targeted sub-pools |
| `create_proxy_list` | Create a geo-targeted sub-pool |
| `delete_proxy_list` | Remove a sub-pool |

### Discovery + history (2)

| Tool | Description |
|---|---|
| `get_geo` | Cascading country/region/city/ISP for targeting |
| `list_orders` | Active SMS / eSIM / proxy orders |

## Example prompts

> Rent me a US number for Telegram verification

> Find an eSIM plan that covers all of Europe with at least 5GB for two weeks

> Show me my active proxies

> Top up esim_xxx with 5GB

## Sharing a key across processes

Multiple MCP clients running simultaneously (Claude Code + Cursor + Desktop) all share the same per-account rate limit. Heavy parallel usage may hit `RATE_LIMITED`; back off and retry.

## Support

- Website: https://voidmob.com
- MCP guide: https://voidmob.com/mcp
- API docs: https://dashboard.voidmob.com/developers/docs
- Issues: https://github.com/voidmobcom/voidmob-mcp/issues

---

<p align="center">
  <a href="https://voidmob.com">Website</a> · <a href="https://voidmob.com/mcp">MCP</a> · <a href="https://github.com/voidmobcom/voidmob-mcp">GitHub</a> · <a href="https://x.com/voidmob_com">X (Twitter)</a> · MIT License
</p>

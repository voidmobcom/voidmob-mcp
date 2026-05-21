# VoidMob MCP

Mobile proxies, non-VoIP SMS verifications, and global eSIMs - exposed as 25 tools your AI agent can call directly.

```bash
npx -y @voidmob/mcp
```

## Setup

1. Generate an API key at https://dashboard.voidmob.com/settings/api-keys (keys are 32-char secrets prefixed `vmk_live_`).
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

Boots in-memory mocks with a $50 starting balance. Every tool works against fake data. State resets on restart.

## Configuration

| Env var | Purpose | Required |
|---|---|---|
| `VOIDMOB_API_KEY` | Bearer key from the dashboard | Live mode |
| `VOIDMOB_SANDBOX` | Set to `1` for mock-data mode | No |
| `VOIDMOB_DEBUG` | Set to `1` to log requests to stderr | No |
| `VOIDMOB_BASE_URL` | Override API host (advanced) | No |

## Tools

### Account (1)
- `get_account` - balance, rate limits, account id

### SMS (7)
- `search_sms_services` - list services with prices
- `rent_number` - rent a US number (verification / rental / dedicated)
- `get_rental` - read status + messages
- `cancel_rental` - cancel a verification or LTR
- `reuse_number` - free or paid reuse of a completed verification
- `re_rent_rental` - extend an LTR for another period
- `toggle_auto_renew` - turn auto-renewal on/off

### eSIM (5)
- `search_esim_plans` - find global data plans
- `purchase_esim` - buy a plan
- `get_esim_status` - status + usage
- `topup_esim` - browse and buy top-ups
- `get_esim_qr` - fetch activation QR as inline image

### Proxy (10)
- `search_proxies` - list available plans
- `purchase_proxy` - buy a mobile proxy
- `get_proxy_status` - status + usage + gateway creds
- `rotate_proxy_ip` - rotate to a new IP (dedicated)
- `renew_proxy` - extend expiry
- `topup_proxy` - add data
- `regenerate_proxy_password` - rotate gateway password
- `list_proxy_lists` - geo-targeted sub-pools
- `create_proxy_list` - new sub-pool
- `delete_proxy_list` - remove a sub-pool

### Discovery + history (2)
- `get_geo` - cascading country/region/city/ISP for targeting
- `list_orders` - active SMS / eSIM / proxy orders

## Example prompts

> Rent me a US number for Telegram verification

> Find an eSIM plan that covers all of Europe with at least 5GB for two weeks

> Show me my active proxies

> Top up esim_xxx with 5GB

## Sharing a key across processes

Multiple MCP clients running simultaneously (Claude Code + Cursor + Desktop) all share the same per-account rate limit. Heavy parallel usage may hit `RATE_LIMITED`; back off and retry.

## Versioning

Semver. Tools target API v1. Major bumps signal removed/renamed tools; minor adds. See https://github.com/voidmobcom/voidmob-mcp/releases.

## Support

- API docs: https://dashboard.voidmob.com/docs
- Issues: https://github.com/voidmobcom/voidmob-mcp/issues

MIT License.

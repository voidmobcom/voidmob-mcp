# VoidMob MCP

Mobile proxies, non-VoIP SMS verifications, and global eSIMs for AI agents and MCP clients.

```bash
npx -y @voidmob/mcp
```

## Quick Start

Add VoidMob to your MCP client. No auth, no config, no API key.

### Claude Code

```bash
claude mcp add voidmob -- npx -y @voidmob/mcp
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "voidmob": {
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"]
    }
  }
}
```

### Claude Desktop

Add to your config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "voidmob": {
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"]
    }
  }
}
```

Restart your client. You now have 23 tools for mobile proxies, SMS verification, eSIM, and wallet operations.

## Available Tools

### Mobile Proxies (8 tools)

| Tool | Description |
|------|-------------|
| `search_proxies` | Search mobile proxy products by country or type (shared, dedicated standard, dedicated premium) |
| `purchase_proxy` | Purchase a mobile proxy and get connection credentials |
| `get_proxy_status` | Check bandwidth usage, connection details, and IP |
| `rotate_proxy` | Rotate to a new IP address (dedicated proxies only) |
| `get_proxy_lists` | Get geo-targeted proxy lists for a shared proxy |
| `create_proxy_list` | Create a new proxy list with location targeting |
| `get_openvpn_config` | Get OpenVPN configuration file for a dedicated proxy |
| `get_vless_config` | Get VLESS connection URI for a dedicated premium proxy |

### SMS - US Non-VoIP (7 tools)

| Tool | Description |
|------|-------------|
| `search_sms_services` | Search US non-VoIP SMS services with verification, rental, and dedicated pricing |
| `get_sms_price` | Get all pricing tiers for a specific service |
| `rent_number` | Rent a US number - verification (20min), long-term rental (3-30 days), or dedicated (28 days) |
| `get_messages` | Check for incoming SMS messages on a rented number |
| `cancel_rental` | Cancel a rental (full refund for verification with no messages) |
| `reuse_number` | Reuse a completed number to receive another SMS |
| `toggle_auto_renew` | Toggle auto-renewal for long-term rentals and dedicated numbers |

### eSIM (5 tools)

| Tool | Description |
|------|-------------|
| `search_esim_plans` | Search eSIM data plans by country, data amount, duration, or features (5G, hotspot) |
| `get_esim_plan_details` | Get full plan details including network type, speed, and activation policy |
| `purchase_esim` | Purchase an eSIM plan and get QR code, activation code, and ICCID |
| `get_esim_usage` | Check data usage and remaining balance for an active eSIM |
| `topup_esim` | Browse available top-up products or purchase a top-up for an active eSIM |

### Wallet (2 tools)

| Tool | Description |
|------|-------------|
| `get_balance` | Get wallet balance in USD and cents |
| `deposit` | Create a crypto deposit (BTC, ETH, SOL, USDT, USDC, LTC, DOGE) |

### General (1 tool)

| Tool | Description |
|------|-------------|
| `list_orders` | List all orders across SMS, eSIM, and proxy services with filtering |

## Example Conversations

These are things you can ask Claude, Cursor, or any MCP client after adding VoidMob:

> Set up a dedicated US mobile proxy and give me the credentials

> Rotate my US dedicated proxy IP

> Create a US-only proxy list on my shared proxy

> Get the OpenVPN config for my US dedicated proxy

> What VLESS connection options do I have for my premium proxy?

> Rent me a dedicated US phone number that receives from all services

> Set up a 7-day WhatsApp rental with auto-renew

> Check if my verification code arrived

> Find eSIM plans that cover all of Europe with at least 5GB

> Find the cheapest eSIM plan for 2 weeks in Japan with at least 5GB

> Top up my Japan eSIM with more data

> Show me all my active orders

## Sandbox Mode

VoidMob MCP currently runs in **sandbox mode**. All 23 tools work, but the data is mock.

- **$50 starting balance** - enough to try every tool
- **Stateful** - renting a number deducts balance, messages appear after a few seconds, deposits auto-confirm
- **Deposits auto-confirm** in ~5 seconds
- **State resets** on server restart
- **No auth required** - zero config, just `npx -y @voidmob/mcp`

The sandbox is designed to let you explore the full flow: deposit funds, rent a number, receive a verification code, check your balance. Everything behaves like the real API, just with mock data underneath.

## API Access

Currently in sandbox mode. Join the waitlist at [voidmob.com](https://voidmob.com) for early API access.

---

<p align="center">
  <a href="https://voidmob.com">Website</a> · <a href="https://github.com/voidmobcom/voidmob-mcp">GitHub</a> · <a href="https://x.com/voidmob_com">X (Twitter)</a> · MIT License
</p>

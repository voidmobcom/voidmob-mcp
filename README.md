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

Restart your client. You now have 18 tools for mobile proxies, SMS verification, eSIM, and wallet operations.

## Available Tools

### Mobile Proxies

| Tool | Description |
|------|-------------|
| `search_proxies` | Search mobile proxy options by country or type |
| `get_proxy_pricing` | Get detailed pricing for a proxy type + country |
| `purchase_proxy` | Purchase a mobile proxy (pay-per-GB or dedicated monthly) |
| `get_proxy_status` | Check bandwidth usage and connection details |
| `rotate_proxy` | Rotate to a new IP address |

### SMS (US non-VoIP)

| Tool | Description |
|------|-------------|
| `search_sms_services` | Search US non-VoIP SMS verification services by name or category |
| `get_sms_price` | Get pricing for a US non-VoIP SMS verification service |
| `rent_number` | Rent a US non-VoIP phone number for verification (5 min expiry) |
| `get_messages` | Check for incoming SMS messages on a rented number |
| `cancel_rental` | Cancel a rental (full refund if no messages received) |

### eSIM

| Tool | Description |
|------|-------------|
| `search_esim_plans` | Search eSIM data plans by country, duration, or data amount |
| `get_esim_plan_details` | Get full plan details including APN and top-up info |
| `purchase_esim` | Purchase an eSIM plan and get a QR code for installation |
| `get_esim_usage` | Check data usage, remaining balance, and time left |
| `topup_esim` | Add more data to an active eSIM order |

### Wallet

| Tool | Description |
|------|-------------|
| `get_balance` | Get wallet balance and recent transactions |
| `deposit` | Create a crypto deposit (BTC, ETH, SOL) |

### General

| Tool | Description |
|------|-------------|
| `list_orders` | List all orders across SMS, eSIM, and proxy services |

## Example Conversations

These are things you can ask Claude, Cursor, or any MCP client after adding VoidMob:

> Set up a dedicated US mobile proxy and give me the credentials

> Rotate my US dedicated proxy IP

> How much does a 5GB eSIM plan in the UK cost?

> Rent me a US phone number for WhatsApp verification

> Check if my verification code arrived

> Find the cheapest eSIM plan for 2 weeks in Japan with at least 5GB

> Show me all my active orders

## Sandbox Mode

VoidMob MCP currently runs in **sandbox mode**. Everything works, but the data is mock.

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

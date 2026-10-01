# VoidMob MCP

[![npm version](https://img.shields.io/npm/v/@voidmob/mcp)](https://www.npmjs.com/package/@voidmob/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/node/v/@voidmob/mcp)](https://nodejs.org)

Mobile proxies, non-VoIP SMS verifications, dedicated numbers, and global eSIMs - exposed as 30 tools your AI agent can call directly, plus short guides (resources) and guided prompts.

```bash
npx -y @voidmob/mcp
```

## Setup

1. Generate an API key at https://dashboard.voidmob.com/developers/api-keys (keys are 32-char secrets prefixed `vmk_live_`) and top up the balance with crypto at https://dashboard.voidmob.com/wallet.
2. Add the MCP to your client (snippets below). Provide the key as `VOIDMOB_API_KEY`.
3. Optional: set a per-order limit and a session budget with the [owner controls](#owner-controls).

Step-by-step guides per client and agent runtime: [voidmob.com/mcp](https://voidmob.com/mcp) and [voidmob.com/integrations](https://voidmob.com/integrations).

### Claude Code

```bash
claude mcp add voidmob -s user -e VOIDMOB_API_KEY=vmk_live_... -- npx -y @voidmob/mcp
```

`-s user` makes the server available in every project; the key goes after `-e` and before `--`.

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

**One-click bundle.** Download `voidmob-mcp.mcpb` from the [latest GitHub release](https://github.com/voidmobcom/voidmob-mcp/releases/latest) and open it (or drag it into Claude Desktop, or use Settings > Extensions > Advanced > Install Extension). Claude Desktop asks for the settings: API key (stored securely), sandbox mode, read-only, max per order and session budget (see [Owner controls](#owner-controls)). Build it yourself with `npm run pack:mcpb`.

**Or by config file.** Open Settings > Developer > Edit Config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add:

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

### Windsurf (Devin Desktop)

Open the MCP config from the Cascade panel menu (Open MCP config file). Current Devin Desktop builds keep it at `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`); Windsurf builds from before the rename use `~/.codeium/windsurf/mcp_config.json`. Add:

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

```bash
codex mcp add voidmob --env VOIDMOB_API_KEY=vmk_live_... -- npx -y @voidmob/mcp
```

Or add to `~/.codex/config.toml` (shared by the Codex CLI, the IDE extension and the ChatGPT desktop app):

```toml
[mcp_servers.voidmob]
command = "npx"
args = ["-y", "@voidmob/mcp"]
env = { VOIDMOB_API_KEY = "vmk_live_..." }
```

### Gemini CLI

Add to `~/.gemini/settings.json`, and export `VOIDMOB_API_KEY` in your shell (Gemini CLI hides variables named like a key from MCP servers unless the server's `env` lists them):

```json
{
  "mcpServers": {
    "voidmob": {
      "command": "npx",
      "args": ["-y", "@voidmob/mcp"],
      "env": { "VOIDMOB_API_KEY": "$VOIDMOB_API_KEY" }
    }
  }
}
```

### OpenClaw

Put `VOIDMOB_API_KEY=vmk_live_...` in `~/.openclaw/.env`, then:

```bash
openclaw mcp set voidmob '{"command":"npx","args":["-y","@voidmob/mcp"],"env":{"VOIDMOB_API_KEY":"${VOIDMOB_API_KEY}"}}'
openclaw mcp doctor voidmob --probe
```

Or use the [agent skill](#agent-skill). Guide: [voidmob.com/integrations/openclaw](https://voidmob.com/integrations/openclaw).

### Hermes Agent

Put `VOIDMOB_API_KEY=vmk_live_...` in `~/.hermes/.env` and add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  voidmob:
    command: "npx"
    args: ["-y", "@voidmob/mcp"]
    env:
      VOIDMOB_API_KEY: "${VOIDMOB_API_KEY}"
```

Or use the [agent skill](#agent-skill). Guide: [voidmob.com/integrations/hermes-agent](https://voidmob.com/integrations/hermes-agent).

### Pi

```bash
pi mcp add voidmob --env VOIDMOB_API_KEY='${VOIDMOB_API_KEY}' -- npx -y @voidmob/mcp
pi mcp list
```

The single quotes keep `${VOIDMOB_API_KEY}` as a reference that Pi reads from your shell. Guide: [voidmob.com/integrations/pi-coding-agent](https://voidmob.com/integrations/pi-coding-agent).

### Grok Bot

1. In your Bot's **Secrets**, add a secret named `VOIDMOB_API_KEY` with your key as the value.
2. In chat, send: *Read https://voidmob.com/skill.md and follow it. My VoidMob API key is in the VOIDMOB_API_KEY secret.*

The skill runs the REST API with curl on the Bot's computer and reads the secret by name. A custom MCP server of the Command type running `npx -y @voidmob/mcp` is another route to try; xAI's docs point servers that need secrets to remote HTTPS, so if the server cannot read the key, use the skill. Never paste the key itself into a chat. Guide: [voidmob.com/integrations/grok-bot](https://voidmob.com/integrations/grok-bot).

## How money works

- **Prepaid balance.** Everything is paid from your USD balance, which you top up with crypto in the [dashboard](https://dashboard.voidmob.com/wallet). The MCP cannot add funds. The API key has no separate spend cap: your balance is the limit, so keep on it only what you are happy for an agent to spend, and consider the local [owner controls](#owner-controls).
- **You approve the price.** Search tools show your live prices. Every buy, renewal, top-up and paid reuse requires `max_price_cents`: the price the agent showed you and you approved. If the current price is higher, nothing is charged and the tool returns the new price so the agent can ask you again; it never buys at a price you did not see. Every buy debits the balance immediately, and every result shows what was charged.
- **No double charges on retries.** Every purchase carries an idempotency key. If the connection drops, this MCP server retries once with the same key, which the API never charges twice.
- **When a result is uncertain,** the tool says the purchase may have gone through. Check `list_orders`, the matching get tool or `get_account` before buying again.
- **SMS verifications cost nothing if no SMS arrives.** A number stays open for up to 15 minutes and can receive several codes. If none arrives, the price is refunded automatically (status `cancelled`). Rare exception: services marked non-refundable end as `expired` without a refund. You can also cancel before any SMS arrives for a full refund; frequent cancellations can temporarily pause SMS purchasing.
- **Long-term rentals** can be cancelled with a full refund within 60 minutes of purchase.
- **Dedicated numbers** are billed monthly and cannot be cancelled; leave auto-renew off and the number simply expires at the end of the month.
- **eSIMs** cannot be cancelled through the MCP once issued. Contact support if one was bought by mistake and never installed.
- **Proxies** that cannot be provisioned are refunded automatically.

## Owner controls

Optional safety settings for the person who installs the server. They apply in live and sandbox mode alike, and a refusal from any of them charges nothing.

| Env var | Effect |
|---|---|
| `VOIDMOB_READ_ONLY=1` | Tools that spend money or change anything are not registered at all. The agent can search prices and read orders, nothing else. |
| `VOIDMOB_MAX_ORDER_CENTS=2500` | Refuses, before any request, a purchase, renewal, top-up or paid reuse whose `max_price_cents` is above this (here $25). Turning auto-renew on is refused when one renewal would cost more. |
| `VOIDMOB_BUDGET_CENTS=5000` | Running spend cap for this server process (here $50). The server counts what each purchase charged; when an outcome is unclear (a dropped connection, a purchase still in flight) it counts the full `max_price_cents`. A purchase that could go over is refused, and auto-renew cannot be turned on (renewals are charged later, outside the session). **This is a per-session safety net, not an account limit:** it resets when the server restarts and does not see purchases made elsewhere. |
| `VOIDMOB_TOOLSETS=sms,esim` | Loads only these tool groups, so the agent carries less context: `sms`, `numbers` (dedicated numbers), `esim`, `proxy`. Account, order and geo tools are always on. |

`get_account` shows the limits in force and how much of the budget is left. A malformed value stops the server with an error instead of being ignored.

## Waiting for SMS codes

After `rent_number`, call `get_rental` with `wait_seconds` (up to 120). The server polls for the agent (2, 3, 5, 8 s, then every 10-15 s) and returns as soon as a code arrives, the 15-minute window closes or the wait ends, with the latest SMS attached. Clients that send a progress token get progress notifications, and cancelling the request stops the wait. SMS text is shown fenced as untrusted data: it comes from whoever sent the SMS and is never an instruction.

## Resources and prompts

The server exposes short guides as MCP resources, read from the [agent skill](skills/voidmob) shipped in the package: `voidmob://guides/money-rules`, `voidmob://guides/sms`, `voidmob://guides/proxies` (HTTP/SOCKS5 and the username syntax for country, city and sticky sessions), `voidmob://guides/esim`, `voidmob://guides/dedicated-numbers` and `voidmob://guides/errors`.

Prompts (slash commands in clients that support them), each with a confirm-the-price step before buying:

- `get_verification_code` (service): rent a number and wait for the code.
- `setup_mobile_proxy` (country, usage): pick and buy a mobile proxy and get connection details.
- `buy_travel_esim` (destination, days, data_gb): find, buy and install a travel eSIM.

Read-only servers offer no prompts, and `VOIDMOB_TOOLSETS` keeps only the prompts of the loaded groups.

## Try without a key (sandbox)

```bash
VOIDMOB_SANDBOX=1 npx -y @voidmob/mcp
```

Boots in-memory mocks with a $500 play-money balance. Every tool works against fake data. State resets on restart.

## Agent skill

For any agent with a shell and curl, MCP or not (Claude Code, Codex, Cursor, OpenClaw, Hermes and other Agent Skills clients), [`skills/voidmob`](skills/voidmob) is an [Agent Skills](https://agentskills.io) `SKILL.md` that teaches the same flows over the REST API: balance checks, quote-then-confirm purchases, idempotent retries, SMS codes, dedicated numbers, proxies and eSIMs. It is plain Markdown with no scripts. It reads the key from `VOIDMOB_API_KEY`; set that in your agent's environment or secret store, never in the skill files.

The quickest way: tell your agent *Read https://voidmob.com/skill.md and follow it.*

```bash
# skills.sh CLI (Claude Code, Codex, Cursor, OpenClaw, Hermes and more)
npx skills add voidmobcom/voidmob-mcp --skill voidmob
# or from voidmob.com
npx skills add https://voidmob.com --skill voidmob

# Hermes Agent (use the full well-known address, not the voidmob.com/skill.md short link,
# so the skill's reference files resolve)
hermes skills install well-known:https://voidmob.com/.well-known/skills/voidmob
# or
hermes skills install voidmobcom/voidmob-mcp/skills/voidmob

# OpenClaw
npx skills add voidmobcom/voidmob-mcp --skill voidmob -a openclaw -g
```

On Hermes, also list the key under `terminal.env_passthrough` in `~/.hermes/config.yaml` so the skill's curl calls receive it.

## Configuration

| Env var | Purpose | Required |
|---|---|---|
| `VOIDMOB_API_KEY` | Bearer key from the dashboard | Live mode |
| `VOIDMOB_SANDBOX` | Set to `1` for mock-data mode | No |
| `VOIDMOB_READ_ONLY` | `1` = no tools that spend or change anything ([owner controls](#owner-controls)) | No |
| `VOIDMOB_MAX_ORDER_CENTS` | Per-order limit in US cents | No |
| `VOIDMOB_BUDGET_CENTS` | Per-session spend cap in US cents | No |
| `VOIDMOB_TOOLSETS` | Tool groups to load: `sms`, `numbers`, `esim`, `proxy` (default: all) | No |
| `VOIDMOB_DEBUG` | Set to `1` to log requests to stderr | No |
| `VOIDMOB_BASE_URL` | Override API host (advanced; must be `https://`, plain `http://` only for localhost) | No |

## Tools

30 tools across six domains. Every tool returns text plus `structuredContent` that matches its declared `outputSchema`.

### Account (1)

| Tool | Description |
|---|---|
| `get_account` | Balance, rate limits, and account id |

### SMS (7)

| Tool | Description |
|---|---|
| `search_sms_services` | List services with prices |
| `rent_number` | Rent a US number: one-time verification (15 min, refunded if no SMS) or long-term rental; takes `max_price_cents` |
| `get_rental` | Read status, the latest code and received messages; `wait_seconds` waits for the code |
| `cancel_rental` | Cancel a verification (before any SMS) or long-term rental (within 60 min), with a full refund |
| `reuse_number` | Free or paid reuse of an earlier verification's number (paid: `max_price_cents`) |
| `re_rent_rental` | Re-rent an expired long-term rental's number for another period; takes `max_price_cents` |
| `toggle_auto_renew` | Turn auto-renewal on or off (rentals and dedicated numbers) |

### Dedicated numbers (3)

| Tool | Description |
|---|---|
| `search_dedicated_countries` | Countries, monthly prices, and stock |
| `purchase_dedicated_number` | Buy a private all-services monthly number; takes `max_price_cents` |
| `get_dedicated_number` | Status and received SMS with parsed codes |

### eSIM (5)

| Tool | Description |
|---|---|
| `search_esim_plans` | Find global data plans |
| `purchase_esim` | Buy a plan; takes `max_price_cents` |
| `get_esim_status` | Status, install details (LPA string) and data usage across all packages |
| `topup_esim` | Browse top-ups, or buy one with `max_price_cents` |
| `get_esim_qr` | Fetch the activation QR as an inline image |

### Proxy (12)

| Tool | Description |
|---|---|
| `search_proxies` | List mobile (shared) and dedicated proxy plans, with dedicated stock |
| `purchase_proxy` | Buy a mobile or dedicated proxy; takes `max_price_cents` |
| `get_proxy_status` | Status, usage, expiry, auto-renew, renewal and top-up prices, ready-to-paste connection URLs |
| `rotate_proxy_ip` | Rotate a dedicated proxy to a new IP |
| `renew_proxy` | Extend expiry at the proxy's renewal price; takes `max_price_cents` |
| `set_proxy_auto_renew` | Turn auto-renew on or off for a dedicated proxy |
| `topup_proxy` | Add data to a mobile proxy; takes `max_price_cents` |
| `regenerate_proxy_password` | Rotate the gateway password, or one list's login with `list_id` |
| `list_proxy_lists` | List geo-targeted sub-pools |
| `create_proxy_list` | Create a geo-targeted sub-pool with its own login, or IP-whitelist auth with `network` |
| `update_proxy_list` | Change a sub-pool's name, geo, rotation or format (the IP whitelist cannot change) |
| `delete_proxy_list` | Remove a sub-pool |

### Discovery + history (2)

| Tool | Description |
|---|---|
| `get_geo` | Cascading country/region/city/ISP for targeting |
| `list_orders` | SMS verifications and rentals, dedicated numbers, eSIMs and proxies; per-kind `status` filter and `cursor` paging |

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

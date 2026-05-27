# blackwall-mcp

[![Glama quality](https://glama.ai/mcp/servers/bluetieroperations-create/blackwall-mcp/badge)](https://glama.ai/mcp/servers/bluetieroperations-create/blackwall-mcp)

**A guardrail for AI agents, as an MCP server.** Your agent calls one tool — `forecast` — before any irreversible action (send email, move money, run SQL, delete data, post content). It gets back a risk score (0–100), a reversibility class, a `GO` / `CAUTION` / `STOP` recommendation, and named red flags in a few seconds (~4-8s).

Works in any MCP host: **Claude Desktop, Claude Code, Cursor, Windsurf**, and any agent framework with MCP support.

> The wall between your agent and disaster. A BLUETIER product.

---

## 1. Get an API key

Sign up free at **https://blackwalltier.com** → Dashboard → API keys → Create key.
Free tier: ~100 forecasts/month, no card. Your key looks like `bw_live_…`.

## 2. Add the server to your MCP host

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "blackwall": {
      "command": "npx",
      "args": ["-y", "blackwall-mcp"],
      "env": { "BLACKWALL_API_KEY": "bw_live_your_key_here" }
    }
  }
}
```

Restart Claude Desktop. You'll see a `forecast` tool available.

### Cursor

`Settings → MCP → Add new global MCP server`, then in `mcp.json`:

```json
{
  "mcpServers": {
    "blackwall": {
      "command": "npx",
      "args": ["-y", "blackwall-mcp"],
      "env": { "BLACKWALL_API_KEY": "bw_live_your_key_here" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add blackwall -e BLACKWALL_API_KEY=bw_live_your_key_here -- npx -y blackwall-mcp
```

### Run locally (any host / testing)

```bash
BLACKWALL_API_KEY=bw_live_your_key_here npx -y blackwall-mcp
```

## 3. Use it

Once added, instruct your agent: *"Before any irreversible action, call the `forecast` tool and stop if it returns STOP."* The model will call it automatically when it's about to do something risky.

---

## The `forecast` tool

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | ✅ | The action type, e.g. `send_email`, `make_payment`, `run_sql`, `delete_file`, `post_content` |
| `inputs` | object | ✅ | Concrete parameters: recipient, `amount_usd`, SQL `statement`, file path, message body, URL, etc. |
| `context` | object | — | Optional: `{ agent_role, user_intent, environment }` |
| `depth` | `standard` \| `deep` | — | Analysis depth. `standard` is the default. |

**Returns:** recommendation (`GO`/`CAUTION`/`STOP`), `risk_score` (0–100), `reversibility` (class + rollback cost), `gate` (proceed/confirm/human-required), `confidence`, `red_flags[]`, `predicted_result`, `alternative_actions[]`.

### Example

Agent about to run `DELETE FROM users;` (no WHERE clause) →

```
🛑 BLACK_WALL: STOP — risk 99/100
Red flags:
  • [CRITICAL] SQL_NO_WHERE — deletes the entire table, not one row
  • [CRITICAL] INTENT_MISMATCH — intent was "remove a single test row"
  • [CRITICAL] IRREVERSIBLE_NO_BACKUP — no recovery path
Guidance: DO NOT take this action. Surface the red flags to the user.
```

---

## Observe mode — try it with zero risk

Not ready to let a guardrail block your agents? Start in **observe mode**. It scores and logs every action but **never tells the agent to stop** — your agents behave exactly as they do today. After a week, review your dashboard and see what it *would* have caught.

```json
{
  "mcpServers": {
    "blackwall": {
      "command": "npx",
      "args": ["-y", "blackwall-mcp"],
      "env": {
        "BLACKWALL_API_KEY": "bw_live_your_key_here",
        "BLACKWALL_MODE": "observe"
      }
    }
  }
}
```

Then see *"what your agents almost did"* in your dashboard. Flip `BLACKWALL_MODE` to `enforce` (or just remove it — enforce is the default) when you're ready to actually block.

## Two tools

The server exposes **two MCP tools**:

- **`forecast`** — pre-action risk check. Returns `GO` / `CAUTION` / `STOP`, risk score, named red flags, reversibility class, and a verifiable receipt.
- **`observe`** — post-action outcome report. Tells BLACK_WALL what actually happened after the action ran (or after the agent obeyed a STOP verdict). Closes the loop so the system can track prediction accuracy over time. FREE — no tokens charged.

Wire your agent to call `forecast` before any irreversible action, then call `observe` afterwards with the `forecast_id` from the original response. `observe` accepts an `outcome_class` (`matched` / `over_scope` / `under_scope` / `no_op` / `diverged` / `aborted`) and optional `divergence_severity` and `details`. See the `forecast` example below; the same wiring applies to `observe`.

## Decision receipts (cryptographic, verifiable offline)

Every `forecast` response now includes a `receipt` field — an Ed25519 signature over canonical SHA-256 hashes of the request + response. Anyone with the published public key can verify offline that BLACK_WALL signed off on a specific (request, response) pair, without trusting our servers.

- Published keys: **https://blackwalltier.com/.well-known/blackwall-signing-keys.json** (stable, cacheable)
- Stateless verify endpoint: **`POST https://blackwalltier.com/api/v1/receipts/verify`** with `{ envelope, request_body, response_body }`
- Hashes only — BLACK_WALL never stores the raw request/response bodies, so receipts give cryptographic audit without payload exposure
- Free-tier retention: 90 days. Paid: indefinite.

The MCP server surfaces the receipt id in its tool output so your agent can log it for later replay / audit.

## Config reference

| Env var | Required | Default | Notes |
|---------|----------|---------|-------|
| `BLACKWALL_API_KEY` | ✅ | — | `bw_live_…` from your dashboard |
| `BLACKWALL_BASE_URL` | — | `https://blackwalltier.com` | |
| `BLACKWALL_MODE` | — | `enforce` | `observe` = log only, never block |

## Links

- Site & docs: https://blackwalltier.com
- Get a key: https://blackwalltier.com/dashboard/keys

MIT licensed.

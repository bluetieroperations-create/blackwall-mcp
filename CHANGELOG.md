# Changelog

## 1.3.0 — 2026-05-31

### Added
- **Remote HTTP (Streamable HTTP) transport** — `http.mjs`, bin `blackwall-mcp-http`,
  `npm run start:http`. Lets hosted MCP clients use BLACK_WALL without spawning a
  local stdio process — notably the xAI / Grok Responses API "remote MCP tools"
  feature and any hosted MCP gateway.
  - **Multi-tenant:** each session binds the caller's own `Authorization: Bearer`
    key to a fresh, isolated server instance — no shared key state across tenants.
  - **Hardened:** key bound at `initialize` and re-verified (constant-time) on
    every request; a key is required to open a session; `X-Forwarded-For` honored
    only under `BLACKWALL_TRUST_PROXY`; optional DNS-rebinding / Host pinning via
    `BLACKWALL_ALLOWED_HOSTS`; per-IP rate limit, body-size cap, session cap + TTL.
- Shared `server.mjs` factory powering both the stdio and HTTP transports.

### Changed
- `@modelcontextprotocol/sdk` floor raised to `^1.29.0`.
- `index.mjs` (stdio transport) refactored onto the shared factory — behavior unchanged.

### Notes
- The stdio server remains the default (`npx blackwall-mcp`). The remote HTTP
  transport is opt-in (`blackwall-mcp-http`) and intended for self-hosting behind TLS.

---

Earlier 1.x: `forecast` / `observe` MCP tools, fail-closed guarantees, signed
decision receipts, `parent_forecast_id` threading, and the `gate()` helper.

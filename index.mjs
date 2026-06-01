#!/usr/bin/env node
/**
 * BLACK_WALL MCP server — stdio transport (default)
 * -------------------------------------------------
 * Exposes BLACK_WALL's pre-action risk check as MCP tools so any MCP-compatible
 * host (Claude Desktop, Claude Code, Cursor, Windsurf, Grok Build, etc.) can let
 * its agent ask "is this action safe?" BEFORE doing something irreversible.
 *
 * Config (env):
 *   BLACKWALL_API_KEY   required at call time — your bw_live_… key from blackwalltier.com/dashboard/keys
 *   BLACKWALL_BASE_URL  optional — defaults to https://blackwalltier.com
 *   BLACKWALL_MODE      optional — 'enforce' (default) or 'observe'
 *
 * Run: BLACKWALL_API_KEY=bw_live_xxx node index.mjs   (stdio transport)
 *
 * For a multi-tenant REMOTE endpoint (e.g. the xAI / Grok Responses API "remote
 * MCP tools" feature), run the HTTP transport instead: `node http.mjs` — there the
 * key comes from each request's Authorization header rather than the environment.
 *
 * Tool/transport logic for forecast & observe lives in ./lib; the MCP wiring
 * (tools, content envelopes) lives in ./server.mjs and is shared by both transports.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.mjs';

const API_KEY = process.env.BLACKWALL_API_KEY;
const BASE_URL = (process.env.BLACKWALL_BASE_URL || 'https://blackwalltier.com').replace(/\/$/, '');
const MODE = process.env.BLACKWALL_MODE;

// Don't exit when the key is missing — the server still starts and exposes the
// tools for introspection (tools/list). The key is required only when a tool is
// actually called. This lets MCP directories/scanners verify the server boots
// without needing credentials. (stdout is reserved for the MCP protocol → stderr.)
if (!API_KEY) {
  console.error('[blackwall-mcp] No BLACKWALL_API_KEY set — server starts, but forecast calls will fail until you set one (https://blackwalltier.com/dashboard/keys).');
}

const server = buildServer({ apiKey: API_KEY, baseUrl: BASE_URL, mode: MODE });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[blackwall-mcp] ready (stdio) · base=' + BASE_URL);

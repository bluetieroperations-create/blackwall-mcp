#!/usr/bin/env node
/**
 * BLACK_WALL MCP server — remote HTTP (Streamable HTTP) transport
 * --------------------------------------------------------------
 * For MCP hosts that connect to a REMOTE server over HTTP rather than spawning a
 * local stdio process — notably the xAI / Grok Responses API "remote MCP tools"
 * feature, and any hosted MCP gateway.
 *
 * Multi-tenant: there is NO server-wide API key. Each MCP SESSION carries the
 * caller's own key as `Authorization: Bearer bw_live_…` on its `initialize`
 * request; that key is bound to an isolated server instance for the life of the
 * session and re-verified on every later request. A key is REQUIRED to open a
 * session — keyless `tools/list` introspection is served by the stdio package,
 * not this endpoint. No cross-tenant state.
 *
 * Protocol: Streamable HTTP with session management (Mcp-Session-Id header) —
 *   POST   /mcp  initialize (no session id) → opens a session
 *   POST   /mcp  with Mcp-Session-Id        → tool calls on that session
 *   GET    /mcp  with Mcp-Session-Id        → server→client SSE stream
 *   DELETE /mcp  with Mcp-Session-Id        → close the session
 *
 * Config (env):
 *   PORT                 default 8787
 *   BLACKWALL_BASE_URL   default https://blackwalltier.com
 *   BLACKWALL_MODE       'enforce' (default) or 'observe'
 *   BLACKWALL_MCP_PATH   default '/mcp'
 *   BLACKWALL_RL_MAX     max requests per IP per minute (default 120)
 *   BLACKWALL_MAX_BODY   max request body bytes (default 1048576)
 *   BLACKWALL_MAX_SESSIONS  cap on concurrent sessions (default 5000)
 *   BLACKWALL_SESSION_TTL_MS idle session expiry (default 600000 = 10m)
 *   BLACKWALL_TRUST_PROXY   '1' to honor X-Forwarded-For (only if your proxy
 *                           OVERWRITES it). Default off → bucket by socket addr.
 *   BLACKWALL_ALLOWED_HOSTS comma-list of Host values to accept (enables DNS-
 *                           rebinding protection). e.g. mcp.blackwalltier.com
 *   BLACKWALL_ALLOWED_ORIGINS comma-list of allowed Origin headers
 *   BLACKWALL_DNS_REBIND    '1' to force DNS-rebinding protection on
 *
 * Run: node http.mjs
 *
 * DEPLOY CHECKLIST: TLS in front; set BLACKWALL_TRUST_PROXY=1 ONLY behind a proxy
 * that overwrites X-Forwarded-For; set BLACKWALL_ALLOWED_HOSTS to your public host.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.mjs';

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.BLACKWALL_BASE_URL || 'https://blackwalltier.com').replace(/\/$/, '');
const MODE = process.env.BLACKWALL_MODE;
const MCP_PATH = process.env.BLACKWALL_MCP_PATH || '/mcp';
const MAX_BODY = Number(process.env.BLACKWALL_MAX_BODY || 1_048_576);
const RL_WINDOW_MS = 60_000;
const RL_MAX = Number(process.env.BLACKWALL_RL_MAX || 120);
const MAX_SESSIONS = Number(process.env.BLACKWALL_MAX_SESSIONS || 5000);
const SESSION_TTL_MS = Number(process.env.BLACKWALL_SESSION_TTL_MS || 600_000);

// H-2: only honor X-Forwarded-For when explicitly told a trusted proxy fronts us
// AND that proxy overwrites (not appends) the header. Default OFF → bucket by the
// real socket address, so XFF spoofing can't escape the rate limiter.
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.BLACKWALL_TRUST_PROXY || '').toLowerCase());

// M-2: DNS-rebinding / Host+Origin pinning. Off by default (host unknown at dev/
// test time); enabled automatically once you configure the deployment's host(s).
const ALLOWED_HOSTS = (process.env.BLACKWALL_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.BLACKWALL_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DNS_REBIND_PROTECT = ALLOWED_HOSTS.length > 0 || ['1', 'true', 'yes'].includes(String(process.env.BLACKWALL_DNS_REBIND || '').toLowerCase());

// sessionId -> { transport, server, lastSeen, boundKeyHash }
const sessions = new Map();

// ---- fixed-window rate limiter, keyed by client IP ----
const hits = new Map();
export function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + RL_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : undefined;
}

// H-1: bind the key at initialize and re-verify it on every later request for the
// session, so a leaked session id alone can't spend a victim's billable key. We
// store only a SHA-256 of the key and compare in constant time.
function keyHash(key) {
  return key ? createHash('sha256').update(key).digest() : null;
}
function keyMatches(boundHash, reqKey) {
  const reqHash = keyHash(reqKey);
  // keyless ↔ keyless: unreachable on this transport since M-1 requires a key to
  // open a session (boundKeyHash is always non-null here). Kept so a future
  // refactor that re-introduces keyless sessions stays correct, not a live path.
  if (boundHash === null && reqHash === null) return true;
  if (boundHash === null || reqHash === null) return false;
  return timingSafeEqual(boundHash, reqHash);
}

function isInitialize(body) {
  if (Array.isArray(body)) return body.some((m) => m && m.method === 'initialize');
  return Boolean(body) && body.method === 'initialize';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { httpCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve(undefined);
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { httpCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

const httpServer = createServer(async (req, res) => {
  const urlPath = (req.url || '').split('?')[0];

  // Health / readiness — unauthenticated, safe for load balancers + registry scanners.
  if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/')) {
    return sendJson(res, 200, { ok: true, service: 'blackwall-mcp', transport: 'http', base: BASE_URL, sessions: sessions.size });
  }

  if (urlPath !== MCP_PATH) {
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (rateLimited(clientIp(req))) {
    return sendJson(res, 429, { jsonrpc: '2.0', error: { code: -32029, message: 'rate limit exceeded' }, id: null }, { 'retry-after': '60' });
  }

  const sessionId = req.headers['mcp-session-id'];

  // ---- GET (SSE stream) / DELETE (close) on an existing session ----
  if (req.method === 'GET' || req.method === 'DELETE') {
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'unknown or expired session' }, id: null });
    }
    if (!keyMatches(entry.boundKeyHash, bearer(req))) {
      return sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32003, message: 'Authorization does not match this session' }, id: null });
    }
    entry.lastSeen = Date.now();
    return entry.transport.handleRequest(req, res);
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { allow: 'GET, POST, DELETE' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.httpCode || 400, { jsonrpc: '2.0', error: { code: -32700, message: err.message }, id: null });
  }

  // ---- existing session: route to its transport ----
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) {
      return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'unknown or expired session' }, id: body?.id ?? null });
    }
    if (!keyMatches(entry.boundKeyHash, bearer(req))) {
      return sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32003, message: 'Authorization does not match this session' }, id: body?.id ?? null });
    }
    entry.lastSeen = Date.now();
    return entry.transport.handleRequest(req, res, body);
  }

  // ---- new session: must be an initialize request carrying a key ----
  if (!isInitialize(body)) {
    return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid session. Send an initialize request first (with Authorization: Bearer <key>).' }, id: body?.id ?? null });
  }

  // M-1: a key is REQUIRED to open a session — no anonymous session allocation.
  // (Keyless tools/list introspection is served by the stdio package that registries
  // crawl, not by this hosted endpoint, so requiring a key here costs nothing.)
  const apiKey = bearer(req);
  if (!apiKey) {
    return sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32004, message: 'initialize requires Authorization: Bearer <key>. Free key at https://blackwalltier.com/dashboard/keys' }, id: body?.id ?? null });
  }

  if (sessions.size >= MAX_SESSIONS) {
    return sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32002, message: 'server at session capacity, retry shortly' }, id: body?.id ?? null });
  }

  // Bind THIS caller's key to a fresh, isolated server for the session's lifetime.
  const boundKeyHash = keyHash(apiKey); // H-1: re-verified on every later request
  const server = buildServer({ apiKey, baseUrl: BASE_URL, mode: MODE });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: DNS_REBIND_PROTECT, // M-2
    ...(ALLOWED_HOSTS.length ? { allowedHosts: ALLOWED_HOSTS } : {}),
    ...(ALLOWED_ORIGINS.length ? { allowedOrigins: ALLOWED_ORIGINS } : {}),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server, lastSeen: Date.now(), boundKeyHash });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[blackwall-mcp] http initialize error:', err?.message ?? err);
    if (transport.sessionId) sessions.delete(transport.sessionId);
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: body?.id ?? null });
    }
  }
});

/**
 * Start listening. Returns the http.Server so callers (and tests) can close it.
 * @param {object} [opts]
 * @param {number} [opts.port]  defaults to PORT env / 8787
 */
export function startHttpServer({ port = PORT } = {}) {
  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    for (const [sid, s] of sessions) {
      if (now - s.lastSeen > SESSION_TTL_MS) {
        try { s.transport.close(); } catch { /* ignore */ }
        sessions.delete(sid);
      }
    }
  }, RL_WINDOW_MS);
  pruneTimer.unref();
  httpServer.on('close', () => clearInterval(pruneTimer));
  httpServer.listen(port, () => {
    const addr = httpServer.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    console.error(`[blackwall-mcp] ready (http) · ${MCP_PATH} on :${p} · base=${BASE_URL}`);
  });
  return httpServer;
}

// Auto-start when run directly (node http.mjs), but not when imported (e.g. by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHttpServer();
}

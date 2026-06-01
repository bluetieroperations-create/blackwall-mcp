// End-to-end tests for the remote HTTP (Streamable HTTP) transport (http.mjs).
// Run: node --test test/http-transport.test.mjs
//
// Spins up: (1) a stub BLACK_WALL backend that captures the Authorization header
// and returns a canned verdict, and (2) the real http.mjs MCP server pointed at it.
// Then drives it with the real MCP SDK client over the session protocol to prove:
//   - tools/list works (forecast + observe registered)
//   - a session with NO key → forecast returns a clear missing-key error, no upstream call
//   - a session WITH Authorization → the caller's key reaches the upstream forecast call
// No real network / no real API key used.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let stub, server, port, clientIp;
let seenAuth; // Authorization header the stub backend last received on /api/v1/forecast

before(async () => {
  // (1) stub BLACK_WALL backend
  stub = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/forecast') {
      // request-local (NOT the shared seenAuth) so concurrent requests can't race.
      const auth = req.headers['authorization'] || null;
      seenAuth = auth;
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fc_test',
          recommendation: 'STOP',
          risk_score: 99,
          gate: 'HUMAN_REQUIRED',
          reversibility: { class: 'IRREVERSIBLE', rollback_cost: 95 },
          red_flags: [{ severity: 'critical', code: 'TEST_FLAG', message: 'stub' }],
          auth_echo: auth, // echoes the key THIS request carried → lets the test prove isolation
        }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  stub.listen(0);
  await once(stub, 'listening');
  const stubPort = stub.address().port;

  // (2) the real http.mjs server, pointed at the stub. Env must be set BEFORE import.
  process.env.BLACKWALL_BASE_URL = `http://127.0.0.1:${stubPort}`;
  process.env.BLACKWALL_RL_MAX = '100000';
  const mod = await import('../http.mjs');
  clientIp = mod.clientIp;
  server = mod.startHttpServer({ port: 0 });
  await once(server, 'listening');
  port = server.address().port;
});

after(() => {
  if (server) server.close();
  if (stub) stub.close();
});

function connect(headers) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    headers ? { requestInit: { headers } } : undefined
  );
  const client = new Client({ name: 'http-transport-test', version: '1.0.0' });
  return { client, transport };
}

test('GET /health responds ok', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.transport, 'http');
});

test('tools/list works over a keyed session and exposes forecast + observe', async () => {
  const { client, transport } = connect({ Authorization: 'Bearer bw_test_list' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['forecast', 'observe']);
  await client.close();
});

test('M-1: keyless initialize is rejected 401 (no anonymous sessions)', async () => {
  const before = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).sessions;
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  assert.equal(r.status, 401, 'keyless initialize must be rejected');
  const after = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).sessions;
  assert.equal(after, before, 'a rejected initialize must NOT allocate a session');
});

test('per-session Authorization is forwarded to the upstream forecast call', async () => {
  seenAuth = null;
  const { client, transport } = connect({ Authorization: 'Bearer bw_test_perreq' });
  await client.connect(transport);
  const res = await client.callTool({ name: 'forecast', arguments: { action: 'run_sql', inputs: { statement: 'DELETE FROM users' } } });
  assert.notEqual(res.isError, true);
  const text = res.content.map((c) => c.text).join('\n');
  assert.match(text, /STOP/);
  assert.match(text, /risk 99/);
  assert.equal(seenAuth, 'Bearer bw_test_perreq', "the caller's key must reach the upstream API");
  await client.close();
});

test('TWO concurrent sessions with different keys never cross-contaminate', async () => {
  const A = connect({ Authorization: 'Bearer bw_key_AAA' });
  const B = connect({ Authorization: 'Bearer bw_key_BBB' });
  await Promise.all([A.client.connect(A.transport), B.client.connect(B.transport)]);

  // Fire both forecasts concurrently — the whole point is to catch shared-state bleed.
  const [ra, rb] = await Promise.all([
    A.client.callTool({ name: 'forecast', arguments: { action: 'run_sql', inputs: { statement: 'DELETE FROM a' } } }),
    B.client.callTool({ name: 'forecast', arguments: { action: 'run_sql', inputs: { statement: 'DELETE FROM b' } } }),
  ]);

  const textA = ra.content.map((c) => c.text).join('\n');
  const textB = rb.content.map((c) => c.text).join('\n');

  // Each session's upstream call must have carried ONLY its own key.
  assert.match(textA, /bw_key_AAA/, "session A must use key A");
  assert.doesNotMatch(textA, /bw_key_BBB/, "session A must NOT see key B");
  assert.match(textB, /bw_key_BBB/, "session B must use key B");
  assert.doesNotMatch(textB, /bw_key_AAA/, "session B must NOT see key A");

  await Promise.all([A.client.close(), B.client.close()]);
});

test('H-1: reusing a session id with the WRONG (or no) key is rejected 401', async () => {
  const { client, transport } = connect({ Authorization: 'Bearer bw_key_AAA' });
  await client.connect(transport);
  const sid = transport.sessionId;
  assert.ok(sid, 'client obtained a session id');

  const onSession = (auth) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid,
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

  assert.equal((await onSession('Bearer bw_key_EVIL')).status, 401, 'wrong key on a hijacked session id → 401');
  assert.equal((await onSession(undefined)).status, 401, 'no key on a keyed session → 401');
  assert.notEqual((await onSession('Bearer bw_key_AAA')).status, 401, 'the bound key still works');

  await client.close();
});

test('H-2: X-Forwarded-For is ignored by default (no proxy trust)', () => {
  const ip = clientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '9.9.9.9' } });
  assert.equal(ip, '9.9.9.9', 'must bucket by socket addr, not spoofable XFF');
});

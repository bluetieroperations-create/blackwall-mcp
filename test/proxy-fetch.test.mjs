// Proves BLACK_WALL's egress routes through an HTTP CONNECT proxy (lib/proxy-fetch.mjs).
// This is the fix for proxy-only-egress networks (NVIDIA NemoClaw's default-deny
// sandbox, corporate proxies) where Node's fetch — which ignores HTTPS_PROXY —
// gets dropped. Run: node --test test/proxy-fetch.test.mjs
//
// Sets up a REAL local CONNECT proxy + a TLS "target" server and asserts the
// request actually tunnels through the proxy (the proxy records the CONNECT) and
// the HTTPS round-trip completes. The TLS cert is generated at runtime in a temp
// dir (openssl) and never committed, so no private key lands in the repo.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { once } from 'node:events';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProxyForUrl, proxyFetch } from '../lib/proxy-fetch.mjs';

let target, proxy, targetPort, proxyPort, certDir, haveTls = false, seenConnect = null;

before(async () => {
  // 1) self-signed cert in a throwaway temp dir (not committed)
  try {
    certDir = mkdtempSync(join(tmpdir(), 'bw-proxytest-'));
    execSync(
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 ' +
        '-subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
      { cwd: certDir, stdio: 'ignore' }
    );
    const key = readFileSync(join(certDir, 'key.pem'));
    const cert = readFileSync(join(certDir, 'cert.pem'));

    // 2) TLS "target" = a stand-in for blackwalltier.com
    target = https.createServer({ key, cert }, (req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fc_proxy_test',
          recommendation: 'STOP',
          risk_score: 99,
          gate: 'HUMAN_REQUIRED',
          reversibility: { class: 'IRREVERSIBLE' },
          red_flags: [{ severity: 'critical', code: 'PROXY_OK' }],
          got_auth: req.headers.authorization || null,
          got_body: b,
        }));
      });
    });
    target.listen(0);
    await once(target, 'listening');
    targetPort = target.address().port;

    // 3) HTTP CONNECT proxy that records the tunnel target and pipes bytes through
    proxy = net.createServer((client) => {
      client.once('data', (chunk) => {
        const m = /^CONNECT (\S+) HTTP/.exec(chunk.toString('latin1'));
        if (!m) return client.destroy();
        seenConnect = m[1];
        const [h, p] = m[1].split(':');
        const upstream = net.connect({ host: h, port: Number(p) }, () => {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          const idx = chunk.indexOf('\r\n\r\n');
          const rest = chunk.slice(idx + 4);
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      });
      client.on('error', () => {});
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    proxyPort = proxy.address().port;
    haveTls = true;
  } catch (e) {
    haveTls = false; // openssl unavailable → proxy round-trip tests self-skip
  }
});

after(() => {
  try { target && target.close(); } catch {}
  try { proxy && proxy.close(); } catch {}
  try { certDir && rmSync(certDir, { recursive: true, force: true }); } catch {}
});

test('getProxyForUrl honors HTTPS_PROXY and NO_PROXY', () => {
  assert.equal(getProxyForUrl('https://blackwalltier.com/x', { HTTPS_PROXY: 'http://p:3128' }), 'http://p:3128');
  assert.equal(getProxyForUrl('https://blackwalltier.com/x', {}), null);
  assert.equal(getProxyForUrl('https://blackwalltier.com/x', { HTTPS_PROXY: 'http://p:3128', NO_PROXY: 'blackwalltier.com' }), null);
  assert.equal(getProxyForUrl('https://api.blackwalltier.com/x', { HTTPS_PROXY: 'http://p:3128', NO_PROXY: '.blackwalltier.com' }), null);
  assert.equal(getProxyForUrl('https://blackwalltier.com/x', { HTTPS_PROXY: 'http://p:3128', NO_PROXY: '*' }), null);
});

test('routes an HTTPS POST through the CONNECT proxy to the target', async (t) => {
  if (!haveTls) return t.skip('openssl/setup unavailable');
  seenConnect = null;
  const f = proxyFetch(`http://127.0.0.1:${proxyPort}`, { tls: { rejectUnauthorized: false } });
  const res = await f(`https://127.0.0.1:${targetPort}/api/v1/forecast`, {
    method: 'POST',
    headers: { Authorization: 'Bearer bw_proxy_test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run_sql', inputs: { statement: 'DELETE FROM users' } }),
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.recommendation, 'STOP');
  assert.equal(j.risk_score, 99);
  // The proof: the request was tunneled THROUGH the proxy, not sent directly.
  assert.equal(seenConnect, `127.0.0.1:${targetPort}`, 'request must CONNECT through the proxy');
  // And the auth header + body survived the manual HTTP serialization.
  assert.equal(j.got_auth, 'Bearer bw_proxy_test');
  assert.match(j.got_body, /DELETE FROM users/);
});

test('rejects when the abort signal is already aborted', async (t) => {
  if (!haveTls) return t.skip('openssl/setup unavailable');
  const f = proxyFetch(`http://127.0.0.1:${proxyPort}`, { tls: { rejectUnauthorized: false } });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => f(`https://127.0.0.1:${targetPort}/x`, { signal: ac.signal }),
    /abort/i
  );
});

test('only supports https targets', async () => {
  const f = proxyFetch('http://127.0.0.1:1');
  await assert.rejects(() => f('http://example.com/x'), /https targets only/i);
});

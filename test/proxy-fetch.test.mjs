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

test('SECURITY: verifies the target cert by default (rejects self-signed)', async (t) => {
  if (!haveTls) return t.skip('openssl/setup unavailable');
  // Production path: NO opts.tls override => tls.connect default rejectUnauthorized:true.
  // Against our self-signed target this MUST fail — proving the API key is never sent
  // over an unverified TLS connection (no silent MITM surface in the proxied sandbox).
  const f = proxyFetch(`http://127.0.0.1:${proxyPort}`);
  await assert.rejects(
    () =>
      f(`https://127.0.0.1:${targetPort}/api/v1/forecast`, {
        method: 'POST',
        headers: { Authorization: 'Bearer bw_should_never_send' },
        body: '{}',
      }),
    (err) => /self.?signed|certificate|unable to verify/i.test(String(err && err.message)) || /CERT/i.test(String(err && err.code))
  );
});

test('only supports https targets', async () => {
  const f = proxyFetch('http://127.0.0.1:1');
  await assert.rejects(() => f('http://example.com/x'), /https targets only/i);
});

test('SECURITY: caps the response body (a flooding proxy cannot exhaust memory)', async (t) => {
  if (!haveTls) return t.skip('openssl/setup unavailable');
  // A hostile/compromised proxy in a default-deny sandbox is the egress point and can
  // return an arbitrarily large body. Without a cap, proxyFetch buffers it all into
  // memory until the (15s prod) timeout fires — hundreds of MB of attacker-controlled
  // data. proxyFetch must abort the read and REJECT (fail closed) once a sane cap is hit,
  // never resolve with a giant body.
  const tlsKey = readFileSync(join(certDir, 'key.pem'));
  const tlsCert = readFileSync(join(certDir, 'cert.pem'));
  const liveSockets = new Set();
  const flood = (await import('node:tls')).createServer({ key: tlsKey, cert: tlsCert }, (s) => {
    liveSockets.add(s);
    s.on('close', () => liveSockets.delete(s));
    s.on('error', () => {});
    s.on('data', () => {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n');
      const block = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a'
      const iv = setInterval(() => {
        if (s.destroyed) return clearInterval(iv);
        s.write(block); // never sends a complete/closing body
      }, 1);
      s.on('close', () => clearInterval(iv));
    });
  });
  flood.listen(0);
  await once(flood, 'listening');
  const floodPort = flood.address().port;
  try {
    const f = proxyFetch(`http://127.0.0.1:${proxyPort}`, { tls: { rejectUnauthorized: false } });
    await assert.rejects(
      () =>
        f(`https://127.0.0.1:${floodPort}/api/v1/forecast`, {
          method: 'POST',
          headers: { Authorization: 'Bearer bw_flood_test' },
          body: '{}',
        }),
      /too large|exceed|max|body/i,
      'a flooding response must be rejected, not buffered without bound'
    );
  } finally {
    // Force-tear the upstream sockets the local proxy keeps piping, so the
    // never-ending flood doesn't hold the test event loop open.
    for (const s of liveSockets) { try { s.destroy(); } catch {} }
    try { flood.close(); } catch {}
  }
});

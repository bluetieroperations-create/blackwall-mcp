// Fail-closed guarantees for the forecast HTTP client (lib/forecast.mjs).
// Run: node --test test/forecast-fail-closed.test.mjs
//
// The gate must FAIL CLOSED: it must throw (never return a usable/"proceed" value)
// on a network error, a non-2xx, a timeout, OR a 2xx whose body carries no verdict.
// The MCP wrapper (index.mjs) turns every throw into an isError "treat as STOP" result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../lib/forecast.mjs';

const OPTS = { apiKey: 'bw_test_key', baseUrl: 'https://example.test' };

// A well-formed verdict the backend would normally return.
const validVerdict = { id: 'fc_1', recommendation: 'STOP', risk_score: 99, red_flags: [] };

const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('returns the parsed verdict on a valid 200', async () => {
  const data = await forecast(
    { action: 'run_sql', inputs: { statement: 'DELETE FROM users' } },
    { ...OPTS, fetch: okJson(validVerdict) }
  );
  assert.equal(data.recommendation, 'STOP');
  assert.equal(data.risk_score, 99);
});

test('FAILS CLOSED on a 200 with an unparseable body (the original fail-open bug)', async () => {
  const badFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0'); // e.g. a CDN HTML page
    },
  });
  await assert.rejects(
    forecast({ action: 'wire_transfer', inputs: { amount_usd: 50000 } }, { ...OPTS, fetch: badFetch }),
    /no usable risk verdict/i
  );
});

test('FAILS CLOSED on a 200 missing recommendation / risk_score', async () => {
  await assert.rejects(
    forecast({ action: 'make_payment', inputs: {} }, { ...OPTS, fetch: okJson({ id: 'fc_2' }) }),
    /no usable risk verdict/i
  );
});

test('throws on a non-2xx response', async () => {
  const errFetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  await assert.rejects(
    forecast({ action: 'send_email', inputs: {} }, { ...OPTS, fetch: errFetch }),
    /error \(500\)/i
  );
});

test('FAILS CLOSED (times out) when the backend hangs, instead of blocking forever', async () => {
  // A fetch that never resolves on its own but honors the AbortSignal forecast() sets.
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        reject(e);
      });
    });
  // 1000ms is the enforced floor (Math.max(1000, …)); a lower value clamps up to it.
  // AbortSignal.timeout() uses an UNREF'd timer, so with nothing else holding the
  // event loop open a fast runner (CI) can go idle and exit before it fires —
  // cancelling this still-pending test. A ref'd interval keeps the loop alive
  // until the timeout resolves; cleared in finally so it never leaks.
  const keepAlive = setInterval(() => {}, 50);
  const started = process.hrtime.bigint();
  try {
    await assert.rejects(
      forecast({ action: 'delete_database', inputs: {} }, { ...OPTS, fetch: hangingFetch, timeoutMs: 1000 }),
      /timed out after 1000ms/i
    );
  } finally {
    clearInterval(keepAlive);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2500, `should abort near the 1000ms timeout, took ${elapsedMs.toFixed(0)}ms`);
});

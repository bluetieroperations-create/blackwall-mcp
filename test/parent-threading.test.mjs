// Per-call threading: forecast() and gate() forward parent_forecast_id so a
// multi-step action's per-call checks share one chain id.
// Run: node --test test/parent-threading.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../lib/forecast.mjs';
import { gate } from '../lib/gate.mjs';

const OPTS = { apiKey: 'bw_test_key', baseUrl: 'https://example.test' };
const GO = { id: 'fc_parent', recommendation: 'GO', risk_score: 5, gate: 'AUTO' };

function captureFetch(store) {
  return async (url, init) => {
    if (url.endsWith('/api/v1/forecast')) {
      store.body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => GO };
    }
    if (/\/outcome$/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    throw new Error('unexpected url ' + url);
  };
}

test('forecast() forwards parent_forecast_id when provided', async () => {
  const store = {};
  await forecast(
    { action: 'run_sql', inputs: {}, parent_forecast_id: 'fc_root' },
    { ...OPTS, fetch: captureFetch(store) }
  );
  assert.equal(store.body.parent_forecast_id, 'fc_root');
});

test('forecast() omits parent_forecast_id when not provided', async () => {
  const store = {};
  await forecast({ action: 'run_sql', inputs: {} }, { ...OPTS, fetch: captureFetch(store) });
  assert.equal('parent_forecast_id' in store.body, false);
});

test('gate() threads parent_forecast_id into the forecast request', async () => {
  const store = {};
  await gate(
    { action: 'run_sql', inputs: {}, parent_forecast_id: 'fc_root' },
    async () => 'ok',
    { ...OPTS, fetch: captureFetch(store) }
  );
  assert.equal(store.body.parent_forecast_id, 'fc_root');
});

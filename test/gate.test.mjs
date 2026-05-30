// Behavior guarantees for the gate() control (lib/gate.mjs).
// Run: node --test test/gate.test.mjs
//
// gate() must: run the action ONLY on GO (or confirmed CAUTION); FAIL CLOSED on
// STOP, unknown verdicts, and forecast-unavailable; and close the loop via observe().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, BlackWallBlocked } from '../lib/gate.mjs';

const OPTS = { apiKey: 'bw_test_key', baseUrl: 'https://example.test' };

// A fetch double that answers /forecast with `verdict` and records observe() calls.
function makeFetch(verdict, observed) {
  return async (url, init) => {
    if (url.endsWith('/api/v1/forecast')) {
      return { ok: true, status: 200, json: async () => verdict };
    }
    if (/\/outcome$/.test(url)) {
      observed.push(JSON.parse(init.body).actual_outcome); // observe() nests under actual_outcome
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error('unexpected url ' + url);
  };
}
const GO      = { id: 'fc_go',      recommendation: 'GO',      risk_score: 10, gate: 'AUTO' };
const STOP    = { id: 'fc_stop',    recommendation: 'STOP',    risk_score: 95 };
const CAUTION = { id: 'fc_caution', recommendation: 'CAUTION', risk_score: 62, gate: 'CONFIRM' };

test('GO → runs the action and observes a matched outcome', async () => {
  const observed = [];
  let ran = false;
  const { result, verdict } = await gate(
    { action: 'send_email', inputs: {} },
    async () => { ran = true; return 'sent'; },
    { ...OPTS, fetch: makeFetch(GO, observed) }
  );
  assert.equal(ran, true);
  assert.equal(result, 'sent');
  assert.equal(verdict.recommendation, 'GO');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].outcome_class, 'matched');
});

test('STOP → FAILS CLOSED: action never runs, throws BlackWallBlocked, observes aborted', async () => {
  const observed = [];
  let ran = false;
  await assert.rejects(
    gate({ action: 'delete_database', inputs: {} }, async () => { ran = true; }, { ...OPTS, fetch: makeFetch(STOP, observed) }),
    (e) => e instanceof BlackWallBlocked && e.reason === 'stop'
  );
  assert.equal(ran, false, 'action must NOT run on STOP');
  assert.equal(observed[0]?.outcome_class, 'aborted');
});

test('CAUTION without confirmation → blocked (default fail-closed)', async () => {
  const observed = [];
  let ran = false;
  await assert.rejects(
    gate({ action: 'revoke_api_key', inputs: {} }, async () => { ran = true; }, { ...OPTS, fetch: makeFetch(CAUTION, observed) }),
    (e) => e instanceof BlackWallBlocked && e.reason === 'caution_declined'
  );
  assert.equal(ran, false);
});

test('CAUTION with onCaution → true → runs', async () => {
  const observed = [];
  let ran = false;
  const { result } = await gate(
    { action: 'revoke_api_key', inputs: {} },
    async () => { ran = true; return 'revoked'; },
    { ...OPTS, fetch: makeFetch(CAUTION, observed), onCaution: async () => true }
  );
  assert.equal(ran, true);
  assert.equal(result, 'revoked');
});

test('forecast unavailable → FAILS CLOSED (action never runs)', async () => {
  let ran = false;
  const boom = async () => { throw new Error('network down'); };
  await assert.rejects(
    gate({ action: 'make_payment', inputs: {} }, async () => { ran = true; }, { ...OPTS, fetch: boom }),
    (e) => e instanceof BlackWallBlocked && e.reason === 'forecast_unavailable'
  );
  assert.equal(ran, false);
});

test('failOpen:true → runs even when forecast is unavailable (escape hatch)', async () => {
  let ran = false;
  const boom = async () => { throw new Error('network down'); };
  const { result, verdict } = await gate(
    { action: 'noop', inputs: {} },
    async () => { ran = true; return 'ok'; },
    { ...OPTS, fetch: boom, failOpen: true }
  );
  assert.equal(ran, true);
  assert.equal(result, 'ok');
  assert.equal(verdict, null);
});

test('action throws after GO → observes diverged and rethrows the original error', async () => {
  const observed = [];
  await assert.rejects(
    gate({ action: 'run_sql', inputs: {} }, async () => { throw new Error('constraint violation'); }, { ...OPTS, fetch: makeFetch(GO, observed) }),
    /constraint violation/
  );
  assert.equal(observed[0]?.outcome_class, 'diverged');
  assert.equal(observed[0]?.divergence_severity, 'high');
});

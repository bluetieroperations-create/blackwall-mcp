// Runnable demo of the gate() control — wrap a risky action so the BLACK_WALL
// check cannot be skipped. gate() forecasts, enforces the verdict (fails closed),
// runs your side effect only when allowed, and reports the outcome via observe().
//
//   BLACKWALL_API_KEY=bw_live_... node examples/gate-quickstart.mjs
//
// Expected: the benign query runs; the destructive one is BLOCKED and its side
// effect never executes.

import { gate, BlackWallBlocked } from '../lib/gate.mjs';

if (!process.env.BLACKWALL_API_KEY) {
  console.error('Set BLACKWALL_API_KEY (free key at https://blackwalltier.com/dashboard/keys).');
  process.exitCode = 1;
}

async function attempt(label, args, sideEffect) {
  try {
    const { result, verdict } = await gate(args, sideEffect);
    console.log(`✅ ${label}: ran — ${verdict.recommendation} (risk ${verdict.risk_score}) → ${result}`);
  } catch (e) {
    if (e instanceof BlackWallBlocked) {
      console.log(`🛑 ${label}: BLOCKED (${e.reason}) — side effect never executed`);
      for (const f of e.verdict?.red_flags ?? []) console.log(`     • [${f.severity}] ${f.code}`);
    } else {
      throw e; // a genuine error from the side effect
    }
  }
}

async function main() {
  // Benign read → GO → the side effect runs.
  await attempt(
    'SELECT 1',
    { action: 'run_sql', inputs: { statement: 'select 1' }, context: { user_intent: 'health check' } },
    async () => 'rows: [{ "?column?": 1 }]',
  );

  // Destructive → STOP → gate() blocks; the throw below proves it never runs.
  await attempt(
    'DROP TABLE users',
    { action: 'run_sql', inputs: { statement: 'DROP TABLE users;' }, context: { user_intent: 'remove one test row' } },
    async () => { throw new Error('THIS SIDE EFFECT MUST NEVER EXECUTE'); },
  );
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

/**
 * BLACK_WALL gate — the safeguard as a *control*, not a policy.
 *
 * Wrap any risky action so the forecast call cannot be skipped. The agent does
 * not have to remember to ask BLACK_WALL — `gate()` asks, enforces the verdict,
 * runs (or blocks) the action, and closes the loop with observe() automatically.
 *
 *   import { gate, BlackWallBlocked } from 'blackwall-mcp/lib/gate';
 *
 *   await gate(
 *     { action: 'revoke_api_key', inputs: { key_id }, context: { user_intent } },
 *     async () => db.revoke(key_id),                 // the actual side effect
 *     { onCaution: async (v) => confirmWithUser(v) } // CAUTION needs a yes; default = block
 *   );
 *
 * DOCTRINE — FAIL CLOSED. If the forecast cannot be obtained (network/auth/timeout)
 * or returns anything that is not an explicit GO, the action does NOT run unless the
 * caller opts in (onCaution returns true, or failOpen: true). A risk gate that fails
 * open is not a risk gate.
 */

import { forecast } from './forecast.mjs';
import { observe } from './observe.mjs';

/** Thrown when the gate refuses to run the action. Carries the verdict (if any). */
export class BlackWallBlocked extends Error {
  constructor(message, { verdict = null, reason = 'blocked' } = {}) {
    super(message);
    this.name = 'BlackWallBlocked';
    this.reason = reason;     // 'stop' | 'caution_declined' | 'forecast_unavailable' | 'unknown_verdict'
    this.verdict = verdict;   // the raw forecast response, when one was obtained
  }
}

const isGo = (v) =>
  (v?.recommendation || '').toUpperCase() === 'GO' ||
  (v?.gate || '').toUpperCase() === 'AUTO';

const isCaution = (v) =>
  ['CAUTION', 'CONFIRM'].includes((v?.recommendation || '').toUpperCase()) ||
  (v?.gate || '').toUpperCase() === 'CONFIRM';

/**
 * @typedef {Object} GateOptions
 * @property {string}  [apiKey]
 * @property {string}  [baseUrl]
 * @property {typeof fetch} [fetch]
 * @property {AbortSignal}  [signal]
 * @property {'standard'|'deep'} [depth]
 * @property {(verdict:object)=>boolean|Promise<boolean>} [onCaution]
 *           Called on CAUTION/CONFIRM. Return true to proceed, false to block. Default: block.
 * @property {boolean} [failOpen=false]  If true, run the action when the forecast is UNAVAILABLE.
 *           Strongly discouraged. Default false (fail closed).
 * @property {boolean} [autoObserve=true]  Report the actual outcome back to BLACK_WALL.
 * @property {(ctx:{ok:boolean,result?:any,error?:Error})=>object} [classify]
 *           Map the action result to observe() args. Default: matched / diverged / aborted.
 */

/**
 * Forecast → enforce → run → observe.
 *
 * @template T
 * @param {{action:string, inputs:object, context?:object, depth?:'standard'|'deep'}} args
 * @param {() => Promise<T>} run  The side-effecting action. Only invoked if the gate allows it.
 * @param {GateOptions} [opts]
 * @returns {Promise<{ result: T, verdict: object }>}
 * @throws {BlackWallBlocked} when the action is not permitted.
 */
export async function gate(args, run, opts = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('gate(args, run, opts): `run` must be a function (the action to guard).');
  }
  const { onCaution, failOpen = false, autoObserve = true, classify, ...clientOpts } = opts;

  // 1. Forecast. Failure to obtain a verdict is itself a STOP (unless failOpen).
  let verdict;
  try {
    verdict = await forecast(
      { action: args.action, inputs: args.inputs, context: args.context, depth: args.depth },
      clientOpts
    );
  } catch (err) {
    if (!failOpen) {
      throw new BlackWallBlocked(
        `BLACK_WALL unavailable (${err?.message ?? err}); failing closed — action "${args.action}" not run.`,
        { reason: 'forecast_unavailable' }
      );
    }
    // failOpen: proceed without a verdict, but we cannot observe (no forecast id).
    const result = await run();
    return { result, verdict: null };
  }

  const fid = verdict?.id;
  const reportOutcome = async (o) => {
    if (autoObserve && fid) { try { await observe(fid, o, clientOpts); } catch { /* never mask the action outcome */ } }
  };

  // 2. Enforce the verdict.
  let allowed = isGo(verdict);
  if (!allowed && isCaution(verdict)) {
    allowed = typeof onCaution === 'function' ? Boolean(await onCaution(verdict)) : false;
    if (!allowed) {
      await reportOutcome(classify?.({ ok: false }) ?? { outcome_class: 'aborted', divergence_severity: 'none', details: 'CAUTION not confirmed by caller.' });
      throw new BlackWallBlocked(`BLACK_WALL: CAUTION on "${args.action}" was not confirmed — action not run.`, { verdict, reason: 'caution_declined' });
    }
  } else if (!allowed) {
    // STOP, or any verdict we don't recognize → fail closed.
    const reason = (verdict?.recommendation || '').toUpperCase() === 'STOP' ? 'stop' : 'unknown_verdict';
    await reportOutcome(classify?.({ ok: false }) ?? { outcome_class: 'aborted', divergence_severity: 'none', details: `Verdict ${verdict?.recommendation ?? '(none)'} — action not run.` });
    throw new BlackWallBlocked(`BLACK_WALL: ${reason.toUpperCase()} on "${args.action}" — action not run.`, { verdict, reason });
  }

  // 3. Run the action and 4. observe the real outcome (closing the loop).
  try {
    const result = await run();
    await reportOutcome(classify?.({ ok: true, result }) ?? { outcome_class: 'matched', divergence_severity: 'none', details: 'Action completed.' });
    return { result, verdict };
  } catch (err) {
    await reportOutcome(classify?.({ ok: false, error: err }) ?? { outcome_class: 'diverged', divergence_severity: 'high', details: `Action threw: ${err?.message ?? err}` });
    throw err;
  }
}

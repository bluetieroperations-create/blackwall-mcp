/**
 * BLACK_WALL forecast — library entry point.
 *
 * Pure(ish) HTTP client for POST /api/v1/forecast. Returns the parsed API
 * response on success and throws on transport / non-2xx errors. Designed for
 * embedding (e.g. an ElizaOS plugin) so callers can apply their own gating
 * logic on top of the verdict.
 *
 * The MCP server's stdio entry point (../index.mjs) wraps this and reformats
 * the result as MCP `content` blocks — keep that wrapper as the single place
 * that emits human/LLM-facing text.
 */

const DEFAULT_BASE_URL = 'https://blackwalltier.com';

/**
 * @typedef {Object} ForecastArgs
 * @property {string} action               Action name (e.g. 'send_email', 'run_sql', 'make_payment').
 * @property {Record<string, any>} inputs  Concrete parameters of the action.
 * @property {Record<string, any>} [context] Optional situational context.
 * @property {'standard'|'deep'} [depth]  Analysis depth.
 */

/**
 * @typedef {Object} ForecastOptions
 * @property {string} [apiKey]   Defaults to process.env.BLACKWALL_API_KEY.
 * @property {string} [baseUrl]  Defaults to process.env.BLACKWALL_BASE_URL or https://blackwalltier.com.
 * @property {typeof fetch} [fetch] Inject a fetch implementation (for tests).
 * @property {AbortSignal} [signal]
 */

/**
 * Call BLACK_WALL forecast. Returns the parsed JSON body — typically:
 *   { id, recommendation, risk_score, red_flags, gate, reversibility, receipt, ... }
 *
 * Throws on missing apiKey, network failure, or non-2xx HTTP. Error objects
 * carry `.status` and `.body` when the failure was an HTTP error response.
 *
 * @param {ForecastArgs} args
 * @param {ForecastOptions} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function forecast({ action, inputs, context, depth, parent_forecast_id }, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.BLACKWALL_API_KEY;
  if (!apiKey) {
    throw new Error(
      'BLACK_WALL: missing apiKey (set BLACKWALL_API_KEY or pass opts.apiKey). ' +
        'Free key at https://blackwalltier.com/dashboard/keys'
    );
  }
  const baseUrl = (opts.baseUrl ?? process.env.BLACKWALL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('BLACK_WALL: no fetch implementation available — pass opts.fetch or run on Node >=18.');
  }

  // A pre-action risk gate must answer quickly or fail — it must never hang the caller
  // waiting on a slow/dead backend. Default a timeout when the caller didn't supply their
  // own AbortSignal. Override via opts.timeoutMs or BLACKWALL_TIMEOUT_MS (floor 1000ms).
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs ?? process.env.BLACKWALL_TIMEOUT_MS) || 15000);
  const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/v1/forecast`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action,
        inputs,
        ...(context ? { context } : {}),
        ...(depth ? { options: { depth } } : {}),
        // Per-call threading: tie this forecast to a multi-step action's first
        // forecast id, so per-call checks on irreversible writes share one chain.
        ...(parent_forecast_id ? { parent_forecast_id } : {}),
      }),
      signal,
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const wrapped = new Error(
      timedOut
        ? `BLACK_WALL forecast request timed out after ${timeoutMs}ms`
        : `BLACK_WALL forecast request failed (network): ${err?.message ?? err}`
    );
    wrapped.cause = err;
    throw wrapped;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(`BLACK_WALL forecast error (${res.status}): ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  // FAIL CLOSED: a 2xx with an unparseable, empty, or verdict-less body is NOT a "proceed"
  // signal. `res.json().catch(() => ({}))` above turns a malformed 200 (CDN interstitial,
  // captive portal, truncated proxy body, backend returning HTML) into `{}`; returning that
  // would let a downstream gate render "Cleared to proceed." Throw instead, so every
  // consumer — the MCP server or an embedding caller — treats it as a failure, not approval.
  if (!data || typeof data !== 'object' || data.recommendation == null || data.risk_score == null) {
    const err = new Error(
      'BLACK_WALL forecast returned no usable risk verdict (a 2xx response with an ' +
        'unparseable or verdict-less body).'
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

export default forecast;

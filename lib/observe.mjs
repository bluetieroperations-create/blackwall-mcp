/**
 * BLACK_WALL observe — library entry point.
 *
 * Closes the loop with an earlier forecast. PATCHes /api/v1/forecast/:id/outcome
 * with structured actual_outcome data. Free (no tokens charged).
 *
 * Like forecast.mjs, this throws on errors; callers (MCP server, Eliza
 * guardrail plugin, etc.) decide how to surface failures.
 */

const DEFAULT_BASE_URL = 'https://blackwalltier.com';

/**
 * @typedef {Object} ObserveArgs
 * @property {'matched'|'over_scope'|'under_scope'|'no_op'|'diverged'|'aborted'} [outcome_class]
 * @property {'none'|'low'|'medium'|'high'|'critical'} [divergence_severity]
 * @property {string[]} [actual_targets]
 * @property {string} [details]
 */

/**
 * @typedef {Object} ObserveOptions
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {typeof fetch} [fetch]
 * @property {AbortSignal} [signal]
 */

/**
 * Report the actual outcome of an action against an earlier forecast.
 *
 * @param {string} forecastId  The `id` returned by an earlier forecast() call.
 * @param {ObserveArgs} [args]
 * @param {ObserveOptions} [opts]
 * @returns {Promise<Record<string, any>>}  Parsed API response.
 */
export async function observe(forecastId, args = {}, opts = {}) {
  if (!forecastId || typeof forecastId !== 'string') {
    throw new Error('BLACK_WALL observe: forecastId (string) is required.');
  }

  const apiKey = opts.apiKey ?? process.env.BLACKWALL_API_KEY;
  if (!apiKey) {
    throw new Error('BLACK_WALL observe: missing apiKey (set BLACKWALL_API_KEY or pass opts.apiKey).');
  }
  const baseUrl = (opts.baseUrl ?? process.env.BLACKWALL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('BLACK_WALL observe: no fetch implementation available — pass opts.fetch or run on Node >=18.');
  }

  // Default a timeout when none supplied, so a hung backend can't block the caller.
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs ?? process.env.BLACKWALL_TIMEOUT_MS) || 15000);
  const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

  const { outcome_class, divergence_severity, actual_targets, details } = args;

  const actualOutcome = {
    ...(outcome_class ? { outcome_class } : {}),
    ...(divergence_severity ? { divergence_severity } : {}),
    ...(actual_targets ? { actual_targets } : {}),
    ...(details ? { details } : {}),
    reported_via: opts.reportedVia ?? 'lib_observe',
    reported_at: new Date().toISOString(),
  };

  let res;
  try {
    res = await fetchImpl(
      `${baseUrl}/api/v1/forecast/${encodeURIComponent(forecastId)}/outcome`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          actual_outcome: actualOutcome,
          customer_notes: details ?? null,
        }),
        signal,
      }
    );
  } catch (err) {
    const wrapped = new Error(`BLACK_WALL observe request failed (network): ${err?.message ?? err}`);
    wrapped.cause = err;
    throw wrapped;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(`BLACK_WALL observe error (${res.status}): ${msg}`);
    err.status = res.status;
    err.body = data;
    err.forecastId = forecastId;
    throw err;
  }

  return data;
}

export default observe;

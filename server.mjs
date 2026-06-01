/**
 * BLACK_WALL MCP server factory
 * -----------------------------
 * Builds an McpServer with the `forecast` and `observe` tools registered.
 * Shared by both transports:
 *   - index.mjs  → stdio   (one server, key from env: single-tenant local host)
 *   - http.mjs   → HTTP    (one server PER request, key from the request's
 *                           Authorization header: multi-tenant remote endpoint)
 *
 * The handlers close over the { apiKey, baseUrl, mode } passed here instead of
 * reading module globals, so the HTTP transport can bind a different caller's
 * key on every request without any shared mutable state.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { forecast } from './lib/forecast.mjs';
import { observe } from './lib/observe.mjs';

const DEFAULT_BASE_URL = 'https://blackwalltier.com';

/**
 * @param {object} cfg
 * @param {string} [cfg.apiKey]   caller's bw_live_… key (may be undefined; the
 *                                forecast tool returns a clear error if so, which
 *                                keeps tools/list working for registry scanners).
 * @param {string} [cfg.baseUrl]  defaults to https://blackwalltier.com
 * @param {'enforce'|'observe'} [cfg.mode]  defaults to 'enforce'
 * @returns {McpServer}
 */
export function buildServer({ apiKey, baseUrl, mode } = {}) {
  const BASE_URL = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const MODE = String(mode || 'enforce').toLowerCase() === 'observe' ? 'observe' : 'enforce';
  const API_KEY = apiKey;

  const server = new McpServer({ name: 'blackwall', version: '1.4.1' });

  server.registerTool(
    'forecast',
    {
      title: 'BLACK_WALL pre-action risk check',
      description:
        'Call this BEFORE taking ANY irreversible or high-stakes action — sending an email, ' +
        'making a payment, running SQL, deleting files or data, posting public content, calling ' +
        'an external API that changes state. It returns a risk score (0–100), a recommendation ' +
        '(GO / CAUTION / STOP), and named red flags. If the recommendation is STOP, do not take ' +
        'the action — surface the flags to the user instead. If CAUTION, confirm with the user first.',
      inputSchema: {
        action: z
          .string()
          .describe(
            "The action about to be taken, e.g. 'send_email', 'make_payment', 'run_sql', " +
              "'delete_file', 'delete_database', 'post_content', 'api_call'."
          ),
        inputs: z
          .record(z.any())
          .describe(
            'The concrete parameters of the action: recipient, amount_usd, SQL statement, ' +
              'file path, message body, URL, etc. Include everything relevant to judging risk.'
          ),
        context: z
          .record(z.any())
          .optional()
          .describe(
            "Optional situational context: { agent_role, user_intent, environment } — helps " +
              'the model judge whether the action fits the intent.'
          ),
        depth: z
          .enum(['standard', 'deep'])
          .optional()
          .describe("Analysis depth. 'standard' (default) or 'deep' (more thorough, costs more)."),
      },
    },
    async ({ action, inputs, context, depth }) => {
      if (!API_KEY) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'BLACK_WALL: missing API key. Set BLACKWALL_API_KEY in your MCP host config (stdio) or send Authorization: Bearer <key> (HTTP) — free key at https://blackwalltier.com/dashboard/keys' }],
        };
      }

      let data;
      try {
        data = await forecast(
          { action, inputs, context, depth },
          { apiKey: API_KEY, baseUrl: BASE_URL }
        );
      } catch (err) {
        // FAIL CLOSED. forecast() throws on network failure, timeout, non-2xx, OR a 2xx with
        // no usable verdict. A risk gate must never imply "proceed" on its own failure — in
        // enforce OR observe mode — so surface every such case as STOP / HUMAN REQUIRED.
        const reason = err?.status
          ? `${err.message.replace(/^BLACK_WALL forecast error \(\d+\):\s*/, '')} (HTTP ${err.status})`
          : (err?.message ?? String(err));
        return {
          isError: true,
          content: [{
            type: 'text',
            text:
              '🛑 BLACK_WALL UNAVAILABLE — could not obtain a risk verdict. Treat this as ' +
              'STOP / HUMAN REQUIRED: do not take the action autonomously; confirm with a human.\n' +
              `Reason: ${reason}`,
          }],
        };
      }

      const flags = Array.isArray(data.red_flags) ? data.red_flags : [];
      const flagLines = flags.length
        ? flags
            .map((f) => `  • [${(f.severity ?? '?').toUpperCase()}] ${f.code ?? ''}${f.message ? ` — ${f.message}` : ''}`)
            .join('\n')
        : '  (none)';

      const verdictEmoji =
        data.recommendation === 'STOP' ? '🛑' : data.recommendation === 'CAUTION' ? '⚠️' : '✅';

      const gate = data.gate;
      const rev = data.reversibility;

      // In observe mode the verdict is logged for review but the agent is always cleared to
      // proceed — so adding this tool changes nothing about how the agent behaves.
      const guidance =
        MODE === 'observe'
          ? '👁 OBSERVE MODE — logged for review, not enforced. Proceed normally.'
          : gate === 'HUMAN_REQUIRED'
            ? 'HUMAN REQUIRED — high-risk and hard to undo. The action has NOT run; do not act autonomously, escalate to a human, and do not build on it.'
            : gate === 'CONFIRM'
              ? 'CONFIRM with the user before proceeding. The action has NOT run yet.'
              : data.recommendation === 'STOP'
                ? 'DO NOT take this action — it has NOT been executed. Surface the red flags and pivot to a safer alternative; do not build on it.'
                : 'Cleared to proceed.';

      const revLine = rev?.class
        ? `\nReversibility: ${rev.class}${rev.rollback_cost != null ? ` (rollback cost ${rev.rollback_cost}/100)` : ''}`
        : '';

      // Verifiable decision receipt — Ed25519 signature anyone can verify offline
      // against the published public key at /.well-known/blackwall-signing-keys.json.
      const receiptLine = data.receipt?.id
        ? `\nReceipt: ${data.receipt.id} (verifiable at ${data.receipt.verify_url ?? 'https://blackwalltier.com/api/v1/receipts/verify'})`
        : '';

      const header =
        MODE === 'observe'
          ? `👁 BLACK_WALL (observe): would be ${data.recommendation} — risk ${data.risk_score}/100${gate ? ` · gate ${gate}` : ''}`
          : `${verdictEmoji} BLACK_WALL: ${data.recommendation} — risk ${data.risk_score}/100${gate ? ` · gate ${gate}` : ''}`;

      const summary =
        header +
        (data.confidence != null ? ` (confidence ${data.confidence})` : '') +
        revLine +
        receiptLine +
        `\n\nRed flags:\n${flagLines}` +
        `\n\nLatency: ${data.latency_ms ?? '?'}ms · tokens charged: ${data.tokens_charged ?? '?'}` +
        `\n\nGuidance: ${guidance}`;

      return {
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: 'Raw response:\n```json\n' + JSON.stringify(data, null, 2) + '\n```' },
        ],
      };
    }
  );

  server.registerTool(
    'observe',
    {
      title: 'BLACK_WALL post-action observation',
      description:
        'Call this AFTER an action runs (or after deciding NOT to run it because BLACK_WALL ' +
        'returned STOP/HUMAN_REQUIRED) to report what actually happened. Closes the loop with the ' +
        'earlier forecast — BLACK_WALL compares your observation to the prediction to track ' +
        'accuracy and improve future forecasts. FREE — no tokens charged. Always call this if you ' +
        'have a forecast_id from a recent `forecast` call.',
      inputSchema: {
        forecast_id: z
          .string()
          .describe(
            'The id returned by the matching `forecast` call (the top-level `id` field in that response). ' +
            'Required.'
          ),
        outcome_class: z
          .enum(['matched', 'over_scope', 'under_scope', 'no_op', 'diverged', 'aborted'])
          .optional()
          .describe(
            "How the actual outcome compared to the prediction. " +
            "'matched' = exactly as predicted. " +
            "'over_scope' = affected MORE than predicted (e.g. DELETE hit 1247 rows when 1 was expected). " +
            "'under_scope' = affected less than predicted. " +
            "'no_op' = action ran but had no effect. " +
            "'diverged' = result was qualitatively different (e.g. unexpected error class). " +
            "'aborted' = action was NOT taken (use this when you obeyed a STOP/HUMAN_REQUIRED verdict)."
          ),
        divergence_severity: z
          .enum(['none', 'low', 'medium', 'high', 'critical'])
          .optional()
          .describe(
            "How bad the divergence was. Use 'none' for 'matched' or 'aborted' outcomes."
          ),
        actual_targets: z
          .array(z.string())
          .optional()
          .describe(
            'IDs / paths / hashes of what was actually affected (e.g. user_ids, file paths, ' +
            'transaction hashes, row counts as strings). Helps reconstruct the event later.'
          ),
        details: z
          .string()
          .optional()
          .describe(
            'Free-form details: what actually happened, error messages, observed side effects, ' +
            'anything that helps trace the event back later.'
          ),
      },
    },
    async ({ forecast_id, outcome_class, divergence_severity, actual_targets, details }) => {
      if (!API_KEY) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'BLACK_WALL: missing API key. Set BLACKWALL_API_KEY (stdio) or send Authorization: Bearer <key> (HTTP).' }],
        };
      }

      try {
        await observe(
          forecast_id,
          { outcome_class, divergence_severity, actual_targets, details },
          { apiKey: API_KEY, baseUrl: BASE_URL, reportedVia: 'mcp_observe' }
        );
      } catch (err) {
        if (err?.status === 404) {
          return {
            isError: true,
            content: [{ type: 'text', text: `BLACK_WALL observe: forecast ${forecast_id} not found (or owned by a different account). Double-check the forecast_id from your earlier forecast response.` }],
          };
        }
        const text = err?.status
          ? `BLACK_WALL observe error (${err.status}): ${err.message.replace(/^BLACK_WALL observe error \(\d+\):\s*/, '')}`
          : `BLACK_WALL observe request failed: ${err?.message ?? err}`;
        return {
          isError: true,
          content: [{ type: 'text', text }],
        };
      }

      const summary =
        `✓ Observation recorded for forecast ${forecast_id}` +
        (outcome_class ? ` · ${outcome_class}` : '') +
        (divergence_severity && divergence_severity !== 'none' ? ` (severity ${divergence_severity})` : '') +
        `.`;

      return {
        content: [{ type: 'text', text: summary }],
      };
    }
  );

  return server;
}

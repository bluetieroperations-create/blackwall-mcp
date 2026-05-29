#!/usr/bin/env node
/**
 * BLACK_WALL MCP server
 * ---------------------
 * Exposes BLACK_WALL's pre-action risk check as an MCP tool so any MCP-compatible
 * host (Claude Desktop, Claude Code, Cursor, Windsurf, etc.) can let its
 * agent ask "is this action safe?" BEFORE doing something irreversible.
 *
 * Config (env):
 *   BLACKWALL_API_KEY   required — your bw_live_… key from blackwalltier.com/dashboard/keys
 *   BLACKWALL_BASE_URL  optional — defaults to https://blackwalltier.com
 *   BLACKWALL_MODE      optional — 'enforce' (default) or 'observe'
 *
 * Run: BLACKWALL_API_KEY=bw_live_xxx node index.mjs   (stdio transport)
 *
 * Note: HTTP/transport logic for forecast & observe lives in ./lib so the same
 * client code can be reused by non-MCP consumers (e.g. an ElizaOS plugin).
 * This file only wires the lib into MCP `content` envelopes.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { forecast } from './lib/forecast.mjs';
import { observe } from './lib/observe.mjs';

const API_KEY = process.env.BLACKWALL_API_KEY;
const BASE_URL = (process.env.BLACKWALL_BASE_URL || 'https://blackwalltier.com').replace(/\/$/, '');

// Don't exit when the key is missing — the server still starts and exposes the
// `forecast` tool for introspection (tools/list). The key is required only when
// `forecast` is actually called (checked in the handler below). This lets MCP
// directories/scanners verify the server boots without needing credentials.
if (!API_KEY) {
  // Write to stderr — stdout is reserved for the MCP protocol.
  console.error('[blackwall-mcp] No BLACKWALL_API_KEY set — server starts, but forecast calls will fail until you set one (https://blackwalltier.com/dashboard/keys).');
}

// 'observe' = score + log everything but NEVER tell the agent to stop (zero behavior change,
//             safe to drop into any agent). 'enforce' = surface STOP/CAUTION as real guidance.
const MODE = (process.env.BLACKWALL_MODE || 'enforce').toLowerCase() === 'observe' ? 'observe' : 'enforce';

const server = new McpServer({
  name: 'blackwall',
  version: '1.1.1',
});

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
        content: [{ type: 'text', text: 'BLACK_WALL: missing BLACKWALL_API_KEY. Set it in your MCP host config — free key at https://blackwalltier.com/dashboard/keys' }],
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
    // Surface the receipt id so the agent can log it for later audit/replay.
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

// ----------------------------------------------------------------------------
// observe — post-action outcome capture (closes the loop with forecast)
// ----------------------------------------------------------------------------
//
// Call this AFTER an action runs (or after deciding NOT to run it because of a
// STOP verdict) to report what actually happened. Black_Wall compares your
// observation to the original prediction to track accuracy over time. FREE —
// no tokens charged.
//
// The agent should call `observe` whenever it has a forecast_id from an earlier
// `forecast` call AND it knows the actual outcome. Skip if you don't have a
// forecast_id to associate. Multiple observations per forecast: last write wins
// for now; full audit history will move to a dedicated observations table later.
//
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
        content: [{ type: 'text', text: 'BLACK_WALL: missing BLACKWALL_API_KEY. Set it in your MCP host config.' }],
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
      content: [
        { type: 'text', text: summary },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[blackwall-mcp] ready (stdio) · base=' + BASE_URL);

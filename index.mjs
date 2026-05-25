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
 *
 * Run: BLACKWALL_API_KEY=bw_live_xxx node index.mjs   (stdio transport)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
  version: '1.0.8',
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
    let res;
    try {
      res = await fetch(`${BASE_URL}/api/v1/forecast`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          inputs,
          ...(context ? { context } : {}),
          ...(depth ? { options: { depth } } : {}),
        }),
      });
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `BLACK_WALL request failed (network): ${err?.message ?? err}` }],
      };
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      return {
        isError: true,
        content: [{ type: 'text', text: `BLACK_WALL error (${res.status}): ${msg}` }],
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

    const header =
      MODE === 'observe'
        ? `👁 BLACK_WALL (observe): would be ${data.recommendation} — risk ${data.risk_score}/100${gate ? ` · gate ${gate}` : ''}`
        : `${verdictEmoji} BLACK_WALL: ${data.recommendation} — risk ${data.risk_score}/100${gate ? ` · gate ${gate}` : ''}`;

    const summary =
      header +
      (data.confidence != null ? ` (confidence ${data.confidence})` : '') +
      revLine +
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[blackwall-mcp] ready (stdio) · base=' + BASE_URL);

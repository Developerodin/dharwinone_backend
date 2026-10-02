// Context builder + tool ledger for Sage's tool-calling agent loop.
//
// Per architecture.md §7b, the agent loop's `input` is:
//   [stable prefix] + [turn context] + [history] + [this turn's tool items]
//
// This module owns everything except the stable prefix (owned by the caller,
// passed through untouched so OpenAI's prompt cache can key on it) and "this
// turn's tool items" (owned by the loop itself — `compactTurnItems` only
// trims them when they grow too large).
//
// Deliberately does not import the tool registry or the loop: this file must
// stay usable from Task 5's loop without a dependency cycle.

import ConversationMemory from '../../../models/conversationMemory.model.js';
import { transcriptLedgerFields } from '../quoteGrounding.js';

// The timezone the model is told "today" in; day-window tools bound their days in it too.
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const HISTORY_TURNS = 6;
const LEDGER_TURNS = 6;
const ARGS_CHAR_CAP = 300;

// ─── Turn-context message ──────────────────────────────────────────────────

function formatDateInTimezone(date, timezone) {
  // en-CA formats as YYYY-MM-DD, which is exactly the ISO date shape we want —
  // avoids hand-rolling timezone math or adding a date library dependency.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Render the user's role label from already-resolved role names. This module
 * never hits the DB itself — `req.user.roleIds` are raw unpopulated
 * ObjectIds in production, so there is nothing usable to "read defensively"
 * off `user` here. The caller resolves names once (e.g. via
 * `resolveViewerRoleNames(user)` in runAgent.js, which the loop
 * already awaits alongside the rest of the request setup) and passes the
 * resulting string array in.
 */
function resolveRoleLabel(roleNames) {
  if (Array.isArray(roleNames) && roleNames.length) return roleNames.join(' + ');
  return 'User';
}

function safeStringifyArgs(args) {
  if (args === undefined) return '{}';
  // Already a string — e.g. summarizeCalls' capArgs stored a truncated JSON
  // string in place of an oversized object. Render it as-is; JSON.stringify
  // would wrap it in quotes and escape every embedded `"`, corrupting it.
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return '""';
  }
}

function renderLedgerLine(call) {
  const tool = call?.tool ?? 'unknown_tool';
  const argsJson = safeStringifyArgs(call?.args);
  const totalPart = call?.total != null ? ` → total ${call.total}` : '';
  return `${tool}(${argsJson})${totalPart}`;
}

function renderLedgerSection(ledger) {
  const entries = Array.isArray(ledger) ? ledger : [];
  const lines = [];
  for (const entry of entries) {
    const calls = Array.isArray(entry?.calls) ? entry.calls : [];
    for (const call of calls) lines.push(renderLedgerLine(call));
  }
  if (!lines.length) return '';
  return `Previous tool calls:\n${lines.join('\n')}`;
}

function buildTurnContextMessage({ user, roleNames, ledger, now, timezone }) {
  const effectiveNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const tz = timezone || DEFAULT_TIMEZONE;
  const todayIso = formatDateInTimezone(effectiveNow, tz);
  const name = user?.name || 'there';
  const roleLabel = resolveRoleLabel(roleNames);

  const parts = [
    `Today's date: ${todayIso} (${tz}).`,
    `User: ${name} (role: ${roleLabel}).`,
  ];
  const ledgerSection = renderLedgerSection(ledger);
  if (ledgerSection) parts.push(ledgerSection);

  return { role: 'developer', content: parts.join('\n\n') };
}

// ─── History trimming ───────────────────────────────────────────────────────

function isRenderableMessage(m) {
  return !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '';
}

/**
 * Group valid history messages into turns (one user message + its assistant
 * reply), then keep only the last `maxTurns`. A trailing unpaired user
 * message (the current query, not yet answered) forms its own one-message
 * turn and is always the last turn kept, since slicing is from the end.
 */
function trimToLastTurns(history, maxTurns) {
  const valid = (Array.isArray(history) ? history : []).filter(isRenderableMessage);

  const turns = [];
  let current = null;
  for (const msg of valid) {
    if (msg.role === 'user' || !current) {
      current = [msg];
      turns.push(current);
    } else {
      current.push(msg);
    }
  }

  return turns
    .slice(-maxTurns)
    .flat()
    .map((m) => ({ role: m.role, content: m.content }));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the per-step `input` array for the Responses API call, plus the
 * stable `instructions` string passed through unchanged.
 *
 * @param {object} args
 * @param {string} args.instructions stable prefix (base instructions + domain
 *   snippets + sorted tool schemas) — returned unchanged so OpenAI's prompt
 *   cache hits across users/turns. Nothing per-user/time-varying belongs here.
 * @param {{name?:string}} [args.user]
 * @param {string[]} [args.roleNames] the user's resolved role names, e.g.
 *   `await resolveViewerRoleNames(user)` (runAgent.js) — this module
 *   stays sync/pure and does not resolve them itself. Empty/omitted renders
 *   as 'User'; never guessed from `user.roleIds`/`user.role` (those are raw
 *   unpopulated ObjectIds on a real req.user, not names).
 * @param {Array<{role:string, content:*}>} [args.history] this request's chat messages
 * @param {Array<{at:Date, calls:Array}>} [args.ledger] prior agent turns' tool ledger
 * @param {Date} [args.now]
 * @param {string} [args.timezone] default 'Asia/Kolkata'
 * @param {{loaded:string[], instructions:string}} [args.preloaded] lazy registry only: domains
 *   loaded before step 1 (from the last ledger entry). Their instructions ride in the input,
 *   not in `instructions`, so the stable prefix stays identical across users and turns.
 * @returns {{instructions:string, input:Array}}
 */
export function buildAgentInput({ instructions, user, roleNames, history, ledger, now, timezone, preloaded } = {}) {
  const turnContext = buildTurnContextMessage({ user, roleNames, ledger, now, timezone });
  const trimmedHistory = trimToLastTurns(history, HISTORY_TURNS);
  const preloadMessage = preloaded?.loaded?.length
    ? { role: 'developer', content: `Tools already loaded for: ${preloaded.loaded.join(', ')}.\n\n${preloaded.instructions}` }
    : null;
  return {
    instructions,
    input: preloadMessage ? [turnContext, preloadMessage, ...trimmedHistory] : [turnContext, ...trimmedHistory],
  };
}

function isCompactedOutput(output) {
  if (typeof output !== 'string') return false;
  try {
    const parsed = JSON.parse(output);
    return !!(parsed && typeof parsed === 'object' && parsed.compacted === true);
  } catch {
    return false;
  }
}

function extractTotalFromOutput(output) {
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' && parsed.total != null ? parsed.total : null;
  } catch {
    return null;
  }
}

/**
 * Shrink this turn's accumulated Responses-API items (messages, function_call,
 * function_call_output, reasoning) to fit `budgetChars`, by replacing the
 * OLDEST function_call_output.output strings with a short ledger-style
 * summary first. Never drops or reorders items — every function_call keeps
 * its function_call_output, just with smaller content.
 *
 * @param {Array} items
 * @param {number} budgetChars <= 0 means "no budget" — items returned unchanged.
 * @param {{keepTools?:string[]}} [options] outputs of these tools are never compacted
 *   (the loop keeps find_tools' loaded-domain instructions). The budget is soft: kept
 *   outputs can leave the items above it.
 * @returns {Array} same reference when no compaction is needed; otherwise a
 *   new array (only the compacted entries are new objects).
 */
export function compactTurnItems(items, budgetChars, { keepTools = [] } = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  if (!(budgetChars > 0)) return items;
  if (JSON.stringify(items).length <= budgetChars) return items;

  const toolNameByCallId = new Map();
  for (const it of items) {
    if (it && it.type === 'function_call' && it.call_id && it.name) {
      toolNameByCallId.set(it.call_id, it.name);
    }
  }

  const result = items.slice();
  const compactableIndexes = [];
  result.forEach((it, i) => {
    if (
      it &&
      it.type === 'function_call_output' &&
      !keepTools.includes(toolNameByCallId.get(it.call_id)) &&
      !isCompactedOutput(it.output)
    ) {
      compactableIndexes.push(i);
    }
  });

  for (const idx of compactableIndexes) {
    const it = result[idx];
    const toolName = toolNameByCallId.get(it.call_id) || 'unknown_tool';
    const total = extractTotalFromOutput(it.output);
    const summary = total != null ? `${toolName} → total ${total}` : `${toolName} → (result omitted)`;
    result[idx] = { ...it, output: JSON.stringify({ compacted: true, summary }) };
    if (JSON.stringify(result).length <= budgetChars) break;
  }

  return result;
}

function capArgs(args) {
  if (args === undefined || args === null) return args;
  let json;
  try {
    json = JSON.stringify(args);
  } catch {
    return args;
  }
  // Small enough — keep the real object so the ledger line can render it.
  if (json.length <= ARGS_CHAR_CAP) return args;
  // Too big to keep verbatim in the ledger (persisted + replayed into every
  // future prompt) — store the truncated JSON text instead of the object.
  return json.slice(0, ARGS_CHAR_CAP);
}

/**
 * Build one ledger entry from this turn's tool calls.
 *
 * @param {Array<{name:string, args:object, output:*}>} calls
 * @returns {{at:Date, calls:Array<{tool:string, args:*, total:number|null, callId?:string, transcriptLoaded?:boolean}>}}
 */
export function summarizeCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  return {
    at: new Date(),
    calls: list.map((c) => {
      const output = c?.output && typeof c.output === 'object' ? c.output : {};
      const total = output.total ?? output.jobs?.length ?? null;
      const ref = transcriptLedgerFields(output);
      return {
        tool: c?.name,
        args: capArgs(c?.args),
        total,
        // call id only. The transcript body stays on the call record.
        ...(ref ? { callId: ref.callId, transcriptLoaded: ref.transcriptLoaded } : {}),
      };
    }),
  };
}

/**
 * Read the agent tool ledger off a ConversationMemory doc.
 * @param {{agentLedger?:Array}|null|undefined} memDoc
 * @returns {Array}
 */
export function readAgentLedger(memDoc) {
  return memDoc?.agentLedger ?? [];
}

/**
 * Append one ledger entry, capped to the last 6 agent turns, atomically.
 * Upserts on (userId, adminId), the collection's unique key. `expiresAt` is
 * set once when the row is created (the schema default, 30 days), and the TTL
 * index then drops the whole row, so the ledger restarts at most once a month.
 *
 * @param {object} args
 * @param {*} args.userId
 * @param {*} args.adminId
 * @param {{at:Date, calls:Array}} args.entry
 * @param {*} [args.ConversationMemoryModel] injected for tests; defaults to
 *   the real ConversationMemory model.
 */
export async function appendAgentLedger({ userId, adminId, entry, ConversationMemoryModel = ConversationMemory }) {
  return ConversationMemoryModel.findOneAndUpdate(
    { userId, adminId },
    { $push: { agentLedger: { $each: [entry], $slice: -LEDGER_TURNS } } },
    { upsert: true }
  );
}

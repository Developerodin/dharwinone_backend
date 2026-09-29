// Entry gate for Sage's agent loop: decides only "try the agent on this turn",
// never how to answer. A false positive costs one agent attempt (runAgent hands
// off → old pipeline); a false negative leaves the turn on the old pipeline.
//
// Domain-generic: a turn matches when any registered domain's `matchesTurn(text)`
// says so (agent/toolRegistry.js's matchedDomains), or a noun-less follow-up
// lands inside the recency window of the agent's last answered turn. Adding a
// domain is now just exporting `matchesTurn` from its `agent/tools/<domain>/index.js`
// — see agent/README.md's "widen the gate" section.

import config from '../../../config/config.js';
import logger from '../../../config/logger.js';
import ConversationMemory from '../../../models/conversationMemory.model.js';
import { readPendingJob } from '../jobProfile/pendingJob.js';
import { readPendingTitle } from '../conversationalEntity/pendingEntity.js';
import { matchedDomains, hasAgentToolAccess } from './toolRegistry.js';
import { readAgentLedger, appendAgentLedger } from './context.js';
import { runAgent } from './runAgent.js';

// A follow-up ("and the remote ones?") carries no noun of its own; the agent
// answered the last turn if its ledger entry is this fresh.
export const AGENT_TURN_WINDOW_MS = 30 * 60 * 1000;

// Appended when an attempted turn is handed back to the legacy pipeline while the
// window is open: the window means "the agent answered the last tool-backed turn",
// so a handoff closes it. Carries no `calls`, so ledger replay skips it.
const windowClosedEntry = (at) => ({ at, handoff: true });

// "what about jobs" after a job-vs-employee title prompt: tryJobConversationalRoute
// opens that title's job profile. Shared so the gate can leave the turn to it.
export const JOB_ENTITY_SWITCH_RE = /^\s*(?:ok\s+)?what about\s+jobs?\s*[.!]?\s*$/i;

/**
 * True when the agent's last ledger entry is younger than AGENT_TURN_WINDOW_MS
 * and is not a handoff (window-closed) marker.
 * @param {{agentLedger?:Array}|null|undefined} memDoc ConversationMemory doc
 * @param {Date} [now]
 * @returns {boolean}
 */
export function hasRecentAgentTurn(memDoc, now = new Date()) {
  const last = readAgentLedger(memDoc).at(-1);
  if (!last?.at || last.handoff) return false;
  const age = now.getTime() - new Date(last.at).getTime();
  return Number.isFinite(age) && age >= 0 && age < AGENT_TURN_WINDOW_MS;
}

/**
 * True when the turn names a registered domain (any domain's `matchesTurn`,
 * via toolRegistry.js's matchedDomains) or the agent answered the last
 * tool-backed turn recently.
 * @param {string} lastUserMsg
 * @param {{agentLedger?:Array}|null|undefined} memDoc ConversationMemory doc
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isAgentTurn(lastUserMsg, memDoc, now = new Date()) {
  const text = String(lastUserMsg || '');
  return matchedDomains(text).length > 0 || hasRecentAgentTurn(memDoc, now);
}

/**
 * An open disambiguation pick ("the job", "2", "the first job") belongs to its handler further down the pipeline, never to the
 * agent — the handler also clears the pick, and a pick left open would catch
 * a later "1". Reads the pending state off the already-loaded memDoc through
 * the readers' injectable model, so their TTL rules apply without extra queries.
 * @param {string} lastUserMsg
 * @param {object|null} memDoc
 * @returns {Promise<boolean>}
 */
export async function hasPendingPick(lastUserMsg, memDoc) {
  const fromMemDoc = { findOne: () => ({ lean: async () => memDoc }) };
  const [job, title] = await Promise.all([
    readPendingJob({ ConversationMemory: fromMemDoc }),
    readPendingTitle({ ConversationMemory: fromMemDoc }),
  ]);
  if (job || title) return true;
  return JOB_ENTITY_SWITCH_RE.test(String(lastUserMsg || ''))
    && !!memDoc?.lastEntities?.positionConversationState?.designation;
}

/**
 * Decide and run one agent attempt. Never throws: any failure → not answered,
 * and the caller continues the old pipeline.
 *
 * One attempt per turn: the entry call (`routerPicked:false`) tries turns the
 * gate accepts; the router-fallback call (`routerPicked:true`, the LLM router
 * picked a job tool) runs only when the entry call did not attempt — the caller
 * passes the entry's `attempted` through instead of re-evaluating the gate.
 *
 * @param {object} args
 * @param {object} args.client OpenAI client
 * @param {object} args.user
 * @param {*} args.adminId
 * @param {Array<{role:string, content:string}>} args.history
 * @param {string|null} [args.requestId]
 * @param {boolean} [args.routerPicked]
 * @param {object} [args.deps] test overrides
 * @param {Array<{domain:string, matchesTurn?:Function, tools:Array}>} [args.deps.domains] stub
 *   domain registry for tests; real registered domains (agent/tools/index.js) when omitted
 * @returns {Promise<{result:null|object, attempted:boolean}>}
 */
export async function tryAgentTurn({ client, user, adminId, history, requestId = null, routerPicked = false, deps = {} }) {
  const {
    enabled = () => !!config.chatbot?.agent?.enabled,
    loadMemDoc = ({ userId, adminId: aId }) =>
      (userId && aId ? ConversationMemory.findOne({ userId, adminId: aId }).lean() : null),
    domains,
    // Access = the user can call >=1 tool in a matched domain; with no domain
    // named this turn (a noun-less recency-window follow-up), any permitted
    // agent tool at all. Replaces the old hard-coded checkToolAccess('fetch_jobs').
    checkAccess = (u, matched) => hasAgentToolAccess(u, matched, domains ? { domains } : {}),
    pendingPick = hasPendingPick,
    run = runAgent,
    appendLedger = appendAgentLedger,
    now = () => new Date(),
  } = deps;
  const skip = { result: null, attempted: false };
  if (!enabled()) return skip;

  const userId = user?.id;
  try {
    const memDoc = await loadMemDoc({ userId, adminId });
    const lastUserMsg = history.filter((m) => m.role === 'user').pop()?.content ?? '';
    const matched = matchedDomains(lastUserMsg, domains ? { domains } : {});
    if (!routerPicked && !(matched.length > 0 || hasRecentAgentTurn(memDoc, now()))) return skip;
    if (!(await checkAccess(user, matched.length > 0 ? matched : null)).ok) return skip;
    if (await pendingPick(lastUserMsg, memDoc)) return skip;

    const result = await run({ client, user, history, memDoc, requestId });
    // An answer with no tool calls (a definition) writes nothing: it must not
    // re-arm the window. A handoff/null closes an open window, so the following
    // noun-less turns stop paying an agent attempt.
    let entry = null;
    if (result) {
      if (result.ledgerEntry?.calls?.length) entry = result.ledgerEntry;
    } else if (hasRecentAgentTurn(memDoc, now())) {
      entry = windowClosedEntry(now());
    }
    if (entry) {
      try {
        await appendLedger({ userId, adminId, entry });
      } catch (err) {
        logger.warn(`[agentGate] ledger persist failed user=${userId} requestId=${requestId ?? 'none'}: ${err.message}`);
      }
    }
    return { result: result ?? null, attempted: true };
  } catch (err) {
    logger.warn(`[agentGate] falling back to legacy pipeline user=${userId} requestId=${requestId ?? 'none'}: ${err?.message || err}`);
    return skip;
  }
}

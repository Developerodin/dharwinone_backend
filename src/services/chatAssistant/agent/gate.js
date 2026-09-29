// Sage's one chat path: load the tool ledger, run the agent loop, persist the
// turn's ledger entry, and turn anything that is not a clean answer into a fixed
// reply. Never throws — the chat must never go dark.

import logger from '../../../config/logger.js';
import ConversationMemory from '../../../models/conversationMemory.model.js';
import { appendAgentLedger } from './context.js';
import { runAgent } from './runAgent.js';

// Fixed replies for turns the agent does not answer. Digit-free on purpose: no
// number reaches the user unless a tool returned it this turn.
export const SAGE_REPLIES = Object.freeze({
  // The model called `handoff`: no tool fits the question.
  handoff:
    "I don't have that in the system right now. I can help with headcount, people lookup, attendance, leave, jobs, and projects — what do you need?",
  // A reply carried a number with no successful tool call behind it.
  untooledNumber:
    "I couldn't check that against the system, so I won't guess a number. Could you ask it another way, for example naming the jobs, people or dates you mean?",
  // Error, timeout, turn deadline, repeated tool failure or an empty reply.
  unavailable: "Sorry, I couldn't answer that right now. Please try again in a moment.",
});

/**
 * @param {string} outcome runAgent's outcome for a turn it did not answer
 * @returns {string}
 */
export function fallbackReply(outcome) {
  if (outcome === 'handoff') return SAGE_REPLIES.handoff;
  if (outcome === 'untooled_number') return SAGE_REPLIES.untooledNumber;
  return SAGE_REPLIES.unavailable;
}

/**
 * Run one chat turn through the agent. Never throws: a turn the agent does not
 * answer comes back as a fixed reply with no blocks.
 *
 * @param {object} args
 * @param {object} args.client OpenAI client
 * @param {object} args.user
 * @param {*} args.adminId
 * @param {Array<{role:string, content:string}>} args.history
 * @param {string|null} [args.requestId]
 * @param {{loadMemDoc?:Function, run?:Function, appendLedger?:Function}} [args.deps] test overrides
 * @returns {Promise<{reply:string, blocks:Array, meta:object|null, outcome:string}>}
 *   `meta` is runAgent's `{ steps, toolCalls, ms }` on an answer, null otherwise.
 */
export async function tryAgentTurn({ client, user, adminId, history, requestId = null, deps = {} }) {
  const {
    loadMemDoc = ({ userId, adminId: aId }) =>
      (userId && aId ? ConversationMemory.findOne({ userId, adminId: aId }).lean() : null),
    run = runAgent,
    appendLedger = appendAgentLedger,
  } = deps;
  const userId = user?.id;
  let outcome = 'error';
  try {
    const memDoc = await loadMemDoc({ userId, adminId });
    const result = await run({
      client,
      user,
      history,
      memDoc,
      requestId,
      onOutcome: (o) => {
        outcome = o;
      },
    });
    if (result) {
      // A no-tool answer (a greeting, a definition) has nothing to replay.
      if (result.ledgerEntry?.calls?.length) {
        try {
          await appendLedger({ userId, adminId, entry: result.ledgerEntry });
        } catch (err) {
          logger.warn(`[agentGate] ledger persist failed user=${userId} requestId=${requestId ?? 'none'}: ${err.message}`);
        }
      }
      return { reply: result.reply, blocks: result.blocks, meta: result.meta, outcome: 'answer' };
    }
  } catch (err) {
    outcome = 'error';
    logger.warn(`[agentGate] turn failed user=${userId} requestId=${requestId ?? 'none'}: ${err?.message || err}`);
  }
  logger.info(`[agentGate] fixed reply user=${userId} outcome=${outcome} requestId=${requestId ?? 'none'}`);
  return { reply: fallbackReply(outcome), blocks: [], meta: null, outcome };
}

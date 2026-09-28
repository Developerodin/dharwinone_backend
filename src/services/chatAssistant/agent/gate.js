// Entry gate for Sage's agent loop: decides only "try the agent on this turn",
// never how to answer. A false positive costs one agent attempt (runAgent hands
// off → old pipeline); a false negative leaves the turn on the old pipeline.
//
// Phase 1 = job nouns. Each migrated domain widens the noun test here; the end
// state is the agent as the default entry and this gate going away.

import { hasJobSubjectNoun } from '../queryPlanner/entities/jobFilter.js';
import { looksLikeJobRankingQuery } from '../queryPlanner/entities/jobRank.js';
import { readAgentLedger } from './context.js';

// A follow-up ("and the remote ones?") carries no noun of its own; the agent
// answered the last turn if its ledger entry is this fresh.
export const AGENT_TURN_WINDOW_MS = 30 * 60 * 1000;

/**
 * True when the agent's last ledger entry is younger than AGENT_TURN_WINDOW_MS.
 * @param {{agentLedger?:Array}|null|undefined} memDoc ConversationMemory doc
 * @param {Date} [now]
 * @returns {boolean}
 */
export function hasRecentAgentTurn(memDoc, now = new Date()) {
  const at = readAgentLedger(memDoc).at(-1)?.at;
  if (!at) return false;
  const age = now.getTime() - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 && age < AGENT_TURN_WINDOW_MS;
}

/**
 * @param {string} lastUserMsg
 * @param {{agentLedger?:Array}|null|undefined} memDoc ConversationMemory doc
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isAgentTurn(lastUserMsg, memDoc, now = new Date()) {
  const text = String(lastUserMsg || '');
  return hasJobSubjectNoun(text) || looksLikeJobRankingQuery(text) || hasRecentAgentTurn(memDoc, now);
}

/**
 * Canonical call-source classification. ONE implementation — the model's
 * pre-save hook, upsertDialerCallRecord, and the backfill script all call this.
 *
 * Distinct from CallRecord.source, which is row *provenance*
 * (initiate/webhook/reconciliation/backfill/legacy) and keeps its meaning.
 * provider='twilio' does NOT imply telephony: the Bolna AI agent dials over
 * Twilio too, so the configured AI caller ID is checked first.
 */
import config from '../config/config.js';
import { normalizePhone } from './phone.js';

export const CALL_SOURCES = {
  AI_AGENT: 'ai_agent',
  TELEPHONY: 'telephony',
  IN_APP: 'in_app',
};

/** The three user-facing categories. Unclassified legacy rows are null and appear in none of them. */
export const UI_CALL_SOURCES = [CALL_SOURCES.AI_AGENT, CALL_SOURCES.TELEPHONY, CALL_SOURCES.IN_APP];

const CALL_SID_RE = /^CA[a-f0-9]{32}$/i;

/**
 * Configured AI caller IDs (current + retired), E.164-normalized. Config only —
 * never client input (§15). Retired numbers matter because history outlives them.
 */
function aiAgentNumbers() {
  const raw = config.bolna?.allFromNumbers?.length
    ? config.bolna.allFromNumbers
    : [config.bolna?.fromPhoneNumber].filter(Boolean);
  return new Set(raw.map((n) => normalizePhone(String(n))).filter(Boolean));
}

function isAiAgentNumber(value) {
  if (!value) return false;
  const norm = normalizePhone(String(value));
  return Boolean(norm) && aiAgentNumbers().has(norm);
}

/**
 * @param {object} ctx - a CallRecord (or the fields about to be written)
 * @returns {'ai_agent'|'telephony'|'in_app'|null} null = genuinely unclassifiable
 */
export function classifyCallSource(ctx = {}) {
  const provider = String(ctx.provider ?? ctx.telephonyData?.provider ?? '').toLowerCase();

  // 1. Explicit in-app signal. CallRecords never carry one today (LiveKit calls
  //    live in the ChatCall collection) — this exists so an in-app row can never
  //    fall through to telephony just because its phone fields are null.
  if (ctx.isInApp === true || provider === 'livekit') return CALL_SOURCES.IN_APP;

  const hasAgentId = Boolean(String(ctx.agentId || '').trim());

  // 2. Our browser/bridge dialer, keyed by a Twilio CallSid and never carrying a
  //    Bolna agent id. This outranks the caller-ID check below because the
  //    configured AI number is ALSO in the assignable company-work-number pool,
  //    so a human can and does place dialer calls from it. A Bolna execution is
  //    never keyed by a CallSid, so this cannot swallow an AI call.
  if (!hasAgentId && CALL_SID_RE.test(String(ctx.executionId || ''))) {
    return CALL_SOURCES.TELEPHONY;
  }

  // 3. AI agent beats generic telephony (§7). agentId is the strongest signal:
  //    it is the *Bolna* agent id, written only by the Bolna paths. Matching the
  //    configured agent list instead would misclassify calls placed by
  //    since-retired agents, and Bolna's own telephony payload reports
  //    provider='twilio', so provider cannot decide either. The configured
  //    caller IDs then cover rows written before agentId tagging.
  if (hasAgentId) return CALL_SOURCES.AI_AGENT;
  if (provider === 'bolna') return CALL_SOURCES.AI_AGENT;
  if (isAiAgentNumber(ctx.fromPhoneNumber) || isAiAgentNumber(ctx.userNumber)) {
    return CALL_SOURCES.AI_AGENT;
  }

  // 4. Ordinary PSTN call through the telephony provider.
  if (provider === 'twilio' || provider === 'plivo') return CALL_SOURCES.TELEPHONY;

  // 5. Not enough information. Left unclassified rather than guessed (§9).
  return null;
}

export default { CALL_SOURCES, UI_CALL_SOURCES, classifyCallSource };

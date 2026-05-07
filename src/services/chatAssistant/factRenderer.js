// uat.dharwin.backend/src/services/chatAssistant/factRenderer.js
//
// Deterministic count answers — bypass the LLM for trivial "how many"
// questions where the retrieval layer already has an authoritative number.
// Returns a string when the question + facts combination is safe to answer
// directly, otherwise null (caller falls through to LLM).
//
// Design rule: only renders when the question is unambiguously a count
// request AND the primary fact is a single number. Anything richer (lists,
// breakdowns, profiles, mixed queries) returns null so the LLM can format.

const COUNT_QUESTION_RE =
  /^\s*(how\s+many|number\s+of|count\s+of|total\s+(number\s+of|of)|what(?:'s| is)\s+the\s+(?:number|count|total)\s+of)\b/i;

// Phrases that need richer formatting — never short-circuit.
const NEEDS_LLM_RE = /\b(list|show|tell me about|details|profile|breakdown|who(\s+are|'s)|names?|email|phone|salary)\b/i;

function pluralise(label, n) {
  if (n === 1 && label.endsWith('s')) return label.slice(0, -1);
  return label;
}

// Lowercase a role name for natural sentence rendering ("agent" not "Agent").
// Keeps multi-word roles intact ("sales agent").
function pickLabelForRender(primary) {
  if (primary?.role) {
    const r = String(primary.role).trim();
    const lc = r.toLowerCase();
    return lc.endsWith('s') ? lc : `${lc}s`;
  }
  return primary?.label || 'records';
}

/**
 * Try to deterministically render an answer for the user's question.
 * Returns a string OR null.
 *
 * @param {string} userMsg
 * @param {{ counts: object[], primary: object|null }} facts
 * @returns {string|null}
 */
export function renderDeterministicAnswer(userMsg, facts) {
  if (!userMsg || !facts?.primary) return null;
  if (NEEDS_LLM_RE.test(userMsg)) return null;
  if (!COUNT_QUESTION_RE.test(userMsg)) return null;

  const p = facts.primary;
  if (typeof p.total !== 'number') return null;

  if (p.kind === 'attendance_summary_day' && p.counts) {
    const c = p.counts;
    return (
      `On **${p.date}**, attendance breakdown across **${p.total} employees**:\n\n` +
      `- **Present:** ${c.Present || 0}\n` +
      `- **Absent:** ${c.Absent || 0}\n` +
      `- **Leave:** ${c.Leave || 0}\n` +
      `- **Holiday:** ${c.Holiday || 0}\n` +
      `- **Week off:** ${c.WeekOff || 0}\n` +
      `- **Incomplete:** ${c.Incomplete || 0}`
    );
  }

  const label = pluralise(pickLabelForRender(p), p.total);
  const breakdown = p.breakdown
    ? `\n\nBreakdown — active: **${p.breakdown.active ?? '?'}**, resigned: **${p.breakdown.resigned ?? '?'}**.`
    : '';
  return `We have **${p.total} ${label}** in total.${breakdown}`;
}

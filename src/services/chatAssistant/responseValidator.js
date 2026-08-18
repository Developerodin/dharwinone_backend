// uat.dharwin.backend/src/services/chatAssistant/responseValidator.js
//
// Post-LLM count enforcement. Compares numeric phrases in the LLM reply
// against authoritative retrieval facts. When a mismatch is detected the
// validator either:
//   1) rewrites the offending number in-place ("We have 5 agents" → "We have 7 agents"), AND
//   2) appends a single CORRECTION line at the end of the reply naming the
//      authoritative count, so the user sees the source of truth even if
//      they pattern-matched on the wrong figure.
//
// Returns: { reply, patched, mismatches }

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build patterns for each fact: matches "(\d+) (label|labels|role|roles)"
// optionally wrapped in markdown bold (`**N**`).
function buildPattern(fact) {
  const variants = new Set();
  if (fact.role) {
    // Role-scoped fact — match ONLY the role label. Don't include the generic
    // "employees" variant or we will rewrite legitimate employee counts in a
    // sentence that mentions both ("we have 7 agents and 126 employees").
    variants.add(fact.role.toLowerCase());
    variants.add(`${fact.role.toLowerCase()}s`);
  } else if (fact.label) {
    // Generic fact (no role) — match the label and its singular/plural pair.
    variants.add(fact.label);
    if (!fact.label.endsWith('s')) variants.add(`${fact.label}s`);
    if (fact.label.endsWith('s')) variants.add(fact.label.slice(0, -1));
  }
  if (variants.size === 0) return null;
  const escaped = [...variants].map(escapeForRegex).join('|');
  return new RegExp(`(\\*\\*)?(\\d+)(\\*\\*)?(\\s+)(${escaped})\\b`, 'gi');
}

/**
 * Detect entity-type mismatch — retrieval said "agents", LLM rendered
 * "employees" or vice versa. Used for telemetry / hard-fail logging.
 *
 * @param {string} reply
 * @param {{ counts: object[], primary: object|null }} facts
 * @returns {{ mismatched: boolean, expected: string|null, found: string|null }}
 */
export function detectEntityTypeDrift(reply, facts) {
  const p = facts?.primary;
  if (!p?.role) return { mismatched: false, expected: null, found: null };
  const lc = String(reply || '').toLowerCase();
  const role = p.role.toLowerCase();
  const numericPhrase = new RegExp(`\\b\\d+\\s+(employees?|agents?|recruiters?|administrators?|admins?|candidates?|students?|sales\\s*agents?|${escapeForRegex(role)}s?)\\b`, 'gi');
  let m;
  let expectedHit = false;
  let driftedNoun = null;
  // eslint-disable-next-line no-cond-assign
  while ((m = numericPhrase.exec(lc)) !== null) {
    const noun = m[1].replace(/s$/, '');
    if (noun === role || noun + 's' === role) { expectedHit = true; continue; }
    if (!driftedNoun) driftedNoun = m[1];
  }
  if (driftedNoun && !expectedHit) {
    return { mismatched: true, expected: role, found: driftedNoun };
  }
  return { mismatched: false, expected: role, found: null };
}

/**
 * Detect entity-type drift AND apply the correction the detector was built
 * for. Streaming cannot recall tokens already sent and non-streaming should
 * not rewrite fluent prose wholesale, so the correction is an appended
 * sentence naming the authoritative entity type — the reply's number is
 * already right (enforceCounts runs first), only the noun drifted.
 *
 * @param {string} reply
 * @param {{ counts: object[], primary: object|null }} facts
 * @returns {{ reply: string, mismatched: boolean, expected: string|null, found: string|null }}
 */
export function applyEntityTypeDrift(reply, facts) {
  const drift = detectEntityTypeDrift(reply, facts);
  if (!drift.mismatched) return { reply: reply || '', ...drift };
  const plural = drift.expected.endsWith('s') ? drift.expected : `${drift.expected}s`;
  const correction =
    `\n\n*To be precise: these records are ${plural}, not ${drift.found} — the lookup was scoped to the ${drift.expected} role.*`;
  return { reply: `${reply || ''}${correction}`, ...drift };
}

/**
 * Walk every count fact and patch wrong numbers in the reply.
 *
 * @param {string} reply
 * @param {{ counts: object[] }} facts
 * @returns {{ reply: string, patched: boolean, mismatches: object[] }}
 */
export function enforceCounts(reply, facts) {
  const out = { reply: reply || '', patched: false, mismatches: [] };
  if (!facts || !Array.isArray(facts.counts) || !facts.counts.length) return out;

  for (const fact of facts.counts) {
    if (typeof fact.total !== 'number') continue;
    const pattern = buildPattern(fact);
    if (!pattern) continue;
    out.reply = out.reply.replace(pattern, (match, b1, num, b2, sep, noun) => {
      const found = Number(num);
      if (found === fact.total) return match;
      out.patched = true;
      out.mismatches.push({
        label: noun,
        expected: fact.total,
        found,
        source: fact.kind,
      });
      const bold1 = b1 || '';
      const bold2 = b2 || '';
      return `${bold1}${fact.total}${bold2}${sep}${noun}`;
    });
  }

  return out;
}


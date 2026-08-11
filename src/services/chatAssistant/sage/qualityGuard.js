// Lightweight post-generation guard — blocks obvious Sage violations only.
// Not a humanizer; does not rewrite factual content.

const DATABASE_PHRASE_RE =
  /\b(based on (the )?records|according to (the )?(database|system records)|the database shows|query returned|retrieval layer)\b/gi;

const FORCED_ENGAGEMENT_RE =
  /\s*(would you like me to[^.?!]*[.?!]|let me know if (you need|there'?s) anything[^.?!]*[.?!]|feel free to ask[^.?!]*[.?!]|is there anything else[^.?!]*[.?!])\s*$/i;

const EMPLOYEES_ONE_RE = /\bEmployees\s*\(\s*1\s*\)/i;

/**
 * @param {string} reply
 * @returns {{ reply: string, violations: string[] }}
 */
export function guardSageReply(reply) {
  const violations = [];
  let out = String(reply || '').trim();
  if (!out) return { reply: out, violations };

  if (DATABASE_PHRASE_RE.test(out)) {
    violations.push('database_phrasing');
    out = out
      .replace(DATABASE_PHRASE_RE, '')
      .replace(/^[,\s]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  if (FORCED_ENGAGEMENT_RE.test(out)) {
    violations.push('forced_engagement');
    out = out.replace(FORCED_ENGAGEMENT_RE, '').trim();
  }

  if (EMPLOYEES_ONE_RE.test(out)) {
    violations.push('employees_one_label');
    out = out.replace(EMPLOYEES_ONE_RE, 'that person').trim();
  }

  return { reply: out, violations };
}

/**
 * Defense-in-depth validator for legacy (LLM-generated) employee list replies.
 * Not used on entityQuery deterministic paths — those bypass the LLM entirely.
 */

/**
 * Placeholder rosters the LLM falls back to when it has a count but no rows —
 * "Employee A / Employee B / …" and "Employee One / Two / …". Case-sensitive on
 * purpose: prose like "give the employee a raise" must not trip it, and the
 * `(?![A-Za-z])` guard keeps "Employee ID" out of the single-letter arm.
 */
const PLACEHOLDER_NAME_RE =
  /\bEmployee\s+(?:[A-Z](?![A-Za-z])|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)\b/g;

const KNOWN_FABRICATED_IDS = Object.freeze(['dbs101', 'dbs102', 'dbs103']);

const KNOWN_FABRICATED_EMAILS = Object.freeze([
  'employeeone@example.com',
  'employeetwo@example.com',
  'employeethree@example.com',
]);

const EMPLOYEE_ID_RE = /\b(DBS\d+)\b/gi;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function buildAllowedSets(records) {
  const ids = new Set();
  const names = new Set();
  const emails = new Set();

  for (const record of records) {
    const employeeId = normalize(record.employeeId);
    if (employeeId) ids.add(employeeId);

    const name = normalize(record.fullName || record.name);
    if (name) names.add(name);

    const email = normalize(record.email);
    if (email) emails.add(email);
  }

  return { ids, names, emails };
}

function stripFabricatedTokens(reply, violations) {
  let next = reply;
  for (const v of violations) {
    if (v.kind === 'employeeId' || v.kind === 'email') {
      const re = new RegExp(`\\b${v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      next = next.replace(re, '—');
    } else if (v.kind === 'name') {
      const re = new RegExp(v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      next = next.replace(re, '—');
    }
  }
  return next.replace(/\|\s*—\s*\|/g, '| — |').trim();
}

/**
 * Validate an LLM reply against authoritative employee query records.
 *
 * @param {string} reply
 * @param {object} toolResult - executeEmployeeQuery ToolResultContract
 * @returns {{ valid: boolean, reply: string, violations: object[], sanitized: boolean }}
 */
export function validateReplyAgainstRecords(reply, toolResult) {
  const text = String(reply || '');
  if (!text) {
    return { valid: true, reply: text, violations: [], sanitized: false };
  }

  const records = Array.isArray(toolResult?.records) ? toolResult.records : [];
  const allowed = buildAllowedSets(records);
  const violations = [];
  const lc = text.toLowerCase();

  const namePattern = new RegExp(PLACEHOLDER_NAME_RE.source, PLACEHOLDER_NAME_RE.flags);
  let nameMatch;
  // eslint-disable-next-line no-cond-assign
  while ((nameMatch = namePattern.exec(text)) !== null) {
    violations.push({ kind: 'name', value: nameMatch[0], reason: 'known_fabrication' });
  }

  for (const email of KNOWN_FABRICATED_EMAILS) {
    if (lc.includes(email)) {
      violations.push({ kind: 'email', value: email, reason: 'known_fabrication' });
    }
  }

  let match;
  const idPattern = new RegExp(EMPLOYEE_ID_RE.source, EMPLOYEE_ID_RE.flags);
  // eslint-disable-next-line no-cond-assign
  while ((match = idPattern.exec(text)) !== null) {
    const raw = match[1];
    const id = normalize(raw);
    if (KNOWN_FABRICATED_IDS.includes(id)) {
      violations.push({ kind: 'employeeId', value: raw, reason: 'known_fabrication' });
      continue;
    }
    if (records.length === 0) {
      violations.push({ kind: 'employeeId', value: raw, reason: 'not_in_result_set' });
    } else if (!allowed.ids.has(id)) {
      violations.push({ kind: 'employeeId', value: raw, reason: 'not_in_result_set' });
    }
  }

  if (!violations.length) {
    return { valid: true, reply: text, violations: [], sanitized: false };
  }

  const sanitizedReply = stripFabricatedTokens(text, violations);
  return {
    valid: false,
    reply: sanitizedReply,
    violations,
    sanitized: sanitizedReply !== text,
  };
}

/**
 * Adapt a legacy `fetched` blob (chatAssistant.service#executeFetches) into the
 * ToolResultContract shape `validateReplyAgainstRecords` expects. Records from
 * every bucket are unioned — an employee ID the LLM legitimately picked up from
 * `fetch_people` or `fetch_placements` must not be scrubbed as fabricated.
 *
 * @param {object|null} fetched
 * @returns {{ success: true, total: number, records: object[] }}
 */
export function collectAuthoritativeRecords(fetched) {
  const records = [];
  for (const bucket of Object.values(fetched || {})) {
    if (!bucket || bucket.notFound) continue;
    if (Array.isArray(bucket.records)) records.push(...bucket.records);
  }
  return { success: true, total: records.length, records };
}

/**
 * One-call guard for the legacy LLM path: collect authoritative records from
 * `fetched`, validate the reply against them, and build the user-visible
 * retraction. Streaming callers emit `notice` as a trailing delta (tokens
 * already sent cannot be rewritten); non-streaming callers just take `reply`.
 *
 * @param {string} reply - LLM reply, post count-enforcement
 * @param {object|null} fetched - executeFetches blob for this turn
 * @returns {{ valid: boolean, reply: string, notice: string, violations: object[] }}
 */
export function guardLegacyReply(reply, fetched) {
  const result = validateReplyAgainstRecords(reply, collectAuthoritativeRecords(fetched));
  if (result.valid) {
    return { valid: true, reply: String(reply || ''), notice: '', violations: [] };
  }

  const notice =
    `\n\n> _Auto-correction: ${result.violations.length} employee identifier(s) in this answer ` +
    `are not present in the retrieved records and have been removed._`;

  return {
    valid: false,
    reply: result.reply,
    notice,
    violations: result.violations,
  };
}

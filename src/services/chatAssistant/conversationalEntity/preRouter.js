// Entity disambiguation selection — user vs role picks (numbers, ordinals, names, hints).

import { renderAmbiguousEntity } from '../conversationPolicy/renderFacts.js';

const INDEX_RE = /^\s*#?\s*(\d{1,2})\s*[.)]?\s*$/;
const ORDINAL_RE =
  /^\s*(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+(?:one|item|person|user|role|result|option))?\s*[.!]?\s*$/i;
const CANCEL_RE =
  /^\s*(neither|none(?:\s+of\s+(?:those|them))?|cancel|nevermind|never\s+mind|forget\s+it|stop)\s*[.!]?\s*$/i;
const ROLE_PICK_RE = /^\s*(?:the\s+)?role(?:\s+only)?\s*[.!]?\s*$/i;
const USER_PICK_RE =
  /^\s*(?:the\s+)?(?:user|person|employee|student|candidate|one)\s*[.!]?\s*$/i;
const JOB_PICK_RE =
  /^\s*(?:the\s+)?(?:job|opening|posting|vacancy|position opening)\s*[.!]?\s*$/i;
const EMPLOYEES_PICK_RE =
  /^\s*(?:the\s+)?(?:employees?|people|staff|team members?)\s*[.!]?\s*$/i;
const FIRST_EMPLOYEE_RE =
  /^\s*(?:the\s+)?first\s+employees?\s*[.!]?\s*$/i;
const FIRST_JOB_RE =
  /^\s*(?:the\s+)?first\s+(?:jobs?|openings?|postings?|vacanc(?:y|ies))\s*[.!]?\s*$/i;
const ORDINAL_EMPLOYEE_RE =
  /^\s*(?:the\s+)?(?:first|second|1st|2nd)(?:\s+(?:one|option|result))?\s+(?:employees?|people|staff)\s*[.!]?\s*$/i;
const ORDINAL_JOB_RE =
  /^\s*(?:the\s+)?(?:first|second|1st|2nd)(?:\s+(?:one|option|result))?\s+(?:jobs?|openings?|postings?|vacanc(?:y|ies))\s*[.!]?\s*$/i;
const FIRST_ONLY_RE =
  /^\s*(?:the\s+)?(?:first|1st)(?:\s+(?:one|option|result))?\s*[.!]?\s*$/i;
const SECOND_ONLY_RE =
  /^\s*(?:the\s+)?(?:second|2nd)(?:\s+(?:one|option|result))?\s*[.!]?\s*$/i;

const WORD_INDEX = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, '5th': 5,
};

function normalizeText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenizeName(s) {
  return normalizeText(s).split(' ').filter(Boolean);
}

function namesMatch(message, candidateName) {
  const msg = normalizeText(message);
  const name = normalizeText(candidateName);
  if (!msg || !name) return false;
  if (msg === name) return true;

  const msgTokens = tokenizeName(message);
  const nameTokens = tokenizeName(candidateName);
  if (msgTokens.length && msgTokens.length === nameTokens.length) {
    return msgTokens.every((t, i) => t === nameTokens[i]);
  }
  return false;
}

/**
 * @param {string} message
 * @param {{ kind:'user'|'role', userId?:any, roleId?:any, name:string, roles?:string[] }[]} matches
 */
export function matchEntitySelection(message, matches = []) {
  const text = String(message || '').trim();
  if (!text) return { kind: 'unrelated' };
  if (CANCEL_RE.test(text)) return { kind: 'cancel' };

  const pick = (n) => {
    if (n < 1 || n > matches.length) return { kind: 'reask' };
    const m = matches[n - 1];
    if (m.kind === 'role') return { kind: 'select', entityType: 'role', roleId: m.roleId };
    return { kind: 'select', entityType: 'user', userId: m.userId };
  };

  const idx = text.match(INDEX_RE);
  if (idx) return pick(Number(idx[1]));

  const ord = text.match(ORDINAL_RE);
  if (ord) return pick(WORD_INDEX[ord[1].toLowerCase()]);

  if (ROLE_PICK_RE.test(text)) {
    const roles = matches.filter((m) => m.kind === 'role');
    if (roles.length === 1) {
      return { kind: 'select', entityType: 'role', roleId: roles[0].roleId };
    }
  }
  if (USER_PICK_RE.test(text)) {
    const users = matches.filter((m) => m.kind === 'user');
    if (users.length === 1) {
      return { kind: 'select', entityType: 'user', userId: users[0].userId };
    }
  }

  const lower = normalizeText(text);
  const named = matches.filter((m) => namesMatch(text, m.name));
  if (named.length === 1) {
    const m = named[0];
    if (m.kind === 'role') return { kind: 'select', entityType: 'role', roleId: m.roleId };
    return { kind: 'select', entityType: 'user', userId: m.userId };
  }

  const partial = matches.filter((m) => {
    const n = normalizeText(m.name);
    return n && (lower.includes(n) || n.includes(lower));
  });
  if (partial.length === 1) {
    const m = partial[0];
    if (m.kind === 'role') return { kind: 'select', entityType: 'role', roleId: m.roleId };
    return { kind: 'select', entityType: 'user', userId: m.userId };
  }

  return { kind: 'unrelated' };
}

export function renderEntityDisambiguationPrompt(pending) {
  return renderAmbiguousEntity({ query: pending.query, matches: pending.matches });
}

/**
 * @param {string} message
 * @param {{ jobMatches?: object[], employeeMatches?: object[] }} pending
 */
export function matchTitleSelection(message, pending = {}) {
  const text = String(message || '').trim();
  if (!text) return { kind: 'unrelated' };
  if (CANCEL_RE.test(text)) return { kind: 'cancel' };

  const hasJobs = pending.jobMatches?.length > 0;
  const hasEmployees = pending.employeeMatches?.length > 0;

  const selectJob = () =>
    hasJobs
      ? { kind: 'select', target: 'job', jobId: pending.jobMatches[0].jobId }
      : { kind: 'unrelated' };
  const selectEmployee = () =>
    hasEmployees ? { kind: 'select', target: 'employee' } : { kind: 'unrelated' };

  if (JOB_PICK_RE.test(text) || FIRST_JOB_RE.test(text) || ORDINAL_JOB_RE.test(text)) {
    const pick = selectJob();
    if (pick.kind === 'select') return pick;
  }
  if (
    EMPLOYEES_PICK_RE.test(text) ||
    FIRST_EMPLOYEE_RE.test(text) ||
    ORDINAL_EMPLOYEE_RE.test(text)
  ) {
    const pick = selectEmployee();
    if (pick.kind === 'select') return pick;
  }

  if (FIRST_ONLY_RE.test(text)) {
    // Prompt order: job posting first, employees second.
    if (hasJobs) return selectJob();
    if (hasEmployees) return selectEmployee();
  }
  if (SECOND_ONLY_RE.test(text)) {
    if (hasJobs && hasEmployees) return selectEmployee();
    if (hasEmployees && !hasJobs) return selectEmployee();
    if (hasJobs && !hasEmployees) return selectJob();
  }

  const idx = text.match(INDEX_RE);
  if (idx) {
    const n = Number(idx[1]);
    if (n === 1 && hasJobs) return selectJob();
    if (n === 2 && hasEmployees) return selectEmployee();
    if (n === 1 && hasEmployees && !hasJobs) return selectEmployee();
  }

  const ord = text.match(ORDINAL_RE);
  if (ord) {
    const n = WORD_INDEX[ord[1].toLowerCase()];
    if (n === 1 && hasJobs) return selectJob();
    if (n === 2 && hasEmployees) return selectEmployee();
    if (n === 1 && hasEmployees && !hasJobs) return selectEmployee();
  }

  const lower = normalizeText(text);
  if (/\b(job|opening|posting|vacancy)\b/.test(lower) && hasJobs) {
    return selectJob();
  }
  if (/\b(employee|people|staff)\b/.test(lower) && hasEmployees) {
    return selectEmployee();
  }

  return { kind: 'unrelated' };
}

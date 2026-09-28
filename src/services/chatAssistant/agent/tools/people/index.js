import countUsers from './countUsers.tool.js';
import listUsers from './listUsers.tool.js';
import getUser from './getUser.tool.js';
import listRoles from './listRoles.tool.js';
import getRole from './getRole.tool.js';

const instructions = [
  'People: user accounts (logins) in the Users directory, and the roles those accounts hold.',
  '- Users: user accounts, logins, "who has role X", "how many admins" → count_users/list_users with a ' +
    'role filter — not list_roles.',
  '- "What can a Sales Agent do" / "what permissions does X role have" → get_role.',
  '- "How many sales agents" → count_users with a role filter (users, not roles).',
  '- "List all recruiters" / "show me agents" / "how many students" → list_users/count_users with that ' +
    'role (Student, Agent, Recruiter, Administrator and Sales Agent are all user roles).',
  '- Status defaults to active for user counts/lists. When you did not pass a status, say the numbers are ' +
    'for active accounts.',
  "- groupBy:'role' on count_users counts a user once per role they hold — a user with 2 roles counts in " +
    'both groups; a user with no role is excluded from every group.',
  '- A short follow-up that\'s just a person\'s name ("what about Priya") is a get_user call, not a ' +
    'count_users/list_users filter, even right after a users answer — the name would land in search by ' +
    'mistake.',
  '- "Tell me about <person>" → get_user.',
].join('\n');

// Noun test for this domain's turns — mirrors gate.js's job-noun test (README
// §"Widen the gate for a new domain"). A false positive costs one wasted agent
// attempt; a false negative leaves the turn on the legacy pipeline, so this
// errs broad by default — but a few specific phrasings belong clearly enough
// to OTHER, not-yet-migrated flows (login-activity reports, the
// Employees/Candidates agent-assignment flow, everyday "permission to <do
// something>") that matching them would likely produce a wrong answer rather
// than a safe handoff, so those are excluded explicitly (review fix round 1, I-4).
const USER_ACCOUNT_RE = /\b(users?|portal\s*access)\b/i;
// "logged in"/"login history"/"login activity" are activity reports —
// count_users/list_users have no login-date filter and would answer with the
// wrong number (an active-user count) instead of handing off.
const LOGIN_ACTIVITY_RE = /\blogged\s+in\b|\blogin\s+(?:history|activity)\b/i;
// Bare "role"/"roles" is specific enough to keep matching on its own ("what
// roles exist", "who has the recruiter role"). Bare "permission(s)" is not —
// it collides with everyday phrases ("permission to take leave") — so it only
// counts in role/RBAC context.
const ROLE_NOUN_RE = /\broles?\b/i;
const ROLE_PERMISSIONS_RE = /\b(?:role\s+permissions?|access\s+permissions?|permissions?\s+(?:of|for|does)\b)/i;
// "what can a/an/the <role> do" — the brief's own get_role routing example.
const ROLE_CAPABILITY_RE = /\bwhat can (?:a|an|the)\s+[\w\s]+?\s+do\b/i;
// "who is <Name>" / "who's <Name>" — "who" is case-insensitive (a sentence-start
// "Who" must still match), but the following word must look like a proper name
// (capitalized in the ORIGINAL text — case-sensitive on purpose), so this
// doesn't open "who is on leave today" or similar non-people turns.
const WHO_IS_NAME_RE = /\b[Ww]ho(?:'s|\s+(?:is|are|has|holds))\s+[A-Z]/;
// "tell me about <Name>" — same capitalised-name rule as WHO_IS_NAME_RE, so "tell me about leave
// policy" does not open the people domain.
const TELL_ME_ABOUT_NAME_RE = /\b(?:tell me about|details (?:of|for)|profile of)\s+[A-Z][a-z]+/;
// Bare "agent" collides with the Employees/Candidates agent-assignment flow
// ("how many candidates are assigned to agent Rahul") — only "sales agent"
// and the actual admin/recruiter role words count as a headcount noun here.
const ROLE_HEADCOUNT_RE = /\bhow many\b.{0,40}\b(admins?|administrators?|recruiters?|sales\s*agents?)\b/i;
// "list all recruiters" / "show me agents" / "how many students": a role noun as the direct object
// of a list/count verb (only an article/"our"/"active" between them). Bare "agent" is safe here
// because it must follow the verb — "candidates assigned to agent Rahul" does not match. These used
// to reach the legacy fetch_employees role fast path, which is gone since round 2.
const ROLE_LIST_COUNT_RE = /\b(?:how many|count|list|show(?:\s+me)?|who are|all)(?:\s+(?:all|the|of|our|active))*\s+(?:admins?|administrators?|recruiters?|sales\s*agents?|agents?|students?)\b/i;
// Course/training asks about students stay with training analytics, not a user headcount.
const TRAINING_RE = /\b(courses?|training|modules?|enrolled|progress)\b/i;

/**
 * True for turns the people domain's tools can plausibly answer. Used by the
 * agent gate's domain-generic turn test (see gate.js / README "Widen the gate
 * for a new domain").
 * @param {string} text
 * @returns {boolean}
 */
export function matchesTurn(text) {
  const t = String(text || '');
  return (USER_ACCOUNT_RE.test(t) && !LOGIN_ACTIVITY_RE.test(t))
    || ROLE_NOUN_RE.test(t)
    || ROLE_PERMISSIONS_RE.test(t)
    || ROLE_CAPABILITY_RE.test(t)
    || WHO_IS_NAME_RE.test(t)
    || TELL_ME_ABOUT_NAME_RE.test(t)
    || ROLE_HEADCOUNT_RE.test(t)
    || (ROLE_LIST_COUNT_RE.test(t) && !TRAINING_RE.test(t));
}

export default {
  domain: 'people',
  instructions,
  tools: [countUsers, listUsers, getUser, listRoles, getRole],
  matchesTurn,
};

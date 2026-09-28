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
  '- Status defaults to active for user counts/lists. When you did not pass a status, say the numbers are ' +
    'for active accounts.',
  "- groupBy:'role' on count_users counts a user once per role they hold — a user with 2 roles counts in " +
    'both groups; a user with no role is excluded from every group.',
  '- A short follow-up that\'s just a person\'s name ("what about Priya") is a get_user call, not a ' +
    'count_users/list_users filter, even right after a users answer — the name would land in search by ' +
    'mistake.',
].join('\n');

// Noun test for this domain's turns — mirrors gate.js's job-noun test (README
// §"Widen the gate for a new domain"). A false positive costs one wasted agent
// attempt; a false negative leaves the turn on the legacy pipeline, so this
// errs broad rather than narrow.
const USER_ACCOUNT_RE =
  /\b(users?|user\s*accounts?|accounts?|logins?|log[\s-]?ins?|sign[\s-]?ins?|portal\s*access)\b/i;
const ROLE_NOUN_RE = /\b(roles?|permissions?)\b/i;
// "who is <Name>" / "who's <Name>" — a bare "who is" is too generic on its own
// (it also opens "who is on leave today", an attendance question, and plenty
// of other non-people turns), so this only fires when the next word looks like
// a proper name (capitalized in the ORIGINAL text — case-sensitive on purpose).
const WHO_IS_NAME_RE = /\bwho(?:'s|\s+(?:is|are|has|holds))\s+[A-Z]/;
const ROLE_HEADCOUNT_RE =
  /\bhow many\b.{0,40}\b(admins?|administrators?|recruiters?|sales\s*agents?|agents?)\b/i;

/**
 * True for turns the people domain's tools can plausibly answer. Used by the
 * agent gate's domain-generic turn test (see gate.js / README "Widen the gate
 * for a new domain").
 * @param {string} text
 * @returns {boolean}
 */
export function matchesTurn(text) {
  const t = String(text || '');
  return USER_ACCOUNT_RE.test(t) || ROLE_NOUN_RE.test(t) || WHO_IS_NAME_RE.test(t) || ROLE_HEADCOUNT_RE.test(t);
}

export default {
  domain: 'people',
  instructions,
  tools: [countUsers, listUsers, getUser, listRoles, getRole],
  matchesTurn,
};

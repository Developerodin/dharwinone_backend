import countUsers from './countUsers.tool.js';
import listUsers from './listUsers.tool.js';
import getUser from './getUser.tool.js';
import listRoles from './listRoles.tool.js';
import getRole from './getRole.tool.js';
import getMyProfile from './getMyProfile.tool.js';
import whatCanIDo from './whatCanIDo.tool.js';

const instructions = [
  'People: user accounts (logins) in the Users directory, and the roles those accounts hold.',
  '- Users: user accounts, logins, "who has role X", "how many admins" → count_users/list_users with a ' +
    'role filter — not list_roles.',
  '- "What can a Sales Agent do" / "what permissions does X role have" → get_role.',
  '- "How many sales agents" / "how many students" → ONE count_users call with filters.role — not groupBy, and not a second plain count (users, not roles).',
  '- "List all recruiters" / "show me agents" / "how many students" → list_users/count_users with that ' +
    'role (Student, Agent, Recruiter, Administrator and Sales Agent are all user roles).',
  '- Users vs profiles: a headcount framed as users or accounts — "how many users", "users by role", "total ' +
    'users and how many of them are employees/candidates", "among the users how many are X" — is count_users ' +
    'with groupBy "role" (ONE call — its groups already hold each role\'s count and its total is the user ' +
    'total, so do not also count or list each role) or filters.role. That matches the Users page. count_employees/' +
    'count_candidates count PROFILES instead: use them only when the question filters on a profile field ' +
    '(skills, location, designation, department, employment type/status, joining/resign dates, agent, ' +
    'paid/unpaid) or asks for current/resigned employees.',
  '- Status defaults to active for user counts/lists. A headcount asked "in total", "across all statuses", ' +
    '"including inactive/disabled", or a push-back that the user means every account → filters.status "all". ' +
    '"list all recruiters" / "show all users" alone means every matching person, not every status. When you ' +
    'did not pass a status, say the numbers are for active accounts.',
  '- Phrase account counts as "N accounts with the <Role> role" and profile counts as "N candidate profiles" / ' +
    '"N employee profiles".',
  "- groupBy:'role' on count_users counts a user once per role they hold — a user with 2 roles counts in " +
    'both groups; a user with no role is excluded from every group.',
  '- A short follow-up that\'s just a person\'s name ("what about Priya") is a get_user call, not a ' +
    'count_users/list_users filter, even right after a users answer — the name would land in search by ' +
    'mistake.',
  '- "Tell me about <person>" → get_user.',
  '- The user\'s OWN details ("my profile", "who am I", "my employee id") → get_my_profile, never get_user.',
  '- Inactive accounts: "not logged in for N days / a month", "inactive users" → count_users/list_users with ' +
    'filters.inactiveDays (a month = 30). "Never logged in" → filters.neverLoggedIn true. "When did X last log ' +
    'in" → list_users with filters.search (get_user has no last login). lastLoginAt is the last password ' +
    'sign-in, not last activity — say so when it matters.',
  '- The user\'s OWN access ("what can I do", "what access do I have", "what can\'t I see") → what_can_i_do. ' +
    'For modules without access, name the modules only — never guess what data is in them. Another role\'s ' +
    'permissions stay on get_role.',
].join('\n');

export default {
  domain: 'people',
  summary: "One person's full profile (role, designation, position), user accounts and logins, roles, and what I can do.",
  instructions,
  tools: [countUsers, listUsers, getUser, getMyProfile, whatCanIDo, listRoles, getRole],
};

import listActivity from './listActivity.tool.js';
import listImpersonations from './listImpersonations.tool.js';

const instructions = [
  'Audit: the Activity Logs trail and impersonation ("Login as") history.',
  '- "Who changed / deleted / created X", "what did <person> do", "who logged in today", "recent role changes" → ' +
    'list_activity. Put the doer in filters.actor, the record acted on in filters.targetType + filters.target, ' +
    'and a day or range in filters.between.',
  '- Logins are action "user.login", sign-outs "user.logout", account disables "user.disable". For a broad area ' +
    'use filters.actionGroup (e.g. "Users & roles", "Jobs & hiring", "Employee", "Attendance") instead of action.',
  '- A row\'s changes list holds old → new values only when the log stored them. changes null means the change ' +
    'detail is not captured in DharwinOne; valueHidden means the value exists but is not shown (pay/compensation) — ' +
    'say so, never guess a value.',
  '- scope "your own activity only" means the viewer can only see their own log rows; ignoredFilters lists filters ' +
    'their access dropped — tell the user instead of presenting the rows as everyone\'s.',
  '- "Who impersonated X", "has anyone logged in as me", "who is impersonating right now" → list_impersonations ' +
    '(noEndRecorded true for "right now"). The reason for an impersonation and the pages viewed during it are ' +
    'not captured in DharwinOne. scope "only sessions you started" means the viewer sees only their own ' +
    'sessions — say so.',
  '- "When did X last log in" is list_users with filters.search (its rows carry lastLoginAt); "who has not ' +
    'logged in for N days" is count_users / list_users with filters.inactiveDays — not list_activity.',
  '- Department / designation moves ("who moved teams", "which groups has X moved between") are org ' +
    'get_reporting_chain mode "group_moves" (load org with find_tools) — not list_activity.',
].join('\n');

export default {
  domain: 'audit',
  summary: 'Activity Logs (who did what, when, old → new values), "Login as" history. Department moves are org.',
  instructions,
  tools: [listActivity, listImpersonations],
};

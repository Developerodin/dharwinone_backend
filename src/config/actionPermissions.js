/**
 * Single source of truth for semantic action → API permission key mapping.
 * Use action names (e.g. 'assign_task', 'view_internal_jobs') in business logic
 * instead of raw permission strings, so the mapping rule lives in one place.
 *
 * Each action resolves to ONE API permission key (e.g. 'tasks.manage'), which is
 * then expanded by config/permissions.js → getGrantingPermissions(...) into the
 * full alias set the user is checked against.
 */
export const ACTION_PERMISSIONS = Object.freeze({
  // Projects
  view_projects: 'projects.read',
  create_project: 'projects.manage',
  update_project: 'projects.manage',
  delete_project: 'projects.manage',
  assign_project: 'projects.manage',

  // Tasks
  view_tasks: 'tasks.read',
  create_task: 'tasks.manage',
  update_task: 'tasks.manage',
  delete_task: 'tasks.manage',
  assign_task: 'tasks.manage',
  comment_on_task: 'tasks.read',

  // Teams
  view_teams: 'teams.read',
  create_team: 'teams.manage',
  update_team: 'teams.manage',
  delete_team: 'teams.manage',
  assign_team_member: 'teams.manage',

  // ATS Jobs
  view_jobs: 'jobs.read',
  view_internal_jobs: 'jobs.read',
  create_job: 'jobs.manage',
  update_job: 'jobs.manage',
  delete_job: 'jobs.manage',
  share_job: 'jobs.read',
  apply_to_job: 'jobs.read',

  // ATS Candidates (legacy pipeline / referral)
  view_candidates: 'candidates.read',
  manage_candidates: 'candidates.manage',

  // ATS Employees (PR2)
  view_employees: 'employees.read',
  manage_employees: 'employees.manage',

  // Activity Logs
  view_activity_logs: 'activityLogs.read',
});

/**
 * Resolve a semantic action key to its API permission key, throwing if unknown
 * so missing entries fail loudly during development.
 *
 * @param {string} action
 * @returns {string}
 */
export const resolveActionPermission = (action) => {
  const key = ACTION_PERMISSIONS[action];
  if (!key) {
    throw new Error(`Unknown action permission: "${action}". Add it to config/actionPermissions.js`);
  }
  return key;
};

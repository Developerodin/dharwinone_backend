/**
 * Sage tool gate. Mirrors the route permission of the portal page each tool
 * reads from, so a chat answer can never exceed what the user could open in the UI.
 * Every ROUTING_TOOLS name must appear here; unknown names are denied.
 *
 * `anyOf` — user needs at least one (aliases resolved like requireAnyOfPermissions).
 * No `anyOf` — the handler already enforces its own check (see `note`) or the
 * tool is self-scoped.
 * `rowScope: 'person'` — rows are post-filtered to the Employees-page scope.
 */
import { getGrantingPermissions } from '../../config/permissions.js';

const PEOPLE_READ = ['candidates.read', 'employees.read']; // employee.route.js canReadEmployees
const OFFERS_READ = [ // offer.route.js canReadOffers
  'candidates.read', 'employees.read',
  'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
  'pre-boarding.read', 'pre-boarding.edit', 'pre-boarding.manage',
];
const PLACEMENTS_READ = [ // placement.route.js canReadPlacements
  'candidates.read',
  'pre-boarding.read', 'pre-boarding.create', 'pre-boarding.edit', 'pre-boarding.delete', 'pre-boarding.manage',
  'onboarding.read', 'onboarding.create', 'onboarding.edit', 'onboarding.delete', 'onboarding.manage',
  'offers.read', 'offers.create', 'offers.edit', 'offers.delete', 'offers.manage',
];

export const TOOL_ACCESS = {
  // People — employee.route.js
  fetch_employees: { anyOf: PEOPLE_READ, rowScope: 'person' },
  employee_analytics: { anyOf: PEOPLE_READ },
  fetch_candidates: { anyOf: PEOPLE_READ, rowScope: 'person' },
  fetch_people: { anyOf: PEOPLE_READ, rowScope: 'person' },
  semantic_employee_search: { anyOf: PEOPLE_READ, rowScope: 'person' },
  match_candidates_to_job: { anyOf: PEOPLE_READ, rowScope: 'person' },
  resolve_person_profile: { note: 'per-field requires in personProfile/index.js' },

  // ATS pipeline
  fetch_interviews: { anyOf: ['interviews.read'], note: 'rows scoped by meetingScope in handler' },
  fetch_offers: { anyOf: OFFERS_READ },
  fetch_placements: { anyOf: PLACEMENTS_READ },
  fetch_jobs: { anyOf: ['jobs.read'] },
  fetch_external_jobs: { anyOf: ['external-jobs.read', 'external-jobs.manage'] },
  fetch_job_applications: { note: 'applicantQuery.service applicationScope' },
  referral_leads_analytics: { note: 'referralLeadsAnalytics.js candidates.read' },

  // Org / PM
  org_structure_analytics: { note: 'hasOrgReadAccess in handler' },
  org_manager_analytics: { anyOf: ['chart.read', 'structure.read', 'structure.manage'] },
  project_analytics: { note: 'projects.read/manage in handler' },
  team_analytics: { note: 'teams.read/manage in handler' },
  task_board_analytics: { note: 'tasks.read/manage in handler' },
  workload_analytics: { note: 'projects/teams read in handler' },
  fetch_tasks: { note: 'task.service.queryTasks visibility' },
  fetch_projects: { note: 'project.service visibility' },

  // HR — handlers check userIsAdmin or self
  fetch_attendance: { note: 'admin check in handler' },
  fetch_attendance_summary: { note: 'admin check in handler' },
  fetch_employee_attendance_calendar: { note: 'admin-or-self in handler' },
  fetch_employee_attendance: { note: 'admin-or-self in handler' },
  fetch_employee_overview: { note: 'admin-or-self in handler' },
  fetch_leave_requests: { note: 'buildLeaveRequestScopeFilter' },
  on_leave_today: { note: 'dashboard permission grading in handler' },
  rank_leaves_by_employee: { note: 'admin check in handler' },
  fetch_backdated_attendance_requests: { note: 'admin-or-self in handler' },
  fetch_shifts: { anyOf: ['students.read'] }, // shift.route.js GET
  training_analytics: { note: 'person arg gated in handler (Task 3)' },

  // Admin config
  fetch_roles: { anyOf: ['roles.read'] }, // role.route.js GET — roles.read only, no .manage alias

  // Self-scoped / public
  fetch_current_user: {},
  fetch_my_shift: {},
  fetch_meetings: { note: 'caller-invited meetings only' },
  fetch_holidays: {},
  search_knowledge_base: {},
};

const hasAny = (permissions, required) =>
  !!permissions &&
  required.some((r) => getGrantingPermissions(r).some((p) => permissions.has(p)));

export async function checkToolAccess(name, user) {
  const rule = TOOL_ACCESS[name];
  if (!rule) return { ok: false, reason: `Unknown tool ${name}.` };
  if (!rule.anyOf) return { ok: true };
  if (user?.platformSuperUser) return { ok: true };
  if (hasAny(user?.authContext?.permissions, rule.anyOf)) return { ok: true };
  return { ok: false, reason: `Requires one of: ${rule.anyOf.join(', ')}.` };
}

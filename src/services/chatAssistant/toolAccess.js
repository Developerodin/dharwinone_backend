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
import { applyEmployeeListScope } from '../../schemas/employees/employeeQuery.scope.js';
import Employee from '../../models/employee.model.js';

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

const idOf = (v) => (v == null ? null : String(v?._id ?? v));

/**
 * Same scope the Employees page applies (employee.controller.js list):
 * Agent → assignedAgent, Sales Agent → referredByUserId | currentSalesAgentUserId,
 * no org-wide read → self. Returns allowed owner User ids, or null = unrestricted.
 */
export async function resolveRowScope(user, deps = {}) {
  const applyScope = deps.applyScope ?? ((u) => applyEmployeeListScope({}, u, u?.authContext));
  const distinctOwners = deps.distinctOwners ?? ((q) => Employee.find(q).distinct('owner'));
  const s = await applyScope(user);
  if (s.agentIds) return new Set((await distinctOwners({ assignedAgent: s.agentIds })).map(String));
  if (s.salesAgentScopeUserId) {
    const uid = s.salesAgentScopeUserId;
    return new Set(
      (await distinctOwners({ $or: [{ referredByUserId: uid }, { currentSalesAgentUserId: uid }] })).map(String)
    );
  }
  if (s.owner) return new Set([String(s.owner)]);
  return null;
}

// Exported so callers outside the guardToolResult pipeline (e.g. buildSystemContext's
// general-query fallback, which queries User directly) can apply the identical
// owner-id predicate instead of re-implementing it.
export const rowMatchesAllowed = (r, allowed) =>
  [r._id, r.id, r.userId, r.owner].map(idOf).some((id) => id && allowed.has(id));

// Precomputed on the whole (unscoped) population before the row filter runs —
// fetch_employees/fetch_people compute these from a company-wide Mongo count,
// and fetch_people pre-renders a full markdown roster before guardToolResult
// ever sees the result. Once rows are cut down, these siblings talk about a
// population the caller can no longer see and must not survive the filter.
const AGGREGATE_SIBLING_KEYS = ['breakdown', 'employmentBreakdown', 'rendered'];

/** Drop stale company-wide aggregates/pre-rendered text and, if present, cut `page` down to the filtered count. */
function stripAggregateSiblings(obj, filteredLength) {
  const out = { ...obj };
  for (const k of AGGREGATE_SIBLING_KEYS) delete out[k];
  if (out.page) out.page = { ...out.page, total: filteredLength, hasMore: false };
  return out;
}

// ponytail: post-filter, not query rewrite — fetch_employees has 5 query paths.
// Ceiling: a scoped user only sees rows inside the handler's limit (max 1000);
// move the owner filter into each query path if a scoped population ever exceeds that.
//
// Three result shapes reach this function: a bare array (semantic_employee_search),
// { records: [...] } (fetch_employees/fetch_candidates/fetch_people), and
// { job, candidates: [...] } (match_candidates_to_job). Each is filtered by the
// same owner-id keys; only the object shapes carry aggregate/pre-rendered
// siblings (employmentBreakdown, rendered, page.total, ...) that must be
// stripped/rewritten so they never describe the pre-scope population.
export function applyRowScope(result, allowed) {
  if (!allowed || !result) return result;
  if (Array.isArray(result)) {
    return result.filter((r) => rowMatchesAllowed(r, allowed));
  }
  if (Array.isArray(result.records)) {
    const records = result.records.filter((r) => rowMatchesAllowed(r, allowed));
    const rest = stripAggregateSiblings(result, records.length);
    return { ...rest, records, total: records.length, baseTotal: records.length, scopedToYou: true };
  }
  if (Array.isArray(result.candidates)) {
    const candidates = result.candidates.filter((r) => rowMatchesAllowed(r, allowed));
    const rest = stripAggregateSiblings(result, candidates.length);
    return { ...rest, candidates, scopedToYou: true };
  }
  return result;
}

const stripKey = (v, key) => {
  if (Array.isArray(v)) return v.map((x) => stripKey(x, key));
  if (v && typeof v === 'object' && !(v instanceof Date) && v.constructor === Object) {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (k !== key) out[k] = stripKey(val, key);
    return out;
  }
  return v;
};

/**
 * personProfile gates compensation on employees.manage; apply the same to every
 * person tool. Same rule as checkToolAccess — platformSuperUser or a permission
 * grant, no userIsAdmin shortcut.
 */
export async function redactSalary(result, user) {
  if (!result || user?.platformSuperUser) return result;
  if (hasAny(user?.authContext?.permissions, ['employees.manage'])) return result;
  return stripKey(result, 'salaryRange');
}

export async function guardToolResult(name, result, user, deps = {}) {
  if (!result || result.forbidden) return result;
  if (TOOL_ACCESS[name]?.rowScope !== 'person') return result;
  const scoped = applyRowScope(result, await resolveRowScope(user, deps));
  return redactSalary(scoped, user);
}

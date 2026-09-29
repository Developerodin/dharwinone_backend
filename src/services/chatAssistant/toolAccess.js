/**
 * Sage tool gate. Mirrors the route permission of the portal page each tool
 * reads from, so a chat answer can never exceed what the user could open in the UI.
 * Every ROUTING_TOOLS name must appear here; unknown names are denied.
 *
 * `anyOf` — user needs at least one (aliases resolved like requireAnyOfPermissions).
 * No `anyOf` — the handler already enforces its own check (see `note`) or the
 * tool is self-scoped.
 * `rowScope: 'person'` — rows are post-filtered to the Employees-page scope.
 * `adminByName` — mirrors a route that also lets an Administrator-by-name user
 * through with no permission grant. No tool currently needs this; kept as a documented
 * escape hatch should a route legitimately
 * need it. Every tool must otherwise pass via `anyOf` or platformSuperUser.
 */
import { getGrantingPermissions } from '../../config/permissions.js';
import { applyEmployeeListScope } from '../../schemas/employees/employeeQuery.scope.js';
import Employee from '../../models/employee.model.js';
import { userIsAdmin } from '../../utils/roleHelpers.js';

const PEOPLE_READ = ['candidates.read', 'employees.read']; // employee.route.js canReadEmployees

export const TOOL_ACCESS = {
  // People — employee.route.js
  designation_manager_analytics: { anyOf: PEOPLE_READ, rowScope: 'person' },
  // Permission keys only — no router tool by these names since round 2; kept for
  // resolveTitleAmbiguity, buildSystemContext and the two-stage people path.
  fetch_employees: { anyOf: PEOPLE_READ, rowScope: 'person' },
  fetch_people: { anyOf: PEOPLE_READ, rowScope: 'person' },

  // ATS pipeline (interviews, offers, placements, referral leads: agent/tools/hiring)
  fetch_jobs: { anyOf: ['jobs.read'] },
  // Reads Job mirrors (jobOrigin='external' / externalRef), the same collection and
  // origin fetch_jobs already exposes — not the raw ExternalJob collection that
  // requireExternalJobsAccess.js's external-jobs.* gate protects. Mirror fetch_jobs'
  // rule exactly rather than a permission this tool doesn't actually read behind.

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

  // Self-scoped / public
  fetch_my_shift: {},
  fetch_holidays: {},
};

const hasAny = (permissions, required) =>
  !!permissions &&
  required.some((r) => getGrantingPermissions(r).some((p) => permissions.has(p)));

/**
 * Evaluate a single TOOL_ACCESS-shaped rule (`{ anyOf, adminByName }` or
 * `{ note }`) against a user. Extracted from `checkToolAccess` so
 * `agent/toolRegistry.js` can run the identical check against a tool's
 * co-located `access` object without a name/TOOL_ACCESS lookup.
 */
export async function checkAccessRule(rule, user, deps = {}) {
  if (!rule.anyOf) return { ok: true };
  if (user?.platformSuperUser) return { ok: true };
  if (hasAny(user?.authContext?.permissions, rule.anyOf)) return { ok: true };
  if (rule.adminByName) {
    const isAdmin = deps.isAdmin ?? userIsAdmin;
    if (await isAdmin(user)) return { ok: true };
  }
  return { ok: false, reason: `Requires one of: ${rule.anyOf.join(', ')}.` };
}

export async function checkToolAccess(name, user, deps = {}) {
  const rule = TOOL_ACCESS[name];
  if (!rule) return { ok: false, reason: `Unknown tool ${name}.` };
  return checkAccessRule(rule, user, deps);
}

/**
 * student.route.js reads other students' progress behind students.read.
 * Same rule as checkToolAccess — platformSuperUser or a permission grant, no
 * Administrator-by-name shortcut.
 */
export async function canReadOtherTraining(user) {
  if (user?.platformSuperUser) return true;
  return hasAny(user?.authContext?.permissions, ['students.read', 'students.manage']);
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

/**
 * Same as `guardToolResult` but takes the rule object directly instead of a
 * TOOL_ACCESS name lookup, so `agent/toolRegistry.js` can guard a tool's
 * result using its co-located `access` object.
 */
export async function guardResultForRule(rule, result, user, deps = {}) {
  if (!result || result.forbidden) return result;
  if (rule?.rowScope !== 'person') return result;
  const scoped = applyRowScope(result, await resolveRowScope(user, deps));
  return redactSalary(scoped, user);
}

export async function guardToolResult(name, result, user, deps = {}) {
  return guardResultForRule(TOOL_ACCESS[name], result, user, deps);
}

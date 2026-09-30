/**
 * Sage tool gate. Each agent tool's co-located `access` rule (agent/defineTool.js)
 * mirrors the route permission of the portal page it reads from, so a chat answer
 * can never exceed what the user could open in the UI. agent/toolRegistry.js runs
 * these checks.
 *
 * `anyOf` — user needs at least one (aliases resolved like requireAnyOfPermissions).
 * `allOf` — user needs every one, each alias-resolved (mirrors requirePermissions(a, b),
 * which is AND; mapping such a route onto `anyOf` would widen access). With both,
 * both must hold.
 * Neither — the handler already enforces its own check (see `note`) or the
 * tool is self-scoped.
 * `rowScope: 'person'` — rows are post-filtered to the Employees-page scope.
 * `adminByName` — mirrors a route that also lets an Administrator-by-name user
 * through with no permission grant. Used only where the mirrored route really does that
 * (list_impersonations ↔ POST /auth/impersonate's requireAdministratorOrPermission);
 * every other tool must pass via `anyOf` or platformSuperUser.
 */
import { getGrantingPermissions } from '../../config/permissions.js';
import { applyEmployeeListScope } from '../../schemas/employees/employeeQuery.scope.js';
import Employee from '../../models/employee.model.js';
import { userIsAdmin } from '../../utils/roleHelpers.js';

const grants = (permissions, required) => getGrantingPermissions(required).some((p) => permissions.has(p));

const hasAny = (permissions, required) => !!permissions && required.some((r) => grants(permissions, r));

const hasAll = (permissions, required) => !!permissions && required.every((r) => grants(permissions, r));

/**
 * Evaluate one access rule (`{ anyOf?, allOf?, adminByName }` or `{ note }`) against a user.
 */
export async function checkAccessRule(rule, user, deps = {}) {
  if (!rule.anyOf && !rule.allOf) return { ok: true };
  if (user?.platformSuperUser) return { ok: true };
  const permissions = user?.authContext?.permissions;
  const allOk = !rule.allOf || hasAll(permissions, rule.allOf);
  const anyOk = !rule.anyOf || hasAny(permissions, rule.anyOf);
  if (allOk && anyOk) return { ok: true };
  if (rule.adminByName) {
    const isAdmin = deps.isAdmin ?? userIsAdmin;
    if (await isAdmin(user)) return { ok: true };
  }
  const reasons = [];
  if (!allOk) reasons.push(`Requires all of: ${rule.allOf.join(', ')}.`);
  if (!anyOk) reasons.push(`Requires one of: ${rule.anyOf.join(', ')}.`);
  return { ok: false, reason: reasons.join(' ') };
}

/**
 * student.route.js reads other students' progress behind students.read.
 * Same rule as checkAccessRule — platformSuperUser or a permission grant, no
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

export const rowMatchesAllowed = (r, allowed) =>
  [r._id, r.id, r.userId, r.owner].map(idOf).some((id) => id && allowed.has(id));

// Aggregates or pre-rendered text a result may carry, computed on the whole
// (unscoped) population before the row filter runs. Once rows are cut down, these
// siblings talk about a population the caller can no longer see and must not survive.
const AGGREGATE_SIBLING_KEYS = ['breakdown', 'employmentBreakdown', 'rendered'];

/** Drop stale company-wide aggregates/pre-rendered text and, if present, cut `page` down to the filtered count. */
function stripAggregateSiblings(obj, filteredLength) {
  const out = { ...obj };
  for (const k of AGGREGATE_SIBLING_KEYS) delete out[k];
  if (out.page) out.page = { ...out.page, total: filteredLength, hasMore: false };
  return out;
}

// ponytail: post-filter, not query rewrite. Ceiling: a scoped user only sees rows
// inside the tool's own limit; move the owner filter into the tool's query if a
// scoped population ever exceeds that.
//
// Three result shapes are handled: a bare array, { records: [...] } and
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
 * person tool. Same rule as checkAccessRule — platformSuperUser or a permission
 * grant, no userIsAdmin shortcut.
 */
export async function redactSalary(result, user) {
  if (!result || user?.platformSuperUser) return result;
  if (hasAny(user?.authContext?.permissions, ['employees.manage'])) return result;
  return stripKey(result, 'salaryRange');
}

/**
 * Guard a tool result by its `access` rule: `rowScope: 'person'` rows are cut to
 * the Employees-page scope and salary is redacted.
 */
export async function guardResultForRule(rule, result, user, deps = {}) {
  if (!result || result.forbidden) return result;
  if (rule?.rowScope !== 'person') return result;
  const scoped = applyRowScope(result, await resolveRowScope(user, deps));
  return redactSalary(scoped, user);
}


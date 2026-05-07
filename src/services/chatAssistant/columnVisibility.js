// uat.dharwin.backend/src/services/chatAssistant/columnVisibility.js
//
// Single source of truth for chatbot table COLUMN visibility:
//   1. Viewer-role resolution (RBAC tier).
//   2. Per-column ACL (which roles may see a key).
//   3. Query-aware default column profiles (drops Role/Dept/etc. unless asked).
//   4. Empty-column pruning (>70% of rows empty → hide).
//
// NOTE: row-level visibility (User.status active/disabled/archived) lives in
// `visibilityRules.js`. That filters which user records appear at all; this
// file decides which fields of those records the viewer is allowed to see.
//
// Renderers (employees.js, people.js, …) build a *candidate* column set +
// rows, then route through `applyColumnVisibility` so RBAC/profile/prune
// decisions live in one place — no scattered conditionals in renderers.
//
// HARD RULE: Employee ID is visible ONLY to viewers whose effective role is
// 'employee'. Admin / Agent / Recruiter / HR / Candidate / Student / Other
// never see it, even if the row carries one.

import Role from '../../models/role.model.js';

// ── Viewer-role tiers ───────────────────────────────────────────────────

export const VIEWER_ROLES = Object.freeze({
  ADMIN:     'admin',
  AGENT:     'agent',
  RECRUITER: 'recruiter',
  HR:        'hr',
  EMPLOYEE:  'employee',
  CANDIDATE: 'candidate',
  STUDENT:   'student',
  OTHER:     'other',
});

// Privileged-first precedence: a user with both Administrator and Employee
// resolves to 'admin', so they cannot see employee IDs. This guarantees the
// "only pure employees see employee IDs" rule no matter how seeding stacks
// roles on a single account.
const ROLE_PRECEDENCE = [
  { names: ['Administrator'],          tier: VIEWER_ROLES.ADMIN },
  { names: ['Agent', 'agent'],         tier: VIEWER_ROLES.AGENT },
  { names: ['HR', 'Human Resources'],  tier: VIEWER_ROLES.HR },
  { names: ['Recruiter'],              tier: VIEWER_ROLES.RECRUITER },
  { names: ['Employee'],               tier: VIEWER_ROLES.EMPLOYEE },
  { names: ['Candidate'],              tier: VIEWER_ROLES.CANDIDATE },
  { names: ['Student'],                tier: VIEWER_ROLES.STUDENT },
];

/**
 * Resolve the viewer's effective role tier from a `req.user`-shaped object.
 * Async because role names live on the Role collection (roleIds are ObjectIds).
 *
 * @param {{ roleIds?:string[], platformSuperUser?:boolean }|null|undefined} user
 * @returns {Promise<string>} one of VIEWER_ROLES values
 */
export async function resolveViewerRole(user) {
  if (!user) return VIEWER_ROLES.OTHER;
  if (user.platformSuperUser) return VIEWER_ROLES.ADMIN;
  const roleIds = user.roleIds || [];
  if (!roleIds.length) return VIEWER_ROLES.OTHER;

  const docs = await Role.find({ _id: { $in: roleIds }, status: 'active' })
    .select('name')
    .lean();
  const names = new Set(docs.map((r) => r.name));

  for (const tier of ROLE_PRECEDENCE) {
    if (tier.names.some((n) => names.has(n))) return tier.tier;
  }
  return VIEWER_ROLES.OTHER;
}

/**
 * RBAC predicate. Sole consumer of the "only employees see employee IDs"
 * rule — everywhere else routes through this helper so the rule cannot drift.
 */
export function canRenderEmployeeId(viewerRole) {
  return viewerRole === VIEWER_ROLES.EMPLOYEE;
}

// ── Column-level ACL ────────────────────────────────────────────────────
//
// Default OPEN. Only restricted columns appear here. Each rule is the set
// of viewer tiers allowed to see the column — anything else strips the
// column AND its row values before the wire.

export const COLUMN_VISIBILITY_RULES = Object.freeze({
  employeeId: { visibleFor: [VIEWER_ROLES.EMPLOYEE] },
});

/**
 * @param {{ key:string }} column
 * @param {string} viewerRole
 */
export function isColumnAllowedForRole(column, viewerRole) {
  const rule = COLUMN_VISIBILITY_RULES[column.key];
  if (!rule) return true;
  return Array.isArray(rule.visibleFor) && rule.visibleFor.includes(viewerRole);
}

// ── Query-aware table profiles ──────────────────────────────────────────
//
// Default column whitelists per queried entity. Anything NOT in
// `defaultColumns` requires explicit opt-in (either via the user's natural
// query — see `queryRequestsRole`/`queryRequestsDept` — or a forceInclude
// override from the caller). This is what removes the always-empty
// ROLE / DEPT columns from the agent + employee + candidate tables.

export const TABLE_PROFILES = Object.freeze({
  employees:  { defaultColumns: ['name', 'employeeId', 'status', 'email'] },
  agents:     { defaultColumns: ['name', 'status'] },
  recruiters: { defaultColumns: ['name', 'status'] },
  candidates: { defaultColumns: ['name', 'appliedRole', 'status'] },
  students:   { defaultColumns: ['name', 'status'] },
  people:     { defaultColumns: ['name', 'employeeId', 'status'] },
});

const ROLE_TO_PROFILE = {
  agent:        TABLE_PROFILES.agents,
  agents:       TABLE_PROFILES.agents,
  salesagent:   TABLE_PROFILES.agents,
  'sales agent':TABLE_PROFILES.agents,
  recruiter:    TABLE_PROFILES.recruiters,
  recruiters:   TABLE_PROFILES.recruiters,
  candidate:    TABLE_PROFILES.candidates,
  candidates:   TABLE_PROFILES.candidates,
  student:      TABLE_PROFILES.students,
  students:     TABLE_PROFILES.students,
  employee:     TABLE_PROFILES.employees,
  employees:    TABLE_PROFILES.employees,
};

/**
 * Pick the profile for a queried role string. Falls back to the generic
 * `people` profile when the role is unknown (e.g. mixed listings).
 */
export function profileForRole(role) {
  const key = String(role || '').toLowerCase();
  return ROLE_TO_PROFILE[key] || TABLE_PROFILES.people;
}

// ── Query-intent detectors ──────────────────────────────────────────────
//
// User must explicitly ask for role / department before those columns
// appear. Heuristic — look at the natural-language query for the keyword.

const ROLE_INTENT_RE  = /\b(role|roles|designation|designations)\b/i;
const DEPT_INTENT_RE  = /\b(dept|department|departments)\b/i;
const EMAIL_INTENT_RE = /\b(email|emails|contact)\b/i;

export function queryRequestsRole(q)  { return !!q && ROLE_INTENT_RE.test(q); }
export function queryRequestsDept(q)  { return !!q && DEPT_INTENT_RE.test(q); }
export function queryRequestsEmail(q) { return !!q && EMAIL_INTENT_RE.test(q); }

// ── Empty-column pruning ────────────────────────────────────────────────

const EMPTY_TOKENS = new Set([null, undefined, '', '—']);

function isCellEmpty(v) {
  const text = v && typeof v === 'object' ? v.v : v;
  return EMPTY_TOKENS.has(text);
}

/**
 * Drop columns whose values are empty in more than `threshold` of rows
 * (default 70%). Operates on whatever rows the caller passes — caller
 * decides whether to prune the full result set or the page slice.
 *
 * @param {object[]} columns
 * @param {object[]} rows
 * @param {number} [threshold] 0..1, fraction of rows that must be empty
 *                              to drop the column. Defaults to 0.7.
 */
export function pruneEmptyColumns(columns, rows, threshold = 0.7) {
  if (!Array.isArray(rows) || rows.length === 0) return columns;
  return columns.filter((col) => {
    const empties = rows.reduce((n, r) => n + (isCellEmpty(r[col.key]) ? 1 : 0), 0);
    return empties / rows.length <= threshold;
  });
}

// ── Top-level orchestrator ──────────────────────────────────────────────

/**
 * Apply RBAC + profile + emptiness gates. Returns a clean { columns, rows }
 * pair where rows have hidden keys stripped — the wire never carries data
 * the viewer is not allowed to see (frontend cannot accidentally reveal it).
 *
 * @param {{
 *   candidateColumns: object[],     // full set the renderer might emit
 *   rows: object[],                 // raw rows keyed by candidate column keys
 *   viewerRole: string,             // VIEWER_ROLES tier
 *   profile?: { defaultColumns:string[] } | null,
 *   queryArg?: string,              // user's natural-language query
 *   forceInclude?: string[],        // caller-mandated columns
 * }} input
 * @returns {{ columns:object[], rows:object[] }}
 */
export function applyColumnVisibility({
  candidateColumns,
  rows,
  viewerRole,
  profile = null,
  queryArg = '',
  forceInclude = [],
}) {
  const allowed = new Set(
    profile && Array.isArray(profile.defaultColumns)
      ? profile.defaultColumns
      : candidateColumns.map((c) => c.key),
  );
  if (queryRequestsRole(queryArg))  allowed.add('role');
  if (queryRequestsDept(queryArg))  allowed.add('department');
  if (queryRequestsEmail(queryArg)) allowed.add('email');
  for (const k of forceInclude) allowed.add(k);

  let cols = candidateColumns.filter((c) =>
    allowed.has(c.key) && isColumnAllowedForRole(c, viewerRole),
  );
  cols = pruneEmptyColumns(cols, rows);

  const allowedKeys = new Set(cols.map((c) => c.key));
  const safeRows = rows.map((r) => {
    const out = {};
    for (const k of allowedKeys) if (k in r) out[k] = r[k];
    return out;
  });

  return { columns: cols, rows: safeRows };
}

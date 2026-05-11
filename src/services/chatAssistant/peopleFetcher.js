const ACTIVE_SYNONYMS   = new Set(['active', 'current']);
const RESIGNED_SYNONYMS = new Set(['resigned', 'retired', 'former', 'past', 'ex', 'left']);
const ALL_SYNONYMS      = new Set(['all', 'both']);

export function normaliseEmploymentScope(input) {
  const v = String(input ?? '').trim().toLowerCase();
  if (RESIGNED_SYNONYMS.has(v)) return 'resigned';
  if (ALL_SYNONYMS.has(v))      return 'all';
  if (ACTIVE_SYNONYMS.has(v))   return 'active';
  return 'active';
}

export function clampPageSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 25;
  return Math.max(10, Math.min(50, Math.floor(v)));
}

/**
 * Build the Mongo filter for the Employee collection.
 * @param {{ownerIds: string[]|null, scope: 'active'|'resigned'|'all', today: Date}} args
 */
export function buildEmployeeFilter({ ownerIds, scope, today }) {
  const filter = {};
  if (ownerIds !== null) filter.owner = { $in: ownerIds };
  if (scope === 'resigned') {
    filter.resignDate = { $ne: null, $lte: today };
  } else if (scope === 'active') {
    filter.$or = [
      { resignDate: null },
      { resignDate: { $exists: false } },
      { resignDate: { $gt: today } },
    ];
  }
  return filter;
}

/**
 * Build the keyset pagination clause.
 * For Employee paging cursor has {lastEmployeeId, lastId}.
 * For User paging cursor has just {lastId}.
 */
export function buildKeysetCursorClause(cursor) {
  if (!cursor) return {};
  if (cursor.lastEmployeeId) {
    return {
      $or: [
        { employeeId: { $gt: cursor.lastEmployeeId } },
        { employeeId: cursor.lastEmployeeId, _id: { $gt: cursor.lastId } },
      ],
    };
  }
  if (cursor.lastId) {
    return { _id: { $gt: cursor.lastId } };
  }
  return {};
}

import { resolveIdentity } from './orphanResolver.js';
import { resolveRoleIds, tagRoleNames } from './roleResolver.js';
import { resolveRole as registryResolveRole } from './roleRegistry.js';
import { visibleUserStatusClause } from './visibilityRules.js';

function emptyPage() {
  return { from: 0, to: 0, total: 0, hasMore: false, nextCursor: null };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mutate `records` in place — set each record's `appliedRole` to the title of
 * the most recent JobApplication.job. Records without an application keep
 * `appliedRole: null` so the renderer's empty-prune can drop the column.
 *
 * @param {object[]} records  rows from fetchEmployees (must carry `_employeeDocId`)
 * @param {*} JobApplication  Mongoose model
 */
async function enrichWithAppliedRole(records, JobApplication) {
  const ids = records.map((r) => r._employeeDocId).filter(Boolean);
  if (!ids.length) return;
  const apps = await JobApplication.find({ candidate: { $in: ids } })
    .populate('job', 'title name')
    .sort({ createdAt: -1 })
    .lean();
  // First match per candidate wins (most recent due to sort).
  const latestByCandidate = new Map();
  for (const a of apps) {
    const key = String(a.candidate);
    if (latestByCandidate.has(key)) continue;
    const title = a.job && (a.job.title || a.job.name);
    if (title) latestByCandidate.set(key, title);
  }
  for (const r of records) {
    const k = String(r._employeeDocId || '');
    if (latestByCandidate.has(k)) r.appliedRole = latestByCandidate.get(k);
  }
}

async function computeEmploymentBreakdown({ Employee, ownerIds, today }) {
  const baseFilter = ownerIds !== null ? { owner: { $in: ownerIds } } : {};
  const [active, resigned] = await Promise.all([
    Employee.countDocuments({
      ...baseFilter,
      $or: [{ resignDate: null }, { resignDate: { $exists: false } }, { resignDate: { $gt: today } }],
    }),
    Employee.countDocuments({ ...baseFilter, resignDate: { $ne: null, $lte: today } }),
  ]);
  return { active, resigned, total: active + resigned };
}

async function fetchEmployees({ scope, cursor, size, search, today, Employee, User, Role, JobApplication = null, isCandidatePath = false }) {
  const { ids: empRoleIds } = await resolveRoleIds('Employee', Role);
  // Fail-closed when the Employee Role doc is missing. Previously the code
  // degraded to ownerIds=null which silently returned ALL Employee records
  // ignoring ownership scope — admins lost the audit boundary and disabled
  // owners bled into headcount. Empty list + explicit error is safer.
  if (!empRoleIds.length) {
    return {
      records: [],
      page: emptyPage(),
      error: 'employee_role_missing',
      hint: 'Employee Role document is not seeded; run seed:roles to restore.',
    };
  }
  // Use the central visibilityRules clause so this filter ALWAYS matches the
  // entity-resolver, attendance aggregator, and legacy fetch_employees paths.
  // Default = active+pending; widen via env CHATBOT_INCLUDE_DISABLED.
  // Resignation is tracked separately via Employee.resignDate (controlled by
  // employmentScope arg).
  const ownerIds = await User.find({
    roleIds: { $in: empRoleIds },
    status: visibleUserStatusClause(),
    platformSuperUser: { $ne: true },
  }).distinct('_id');

  const baseFilter = buildEmployeeFilter({ ownerIds, scope, today });
  const cursorClause = buildKeysetCursorClause(cursor);
  const searchClause = search
    ? { $or: [
        { fullName:   { $regex: escapeRegex(search), $options: 'i' } },
        { employeeId: { $regex: escapeRegex(search), $options: 'i' } },
      ] }
    : {};

  const fullFilter = { ...baseFilter, ...cursorClause, ...searchClause };

  const [pageDocs, total, breakdown] = await Promise.all([
    Employee.find(fullFilter).sort({ employeeId: 1, _id: 1 }).limit(size + 1).lean(),
    Employee.countDocuments({ ...baseFilter, ...searchClause }),
    computeEmploymentBreakdown({ Employee, ownerIds, today }),
  ]);

  const hasMore = pageDocs.length > size;
  const records = pageDocs.slice(0, size);

  if (records.length === 0 && search) {
    return { records: [], page: emptyPage(), notFound: true, searchedFor: search, source: 'mongo:employee:search' };
  }

  const ownerIdsOnPage = records.map((e) => e.owner).filter(Boolean);
  const owners = ownerIdsOnPage.length
    ? await User.find({ _id: { $in: ownerIdsOnPage } }).lean()
    : [];
  const userByOwner = new Map(owners.map((u) => [String(u._id), u]));

  // Batch-resolve role tags across the page.
  const allRoleIds = [...new Set(owners.flatMap((u) => (u.roleIds || []).map(String)))];
  const roleMap = allRoleIds.length ? await tagRoleNames(allRoleIds, Role) : new Map();

  const out = records.map((e) => {
    const u = userByOwner.get(String(e.owner));
    const id = resolveIdentity(e, u);
    const computed = u
      ? [...new Set((u.roleIds || []).map((rid) => roleMap.get(String(rid))).filter(Boolean))]
      : ['Employee'];
    const resolvedRoleNames = computed.length ? computed : ['Employee'];
    return {
      ...id,
      _employeeDocId: e._id,           // internal — stripped before render
      role: resolvedRoleNames,         // listingRenderer reads `role`
      roleNames: resolvedRoleNames,    // summarizeData renderer reads `roleNames`
      employeeId: e.employeeId || null,
      designation: e.designation || null,
      department: e.department || null,
      joiningDate: e.joiningDate || null,
      resignDate: e.resignDate || null,
      employmentState: e.resignDate && new Date(e.resignDate) <= today ? 'resigned' : 'active',
    };
  });

  // Candidate path — enrich with the latest JobApplication's job title so the
  // chatbot's candidate table can show an authoritative "Applied Role" column
  // instead of falling back to Employee.designation. Single batched query;
  // no N+1. Silent no-op when JobApplication isn't injected (legacy callers).
  if (isCandidatePath && JobApplication && out.length) {
    await enrichWithAppliedRole(out, JobApplication);
  }
  for (const r of out) delete r._employeeDocId;

  const last = records[records.length - 1];
  const nextCursor = hasMore && last
    ? { lastEmployeeId: last.employeeId || '', lastId: last._id }
    : null;

  return {
    records: out,
    page: { from: 1, to: out.length, total, hasMore, nextCursor },
    source: `mongo:employee:${scope}`,
    breakdown,
  };
}

async function fetchUsersByRole({ role, cursor, size, search, User, Role }) {
  const { ids: roleIds } = await resolveRoleIds(role, Role);
  if (!roleIds.length) {
    return { records: [], page: emptyPage(), error: 'role_not_found' };
  }

  const cursorClause = buildKeysetCursorClause(cursor);
  const searchClause = search
    ? { $or: [
        { name:  { $regex: escapeRegex(search), $options: 'i' } },
        { email: { $regex: escapeRegex(search), $options: 'i' } },
      ] }
    : {};

  // No adminId filter — global fetch (multi-tenancy enforced upstream if ever required).
  // Excludes platformSuperUser so the seed/owner account never appears in role-scoped lists.
  // visibleUserStatusClause() — single source of truth so count == list == direct
  // lookup. Operator can widen via env CHATBOT_INCLUDE_DISABLED if a tenant wants
  // disabled users surfaced.
  const visibilityFilter = { status: visibleUserStatusClause(), platformSuperUser: { $ne: true } };
  const filter = { roleIds: { $in: roleIds }, ...visibilityFilter, ...cursorClause, ...searchClause };

  const [pageDocs, total] = await Promise.all([
    User.find(filter).sort({ _id: 1 }).limit(size + 1).lean(),
    User.countDocuments({ roleIds: { $in: roleIds }, ...visibilityFilter, ...searchClause }),
  ]);

  const hasMore = pageDocs.length > size;
  const records = pageDocs.slice(0, size);

  if (records.length === 0 && search) {
    return { records: [], page: emptyPage(), notFound: true, searchedFor: search, source: `mongo:user:${role}:search` };
  }

  // Tag every row with the canonical names of all roles its user holds.
  const allRoleIds = [...new Set(records.flatMap((u) => (u.roleIds || []).map(String)))];
  const roleMap = await tagRoleNames(allRoleIds, Role);

  const out = records.map((u) => {
    const roleNames = [...new Set(
      (u.roleIds || []).map((id) => roleMap.get(String(id))).filter(Boolean)
    )];
    return {
      _id: u._id,
      name: u.name || u.email || 'Unknown',
      email: u.email || null,
      phone: u.phoneNumber || null,
      role: roleNames.length ? roleNames : [role],
      roleNames: roleNames.length ? roleNames : [role],
      designation: null,
      department: null,
      employmentState: 'active',
      _orphan: false,
    };
  });

  const last = records[records.length - 1];
  const nextCursor = hasMore && last ? { lastId: last._id } : null;

  return {
    records: out,
    page: { from: 1, to: out.length, total, hasMore, nextCursor },
    source: `mongo:user:${role}`,
  };
}

async function fetchStudents({ cursor, size, search, Student, User, Role }) {
  // Student docs themselves carry no name/email — those live on the linked User.
  // Resolve Administrator role ids so we can drop Student rows whose linked
  // User also holds Administrator (regression fix — admins were bleeding into
  // the student list when a Student doc referenced an admin owner).
  let adminRoleIds = [];
  if (Role) {
    try {
      const adminDocs = await Role.find(
        { name: { $in: ['Administrator'] }, status: 'active' },
        { _id: 1 }
      ).lean();
      adminRoleIds = adminDocs.map((d) => d._id);
    } catch {
      adminRoleIds = [];
    }
  }
  const adminIdSet = new Set(adminRoleIds.map((id) => String(id)));

  const cursorClause = buildKeysetCursorClause(cursor);
  const docFilter = { ...cursorClause };

  // Pull more than `size` so admin / search filtering still leaves a full page.
  const fetchSize = Math.max(size * 3, size + 5);
  const [pageDocs, totalRaw] = await Promise.all([
    Student.find(docFilter).sort({ _id: 1 }).limit(fetchSize + 1).lean(),
    Student.countDocuments({}),
  ]);

  const userIds = pageDocs.map((s) => s.user).filter(Boolean);
  const users = User && userIds.length
    ? await User.find(
        { _id: { $in: userIds } },
        { _id: 1, name: 1, email: 1, phoneNumber: 1, roleIds: 1 }
      ).lean()
    : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const safeSearch = search ? escapeRegex(search) : null;
  const searchRe = safeSearch ? new RegExp(safeSearch, 'i') : null;

  const filtered = [];
  for (const s of pageDocs) {
    const u = userById.get(String(s.user));
    // Strict-equality role guard — never `.includes("admin")`. Drop students
    // whose linked User carries any Administrator role id.
    if (u?.roleIds?.some((rid) => adminIdSet.has(String(rid)))) continue;
    if (searchRe) {
      const hay = `${u?.name || ''} ${u?.email || ''}`.trim();
      if (!searchRe.test(hay)) continue;
    }
    filtered.push({ s, u });
    if (filtered.length >= size + 1) break;
  }

  const hasMore = filtered.length > size;
  const records = filtered.slice(0, size);

  if (records.length === 0 && search) {
    return { records: [], page: emptyPage(), notFound: true, searchedFor: search, source: 'mongo:student:search' };
  }

  // Authoritative total = students whose linked User is non-admin. Compute via
  // an adminUserIds set; falls back to raw count when Role isn't seeded.
  let total = totalRaw;
  if (adminRoleIds.length && User) {
    const adminUserIds = (await User.find(
      { roleIds: { $in: adminRoleIds } },
      { _id: 1 }
    ).lean()).map((u) => u._id);
    if (adminUserIds.length) {
      const adminStudentCount = await Student.countDocuments({ user: { $in: adminUserIds } });
      total = Math.max(0, totalRaw - adminStudentCount);
    }
  }

  const out = records.map(({ s, u }) => ({
    _id: s._id,
    name: u?.name || u?.email || 'Unknown',
    email: u?.email || null,
    phone: u?.phoneNumber || s.phone || null,
    role: ['Student'],
    roleNames: ['Student'],
    designation: null,
    department: null,
    employmentState: 'active',
    _orphan: !u,
  }));

  const last = records[records.length - 1]?.s;
  const nextCursor = hasMore && last ? { lastId: last._id } : null;

  return {
    records: out,
    page: { from: 1, to: out.length, total, hasMore, nextCursor },
    source: 'mongo:student',
  };
}

/**
 * Async orchestrator. Models are injected so this is fully unit-testable.
 * @param {{ adminId: string, role: string, employmentScope: string, cursor: object|null,
 *           pageSize: number, search?: string|null, today?: Date, models: object }} params
 */
export async function fetchPeople({
  adminId, role, employmentScope, cursor, pageSize,
  search = null, today = new Date(), models,
}) {
  const scope = normaliseEmploymentScope(employmentScope);
  const size  = clampPageSize(pageSize);
  const { Employee, User, Role, Student, JobApplication = null } = models;

  try {
    // Slug-driven dispatch. Custom roles added in DB (e.g. "Mentor") flow
    // through fetchUsersByRole automatically — no code change needed.
    const resolved = await registryResolveRole(role);
    // Cold registry / unknown role → fall back to slugifying the input
    // itself so behavior class can still be inferred for the well-known
    // Employee / Candidate / Student paths.
    const slug = resolved.canonical
      || String(role || '').trim().toLowerCase().replace(/[\s_-]+/g, '').replace(/[^a-z0-9]/g, '');

    if (!slug) return { records: [], page: emptyPage(), error: 'role_not_found' };

    if (slug === 'employee' || slug === 'candidate') {
      return await fetchEmployees({
        scope, cursor, size, search, today,
        Employee, User, Role, JobApplication,
        isCandidatePath: slug === 'candidate',
      });
    }
    if (slug === 'student') {
      return await fetchStudents({ cursor, size, search, Student, User, Role });
    }
    return await fetchUsersByRole({ role, cursor, size, search, User, Role });
  } catch (err) {
    return { records: [], page: emptyPage(), error: 'fetch_failed', errorMessage: err.message };
  }
}

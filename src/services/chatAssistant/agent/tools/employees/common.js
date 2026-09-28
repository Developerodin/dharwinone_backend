import EmployeeModel from '../../../../../models/employee.model.js';
import { executeEmployeeQuery as realExecuteEmployeeQuery } from '../../../../../schemas/employees/employeeQuery.executor.js';
import {
  applyEmployeeListScope as realApplyEmployeeListScope,
  toApiFilter,
} from '../../../../../schemas/employees/employeeQuery.scope.js';
import {
  authorizeEmployeeQuery as realAuthorizeEmployeeQuery,
  EMPLOYEE_QUERY_READ_PERMISSIONS,
} from '../../../../../schemas/employees/employeeQuery.rbac.js';
import { buildEmployeeListMongoFilter as realBuildEmployeeListMongoFilter } from '../../../../employee.service.js';

// Same permissions the Employees page list route accepts (employee.route.js canReadEmployees).
export const EMPLOYEES_ACCESS = Object.freeze({ anyOf: [...EMPLOYEE_QUERY_READ_PERMISSIONS] });

const MAX_GROUPS = 25;
const NOT_SET = 'Not set';
export const MAX_LIST_LIMIT = 50;

/** Fail-closed guard, mirrors people's peopleScope(ctx). */
export function personRecordsScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('employee/candidate tools need an authenticated user with an id');
  }
  return ctx.user;
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function personRecordsDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    executeEmployeeQuery: deps.executeEmployeeQuery ?? realExecuteEmployeeQuery,
    applyEmployeeListScope: deps.applyEmployeeListScope ?? realApplyEmployeeListScope,
    buildEmployeeListMongoFilter: deps.buildEmployeeListMongoFilter ?? realBuildEmployeeListMongoFilter,
    authorizeEmployeeQuery: deps.authorizeEmployeeQuery ?? realAuthorizeEmployeeQuery,
    Employee: deps.Employee ?? EmployeeModel,
  };
}

/** Drop empty keys; ownerUserRole rides along as a filter (toApiFilter passes it through). */
function cleanFilters(filters = {}, ownerUserRole) {
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return { ...out, ownerUserRole };
}

/** executeEmployeeQuery owns RBAC, row scope and salary masking — never bypass it. */
function executorDeps(deps) {
  return {
    applyEmployeeListScope: deps.applyEmployeeListScope,
    buildEmployeeListMongoFilter: deps.buildEmployeeListMongoFilter,
  };
}

export async function runPersonCount({ filters, ownerUserRole, user, deps }) {
  const query = { entity: 'employees', operations: ['count'], filters: cleanFilters(filters, ownerUserRole) };
  const res = await deps.executeEmployeeQuery(query, user, executorDeps(deps));
  if (!res?.success) return { error: res?.message || 'query failed' };
  return {
    total: res.total ?? 0,
    ...(res.employmentBreakdown ? { employmentBreakdown: res.employmentBreakdown } : {}),
    filtersApplied: filters || {},
  };
}

export async function runPersonList({ filters, ownerUserRole, page = 1, limit = 20, user, deps }) {
  const query = {
    entity: 'employees',
    operations: ['count', 'list'],
    filters: cleanFilters(filters, ownerUserRole),
    pagination: { page, limit: Math.min(limit, MAX_LIST_LIMIT) },
  };
  const res = await deps.executeEmployeeQuery(query, user, executorDeps(deps));
  if (!res?.success) return { error: res?.message || 'query failed' };
  return {
    total: res.total ?? 0,
    page: res.page ?? page,
    hasNextPage: !!res.hasNextPage,
    records: (res.records || []).map((r) => ({
      id: String(r._id ?? ''),
      name: r.fullName ?? null,
      employeeId: r.employeeId ?? null,
      email: r.email ?? null,
      designation: r.designation ?? null,
      department: r.department ?? null,
      employmentType: r.employmentType ?? null,
      compensationType: r.compensationType ?? null,
      joiningDate: r.joiningDate ?? r.joinDate ?? null,
      resignDate: r.resignDate ?? r.resignationDate ?? null,
    })),
    filtersApplied: filters || {},
  };
}

function shapeGroups(values) {
  const byValue = new Map();
  for (const raw of values) {
    const value = raw === null || raw === undefined || raw === '' ? NOT_SET : String(raw);
    byValue.set(value, (byValue.get(value) || 0) + 1);
  }
  const all = [...byValue].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  const groups = all.slice(0, MAX_GROUPS);
  const otherCount = all.slice(MAX_GROUPS).reduce((s, g) => s + g.count, 0);
  return { total: values.length, groups, ...(otherCount ? { otherCount } : {}) };
}

/**
 * Breakdown by one Employee field. employmentStatus uses the executor's own breakdown; every other
 * field reads the scoped rows' single field and groups in JS.
 * ponytail: JS grouping over find().select(field) — aggregate $match does not auto-cast the string
 * ids buildEmployeeListMongoFilter can emit (same reason applicantQuery groups in JS). Fine to ~50k
 * rows; switch to an aggregate with explicit ObjectId casting if the collection outgrows that.
 */
export async function runPersonGroupBy({ filters, ownerUserRole, groupBy, user, deps }) {
  const cleaned = cleanFilters(filters, ownerUserRole);

  if (groupBy === 'employmentStatus') {
    const res = await runPersonCount({
      filters: { ...(filters || {}), employmentStatus: 'all' }, ownerUserRole, user, deps,
    });
    if (res.error) return res;
    const b = res.employmentBreakdown || { active: 0, resigned: 0, total: res.total };
    return {
      total: b.total,
      groups: [{ value: 'current', count: b.active }, { value: 'resigned', count: b.resigned }],
      groupBy,
      filtersApplied: filters || {},
    };
  }

  // Same salary-inference guard as a plain count: a salary-masked viewer may not break one
  // narrowed-down person out by compensationType.
  const authProbe = groupBy === 'compensationType' ? { ...cleaned, compensationType: 'paid' } : cleaned;
  const auth = deps.authorizeEmployeeQuery({ entity: 'employees', operations: ['count'], filters: authProbe }, user);
  if (!auth?.allowed) return { error: auth?.error || 'not allowed' };

  const apiFilter = await deps.applyEmployeeListScope(toApiFilter(cleaned), user, user.authContext);
  const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
  const rows = await deps.Employee.find(mongoFilter).select(groupBy).lean();
  return { ...shapeGroups(rows.map((r) => r[groupBy])), groupBy, filtersApplied: filters || {} };
}

export function personCountFacts(kind, label, total) {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}

const GROUP_LABELS = {
  department: 'Department',
  designation: 'Designation',
  employmentType: 'Employment type',
  compensationType: 'Paid / unpaid',
  employmentStatus: 'Status',
};

const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function personBreakdownBlock(result, { label, id }) {
  const rows = result.groups.map((g) => ({ value: g.value, count: String(g.count) }));
  if (result.otherCount) rows.push({ value: 'Other', count: String(result.otherCount) });
  const colLabel = GROUP_LABELS[result.groupBy] ?? result.groupBy;
  return {
    type: 'table',
    id,
    tableType: id,
    title: `${cap(label)} by ${colLabel.toLowerCase()} (${result.total})`,
    columns: [
      { key: 'value', label: colLabel, priority: 'primary' },
      { key: 'count', label: cap(label), priority: 'primary', format: 'number' },
    ],
    rows,
    layout: 'auto',
  };
}

export function personListBlock(result, { label, id }) {
  return {
    type: 'table',
    id,
    tableType: id,
    title: `${cap(label)} (${result.total})`,
    columns: [
      { key: 'name', label: 'Name', priority: 'primary' },
      { key: 'employeeId', label: 'ID', priority: 'secondary' },
      { key: 'designation', label: 'Designation', priority: 'primary' },
      { key: 'department', label: 'Department', priority: 'secondary' },
      { key: 'employmentType', label: 'Type', priority: 'secondary' },
    ],
    rows: result.records.map((r) => ({
      name: r.name ?? '—',
      employeeId: r.employeeId ?? '—',
      designation: r.designation ?? '—',
      department: r.department ?? '—',
      employmentType: r.employmentType ?? '—',
    })),
    layout: 'auto',
  };
}

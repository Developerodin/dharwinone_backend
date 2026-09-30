import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import EmployeeModel from '../../../../../models/employee.model.js';
import UserModel from '../../../../../models/user.model.js';
import EmployeeTransferModel from '../../../../../models/employeeTransfer.model.js';
import {
  searchOrgChart as realSearchOrgChart,
  listOrgUnits as realListOrgUnits,
  buildTree as realBuildTree,
} from '../../../../orgStructure.service.js';
import { queryTeamMembers as realQueryTeamMembers } from '../../../../team.service.js';
import { queryTeamGroups as realQueryTeamGroups } from '../../../../teamGroup.service.js';
import { ORG_READ_PERMISSIONS } from '../../../orgStructureAnalytics.js';
import { buildProjectQueryContext } from '../../../projectGraph.resolvers.js';
import { checkAccessRule, resolveRowScope as realResolveRowScope } from '../../../toolAccess.js';
import { EMPLOYEES_ACCESS, dayWindowBounds } from '../employees/common.js';
import { TEAMS_ACCESS, idOf } from '../projects/common.js';

const MAX_RECORDS = 50;
const MODES = ['chain', 'direct_reports', 'no_reporting_manager', 'no_group', 'group_moves'];
const LEVEL_BY_TYPE = { department: 'teamLead', supervisor: 'supervisor', manager: 'manager', ceo: 'ceo' };
const NOT_CAPTURED = 'not captured in DharwinOne';

function orgScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) throw new Error('org tools need an authenticated user with an id');
  return ctx.user;
}

function chainDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    searchOrgChart: deps.searchOrgChart ?? realSearchOrgChart,
    listOrgUnits: deps.listOrgUnits ?? realListOrgUnits,
    buildTree: deps.buildTree ?? realBuildTree,
    queryTeamMembers: deps.queryTeamMembers ?? realQueryTeamMembers,
    queryTeamGroups: deps.queryTeamGroups ?? realQueryTeamGroups,
    resolveRowScope: deps.resolveRowScope ?? realResolveRowScope,
    Employee: deps.Employee ?? EmployeeModel,
    User: deps.User ?? UserModel,
    EmployeeTransfer: deps.EmployeeTransfer ?? EmployeeTransferModel,
  };
}

const allowed = async (rule, user) => (await checkAccessRule(rule, user)).ok;
// idOf, not String(v._id ?? v): queryTeamMembers returns toJSON rows whose populated teamId is { id, name }.
const sid = idOf;

/** A person on the Org Chart search (active, Employee-role, chart-scoped). Exact name wins. */
async function resolveChartPerson(person, user, deps) {
  const res = await deps.searchOrgChart(user, person);
  const hits = res?.employees || [];
  const exact = hits.filter((e) => String(e.fullName || '').toLowerCase() === person.trim().toLowerCase());
  const pool = exact.length ? exact : hits;
  if (pool.length === 1) return { found: pool[0], paths: res.paths || [] };
  if (pool.length > 1) return { result: { ambiguous: 'person', matches: pool.slice(0, 10).map((e) => e.fullName) } };
  return { result: { notFound: 'person', searchedFor: person, note: 'No active employee by that name on the org chart.' } };
}

/** Every active employee the Org Chart shows (in a department node or unassigned). */
async function chartEmployees(user, deps) {
  const tree = await deps.buildTree(user);
  const out = new Map();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      for (const e of n.employees || []) out.set(String(e.id), e);
      walk(n.children);
    }
  };
  walk(tree?.roots);
  for (const e of tree?.unassigned || []) out.set(String(e.id), e);
  return { all: [...out.values()], unassigned: tree?.unassigned || [] };
}

/**
 * Employee.reportingManager is only set from Onboarding → Edit, and some deployments never set it. When
 * no employee has one, "nobody reports to X" / "everyone lacks a manager" would be a false finding —
 * the field is simply not captured.
 */
const RM_UNUSED_NOTE =
  'No employee has a reporting manager set in DharwinOne (it is set from Onboarding → Edit), so reporting-manager ' +
  'links are not captured yet — this is not a finding about the people listed.';
async function reportingManagerUnused(deps) {
  return (await deps.Employee.countDocuments({ reportingManager: { $ne: null } })) === 0;
}

async function workforceTeams(empId, user, deps) {
  if (!(await allowed(TEAMS_ACCESS, user))) return { teams: null, teamsNote: 'Workforce team leads need teams.read.' };
  const qctx = buildProjectQueryContext(user);
  const members = await deps.queryTeamMembers({ ...qctx, employeeId: empId }, { limit: 10 });
  const teamIds = [...new Set((members?.results || []).map((m) => sid(m.teamId)).filter(Boolean))];
  if (!teamIds.length) return { teams: [] };
  const groups = await deps.queryTeamGroups({ ...qctx, _id: { $in: teamIds } }, { limit: 10 });
  const leadIds = (groups?.results || []).map((g) => sid(g.teamLead)).filter(Boolean);
  const leads = leadIds.length ? await deps.Employee.find({ _id: { $in: leadIds } }).select('fullName').lean() : [];
  const leadName = new Map(leads.map((l) => [String(l._id), l.fullName ?? null]));
  return {
    teams: (groups?.results || []).map((g) => ({
      team: g.name ?? null,
      teamLead: g.teamLead ? leadName.get(sid(g.teamLead)) ?? null : null,
    })),
  };
}

async function runChain(person, user, deps) {
  const who = await resolveChartPerson(person, user, deps);
  if (who.result) return { mode: 'chain', ...who.result };
  const empId = String(who.found.id);
  const [emp, units] = await Promise.all([
    deps.Employee.findById(empId).select('owner reportingManager designation').lean(),
    deps.listOrgUnits(),
  ]);
  const selfIds = new Set([empId, sid(emp?.owner)].filter(Boolean));
  const unitById = new Map((units || []).map((u) => [String(u.id ?? u._id), u]));
  const path = (who.paths.find((p) => p.kind === 'employee' && String(p.id) === empId)?.pathIds) || [];
  const chain = [...path].reverse().map((id) => unitById.get(String(id))).filter(Boolean).map((u) => {
    const headId = sid(u.headEmployeeId);
    return {
      level: LEVEL_BY_TYPE[u.type] ?? u.type,
      unit: u.name ?? null,
      head: u.headEmployee?.fullName ?? null,
      ...(headId && selfIds.has(headId) ? { isSelf: true } : {}),
    };
  });
  let reportingManager = null;
  if (emp?.reportingManager) {
    const rm = await deps.User.findById(emp.reportingManager).select('name').lean();
    reportingManager = rm?.name ?? null;
  }
  const teams = await workforceTeams(empId, user, deps);
  return {
    mode: 'chain',
    person: who.found.fullName ?? null,
    designation: emp?.designation ?? null,
    onChart: chain.length > 0,
    chain,
    ...(chain.length ? {} : { chainNote: 'Not placed in any org-chart department (no group).' }),
    reportingManager,
    ...(reportingManager ? {} : { reportingManagerNote: `Reporting manager ${NOT_CAPTURED}.` }),
    ...teams,
  };
}

async function runDirectReports(person, limit, user, deps) {
  const who = await resolveChartPerson(person, user, deps);
  if (who.result) return { mode: 'direct_reports', ...who.result };
  const empId = String(who.found.id);
  const [emp, units] = await Promise.all([
    deps.Employee.findById(empId).select('owner').lean(),
    deps.listOrgUnits(),
  ]);
  const ownerId = sid(emp?.owner);
  const selfIds = new Set([empId, ownerId].filter(Boolean));
  const headsUnits = (units || [])
    .filter((u) => u.headEmployeeId && selfIds.has(sid(u.headEmployeeId)))
    .map((u) => ({ unit: u.name ?? null, type: u.type }));
  if (!ownerId) {
    return { mode: 'direct_reports', person: who.found.fullName ?? null, total: 0, records: [], headsUnits,
      note: 'This employee has no login account, so nobody can have them as reporting manager.' };
  }
  const filter = { reportingManager: ownerId, isActive: { $ne: false } };
  const [rows, total] = await Promise.all([
    deps.Employee.find(filter).select('fullName designation employeeId').sort({ fullName: 1 }).limit(limit).lean(),
    deps.Employee.countDocuments(filter),
  ]);
  return {
    mode: 'direct_reports',
    person: who.found.fullName ?? null,
    total,
    records: rows.map((r) => ({ name: r.fullName ?? null, employeeId: r.employeeId ?? null, designation: r.designation ?? null })),
    headsUnits,
    ...(total === 0 && (await reportingManagerUnused(deps)) ? { note: RM_UNUSED_NOTE } : {}),
  };
}

/** ponytail: $in over every chart employee id; fine to ~10k active employees, then move to an aggregate. */
async function runNoReportingManager(limit, user, deps) {
  const { all } = await chartEmployees(user, deps);
  const ids = all.map((e) => String(e.id));
  const rows = ids.length
    ? await deps.Employee.find({ _id: { $in: ids }, reportingManager: null })
      .select('fullName designation employeeId').sort({ fullName: 1 }).lean()
    : [];
  return {
    mode: 'no_reporting_manager',
    total: rows.length,
    totalActiveEmployees: ids.length,
    records: rows.slice(0, limit).map((r) => ({
      name: r.fullName ?? null, employeeId: r.employeeId ?? null, designation: r.designation ?? null,
    })),
    ...(ids.length && rows.length === ids.length && (await reportingManagerUnused(deps)) ? { note: RM_UNUSED_NOTE } : {}),
  };
}

async function runNoGroup(limit, user, deps) {
  const { all, unassigned } = await chartEmployees(user, deps);
  const sorted = [...unassigned].sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  return {
    mode: 'no_group',
    total: unassigned.length,
    totalActiveEmployees: all.length,
    records: sorted.slice(0, limit).map((e) => ({ name: e.fullName ?? null, designation: e.designation ?? null })),
  };
}

/**
 * EmployeeTransfer rows (designation / department moves) with who approved and when. Employee-record
 * history, so it also needs an Employees-page read permission and stays inside that page's row scope.
 */
async function runGroupMoves({ person, movedBetween, limit }, user, deps) {
  if (!(await allowed(EMPLOYEES_ACCESS, user))) {
    return { mode: 'group_moves', error: `Group moves need one of: ${EMPLOYEES_ACCESS.anyOf.join(', ')}.` };
  }
  const allowedOwners = await deps.resolveRowScope(user);
  const clauses = [];
  if (allowedOwners) {
    const empIds = await deps.Employee.find({ owner: { $in: [...allowedOwners] } }).distinct('_id');
    clauses.push({ employee: { $in: empIds } });
  }
  let personName = null;
  if (person) {
    const who = await resolveChartPerson(person, user, deps);
    if (who.result) return { mode: 'group_moves', ...who.result };
    personName = who.found.fullName ?? null;
    clauses.push({ employee: String(who.found.id) });
  }
  const { from, to } = dayWindowBounds(movedBetween);
  if (from || to) {
    clauses.push({ effectiveDate: { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) } });
  }
  const filter = clauses.length ? { $and: clauses } : {};
  const [rows, total] = await Promise.all([
    deps.EmployeeTransfer.find(filter).sort({ effectiveDate: -1 }).limit(limit)
      .populate('employee', 'fullName').populate('approvedBy', 'name').lean(),
    deps.EmployeeTransfer.countDocuments(filter),
  ]);
  return {
    mode: 'group_moves',
    ...(personName ? { person: personName } : {}),
    ...(movedBetween ? { movedBetween } : {}),
    total,
    records: rows.map((t) => ({
      employee: t.employee?.fullName ?? null,
      fromDesignation: t.oldDesignation ?? null,
      toDesignation: t.newDesignation ?? null,
      fromDepartment: t.oldDepartment ?? null,
      toDepartment: t.newDepartment ?? null,
      effectiveDate: t.effectiveDate ?? null,
      approvedBy: t.approvedBy?.name ?? null,
      recordedAt: t.createdAt ?? null,
    })),
    ...(allowedOwners ? { scopedToYou: true } : {}),
  };
}

export default defineTool({
  name: 'get_reporting_chain',
  domain: 'org',
  kind: 'read',
  description:
    'Who someone reports to and who reports to them. mode chain (person): team lead (their department unit head) → ' +
    'supervisor → manager → CEO on the org chart, plus their reporting manager field and workforce team leads. ' +
    'mode direct_reports (person): employees whose reporting manager is this person, and chart units they head. ' +
    'mode no_reporting_manager / no_group: active employees with no reporting manager / in no org-chart ' +
    'department. mode group_moves: internal transfers (department / designation moves) with who approved and ' +
    'when; optional person and movedBetween.',
  measure:
    'Active Employee profiles on the Org Chart. Direct reports = Employee.reportingManager links. Group moves = ' +
    'EmployeeTransfer records (internal transfers), by effective date.',
  input: Joi.object({
    mode: Joi.string().valid(...MODES).default('chain'),
    person: Joi.string().min(2).max(120).description('Real name of the employee. Required for chain / direct_reports.'),
    movedBetween: Joi.object({
      from: Joi.string().min(10).max(10).description('YYYY-MM-DD'),
      to: Joi.string().min(10).max(10).description('YYYY-MM-DD'),
    }).description('mode group_moves: effective date on or between these days (inclusive, IST).'),
    limit: Joi.number().integer().min(1).max(MAX_RECORDS).default(20),
  }),
  access: { anyOf: [...ORG_READ_PERMISSIONS] },
  async execute({ mode = 'chain', person, movedBetween, limit = 20 } = {}, ctx) {
    const user = orgScope(ctx);
    const deps = chainDeps(ctx);
    if ((mode === 'chain' || mode === 'direct_reports') && !person) return { mode, error: `mode ${mode} needs person.` };
    if (mode === 'chain') return runChain(person, user, deps);
    if (mode === 'direct_reports') return runDirectReports(person, limit, user, deps);
    if (mode === 'no_reporting_manager') return runNoReportingManager(limit, user, deps);
    if (mode === 'no_group') return runNoGroup(limit, user, deps);
    return runGroupMoves({ person, movedBetween, limit }, user, deps);
  },
  render(result) {
    if (!result || result.error || result.matches || result.notFound || result.mode === 'chain') return null;
    const label = {
      direct_reports: 'direct reports', no_reporting_manager: 'employees without a reporting manager',
      no_group: 'employees in no group', group_moves: 'group moves',
    }[result.mode];
    const rows = (result.records || []).map((r) => (result.mode === 'group_moves'
      ? { name: r.employee ?? '—', detail: `${r.fromDepartment ?? '—'} → ${r.toDepartment ?? '—'}` }
      : { name: r.name ?? '—', detail: r.designation ?? '—' }));
    return {
      blocks: rows.length ? [{
        type: 'table',
        id: 'reporting-chain',
        tableType: 'reporting-chain',
        title: `${label[0].toUpperCase()}${label.slice(1)} (${result.total})`,
        columns: [
          { key: 'name', label: 'Name', priority: 'primary' },
          { key: 'detail', label: result.mode === 'group_moves' ? 'Move' : 'Designation', priority: 'primary' },
        ],
        rows,
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'get_reporting_chain', label, total: result.total }] },
    };
  },
});

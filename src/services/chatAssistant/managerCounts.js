/**
 * Authoritative counts for manager concept meanings (Business Knowledge Layer).
 */

import Role from '../../models/role.model.js';
import User from '../../models/user.model.js';
import Employee from '../../models/employee.model.js';
import { listOrgUnits } from '../orgStructure.service.js';
import { computeSpanMetrics } from '../orgTree.pure.js';
import { employeeOwnerQuery, overridesFromArgs } from './visibilityRules.js';
import { buildEmployeeEmploymentFilter } from './employeeEmploymentFilter.js';
import { extractDesignationPhrase } from './businessConcepts.js';
import { POSITION_TYPES } from './orgStructureAnalytics.js';

const EMPLOYEE_ROLE_NAMES = ['Employee'];

/**
 * Org-chart heads that count toward "people with direct reports" span enrichment.
 * Department units use memberCount as span — their heads must NOT be treated as managers.
 * @param {{ type?: string, isActive?: boolean, headEmployeeId?: unknown }} unit
 * @returns {boolean}
 */
export function isOrgChartLeaderUnit(unit) {
  if (!unit || unit.isActive === false || !unit.headEmployeeId) return false;
  return POSITION_TYPES.includes(String(unit.type || '').toLowerCase());
}

/**
 * Resolve active Employee-role owner ids for the tenant.
 * @param {{ user?: object, args?: object }} opts
 */
async function resolveEmployeeOwnerIds(opts = {}) {
  const visOverride = overridesFromArgs(opts.args || {});
  const profileRoleDocs = await Role.find(
    { name: { $in: EMPLOYEE_ROLE_NAMES }, status: 'active' },
    { _id: 1 }
  ).lean();
  const profileRoleIds = profileRoleDocs.map((d) => d._id);
  if (!profileRoleIds.length) return { ownerIds: [], baseFilter: null, designationPhrase: 'Manager' };

  const ownerIds = await User.find(
    employeeOwnerQuery({ roleIds: profileRoleIds, override: visOverride }),
    { _id: 1 }
  ).distinct('_id');

  const today = new Date();
  const baseFilter = buildEmployeeEmploymentFilter({
    ownerIds,
    employmentStatus: 'active',
    today,
  });

  const text = opts.text || '';
  const designationPhrase = opts.designationPhrase ?? extractDesignationPhrase(text) ?? 'Manager';

  return { ownerIds, baseFilter, designationPhrase, today };
}

/**
 * Build a map of org-manager userId → { directReports, sources } from
 * reportingManager links and org-chart position heads (ceo/manager/supervisor) with span.
 * Department unit heads are excluded — memberCount is not a management span.
 * @param {{ baseFilter: object, ownerIds: string[] }} ctx
 * @returns {Promise<Map<string, { directReports: number, sources: string[] }>>}
 */
export async function collectOrgManagerLeaders(ctx) {
  const leaderMap = new Map();
  const { baseFilter } = ctx;
  if (!baseFilter) return leaderMap;

  const reportingRows = await Employee.aggregate([
    {
      $match: {
        ...baseFilter,
        reportingManager: { $exists: true, $ne: null },
      },
    },
    { $group: { _id: '$reportingManager', directReports: { $sum: 1 } } },
  ]);

  for (const row of reportingRows) {
    if (!row?._id) continue;
    leaderMap.set(String(row._id), {
      directReports: row.directReports || 0,
      sources: ['reportingManager'],
    });
  }

  try {
    const units = await listOrgUnits();
    const empRows = await Employee.find(baseFilter, {
      _id: 1,
      owner: 1,
      fullName: 1,
      departmentId: 1,
      isActive: 1,
    }).lean();
    const empPlain = empRows.map((e) => ({
      id: String(e._id),
      departmentId: e.departmentId,
      isActive: e.isActive !== false,
    }));
    const spanMetrics = computeSpanMetrics(units, empPlain);
    const empById = new Map(empRows.map((e) => [String(e._id), e]));

    for (const u of units) {
      if (!isOrgChartLeaderUnit(u)) continue;
      const unitId = String(u.id || u._id);
      const span = spanMetrics.get(unitId);
      if (!span || span.directReports <= 0) continue;

      const headEmp = empById.get(String(u.headEmployeeId));
      const ownerId = headEmp?.owner ? String(headEmp.owner) : null;
      if (!ownerId) continue;

      const existing = leaderMap.get(ownerId);
      if (existing) {
        existing.directReports = Math.max(existing.directReports, span.directReports);
        if (!existing.sources.includes('orgChartHead')) existing.sources.push('orgChartHead');
      } else {
        leaderMap.set(ownerId, {
          directReports: span.directReports,
          sources: ['orgChartHead'],
        });
      }
    }
  } catch {
    /* org chart enrichment is best-effort */
  }

  return leaderMap;
}

/**
 * Count active employees who have at least one direct report (distinct reportingManager targets).
 * @param {{ adminId: string, user?: object, designationPhrase?: string|null }} opts
 * @returns {Promise<{ orgManagers: number, designationManagers: number, designationPhrase: string }>}
 */
export async function fetchManagerConceptCounts(opts = {}) {
  const ctx = await resolveEmployeeOwnerIds(opts);
  const { baseFilter, designationPhrase } = ctx;
  if (!baseFilter || !ctx.ownerIds.length) {
    return { orgManagers: 0, designationManagers: 0, designationPhrase };
  }

  const [leaderMap, designationManagers] = await Promise.all([
    collectOrgManagerLeaders(ctx),
    Employee.countDocuments({
      ...baseFilter,
      designation: designationRegexForPhrase(designationPhrase),
    }),
  ]);

  return {
    orgManagers: leaderMap.size,
    designationManagers,
    designationPhrase,
  };
}

/**
 * @param {string} phrase
 * @returns {object}
 */
export function designationRegexForPhrase(phrase) {
  const p = String(phrase || 'Manager').trim();
  if (/^manager$/i.test(p)) {
    return { $regex: '^Manager$', $options: 'i' };
  }
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $regex: escaped, $options: 'i' };
}

/**
 * List/count org managers (people with direct reports via reportingManager and/or org-chart head span).
 * @param {{ adminId: string, limit?: number, user?: object }} opts
 */
export async function fetchOrgManagersAnalytics(opts = {}) {
  const ctx = await resolveEmployeeOwnerIds(opts);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);

  if (!ctx.baseFilter || !ctx.ownerIds.length) {
    return {
      total: 0,
      records: [],
      authoritative: true,
      metric: 'org_managers',
      population: 'Employee',
      definition:
        'Active employees with one or more direct reports (reportingManager links and/or org-chart position heads with span). Excludes department unit heads.',
    };
  }

  const leaderMap = await collectOrgManagerLeaders(ctx);
  const total = leaderMap.size;
  const top = [...leaderMap.entries()]
    .map(([userId, meta]) => ({ userId, ...meta }))
    .sort((a, b) => b.directReports - a.directReports)
    .slice(0, limit);

  const userRows = top.length
    ? await User.find({ _id: { $in: top.map((r) => r.userId) } }, { name: 1, email: 1 }).lean()
    : [];
  const userById = new Map(userRows.map((u) => [String(u._id), u]));

  const empRows = top.length
    ? await Employee.find(
        { owner: { $in: top.map((r) => r.userId) }, ...ctx.baseFilter },
        { fullName: 1, employeeId: 1, designation: 1, department: 1, owner: 1 }
      ).lean()
    : [];
  const empByOwner = new Map(empRows.map((e) => [String(e.owner), e]));

  const records = top.map((row) => {
    const uid = String(row.userId);
    const emp = empByOwner.get(uid);
    const usr = userById.get(uid);
    return {
      name: emp?.fullName || usr?.name || 'Unknown',
      employeeId: emp?.employeeId || null,
      designation: emp?.designation || null,
      department: emp?.department || null,
      directReports: row.directReports,
      sources: row.sources,
    };
  });

  return {
    metric: 'org_managers',
    total,
    records,
    authoritative: true,
    population: 'Employee',
    definition:
      'Active employees with one or more direct reports (reportingManager links and/or org-chart position heads with span). Excludes department unit heads. NOT manager positions on the org chart and NOT designation/title alone.',
  };
}

/**
 * List employees whose designation matches the requested title phrase.
 * @param {{ adminId: string, limit?: number, user?: object, designationPhrase?: string, text?: string }} opts
 */
export async function fetchDesignationManagersAnalytics(opts = {}) {
  const ctx = await resolveEmployeeOwnerIds(opts);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const designationPhrase = ctx.designationPhrase || 'Manager';

  if (!ctx.baseFilter || !ctx.ownerIds.length) {
    return {
      metric: 'designation_managers',
      total: 0,
      records: [],
      designationPhrase,
      authoritative: true,
      definition: `Active employees whose designation matches "${designationPhrase}".`,
    };
  }

  const desigFilter = designationRegexForPhrase(designationPhrase);
  const total = await Employee.countDocuments({ ...ctx.baseFilter, designation: desigFilter });
  const empRows = await Employee.find(
    { ...ctx.baseFilter, designation: desigFilter },
    { fullName: 1, employeeId: 1, designation: 1, department: 1, owner: 1 }
  )
    .sort({ fullName: 1 })
    .limit(limit)
    .lean();

  const userRows = empRows.length
    ? await User.find({ _id: { $in: empRows.map((e) => e.owner).filter(Boolean) } }, { name: 1, email: 1 }).lean()
    : [];
  const userById = new Map(userRows.map((u) => [String(u._id), u]));

  const records = empRows.map((emp) => {
    const usr = emp.owner ? userById.get(String(emp.owner)) : null;
    return {
      name: emp.fullName || usr?.name || 'Unknown',
      employeeId: emp.employeeId || null,
      designation: emp.designation || null,
      department: emp.department || null,
    };
  });

  return {
    metric: 'designation_managers',
    total,
    records,
    designationPhrase,
    authoritative: true,
    definition: `Active employees whose designation matches "${designationPhrase}". This is job title/designation — not org-chart manager positions and not "people with direct reports".`,
  };
}

import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  getOrgCoverageSummary as realGetOrgCoverageSummary,
  listOrgUnits as realListOrgUnits,
  buildTree as realBuildTree,
} from '../../../../orgStructure.service.js';
import { buildOrgStructureAnalyticsPayload, ORG_READ_PERMISSIONS } from '../../../orgStructureAnalytics.js';
import { fetchOrgManagersAnalytics as realFetchOrgManagers } from '../../../managerCounts.js';

const MAX_RECORDS = 50;
const POSITION_METRIC = { ceo: 'ceo', manager: 'managers', supervisor: 'supervisors' };

/** Fail-closed guard, same shape as the other domains' <domain>Scope(ctx). */
function orgScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) throw new Error('org tools need an authenticated user with an id');
  return ctx.user;
}

function orgDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    getOrgCoverageSummary: deps.getOrgCoverageSummary ?? realGetOrgCoverageSummary,
    listOrgUnits: deps.listOrgUnits ?? realListOrgUnits,
    buildTree: deps.buildTree ?? realBuildTree,
    fetchOrgManagersAnalytics: deps.fetchOrgManagersAnalytics ?? realFetchOrgManagers,
  };
}

/**
 * The Org Chart / Structure pages' own services (orgStructure.service) through the legacy payload
 * builder, trimmed to the asked metric. Access mirrors orgStructure.route.js canReadTree.
 */
export default defineTool({
  name: 'get_org_structure',
  domain: 'org',
  kind: 'read',
  description:
    'The ORG CHART (Org Structure page). metric: "positions" — ceo/manager/supervisor POSITIONS (one chart card ' +
    'each, with the head\'s name; pass positionType); "departments" — department UNITS on the chart and how many ' +
    'employees sit in each; "unit" — one named unit (unitName, e.g. "Group A") and who is in/under it; ' +
    '"unassigned" — active employees in no chart department; "people_managers" — employees who have direct ' +
    'reports; "coverage" — the overall summary.',
  measure:
    'Org-chart units (OrgUnit rows, active only) and active Employee profiles placed on the chart. Positions ' +
    'count chart cards, not people or job titles; departments are chart units, not the Employee.department ' +
    'text field; people_managers counts employees with at least one direct report.',
  input: Joi.object({
    metric: Joi.string()
      .valid('coverage', 'positions', 'departments', 'unit', 'unassigned', 'people_managers')
      .default('coverage'),
    positionType: Joi.string().valid('ceo', 'manager', 'supervisor')
      .description('For metric positions. Omit to get all three.'),
    unitName: Joi.string().min(1).max(80).description('For metric unit: the chart unit\'s name.'),
    limit: Joi.number().integer().min(1).max(MAX_RECORDS).default(25),
  }),
  access: { anyOf: [...ORG_READ_PERMISSIONS] },
  async execute({ metric = 'coverage', positionType, unitName, limit = 25 } = {}, ctx) {
    const user = orgScope(ctx);
    const deps = orgDeps(ctx);

    if (metric === 'people_managers') {
      const res = await deps.fetchOrgManagersAnalytics({ limit, user });
      return { metric, total: res.total ?? 0, records: (res.records || []).slice(0, limit), definition: res.definition };
    }
    if (metric === 'unit' && !unitName) return { error: 'metric "unit" needs unitName.' };

    const needsTree = metric !== 'positions';
    const [summary, units, tree] = await Promise.all([
      deps.getOrgCoverageSummary(user),
      deps.listOrgUnits(),
      needsTree ? deps.buildTree(user) : Promise.resolve(null),
    ]);
    const legacyMetric = metric === 'unit' ? 'unit_lookup' : (POSITION_METRIC[positionType] || metric);
    const p = buildOrgStructureAnalyticsPayload({
      summary, units, tree, args: { metric: legacyMetric, unitName: metric === 'unit' ? unitName : null },
    });

    if (metric === 'positions') {
      const types = positionType ? [positionType] : ['ceo', 'manager', 'supervisor'];
      const byType = { ceo: p.leadership?.ceoPositions, manager: p.managers?.positions, supervisor: p.supervisors?.positions };
      const records = types.flatMap((t) => (byType[t] || []).map((r) => ({ name: r.name, type: t, headName: r.headName || null })));
      return { metric, positionType: positionType || 'all', total: records.length, records: records.slice(0, limit) };
    }
    if (metric === 'departments') {
      const records = (p.departments?.records || []).map((d) => ({ name: d.name, employeeCount: d.employeeCount }));
      return {
        metric,
        total: p.departments?.count ?? records.length,
        records: records.slice(0, limit),
        departmentsWithoutChartNode: p.departments?.departmentsWithoutNode ?? 0,
      };
    }
    if (metric === 'unassigned') {
      return { metric, total: p.employees?.unassigned ?? 0, totalActiveEmployees: p.employees?.total ?? 0 };
    }
    if (metric === 'unit') {
      const matches = (p.lookup?.matches || []).slice(0, MAX_RECORDS).map((m) => ({
        ...m, employees: Array.isArray(m.employees) ? m.employees.slice(0, MAX_RECORDS) : m.employees,
      }));
      return { metric, unitName, total: p.authoritativeCount, label: p.authoritativeLabel, matches };
    }
    return {
      metric: 'coverage',
      employees: p.employees,
      unitCounts: p.unitCounts,
      unitsMissingHead: p.leadership?.unitsMissingHead ?? 0,
      departmentsWithoutChartNode: p.departments?.departmentsWithoutNode ?? 0,
      openSlots: p.openSlots ?? 0,
      overSpanUnits: p.overSpanUnits ?? 0,
    };
  },
  render(result) {
    if (!result || result.error) return null;
    const labels = {
      positions: 'positions', departments: 'departments', unassigned: 'unassigned employees',
      people_managers: 'people managers',
    };
    const label = labels[result.metric];
    if (!label || typeof result.total !== 'number') return { blocks: [] };
    const detailOf = (r) => {
      if (r.headName) return r.headName;
      if (r.employeeCount != null) return String(r.employeeCount);
      if (r.directReports != null) return String(r.directReports);
      return '—';
    };
    const rows = (result.records || []).map((r) => ({ name: r.name ?? '—', detail: detailOf(r) }));
    const detailLabel = { positions: 'Head', departments: 'Employees', people_managers: 'Direct reports' }[result.metric];
    return {
      blocks: rows.length ? [{
        type: 'table',
        id: 'org-structure',
        tableType: 'org-structure',
        title: `Org chart ${label} (${result.total})`,
        columns: [
          { key: 'name', label: 'Name', priority: 'primary' },
          { key: 'detail', label: detailLabel, priority: 'primary' },
        ],
        rows,
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'get_org_structure', label, total: result.total }] },
    };
  },
});

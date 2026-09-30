import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getOrgStructure from '../getOrgStructure.tool.js';
import getReportingChain from '../getReportingChain.tool.js';

const user = { id: '64b7f0c2a1b2c3d4e5f60001', authContext: { permissions: new Set(['chart.read']) } };

const UNITS = [
  { id: 'c1', name: 'Chief', type: 'ceo', isActive: true, headEmployeeId: 'e1', headName: 'Meera' },
  { id: 'm1', name: 'Ops Manager', type: 'manager', isActive: true, headEmployeeId: 'e2', headName: 'Ravi' },
  { id: 'm2', name: 'Tech Manager', type: 'manager', isActive: true },
  { id: 's1', name: 'Group A', type: 'supervisor', isActive: true },
  { id: 'd1', name: 'Sales', type: 'department', isActive: true, departmentId: 'dep1' },
  { id: 'd2', name: 'Old', type: 'department', isActive: false },
];
const TREE = {
  roots: [{
    id: 'c1', name: 'Chief', type: 'ceo',
    children: [{
      id: 'd1', name: 'Sales', type: 'department', memberCount: 2,
      employees: [{ id: 'x', fullName: 'A' }, { id: 'y', fullName: 'B' }],
    }],
  }],
};
const SUMMARY = { totalActiveEmployees: 10, assignedEmployees: 7, unassignedEmployees: 3, checklist: {} };

function deps(extra = {}) {
  const calls = { tree: 0 };
  return {
    calls,
    getOrgCoverageSummary: async () => SUMMARY,
    listOrgUnits: async () => UNITS,
    buildTree: async () => { calls.tree += 1; return TREE; },
    ...extra,
  };
}

describe('get_org_structure', () => {
  it('access mirrors the org chart routes', () => {
    assert.deepEqual(getOrgStructure.access.anyOf, ['chart.read', 'structure.read', 'structure.manage']);
    assert.ok(getOrgStructure.measure);
  });

  it('manager POSITIONS count chart cards, with head names, without building the tree', async () => {
    const d = deps();
    const res = await getOrgStructure.execute({ metric: 'positions', positionType: 'manager' }, { user, deps: d });
    assert.equal(res.total, 2);
    assert.deepEqual(res.records.map((r) => r.headName), ['Ravi', null]);
    assert.equal(d.calls.tree, 0);
  });

  it('departments are active chart units with member counts (not Employee.department)', async () => {
    const res = await getOrgStructure.execute({ metric: 'departments' }, { user, deps: deps() });
    assert.equal(res.total, 1);
    assert.deepEqual(res.records, [{ name: 'Sales', employeeCount: 2 }]);
  });

  it('unassigned comes from the coverage summary', async () => {
    const res = await getOrgStructure.execute({ metric: 'unassigned' }, { user, deps: deps() });
    assert.equal(res.total, 3);
    assert.equal(res.totalActiveEmployees, 10);
  });

  it('unit lookup needs a name and finds it in the tree', async () => {
    const missing = await getOrgStructure.execute({ metric: 'unit' }, { user, deps: deps() });
    assert.match(missing.error, /unitName/);
    const res = await getOrgStructure.execute({ metric: 'unit', unitName: 'sales' }, { user, deps: deps() });
    assert.equal(res.total, 2);
    assert.equal(res.matches[0].name, 'Sales');
  });

  it('people_managers delegates to the direct-reports count', async () => {
    let args;
    const fetchOrgManagersAnalytics = async (a) => { args = a; return { total: 4, records: [{ name: 'Ravi', directReports: 3 }] }; };
    const res = await getOrgStructure.execute(
      { metric: 'people_managers', limit: 10 }, { user, deps: deps({ fetchOrgManagersAnalytics }) },
    );
    assert.equal(args.limit, 10);
    assert.equal(res.total, 4);
    const r = getOrgStructure.render(res);
    assert.equal(r.facts.counts[0].label, 'people managers');
    assert.equal(r.blocks[0].rows[0].detail, '3');
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(getOrgStructure.execute({}, { user: {}, deps: deps() }), /authenticated user/);
  });
});

const viewerWith = (...p) => ({ id: '64b7f0c2a1b2c3d4e5f60001', roleIds: [], authContext: { permissions: new Set(p) } });

function q(result) {
  const c = {
    select: () => c, sort: () => c, limit: () => c, populate: () => c,
    lean: async () => result, distinct: async () => result,
  };
  return c;
}

const CHART_UNITS = [
  { id: 'c1', name: 'Chief', type: 'ceo', headEmployeeId: 'uC', headEmployee: { fullName: 'Meera' } },
  { id: 'm1', name: 'Ops', type: 'manager', headEmployeeId: 'uM', headEmployee: { fullName: 'Ravi' } },
  { id: 's1', name: 'Group A', type: 'supervisor', headEmployeeId: null, headEmployee: null },
  { id: 'd1', name: 'Sales', type: 'department', headEmployeeId: 'e1', headEmployee: { fullName: 'Asha' } },
];

function chainCtx({ perms = ['chart.read'], emp = { owner: 'u1', reportingManager: 'u5', designation: 'SDR' }, extra = {} } = {}) {
  const seen = {};
  return {
    seen,
    user: viewerWith(...perms),
    deps: {
      searchOrgChart: async (_u, name) => (name.toLowerCase().startsWith('as')
        ? { employees: [{ id: 'e1', fullName: 'Asha Rao' }], paths: [{ kind: 'employee', id: 'e1', pathIds: ['c1', 'm1', 's1', 'd1'] }] }
        : { employees: [], paths: [] }),
      listOrgUnits: async () => CHART_UNITS,
      Employee: {
        findById: () => q(emp),
        find: (filter) => { seen.employeeFind = filter; return q([{ fullName: 'Kiran', designation: 'SDR', employeeId: 'E7' }]); },
        countDocuments: async () => 1,
      },
      User: { findById: () => q({ name: 'Boss Man' }) },
      ...extra,
    },
  };
}

describe('get_reporting_chain', () => {
  it('shares the org chart access rule and needs a person for chain', async () => {
    assert.deepEqual(getReportingChain.access.anyOf, ['chart.read', 'structure.read', 'structure.manage']);
    const res = await getReportingChain.execute({ mode: 'chain' }, chainCtx());
    assert.match(res.error, /needs person/);
  });

  it('chain: team lead → supervisor → manager → CEO, plus reporting manager; teams need teams.read', async () => {
    const res = await getReportingChain.execute({ person: 'asha' }, chainCtx());
    assert.equal(res.person, 'Asha Rao');
    assert.deepEqual(res.chain, [
      { level: 'teamLead', unit: 'Sales', head: 'Asha', isSelf: true },
      { level: 'supervisor', unit: 'Group A', head: null },
      { level: 'manager', unit: 'Ops', head: 'Ravi' },
      { level: 'ceo', unit: 'Chief', head: 'Meera' },
    ]);
    assert.equal(res.reportingManager, 'Boss Man');
    assert.equal(res.teams, null);
    assert.match(res.teamsNote, /teams\.read/);
  });

  it('missing reporting manager is null and "not captured", never guessed', async () => {
    const res = await getReportingChain.execute({ person: 'asha' }, chainCtx({ emp: { owner: 'u1' } }));
    assert.equal(res.reportingManager, null);
    assert.match(res.reportingManagerNote, /not captured in DharwinOne/);
  });

  it('workforce team leads with teams.read', async () => {
    const ctx = chainCtx({
      perms: ['chart.read', 'teams.read'],
      extra: {
        queryTeamMembers: async (f) => { assert.equal(f.employeeId, 'e1'); return { results: [{ teamId: { _id: 't1', name: 'Alpha' } }] }; },
        queryTeamGroups: async () => ({ results: [{ _id: 't1', name: 'Alpha', teamLead: 'e9' }] }),
      },
    });
    ctx.deps.Employee.find = () => q([{ _id: 'e9', fullName: 'Lead Person' }]);
    const res = await getReportingChain.execute({ person: 'asha' }, ctx);
    assert.deepEqual(res.teams, [{ team: 'Alpha', teamLead: 'Lead Person' }]);
  });

  it('workforce teams: reads the toJSON { id, name } teamId that queryTeamMembers really returns', async () => {
    let groupFilter;
    const ctx = chainCtx({
      perms: ['chart.read', 'teams.read'],
      extra: {
        queryTeamMembers: async () => ({ results: [{ teamId: { id: 't1', name: 'Alpha' } }] }),
        queryTeamGroups: async (f) => { groupFilter = f; return { results: [{ _id: 't1', name: 'Alpha', teamLead: null }] }; },
      },
    });
    const res = await getReportingChain.execute({ person: 'asha' }, ctx);
    assert.deepEqual(groupFilter._id.$in, ['t1']);
    assert.deepEqual(res.teams, [{ team: 'Alpha', teamLead: null }]);
  });

  it('unknown person is notFound', async () => {
    const res = await getReportingChain.execute({ person: 'Zed' }, chainCtx());
    assert.equal(res.notFound, 'person');
  });

  it('direct reports come from reportingManager = the person\'s login', async () => {
    const ctx = chainCtx();
    const res = await getReportingChain.execute({ mode: 'direct_reports', person: 'asha' }, ctx);
    assert.equal(ctx.seen.employeeFind.reportingManager, 'u1');
    assert.equal(res.total, 1);
    assert.deepEqual(res.headsUnits, [{ unit: 'Sales', type: 'department' }]);
  });

  it('no reporting manager / no group are read over the org chart population', async () => {
    const buildTree = async () => ({
      roots: [{ employees: [{ id: 'e1', fullName: 'Asha' }], children: [] }],
      unassigned: [{ id: 'e2', fullName: 'Kiran', designation: 'SDR' }],
    });
    const ctx = chainCtx({ extra: { buildTree } });
    const nrm = await getReportingChain.execute({ mode: 'no_reporting_manager' }, ctx);
    assert.deepEqual(ctx.seen.employeeFind._id.$in, ['e1', 'e2']);
    assert.equal(ctx.seen.employeeFind.reportingManager, null);
    assert.equal(nrm.totalActiveEmployees, 2);
    const ng = await getReportingChain.execute({ mode: 'no_group' }, ctx);
    assert.deepEqual(ng.records, [{ name: 'Kiran', designation: 'SDR' }]);
    assert.equal(getReportingChain.render(ng).facts.counts[0].total, 1);
  });

  it('when no employee has a reporting manager set, says "not captured" instead of reporting a finding', async () => {
    const buildTree = async () => ({ roots: [], unassigned: [{ id: 'e1', fullName: 'Asha' }, { id: 'e2', fullName: 'Kiran' }] });
    const ctx = chainCtx({ extra: { buildTree } });
    ctx.deps.Employee.find = () => q([{ fullName: 'Asha' }, { fullName: 'Kiran' }]);
    ctx.deps.Employee.countDocuments = async () => 0;
    const nrm = await getReportingChain.execute({ mode: 'no_reporting_manager' }, ctx);
    assert.equal(nrm.total, 2);
    assert.match(nrm.note, /No employee has a reporting manager set/);
    const dr = await getReportingChain.execute({ mode: 'direct_reports', person: 'asha' }, ctx);
    assert.equal(dr.total, 0);
    assert.match(dr.note, /not captured yet/);
  });

  it('group moves need an Employees-page permission', async () => {
    const res = await getReportingChain.execute({ mode: 'group_moves' }, chainCtx());
    assert.match(res.error, /Group moves need/);
  });

  it('group moves: who / when, IST day window, inside the Employees-page row scope', async () => {
    let filter;
    const EmployeeTransfer = {
      find: (f) => { filter = f; return q([{
        employee: { fullName: 'Asha Rao' }, oldDepartment: 'Sales', newDepartment: 'Ops', oldDesignation: 'SDR',
        newDesignation: 'AE', effectiveDate: '2026-09-10T00:00:00.000Z', approvedBy: { name: 'Ravi' },
      }]); },
      countDocuments: async () => 1,
    };
    const ctx = chainCtx({
      perms: ['chart.read', 'employees.read'],
      extra: { EmployeeTransfer, resolveRowScope: async () => new Set(['u1']) },
    });
    ctx.deps.Employee.find = () => q(['e1']);
    const res = await getReportingChain.execute({ mode: 'group_moves', movedBetween: { from: '2026-09-01', to: '2026-09-30' } }, ctx);
    assert.deepEqual(filter.$and[0], { employee: { $in: ['e1'] } });
    assert.equal(filter.$and[1].effectiveDate.$gte.toISOString(), '2026-08-31T18:30:00.000Z');
    assert.equal(filter.$and[1].effectiveDate.$lte.toISOString(), '2026-09-30T18:29:59.999Z');
    assert.equal(res.scopedToYou, true);
    assert.deepEqual(res.records[0], {
      employee: 'Asha Rao', fromDesignation: 'SDR', toDesignation: 'AE', fromDepartment: 'Sales', toDepartment: 'Ops',
      effectiveDate: '2026-09-10T00:00:00.000Z', approvedBy: 'Ravi', recordedAt: null,
    });
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(getReportingChain.execute({ person: 'asha' }, { user: {}, deps: {} }), /authenticated user/);
  });
});

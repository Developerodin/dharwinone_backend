import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getOrgStructure from '../getOrgStructure.tool.js';

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

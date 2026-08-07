import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORG_READ_PERMISSIONS,
  POSITION_TYPES,
  hasOrgReadAccess,
  formatOrgCoverageFacts,
  countOrgUnitsByType,
  listPositionRecords,
  listDepartmentRecords,
  findOrgUnitsByName,
  findTreeNodesByName,
  summarizeOrgUnitNode,
  lookupOrgUnitFromTree,
  resolveOrgAuthoritativeCount,
  looksLikeOrgStructureQuery,
  guardFetchEmployeesOrgRoute,
  extractOrgStructureArgs,
  buildOrgStructureAnalyticsPayload,
} from '../orgStructureAnalytics.js';

const SAMPLE_SUMMARY = {
  totalActiveEmployees: 40,
  assignedEmployees: 35,
  unassignedEmployees: 5,
  totalOrgUnits: 12,
  departmentsWithoutNode: 1,
  departmentNodesWithoutEmployees: 2,
  unitsMissingHead: 3,
  overSpanUnits: 1,
  openSlots: 4,
  hasCeo: true,
  checklist: {
    hasCeo: true,
    hasManagers: true,
    hasSupervisors: true,
    hasDepartmentNodes: true,
    allDepartmentsLinked: false,
    noUnassignedEmployees: false,
    allLeadershipHeadsAssigned: false,
  },
};

const SAMPLE_UNITS = [
  {
    id: '1',
    name: 'CEO',
    type: 'ceo',
    isActive: true,
    headEmployeeId: 'h0',
    headEmployee: { id: 'h0', fullName: 'Harvinder' },
  },
  {
    id: '2',
    name: 'Ops Manager',
    type: 'manager',
    isActive: true,
    headEmployeeId: 'h1',
    headEmployee: { id: 'h1', fullName: 'Jason' },
  },
  {
    id: '3',
    name: 'East Manager',
    type: 'manager',
    isActive: true,
    headEmployeeId: 'h2',
    headEmployee: { id: 'h2', fullName: 'Priya' },
  },
  {
    id: '4',
    name: 'Supervisor North',
    type: 'supervisor',
    isActive: true,
    headEmployeeId: 'h3',
    headEmployee: { id: 'h3', fullName: 'Cara' },
  },
  { id: '5', name: 'Supervisor South', type: 'supervisor', isActive: true },
  { id: '6', name: 'Supervisor West', type: 'supervisor', isActive: true },
  { id: '7', name: 'Group A', type: 'department', isActive: true, departmentId: 'd1' },
  { id: '8', name: 'Sales', type: 'department', isActive: true, departmentId: 'd2' },
  { id: '9', name: 'Inactive Mgr', type: 'manager', isActive: false },
];

const SAMPLE_TREE = {
  roots: [
    {
      id: '1',
      name: 'CEO',
      type: 'ceo',
      headEmployee: { fullName: 'Ada' },
      children: [
        {
          id: '2',
          name: 'Ops Manager',
          type: 'manager',
          headEmployee: { fullName: 'Bob' },
          children: [
            {
              id: '4',
              name: 'Supervisor North',
              type: 'supervisor',
              headEmployee: { fullName: 'Cara' },
              children: [
                {
                  id: '7',
                  name: 'Group A',
                  type: 'department',
                  memberCount: 2,
                  employees: [
                    { id: 'e1', fullName: 'Eve', designation: 'Rep' },
                    { id: 'e2', fullName: 'Finn', designation: 'Rep' },
                  ],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('orgStructureAnalytics (Epic G)', () => {
  it('documents the confirmed read-permission set (mirrors canReadTree)', () => {
    assert.deepEqual(ORG_READ_PERMISSIONS, ['chart.read', 'structure.read', 'structure.manage']);
  });

  describe('hasOrgReadAccess', () => {
    it('denies when permissions is missing or not a Set', () => {
      assert.equal(hasOrgReadAccess(undefined), false);
      assert.equal(hasOrgReadAccess(null), false);
      assert.equal(hasOrgReadAccess([]), false);
    });

    it('denies a Set with unrelated permissions', () => {
      assert.equal(hasOrgReadAccess(new Set(['candidates.read'])), false);
    });

    it('grants access when any ORG_READ_PERMISSIONS entry is present', () => {
      assert.equal(hasOrgReadAccess(new Set(['chart.read'])), true);
      assert.equal(hasOrgReadAccess(new Set(['structure.read'])), true);
      assert.equal(hasOrgReadAccess(new Set(['structure.manage'])), true);
    });
  });

  describe('countOrgUnitsByType / position records', () => {
    it('counts active manager/supervisor/department/ceo positions (not User roles)', () => {
      assert.deepEqual(POSITION_TYPES, ['ceo', 'manager', 'supervisor']);
      const c = countOrgUnitsByType(SAMPLE_UNITS);
      assert.equal(c.manager, 2);
      assert.equal(c.supervisor, 3);
      assert.equal(c.department, 2);
      assert.equal(c.ceo, 1);
      assert.equal(c.total, 8);
    });

    it('lists manager positions with assigned head names (Org Chart cards)', () => {
      const positions = listPositionRecords(SAMPLE_UNITS, 'manager');
      assert.equal(positions.length, 2);
      assert.equal(positions[0].kind, 'position');
      assert.equal(positions[0].name, 'Ops Manager');
      assert.equal(positions[0].headName, 'Jason');
      assert.equal(positions[0].hasHead, true);
      assert.equal(positions[1].headName, 'Priya');
    });

    it('lists department units with membership from the tree', () => {
      const depts = listDepartmentRecords(SAMPLE_UNITS, SAMPLE_TREE);
      const groupA = depts.find((d) => d.name === 'Group A');
      assert.equal(groupA.kind, 'department');
      assert.equal(groupA.memberCount, 2);
      assert.equal(groupA.employees[0].fullName, 'Eve');
    });
  });

  describe('findOrgUnitsByName / tree lookup', () => {
    it('finds Group A by exact name', () => {
      const hits = findOrgUnitsByName(SAMPLE_UNITS, 'Group A');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].type, 'department');
    });

    it('walks the tree for Group A and summarizes employees', () => {
      const nodes = findTreeNodesByName(SAMPLE_TREE, 'group a');
      assert.equal(nodes.length, 1);
      const summary = summarizeOrgUnitNode(nodes[0]);
      assert.equal(summary.kind, 'department');
      assert.equal(summary.employeeCount, 2);
      assert.equal(summary.employees[0].fullName, 'Eve');
    });

    it('summarizes a manager position with head + reports', () => {
      const nodes = findTreeNodesByName(SAMPLE_TREE, 'Ops Manager');
      const summary = summarizeOrgUnitNode(nodes[0]);
      assert.equal(summary.kind, 'position');
      assert.equal(summary.headName, 'Bob');
      assert.equal(summary.reports.length, 1);
      assert.equal(summary.childSupervisors[0].name, 'Supervisor North');
    });

    it('lookupOrgUnitFromTree reports departments under a supervisor', () => {
      const lookup = lookupOrgUnitFromTree(SAMPLE_TREE, 'Supervisor North');
      assert.equal(lookup.notFound, false);
      assert.equal(lookup.matches[0].kind, 'position');
      assert.equal(lookup.matches[0].headName, 'Cara');
      assert.equal(lookup.matches[0].childDepartments.length, 1);
      assert.equal(lookup.matches[0].childDepartments[0].name, 'Group A');
    });

    it('returns notFound when the name is absent', () => {
      const lookup = lookupOrgUnitFromTree(SAMPLE_TREE, 'Group Z');
      assert.equal(lookup.notFound, true);
      assert.equal(lookup.matchCount, 0);
    });
  });

  describe('formatOrgCoverageFacts', () => {
    it('maps coverage + position/department records into AUTHORITATIVE buckets', () => {
      const facts = formatOrgCoverageFacts(SAMPLE_SUMMARY, SAMPLE_UNITS, SAMPLE_TREE);

      assert.equal(facts.managers.count, 2);
      assert.equal(facts.managers.positions.length, 2);
      assert.equal(facts.managers.positions[0].headName, 'Jason');
      assert.equal(facts.supervisors.count, 3);
      assert.equal(facts.departments.count, 2);
      assert.equal(facts.departments.records[0].memberCount, 2);
      assert.match(facts.managers.definition, /manager \*\*positions\*\*|manager \*\*positions\*\*|positions/i);
      assert.match(facts.managers.definition, /NOT User role/);
      assert.equal(facts.leadership.ceoPositions[0].headName, 'Harvinder');
      assert.equal(facts.employees.total, 40);
      assert.equal(facts.employees.unassigned, 5);
      assert.match(facts.employees.unassignedDefinition, /departmentId/);
      assert.equal(facts.authoritative, true);
    });

    it('defaults every field to zero/false on an empty summary without throwing', () => {
      const facts = formatOrgCoverageFacts();
      assert.equal(facts.departments.hasDepartmentNodes, false);
      assert.equal(facts.supervisors.hasSupervisors, false);
      assert.equal(facts.employees.total, 0);
      assert.equal(facts.employees.unassigned, 0);
      assert.equal(facts.authoritative, true);
    });
  });

  describe('resolveOrgAuthoritativeCount', () => {
    it('returns manager POSITION count for metric=managers (Org Chart cards)', () => {
      const facts = formatOrgCoverageFacts(SAMPLE_SUMMARY, SAMPLE_UNITS);
      const a = resolveOrgAuthoritativeCount(facts, { metric: 'managers' });
      assert.equal(a.count, 2);
      assert.match(a.label, /manager positions/i);
    });

    it('returns supervisor position count for metric=supervisors', () => {
      const facts = formatOrgCoverageFacts(SAMPLE_SUMMARY, SAMPLE_UNITS);
      const a = resolveOrgAuthoritativeCount(facts, { metric: 'supervisors' });
      assert.equal(a.count, 3);
      assert.match(a.label, /supervisor positions/i);
    });

    it('returns employee count for a department unit lookup', () => {
      const facts = formatOrgCoverageFacts(SAMPLE_SUMMARY, SAMPLE_UNITS);
      const lookup = lookupOrgUnitFromTree(SAMPLE_TREE, 'Group A');
      const a = resolveOrgAuthoritativeCount(facts, { metric: 'unit_lookup', lookup });
      assert.equal(a.count, 2);
      assert.match(a.label, /Group A/i);
    });

    it('returns report count for a manager position lookup and mentions head', () => {
      const facts = formatOrgCoverageFacts(SAMPLE_SUMMARY, SAMPLE_UNITS);
      const lookup = lookupOrgUnitFromTree(SAMPLE_TREE, 'Ops Manager');
      const a = resolveOrgAuthoritativeCount(facts, { metric: 'unit_lookup', lookup });
      assert.equal(a.count, 1);
      assert.match(a.label, /manager position/i);
      assert.match(a.label, /Bob/);
    });

    it('returns unassigned count for metric=unassigned', () => {
      const facts = formatOrgCoverageFacts(SAMPLE_SUMMARY, SAMPLE_UNITS);
      const a = resolveOrgAuthoritativeCount(facts, { metric: 'unassigned' });
      assert.equal(a.count, 5);
    });
  });

  describe('looksLikeOrgStructureQuery / routing guards', () => {
    it('detects manager / supervisor / group / org chart asks', () => {
      assert.equal(looksLikeOrgStructureQuery('how many managers'), true);
      assert.equal(looksLikeOrgStructureQuery('how many supervisors'), true);
      assert.equal(looksLikeOrgStructureQuery('group a in org chart'), true);
      assert.equal(looksLikeOrgStructureQuery('org structure coverage'), true);
      assert.equal(looksLikeOrgStructureQuery('unassigned employees'), true);
      assert.equal(looksLikeOrgStructureQuery('how many employees resigned in July'), false);
      assert.equal(looksLikeOrgStructureQuery('list sales agents'), false);
    });

    it('blocks fetch_employees for org asks', () => {
      const g = guardFetchEmployeesOrgRoute('how many managers');
      assert.equal(g.block, true);
      assert.ok(g.preferModules.includes('org_structure_analytics'));
      assert.equal(guardFetchEmployeesOrgRoute('list recruiters'), null);
    });
  });

  describe('extractOrgStructureArgs', () => {
    it('extracts managers / supervisors / unassigned metrics', () => {
      assert.equal(extractOrgStructureArgs('how many managers').metric, 'managers');
      assert.equal(extractOrgStructureArgs('how many supervisors').metric, 'supervisors');
      assert.equal(extractOrgStructureArgs('unassigned employees').metric, 'unassigned');
    });

    it('extracts Group A as unitName for unit_lookup', () => {
      const a = extractOrgStructureArgs('group a in org chart');
      assert.equal(a.metric, 'unit_lookup');
      assert.equal(a.unitName, 'Group A');
    });
  });

  describe('buildOrgStructureAnalyticsPayload', () => {
    it('assembles coverage + Group A lookup with AUTHORITATIVE count', () => {
      const payload = buildOrgStructureAnalyticsPayload({
        summary: SAMPLE_SUMMARY,
        units: SAMPLE_UNITS,
        tree: SAMPLE_TREE,
        args: { metric: 'unit_lookup', unitName: 'Group A' },
      });
      assert.equal(payload.authoritative, true);
      assert.equal(payload.authoritativeCount, 2);
      assert.equal(payload.lookup.notFound, false);
      assert.equal(payload.lookup.matches[0].kind, 'department');
      assert.equal(payload.managers.count, 2);
      assert.equal(payload.supervisors.count, 3);
    });

    it('assembles manager POSITION headcount with head names for listing', () => {
      const payload = buildOrgStructureAnalyticsPayload({
        summary: SAMPLE_SUMMARY,
        units: SAMPLE_UNITS,
        tree: SAMPLE_TREE,
        args: { metric: 'managers' },
      });
      assert.equal(payload.authoritativeCount, 2);
      assert.match(payload.authoritativeLabel, /manager positions/i);
      assert.equal(payload.lookup, null);
      assert.equal(payload.managers.records[0].headName, 'Jason');
      assert.equal(payload.managers.records[1].headName, 'Priya');
    });
  });
});

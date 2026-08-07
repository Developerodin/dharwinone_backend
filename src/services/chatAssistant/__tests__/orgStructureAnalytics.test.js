import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORG_READ_PERMISSIONS,
  hasOrgReadAccess,
  formatOrgCoverageFacts,
} from '../orgStructureAnalytics.js';

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

  describe('formatOrgCoverageFacts', () => {
    it('maps a full getOrgCoverageSummary result into AUTHORITATIVE buckets', () => {
      const summary = {
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
          hasSupervisors: false,
          hasDepartmentNodes: true,
          allDepartmentsLinked: false,
          noUnassignedEmployees: false,
          allLeadershipHeadsAssigned: false,
        },
      };

      const facts = formatOrgCoverageFacts(summary);

      assert.deepEqual(facts.departments, {
        hasDepartmentNodes: true,
        departmentsWithoutNode: 1,
        departmentNodesWithoutEmployees: 2,
        allDepartmentsLinked: false,
      });
      assert.deepEqual(facts.supervisors, { hasSupervisors: false });
      assert.equal(facts.employees.total, 40);
      assert.equal(facts.employees.assigned, 35);
      assert.equal(facts.employees.unassigned, 5);
      assert.match(facts.employees.unassignedDefinition, /departmentId/);
      assert.match(facts.employees.unassignedDefinition, /orgTree\.pure\.js/);
      assert.deepEqual(facts.leadership, {
        hasCeo: true,
        hasManagers: true,
        unitsMissingHead: 3,
        allLeadershipHeadsAssigned: false,
      });
      assert.equal(facts.overSpanUnits, 1);
      assert.equal(facts.openSlots, 4);
      assert.equal(facts.authoritative, true);
      assert.match(facts.source, /getOrgCoverageSummary/);
    });

    it('defaults every field to zero/false on an empty summary without throwing', () => {
      const facts = formatOrgCoverageFacts();
      assert.deepEqual(facts.departments, {
        hasDepartmentNodes: false,
        departmentsWithoutNode: 0,
        departmentNodesWithoutEmployees: 0,
        allDepartmentsLinked: false,
      });
      assert.deepEqual(facts.supervisors, { hasSupervisors: false });
      assert.deepEqual(facts.employees.total, 0);
      assert.deepEqual(facts.employees.assigned, 0);
      assert.deepEqual(facts.employees.unassigned, 0);
      assert.equal(facts.overSpanUnits, 0);
      assert.equal(facts.openSlots, 0);
      assert.equal(facts.authoritative, true);
    });
  });
});

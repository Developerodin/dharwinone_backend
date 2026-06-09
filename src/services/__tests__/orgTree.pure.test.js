import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTreeFromData, wouldCreateCycle, hasActiveChildren, departmentHasAssignedEmployees,
  isAllowedParentChild, validateOrgUnitPlacement, childrenValidAfterTypeChange,
} from '../orgTree.pure.js';

const u = (id, type, parentId = null, extra = {}) => ({ id, type, parentId, isActive: true, order: 0, name: id, ...extra });
const emp = (id, departmentId = null) => ({ id, fullName: `Emp ${id}`, departmentId, isActive: true });

test('buildTreeFromData nests ceo→manager→supervisor→department and lists employees', () => {
  const units = [
    u('c', 'ceo'),
    u('m', 'manager', 'c'),
    u('s', 'supervisor', 'm'),
    u('d', 'department', 's', { departmentId: 'dept1' }),
  ];
  const employees = [emp('e1', 'dept1'), emp('e2', 'dept1')];
  const { roots, unassigned } = buildTreeFromData(units, employees);
  assert.equal(roots.length, 1);
  const dept = roots[0].children[0].children[0].children[0];
  assert.equal(dept.id, 'd');
  assert.equal(dept.employees.length, 2);
  assert.equal(dept.memberCount, 2);
  assert.deepEqual(unassigned.map((e) => e.id), []);
});

test('buildTreeFromData puts unmatched active employees in Unassigned', () => {
  const units = [u('c', 'ceo'), u('d', 'department', 'c', { departmentId: 'dept1' })];
  const employees = [emp('e1', 'dept1'), emp('e2', 'deptX'), emp('e3', null)];
  const { unassigned } = buildTreeFromData(units, employees);
  assert.deepEqual(unassigned.map((e) => e.id).sort(), ['e2', 'e3']);
});

test('buildTreeFromData returns empty roots when there are no roots', () => {
  const { roots, unassigned } = buildTreeFromData([], [emp('e1', null)]);
  assert.deepEqual(roots, []);
  assert.equal(unassigned.length, 1);
});

test('buildTreeFromData returns a forest for N>1 roots', () => {
  const units = [u('c1', 'ceo'), u('c2', 'ceo')];
  const { roots } = buildTreeFromData(units, []);
  assert.equal(roots.length, 2);
});

test('buildTreeFromData reparents orphan (parent missing) to a flagged virtual root', () => {
  const units = [u('m', 'manager', 'ghost')];
  const { roots } = buildTreeFromData(units, []);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, 'm');
  assert.equal(roots[0].orphaned, true);
});

test('buildTreeFromData excludes inactive units and inactive employees', () => {
  const units = [u('c', 'ceo'), u('d', 'department', 'c', { departmentId: 'dept1', isActive: false })];
  const employees = [{ ...emp('e1', 'dept1'), isActive: false }];
  const { roots, unassigned } = buildTreeFromData(units, employees);
  assert.equal(roots[0].children.length, 0);
  assert.equal(unassigned.length, 0);
});

test('wouldCreateCycle: reparenting a node under its own descendant is rejected', () => {
  const units = [u('a', 'manager'), u('b', 'supervisor', 'a'), u('c', 'department', 'b')];
  assert.equal(wouldCreateCycle(units, 'a', 'c'), true);
  assert.equal(wouldCreateCycle(units, 'a', 'a'), true);
  assert.equal(wouldCreateCycle(units, 'c', 'a'), false);
  assert.equal(wouldCreateCycle(units, 'c', null), false);
});

test('hasActiveChildren detects active child units', () => {
  const units = [u('p', 'manager'), u('k', 'supervisor', 'p'), u('x', 'supervisor', 'p', { isActive: false })];
  assert.equal(hasActiveChildren(units, 'p'), true);
  assert.equal(hasActiveChildren(units, 'k'), false);
});

test('departmentHasAssignedEmployees detects active assignment', () => {
  const employees = [emp('e1', 'dept1'), { ...emp('e2', 'dept1'), isActive: false }];
  assert.equal(departmentHasAssignedEmployees(employees, 'dept1'), true);
  assert.equal(departmentHasAssignedEmployees(employees, 'dept2'), false);
});

test('isAllowedParentChild enforces ceo→manager→supervisor→department chain', () => {
  assert.equal(isAllowedParentChild(null, 'ceo'), true);
  assert.equal(isAllowedParentChild('ceo', 'manager'), true);
  assert.equal(isAllowedParentChild('ceo', 'department', true), true);
  assert.equal(isAllowedParentChild('ceo', 'department', false), false);
  assert.equal(isAllowedParentChild('manager', 'supervisor'), true);
  assert.equal(isAllowedParentChild('supervisor', 'department'), true);
  assert.equal(isAllowedParentChild('ceo', 'supervisor'), false);
});

test('validateOrgUnitPlacement rejects invalid parent-child', () => {
  const units = [u('c', 'ceo'), u('m', 'manager', 'c')];
  const verdict = validateOrgUnitPlacement(units, { type: 'supervisor' }, 'c');
  assert.equal(verdict.ok, false);
});

test('childrenValidAfterTypeChange rejects a demotion that orphans a child', () => {
  // manager 'm' has supervisor child 's'. Demoting 'm' to 'supervisor' makes
  // supervisor→supervisor illegal.
  const units = [u('m', 'manager'), u('s', 'supervisor', 'm')];
  const verdict = childrenValidAfterTypeChange(units, 'm', 'supervisor');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.child.id, 's');
});

test('childrenValidAfterTypeChange rejects turning a parent into a department (leaf)', () => {
  const units = [u('s', 'supervisor'), u('d', 'department', 's', { departmentId: 'dept1' })];
  // supervisor 's' has a department child; making 's' a department is illegal (departments are leaves)
  const verdict = childrenValidAfterTypeChange(units, 's', 'department');
  assert.equal(verdict.ok, false);
});

test('childrenValidAfterTypeChange allows a change that keeps children legal', () => {
  // 's' has no children — any type change is fine.
  const units = [u('m', 'manager'), u('s', 'supervisor', 'm')];
  assert.deepEqual(childrenValidAfterTypeChange(units, 's', 'department'), { ok: true });
});

test('childrenValidAfterTypeChange ignores inactive children', () => {
  const units = [u('m', 'manager'), u('s', 'supervisor', 'm', { isActive: false })];
  assert.deepEqual(childrenValidAfterTypeChange(units, 'm', 'supervisor'), { ok: true });
});

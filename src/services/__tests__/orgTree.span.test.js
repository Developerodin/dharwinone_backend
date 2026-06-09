import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSpanMetrics,
  filterUnitsToSubtree,
  findUnitPathIds,
  DEFAULT_SPAN_THRESHOLDS,
} from '../orgTree.pure.js';

test('computeSpanMetrics flags manager over span', () => {
  const units = [
    { id: 'ceo', type: 'ceo', parentId: null, isActive: true },
    { id: 'm1', type: 'manager', parentId: 'ceo', isActive: true },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      type: 'supervisor',
      parentId: 'm1',
      isActive: true,
    })),
  ];
  const metrics = computeSpanMetrics(units, []);
  assert.equal(metrics.get('m1').directReports, 9);
  assert.equal(metrics.get('m1').band, 'warn');
  assert.ok(DEFAULT_SPAN_THRESHOLDS.manager.warn <= 9);
});

test('filterUnitsToSubtree limits depth from root', () => {
  const units = [
    { id: 'a', parentId: null, isActive: true },
    { id: 'b', parentId: 'a', isActive: true },
    { id: 'c', parentId: 'b', isActive: true },
  ];
  const sub = filterUnitsToSubtree(units, 'a', 2);
  assert.equal(sub.length, 2);
  assert.ok(sub.some((u) => u.id === 'a'));
  assert.ok(sub.some((u) => u.id === 'b'));
  assert.ok(!sub.some((u) => u.id === 'c'));
});

test('findUnitPathIds returns root-to-target path', () => {
  const units = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
  ];
  assert.deepEqual(findUnitPathIds(units, 'c'), ['a', 'b', 'c']);
});
